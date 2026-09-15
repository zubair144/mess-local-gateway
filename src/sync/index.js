const config = require("../config");
const logger = require("../logger");
const defaultDb = require("../db/database");
const { createCloudClient, isCloudConfigured } = require("../cloud/cloud-client");
const { createMutex } = require("./mutex");
const {
  getCloudSnapshot,
  resetProcessingRows,
  getPersistedState,
  setSyncVersion,
  getSyncVersion,
} = require("./sync-state");
const { pullMasterData } = require("./master-pull.service");
const {
  pushPendingTransactions,
  makeFailedRetryable,
  clearFailedDummyTransactions,
} = require("./transaction-push.service");
const { sendHeartbeat } = require("./heartbeat.service");
const { resetLocalDemoData } = require("./reset-demo-data.service");

const cloudMutex = createMutex();

let started = false;
let pullTimer = null;
let pushTimer = null;
let heartbeatTimer = null;
let pullRunning = false;
let pushRunning = false;
let heartbeatRunning = false;
let client = null;

function getClient() {
  if (!client) {
    client = createCloudClient();
  }
  return client;
}

function cloudReady() {
  return started && isCloudConfigured(config);
}

function pullAllowed() {
  return Boolean(config.cloudPullEnabled);
}

function pushAllowed() {
  return Boolean(config.cloudPushEnabled);
}

function heartbeatAllowed() {
  return Boolean(config.heartbeatEnabled);
}

function skipBecauseAuthLocked() {
  const state = getPersistedState(defaultDb);
  return state.cloudConnectionStatus === "auth_failed";
}

function disabledResult(kind, reason) {
  if (kind === "pull") {
    return {
      ok: false,
      skipped: true,
      disabled: true,
      error: reason,
      fromVersion: 0,
      toVersion: 0,
      employeesUpdated: 0,
      ratesUpdated: 0,
      timingsUpdated: 0,
    };
  }
  if (kind === "push") {
    return {
      ok: true,
      skipped: true,
      disabled: true,
      error: reason,
      pendingBefore: 0,
      synced: 0,
      failed: 0,
    };
  }
  return { ok: false, skipped: true, disabled: true, error: reason };
}

async function runPull(options = {}) {
  if (!pullAllowed() && !options.ignoreFlags) {
    logger.info("CLOUD-PULL", "skipped because CLOUD_PULL_ENABLED=false");
    return disabledResult("pull", "Cloud pull is disabled");
  }

  if (!cloudReady() && !options.force) {
    return {
      ok: false,
      error: "Cloud sync is not configured",
      fromVersion: 0,
      toVersion: 0,
      employeesUpdated: 0,
      ratesUpdated: 0,
      timingsUpdated: 0,
    };
  }

  return cloudMutex.run(async () => {
    if (pullRunning) {
      logger.info("CLOUD-PULL", "skipped because a pull is already running");
      return { ok: false, skipped: true, error: "Pull already running" };
    }
    pullRunning = true;
    try {
      return await pullMasterData({
        database: options.database || defaultDb,
        client: options.client || getClient(),
        since: options.since,
        forceFull: Boolean(options.forceFull),
      });
    } finally {
      pullRunning = false;
    }
  });
}

async function runPush(options = {}) {
  if (!pushAllowed() && !options.ignoreFlags) {
    logger.info("CLOUD-PUSH", "skipped because CLOUD_PUSH_ENABLED=false");
    return disabledResult("push", "Cloud push is disabled");
  }

  if (!cloudReady() && !options.force) {
    return {
      ok: false,
      error: "Cloud sync is not configured",
      pendingBefore: 0,
      synced: 0,
      failed: 0,
    };
  }

  return cloudMutex.run(async () => {
    if (pushRunning) {
      logger.info("CLOUD-PUSH", "skipped because a push is already running");
      return { ok: false, skipped: true, error: "Push already running" };
    }
    pushRunning = true;
    try {
      return await pushPendingTransactions({
        database: options.database || defaultDb,
        client: options.client || getClient(),
        limit: options.limit,
      });
    } finally {
      pushRunning = false;
    }
  });
}

