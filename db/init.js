const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "../data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "mess-local.db");

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("SQLite database:", dbPath);

/*
|--------------------------------------------------------------------------
| Employees
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    employee_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    department_id TEXT,

    qr_code TEXT UNIQUE,
    face_device_user_id TEXT,

    mess_eligible INTEGER DEFAULT 1,

    monthly_allowance REAL DEFAULT 0,
    available_balance REAL DEFAULT 0,

    active INTEGER DEFAULT 1,

    updated_at TEXT,
    synced_at TEXT
);
`);

/*
|--------------------------------------------------------------------------
| Meal Settings
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS meal_settings (
    id TEXT PRIMARY KEY,
    meal_name TEXT NOT NULL,

    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,

    rate REAL DEFAULT 0,
    parcel_charge REAL DEFAULT 0,

    active INTEGER DEFAULT 1,

    updated_at TEXT
);
`);

/*
|--------------------------------------------------------------------------
| Transactions
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,

    employee_id TEXT,

    transaction_type TEXT NOT NULL,

    meal_name TEXT,

    amount REAL DEFAULT 0,
    previous_balance REAL DEFAULT 0,
    new_balance REAL DEFAULT 0,

    guest_count INTEGER DEFAULT 0,

    identification_method TEXT,

    device_id TEXT,

    transaction_time TEXT NOT NULL,

    sync_status TEXT DEFAULT 'pending',

    synced_at TEXT,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(employee_id)
        REFERENCES employees(id)
);
`);

/*
|--------------------------------------------------------------------------
| Device Events
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS device_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    device_id TEXT,
    device_type TEXT,

    user_identifier TEXT,

    event_type TEXT,

    raw_data TEXT,

    processed INTEGER DEFAULT 0,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

/*
|--------------------------------------------------------------------------
| Sync Queue
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,

    action TEXT NOT NULL,

    payload TEXT NOT NULL,

    status TEXT DEFAULT 'pending',

    retry_count INTEGER DEFAULT 0,

    last_error TEXT,

    created_at TEXT DEFAULT CURRENT_TIMESTAMP,

    synced_at TEXT
);
`);

/*
|--------------------------------------------------------------------------
| Local Settings
|--------------------------------------------------------------------------
*/

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
`);

console.log("✅ SQLite database initialized successfully.");

db.close();