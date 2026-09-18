const db = require("../db/database");
const employeeService = require("../services/employee-service");
const mealTransaction = require("../services/meal-transaction.service");
const dashboardService = require("../services/dashboard-service");
const { getSyncQueueSummary } = require("../services/dashboard-service");
const {
  syncNow,
  forceFullPull,
  retryFailed,
  clearFailedDummy,
  resetDemoData,
  resetAndPull,
  getSyncStatus,
} = require("../services/sync-service");
const identityService = require("../services/identity-service");
const logger = require("../logger");

async function handleForceFullPull(req, res) {
  const sync = getSyncStatus();
  if (!sync.configured) {
    return res.status(400).json({
      success: false,
      message: "Cloud sync is not configured. Set CLOUD_API_URL and GATEWAY_API_KEY.",
    });
  }
  if (sync.pullEnabled === false) {
    return res.status(400).json({
      success: false,
      message: "Cloud pull is disabled (CLOUD_PULL_ENABLED=false).",
    });
  }

  try {
    const result = await forceFullPull();
    res.json(result);
  } catch (err) {
    logger.error("SYNC", err.message || err);
    res.status(500).json({
      success: false,
      message: err.message || "Force full pull failed",
    });
  }
}

function requireConfirm(req) {
  const bodyConfirm = req.body && (req.body.confirm === true || req.body.confirm === "1");
  const queryConfirm = req.query && req.query.confirm === "1";
  return Boolean(bodyConfirm || queryConfirm);
}

