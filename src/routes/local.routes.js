const db = require("../db/database");
const employeeService = require("../services/employee-service");
const mealTransaction = require("../services/meal-transaction.service");
const dashboardService = require("../services/dashboard-service");
const { getSyncQueueSummary } = require("../services/dashboard-service");
const logger = require("../logger");

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

  app.post("/api/local/sync/retry-failed", (req, res) => {
    res.status(501).json({
      success: false,
      message: "Cloud synchronization is not configured yet.",
    });
  });

  app.post("/api/local/sync/now", (req, res) => {
    res.status(501).json({
      success: false,
      message: "Cloud synchronization is not configured yet.",
    });
  });
}

module.exports = {
  registerLocalRoutes,
};
