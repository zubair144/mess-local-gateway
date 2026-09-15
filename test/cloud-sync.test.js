const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { applySchema } = require("../src/db/schema");
const { createProcessor } = require("../src/services/meal-transaction.service");
const { sha256hex, hashQrToken, parseQrToken } = require("../src/cloud/qr-hash");
const { CloudRequestError } = require("../src/cloud/cloud-client");
const { pullMasterData, applyMasterPayload } = require("../src/sync/master-pull.service");
const { getSyncVersion: readPersistedVersion } = require("../src/sync/sync-state");
const {
  pushPendingTransactions,
  makeFailedRetryable,
  retryDelayMs,
} = require("../src/sync/transaction-push.service");

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return db;
}

function createFileDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mess-gw-sync-"));
  const file = path.join(dir, "mess-local.db");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  applySchema(db);
  return { db, file, dir };
}

function seedMeals(db) {
  const now = new Date().toISOString();
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

function seedDemoEmployee(db, extras = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, qr_code, face_device_user_id,
      mess_eligible, monthly_allowance, available_balance, cloud_balance,
      active, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 15000, ?, ?, 1, 1, ?, ?)
  `
  ).run(
    extras.id || "emp-001",
    extras.employeeCode || "EMP001",
    extras.name || "Muhammad Ali",
    extras.qrCode === undefined ? "EMP001-QR" : extras.qrCode,
    extras.faceDeviceUserId || "25",
    extras.availableBalance == null ? 15000 : extras.availableBalance,
    extras.cloudBalance == null
      ? extras.availableBalance == null
        ? 15000
        : extras.availableBalance
      : extras.cloudBalance,
    now,
    now
  );
}

function cloudEmployee(overrides = {}) {
  return {
    cloudId: "cloud-emp-1",
    employeeCode: "EMP100",
    name: "Cloud User",
    department: "Operations",
    availableBalance: 15000,
    qrTokenHash: sha256hex("portal-token"),
    qrStatus: "ACTIVE",
    faceDeviceUserId: "42",
    messEligible: true,
    isActive: true,
    isDeleted: false,
    syncVersion: 1,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockClient(handlers) {
  return {
    pullChanges: async (since) => handlers.pullChanges(since),
    pushTransactions: async (transactions) => handlers.pushTransactions(transactions),
    sendHeartbeat: async (status) =>
      handlers.sendHeartbeat ? handlers.sendHeartbeat(status) : { success: true },
  };
}

test("QR hash matches cloud SHA-256 and MESS_EMPLOYEE prefix stripping", () => {
  assert.equal(parseQrToken("MESS_EMPLOYEE:abc"), "abc");
  assert.equal(hashQrToken("MESS_EMPLOYEE:abc"), sha256hex("abc"));
  assert.equal(hashQrToken("abc"), sha256hex("abc"));
});

test("initial since=0 pull inserts employee, rates, timings, and persists syncVersion", async () => {
  const db = createTestDb();
  const client = mockClient({
    pullChanges: async (since) => {
      assert.equal(since, 0);
      return {
        success: true,
        syncVersion: 10,
        serverTime: new Date().toISOString(),
        employees: [cloudEmployee()],
        mealRates: [
          {
            cloudId: "mt-lunch",
            mealType: "Lunch",
            rate: 500,
            parcelCharge: 0,
            isActive: true,
            syncVersion: 10,
          },
        ],
        mealTimings: [
          {
            cloudId: "mt-lunch",
            mealType: "Lunch",
            startTime: "12:00",
            endTime: "15:00",
            isActive: true,
            syncVersion: 10,
          },
        ],
      };
    },
  });

  const result = await pullMasterData({ database: db, client, since: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, 0);
  assert.equal(result.toVersion, 10);
  assert.equal(result.employeesInserted + result.employeesUpdated, 1);
  assert.equal(result.employeesReceived, 1);
  assert.equal(result.ratesUpdated, 1);
  assert.equal(result.timingsUpdated, 1);
  assert.equal(readPersistedVersion(db), 10);

  const employee = db.prepare("SELECT * FROM employees WHERE cloud_id = 'cloud-emp-1'").get();
  assert.equal(employee.employee_code, "EMP100");
  assert.equal(employee.qr_token_hash, sha256hex("portal-token"));
  assert.equal(employee.face_device_user_id, "42");
  assert.equal(employee.available_balance, 15000);
  assert.equal(employee.cloud_balance, 15000);
});

test("incremental pull updates, deactivates, and refreshes rates/timings", async () => {
  const db = createTestDb();
  applyMasterPayload(db, {
    syncVersion: 10,
    employees: [cloudEmployee()],
    mealRates: [
      { cloudId: "mt-lunch", mealType: "Lunch", rate: 500, parcelCharge: 0, isActive: true },
    ],
    mealTimings: [
      {
        cloudId: "mt-lunch",
        mealType: "Lunch",
        startTime: "12:00",
        endTime: "15:00",
        isActive: true,
      },
    ],
  });

  const client = mockClient({
    pullChanges: async (since) => {
      assert.equal(since, 10);
      return {
        success: true,
        syncVersion: 14,
        employees: [
          cloudEmployee({
            name: "Cloud User Updated",
            isActive: false,
            messEligible: false,
            syncVersion: 14,
          }),
        ],
        mealRates: [
          { cloudId: "mt-lunch", mealType: "Lunch", rate: 650, parcelCharge: 50, isActive: true },
        ],
        mealTimings: [
          {
            cloudId: "mt-lunch",
            mealType: "Lunch",
            startTime: "13:00",
            endTime: "16:00",
            isActive: true,
          },
        ],
      };
    },
  });

  const result = await pullMasterData({ database: db, client });
  assert.equal(result.ok, true);
  assert.equal(result.toVersion, 14);
  assert.equal(readPersistedVersion(db), 14);

  const employee = db.prepare("SELECT * FROM employees WHERE cloud_id = 'cloud-emp-1'").get();
  assert.equal(employee.name, "Cloud User Updated");
  assert.equal(employee.is_active, 0);
  assert.equal(employee.mess_eligible, 0);

  const rate = db.prepare("SELECT * FROM meal_rates WHERE meal_type = 'lunch'").get();
  assert.equal(rate.rate, 650);
  assert.equal(rate.parcel_charge, 50);

  const timing = db.prepare("SELECT * FROM meal_timings WHERE meal_type = 'lunch'").get();
  assert.equal(timing.start_time, "13:00");
});

test("failed SQLite apply does not advance syncVersion", async () => {
  const db = createTestDb();
  db.prepare(
    `
    INSERT INTO gateway_settings (key, value, updated_at)
    VALUES ('last_cloud_sync_version', '7', ?)
  `
  ).run(new Date().toISOString());

  const client = mockClient({
    pullChanges: async () => ({
      success: true,
      employees: [cloudEmployee({ employeeCode: "EMP100" })],
      mealRates: [],
      mealTimings: [],
    }),
  });

  const result = await pullMasterData({ database: db, client, since: 7 });
  assert.equal(result.ok, false);
  assert.equal(readPersistedVersion(db), 7);
  const inserted = db.prepare("SELECT COUNT(*) AS count FROM employees").get();
  assert.equal(inserted.count, 0);
});

test("cloud pull never restores a stale balance over pending local meals", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db, {
    id: "emp-001",
    employeeCode: "EMP001",
    availableBalance: 15000,
    cloudBalance: 15000,
  });

  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(meal.success, true);
  assert.equal(meal.balanceAfter, 14500);

  const client = mockClient({
    pullChanges: async () => ({
      success: true,
      syncVersion: 20,
      employees: [
        cloudEmployee({
          cloudId: "cloud-emp-001",
          employeeCode: "EMP001",
          name: "Muhammad Ali",
          availableBalance: 15000,
          qrTokenHash: "",
          qrStatus: "",
          faceDeviceUserId: "25",
        }),
      ],
      mealRates: [],
      mealTimings: [],
    }),
  });

  const result = await pullMasterData({ database: db, client, since: 0 });
  assert.equal(result.ok, true);

  const employee = db.prepare("SELECT * FROM employees WHERE employee_code = 'EMP001'").get();
  assert.equal(employee.cloud_balance, 15000);
  assert.equal(employee.available_balance, 14500);
});

test("pending transaction uploads and already_synced reuses localTransactionId", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db, { availableBalance: 15000 });
  db.prepare("UPDATE employees SET cloud_id = 'cloud-emp-001' WHERE id = 'emp-001'").run();

  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(meal.success, true);

  const seen = [];
  const client = mockClient({
    pushTransactions: async (transactions) => {
      seen.push(transactions.map((tx) => tx.localTransactionId));
      return {
        success: true,
        results: transactions.map((tx) => ({
          localTransactionId: tx.localTransactionId,
          status: seen.length === 1 ? "synced" : "already_synced",
          cloudTransactionId: "cloud-txn-1",
          cloudBalance: 14500,
        })),
      };
    },
  });

  const first = await pushPendingTransactions({ database: db, client });
  assert.equal(first.synced, 1);
  assert.equal(first.failed, 0);

  db.prepare(
    `
    UPDATE sync_queue
    SET status = 'pending', next_attempt_at = ?, updated_at = ?
    WHERE entity_id = ?
  `
  ).run(new Date().toISOString(), new Date().toISOString(), meal.localTransactionId);

  const second = await pushPendingTransactions({ database: db, client });
  assert.equal(second.synced, 1);
  assert.equal(seen[0][0], meal.localTransactionId);
  assert.equal(seen[1][0], meal.localTransactionId);

  const queue = db
    .prepare("SELECT * FROM sync_queue WHERE entity_id = ?")
    .get(meal.localTransactionId);
  assert.equal(queue.status, "synced");
  assert.equal(queue.cloud_transaction_id, "cloud-txn-1");

  const txn = db
    .prepare("SELECT * FROM transactions WHERE local_transaction_id = ?")
    .get(meal.localTransactionId);
  assert.equal(txn.sync_status, "synced");
  assert.equal(txn.cloud_transaction_id, "cloud-txn-1");
});

test("partial batch success keeps the failed row", async () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  for (const item of [
    { id: "local-a", code: "EMPA" },
    { id: "local-b", code: "EMPB" },
    { id: "local-c", code: "EMPC" },
  ]) {
    db.prepare(
      `
      INSERT INTO sync_queue (
        entity_type, entity_id, action, payload, payload_json, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES ('meal_transaction', ?, 'create', ?, ?, 'pending', 0, ?, ?, ?)
    `
    ).run(
      item.id,
      JSON.stringify({
        localTransactionId: item.id,
        employeeCode: item.code,
        source: "qr",
        mealType: "lunch",
        mealRate: 500,
        totalAmount: 500,
        transactionTime: now,
        balanceBefore: 15000,
        balanceAfter: 14500,
      }),
      JSON.stringify({
        localTransactionId: item.id,
        employeeCode: item.code,
        source: "qr",
        mealType: "lunch",
        mealRate: 500,
        totalAmount: 500,
        transactionTime: now,
        balanceBefore: 15000,
        balanceAfter: 14500,
      }),
      now,
      now,
      now
    );
  }

  const client = mockClient({
    pushTransactions: async (transactions) => ({
      success: true,
      results: [
        { localTransactionId: "local-a", status: "synced", cloudTransactionId: "ca" },
        { localTransactionId: "local-b", status: "already_synced", cloudTransactionId: "cb" },
        {
          localTransactionId: "local-c",
          status: "failed",
          errorCode: "EMPLOYEE_NOT_FOUND",
        },
      ],
    }),
  });

  const result = await pushPendingTransactions({ database: db, client });
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 1);

  const rows = db
    .prepare("SELECT entity_id, status, last_error FROM sync_queue ORDER BY entity_id")
    .all();
  assert.equal(rows[0].status, "synced");
  assert.equal(rows[1].status, "synced");
  assert.equal(rows[2].status, "failed");
  assert.match(String(rows[2].last_error), /EMPLOYEE_NOT_FOUND/);
});

test("network unavailable does not lose the pending transaction", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });

  const client = mockClient({
    pushTransactions: async () => {
      throw new CloudRequestError({
        message: "Network error (ECONNREFUSED)",
        code: "ECONNREFUSED",
        retryable: true,
      });
    },
  });

  const result = await pushPendingTransactions({ database: db, client });
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);

  const queue = db
    .prepare("SELECT * FROM sync_queue WHERE entity_id = ?")
    .get(meal.localTransactionId);
  assert.equal(queue.status, "failed");
  assert.ok(queue.next_attempt_at);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count,
    1
  );
});

test("server restart retains the pending queue", () => {
  const { db, file, dir } = createFileDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  db.close();

  const reopened = new Database(file);
  const queue = reopened
    .prepare("SELECT status, entity_id FROM sync_queue WHERE entity_id = ?")
    .get(meal.localTransactionId);
  assert.equal(queue.status, "pending");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("offline QR meal still deducts, writes ledger/queue, and printer API stays callable", () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });

  const result = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });

  assert.equal(result.success, true);
  assert.equal(result.balanceAfter, 14500);
  assert.equal(
    db.prepare("SELECT available_balance FROM employees WHERE id = 'emp-001'").get()
      .available_balance,
    14500
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM employee_ledger").get().count,
    1
  );
  assert.equal(
    db.prepare("SELECT status FROM sync_queue").get().status,
    "pending"
  );

  const printer = require("../src/hardware/printer/printer-service");
  assert.equal(typeof printer.printMealReceipt, "function");
  assert.equal(typeof processor.updatePrintStatus, "function");
  processor.updatePrintStatus(result.localTransactionId, "failed");
  assert.equal(
    db
      .prepare("SELECT print_status FROM transactions WHERE local_transaction_id = ?")
      .get(result.localTransactionId).print_status,
    "failed"
  );
});

test("hashed production QR works and demo QR remains available for seed employees", () => {
  const db = createTestDb();
  seedMeals(db);
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO employees (
      id, employee_code, name, qr_code, qr_token_hash, qr_status,
      mess_eligible, monthly_allowance, available_balance, cloud_balance,
      active, is_active, created_at, updated_at
    ) VALUES (
      'emp-hash', 'EMPHASH', 'Hashed User', NULL, ?, 'ACTIVE',
      1, 15000, 15000, 15000, 1, 1, ?, ?
    )
  `
  ).run(sha256hex("secret-token"), now, now);
  seedDemoEmployee(db);

  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const hashed = processor.processMealTransaction({
    source: "qr",
    identifier: "MESS_EMPLOYEE:secret-token",
  });
  assert.equal(hashed.success, true);

  const demo = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(demo.success, true);
});

