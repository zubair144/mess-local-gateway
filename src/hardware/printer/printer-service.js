const net = require("net");
const config = require("../../config");
const logger = require("../../logger");
const { formatDisplayDateTime } = require("../../utils/time");
const { formatRs, shortTxnId, displaySource } = require("../../utils/format");

let lastStatus = {
  ready: false,
  label: "Not initialized",
  ip: null,
  port: null,
};

function sanitizeZpl(value, options = {}) {
  const newline = options.newline === undefined ? " " : options.newline;
  const maxLength = options.maxLength;

  let sanitized = String(value || "")
    .replace(/\^/g, "")
    .replace(/~/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, newline);

  if (maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized;
}

function formatDateTime() {
  return new Date().toLocaleString("en-GB", {
    hour12: true,
  });
}

function sendZpl(zpl) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.setTimeout(config.printerTimeoutMs);

    socket.connect(config.printerPort, config.printerIp, () => {
      socket.write(zpl, (error) => {
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }

        socket.end();
        resolve();
      });
    });

    socket.on("error", (error) => {
      reject(error);
    });

    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Printer connection timeout"));
    });
  });
}

function probePrinter() {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(2000);

    socket.connect(config.printerPort, config.printerIp, () => {
      socket.end();
      resolve({
        ready: true,
        label: "Ready",
        ip: config.printerIp,
        port: config.printerPort,
      });
    });

    socket.on("error", (error) => {
      resolve({
        ready: false,
        label: "Offline",
        ip: config.printerIp,
        port: config.printerPort,
        error: error.message,
      });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({
        ready: false,
        label: "Offline",
        ip: config.printerIp,
        port: config.printerPort,
        error: "Printer connection timeout",
      });
    });
  });
}

async function initPrinter() {
  lastStatus = {
    ready: false,
    label: "Not initialized",
    ip: config.printerIp,
    port: config.printerPort,
  };

  if (!config.printerEnabled) {
    lastStatus = {
      ready: false,
      label: "Disabled",
      ip: config.printerIp,
      port: config.printerPort,
    };
    logger.info("PRINTER", "Printer disabled by configuration");
    return lastStatus;
  }

  lastStatus = await probePrinter();

  if (lastStatus.ready) {
    logger.info(
      "PRINTER",
      `Ready at ${config.printerIp}:${config.printerPort}`
    );
  } else {
    logger.error(
      "PRINTER",
      `Not reachable at ${config.printerIp}:${config.printerPort}` +
        (lastStatus.error ? ` (${lastStatus.error})` : "")
    );
  }

  return lastStatus;
}

async function getPrinterStatus({ probe = false } = {}) {
  if (!config.printerEnabled) {
    lastStatus = {
      ready: false,
      label: "Disabled",
      ip: config.printerIp,
      port: config.printerPort,
    };
    return lastStatus;
  }

  if (!probe && lastStatus.ip) {
    return lastStatus;
  }

  lastStatus = await probePrinter();
  return lastStatus;
}

function printAttendanceReceipt(attendance) {
  logger.info("PRINTER", "Printing attendance receipt");
  logger.info("PRINTER", `User ID: ${attendance.userId}`);
  logger.info(
    "PRINTER",
    `Printer: ${config.printerIp}:${config.printerPort}`
  );

  const zpl = `
^XA
^PW600
^LL430

^CF0,35
^FO70,30^FDEXECUTIVE MESS^FS

^CF0,23
^FO70,85^FDAttendance Receipt^FS

^FO40,125^GB520,2,2^FS

^CF0,28
^FO50,155^FDUser ID: ${sanitizeZpl(attendance.userId)}^FS

^CF0,24
^FO50,205^FDDate/Time:^FS
^FO50,240^FD${sanitizeZpl(attendance.dateTime || new Date().toLocaleString())}^FS

^CF0,20
^FO50,290^FDVerify Mode: ${sanitizeZpl(attendance.verifyMode)}^FS

^CF0,18
^FO50,335^FDDevice: ${sanitizeZpl(attendance.serialNumber)}^FS

^FO40,375^GB520,2,2^FS

^XZ
`;

  return sendZpl(zpl).then(() => {
    logger.info("PRINTER", "Receipt printed");
  });
}

function printQrReceipt(qrData) {
  const safeQrData = sanitizeZpl(qrData, {
    newline: "",
    maxLength: 150,
  });

  const zpl = `
^XA
^PW600
^LL450

^CF0,35
^FO40,30
^FDEXECUTIVE MESS^FS

^CF0,25
^FO40,85
^FDQR SCAN RECEIPT^FS

^FO40,125
^GB520,2,2^FS

^CF0,22
^FO40,155
^FDQR DATA:^FS

^CF0,27
^FO40,195
^FD${safeQrData}^FS

^FO40,245
^BQN,2,5
^FDLA,${safeQrData}^FS

^CF0,18
^FO300,275
^FD${formatDateTime()}^FS

^FO40,390
^GB520,2,2^FS

^CF0,18
^FO40,410
^FDQR Scanner Test - BC-8000G^FS

^XZ
`;

  return sendZpl(zpl).then(() => {
    logger.info("PRINTER", "Receipt printed");
  });
}

function printTestReceipt() {
  logger.info(
    "PRINTER",
    `Connecting to Zebra ${config.printerIp}:${config.printerPort}...`
  );

  const zpl = `
^XA
^PW600
^LL300

^CF0,35
^FO70,40^FDEXECUTIVE MESS^FS

^CF0,25
^FO70,100^FDZebra Printer Test^FS

^CF0,22
^FO70,150^FDPrinter Connection OK^FS

^XZ
`;

  return sendZpl(zpl).then(() => {
    logger.info("PRINTER", "Test receipt printed");
  });
}

function printMealReceipt(data) {
  const employeeName = sanitizeZpl(data.employeeName || "-", { maxLength: 40 });
  const employeeCode = sanitizeZpl(
    data.employeeCode || data.userId || "-",
    { maxLength: 32 }
  );
  const mealName = sanitizeZpl(data.mealName || "-", { maxLength: 24 });
  const amountText = sanitizeZpl(formatRs(data.amount));
  const balanceText = sanitizeZpl(
    `Balance: ${formatRs(data.balanceAfter ?? data.newBalance)}`
  );
  const sourceText = sanitizeZpl(displaySource(data.source));
  const dateTime = sanitizeZpl(
    formatDisplayDateTime(data.dateTime || new Date(), config.timezone)
  );
  const txn = sanitizeZpl(
    `TXN: ${shortTxnId(data.localTransactionId || data.transactionId)}`
  );

  const zpl = `
^XA
^PW600
^LL560

^CF0,35
^FO70,30^FDEXECUTIVE MESS^FS

^FO40,80^GB520,2,2^FS

^CF0,28
^FO50,110^FD${employeeName}^FS

^CF0,24
^FO50,150^FD${employeeCode}^FS

^CF0,28
^FO50,200^FD${mealName}^FS

^CF0,26
^FO50,240^FD${amountText}^FS

^CF0,24
^FO50,290^FD${balanceText}^FS

^CF0,22
^FO50,340^FD${sourceText}^FS

^CF0,20
^FO50,380^FD${dateTime}^FS

^CF0,20
^FO50,420^FD${txn}^FS

^FO40,470^GB520,2,2^FS

^XZ
`;

  return sendZpl(zpl).then(() => {
    logger.info("PRINTER", "Receipt printed");
  });
}

module.exports = {
  initPrinter,
  getPrinterStatus,
  printAttendanceReceipt,
  printQrReceipt,
  printTestReceipt,
  printMealReceipt,
  sanitizeZpl,
};
