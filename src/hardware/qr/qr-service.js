const rfid = require("../rfid/rfid-service");

/**
 * Legacy QR HID adapter. Operational identification is RFID.
 * Kept so existing /api/meal/qr callers and tests continue to import this file.
 */
async function handleQrScan(rawValue, options = {}) {
  return rfid.handleRfidScan(rawValue, options);
}

module.exports = {
  startQrService: () => {},
  stopQrService: () => {},
  handleQrScan,
  getQrStatus: () => rfid.getRfidStatus(),
};