test("retry-failed makes rows pending again", () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO sync_queue (
      entity_type, entity_id, action, payload, payload_json, status,
      attempt_count, last_error, created_at, updated_at
    ) VALUES ('meal_transaction', 'x', 'create', '{}', '{}', 'failed', 4, 'EMPLOYEE_NOT_FOUND', ?, ?)
  `
  ).run(now, now);

  const changed = makeFailedRetryable(db);
  assert.equal(changed, 1);
  const row = db.prepare("SELECT status FROM sync_queue").get();
  assert.equal(row.status, "pending");
});

test("retry backoff doubles from the configured base", () => {
  assert.equal(retryDelayMs(1, 5000, 300000), 5000);
  assert.equal(retryDelayMs(2, 5000, 300000), 10000);
  assert.equal(retryDelayMs(3, 5000, 300000), 20000);
  assert.equal(retryDelayMs(4, 5000, 300000), 40000);
  assert.equal(retryDelayMs(10, 5000, 300000), 300000);
});

const config = require("../src/config");
const {
  syncNow,
  forceFullPull,
  runPush,
} = require("../src/sync");
const {
  clearFailedDummyTransactions,
} = require("../src/sync/transaction-push.service");
const { setSyncVersion, getSyncVersion } = require("../src/sync/sync-state");

function withSyncFlags(flags, fn) {
  const previous = {
    cloudSyncEnabled: config.cloudSyncEnabled,
    cloudPullEnabled: config.cloudPullEnabled,
    cloudPushEnabled: config.cloudPushEnabled,
    heartbeatEnabled: config.heartbeatEnabled,
    syncEnabled: config.syncEnabled,
  };
  Object.assign(config, flags);
  if (flags.cloudSyncEnabled !== undefined) {
    config.syncEnabled = flags.cloudSyncEnabled;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.assign(config, previous);
    });
}

test("pull enabled + push disabled: Sync Now does not invoke cloud transaction push", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  let pushCalls = 0;
  let pullCalls = 0;
  let heartbeatCalls = 0;

  const client = mockClient({
    pullChanges: async (since) => {
      pullCalls += 1;
      assert.equal(since, 0);
      return {
        success: true,
        syncVersion: 5,
        employees: [cloudEmployee({ syncVersion: 5 })],
        mealRates: [],
        mealTimings: [],
      };
    },
    pushTransactions: async () => {
      pushCalls += 1;
      return { success: true, results: [] };
    },
    sendHeartbeat: async () => {
      heartbeatCalls += 1;
      return { success: true };
    },
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: true,
    },
    async () => {
      const result = await syncNow({ database: db, client });
      assert.equal(result.success, true);
      assert.equal(result.push.disabled, true);
      assert.equal(pushCalls, 0);
      assert.equal(pullCalls, 1);
      assert.equal(heartbeatCalls, 1);
      assert.equal(result.pull.toVersion, 5);
    }
  );
});

test("Force Full Pull starts from version 0 and preserves transaction history", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(meal.success, true);

  setSyncVersion(db, 139);
  let seenSince = null;
  const client = mockClient({
    pullChanges: async (since) => {
      seenSince = since;
      return {
        success: true,
        syncVersion: 140,
        employees: [
          cloudEmployee({
            cloudId: "cloud-new",
            employeeCode: "EMP999",
            name: "Force Pull Emp",
            syncVersion: 140,
            availableBalance: 9000,
            qrTokenHash: "",
            faceDeviceUserId: "",
          }),
        ],
        mealRates: [],
        mealTimings: [],
      };
    },
    pushTransactions: async () => ({ success: true, results: [] }),
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: false,
    },
    async () => {
      const result = await forceFullPull({ database: db, client });
      assert.equal(result.success, true);
      assert.equal(seenSince, 0);
      assert.equal(result.previousVersion, 139);
      assert.equal(result.pull.fromVersion, 0);
      assert.equal(result.pull.toVersion, 140);
      assert.equal(getSyncVersion(db), 140);

      const employee = db
        .prepare("SELECT * FROM employees WHERE employee_code = 'EMP999'")
        .get();
      assert.ok(employee);
      assert.equal(employee.name, "Force Pull Emp");

      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM transactions").get().count,
        1
      );
      assert.equal(
        db
          .prepare("SELECT local_transaction_id FROM transactions")
          .get().local_transaction_id,
        meal.localTransactionId
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM sync_queue").get().count,
        1
      );
    }
  );
});

test("employee from cloud is upserted into SQLite", async () => {
  const db = createTestDb();
  const client = mockClient({
    pullChanges: async () => ({
      success: true,
      syncVersion: 42,
      employees: [
        cloudEmployee({
          cloudId: "cloud-upsert-1",
          employeeCode: "EMP777",
          name: "Upsert Target",
          availableBalance: 1234,
          syncVersion: 42,
        }),
      ],
      mealRates: [],
      mealTimings: [],
    }),
  });

  const result = await pullMasterData({ database: db, client, since: 0 });
  assert.equal(result.ok, true);
  const row = db
    .prepare("SELECT * FROM employees WHERE cloud_id = 'cloud-upsert-1'")
    .get();
  assert.equal(row.employee_code, "EMP777");
  assert.equal(row.name, "Upsert Target");
  assert.equal(row.available_balance, 1234);
  assert.equal(row.cloud_balance, 1234);
});

test("incremental employee change after sinceVersion is retrieved and applied", async () => {
  const db = createTestDb();
  applyMasterPayload(db, {
    syncVersion: 139,
    employees: [cloudEmployee({ syncVersion: 139 })],
    mealRates: [],
    mealTimings: [],
  });
  assert.equal(readPersistedVersion(db), 139);

  const client = mockClient({
    pullChanges: async (since) => {
      assert.equal(since, 139);
      return {
        success: true,
        syncVersion: 140,
        employees: [
          cloudEmployee({
            cloudId: "cloud-emp-new",
            employeeCode: "EMP140",
            name: "Version 140 Emp",
            syncVersion: 140,
            availableBalance: 5000,
            qrTokenHash: "",
            faceDeviceUserId: "",
          }),
        ],
        mealRates: [],
        mealTimings: [],
      };
    },
  });

  const result = await pullMasterData({ database: db, client });
  assert.equal(result.ok, true);
  assert.equal(result.fromVersion, 139);
  assert.equal(result.toVersion, 140);
  assert.equal(readPersistedVersion(db), 140);
  const emp = db
    .prepare("SELECT * FROM employees WHERE employee_code = 'EMP140'")
    .get();
  assert.equal(emp.name, "Version 140 Emp");
});

test("QR meal still works while cloud push is disabled and push is not invoked", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(meal.success, true);
  assert.equal(meal.balanceAfter, 14500);

  let pushCalls = 0;
  const client = mockClient({
    pushTransactions: async () => {
      pushCalls += 1;
      return { success: true, results: [] };
    },
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: true,
    },
    async () => {
      const push = await runPush({ database: db, client, force: true });
      assert.equal(push.disabled, true);
      assert.equal(pushCalls, 0);
      assert.equal(
        db
          .prepare("SELECT status FROM sync_queue WHERE entity_id = ?")
          .get(meal.localTransactionId).status,
        "pending"
      );
    }
  );
});

test("clear-failed-dummy removes only dummy failed queue rows", () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO sync_queue (
      entity_type, entity_id, action, payload, payload_json, status,
      attempt_count, last_error, created_at, updated_at
    ) VALUES
      ('meal_transaction', 'dummy-1', 'create', '{"employeeCode":"DUMMY01"}', '{"employeeCode":"DUMMY01"}', 'failed', 2, 'x', ?, ?),
      ('meal_transaction', 'demo-seed', 'create', '{}', '{"employeeCode":"EMP001","employeeId":"emp-001"}', 'failed', 2, 'EMPLOYEE_NOT_FOUND', ?, ?),
      ('meal_transaction', 'real-1', 'create', '{}', '{"employeeCode":"EMP100","employeeCloudId":"cloud-real"}', 'failed', 2, 'x', ?, ?)
  `
  ).run(now, now, now, now, now, now);

  const result = clearFailedDummyTransactions(db);
  assert.equal(result.cleared, 2);
  const remaining = db.prepare("SELECT entity_id, status FROM sync_queue").all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].entity_id, "real-1");
  assert.equal(remaining[0].status, "failed");
});

