function formatRs(amount) {
  const numeric = Number(amount);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  return `Rs ${safe.toLocaleString("en-US")}`;
}

function shortTxnId(id) {
  return String(id || "")
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
}

function displayMealName(mealType) {
  const value = String(mealType || "").trim().toLowerCase();
  if (!value) {
    return "-";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function displaySource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value === "face") {
    return "FACE";
  }
  if (value === "rfid") {
    return "RFID";
  }
  if (value === "qr") {
    return "QR";
  }
  if (value === "manual" || value === "manual-test") {
    return "MANUAL";
  }
  return value ? value.toUpperCase() : "-";
}

function normalizeSource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value === "manual-test") {
    return "manual";
  }
  return value;
}

module.exports = {
  formatRs,
  shortTxnId,
  displayMealName,
  displaySource,
  normalizeSource,
};
