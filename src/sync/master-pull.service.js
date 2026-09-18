const crypto = require("crypto");
const defaultDb = require("../db/database");
const logger = require("../logger");
const { normalizeRfidUid } = require("../utils/rfid");
const {
  getSyncVersion,
  markPullSuccess,
  markCloudFailure,
} = require("./sync-state");

function normalizeMealType(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function asIso(value) {
  if (!value) {
    return new Date().toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function isTruthyFlag(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (value === true || value === 1 || value === "1") {
    return true;
  }
  if (value === false || value === 0 || value === "0") {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "active", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "inactive", "no"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function pendingUnsyncedDebits(database, employeeId) {
  const row = database
    .prepare(
      `
      SELECT COALESCE(SUM(COALESCE(total_amount, amount)), 0) AS pending
      FROM transactions
      WHERE employee_id = ?
        AND COALESCE(status, 'completed') = 'completed'
        AND COALESCE(sync_status, 'pending') != 'synced'
    `
    )
    .get(employeeId);

  return Number(row && row.pending ? row.pending : 0) || 0;
}

function effectiveBalance(cloudBalance, pendingDebits) {
  const cloud = Number(cloudBalance);
  const pending = Number(pendingDebits) || 0;
  const safeCloud = Number.isFinite(cloud) ? cloud : 0;
  return Number((safeCloud - pending).toFixed(2));
}

function findEmployee(database, cloudId, employeeCode) {
  if (cloudId) {
    const byCloud = database
      .prepare("SELECT * FROM employees WHERE cloud_id = ?")
      .get(cloudId);
    if (byCloud) {
      return byCloud;
    }
  }

  if (employeeCode) {
    return database
      .prepare("SELECT * FROM employees WHERE employee_code = ?")
      .get(employeeCode);
  }

  return null;
}

function clearDuplicateFaceId(database, faceDeviceUserId, keepId) {
  if (!faceDeviceUserId) {
    return;
  }

  database
    .prepare(
      `
      UPDATE employees
      SET face_device_user_id = NULL
      WHERE face_device_user_id = ?
        AND id != ?
    `
    )
    .run(faceDeviceUserId, keepId);
}

function clearDuplicateQrHash(database, qrTokenHash, keepId) {
  if (!qrTokenHash) {
    return;
  }

  database
    .prepare(
      `
      UPDATE employees
      SET qr_token_hash = NULL
      WHERE qr_token_hash = ?
        AND id != ?
    `
    )
    .run(qrTokenHash, keepId);
}

function clearDuplicateRfidUid(database, rfidUid, keepId) {
  if (!rfidUid) {
    return;
  }

  database
    .prepare(
      `
      UPDATE employees
      SET rfid_uid = NULL
      WHERE rfid_uid = ?
        AND id != ?
    `
    )
    .run(rfidUid, keepId);
}

function applyEmployee(database, employee) {
  const cloudId = String(employee.cloudId || employee.id || "").trim();
  const employeeCode = String(employee.employeeCode || "").trim();

  if (!cloudId && !employeeCode) {
    throw new Error("Cloud employee is missing cloudId and employeeCode");
  }

  const existing = findEmployee(database, cloudId, employeeCode);
  const now = asIso(employee.updatedAt);
  const isDeleted = employee.isDeleted === true;
  const isActive = !isDeleted && isTruthyFlag(employee.isActive, true);
  const messEligible = !isDeleted && isTruthyFlag(employee.messEligible, true);
  const incomingCloudBalance = Number(employee.availableBalance);
  const cloudBalance = Number.isFinite(incomingCloudBalance)
    ? incomingCloudBalance
    : existing
      ? Number(existing.cloud_balance || existing.available_balance || 0)
      : 0;
  const qrTokenHash = String(employee.qrTokenHash || "").trim();
  const qrStatus = String(employee.qrStatus || "").trim() || null;
  const rfidUid = normalizeRfidUid(employee.rfidCardUid || employee.cardId);
  const faceDeviceUserId = String(employee.faceDeviceUserId || "").trim();
  const faceTemplateId = String(employee.faceTemplateId || "").trim();
  const department = String(employee.department || "").trim();
  const departmentId = String(employee.departmentId || "").trim() || department;
  const incomingAllowance = Number(
    employee.monthlyAllowance != null
      ? employee.monthlyAllowance
      : employee.monthlyMessAllowance
  );
  const monthlyAllowance = Number.isFinite(incomingAllowance)
    ? incomingAllowance
    : existing
      ? Number(existing.monthly_allowance || 0)
      : 0;
  const localId = existing ? existing.id : cloudId || crypto.randomUUID();
  const pendingDebits = existing ? pendingUnsyncedDebits(database, existing.id) : 0;
  const availableBalance = effectiveBalance(cloudBalance, pendingDebits);

  if (faceDeviceUserId) {
    clearDuplicateFaceId(database, faceDeviceUserId, localId);
  }
  if (qrTokenHash) {
    clearDuplicateQrHash(database, qrTokenHash, localId);
  }
  if (rfidUid) {
    clearDuplicateRfidUid(database, rfidUid, localId);
  }

  if (existing) {
    database
      .prepare(
        `
        UPDATE employees
        SET
          cloud_id = COALESCE(NULLIF(?, ''), cloud_id),
          employee_code = COALESCE(NULLIF(?, ''), employee_code),
          name = ?,
          department_id = ?,
          department = ?,
          qr_token_hash = ?,
          qr_status = ?,
          qr_code = CASE WHEN ? != '' THEN NULL ELSE qr_code END,
          rfid_uid = ?,
          face_device_user_id = ?,
          face_template_id = ?,
          mess_eligible = ?,
          is_active = ?,
          active = ?,
          monthly_allowance = ?,
          cloud_balance = ?,
          available_balance = ?,
          sync_version = ?,
          updated_at = ?,
          synced_at = ?
        WHERE id = ?
      `
      )
      .run(
        cloudId,
        employeeCode,
        String(employee.name || existing.name || employeeCode),
        departmentId,
        department,
        qrTokenHash || null,
        qrStatus,
        qrTokenHash,
        rfidUid || null,
        faceDeviceUserId || null,
        faceTemplateId || null,
        messEligible ? 1 : 0,
        isActive ? 1 : 0,
        isActive ? 1 : 0,
        monthlyAllowance,
        cloudBalance,
        availableBalance,
        Number(employee.syncVersion || 0) || 0,
        now,
        now,
        existing.id
      );

    return "updated";
  }

  database
    .prepare(
      `
      INSERT INTO employees (
        id,
        cloud_id,
        employee_code,
        name,
        department_id,
        department,
        qr_code,
        qr_token_hash,
        qr_status,
        rfid_uid,
        face_device_user_id,
        face_template_id,
        mess_eligible,
        monthly_allowance,
        available_balance,
        cloud_balance,
        active,
        is_active,
        created_at,
        updated_at,
        synced_at,
        sync_version
      ) VALUES (
        ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `
      )
      .run(
      localId,
      cloudId || null,
      employeeCode,
      String(employee.name || employeeCode),
      departmentId,
      department,
      qrTokenHash || null,
      qrStatus,
      rfidUid || null,
      faceDeviceUserId || null,
      faceTemplateId || null,
      messEligible ? 1 : 0,
      monthlyAllowance,
      availableBalance,
      cloudBalance,
      isActive ? 1 : 0,
      isActive ? 1 : 0,
      now,
      now,
      now,
      Number(employee.syncVersion || 0) || 0
    );

  return "inserted";
}

function deactivateMealRecord(database, table, cloudId, mealType) {
  if (cloudId) {
    database
      .prepare(
        `
        UPDATE ${table}
        SET is_active = 0, updated_at = ?
        WHERE cloud_id = ? OR id = ?
      `
      )
      .run(new Date().toISOString(), cloudId, cloudId);
  }

  if (mealType) {
    database
      .prepare(
        `
        UPDATE ${table}
        SET is_active = 0, updated_at = ?
        WHERE meal_type = ?
      `
      )
      .run(new Date().toISOString(), mealType);
  }
}

function applyMealRate(database, rate) {
  const cloudId = String(rate.cloudId || rate.id || "").trim();
  const mealType = normalizeMealType(rate.mealType);
  const deleted = rate.isDeleted === true;

  if (deleted) {
    deactivateMealRecord(database, "meal_rates", cloudId, mealType);
    return "deactivated";
  }

  if (String(rate.source || "").toLowerCase() === "history") {
    return "skipped";
  }

  if (!mealType) {
    return "skipped";
  }

  const now = asIso(rate.updatedAt);
  const isActive = isTruthyFlag(rate.isActive, true) ? 1 : 0;

  database
    .prepare(
      `
      INSERT INTO meal_rates (
        id,
        cloud_id,
        meal_type,
        rate,
        parcel_charge,
        is_active,
        effective_from,
        updated_at,
        sync_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meal_type) DO UPDATE SET
        cloud_id = COALESCE(excluded.cloud_id, meal_rates.cloud_id),
        rate = excluded.rate,
        parcel_charge = excluded.parcel_charge,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at,
        sync_version = excluded.sync_version
    `
    )
    .run(
      cloudId || mealType,
      cloudId || null,
      mealType,
      Number(rate.rate || 0) || 0,
      Number(rate.parcelCharge || 0) || 0,
      isActive,
      rate.effectiveFrom || now,
      now,
      Number(rate.syncVersion || 0) || 0
    );

  return "updated";
}

function applyMealTiming(database, timing) {
  const cloudId = String(timing.cloudId || timing.id || "").trim();
  const mealType = normalizeMealType(timing.mealType);
  const deleted = timing.isDeleted === true;

  if (deleted) {
    deactivateMealRecord(database, "meal_timings", cloudId, mealType);
    return "deactivated";
  }

  if (!mealType || !timing.startTime || !timing.endTime) {
    return "skipped";
  }

  const now = asIso(timing.updatedAt);
  const isActive = isTruthyFlag(timing.isActive, true) ? 1 : 0;

  database
    .prepare(
      `
      INSERT INTO meal_timings (
        id,
        cloud_id,
        meal_type,
        start_time,
        end_time,
        is_active,
        updated_at,
        sync_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(meal_type) DO UPDATE SET
        cloud_id = COALESCE(excluded.cloud_id, meal_timings.cloud_id),
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        is_active = excluded.is_active,
        updated_at = excluded.updated_at,
        sync_version = excluded.sync_version
    `
    )
    .run(
      cloudId || mealType,
      cloudId || null,
      mealType,
      String(timing.startTime).trim(),
      String(timing.endTime).trim(),
      isActive,
      now,
      Number(timing.syncVersion || 0) || 0
    );

  return "updated";
}

function removeStaleEmployees(database, keptCloudIds, keptCodes) {
  const rows = database
    .prepare("SELECT id, cloud_id, employee_code FROM employees")
    .all();
  let removed = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const cloudId = String(row.cloud_id || "").trim();
    const code = String(row.employee_code || "").trim();
    const keep =
      (cloudId && keptCloudIds.has(cloudId)) || (code && keptCodes.has(code));
    if (keep) {
      continue;
    }

    try {
      database.prepare("DELETE FROM employees WHERE id = ?").run(row.id);
      removed += 1;
    } catch (_err) {
      // FK references (transactions/ledger) — deactivate instead of failing the pull.
      database
        .prepare(
          `
          UPDATE employees
          SET is_active = 0, active = 0, mess_eligible = 0, updated_at = ?
          WHERE id = ?
        `
        )
        .run(now, row.id);
      removed += 1;
    }
  }

  return removed;
}

function removeStaleMealRows(database, table, keptCloudIds, keptMealTypes) {
  const rows = database
    .prepare(`SELECT id, cloud_id, meal_type FROM ${table}`)
    .all();
  let removed = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const cloudId = String(row.cloud_id || "").trim();
    const mealType = normalizeMealType(row.meal_type);
    const keep =
      (cloudId && keptCloudIds.has(cloudId)) ||
      (mealType && keptMealTypes.has(mealType));
    if (keep) {
      continue;
    }

    database
      .prepare(
        `
        UPDATE ${table}
        SET is_active = 0, updated_at = ?
        WHERE id = ?
      `
      )
      .run(now, row.id);
    removed += 1;
  }

  return removed;
}

function validateMasterSnapshot(payload, { forceFull = false } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Cloud snapshot is empty or invalid");
  }

  const syncVersion = Number(payload.syncVersion);
  if (!Number.isFinite(syncVersion)) {
    throw new Error("Cloud payload is missing a numeric syncVersion");
  }

  if (!Array.isArray(payload.employees)) {
    throw new Error("Cloud snapshot employees must be an array");
  }

  if (payload.mealRates != null && !Array.isArray(payload.mealRates)) {
    throw new Error("Cloud snapshot mealRates must be an array");
  }

  if (payload.mealTimings != null && !Array.isArray(payload.mealTimings)) {
    throw new Error("Cloud snapshot mealTimings must be an array");
  }

  // Force-full must never wipe master data on an obviously broken empty payload
  // when the cloud counter claims history exists.
  if (forceFull && payload.employees.length === 0 && syncVersion > 0) {
    throw new Error(
      "Cloud force-full snapshot returned 0 employees while syncVersion > 0 — refusing to replace local master data"
    );
  }

  return syncVersion;
}

function applyMasterPayload(database, payload, { authoritative = false } = {}) {
  const employees = payload.employees || [];
  const mealRates = payload.mealRates || [];
  const mealTimings = payload.mealTimings || [];
  const departments = payload.departments || [];
  const mealSettings = payload.mealSettings || [];

  const stats = {
    employeesReceived: employees.length,
    employeesUpdated: 0,
    employeesInserted: 0,
    employeesRemoved: 0,
    departmentsReceived: departments.length,
    mealRatesReceived: mealRates.length,
    mealTimingsReceived: mealTimings.length,
    mealSettingsReceived: mealSettings.length,
    ratesUpdated: 0,
    ratesRemoved: 0,
    timingsUpdated: 0,
    timingsRemoved: 0,
  };

  const keptEmployeeCloudIds = new Set();
  const keptEmployeeCodes = new Set();
  const keptRateCloudIds = new Set();
  const keptRateMealTypes = new Set();
  const keptTimingCloudIds = new Set();
  const keptTimingMealTypes = new Set();

  for (const employee of employees) {
    const action = applyEmployee(database, employee || {});
    const cloudId = String((employee && (employee.cloudId || employee.id)) || "").trim();
    const code = String((employee && employee.employeeCode) || "").trim();
    if (cloudId) keptEmployeeCloudIds.add(cloudId);
    if (code) keptEmployeeCodes.add(code);
    if (action === "inserted") {
      stats.employeesInserted += 1;
    } else if (action === "updated") {
      stats.employeesUpdated += 1;
    }
  }

  for (const _dept of departments) {
    // reserved for future department table upserts
  }

  for (const rate of mealRates) {
    const action = applyMealRate(database, rate || {});
    const cloudId = String((rate && (rate.cloudId || rate.id)) || "").trim();
    const mealType = normalizeMealType(rate && rate.mealType);
    if (cloudId) keptRateCloudIds.add(cloudId);
    if (mealType && String((rate && rate.source) || "").toLowerCase() !== "history") {
      keptRateMealTypes.add(mealType);
    }
    if (action === "updated" || action === "deactivated") {
      stats.ratesUpdated += 1;
    }
  }

  for (const timing of mealTimings) {
    const action = applyMealTiming(database, timing || {});
    const cloudId = String((timing && (timing.cloudId || timing.id)) || "").trim();
    const mealType = normalizeMealType(timing && timing.mealType);
    if (cloudId) keptTimingCloudIds.add(cloudId);
    if (mealType) keptTimingMealTypes.add(mealType);
    if (action === "updated" || action === "deactivated") {
      stats.timingsUpdated += 1;
    }
  }

  for (const setting of mealSettings) {
    if (setting && (setting.rate != null || setting.mealType)) {
      const action = applyMealRate(database, setting);
      const cloudId = String((setting.cloudId || setting.id) || "").trim();
      const mealType = normalizeMealType(setting.mealType);
      if (cloudId) keptRateCloudIds.add(cloudId);
      if (mealType) keptRateMealTypes.add(mealType);
      if (action === "updated" || action === "deactivated") {
        stats.ratesUpdated += 1;
      }
    }
    if (setting && setting.startTime && setting.endTime) {
      const action = applyMealTiming(database, setting);
      const cloudId = String((setting.cloudId || setting.id) || "").trim();
      const mealType = normalizeMealType(setting.mealType);
      if (cloudId) keptTimingCloudIds.add(cloudId);
      if (mealType) keptTimingMealTypes.add(mealType);
      if (action === "updated" || action === "deactivated") {
        stats.timingsUpdated += 1;
      }
    }
  }

  if (authoritative) {
    stats.employeesRemoved = removeStaleEmployees(
      database,
      keptEmployeeCloudIds,
      keptEmployeeCodes
    );
    stats.ratesRemoved = removeStaleMealRows(
      database,
      "meal_rates",
      keptRateCloudIds,
      keptRateMealTypes
    );
    stats.timingsRemoved = removeStaleMealRows(
      database,
      "meal_timings",
      keptTimingCloudIds,
      keptTimingMealTypes
    );
  }

  const nextVersion = Number(payload.syncVersion);
  if (!Number.isFinite(nextVersion)) {
    throw new Error("Cloud payload is missing a numeric syncVersion");
  }

  const now = new Date().toISOString();
  database
    .prepare(
      `
      INSERT INTO gateway_settings (key, value, updated_at)
      VALUES ('last_cloud_sync_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
    )
    .run(String(nextVersion), now);

  return {
    ...stats,
    toVersion: nextVersion,
  };
}

function logEmployeeSnapshot(employees, { development = false } = {}) {
  const list = Array.isArray(employees) ? employees : [];
  logger.info("CLOUD-PULL", `employee snapshot received count=${list.length}`);
  if (!development) {
    return;
  }
  for (const employee of list) {
    const code = String((employee && employee.employeeCode) || "").trim() || "?";
    const name = String((employee && employee.name) || "").trim() || "?";
    logger.info("CLOUD-PULL", `employee ${code} ${name}`);
  }
}

async function pullMasterData({
  database = defaultDb,
  client,
  since,
  forceFull = false,
} = {}) {
  if (!client) {
    throw new Error("Cloud client is required");
  }

  const config = require("../config");
  const fromVersion = since == null ? getSyncVersion(database) : Number(since) || 0;
  if (forceFull) {
    logger.info("CLOUD-PULL", "FORCE FULL PULL");
  }
  logger.info("CLOUD-PULL", `starting from version ${fromVersion}`);

  let payload;
  try {
    payload = await client.pullChanges(fromVersion);
  } catch (error) {
    markCloudFailure(database, error);
    logger.warn("SYNC", "cloud unavailable - local service continues");
    logger.warn("CLOUD-PULL", error.message || error);
    return {
      ok: false,
      fromVersion,
      toVersion: fromVersion,
      employeesUpdated: 0,
      employeesInserted: 0,
      employeesRemoved: 0,
      employeesReceived: 0,
      ratesUpdated: 0,
      timingsUpdated: 0,
      error: error.message || String(error),
      authFailure: Boolean(error.authFailure),
    };
  }

  const body = payload || {};
  let syncVersion;
  try {
    syncVersion = validateMasterSnapshot(body, { forceFull });
  } catch (error) {
    markCloudFailure(database, error);
    logger.error("CLOUD-PULL", error.message || error);
    return {
      ok: false,
      fromVersion,
      toVersion: fromVersion,
      employeesUpdated: 0,
      employeesInserted: 0,
      employeesRemoved: 0,
      employeesReceived: Array.isArray(body.employees) ? body.employees.length : 0,
      ratesUpdated: 0,
      timingsUpdated: 0,
      error: error.message || String(error),
    };
  }

  logger.info("CLOUD-PULL", `snapshot version=${syncVersion}`);
  logEmployeeSnapshot(body.employees, {
    development: config.nodeEnv !== "production" || config.logLevel === "debug",
  });

  const receivedEmployees = (body.employees || []).length;
  const receivedDepartments = (body.departments || []).length;
  const receivedRates = (body.mealRates || []).length;
  const receivedTimings = (body.mealTimings || []).length;
  const receivedSettings = (body.mealSettings || []).length;

  logger.info("CLOUD-PULL", `employees received=${receivedEmployees}`);
  logger.info("CLOUD-PULL", `meal rates received=${receivedRates}`);
  logger.info("CLOUD-PULL", `meal timings received=${receivedTimings}`);

  const apply = database.transaction((data) =>
    applyMasterPayload(database, data, { authoritative: Boolean(forceFull) })
  );

  try {
    const stats = apply.immediate(body);
    markPullSuccess(database, { syncVersion: stats.toVersion });

    logger.info(
      "CLOUD-PULL",
      `employees inserted=${stats.employeesInserted} updated=${stats.employeesUpdated} removed=${stats.employeesRemoved}`
    );
    logger.info("CLOUD-PULL", `departments received=${receivedDepartments}`);
    logger.info(
      "CLOUD-PULL",
      `meal rates received=${receivedRates} upserted=${stats.ratesUpdated}` +
        (forceFull ? ` removed=${stats.ratesRemoved}` : "")
    );
    logger.info(
      "CLOUD-PULL",
      `meal timings received=${receivedTimings} upserted=${stats.timingsUpdated}` +
        (forceFull ? ` removed=${stats.timingsRemoved}` : "")
    );
    if (receivedSettings > 0) {
      logger.info("CLOUD-PULL", `mealSettings received=${receivedSettings}`);
    } else {
      logger.info("CLOUD-PULL", "mealSettings received=0");
    }
    logger.info("CLOUD-PULL", `completed version=${stats.toVersion}`);

    return {
      ok: true,
      fromVersion,
      toVersion: stats.toVersion,
      previousVersion: fromVersion,
      newVersion: stats.toVersion,
      forceFull: Boolean(forceFull),
      employeesUpdated: stats.employeesUpdated,
      employeesInserted: stats.employeesInserted,
      employeesRemoved: stats.employeesRemoved,
      employeesReceived: receivedEmployees,
      departmentsReceived: receivedDepartments,
      ratesUpdated: stats.ratesUpdated,
      ratesRemoved: stats.ratesRemoved || 0,
      ratesReceived: receivedRates,
      timingsUpdated: stats.timingsUpdated,
      timingsRemoved: stats.timingsRemoved || 0,
      timingsReceived: receivedTimings,
      mealSettingsReceived: receivedSettings,
    };
  } catch (error) {
    logger.error("CLOUD-PULL", error.message || error);
    markCloudFailure(database, error);
    return {
      ok: false,
      fromVersion,
      toVersion: fromVersion,
      employeesUpdated: 0,
      employeesInserted: 0,
      employeesRemoved: 0,
      employeesReceived: receivedEmployees,
      ratesUpdated: 0,
      timingsUpdated: 0,
      error: error.message || String(error),
    };
  }
}

module.exports = {
  pullMasterData,
  applyMasterPayload,
  applyEmployee,
  pendingUnsyncedDebits,
  effectiveBalance,
  normalizeMealType,
  validateMasterSnapshot,
  removeStaleEmployees,
};