const { resetLocalDemoData } = require("../src/sync/reset-demo-data.service");
const { resetAndPull } = require("../src/sync");

test("authoritative force full pull removes stale local employees not in cloud snapshot", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db, {
    id: "emp-stale",
    employeeCode: "STALE01",
    name: "Stale Local",
    faceDeviceUserId: "91",
    qrCode: "STALE-QR",
  });
  seedDemoEmployee(db, {
    id: "emp-keep",
    employeeCode: "KEEP01",
    name: "Keep Local",
    faceDeviceUserId: "92",
    qrCode: "KEEP-QR",
  });
  db.prepare("UPDATE employees SET cloud_id = ? WHERE id = ?").run("cloud-keep", "emp-keep");

  const client = mockClient({
    pullChanges: async () => ({
      success: true,
      syncVersion: 50,
      employees: [
        cloudEmployee({
          cloudId: "cloud-keep",
          employeeCode: "KEEP01",
          name: "Keep From Cloud",
          syncVersion: 50,
          availableBalance: 1000,
          qrTokenHash: "",
          faceDeviceUserId: "",
        }),
      ],
      mealRates: [
        {
          cloudId: "mt-lunch",
          mealType: "lunch",
          rate: 500,
          parcelCharge: 0,
          isActive: true,
          syncVersion: 50,
        },
      ],
      mealTimings: [
        {
          cloudId: "mt-lunch",
          mealType: "lunch",
          startTime: "00:00",
          endTime: "23:59",
          isActive: true,
          syncVersion: 50,
        },
      ],
    }),
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: false,
    },
    async () => {
      const result = await forceFullPull({ database: db, client });
      assert.equal(result.success, true);
      assert.equal(result.pull.employeesReceived, 1);
      assert.ok(result.pull.employeesRemoved >= 1);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS c FROM employees WHERE employee_code = 'STALE01'").get().c,
        0
      );
      const kept = db.prepare("SELECT * FROM employees WHERE employee_code = 'KEEP01'").get();
      assert.equal(kept.name, "Keep From Cloud");
      assert.equal(kept.cloud_id, "cloud-keep");
    }
  );
});

