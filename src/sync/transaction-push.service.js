const defaultDb = require("../db/database");
const config = require("../config");
const logger = require("../logger");
const { displayMealName, normalizeSource } = require("../utils/format");
const {
  markPushSuccess,
  markCloudFailure,
  nowIso,
} = require("./sync-state");
const { pendingUnsyncedDebits, effectiveBalance } = require("./master-pull.service");

const SUCCESS_STATUSES = new Set(["synced", "already_synced"]);

function retryDelayMs(attemptCount, baseMs, maxMs) {
  const exponent = Math.max(0, Number(attemptCount) - 1);
  const delay = Number(baseMs) * Math.pow(2, exponent);
  return Math.min(delay, Number(maxMs) || delay);
}

function nextAttemptAt(attemptCount, options = {}) {
  const maxAttempts = options.maxAttempts || config.syncMaxAttempts;
  if (attemptCount >= maxAttempts) {
    return null;
  }
  const delay = retryDelayMs(
    attemptCount,
    options.baseMs || config.syncRetryBaseMs,
    options.maxMs || config.syncRetryMaxMs
  );
  return new Date(Date.now() + delay).toISOString();
}

function parsePayload(row) {
  const raw = row.payload_json || row.payload;
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function selectEligibleRows(database, { limit, now } = {}) {
  const maxAttempts = config.syncMaxAttempts;
  return database
    .prepare(
      `
      SELECT *
      FROM sync_queue
      WHERE entity_type = 'meal_transaction'
        AND (
          status = 'pending'
          OR (
            status = 'failed'
            AND attempt_count < ?
            AND next_attempt_at IS NOT NULL
            AND next_attempt_at <= ?
          )
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?
    `
    )
    .all(maxAttempts, now, now, limit);
}

function markProcessing(database, ids, now) {
  if (!ids.length) {
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  database
    .prepare(
      `
      UPDATE sync_queue
      SET status = 'processing', last_attempt_at = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `
    )
    .run(now, now, ...ids);
}

function loadTransaction(database, entityId) {
  return database
    .prepare(
      `
      SELECT
        t.*,
        e.cloud_id AS employee_cloud_id,
        e.id AS employee_row_id
      FROM transactions t
      LEFT JOIN employees e ON e.id = t.employee_id
      WHERE t.local_transaction_id = ?
         OR t.id = ?
      LIMIT 1
    `
    )
    .get(entityId, entityId);
}

function buildCloudTransaction(queueRow, txn) {
  const snapshot = parsePayload(queueRow);
  const mealTypeRaw = (txn && (txn.meal_type || txn.meal_name)) || snapshot.mealType || snapshot.mealName || "";
  const source = normalizeSource((txn && (txn.source || txn.identification_method)) || snapshot.source || "qr");

  return {
    localTransactionId:
      (txn && (txn.local_transaction_id || txn.id)) ||
      snapshot.localTransactionId ||
      queueRow.entity_id,
    employeeCloudId:
      (txn && txn.employee_cloud_id) || snapshot.employeeCloudId || "",
    employeeCode:
      (txn && txn.employee_code) || snapshot.employeeCode || "",
    source,
    mealType: displayMealName(mealTypeRaw),
    mealRate: Number((txn && txn.meal_rate) != null ? txn.meal_rate : snapshot.mealRate) || 0,
    totalAmount:
      Number((txn && (txn.total_amount != null ? txn.total_amount : txn.amount)) || snapshot.totalAmount) || 0,
    transactionTime:
      (txn && txn.transaction_time) || snapshot.transactionTime || queueRow.created_at,
    balanceBefore:
      Number((txn && (txn.balance_before != null ? txn.balance_before : txn.previous_balance)) || snapshot.balanceBefore) || 0,
    balanceAfter:
      Number((txn && (txn.balance_after != null ? txn.balance_after : txn.new_balance)) || snapshot.balanceAfter) || 0,
    printStatus: (txn && txn.print_status) || snapshot.printStatus || "",
    _queueId: queueRow.id,
    _employeeRowId: txn && txn.employee_row_id,
  };
}

function updateQueueRow(database, id, fields) {
  const now = nowIso();
  database
    .prepare(
      `
      UPDATE sync_queue
      SET
        status = ?,
        attempt_count = ?,
        retry_count = ?,
        last_error = ?,
        last_attempt_at = ?,
        next_attempt_at = ?,
        cloud_transaction_id = ?,
        synced_at = ?,
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(
      fields.status,
      fields.attemptCount,
      fields.attemptCount,
      fields.lastError || null,
      fields.lastAttemptAt || now,
      fields.nextAttemptAt,
      fields.cloudTransactionId || null,
      fields.syncedAt || null,
      now,
      id
    );
}

function markTransactionSynced(database, localTransactionId, cloudTransactionId) {
  const now = nowIso();
  database
    .prepare(
      `
      UPDATE transactions
      SET
        sync_status = 'synced',
        cloud_transaction_id = COALESCE(?, cloud_transaction_id),
        synced_at = ?
      WHERE local_transaction_id = ?
         OR id = ?
    `
    )
    .run(cloudTransactionId || null, now, localTransactionId, localTransactionId);

  database
    .prepare(
      `
      UPDATE employee_ledger
      SET sync_status = 'synced'
      WHERE transaction_id = ?
    `
    )
    .run(localTransactionId);
}

function reconcileCloudBalance(database, employeeId, cloudBalance) {
  if (!employeeId || cloudBalance == null || !Number.isFinite(Number(cloudBalance))) {
    return;
  }

  const pending = pendingUnsyncedDebits(database, employeeId);
  const available = effectiveBalance(cloudBalance, pending);
  database
    .prepare(
      `
      UPDATE employees
      SET
        cloud_balance = ?,
        available_balance = ?,
        updated_at = ?
      WHERE id = ?
    `
    )
    .run(Number(cloudBalance), available, nowIso(), employeeId);
}

function applySuccess(database, queueRow, result, mapped) {
  const attemptCount = Number(queueRow.attempt_count || 0) + 1;
  updateQueueRow(database, queueRow.id, {
    status: "synced",
    attemptCount,
    lastError: null,
    nextAttemptAt: null,
    cloudTransactionId: result.cloudTransactionId || null,
    syncedAt: nowIso(),
  });
  markTransactionSynced(
    database,
    mapped.localTransactionId,
    result.cloudTransactionId
  );
  reconcileCloudBalance(database, mapped._employeeRowId, result.cloudBalance);
}

function applyFailure(database, queueRow, result, options = {}) {
  const attemptCount = Number(queueRow.attempt_count || 0) + 1;
  const errorText = [result.errorCode, result.message || result.error]
    .filter(Boolean)
    .join(": ");
  const next = options.authFailure
    ? new Date(Date.now() + (config.syncRetryMaxMs || 300000)).toISOString()
    : nextAttemptAt(attemptCount, options);

  updateQueueRow(database, queueRow.id, {
    status: "failed",
    attemptCount,
    lastError: errorText || "Cloud sync failed",
    nextAttemptAt: next,
    cloudTransactionId: queueRow.cloud_transaction_id || null,
    syncedAt: null,
  });
}

function revertBatch(database, rows, error, options = {}) {
  for (const row of rows) {
    applyFailure(
      database,
      row,
      {
        errorCode: error.code || "NETWORK",
        message: error.message || "Cloud unavailable",
      },
      options
    );
  }
}

async function pushPendingTransactions({
  database = defaultDb,
  client,
  limit,
} = {}) {
  if (!client) {
    throw new Error("Cloud client is required");
  }

  const batchSize = Math.min(
    Math.max(1, Number(limit || config.syncBatchSize) || 50),
    100
  );
  const now = nowIso();
  const rows = selectEligibleRows(database, { limit: batchSize, now });

  if (!rows.length) {
    return {
      ok: true,
      pendingBefore: 0,
      uploaded: 0,
      synced: 0,
      failed: 0,
      alreadySynced: 0,
    };
  }

  logger.info("CLOUD-PUSH", `uploading ${rows.length} transactions`);
  markProcessing(database, rows.map((row) => row.id), now);

  const mapped = rows.map((row) => {
    const txn = loadTransaction(database, row.entity_id);
    return { row, payload: buildCloudTransaction(row, txn) };
  });

  const body = mapped.map((item) => {
    const tx = { ...item.payload };
    delete tx._queueId;
    delete tx._employeeRowId;
    return tx;
  });

  let response;
  try {
    response = await client.pushTransactions(body);
  } catch (error) {
    const authFailure = Boolean(error && error.authFailure);
    revertBatch(database, rows, error, { authFailure });
    markCloudFailure(database, error);
    if (authFailure) {
      logger.error("CLOUD-PUSH", "authentication failed - check GATEWAY_ID / GATEWAY_API_KEY");
    } else {
      logger.warn("SYNC", "cloud unavailable - local service continues");
      logger.warn("CLOUD-PUSH", error.message || error);
    }
    return {
      ok: false,
      pendingBefore: rows.length,
      uploaded: rows.length,
      synced: 0,
      failed: rows.length,
      alreadySynced: 0,
      error: error.message || String(error),
      authFailure,
    };
  }

  const results = Array.isArray(response && response.results) ? response.results : [];
  const byLocalId = new Map();
  for (const result of results) {
    if (result && result.localTransactionId) {
      byLocalId.set(String(result.localTransactionId), result);
    }
  }

  let synced = 0;
  let alreadySynced = 0;
  let failed = 0;

  const applyResults = database.transaction(() => {
    for (const item of mapped) {
      const result =
        byLocalId.get(item.payload.localTransactionId) || {
          localTransactionId: item.payload.localTransactionId,
          status: "failed",
          errorCode: "MISSING_RESULT",
          message: "Cloud did not return a result for this transaction",
        };

      if (SUCCESS_STATUSES.has(String(result.status || "").toLowerCase())) {
        applySuccess(database, item.row, result, item.payload);
        if (String(result.status).toLowerCase() === "already_synced") {
          alreadySynced += 1;
        } else {
          synced += 1;
        }
      } else {
        applyFailure(database, item.row, result);
        failed += 1;
      }
    }
  });

  applyResults();
  markPushSuccess(database);

  logger.info("CLOUD-PUSH", `${synced + alreadySynced} synced, ${failed} failed`);

  return {
    ok: failed === 0,
    pendingBefore: rows.length,
    uploaded: rows.length,
    synced: synced + alreadySynced,
    alreadySynced,
    failed,
  };
}

function makeFailedRetryable(database = defaultDb) {
  const now = nowIso();
  const result = database
    .prepare(
      `
      UPDATE sync_queue
      SET
        status = 'pending',
        next_attempt_at = ?,
        updated_at = ?
      WHERE status = 'failed'
    `
    )
    .run(now, now);

  return result.changes || 0;
}

function looksLikeDummyQueueRow(row) {
  const haystack = [
    row.entity_id,
    row.payload_json,
    row.payload,
    row.last_error,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  if (
    haystack.includes("dummy") ||
    haystack.includes("test-tx") ||
    haystack.includes("local-dummy") ||
    /\bdemo[-_]?tx\b/.test(haystack)
  ) {
    return true;
  }

  // Demo-seed meals (EMP001/EMP002 / emp-001) that never had a cloud employee id.
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json || row.payload || "{}") || {};
  } catch {
    payload = {};
  }
  const code = String(payload.employeeCode || "").toUpperCase();
  const localEmpId = String(payload.employeeId || "").toLowerCase();
  const cloudId = String(payload.employeeCloudId || payload.cloudId || "").trim();
  const demoCodes = new Set(["EMP001", "EMP002"]);
  const demoLocalIds = new Set(["emp-001", "emp-002"]);
  if (!cloudId && (demoCodes.has(code) || demoLocalIds.has(localEmpId))) {
    return true;
  }

  return false;
}

/**
 * Development/admin helper: remove ONLY failed queue rows that look like dummy/test
 * uploads. Never deletes transaction history or non-dummy failed rows.
 */
function clearFailedDummyTransactions(database = defaultDb) {
  const failed = database
    .prepare(
      `
      SELECT id, entity_id, payload, payload_json, last_error
      FROM sync_queue
      WHERE status = 'failed'
    `
    )
    .all();

  const ids = failed.filter(looksLikeDummyQueueRow).map((row) => row.id);
  if (!ids.length) {
    return { cleared: 0, inspected: failed.length };
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = database
    .prepare(`DELETE FROM sync_queue WHERE id IN (${placeholders}) AND status = 'failed'`)
    .run(...ids);

  return {
    cleared: result.changes || 0,
    inspected: failed.length,
    ids,
  };
}

module.exports = {
  pushPendingTransactions,
  makeFailedRetryable,
  clearFailedDummyTransactions,
  looksLikeDummyQueueRow,
  retryDelayMs,
  nextAttemptAt,
  buildCloudTransaction,
  SUCCESS_STATUSES,
};
