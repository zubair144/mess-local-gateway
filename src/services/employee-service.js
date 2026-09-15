const db = require("../db/database");
const { hashQrToken, parseQrToken } = require("../cloud/qr-hash");

const EMPLOYEE_COLUMNS = `
  id,
  cloud_id,
  employee_code,
  name,
  department_id,
  department,
  qr_code,
  qr_token_hash,
  qr_status,
  face_device_user_id,
  face_template_id,
  is_active,
  active,
  mess_eligible,
  monthly_allowance,
  available_balance,
  cloud_balance,
  created_at,
  updated_at,
  synced_at,
  sync_version
`;

function normalizeIdentifier(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function isActiveValue(value) {
  return Number(value) === 1 || value === true;
}

function mapEmployee(row) {
  if (!row) {
    return null;
  }

  const isActive = row.is_active === null || row.is_active === undefined
    ? isActiveValue(row.active)
    : isActiveValue(row.is_active);

  return {
    ...row,
    is_active: isActive ? 1 : 0,
    active: isActive ? 1 : 0,
    mess_eligible: isActiveValue(row.mess_eligible) ? 1 : 0,
    available_balance: Number(row.available_balance || 0),
    monthly_allowance: Number(row.monthly_allowance || 0),
    cloud_balance: Number(
      row.cloud_balance == null ? row.available_balance || 0 : row.cloud_balance
    ),
    isActive,
    messEligible: isActiveValue(row.mess_eligible),
  };
}

function findByFaceDeviceId(id, database = db) {
  const identifier = normalizeIdentifier(id);
  if (!identifier) {
    return null;
  }

  const row = database
    .prepare(
      `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE face_device_user_id = ?
    `
    )
    .get(identifier);

  return mapEmployee(row);
}

function isQrStatusActive(value) {
  const status = String(value || "").trim().toUpperCase();
  return !status || status === "ACTIVE";
}

function findByQrCode(code, database = db) {
  const identifier = normalizeIdentifier(code);
  if (!identifier) {
    return null;
  }

  const token = parseQrToken(identifier);
  const hash = hashQrToken(identifier);

  if (hash) {
    const hashed = database
      .prepare(
        `
        SELECT ${EMPLOYEE_COLUMNS}
        FROM employees
        WHERE qr_token_hash = ?
      `
      )
      .get(hash);

    if (hashed) {
      if (!isQrStatusActive(hashed.qr_status)) {
        return null;
      }
      return mapEmployee(hashed);
    }
  }

  const row = database
    .prepare(
      `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE qr_code = ?
         OR qr_code = ?
    `
    )
    .get(identifier, token || identifier);

  return mapEmployee(row);
}

function findByEmployeeCode(code, database = db) {
  const identifier = normalizeIdentifier(code);
  if (!identifier) {
    return null;
  }

  const row = database
    .prepare(
      `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE employee_code = ?
    `
    )
    .get(identifier);

  return mapEmployee(row);
}

function findById(id, database = db) {
  const identifier = normalizeIdentifier(id);
  if (!identifier) {
    return null;
  }

  const row = database
    .prepare(
      `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE id = ?
    `
    )
    .get(identifier);

  return mapEmployee(row);
}

function findByIdentifier(identifier, method, database = db) {
  if (method === "qr") {
    return findByQrCode(identifier, database);
  }

  if (method === "face") {
    return findByFaceDeviceId(identifier, database);
  }

  if (method === "manual" || method === "manual-test") {
    return findByEmployeeCode(identifier, database);
  }

  return null;
}

function listEmployees({ q } = {}, database = db) {
  const search = normalizeIdentifier(q);
  const sql = search
    ? `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE employee_code LIKE ?
        OR name LIKE ?
        OR IFNULL(qr_code, '') LIKE ?
        OR IFNULL(face_device_user_id, '') LIKE ?
      ORDER BY name ASC
    `
    : `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      ORDER BY name ASC
    `;

  const params = search
    ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`]
    : [];

  return database.prepare(sql).all(...params).map(mapEmployee);
}

function toPublicEmployee(employee) {
  if (!employee) {
    return null;
  }

  return {
    id: employee.id,
    cloudId: employee.cloud_id || null,
    employeeCode: employee.employee_code,
    name: employee.name,
    departmentId: employee.department_id,
    department: employee.department || employee.department_id || "",
    qrCode: employee.qr_code,
    faceDeviceUserId: employee.face_device_user_id,
    isActive: Boolean(employee.isActive ?? employee.is_active),
    messEligible: Boolean(employee.messEligible ?? employee.mess_eligible),
    monthlyAllowance: Number(employee.monthly_allowance || 0),
    availableBalance: Number(employee.available_balance || 0),
    cloudBalance: Number(
      employee.cloud_balance == null
        ? employee.available_balance || 0
        : employee.cloud_balance
    ),
    createdAt: employee.created_at,
    updatedAt: employee.updated_at,
  };
}

module.exports = {
  findByFaceDeviceId,
  findByQrCode,
  findByEmployeeCode,
  findById,
  findByIdentifier,
  listEmployees,
  toPublicEmployee,
  mapEmployee,
};