test("reset demo data clears transactions, failed sync, and employees but keeps schema", () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
  const meal = processor.processMealTransaction({
    source: "qr",
    identifier: "EMP001-QR",
  });
  assert.equal(meal.success, true);

  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO sync_queue (
      entity_type, entity_id, action, payload, payload_json, status,
      attempt_count, last_error, created_at, updated_at
    ) VALUES ('meal_transaction', 'fail-1', 'create', '{}', '{}', 'failed', 3, 'EMPLOYEE_NOT_FOUND', ?, ?)
  `
  ).run(now, now);
  setSyncVersion(db, 99);

  const result = resetLocalDemoData({ database: db });
  assert.equal(result.success, true);
  assert.equal(result.localReset.employeesDeleted, 1);
  assert.equal(result.localReset.transactionsDeleted, 1);
  assert.ok(result.localReset.syncQueueDeleted >= 2);
  assert.equal(getSyncVersion(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM employees").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM transactions").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sync_queue").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM meal_rates").get().c, 0);
  // Schema tables still exist
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employees'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gateway_settings'").get());
});

test("reset + pull repopulates employees from cloud and does not push", async () => {
  const db = createTestDb();
  seedMeals(db);
  seedDemoEmployee(db);
  setSyncVersion(db, 10);

  let pushCalls = 0;
  let pullCalls = 0;
  const client = mockClient({
    pullChanges: async () => {
      pullCalls += 1;
      return {
        success: true,
        syncVersion: 77,
        employees: [
          cloudEmployee({
            cloudId: "cloud-reloaded",
            employeeCode: "RELOAD1",
            name: "Reloaded Emp",
            syncVersion: 77,
            availableBalance: 8000,
            qrTokenHash: "",
            faceDeviceUserId: "9",
          }),
        ],
        mealRates: [
          {
            cloudId: "mt-lunch",
            mealType: "lunch",
            rate: 500,
            parcelCharge: 0,
            isActive: true,
            syncVersion: 77,
          },
        ],
        mealTimings: [
          {
            cloudId: "mt-lunch",
            mealType: "lunch",
            startTime: "00:00",
            endTime: "23:59",
            isActive: true,
            syncVersion: 77,
          },
        ],
      };
    },
    pushTransactions: async () => {
      pushCalls += 1;
      return { success: true, results: [] };
    },
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: false,
    },
    async () => {
      const result = await resetAndPull({ database: db, client });
      assert.equal(result.success, true);
      assert.equal(result.pushSkipped, true);
      assert.equal(pushCalls, 0);
      assert.ok(pullCalls >= 2); // probe + force full pull
      assert.equal(result.cloudPull.employeesReceived, 1);
      assert.equal(result.cloudPull.toVersion, 77);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM employees").get().c, 1);
      assert.equal(
        db.prepare("SELECT employee_code FROM employees").get().employee_code,
        "RELOAD1"
      );
      assert.equal(getSyncVersion(db), 77);

      // Face/QR offline meal engine still works after reload
      const processor = createProcessor(db, { timeZone: "Asia/Karachi" });
      const meal = processor.processMealTransaction({
        source: "face",
        identifier: "9",
      });
      assert.equal(meal.success, true);
      const code =
        meal.employeeCode ||
        (meal.employee && meal.employee.employeeCode) ||
        null;
      assert.equal(code, "RELOAD1");
    }
  );
});

test("force full pull refuses invalid empty employee snapshot when version > 0", async () => {
  const db = createTestDb();
  seedDemoEmployee(db);
  setSyncVersion(db, 5);
  const client = mockClient({
    pullChanges: async () => ({
      success: true,
      syncVersion: 12,
      employees: [],
      mealRates: [],
      mealTimings: [],
    }),
  });

  await withSyncFlags(
    {
      cloudSyncEnabled: true,
      cloudPullEnabled: true,
      cloudPushEnabled: false,
      heartbeatEnabled: false,
    },
    async () => {
      const result = await forceFullPull({ database: db, client });
      assert.equal(result.success, false);
      assert.equal(getSyncVersion(db), 5);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM employees").get().c, 1);
    }
  );
});
