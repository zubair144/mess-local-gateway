const defaultDb = require("../db/database");
const logger = require("../logger");
const { setSyncVersion } = require("./sync-state");

/** Sync cursor / status keys we reset. Hardware & cloud URL live in .env, not SQLite. */
const SYNC_CURSOR_KEYS = [
  "last_cloud_sync_version",
  "last_successful_pull_at",
  "last_successful_push_at",
  "last_heartbeat_at",
  "last_cloud_error",
  "cloud_connection_status",
  "demo_seeded_at",
];

/** Keys that must survive a demo reset (identity / reconnect). */
const PRESERVED_SETTING_KEYS = new Set([
  // reserved — cloud URL / gateway id / device settings come from .env today
]);

function countRows(database, table) {
  try {
    return Number(
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0
    );
  } catch (_err) {
    return 0;
  }
}

function deleteAll(database, table) {
  const before = countRows(database, table);
  database.prepare(`DELETE FROM ${table}`).run();
  return before;
}

/**
 * Destructive admin/dev reset of local BUSINESS / DEMO data.
 * Preserves schema, migrations, and .env-backed hardware/cloud configuration.
 * Does NOT push anything to cloud.
 */
function resetLocalDemoData(options = {}) {
  const database = options.database || defaultDb;

  const before = {
    employees: countRows(database, "employees"),
    transactions: countRows(database, "transactions"),
    employeeLedger: countRows(database, "employee_ledger"),
    syncQueue: countRows(database, "sync_queue"),
    deviceEvents: countRows(database, "device_events"),
    mealRates: countRows(database, "meal_rates"),
    mealTimings: countRows(database, "meal_timings"),
    mealSettings: countRows(database, "meal_settings"),
  };

  const run = database.transaction(() => {
    const localReset = {
      employeesDeleted: 0,
      transactionsDeleted: 0,
      employeeLedgerDeleted: 0,
      syncQueueDeleted: 0,
      deviceEventsDeleted: 0,
      mealRatesDeleted: 0,
      mealTimingsDeleted: 0,
      mealSettingsDeleted: 0,
      syncCursorReset: false,
    };

    // Order matters for FK: children first.
    localReset.syncQueueDeleted = deleteAll(database, "sync_queue");
    localReset.employeeLedgerDeleted = deleteAll(database, "employee_ledger");
    localReset.transactionsDeleted = deleteAll(database, "transactions");
    localReset.deviceEventsDeleted = deleteAll(database, "device_events");
    localReset.employeesDeleted = deleteAll(database, "employees");
    localReset.mealRatesDeleted = deleteAll(database, "meal_rates");
    localReset.mealTimingsDeleted = deleteAll(database, "meal_timings");
    localReset.mealSettingsDeleted = deleteAll(database, "meal_settings");

    const placeholders = SYNC_CURSOR_KEYS.map(() => "?").join(", ");
    database
      .prepare(`DELETE FROM gateway_settings WHERE key IN (${placeholders})`)
      .run(...SYNC_CURSOR_KEYS);

    // Keep any explicitly preserved keys (none today — config is env-based).
    for (const key of PRESERVED_SETTING_KEYS) {
      database
        .prepare("SELECT 1 FROM gateway_settings WHERE key = ?")
        .get(key);
    }

    setSyncVersion(database, 0);
    localReset.syncCursorReset = true;

    return localReset;
  });

  const localReset = run.immediate();
  logger.info(
    "ADMIN",
    `reset-demo-data employees=${localReset.employeesDeleted} txs=${localReset.transactionsDeleted} queue=${localReset.syncQueueDeleted}`
  );

  return {
    success: true,
    localReset,
    before,
    lastPulledVersion: 0,
    preserved: {
      schema: true,
      gatewayEnvConfig: true,
      hardwareEnvConfig: true,
      migrations: true,
    },
  };
}

module.exports = {
  resetLocalDemoData,
  SYNC_CURSOR_KEYS,
  PRESERVED_SETTING_KEYS,
};
