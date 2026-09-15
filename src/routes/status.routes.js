const db = require("../db/database");
const { getCurrentMeal } = require("../services/meal-service");
const { getSyncStatus } = require("../services/sync-service");
const hardware = require("../hardware");
const config = require("../config");

function mapServiceState(ready, disabledLabel = "offline") {
  if (ready) {
    return "online";
  }
  return disabledLabel;
}

async function buildStatus({ probePrinter = false } = {}) {
  const sqlite = db.getStatus();
  const hardwareStatus = await hardware.getHardwareStatus({ probePrinter });
  const sync = getSyncStatus();

  const databaseOnline = sqlite.connected ? "online" : "offline";
  const faceOnline = !config.faceEnabled
    ? "disabled"
    : mapServiceState(hardwareStatus.face.ready);
  const qrOnline = !config.qrEnabled
    ? "disabled"
    : mapServiceState(hardwareStatus.qr.ready);
  const printerOnline = !config.printerEnabled
    ? "disabled"
    : mapServiceState(hardwareStatus.printer.ready);

  return {
    status: sqlite.connected ? "online" : "degraded",
    database: databaseOnline,
    face: faceOnline,
    qr: qrOnline,
    printer: printerOnline,
    gateway: "Mess Local Gateway",
    sqlite,
    currentMeal: getCurrentMeal(),
    hardware: hardwareStatus,
    sync,
    cloud: {
      configured: Boolean(sync.configured),
      online: Boolean(sync.online),
      gatewayId: sync.gatewayId || config.gatewayId,
      pullEnabled: sync.pullEnabled !== false,
      pushEnabled: sync.pushEnabled !== false,
      heartbeatEnabled: sync.heartbeatEnabled !== false,
      lastPullAt: sync.lastPullAt || null,
      lastPushAt: sync.lastPushAt || null,
      lastHeartbeatAt: sync.lastHeartbeatAt || null,
      syncVersion: Number(sync.syncVersion || 0) || 0,
      pending: Number(sync.pending || 0) || 0,
      failed: Number(sync.failed || 0) || 0,
      lastError: sync.lastError || null,
      connectionStatus: sync.connectionStatus || sync.status,
    },
    timezone: config.timezone,
    ports: {
      gateway: config.gatewayPort,
      zkAdms: config.zkAdmsPort,
    },
  };
}

function registerStatusRoutes(app) {
  app.get("/health", async (req, res) => {
    const sqlite = db.getStatus();

    res.json({
      status: sqlite.connected ? "ok" : "error",
      gateway: "Mess Local Gateway",
      database: "SQLite",
      currentMeal: getCurrentMeal(),
    });
  });

  app.get("/api/status", async (req, res) => {
    res.json(
      await buildStatus({
        probePrinter: req.query.probe === "1",
      })
    );
  });
}

module.exports = {
  registerStatusRoutes,
  buildStatus,
};
