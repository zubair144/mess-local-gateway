const config = require("../../config");
const logger = require("../../logger");
const { startAdmsServer } = require("./zk-adms");
const printer = require("../printer/printer-service");
const { processMealTransaction } = require("../../services/transaction-service");

const recentlyPrinted = new Map();

let admsServer = null;
let started = false;

function isDuplicatePrint(key) {
  const previousTime = recentlyPrinted.get(key);

  if (!previousTime) {
    return false;
  }

  return Date.now() - previousTime < config.faceDuplicateWindowMs;
}

function markAsPrinted(key) {
  recentlyPrinted.set(key, Date.now());

  setTimeout(() => {
    recentlyPrinted.delete(key);
  }, config.faceDuplicateWindowMs);
}

async function handleAttendanceEvent(attendance, options = {}) {
  const userId = String(attendance.userId || "").trim();
  const skipPrint = Boolean(options.skipPrint);

  if (!userId) {
    logger.warn("FACE", "No User ID found. Skipping print.");
    return { handled: false, reason: "NO_USER_ID" };
  }

  logger.info("FACE", `Employee ID: ${userId}`);
  logger.info("FACE", `Date/Time: ${attendance.dateTime || "-"}`);

  const eventKey = `${attendance.serialNumber || "UNKNOWN"}-${userId}-${attendance.dateTime || ""}`;

  if (isDuplicatePrint(eventKey)) {
    logger.warn("FACE", `Duplicate attendance event ignored: ${eventKey}`);
    return { handled: false, reason: "DUPLICATE" };
  }

  markAsPrinted(eventKey);

  let mealResult = null;

  if (config.hardwareProcessMeals) {
    try {
      mealResult = processMealTransaction({
        source: "face",
        identifier: userId,
        deviceId: attendance.serialNumber || null,
      });
    } catch (err) {
      logger.error("FACE", err);
    }
  } else {
    logger.info(
      "FACE",
      "SQLite meal processing skipped (HARDWARE_PROCESS_MEALS=false)"
    );
  }

  if (skipPrint) {
    return {
      handled: true,
      userId,
      printed: false,
      mealResult,
    };
  }

  try {
    await printer.printAttendanceReceipt({
      userId,
      dateTime: attendance.dateTime,
      status: attendance.status,
      verifyMode: attendance.verifyMode,
      workCode: attendance.workCode,
      serialNumber: attendance.serialNumber,
    });

    logger.info("FACE", `Receipt printed successfully for User ID: ${userId}`);

    return {
      handled: true,
      userId,
      printed: true,
      mealResult,
    };
  } catch (err) {
    recentlyPrinted.delete(eventKey);
    logger.error("PRINTER", err.message || err);
    throw err;
  }
}

async function startFaceService() {
  if (started) {
    return admsServer;
  }

  if (!config.faceEnabled) {
    logger.info("FACE", "Face service disabled by configuration");
    return null;
  }

  admsServer = await startAdmsServer({
    port: config.zkAdmsPort,
    host: config.zkAdmsHost,
    onAttendance: handleAttendanceEvent,
  });

  started = true;
  return admsServer;
}

function stopFaceService() {
  if (!admsServer) {
    started = false;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    admsServer.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      started = false;
      admsServer = null;
      logger.info("FACE", "ADMS listener stopped");
      resolve();
    });
  });
}

function getFaceStatus() {
  if (!config.faceEnabled) {
    return {
      ready: false,
      label: "Disabled",
      port: config.zkAdmsPort,
    };
  }

  return {
    ready: started,
    label: started ? "Listening" : "Stopped",
    port: config.zkAdmsPort,
    host: config.zkAdmsHost,
  };
}

module.exports = {
  startFaceService,
  stopFaceService,
  handleAttendanceEvent,
  getFaceStatus,
};