async function runHeartbeat(options = {}) {
  if (!heartbeatAllowed() && !options.ignoreFlags) {
    return disabledResult("heartbeat", "Heartbeat is disabled");
  }

  if (!cloudReady() && !options.force) {
    return { ok: false, error: "Cloud sync is not configured" };
  }

  if (heartbeatRunning) {
    return { ok: false, skipped: true };
  }

  heartbeatRunning = true;
  try {
    return await sendHeartbeat({
      database: options.database || defaultDb,
      client: options.client || getClient(),
    });
  } finally {
    heartbeatRunning = false;
  }
}

async function syncNow(options = {}) {
  logger.info("SYNC", "manual sync now requested");
  const pull = pullAllowed()
    ? await runPull({ ...options, force: true })
    : disabledResult("pull", "Cloud pull is disabled");
  const push = pushAllowed()
    ? await runPush({ ...options, force: true })
    : disabledResult("push", "Cloud push is disabled");
  const heartbeat = heartbeatAllowed()
    ? await runHeartbeat({ ...options, force: true })
    : disabledResult("heartbeat", "Heartbeat is disabled");

  const pullOk = !pullAllowed() || Boolean(pull.ok);
  const pushOk = !pushAllowed() || Boolean(push.ok) || Boolean(push.disabled);
  const heartbeatOk = !heartbeatAllowed() || Boolean(heartbeat.ok) || Boolean(heartbeat.disabled);

  return {
    success: pullOk && pushOk && heartbeatOk,
    pull: {
      fromVersion: pull.fromVersion,
      toVersion: pull.toVersion,
      employeesUpdated: pull.employeesUpdated || 0,
      ratesUpdated: pull.ratesUpdated || 0,
      timingsUpdated: pull.timingsUpdated || 0,
      disabled: Boolean(pull.disabled),
      error: pull.error || null,
    },
    push: {
      pendingBefore: push.pendingBefore || 0,
      synced: push.synced || 0,
      failed: push.failed || 0,
      disabled: Boolean(push.disabled),
      error: push.error || null,
    },
    heartbeat: {
      success: Boolean(heartbeat.ok),
      disabled: Boolean(heartbeat.disabled),
      error: heartbeat.error || null,
    },
  };
}

async function forceFullPull(options = {}) {
  const database = options.database || defaultDb;
  const previous = getSyncVersion(database);
  setSyncVersion(database, 0);
  logger.info(
    "CLOUD-PULL",
    `master cursor reset ${previous} → 0 (transactions/hardware untouched)`
  );

  const pull = await runPull({
    ...options,
    database,
    since: 0,
    force: true,
    forceFull: true,
  });

  if (!pull.ok) {
    // Keep incremental cursor intact when the full snapshot request fails.
    setSyncVersion(database, previous);
    logger.warn(
      "CLOUD-PULL",
      `force full pull failed — restored master cursor to ${previous}`
    );
  }

  let heartbeat = { ok: true, disabled: !heartbeatAllowed() };
  if (pull.ok && heartbeatAllowed()) {
    heartbeat = await runHeartbeat({ ...options, database, force: true });
  }

  return {
    success: Boolean(pull.ok),
    forceFullPull: true,
    previousVersion: previous,
    newVersion: pull.toVersion,
    pull: {
      fromVersion: pull.fromVersion,
      toVersion: pull.toVersion,
      previousVersion: previous,
      newVersion: pull.toVersion,
      employeesReceived: pull.employeesReceived || 0,
      employeesInserted: pull.employeesInserted || 0,
      employeesUpdated: pull.employeesUpdated || 0,
      employeesRemoved: pull.employeesRemoved || 0,
      departmentsReceived: pull.departmentsReceived || 0,
      ratesReceived: pull.ratesReceived || 0,
      ratesUpdated: pull.ratesUpdated || 0,
      ratesRemoved: pull.ratesRemoved || 0,
      timingsReceived: pull.timingsReceived || 0,
      timingsUpdated: pull.timingsUpdated || 0,
      timingsRemoved: pull.timingsRemoved || 0,
      error: pull.error || null,
    },
    heartbeat: {
      success: Boolean(heartbeat.ok),
      disabled: Boolean(heartbeat.disabled),
      error: heartbeat.error || null,
    },
  };
}

