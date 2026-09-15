# Executive Mess — Local Gateway

Local mess gateway for the Executive Mess. One Node process owns:

- SQLite meal/employee/transaction data
- ZKTeco MB560-VL Face / ADMS listener
- Black Copper BC-8000G QR scanner (USB HID keyboard)
- Zebra receipt printer (ZPL over TCP 9100)
- Local REST API
- Cloud sync placeholder

## Run

```bash
cp .env.example .env   # already created with working hardware values
npm install
npm start
```

Development:

```bash
npm run dev
```

Initialize / migrate SQLite schema (safe, idempotent):

```bash
npm run db:init
```

## Ports

| Service | Default | Notes |
|---|---|---|
| Gateway API | `5050` | Local REST API |
| ZKTeco ADMS | `8080` | Dedicated listener required by the device. Do not merge onto 5050. |

Working production printer:

- `192.168.1.17:9100` (Zebra ZPL over TCP)

## Folder structure

```text
mess-local-gateway/
├── src/
│   ├── hardware/
│   │   ├── face/          Face / ZKTeco ADMS
│   │   ├── qr/            USB HID QR scanner
│   │   ├── printer/       Shared Zebra ZPL printer
│   │   └── index.js
│   ├── routes/
│   ├── services/          SQLite meal / employee / sync
│   ├── db/
│   ├── config/
│   ├── logger.js
│   └── server.js
├── data/mess-local.db
├── docs/
├── .env
├── .env.example
└── package.json
```

## Local APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Existing health check |
| GET | `/api/status` | Gateway + hardware + SQLite status |
| GET | `/api/hardware/status` | Face / QR / printer |
| POST | `/api/meal/serve` | Direct meal serve (`qr` / `face` / `manual`) |
| POST | `/api/meal/face` | Face identifier → transaction + optional print |
| POST | `/api/meal/qr` | QR identifier → transaction + optional print |
| POST | `/api/printer/test` | Print the working Zebra test receipt |
| GET | `/employees` | Active employees |
| GET | `/transactions` | Local transactions |
| GET | `/sync/pending` | Pending cloud sync queue |

Hardware-triggered Face and QR events still print the proven working receipts even if the employee is not yet in SQLite. Meal deduction is attempted through `processMealTransaction()` and can be disabled with `HARDWARE_PROCESS_MEALS=false`.

## Hardware docs

See:

- [`docs/HARDWARE-INTEGRATION.md`](docs/HARDWARE-INTEGRATION.md)
- [`docs/MIGRATION-zkteco-mb560-test.md`](docs/MIGRATION-zkteco-mb560-test.md)
