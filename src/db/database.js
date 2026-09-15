const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../config");
const { applySchema } = require("./schema");
const logger = require("../logger");

const dataDir = path.dirname(config.sqlitePath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.sqlitePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

applySchema(db);

function getStatus() {
  try {
    db.prepare("SELECT 1").get();
    return {
      connected: true,
      path: config.sqlitePath,
    };
  } catch (err) {
    logger.error("SQLITE", err.message);
    return {
      connected: false,
      path: config.sqlitePath,
      error: err.message,
    };
  }
}

function closeDatabase() {
  if (db.open) {
    db.close();
  }
}

module.exports = db;
module.exports.getStatus = getStatus;
module.exports.closeDatabase = closeDatabase;
