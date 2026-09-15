const crypto = require("crypto");
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "../.env"),
  quiet: true,
});

const db = require("../src/db/database");
const config = require("../src/config");
const { getTimeContext } = require("../src/utils/time");

function padTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildMealWindow(currentHm) {
  const [hourText, minuteText] = currentHm.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);

  const startMinute = Math.max(0, minute - 30);
  const endMinute = Math.min(59, minute + 30);
  const startHour = startMinute === 0 && minute < 30 ? Math.max(0, hour - 1) : hour;
  const endHour = endMinute === 59 && minute > 29 ? Math.min(23, hour + 1) : hour;

  return {
    start: padTime(startHour, startMinute),
    end: padTime(endHour, endMinute),
  };
}

function upsertEmployee(row) {
  db.prepare(
    `
    INSERT INTO employees (
      id,
      cloud_id,
      employee_code,
      name,
      department_id,
      qr_code,
      face_device_user_id,
      mess_eligible,
      monthly_allowance,
      available_balance,
      cloud_balance,
      active,
      is_active,
      created_at,
      updated_at,
      sync_version
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
    )
    ON CONFLICT(employee_code) DO UPDATE SET
      name = excluded.name,
      qr_code = excluded.qr_code,
      face_device_user_id = excluded.face_device_user_id,
      mess_eligible = excluded.mess_eligible,
      monthly_allowance = excluded.monthly_allowance,
      available_balance = excluded.available_balance,
      cloud_balance = excluded.cloud_balance,
      active = excluded.active,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at
    WHERE employees.cloud_id IS NULL OR TRIM(employees.cloud_id) = ''
  `
  ).run(
    row.id,
    row.cloudId,
    row.employeeCode,
    row.name,
    row.departmentId,
    row.qrCode,
    row.faceDeviceUserId,
    row.messEligible,
    row.monthlyAllowance,
    row.availableBalance,
    row.availableBalance,
    row.isActive,
    row.isActive,
    row.createdAt,
    row.updatedAt
  );
}

function upsertMealRate(mealType, rate, parcelCharge, updatedAt) {
  db.prepare(
    `
    INSERT INTO meal_rates (
      id, meal_type, rate, parcel_charge, is_active, effective_from, updated_at, sync_version
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 0)
    ON CONFLICT(meal_type) DO UPDATE SET
      rate = excluded.rate,
      parcel_charge = excluded.parcel_charge,
      is_active = 1,
      updated_at = excluded.updated_at
  `
  ).run(mealType, mealType, rate, parcelCharge, updatedAt, updatedAt);
}

function upsertMealTiming(mealType, startTime, endTime, updatedAt) {
  db.prepare(
    `
    INSERT INTO meal_timings (
      id, meal_type, start_time, end_time, is_active, updated_at, sync_version
    ) VALUES (?, ?, ?, ?, 1, ?, 0)
    ON CONFLICT(meal_type) DO UPDATE SET
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      is_active = 1,
      updated_at = excluded.updated_at
  `
  ).run(mealType, mealType, startTime, endTime, updatedAt);
}

function main() {
  const nowIso = new Date().toISOString();
  const time = getTimeContext(new Date(), config.timezone);
  const activeWindow = buildMealWindow(time.timeHm);

  upsertEmployee({
    id: "emp-001",
    cloudId: null,
    employeeCode: "EMP001",
    name: "Muhammad Ali",
    departmentId: "dept-ops",
    qrCode: "EMP001-QR",
    faceDeviceUserId: config.demoFaceDeviceUserId,
    messEligible: 1,
    monthlyAllowance: 15000,
    availableBalance: 15000,
    isActive: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  upsertEmployee({
    id: "emp-002",
    cloudId: null,
    employeeCode: "EMP002",
    name: "Low Balance User",
    departmentId: "dept-ops",
    qrCode: "EMP002-QR",
    faceDeviceUserId: "9999",
    messEligible: 1,
    monthlyAllowance: 15000,
    availableBalance: 200,
    isActive: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const cloudSyncVersion = Number(
    (
      db
        .prepare(
          "SELECT value FROM gateway_settings WHERE key = 'last_cloud_sync_version'"
        )
        .get() || { value: "0" }
    ).value || 0
  );

  if (cloudSyncVersion > 0) {
    console.log(
      `Skipping demo meal rates/timings because cloud sync version is ${cloudSyncVersion}.`
    );
    console.log(
      "To reset demo data: stop the gateway, delete data/mess-local.db, then run npm run db:init && npm run seed:demo"
    );
  } else {
    upsertMealRate("breakfast", 300, 0, nowIso);
    upsertMealRate("lunch", 500, 0, nowIso);
    upsertMealRate("dinner", 500, 0, nowIso);

    upsertMealTiming("breakfast", "07:00", "10:00", nowIso);
    upsertMealTiming("lunch", activeWindow.start, activeWindow.end, nowIso);
    upsertMealTiming("dinner", "19:00", "22:00", nowIso);
  }

  db.prepare(
    `
    INSERT INTO gateway_settings (key, value, updated_at)
    VALUES ('demo_seeded_at', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `
  ).run(nowIso, nowIso);

  console.log("Demo seed complete.");
  console.log(`Database: ${config.sqlitePath}`);
  console.log("Employees: EMP001 (15000), EMP002 (200)");
  console.log(`Active lunch window for testing: ${activeWindow.start} - ${activeWindow.end}`);
  console.log(`Face device user id for EMP001: ${config.demoFaceDeviceUserId}`);
  console.log("QR code for EMP001: EMP001-QR");
  console.log(
    "Demo seed never overwrites employees that already have a cloud_id."
  );
}

main();
db.closeDatabase();