function resetDemoData(options = {}) {
  return resetLocalDemoData(options);
}

async function resetAndPull(options = {}) {
  const database = options.database || defaultDb;
  const activeClient = options.client || getClient();

  if (!isCloudConfigured(config) && !options.ignoreConfig) {
    return {
      success: false,
      message: "Cloud sync is not configured. Set CLOUD_API_URL and GATEWAY_API_KEY.",
    };
  }
  if (!pullAllowed() && !options.ignoreFlags) {
    return {
      success: false,
      message: "Cloud pull is disabled (CLOUD_PULL_ENABLED=false).",
    };
  }

  logger.info("ADMIN", "reset-and-pull: probing cloud");
  let probe;
  try {
    probe = await activeClient.pullChanges(0);
  } catch (error) {
    logger.warn("ADMIN", `reset-and-pull aborted — cloud unreachable: ${error.message}`);
    return {
      success: false,
      message: `Cloud unreachable: ${error.message || error}`,
      cloudReachable: false,
    };
  }

  const employeesReceived = Array.isArray(probe && probe.employees)
    ? probe.employees.length
    : -1;
  const syncVersion = Number(probe && probe.syncVersion);
  if (!Number.isFinite(syncVersion) || !Array.isArray(probe && probe.employees)) {
    return {
      success: false,
      message: "Cloud returned an invalid master snapshot — local data preserved",
      cloudReachable: true,
    };
  }
  if (employeesReceived === 0 && syncVersion > 0) {
    return {
      success: false,
      message:
        "Cloud snapshot has 0 employees while syncVersion > 0 — refusing destructive reset",
      cloudReachable: true,
    };
  }

  const resetResult = resetLocalDemoData({ database });
  const pull = await forceFullPull({
    ...options,
    database,
    client: activeClient,
  });

  return {
    success: Boolean(pull.success),
    cloudReachable: true,
    localReset: resetResult.localReset,
    cloudPull: {
      employeesReceived: pull.pull?.employeesReceived || 0,
      employeesInserted: pull.pull?.employeesInserted || 0,
      employeesUpdated: pull.pull?.employeesUpdated || 0,
      employeesRemoved: pull.pull?.employeesRemoved || 0,
      ratesReceived: pull.pull?.ratesReceived || 0,
      timingsReceived: pull.pull?.timingsReceived || 0,
      fromVersion: pull.pull?.fromVersion || 0,
      toVersion: pull.pull?.toVersion || 0,
      error: pull.pull?.error || null,
    },
    pushSkipped: true,
    pushEnabled: pushAllowed(),
  };
}

async function retryFailed(options = {}) {
  if (!pushAllowed()) {
    logger.info("SYNC", "retry-failed skipped because CLOUD_PUSH_ENABLED=false");
    return {
      success: false,
      retried: 0,
      disabled: true,
      message: "Cloud push is disabled; failed rows were left untouched",
      push: {
        pendingBefore: 0,
        synced: 0,
        failed: 0,
        disabled: true,
        error: "Cloud push is disabled",
      },
    };
  }

  const database = options.database || defaultDb;
  const retried = makeFailedRetryable(database);
  logger.info("SYNC", `retry-failed: ${retried} row(s) made retryable`);
  const push = await runPush({ ...options, force: true });
  return {
    success: Boolean(push.ok),
    retried,
    push: {
      pendingBefore: push.pendingBefore || 0,
      synced: push.synced || 0,
      failed: push.failed || 0,
      error: push.error || null,
    },
  };
}

function clearFailedDummy(options = {}) {
  const database = options.database || defaultDb;
  const result = clearFailedDummyTransactions(database);
  logger.info(
    "SYNC",
    `clear-failed-dummy: removed ${result.cleared} failed dummy queue row(s)`
  );
  return result;
}

async function pullTick() {
  if (!started || !isCloudConfigured(config) || !pullAllowed()) {
    return;
  }
  if (skipBecauseAuthLocked()) {
    logger.warn("CLOUD-PULL", "skipped because gateway authentication failed");
    return;
  }
  if (pullRunning) {
    return;
  }
  try {
    await runPull();
  } catch (error) {
    logger.error("CLOUD-PULL", error.message || error);
  }
}

