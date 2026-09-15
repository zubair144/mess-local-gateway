const defaultDb = require("../db/database");
const config = require("../config");
const { isCloudConfigured } = require("../cloud/cloud-client");

const KEYS = {
  lastCloudSyncVersion: "last_cloud_sync_version",
  lastSuccessfulPullAt: "last_successful_pull_at",
  lastSuccessfulPushAt: "last_successful_push_at",
  lastHeartbeatAt: "last_heartbeat_at",
  lastCloudError: "last_cloud_error",
  cloudConnectionStatus: "cloud_connection_status",
};

function nowIso() {
  return new Date().toISOString();
}

function getValue(database, key, fallback = "") {
  const row = database
    .prepare("SELECT value FROM gateway_settings WHERE key = ?")
    .get(key);
  return row && row.value != null ? row.value : fallback;
}

function setValue(database, key, value) {
  database
    .prepare(
      `
      INSERT INTO gateway_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `
    )
    .run(key, value == null ? "" : String(value), nowIso());
}

function getSyncVersion(database = defaultDb) {
  return Number(getValue(database, KEYS.lastCloudSyncVersion, "0")) || 0;
}

function setSyncVersion(database, version) {
  setValue(database, KEYS.lastCloudSyncVersion, Number(version) || 0);
}

function setCloudError(database, message, status) {
  if (message) {
    setValue(database, KEYS.lastCloudError, message);
  }
  if (status) {
    setValue(database, KEYS.cloudConnectionStatus, status);
  }
}

function clearCloudError(database, status = "online") {
  setValue(database, KEYS.lastCloudError, "");
  setValue(database, KEYS.cloudConnectionStatus, status);
}

function getQueueCounts(database = defaultDb) {
  const rows = database
    .prepare(
      `
      SELECT status, COUNT(*) AS count
      FROM sync_queue
      GROUP BY status
    `
    )
    .all();

  const counts = {
    pending: 0,
    processing: 0,
    synced: 0,
    failed: 0,
  };

  for (const row of rows) {
    counts[row.status] = Number(row.count || 0);
  }

  return counts;
}

function getPersistedState(database = defaultDb) {
  const configured = isCloudConfigured(config);
  const connectionStatus = getValue(
    database,
    KEYS.cloudConnectionStatus,
    configured ? "unknown" : "not_configured"
  );
  const lastError = getValue(database, KEYS.lastCloudError, "") || "";

  return {
    lastCloudSyncVersion: getSyncVersion(database),
    lastSuccessfulPullAt: getValue(database, KEYS.lastSuccessfulPullAt, "") || null,
    lastSuccessfulPushAt: getValue(database, KEYS.lastSuccessfulPushAt, "") || null,
    lastHeartbeatAt: getValue(database, KEYS.lastHeartbeatAt, "") || null,
    lastCloudError: lastError || null,
    cloudConnectionStatus: connectionStatus,
  };
}

function getCloudSnapshot(database = defaultDb) {
  const configured = isCloudConfigured(config);
  const persisted = getPersistedState(database);
  const counts = getQueueCounts(database);
  const status = persisted.cloudConnectionStatus;
  const online = configured && status === "online";

  return {
    configured,
    enabled: Boolean(config.cloudSyncEnabled),
    pullEnabled: Boolean(config.cloudPullEnabled),
    pushEnabled: Boolean(config.cloudPushEnabled),
    heartbeatEnabled: Boolean(config.heartbeatEnabled),
    online,
    gatewayId: config.gatewayId,
    cloudApiUrl: config.cloudApiUrl,
    lastPullAt: persisted.lastSuccessfulPullAt,
    lastPushAt: persisted.lastSuccessfulPushAt,
    lastHeartbeatAt: persisted.lastHeartbeatAt,
    syncVersion: persisted.lastCloudSyncVersion,
    pending: counts.pending + counts.processing,
    failed: counts.failed,
    lastError: configured ? persisted.lastCloudError : "GATEWAY_API_KEY is not configured",
    connectionStatus: configured ? status : "not_configured",
    counts,
  };
}

function markPullSuccess(database, { syncVersion }) {
  if (syncVersion != null) {
    setSyncVersion(database, syncVersion);
  }
  setValue(database, KEYS.lastSuccessfulPullAt, nowIso());
  clearCloudError(database, "online");
}

function markPushSuccess(database) {
  setValue(database, KEYS.lastSuccessfulPushAt, nowIso());
  const currentError = getValue(database, KEYS.lastCloudError, "");
  if (!currentError) {
    setValue(database, KEYS.cloudConnectionStatus, "online");
  } else {
    setValue(database, KEYS.cloudConnectionStatus, "online");
    setValue(database, KEYS.lastCloudError, "");
  }
}

function markHeartbeatSuccess(database) {
  setValue(database, KEYS.lastHeartbeatAt, nowIso());
  setValue(database, KEYS.cloudConnectionStatus, "online");
}

function markCloudFailure(database, error) {
  const authFailure = Boolean(error && error.authFailure);
  const status = authFailure ? "auth_failed" : "offline";
  const message = error && error.message ? error.message : String(error || "Cloud unavailable");
  setCloudError(database, message, status);
}

function resetProcessingRows(database = defaultDb) {
  const now = nowIso();
  database
    .prepare(
      `
      UPDATE sync_queue
      SET
        status = 'pending',
        updated_at = ?,
        next_attempt_at = ?
      WHERE status = 'processing'
    `
    )
    .run(now, now);
}

module.exports = {
  KEYS,
  getValue,
  setValue,
  getSyncVersion,
  setSyncVersion,
  getQueueCounts,
  getPersistedState,
  getCloudSnapshot,
  markPullSuccess,
  markPushSuccess,
  markHeartbeatSuccess,
  markCloudFailure,
  resetProcessingRows,
  nowIso,
};
