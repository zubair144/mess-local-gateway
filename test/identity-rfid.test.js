const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { applySchema } = require("../src/db/schema");
const { applyMasterPayload } = require("../src/sync/master-pull.service");
const employeeService = require("../src/services/employee-service");
const identityService = require("../src/services/identity-service");
const { normalizeRfidUid } = require("../src/utils/rfid");

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

test("RFID UID normalization trims scanner noise and preserves leading zeros", () => {
  assert.equal(normalizeRfidUid(" 004a1b \r\n"), "004A1B");
  assert.equal(normalizeRfidUid("04 A1 B2"), "04A1B2");
});

test("registered RFID resolves the correct employee and unknown RFID is rejected", () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, rfid_uid, mess_eligible, monthly_allowance,
      available_balance, active, is_active, created_at, updated_at
    ) VALUES ('emp-1', 'EMP1024', 'Muhammad Ali', '04A1B2C3D4', 1, 15000, 8500, 1, 1, ?, ?)
  `
  ).run(now, now);

  const found = employeeService.findByRfidUid("04a1b2c3d4", db);
  assert.equal(found.employee_code, "EMP1024");
  assert.equal(employeeService.findByRfidUid("NOPE", db), null);
});

test("cloud RFID update and removal sync into local SQLite", () => {
  const db = createTestDb();
  applyMasterPayload(db, {
    syncVersion: 1,
    employees: [{
      cloudId: "cloud-1",
      employeeCode: "EMP1024",
      name: "Muhammad Ali",
      rfidCardUid: "AAA111",
      availableBalance: 8500,
      messEligible: true,
      isActive: true,
      syncVersion: 1,
      updatedAt: new Date().toISOString(),
    }],
    mealRates: [],
    mealTimings: [],
  });
  assert.equal(employeeService.findByRfidUid("AAA111", db).employee_code, "EMP1024");

  applyMasterPayload(db, {
    syncVersion: 2,
    employees: [{
      cloudId: "cloud-1",
      employeeCode: "EMP1024",
      name: "Muhammad Ali",
      rfidCardUid: "BBB222",
      availableBalance: 8500,
      messEligible: true,
      isActive: true,
      syncVersion: 2,
      updatedAt: new Date().toISOString(),
    }],
    mealRates: [],
    mealTimings: [],
  });
  assert.equal(employeeService.findByRfidUid("AAA111", db), null);
  assert.equal(employeeService.findByRfidUid("BBB222", db).employee_code, "EMP1024");

  applyMasterPayload(db, {
    syncVersion: 3,
    employees: [{
      cloudId: "cloud-1",
      employeeCode: "EMP1024",
      name: "Muhammad Ali",
      rfidCardUid: "",
      availableBalance: 8500,
      messEligible: true,
      isActive: true,
      syncVersion: 3,
      updatedAt: new Date().toISOString(),
    }],
    mealRates: [],
    mealTimings: [],
  });
  assert.equal(employeeService.findByRfidUid("BBB222", db), null);
});

test("verification session is single-use and expires after consume", () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, rfid_uid, mess_eligible, monthly_allowance,
      available_balance, active, is_active, created_at, updated_at
    ) VALUES ('emp-1', 'EMP1024', 'Muhammad Ali', '04A1B2C3D4', 1, 15000, 8500, 1, 1, ?, ?)
  `
  ).run(now, now);

  const created = identityService.createVerificationSession({
    source: "rfid",
    identifier: "04A1B2C3D4",
    database: db,
  });
  assert.equal(created.ok, true);
  const first = identityService.consumeSession(created.verificationSessionId);
  assert.equal(first.ok, true);
  const second = identityService.consumeSession(created.verificationSessionId);
  assert.equal(second.ok, false);
});
