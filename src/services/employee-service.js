const db = require("../db/database");

const EMPLOYEE_COLUMNS = `
  id,
  cloud_id,
  employee_code,
  name,
  department_id,
  qr_code,
  face_device_user_id,
  is_active,
  active,
  mess_eligible,
  monthly_allowance,
  available_balance,
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

function findByQrCode(code, database = db) {
  const identifier = normalizeIdentifier(code);
  if (!identifier) {
    return null;
  }

  const row = database
    .prepare(
      `
      SELECT ${EMPLOYEE_COLUMNS}
      FROM employees
      WHERE qr_code = ?
    `
    )
    .get(identifier);

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
    employeeCode: employee.employee_code,
    name: employee.name,
    departmentId: employee.department_id,
    qrCode: employee.qr_code,
    faceDeviceUserId: employee.face_device_user_id,
    isActive: Boolean(employee.isActive ?? employee.is_active),
    messEligible: Boolean(employee.messEligible ?? employee.mess_eligible),
    monthlyAllowance: Number(employee.monthly_allowance || 0),
    availableBalance: Number(employee.available_balance || 0),
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
