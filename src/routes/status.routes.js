const db = require("../db/database");
const { getCurrentMeal } = require("../services/meal-service");
const { getSyncStatus } = require("../services/sync-service");
const hardware = require("../hardware");
const config = require("../config");

async function buildStatus() {
  const sqlite = db.getStatus();
  const hardwareStatus = await hardware.getHardwareStatus();
  const sync = getSyncStatus();

  return {
    status: sqlite.connected ? "ok" : "degraded",
    gateway: "Mess Local Gateway",
    database: "SQLite",
    sqlite,
    currentMeal: getCurrentMeal(),
    hardware: hardwareStatus,
    sync,
    ports: {
      gateway: config.gatewayPort,
      zkAdms: config.zkAdmsPort,
    },
  };
}

function registerStatusRoutes(app) {
  app.get("/health", async (req, res) => {
    const sqlite = db.getStatus();

    res.json({
      status: sqlite.connected ? "ok" : "error",
      gateway: "Mess Local Gateway",
      database: "SQLite",
      currentMeal: getCurrentMeal(),
    });
  });

  app.get("/api/status", async (req, res) => {
    res.json(await buildStatus());
  });
}

module.exports = {
  registerStatusRoutes,
  buildStatus,
};
