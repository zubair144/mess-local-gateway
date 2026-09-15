function tableExists(db, name) {
  const row = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `
    )
    .get(name);

  return Boolean(row);
}

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function addColumnIfMissing(db, table, column, definition) {
  if (!tableExists(db, table)) {
    return;
  }

  const columns = getColumnNames(db, table);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function applyLegacySchema(db) {
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

function applyNewTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_rates (
      id TEXT PRIMARY KEY,
      meal_type TEXT NOT NULL UNIQUE,
      rate REAL NOT NULL DEFAULT 0,
      parcel_charge REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      effective_from TEXT,
      updated_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meal_timings (
      id TEXT PRIMARY KEY,
      meal_type TEXT NOT NULL UNIQUE,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      sync_version INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS employee_ledger (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      employee_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY(employee_id) REFERENCES employees(id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
  `);
}

function migrateExistingColumns(db) {
  addColumnIfMissing(db, "employees", "cloud_id", "TEXT");
  addColumnIfMissing(db, "employees", "is_active", "INTEGER");
  addColumnIfMissing(db, "employees", "created_at", "TEXT");
  addColumnIfMissing(db, "employees", "sync_version", "INTEGER DEFAULT 0");

  db.exec(`
    UPDATE employees
    SET is_active = COALESCE(is_active, active, 1)
    WHERE is_active IS NULL
  `);

  db.exec(`
    UPDATE employees
    SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP)
    WHERE created_at IS NULL OR created_at = ''
  `);

  db.exec(`
    UPDATE employees
    SET sync_version = COALESCE(sync_version, 0)
    WHERE sync_version IS NULL
  `);

  addColumnIfMissing(db, "transactions", "local_transaction_id", "TEXT");
  addColumnIfMissing(db, "transactions", "cloud_transaction_id", "TEXT");
  addColumnIfMissing(db, "transactions", "source", "TEXT");
  addColumnIfMissing(db, "transactions", "meal_type", "TEXT");
  addColumnIfMissing(db, "transactions", "meal_rate", "REAL");
  addColumnIfMissing(db, "transactions", "parcel_charge", "REAL DEFAULT 0");
  addColumnIfMissing(db, "transactions", "total_amount", "REAL");
  addColumnIfMissing(db, "transactions", "balance_before", "REAL");
  addColumnIfMissing(db, "transactions", "balance_after", "REAL");
  addColumnIfMissing(db, "transactions", "status", "TEXT");
  addColumnIfMissing(db, "transactions", "print_status", "TEXT");

  db.exec(`
    UPDATE transactions
    SET
      local_transaction_id = COALESCE(NULLIF(local_transaction_id, ''), id),
      source = COALESCE(NULLIF(source, ''), identification_method),
      meal_type = COALESCE(NULLIF(meal_type, ''), lower(meal_name)),
      meal_rate = COALESCE(meal_rate, amount),
      parcel_charge = COALESCE(parcel_charge, 0),
      total_amount = COALESCE(total_amount, amount),
      balance_before = COALESCE(balance_before, previous_balance),
      balance_after = COALESCE(balance_after, new_balance),
      status = COALESCE(NULLIF(status, ''), 'completed'),
      print_status = COALESCE(NULLIF(print_status, ''), 'pending')
  `);

  addColumnIfMissing(db, "sync_queue", "payload_json", "TEXT");
  addColumnIfMissing(db, "sync_queue", "attempt_count", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "sync_queue", "updated_at", "TEXT");

  db.exec(`
    UPDATE sync_queue
    SET
      payload_json = COALESCE(NULLIF(payload_json, ''), payload),
      attempt_count = COALESCE(attempt_count, retry_count, 0),
      updated_at = COALESCE(updated_at, created_at)
  `);
}

function migrateLegacyMealSettings(db) {
  const rateCount = db.prepare("SELECT COUNT(*) AS count FROM meal_rates").get().count;
  const timingCount = db.prepare("SELECT COUNT(*) AS count FROM meal_timings").get().count;

  if (rateCount > 0 && timingCount > 0) {
    return;
  }

  const legacyMeals = db
    .prepare(
      `
      SELECT *
      FROM meal_settings
      ORDER BY meal_name ASC
    `
    )
    .all();

  const insertRate = db.prepare(`
    INSERT OR IGNORE INTO meal_rates (
      id,
      meal_type,
      rate,
      parcel_charge,
      is_active,
      effective_from,
      updated_at,
      sync_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `);

  const insertTiming = db.prepare(`
    INSERT OR IGNORE INTO meal_timings (
      id,
      meal_type,
      start_time,
      end_time,
      is_active,
      updated_at,
      sync_version
    ) VALUES (?, ?, ?, ?, ?, ?, 0)
  `);

  for (const meal of legacyMeals) {
    const mealType = String(meal.meal_name || "")
      .trim()
      .toLowerCase();

    if (!mealType) {
      continue;
    }

    const now = new Date().toISOString();

    if (rateCount === 0) {
      insertRate.run(
        meal.id || mealType,
        mealType,
        Number(meal.rate || 0),
        Number(meal.parcel_charge || 0),
        meal.active ? 1 : 0,
        now,
        meal.updated_at || now
      );
    }

    if (timingCount === 0) {
      insertTiming.run(
        meal.id || mealType,
        mealType,
        meal.start_time,
        meal.end_time,
        meal.active ? 1 : 0,
        meal.updated_at || now
      );
    }
  }
}

function migrateGatewaySettings(db) {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM gateway_settings").get().count;
  if (existing > 0) {
    return;
  }

  const legacy = db.prepare("SELECT key, value FROM settings").all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO gateway_settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `);

  const now = new Date().toISOString();
  for (const row of legacy) {
    insert.run(row.key, row.value, now);
  }
}

function applyIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_employee_code
    ON employees(employee_code);
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_qr_code
    ON employees(qr_code)
    WHERE qr_code IS NOT NULL AND TRIM(qr_code) != '';
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_face_device_user_id
    ON employees(face_device_user_id)
    WHERE face_device_user_id IS NOT NULL AND TRIM(face_device_user_id) != '';
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_local_transaction_id
    ON transactions(local_transaction_id)
    WHERE local_transaction_id IS NOT NULL AND TRIM(local_transaction_id) != '';
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_employee_meal_time
    ON transactions(employee_id, meal_type, transaction_time);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_sync_status
    ON transactions(sync_status);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ledger_employee_created
    ON employee_ledger(employee_id, created_at);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status_created
    ON sync_queue(status, created_at);
  `);
}

function applySchema(db) {
  applyLegacySchema(db);
  applyNewTables(db);
  migrateExistingColumns(db);
  migrateLegacyMealSettings(db);
  migrateGatewaySettings(db);
  applyIndexes(db);
}

module.exports = {
  applySchema,
};
