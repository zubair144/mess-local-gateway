# Executive Mess — Local Gateway

Local mess gateway for the Executive Mess. One Node process owns:

- SQLite transaction engine (employees, ledger, transactions, sync queue)
- ZKTeco MB560-VL Face / ADMS listener
- Black Copper BC-8000G QR scanner (USB HID keyboard)
- Zebra receipt printer (ZPL over TCP 9100)
- Local REST API + operational dashboard
- Cloud ↔ local sync (offline-first)

## Run

```bash
cp .env.example .env
npm install
npm run db:init
npm run seed:demo   # optional demo employees/rates/timings
npm start
```

Development:

```bash
npm run dev
```

Dashboard:

```text
http://localhost:5050/gateway
```

## Ports

| Service | Default | Notes |
|---|---|---|
| Gateway API + Dashboard | `5050` | Local REST + UI |
| ZKTeco ADMS | `8080` | Dedicated listener required by the device |

## Transaction engine

Face, QR, and manual/API requests all call `processMealTransaction()` in `src/services/meal-transaction.service.js`.

Successful flow:

```text
validate → SQLite COMMIT → print one meal receipt
```

See [`docs/LOCAL-TRANSACTION-ENGINE.md`](docs/LOCAL-TRANSACTION-ENGINE.md) and [`docs/CLOUD-SYNC.md`](docs/CLOUD-SYNC.md).

## Local APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/api/status` | Gateway + hardware + SQLite status |
| GET | `/api/local/dashboard` | Dashboard polling data |
| GET | `/api/local/employees` | Employees |
| GET | `/api/local/employees/:id` | Employee detail + ledger |
| GET | `/api/local/transactions` | Transactions (filters supported) |
| GET | `/api/local/sync-queue` | Sync queue counts/items |
| POST | `/api/local/meal/process` | Manual meal test (`employeeCode`) |
| POST | `/api/local/sync/now` | Pull master data + push pending transactions |
| POST | `/api/local/sync/retry-failed` | Re-queue failed uploads and push |
| POST | `/api/meal/face` | Face simulation |
| POST | `/api/meal/qr` | QR simulation |
| POST | `/api/printer/test` | Print one test receipt |
| GET | `/employees` | Legacy employee list |
| GET | `/transactions` | Legacy transactions |
| GET | `/sync/pending` | Legacy pending sync |

## Demo testing (no hardware)

```bash
# Successful manual lunch for EMP001
curl -X POST http://localhost:5050/api/local/meal/process \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual-test","employeeCode":"EMP001"}'

# Face path (same engine)
curl -X POST http://localhost:5050/api/meal/face \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"1","print":false}'

# QR path (same engine)
curl -X POST http://localhost:5050/api/meal/qr \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"EMP001-QR","print":false}'
```

Inspect SQLite:

```bash
sqlite3 data/mess-local.db "SELECT employee_code, available_balance FROM employees;"
sqlite3 data/mess-local.db "SELECT employee_code, meal_name, total_amount, source, status FROM transactions ORDER BY transaction_time DESC LIMIT 10;"
sqlite3 data/mess-local.db "SELECT entry_type, amount, balance_before, balance_after FROM employee_ledger ORDER BY created_at DESC LIMIT 10;"
```

## Cloud sync

Requires `CLOUD_API_URL` (portal base URL) and `GATEWAY_API_KEY`. The gateway never talks to MongoDB.

```bash
curl http://localhost:5050/api/status
curl -X POST http://localhost:5050/api/local/sync/now
curl -X POST http://localhost:5050/api/local/sync/retry-failed
sqlite3 data/mess-local.db "SELECT status, COUNT(*) FROM sync_queue GROUP BY status;"
```

Details: [`docs/CLOUD-SYNC.md`](docs/CLOUD-SYNC.md).

## Tests

```bash
npm test
```

## Hardware docs

- [`docs/HARDWARE-INTEGRATION.md`](docs/HARDWARE-INTEGRATION.md)
- [`docs/MIGRATION-zkteco-mb560-test.md`](docs/MIGRATION-zkteco-mb560-test.md)
- [`docs/LOCAL-TRANSACTION-ENGINE.md`](docs/LOCAL-TRANSACTION-ENGINE.md)
- [`docs/CLOUD-SYNC.md`](docs/CLOUD-SYNC.md)
