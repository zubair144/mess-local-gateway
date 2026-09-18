function normalizeRfidUid(value) {
  if (value === undefined || value === null) {
    return "";
  }
  let s = String(value).replace(/[\r\n\t ]+/g, "").trim();
  if (!s) {
    return "";
  }
  if (/^[0-9A-Za-z]+$/.test(s)) {
    s = s.toUpperCase();
  }
  return s;
}

function isCardVerifyMode(verifyMode) {
  const value = String(verifyMode || "").trim().toUpperCase();
  if (!value) {
    return false;
  }
  return (
    value === "2" ||
    value === "4" ||
    value === "CARD" ||
    value === "RF" ||
    value === "RFID" ||
    value === "IDCARD" ||
    value === "ID_CARD"
  );
}

module.exports = {
  normalizeRfidUid,
  isCardVerifyMode,
};
