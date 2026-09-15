# Cloud ↔ Local Synchronization

Offline-first gateway sync with the Mess Management web API. The local gateway never connects to MongoDB.

```text
mess-local-gateway
        ↓ HTTPS /api/gateway/*
Mess Management Web API
        ↓
MongoDB
```

## Intended operating modes

| Mode | Pull | Push | Heartbeat | Behavior |
|---|---|---|---|---|
| **Normal Production** | ON | ON | ON | Master data down, meal transactions up |
| **Demo / Master Data Test** | ON | OFF | ON | Cloud employees/rates sync into SQLite; local meals stay local |
| **Offline** | cloud unavailable | — | — | Local meal engine, QR, face, printer, and SQLite continue |

Configure Demo / Master Data Test with:

```env
CLOUD_SYNC_ENABLED=true
CLOUD_PULL_ENABLED=true
CLOUD_PUSH_ENABLED=false
HEARTBEAT_ENABLED=true
```

When push is disabled, pending/failed `sync_queue` rows are **kept** (never auto-deleted). Automatic upload and Retry Failed uploads are skipped.

## Architecture

```text
Cloud Admin creates/updates Employee
        ↓  (allocates syncVersion N+1)
Gateway periodically pulls changes   GET /api/gateway/sync?since=<syncVersion>
        ↓
SQLite employees / meal_rates / meal_timings
        ↓
Employee scans QR / face
        ↓
processMealTransaction()  (100% local — never waits on cloud)
        ↓
Receipt prints
        ↓
sync_queue pending
        ↓
Gateway uploads (only if CLOUD_PUSH_ENABLED=true)
        POST /api/gateway/transactions
```

## Environment variables

Set these in `.env`. `CLOUD_API_URL` is the **web portal base URL**, not a MongoDB URI.

| Variable | Default | Purpose |
|---|---|---|
| `CLOUD_API_URL` | `http://localhost:3000` | Portal origin |
| `GATEWAY_ID` | `MESS-01` | Sent as `x-gateway-id` |
| `GATEWAY_API_KEY` | _(empty)_ | Sent as `x-gateway-api-key`. **Never put this in frontend JS.** |
| `CLOUD_SYNC_ENABLED` | `true` | Master switch for sync workers (`SYNC_ENABLED` is a legacy alias) |
| `CLOUD_PULL_ENABLED` | `true` | Cloud → local master-data pull |
| `CLOUD_PUSH_ENABLED` | `true` | Local → cloud transaction upload |
| `HEARTBEAT_ENABLED` | `true` | `POST /api/gateway/heartbeat` |
| `SYNC_PULL_INTERVAL_MS` | `15000` | Pull interval |
| `SYNC_PUSH_INTERVAL_MS` | `10000` | Push interval |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat interval |
| `SYNC_BATCH_SIZE` | `50` | Max transactions per upload (capped at 100) |
| `SYNC_REQUEST_TIMEOUT_MS` | `10000` | HTTP timeout |
| `SYNC_MAX_ATTEMPTS` | `10` | Auto-retry cap per queue row |
| `SYNC_RETRY_BASE_MS` | `5000` | First retry delay |
| `SYNC_RETRY_MAX_MS` | `300000` | Retry delay cap (5 minutes) |

Sync is treated as **not configured** until both `CLOUD_API_URL` and `GATEWAY_API_KEY` are set and `CLOUD_SYNC_ENABLED` is true. Local meal service still starts.

## Startup

```text
SQLite initialize
        ↓
Gateway HTTP server starts
        ↓
Hardware services start
        ↓
Sync workers start (only enabled ones)
        ↓
Initial cloud pull attempted if CLOUD_PULL_ENABLED (non-blocking)
```

Cloud failure never prevents gateway startup. QR, face, printer, and SQLite keep working with cloud shown as Offline.

## Cloud pull

`GET /api/gateway/sync?since=<last_cloud_sync_version>`

- First run uses `since=0`.
- `last_cloud_sync_version` is stored in `gateway_settings` and survives process restart.
- The version is updated **only after** the entire payload is committed in one SQLite transaction.
- Cloud allocates a new `syncVersion` on every Employee / MealType / MealRate create, update, and soft-delete. Incremental pull returns only `syncVersion > since`.

Employees are upserted by `cloud_id`, then `employee_code`. Inactive, deleted, or ineligible cloud employees set `is_active = 0` / `mess_eligible = 0`. **Transaction history is never deleted.**

Example pull logs:

```text
[CLOUD-PULL] starting from version 139
[CLOUD-PULL] employees received=1 upserted=1
[CLOUD-PULL] departments received=0
[CLOUD-PULL] mealRates received=0 upserted=0
[CLOUD-PULL] mealTimings received=0 upserted=0
[CLOUD-PULL] mealSettings received=0
[CLOUD-PULL] completed at version 140
```

## Force Full Pull

