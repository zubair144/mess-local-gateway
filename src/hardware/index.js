const face = require("./face/face-service");
const qr = require("./qr/qr-service");
const printer = require("./printer/printer-service");

async function startHardware() {
  await face.startFaceService();
  qr.startQrService();
  await printer.initPrinter();
}

async function stopHardware() {
  qr.stopQrService();
  await face.stopFaceService();
}

async function getHardwareStatus({ probePrinter = false } = {}) {
  const printerStatus = await printer.getPrinterStatus({
    probe: probePrinter,
  });

  return {
    face: face.getFaceStatus(),
    qr: qr.getQrStatus(),
    printer: printerStatus,
  };
}

module.exports = {
  startHardware,
  stopHardware,
  getHardwareStatus,
  face,
  qr,
  printer,
};
