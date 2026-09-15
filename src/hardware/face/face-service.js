const config = require("../../config");
const logger = require("../../logger");
const { startAdmsServer } = require("./zk-adms");
const printer = require("../printer/printer-service");
const mealTransaction = require("../../services/meal-transaction.service");

const recentlySeen = new Map();

let admsServer = null;
let started = false;

function isDuplicateEvent(key) {
  const previousTime = recentlySeen.get(key);
  if (!previousTime) {
    return false;
  }
  return Date.now() - previousTime < config.faceDuplicateWindowMs;
}

function markEvent(key) {
  recentlySeen.set(key, Date.now());

  setTimeout(() => {
    recentlySeen.delete(key);
  }, config.faceDuplicateWindowMs);
}

async function printSuccessfulMeal(result) {
  if (!result || !result.success) {
    return { printed: false, printStatus: result && result.printStatus };
  }

  const receipt = mealTransaction.getReceiptData(result);

  try {
    await printer.printMealReceipt(receipt);
    mealTransaction.updatePrintStatus(result.localTransactionId, "printed");
    return { printed: true, printStatus: "printed" };
  } catch (err) {
    mealTransaction.updatePrintStatus(result.localTransactionId, "failed");
    logger.error("PRINTER", err.message || err);
    logger.error(
      "PRINTER",
      `Receipt failed after committed TXN ${result.localTransactionId}`
    );
    return { printed: false, printStatus: "failed", printError: err.message };
  }
}

async function handleAttendanceEvent(attendance, options = {}) {
  const userId = String(attendance.userId || "").trim();
  const skipPrint = Boolean(options.skipPrint);

  if (!userId) {
    logger.warn("FACE", "No User ID found. Skipping.");
    return { handled: false, reason: "NO_USER_ID" };
  }

  logger.info("FACE", `Device User ID: ${userId}`);
  logger.info("FACE", `Date/Time: ${attendance.dateTime || "-"}`);

  const eventKey = `${attendance.serialNumber || "UNKNOWN"}-${userId}-${attendance.dateTime || ""}`;

  if (isDuplicateEvent(eventKey)) {
    logger.warn("FACE", `Duplicate attendance event ignored: ${eventKey}`);
    return { handled: false, reason: "DUPLICATE" };
  }

  markEvent(eventKey);

  let mealResult = null;

  try {
    mealResult = mealTransaction.processMealTransaction({
      source: "face",
      identifier: userId,
      deviceId: attendance.serialNumber || null,
    });
  } catch (err) {
    logger.error("FACE", err);
    return {
      handled: true,
      userId,
      printed: false,
      mealResult: {
        success: false,
        reason: "TRANSACTION_FAILED",
        message: err.message || "Transaction failed",
      },
    };
  }

  if (skipPrint) {
    return {
      handled: true,
      userId,
      printed: false,
      mealResult,
    };
  }

  if (!mealResult || !mealResult.success) {
    if (config.printDeclinedReceipts) {
      logger.info("FACE", "Declined receipt printing is enabled but not implemented");
    }
    return {
      handled: true,
      userId,
      printed: false,
      mealResult,
    };
  }

  const printResult = await printSuccessfulMeal(mealResult);

  return {
    handled: true,
    userId,
    printed: printResult.printed,
    printStatus: printResult.printStatus,
    printError: printResult.printError,
    mealResult: {
      ...mealResult,
      printStatus: printResult.printStatus,
    },
  };
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
