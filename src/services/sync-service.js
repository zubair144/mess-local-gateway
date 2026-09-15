const config = require("../config");
const logger = require("../logger");

let started = false;

function startSyncWorker() {
  started = true;

  if (!config.cloudApiUrl) {
    logger.info("SYNC", "Cloud API not configured — sync remains offline");
    return;
  }

  // TODO: poll sync_queue and POST pending meal transactions to the cloud API.
  logger.info("SYNC", `Cloud sync worker ready (${config.cloudApiUrl})`);
}

function stopSyncWorker() {
  started = false;
}

function getSyncStatus() {
  if (!started) {
    return {
      ready: false,
      status: "stopped",
      label: "Stopped",
    };
  }

  if (!config.cloudApiUrl) {
    return {
      ready: false,
      status: "offline",
      label: "Offline",
    };
  }

  return {
    ready: true,
    status: "ready",
    label: "Ready",
    cloudApiUrl: config.cloudApiUrl,
  };
}

module.exports = {
  startSyncWorker,
  stopSyncWorker,
  getSyncStatus,
};
