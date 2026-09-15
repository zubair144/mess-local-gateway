const crypto = require("crypto");

const QR_PREFIX = "MESS_EMPLOYEE:";

function parseQrToken(raw) {
  const payload = String(raw || "").trim();
  if (!payload) {
    return "";
  }
  return payload.startsWith(QR_PREFIX)
    ? payload.slice(QR_PREFIX.length)
    : payload;
}

function sha256hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function hashQrToken(raw) {
  const token = parseQrToken(raw);
  if (!token) {
    return "";
  }
  return sha256hex(token);
}

module.exports = {
  QR_PREFIX,
  parseQrToken,
  sha256hex,
  hashQrToken,
};
