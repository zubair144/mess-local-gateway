const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "../../.env"),
  quiet: true,
});

const PROJECT_ROOT = path.join(__dirname, "../..");

function envString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const sqliteRelative = envString("SQLITE_PATH", "./data/mess-local.db");

module.exports = {
  projectRoot: PROJECT_ROOT,
  logLevel: envString("LOG_LEVEL", "info").toLowerCase(),

  gatewayPort: envInt("GATEWAY_PORT", 5050),
  gatewayHost: envString("GATEWAY_HOST", "0.0.0.0"),
  gatewayHostIp: envString("GATEWAY_HOST_IP", "192.168.1.4"),

  zkAdmsPort: envInt("ZK_ADMS_PORT", 8080),
  zkAdmsHost: envString("ZK_ADMS_HOST", "0.0.0.0"),
  zkDeviceIp: envString("ZK_DEVICE_IP", "192.168.1.16"),
  zkDevicePort: envInt("ZK_DEVICE_PORT", 4370),
  zkCommKey: envInt("ZK_COMM_KEY", 0),

  printerIp: envString("PRINTER_IP", "192.168.1.17"),
  printerPort: envInt("PRINTER_PORT", 9100),
  printerTimeoutMs: envInt("PRINTER_TIMEOUT_MS", 5000),

  sqlitePath: path.resolve(PROJECT_ROOT, sqliteRelative),

  faceEnabled: envBool("FACE_ENABLED", true),
  qrEnabled: envBool("QR_ENABLED", true),
  printerEnabled: envBool("PRINTER_ENABLED", true),
  hardwareProcessMeals: envBool("HARDWARE_PROCESS_MEALS", true),

  faceDuplicateWindowMs: envInt("FACE_DUPLICATE_WINDOW_MS", 10000),
  qrDuplicateWindowMs: envInt("QR_DUPLICATE_WINDOW_MS", 3000),

  timezone: envString("TIMEZONE", "Asia/Karachi"),
  printDeclinedReceipts: envBool("PRINT_DECLINED_RECEIPTS", false),
  dashboardPollMs: envInt("DASHBOARD_POLL_MS", 3000),
  demoFaceDeviceUserId: envString("DEMO_FACE_DEVICE_USER_ID", "1"),
  nodeEnv: envString("NODE_ENV", "development"),
  devForceMeal: envString("DEV_FORCE_MEAL", "").trim().toLowerCase(),

  cloudApiUrl: envString("CLOUD_API_URL", "http://localhost:3000"),
  gatewayId: envString("GATEWAY_ID", "MESS-01"),
  gatewayApiKey: envString("GATEWAY_API_KEY", ""),
  // CLOUD_SYNC_ENABLED is the master switch; SYNC_ENABLED remains a backward-compatible alias.
  cloudSyncEnabled: envBool(
    "CLOUD_SYNC_ENABLED",
    envBool("SYNC_ENABLED", true)
  ),
  cloudPullEnabled: envBool("CLOUD_PULL_ENABLED", true),
  cloudPushEnabled: envBool("CLOUD_PUSH_ENABLED", true),
  heartbeatEnabled: envBool("HEARTBEAT_ENABLED", true),
  syncPullIntervalMs: envInt("SYNC_PULL_INTERVAL_MS", 15000),
  syncPushIntervalMs: envInt("SYNC_PUSH_INTERVAL_MS", 10000),
  heartbeatIntervalMs: envInt("HEARTBEAT_INTERVAL_MS", 30000),
  syncBatchSize: envInt("SYNC_BATCH_SIZE", 50),
  syncRequestTimeoutMs: envInt("SYNC_REQUEST_TIMEOUT_MS", 10000),
  syncMaxAttempts: envInt("SYNC_MAX_ATTEMPTS", 10),
  syncRetryBaseMs: envInt("SYNC_RETRY_BASE_MS", 5000),
  syncRetryMaxMs: envInt("SYNC_RETRY_MAX_MS", 300000),
};

// Keep syncEnabled as a plain alias so existing callers keep working.
module.exports.syncEnabled = module.exports.cloudSyncEnabled;