Resets **only** the master-data cursor (`last_cloud_sync_version → 0`), then pulls the full cloud snapshot.

Does **not**:

- wipe SQLite
- delete attendance / meal / POS transaction history
- reset hardware configuration
- affect QR / face / printer services
- upload transactions

```bash
curl -X POST http://localhost:5050/api/local/sync/force-full-pull
# alias:
curl -X POST http://localhost:5050/api/sync/force-full-pull
```

Expected logs:

```text
[CLOUD-PULL] master cursor reset 139 → 0 (transactions/hardware untouched)
[CLOUD-PULL] FORCE FULL PULL
[CLOUD-PULL] starting from version 0
[CLOUD-PULL] employees received=N upserted=N
...
[CLOUD-PULL] completed at version <current>
```

Use Force Full Pull for initial setup, recovery, or manual testing. Normal sync must remain incremental.

## Sync Now

`POST /api/local/sync/now` respects the independent flags:

| Flag | Sync Now behavior |
|---|---|
| `CLOUD_PULL_ENABLED=true` | Runs master pull |
| `CLOUD_PUSH_ENABLED=false` | Skips transaction push (rows kept) |
| `HEARTBEAT_ENABLED=true` | Sends heartbeat |

## Balance reconciliation

This is an offline-first wallet. A cloud pull must not erase pending local meals.

```text
available_balance = cloud_balance - pendingDebits
```

where `pendingDebits` are completed local transactions with `sync_status != 'synced'`.

## Transaction push

Eligible only when `CLOUD_PUSH_ENABLED=true`. Failed rows are retried with exponential backoff until `SYNC_MAX_ATTEMPTS`. Disabling push stops automatic retries without deleting queue rows.

### Clear failed dummy rows (dev/admin)

Removes **only** failed `sync_queue` rows that look like dummy/test data (payload contains `dummy` / `test-tx`, or demo-seed `EMP001`/`EMP002` without a cloud employee id). Never deletes transaction history or non-dummy failures. With `CLOUD_PUSH_ENABLED=false`, failed rows are left alone automatically (no retries).

```bash
curl -X POST 'http://localhost:5050/api/local/sync/clear-failed-dummy'
# production:
curl -X POST 'http://localhost:5050/api/local/sync/clear-failed-dummy?confirm=1'
```

## Offline behavior

If the cloud is unreachable:

- Gateway stays up
- QR / face / printer / SQLite keep working
- Successful meals still print, deduct, write ledger, and enqueue `sync_queue`
- Dashboard shows Cloud Connection = Offline
- Workers log `[SYNC] cloud unavailable - local service continues`

## Manual commands

```bash
# Cloud / hardware status
curl http://localhost:5050/api/status

# Pull (+ push if enabled) + heartbeat
curl -X POST http://localhost:5050/api/local/sync/now

# Reset master cursor and re-pull all cloud master data
curl -X POST http://localhost:5050/api/local/sync/force-full-pull

# Make failed rows retryable and push (no-op when push disabled)
curl -X POST http://localhost:5050/api/local/sync/retry-failed

# Confirm a cloud employee landed in SQLite
sqlite3 data/mess-local.db \
"SELECT employee_code, name, cloud_id, available_balance, cloud_balance, is_active
 FROM employees
 ORDER BY updated_at DESC
 LIMIT 20;"

# Or via API
curl 'http://localhost:5050/api/local/employees?q=EMP'

# Queue breakdown
sqlite3 data/mess-local.db \
"SELECT status, COUNT(*) FROM sync_queue GROUP BY status;"
```

## Dashboard

`http://localhost:5050/gateway` shows connection, gateway id, pull/push flags, last pull/push, sync version, pending/failed counts, and last error. **Sync Now**, **Force Full Pull**, and **Retry Failed** are enabled when the gateway is configured.

## Demo seed vs cloud data

`npm run seed:demo` will **not** overwrite employees that already have a `cloud_id`, and it will not replace meal rates/timings after a successful cloud pull (`last_cloud_sync_version > 0`).

## Troubleshooting

| Symptom | What to check |
|---|---|
| Cloud = Not configured | `GATEWAY_API_KEY` empty or `CLOUD_SYNC_ENABLED=false` |
| Auth failed | Wrong `GATEWAY_ID` / API key |
| Pull stays at same version with 0 employees | Cloud has no records with `syncVersion > since`. Create/update on the portal must allocate a new version. Use Force Full Pull only for recovery. |
| Push still running in Demo mode | Set `CLOUD_PUSH_ENABLED=false` and restart |
| `EMPLOYEE_NOT_FOUND` on push | Employee not on cloud yet; pull first, then retry |
| Demo QR stopped working after pull | Expected once that employee has `qrTokenHash` |

Log prefixes: `[CLOUD-PULL]`, `[CLOUD-PUSH]`, `[HEARTBEAT]`, `[SYNC]`. `GATEWAY_API_KEY` is never printed.
