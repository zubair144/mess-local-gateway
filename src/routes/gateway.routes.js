const db = require("../db/database");

function registerGatewayRoutes(app) {
  app.get("/employees", (req, res) => {
    const employees = db
      .prepare(
        `
        SELECT
          id,
          employee_code,
          name,
          qr_code,
          face_device_user_id,
          mess_eligible,
          monthly_allowance,
          available_balance,
          active
        FROM employees
        WHERE active = 1
      `
      )
      .all();

    res.json(employees);
  });

  app.get("/transactions", (req, res) => {
    const transactions = db
      .prepare(
        `
        SELECT *
        FROM transactions
        ORDER BY transaction_time DESC
      `
      )
      .all();

    res.json(transactions);
  });

  app.get("/sync/pending", (req, res) => {
    const pending = db
      .prepare(
        `
        SELECT *
        FROM sync_queue
        WHERE status = 'pending'
        ORDER BY id ASC
      `
      )
      .all();

    res.json(pending);
  });
}

module.exports = {
  registerGatewayRoutes,
};