async function pushTick() {
  if (!started || !isCloudConfigured(config) || !pushAllowed()) {
    return;
  }
  if (skipBecauseAuthLocked()) {
    logger.warn("CLOUD-PUSH", "skipped because gateway authentication failed");
    return;
  }
  if (pushRunning) {
    return;
  }
  try {
    await runPush();
  } catch (error) {
    logger.error("CLOUD-PUSH", error.message || error);
  }
}

async function heartbeatTick() {
  if (!started || !isCloudConfigured(config) || !heartbeatAllowed()) {
    return;
  }
  if (skipBecauseAuthLocked()) {
    return;
  }
  try {
    await runHeartbeat();
  } catch (error) {
    logger.error("HEARTBEAT", error.message || error);
  }
}

function startSyncWorker(options = {}) {
  if (started) {
    return;
  }

  started = true;
  client = options.client || createCloudClient();

  resetProcessingRows(defaultDb);

  if (!config.cloudSyncEnabled) {
    logger.info("SYNC", "disabled by CLOUD_SYNC_ENABLED=false");
    return;
  }

  if (!isCloudConfigured(config)) {
    logger.info(
      "SYNC",
      "Cloud API not configured — set CLOUD_API_URL and GATEWAY_API_KEY; local service continues"
    );
    return;
  }

  logger.info(
    "SYNC",
    `Cloud sync worker ready (${config.cloudApiUrl}) pull=${config.cloudPullEnabled} push=${config.cloudPushEnabled} heartbeat=${config.heartbeatEnabled}`
  );

  if (pullAllowed()) {
    pullTimer = setInterval(pullTick, config.syncPullIntervalMs);
    if (pullTimer.unref) pullTimer.unref();
  } else {
    logger.info("SYNC", "pull worker not started (CLOUD_PULL_ENABLED=false)");
  }

  if (pushAllowed()) {
    pushTimer = setInterval(pushTick, config.syncPushIntervalMs);
    if (pushTimer.unref) pushTimer.unref();
  } else {
    logger.info(
      "SYNC",
      "push worker not started (CLOUD_PUSH_ENABLED=false) — local transactions kept, not uploaded"
    );
  }

  if (heartbeatAllowed()) {
    heartbeatTimer = setInterval(heartbeatTick, config.heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  } else {
    logger.info("SYNC", "heartbeat worker not started (HEARTBEAT_ENABLED=false)");
  }

  setImmediate(() => {
    if (pullAllowed()) {
      pullTick().catch((error) => {
        logger.error("CLOUD-PULL", error.message || error);
      });
    }
    if (heartbeatAllowed()) {
      heartbeatTick().catch((error) => {
        logger.error("HEARTBEAT", error.message || error);
      });
    }
  });
}

function stopSyncWorker() {
  started = false;
  pullRunning = false;
  pushRunning = false;
  heartbeatRunning = false;

  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  logger.info("SYNC", "workers stopped");
}

function getSyncStatus() {
  const snapshot = getCloudSnapshot(defaultDb);
  const configured = snapshot.configured;

  if (!started) {
    return {
      ready: false,
      status: "stopped",
      label: "Stopped",
      ...snapshot,
    };
  }

  if (!configured) {
    return {
      ready: false,
      status: "not_configured",
      label: "Not configured",
      ...snapshot,
    };
  }

  if (snapshot.connectionStatus === "auth_failed") {
    return {
      ready: true,
      status: "auth_failed",
      label: "Auth failed",
      ...snapshot,
      online: false,
    };
  }

  if (snapshot.online) {
    return {
      ready: true,
      status: "online",
      label: "Online",
      ...snapshot,
    };
  }

  return {
    ready: true,
    status: snapshot.connectionStatus || "offline",
    label: snapshot.connectionStatus === "unknown" ? "Ready" : "Offline",
    ...snapshot,
    online: false,
  };
}

module.exports = {
  startSyncWorker,
  stopSyncWorker,
  getSyncStatus,
  syncNow,
  forceFullPull,
  retryFailed,
  clearFailedDummy,
  resetDemoData,
  resetAndPull,
  runPull,
  runPush,
  runHeartbeat,
};