function registerLocalRoutes(app) {
  app.get("/api/local/employees", (req, res) => {
    const employees = employeeService
      .listEmployees({ q: req.query.q })
      .map(employeeService.toPublicEmployee);

    res.json({
      success: true,
      count: employees.length,
      employees,
    });
  });

  app.get("/api/local/employees/:id", (req, res) => {
    const employee = employeeService.findById(req.params.id);

    if (!employee) {
      return res.status(404).json({
        success: false,
        reason: "EMPLOYEE_NOT_FOUND",
      });
    }

    const ledger = db
      .prepare(
        `
        SELECT *
        FROM employee_ledger
        WHERE employee_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `
      )
      .all(employee.id);

    const transactions = db
      .prepare(
        `
        SELECT *
        FROM transactions
        WHERE employee_id = ?
        ORDER BY transaction_time DESC
        LIMIT 20
      `
      )
      .all(employee.id);

    res.json({
      success: true,
      employee: employeeService.toPublicEmployee(employee),
      ledger,
      transactions,
    });
  });

  app.get("/api/local/transactions", (req, res) => {
    const { date, employee, meal, source, sync_status: syncStatus } = req.query;

    const clauses = ["1 = 1"];
    const params = [];

    if (date) {
      clauses.push("business_date = ?");
      params.push(date);
    }

    if (employee) {
      clauses.push("(employee_code = ? OR employee_id = ?)");
      params.push(employee, employee);
    }

    if (meal) {
      clauses.push("(lower(meal_type) = ? OR lower(meal_name) = ?)");
      const mealValue = String(meal).toLowerCase();
      params.push(mealValue, mealValue);
    }

    if (source) {
      clauses.push("(source = ? OR identification_method = ?)");
      params.push(source, source);
    }

    if (syncStatus) {
      clauses.push("sync_status = ?");
      params.push(syncStatus);
    }

    const transactions = db
      .prepare(
        `
        SELECT *
        FROM transactions
        WHERE ${clauses.join(" AND ")}
        ORDER BY transaction_time DESC
        LIMIT 200
      `
      )
      .all(...params);

    res.json({
      success: true,
      count: transactions.length,
      transactions,
    });
  });

  app.get("/api/local/sync-queue", (req, res) => {
    const summary = getSyncQueueSummary();
    const items = dashboardService.getPendingSyncItems(100);

    res.json({
      success: true,
      counts: summary,
      items,
    });
  });

  app.get("/api/local/dashboard", async (req, res) => {
    res.json({
      success: true,
      ...(await dashboardService.getDashboardSnapshot({
        probePrinter: req.query.probe === "1",
      })),
    });
  });

  app.post("/api/local/meal/process", async (req, res) => {
    const body = req.body || {};
    const source = body.source || "manual-test";
    const identifier =
      body.identifier ||
      body.employeeCode ||
      body.qrCode ||
      body.rfidUid ||
      body.rfidCardUid ||
      body.faceDeviceUserId;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        reason: "IDENTIFIER_REQUIRED",
        message: "employeeCode or identifier is required.",
      });
    }

    try {
      const result = mealTransaction.processMealTransaction({
        source,
        identifier,
        timestamp: body.timestamp,
        deviceId: body.deviceId || "manual-api",
        mealType: body.mealType,
        allowMealOverride: Boolean(body.mealType),
      });

      if (!result.success) {
        return res.status(400).json(result);
      }

      res.json(result);
    } catch (err) {
      logger.error("TRANSACTION", err.message || err);
      res.status(500).json({
        success: false,
        reason: "TRANSACTION_FAILED",
        message: err.message || "Transaction failed",
      });
    }
  });

  app.post("/api/local/sync/retry-failed", async (req, res) => {
    const sync = getSyncStatus();
    if (!sync.configured) {
      return res.status(400).json({
        success: false,
        message: "Cloud sync is not configured. Set CLOUD_API_URL and GATEWAY_API_KEY.",
      });
    }

    try {
      const result = await retryFailed();
      res.json(result);
    } catch (err) {
      logger.error("SYNC", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Retry failed",
      });
    }
  });

  app.post("/api/local/sync/now", async (req, res) => {
    const sync = getSyncStatus();
    if (!sync.configured) {
      return res.status(400).json({
        success: false,
        message: "Cloud sync is not configured. Set CLOUD_API_URL and GATEWAY_API_KEY.",
      });
    }

    try {
      const result = await syncNow();
      res.json(result);
    } catch (err) {
      logger.error("SYNC", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Sync now failed",
      });
    }
  });

  app.post("/api/local/sync/force-full-pull", handleForceFullPull);
  app.post("/api/sync/force-full-pull", handleForceFullPull);

  app.post("/api/local/sync/clear-failed-dummy", (req, res) => {
    if (process.env.NODE_ENV === "production" && req.query.confirm !== "1") {
      return res.status(400).json({
        success: false,
        message: "Pass ?confirm=1 in production to clear failed dummy queue rows.",
      });
    }

    try {
      const result = clearFailedDummy();
      res.json({ success: true, ...result });
    } catch (err) {
      logger.error("SYNC", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Clear failed",
      });
    }
  });

  app.post("/api/local/admin/reset-demo-data", (req, res) => {
    if (!requireConfirm(req)) {
      return res.status(400).json({
        success: false,
        message:
          "Confirmation required. POST {\"confirm\":true} or ?confirm=1 — this deletes local business/demo data.",
      });
    }

    try {
      const result = resetDemoData();
      res.json(result);
    } catch (err) {
      logger.error("ADMIN", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Reset demo data failed",
      });
    }
  });

  app.post("/api/local/admin/reset-and-pull", async (req, res) => {
    if (!requireConfirm(req)) {
      return res.status(400).json({
        success: false,
        message:
          "Confirmation required. POST {\"confirm\":true} or ?confirm=1 — this deletes local data then reloads from cloud.",
      });
    }

    const sync = getSyncStatus();
    if (!sync.configured) {
      return res.status(400).json({
        success: false,
        message: "Cloud sync is not configured. Set CLOUD_API_URL and GATEWAY_API_KEY.",
      });
    }
    if (sync.pullEnabled === false) {
      return res.status(400).json({
        success: false,
        message: "Cloud pull is disabled (CLOUD_PULL_ENABLED=false).",
      });
    }

    try {
      const result = await resetAndPull();
      const status = result.success ? 200 : 400;
      res.status(status).json(result);
    } catch (err) {
      logger.error("ADMIN", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Reset and pull failed",
      });
    }
  });

  app.post("/api/local/identity/arm", (req, res) => {
    const body = req.body || {};
    res.json({
      success: true,
      ...identityService.armVerification({
        terminalId: body.terminalId,
        ttlMs: body.ttlMs,
      }),
    });
  });

  app.post("/api/local/identity/disarm", (_req, res) => {
    res.json({ success: true, ...identityService.disarmVerification() });
  });

  app.post("/api/local/identity/resolve", (req, res) => {
    const body = req.body || {};
    const type = String(body.type || body.source || "rfid").toLowerCase();
    const identifier = body.identifier || body.rfidCardUid || body.faceDeviceUserId;
    const result = identityService.createVerificationSession({
      source: type,
      identifier,
      deviceId: body.deviceId || "pos",
    });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json({ success: true, ...result });
  });

  app.get("/api/local/identity/pending", (_req, res) => {
    const session = identityService.getLatestPending();
    res.json({
      success: true,
      armed: identityService.isVerificationArmed(),
      session: session || null,
    });
  });

  app.post("/api/local/identity/consume", (req, res) => {
    const id = req.body && req.body.verificationSessionId;
    const result = identityService.consumeSession(id);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json({ success: true, ...result });
  });
}

module.exports = {
  registerLocalRoutes,
};
