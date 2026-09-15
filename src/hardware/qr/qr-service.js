const readline = require("readline");
const config = require("../../config");
const logger = require("../../logger");
const printer = require("../printer/printer-service");
const { processMealTransaction } = require("../../services/transaction-service");

let rl = null;
let started = false;
let lastScan = "";
let lastScanTime = 0;

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

  if (config.hardwareProcessMeals) {
    try {
      mealResult = processMealTransaction({
        source: "qr",
        identifier: qrData,
        deviceId: "bc-8000g",
      });
    } catch (err) {
      logger.error("QR", err);
    }
  } else {
    logger.info(
      "QR",
      "SQLite meal processing skipped (HARDWARE_PROCESS_MEALS=false)"
    );
  }

  if (skipPrint) {
    return {
      handled: true,
      printed: false,
      qrData,
      mealResult,
    };
  }

  try {
    await printer.printQrReceipt(qrData);
    logger.info("QR", "Receipt printed");
    logger.info("QR", "Waiting for next QR scan...");

    return {
      handled: true,
      printed: true,
      qrData,
      mealResult,
    };
  } catch (err) {
    lastScan = "";
    lastScanTime = 0;
    logger.error("PRINTER", err.message || err);
    logger.info("QR", "Waiting for next QR scan...");
    throw err;
  }
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
