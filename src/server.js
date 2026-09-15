const express = require("express");
const config = require("./config");
const logger = require("./logger");
const db = require("./db/database");
const { registerRoutes } = require("./routes");
const { startHardware, stopHardware, getHardwareStatus } = require("./hardware");
const {
  startSyncWorker,
  stopSyncWorker,
  getSyncStatus,
} = require("./services/sync-service");

const app = express();

app.use(express.json());

registerRoutes(app);

let gatewayServer = null;
let shuttingDown = false;

function printStartupBanner(hardwareStatus) {
  const sqlite = db.getStatus();
  const sync = getSyncStatus();
  const face = hardwareStatus.face;
  const qr = hardwareStatus.qr;
  const printer = hardwareStatus.printer;

  const faceLine = config.faceEnabled
    ? `Listening on ${config.zkAdmsPort}`
    : "Disabled";
  const qrLine = qr.label || (qr.ready ? "Ready" : "Stopped");
  const printerLine = printer.label || (printer.ready ? "Ready" : "Offline");
  const sqliteLine = sqlite.connected ? "Connected" : "Error";
  const syncLine = sync.label || "Offline";

  console.log(`
================================================
 EXECUTIVE MESS - LOCAL GATEWAY
================================================

Gateway API    : http://localhost:${config.gatewayPort}
SQLite         : ${sqliteLine}
ZKTeco ADMS    : ${faceLine}
QR Scanner     : ${qrLine}
Printer        : ${printerLine}
Cloud Sync     : ${syncLine}

Device ADMS    : http://${config.gatewayHostIp}:${config.zkAdmsPort}
Zebra Printer  : ${config.printerIp}:${config.printerPort}

================================================
 SERVICE READY
================================================
`);
}

function startGatewayApi() {
  return new Promise((resolve, reject) => {
    const server = app.listen(config.gatewayPort, config.gatewayHost, () => {
      logger.info(
        "GATEWAY",
        `API listening on http://localhost:${config.gatewayPort}`
      );
      resolve(server);
    });

    server.on("error", reject);
  });
}

async function start() {
  logger.info("GATEWAY", "Loading configuration");

  const sqlite = db.getStatus();
  if (!sqlite.connected) {
    throw new Error(`SQLite failed to initialize: ${sqlite.error || "unknown"}`);
  }
  logger.info("GATEWAY", `SQLite connected (${config.sqlitePath})`);

  gatewayServer = await startGatewayApi();

  await startHardware();

  startSyncWorker();

  const hardwareStatus = await getHardwareStatus();
  printStartupBanner(hardwareStatus);
}

function stopGatewayApi() {
  if (!gatewayServer) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    gatewayServer.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      gatewayServer = null;
      resolve();
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info("GATEWAY", `Received ${signal}, shutting down`);

  try {
    stopSyncWorker();
    await stopHardware();
    await stopGatewayApi();
    db.closeDatabase();
    logger.info("GATEWAY", "Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("GATEWAY", err.message || err);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

start().catch((err) => {
  logger.error("GATEWAY", err.message || err);
  process.exit(1);
});
