const db = require("../db/database");
const config = require("../config");
const { getTimeContext } = require("../utils/time");
const mealTransaction = require("./meal-transaction.service");
const { getSyncStatus } = require("./sync-service");
const hardware = require("../hardware");

function getOperationalDate() {
  return getTimeContext(new Date(), config.timezone).operationalDate;
}

function getSyncQueueSummary() {
  const rows = db
    .prepare(
      `
      SELECT status, COUNT(*) AS count
      FROM sync_queue
      GROUP BY status
    `
    )
    .all();

  const summary = {
    pending: 0,
    processing: 0,
    synced: 0,
    failed: 0,
  };

  for (const row of rows) {
    summary[row.status] = row.count;
  }

  return summary;
}

function getTodayStats() {
  const businessDate = getOperationalDate();

  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_amount), 0) AS amount
      FROM transactions
      WHERE business_date = ?
        AND COALESCE(status, 'completed') = 'completed'
    `
    )
    .get(businessDate);

  return {
    businessDate,
    count: row.count,
    amount: Number(row.amount || 0),
  };
}

function getRecentTransactions(limit = 20) {
  return db
    .prepare(
      `
      SELECT
        id,
        local_transaction_id,
        employee_code,
        employee_name,
        meal_type,
        meal_name,
        total_amount,
        amount,
        source,
        identification_method,
        status,
        print_status,
        sync_status,
        transaction_time,
        business_date
      FROM transactions
      ORDER BY transaction_time DESC
      LIMIT ?
    `
    )
    .all(limit);
}

function getPendingSyncItems(limit = 20) {
  return db
    .prepare(
      `
      SELECT
        id,
        entity_type,
        entity_id,
        action,
        status,
        attempt_count,
        last_error,
        created_at,
        updated_at
      FROM sync_queue
      WHERE status IN ('pending', 'failed', 'processing')
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(limit);
}

async function getDashboardSnapshot({ probePrinter = false } = {}) {
  const sqlite = db.getStatus();
  const hardwareStatus = await hardware.getHardwareStatus({ probePrinter });
  const sync = getSyncStatus();
  const syncQueue = getSyncQueueSummary();
  const today = getTodayStats();
  const employeeCount = db
    .prepare("SELECT COUNT(*) AS count FROM employees")
    .get().count;

  const cloudSyncLabel = !config.cloudApiUrl
    ? "NOT CONFIGURED"
    : sync.ready
      ? "ONLINE"
      : "OFFLINE";

  return {
    title: "EXECUTIVE MESS LOCAL GATEWAY",
    statusCards: {
      cloudSync: cloudSyncLabel,
      sqlite: sqlite.connected ? "ONLINE" : "OFFLINE",
      zkteco: hardwareStatus.face.ready ? "ONLINE" : "OFFLINE",
      qrScanner: hardwareStatus.qr.ready ? "ONLINE" : "OFFLINE",
      printer: hardwareStatus.printer.ready ? "ONLINE" : "OFFLINE",
    },
    stats: {
      employees: employeeCount,
      todayTransactions: today.count,
      todayAmount: today.amount,
      pendingSync: syncQueue.pending,
      failedSync: syncQueue.failed,
      businessDate: today.businessDate,
    },
    lastEvent: mealTransaction.getLastEvent(),
    recentTransactions: getRecentTransactions(15),
    pendingSync: getPendingSyncItems(15),
    hardware: hardwareStatus,
    sync,
    syncQueue,
    pollIntervalMs: config.dashboardPollMs,
    timezone: config.timezone,
  };
}

module.exports = {
  getDashboardSnapshot,
  getSyncQueueSummary,
  getTodayStats,
  getRecentTransactions,
  getPendingSyncItems,
};
