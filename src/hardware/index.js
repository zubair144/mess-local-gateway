const face = require("./face/face-service");
const qr = require("./qr/qr-service");
const rfid = require("./rfid/rfid-service");
const printer = require("./printer/printer-service");

async function startHardware() {
  await face.startFaceService();
  rfid.startRfidService();
  await printer.initPrinter();
}

async function stopHardware() {
  rfid.stopRfidService();
  await face.stopFaceService();
}

async function getHardwareStatus({ probePrinter = false } = {}) {
  const printerStatus = await printer.getPrinterStatus({
    probe: probePrinter,
  });
  const rfidStatus = rfid.getRfidStatus();

  return {
    face: face.getFaceStatus(),
    rfid: rfidStatus,
    qr: rfidStatus,
    printer: printerStatus,
  };
}

module.exports = {
  startHardware,
  stopHardware,
  getHardwareStatus,
  face,
  qr,
  rfid,
  printer,
};
