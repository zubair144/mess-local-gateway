const db = require("../db/database");

function findByFaceDeviceId(id) {
  if (id === undefined || id === null || String(id).trim() === "") {
    return null;
  }

  return db
    .prepare(
      `
      SELECT *
      FROM employees
      WHERE face_device_user_id = ?
      AND active = 1
    `
    )
    .get(String(id).trim());
}

function findByQrCode(code) {
  if (!code) {
    return null;
  }

  return db
    .prepare(
      `
      SELECT *
      FROM employees
      WHERE qr_code = ?
      AND active = 1
    `
    )
    .get(String(code).trim());
}

function findByEmployeeCode(code) {
  if (!code) {
    return null;
  }

  return db
    .prepare(
      `
      SELECT *
      FROM employees
      WHERE employee_code = ?
      AND active = 1
    `
    )
    .get(String(code).trim());
}

function findByIdentifier(identifier, method) {
  if (method === "qr") {
    return findByQrCode(identifier);
  }

  if (method === "face") {
    return findByFaceDeviceId(identifier);
  }

  if (method === "manual") {
    return findByEmployeeCode(identifier);
  }

  return null;
}

module.exports = {
  findByFaceDeviceId,
  findByQrCode,
  findByEmployeeCode,
  findByIdentifier,
};
