const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applySchema } = require("../src/db/schema");
const { createProcessor } = require("../src/services/meal-transaction.service");

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function seedBase(db) {
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, qr_code, face_device_user_id,
      mess_eligible, monthly_allowance, available_balance,
      active, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 15000, ?, 1, 1, ?, ?)
  `
  ).run(
    "emp-001",
    "EMP001",
    "Muhammad Ali",
    "EMP001-QR",
    "25",
    15000,
    now,
    now
  );

  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, qr_code, face_device_user_id,
      mess_eligible, monthly_allowance, available_balance,
      active, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 15000, ?, 1, 1, ?, ?)
  `
  ).run(
    "emp-002",
    "EMP002",
    "Low Balance User",
    "EMP002-QR",
    "999",
    200,
    now,
    now
  );

  db.prepare(
    `
    INSERT INTO meal_rates (id, meal_type, rate, parcel_charge, is_active, effective_from, updated_at)
    VALUES ('lunch', 'lunch', 500, 0, 1, ?, ?)
  `
  ).run(now, now);

  db.prepare(
    `
    INSERT INTO meal_timings (id, meal_type, start_time, end_time, is_active, updated_at)
    VALUES ('lunch', 'lunch', '00:00', '23:59', 1, ?)
  `
  ).run(now);
}

test("successful transaction deducts balance and writes ledger/sync queue", () => {
  const db = createTestDb();
  seedBase(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const result = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });

  assert.equal(result.success, true);
  assert.equal(result.balanceBefore, 15000);
  assert.equal(result.balanceAfter, 14500);

  const employee = db
    .prepare("SELECT available_balance FROM employees WHERE id = 'emp-001'")
    .get();
  assert.equal(employee.available_balance, 14500);

  const ledger = db
    .prepare(
      "SELECT COUNT(*) AS count FROM employee_ledger WHERE employee_id = 'emp-001'"
    )
    .get();
  assert.equal(ledger.count, 1);

  const syncQueue = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sync_queue WHERE entity_id = ?"
    )
    .get(result.localTransactionId);
  assert.equal(syncQueue.count, 1);
});

test("duplicate meal is blocked across sources", () => {
  const db = createTestDb();
  seedBase(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const first = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(first.success, true);

  const second = processor.processMealTransaction({
    source: "face",
    identifier: "25",
  });

  assert.equal(second.success, false);
  assert.equal(second.reason, "MEAL_ALREADY_TAKEN");

  const employee = db
    .prepare("SELECT available_balance FROM employees WHERE id = 'emp-001'")
    .get();
  assert.equal(employee.available_balance, 14500);
});

test("insufficient balance does not deduct", () => {
  const db = createTestDb();
  seedBase(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const result = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP002-QR",
  });

  assert.equal(result.success, false);
  assert.equal(result.reason, "INSUFFICIENT_BALANCE");
  assert.equal(result.currentBalance, 200);
  assert.equal(result.requiredAmount, 500);

  const employee = db
    .prepare("SELECT available_balance FROM employees WHERE id = 'emp-002'")
    .get();
  assert.equal(employee.available_balance, 200);
});

test("inactive and ineligible employees are declined", () => {
  const db = createTestDb();
  seedBase(db);
  const now = new Date().toISOString();

  db.prepare(
    "UPDATE employees SET active = 0, is_active = 0 WHERE employee_code = 'EMP001'"
  ).run();

  db.prepare(
    "UPDATE employees SET mess_eligible = 0 WHERE employee_code = 'EMP002'"
  ).run();

  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const inactive = processor.processMealTransaction({
    source: "manual-test",
    identifier: "EMP001",
  });
  assert.equal(inactive.reason, "EMPLOYEE_INACTIVE");

  const ineligible = processor.processMealTransaction({
    source: "manual-test",
    identifier: "EMP002",
  });
  assert.equal(ineligible.reason, "MESS_NOT_ELIGIBLE");
});

test("employee not found is declined", () => {
  const db = createTestDb();
  seedBase(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const result = processor.processMealTransaction({
    source: "qr",
    identifier: "UNKNOWN-QR",
  });

  assert.equal(result.reason, "EMPLOYEE_NOT_FOUND");
});
