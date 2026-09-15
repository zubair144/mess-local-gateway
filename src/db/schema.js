function applySchema(db) {
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,

      employee_id TEXT NOT NULL,
      employee_code TEXT NOT NULL,
      employee_name TEXT NOT NULL,

      meal_id TEXT,
      meal_name TEXT NOT NULL,

      amount REAL NOT NULL,

      previous_balance REAL NOT NULL,
      new_balance REAL NOT NULL,

      identification_method TEXT NOT NULL,
      identifier TEXT,

      device_id TEXT,

      transaction_time TEXT NOT NULL,

      business_date TEXT NOT NULL,

      sync_status TEXT DEFAULT 'pending',

      synced_at TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY(employee_id)
        REFERENCES employees(id)
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_meal_date
    ON transactions (
      employee_id,
      meal_name,
      business_date
    );
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

module.exports = {
  applySchema,
};
