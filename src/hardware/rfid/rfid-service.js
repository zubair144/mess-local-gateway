const readline = require("readline");
const config = require("../../config");
const logger = require("../../logger");
const printer = require("../printer/printer-service");
const mealTransaction = require("../../services/meal-transaction.service");
const identityService = require("../../services/identity-service");
const { normalizeRfidUid } = require("../../utils/rfid");

let rl = null;
let started = false;
let lastScan = "";
let lastScanTime = 0;

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

async function handleRfidScan(rawValue, options = {}) {
  const uid = normalizeRfidUid(rawValue);
  const skipPrint = Boolean(options.skipPrint);
  const verificationOnly = Boolean(options.verificationOnly) || identityService.isVerificationArmed();

  if (!uid) {
    return { handled: false, reason: "EMPTY" };
  }

  const now = Date.now();
  const windowMs = config.rfidDuplicateWindowMs || config.qrDuplicateWindowMs || 1500;

  if (uid === lastScan && now - lastScanTime < windowMs) {
    logger.warn("RFID", `Duplicate read ignored: ${uid}`);
    return { handled: false, reason: "DUPLICATE", rfidUid: uid };
  }

  lastScan = uid;
  lastScanTime = now;

  logger.info("RFID", `Card read: ${uid}`);

  if (verificationOnly) {
    const session = identityService.createVerificationSession({
      source: "rfid",
      identifier: uid,
      deviceId: options.deviceId || "rfid-hid",
    });
    logger.info("RFID", session.ok ? "Verification session created" : session.message || session.reason);
    return {
      handled: true,
      printed: false,
      rfidUid: uid,
      verificationSession: session,
      mealResult: null,
    };
  }

  let mealResult = null;

  try {
    mealResult = mealTransaction.processMealTransaction({
      source: "rfid",
      identifier: uid,
      deviceId: options.deviceId || "rfid-hid",
    });
  } catch (err) {
    logger.error("RFID", err);
    return {
      handled: true,
      printed: false,
      rfidUid: uid,
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
      printed: false,
      rfidUid: uid,
      mealResult,
    };
  }

  if (!mealResult || !mealResult.success) {
    if (config.printDeclinedReceipts) {
      logger.info("RFID", "Declined receipt printing is enabled but not implemented");
    }
    logger.info("RFID", "Waiting for next RFID tap...");
    return {
      handled: true,
      printed: false,
      rfidUid: uid,
      mealResult,
    };
  }

  const printResult = await printSuccessfulMeal(mealResult);
  logger.info("RFID", "Waiting for next RFID tap...");

  return {
    handled: true,
    printed: printResult.printed,
    printStatus: printResult.printStatus,
    printError: printResult.printError,
    rfidUid: uid,
    mealResult: {
      ...mealResult,
      printStatus: printResult.printStatus,
    },
  };
}

function startRfidService() {
  if (started) {
    return;
  }

  if (!config.rfidEnabled && !config.qrEnabled) {
    logger.info("RFID", "RFID service disabled by configuration");
    return;
  }

  started = true;

  const attachStdin =
    Boolean(process.stdin.isTTY) ||
    process.env.RFID_FORCE_STDIN === "true" ||
    process.env.QR_FORCE_STDIN === "true";

  if (!attachStdin) {
    logger.info(
      "RFID",
      "No TTY — HID reader not attached; POST /api/meal/rfid is available"
    );
    return;
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    try {
      await handleRfidScan(line);
    } catch (err) {
      logger.error("RFID", err.message || err);
    }
  });

  rl.on("close", () => {
    logger.info("RFID", "Reader input closed");
  });

  logger.info("RFID", "Reader ready (USB HID / stdin, CR suffix required)");
}

function stopRfidService() {
  started = false;

  if (!rl) {
    return;
  }

  try {
    rl.close();
  } catch (err) {
    logger.error("RFID", err.message || err);
  }

  rl = null;
}

function getRfidStatus() {
  if (!config.rfidEnabled && !config.qrEnabled) {
    return {
      ready: false,
      label: "Disabled",
    };
  }

  const hidAttached = Boolean(rl);

  return {
    ready: started,
    label: !started
      ? "Stopped"
      : hidAttached
        ? "Ready"
        : "Ready (API)",
    hidAttached,
  };
}

module.exports = {
  startRfidService,
  stopRfidService,
  handleRfidScan,
  getRfidStatus,
};
