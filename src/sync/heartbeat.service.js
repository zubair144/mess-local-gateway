const defaultDb = require("../db/database");
const config = require("../config");
const logger = require("../logger");
const { getTimeContext } = require("../utils/time");
const { getQueueCounts, markHeartbeatSuccess, markCloudFailure } = require("./sync-state");

function readPackageVersion() {
  try {
    return require("../../package.json").version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

async function sendHeartbeat({ database = defaultDb, client } = {}) {
  if (!client) {
    throw new Error("Cloud client is required");
  }

  const counts = getQueueCounts(database);
  const payload = {
    pendingSyncCount: counts.pending + counts.processing,
    failedSyncCount: counts.failed,
    gatewayTime: getTimeContext(new Date(), config.timezone).iso,
    version: readPackageVersion(),
  };

  try {
    const result = await client.sendHeartbeat(payload);
    markHeartbeatSuccess(database);
    logger.info(
      "HEARTBEAT",
      `ok pending=${payload.pendingSyncCount} failed=${payload.failedSyncCount}`
    );
    return { ok: true, payload, result };
  } catch (error) {
    markCloudFailure(database, error);
    if (error.authFailure) {
      logger.error("HEARTBEAT", "authentication failed - check GATEWAY_ID / GATEWAY_API_KEY");
    } else {
      logger.warn("HEARTBEAT", error.message || error);
    }
    return {
      ok: false,
      payload,
      error: error.message || String(error),
      authFailure: Boolean(error.authFailure),
    };
  }
}

module.exports = {
  sendHeartbeat,
};
