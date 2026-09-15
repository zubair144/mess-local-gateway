const readline = require("readline");
const config = require("../../config");
const logger = require("../../logger");
const printer = require("../printer/printer-service");
const mealTransaction = require("../../services/meal-transaction.service");

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

async function handleQrScan(rawValue, options = {}) {
  const qrData = String(rawValue || "").trim();
  const skipPrint = Boolean(options.skipPrint);

  if (!qrData) {
    return { handled: false, reason: "EMPTY" };
  }

  const now = Date.now();

  if (
    qrData === lastScan &&
    now - lastScanTime < config.qrDuplicateWindowMs
  ) {
    logger.warn("QR", `Duplicate scan ignored: ${qrData}`);
    return { handled: false, reason: "DUPLICATE", qrData };
  }

  lastScan = qrData;
  lastScanTime = now;

  logger.info("QR", `Code scanned: ${qrData}`);

  let mealResult = null;

  try {
    mealResult = mealTransaction.processMealTransaction({
      source: "qr",
      identifier: qrData,
      deviceId: "bc-8000g",
    });
  } catch (err) {
    logger.error("QR", err);
    return {
      handled: true,
      printed: false,
      qrData,
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
      qrData,
      mealResult,
    };
  }

  if (!mealResult || !mealResult.success) {
    if (config.printDeclinedReceipts) {
      logger.info("QR", "Declined receipt printing is enabled but not implemented");
    }
    logger.info("QR", "Waiting for next QR scan...");
    return {
      handled: true,
      printed: false,
      qrData,
      mealResult,
    };
  }

  const printResult = await printSuccessfulMeal(mealResult);
  logger.info("QR", "Waiting for next QR scan...");

  return {
    handled: true,
    printed: printResult.printed,
    printStatus: printResult.printStatus,
    printError: printResult.printError,
    qrData,
    mealResult: {
      ...mealResult,
      printStatus: printResult.printStatus,
    },
  };
}

function startQrService() {
  if (started) {
    return;
  }

  if (!config.qrEnabled) {
    logger.info("QR", "QR service disabled by configuration");
    return;
  }

  started = true;

  const attachStdin =
    Boolean(process.stdin.isTTY) ||
    process.env.QR_FORCE_STDIN === "true";

  if (!attachStdin) {
    logger.info(
      "QR",
      "No TTY — HID scanner not attached; POST /api/meal/qr is available"
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
      await handleQrScan(line);
    } catch (err) {
      logger.error("QR", err.message || err);
    }
  });

  rl.on("close", () => {
    logger.info("QR", "Scanner input closed");
  });

  logger.info("QR", "Scanner ready (USB HID / stdin, CR suffix required)");
}

function stopQrService() {
  started = false;

  if (!rl) {
    return;
  }

  try {
    rl.close();
  } catch (err) {
    logger.error("QR", err.message || err);
  }

  rl = null;
}

function getQrStatus() {
  if (!config.qrEnabled) {
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
  startQrService,
  stopQrService,
  handleQrScan,
  getQrStatus,
};
