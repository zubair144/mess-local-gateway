# Local Transaction Engine

The gateway uses one shared SQLite-backed engine for Face, QR, and manual/API meal processing.

## Flow

```text
Face / QR / Manual API
        ↓
processMealTransaction()
        ↓
Validation (employee, eligibility, meal window, rate, duplicate, balance)
        ↓
SQLite IMMEDIATE transaction
        ↓
transactions + employee_ledger + employees.available_balance + sync_queue
        ↓
COMMIT
        ↓
Receipt print (success only)
```

Entry point: `src/services/meal-transaction.service.js`

Hardware and HTTP routes call the same function through `src/services/transaction-service.js`.

## Validation order

1. `EMPLOYEE_NOT_FOUND`
2. `EMPLOYEE_INACTIVE`
3. `MESS_NOT_ELIGIBLE`
4. `NO_ACTIVE_MEAL` (from `meal_timings`, timezone `Asia/Karachi`)
5. `MEAL_RATE_NOT_CONFIGURED`
6. `MEAL_ALREADY_TAKEN` (employee + meal + operational date, cross-source)
7. `INSUFFICIENT_BALANCE`

## SQLite tables

| Table | Purpose |
|---|---|
| `employees` | Local employee master + cached balance |
| `meal_rates` | Active meal pricing |
| `meal_timings` | Meal windows |
| `meal_settings` | Legacy table (migrated into rates/timings when empty) |
| `transactions` | Completed local meal transactions |
| `employee_ledger` | Financial audit trail (`meal`, etc.) |
| `sync_queue` | Pending cloud sync payloads |
| `gateway_settings` | Local gateway configuration |

Existing databases are migrated in place (`ALTER TABLE`, no destructive drops).

## Duplicate prevention

- Business rule: one completed buffet meal per employee, meal type, and operational date.
- Enforced inside the SQLite transaction before balance deduction.
- Unique index `idx_employee_meal_date` provides a final safety net.
- Hardware duplicate windows (`FACE_DUPLICATE_WINDOW_MS`, `QR_DUPLICATE_WINDOW_MS`) only suppress repeated raw device events.

## Printer behavior

- Receipt printing happens **after** successful SQLite `COMMIT`.
- Declined transactions do not print (unless `PRINT_DECLINED_RECEIPTS=true` in future).
- If printing fails after commit, the transaction remains `completed` and `print_status=failed`.

## APIs

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | Service health |
| GET | `/api/local/employees` | Employee list/search |
| GET | `/api/local/employees/:id` | Employee + ledger + transactions |
| GET | `/api/local/transactions` | Filters: `date`, `employee`, `meal`, `source`, `sync_status` |
| GET | `/api/local/sync-queue` | Queue counts + items |
| GET | `/api/local/dashboard` | Dashboard polling payload |
| POST | `/api/local/meal/process` | Manual test hook into the same engine |
| POST | `/api/meal/face` | Face simulation |
| POST | `/api/meal/qr` | QR simulation |
| POST | `/api/printer/test` | One test receipt |

## Demo seed

```bash
npm run seed:demo
```

Seeds `EMP001`, `EMP002`, meal rates, and adjusts lunch timing to include the current Karachi time.

Optional development override:

```env
DEV_FORCE_MEAL=lunch
```

## Dashboard

- URL: `http://localhost:5050/gateway` (also served at `/`)
- Poll interval: `DASHBOARD_POLL_MS` (default 3000 ms)
- Cloud sync buttons are disabled until cloud sync is implemented.

## Testing

```bash
npm test
```

Covers success, duplicate (cross-source), insufficient balance, inactive, ineligible, and not-found paths.

## Cloud sync (next phase)

`sync_queue` rows are created with `status=pending` for every successful transaction. Full upload/sync to cloud APIs is intentionally not implemented in this phase.
