const crypto = require("crypto");
const employeeService = require("./employee-service");
const { normalizeRfidUid } = require("../utils/rfid");

const SESSION_TTL_MS = 45_000;
const sessions = new Map();
let armedUntil = 0;
let armedTerminalId = "";

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session || session.consumed || session.expiresAt <= now) {
      sessions.delete(id);
    }
  }
}

function resolveEmployeeByIdentity({ type, identifier, database } = {}) {
  const method = String(type || "").trim().toLowerCase();
  const raw = String(identifier || "").trim();
  if (!method || !raw) {
    return { ok: false, reason: "IDENTIFIER_REQUIRED", message: "identifier is required." };
  }

  const lookupId = method === "rfid" ? normalizeRfidUid(raw) : raw;
  const employee = employeeService.findByIdentifier(lookupId, method, database);

  if (!employee) {
    return {
      ok: false,
      reason: method === "rfid" ? "RFID_INVALID" : "EMPLOYEE_NOT_FOUND",
      message:
        method === "rfid"
          ? "RFID card is not registered with an employee."
          : "Employee not found.",
    };
  }

  if (!employee.isActive) {
    return {
      ok: false,
      reason: "EMPLOYEE_INACTIVE",
      message: "Employee is inactive.",
      employee: employeeService.toPublicEmployee(employee),
    };
  }

  if (!employee.messEligible) {
    return {
      ok: false,
      reason: "MESS_NOT_ELIGIBLE",
      message: "Employee is not eligible for mess services.",
      employee: employeeService.toPublicEmployee(employee),
    };
  }

  return {
    ok: true,
    employee,
    publicEmployee: employeeService.toPublicEmployee(employee),
    source: method,
    identifier: lookupId,
  };
}

function armVerification({ terminalId, ttlMs } = {}) {
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 60_000;
  armedUntil = Date.now() + ttl;
  armedTerminalId = String(terminalId || "pos");
  return {
    armed: true,
    terminalId: armedTerminalId,
    expiresAt: new Date(armedUntil).toISOString(),
  };
}

function disarmVerification() {
  armedUntil = 0;
  armedTerminalId = "";
  return { armed: false };
}

function isVerificationArmed() {
  return Date.now() < armedUntil;
}

function createVerificationSession({ source, identifier, deviceId, database } = {}) {
  pruneSessions();
  const resolved = resolveEmployeeByIdentity({
    type: source,
    identifier,
    database,
  });
  if (!resolved.ok) {
    return resolved;
  }

  const verificationSessionId = crypto.randomUUID();
  const now = Date.now();
  const session = {
    verificationSessionId,
    employeeId: resolved.employee.id,
    employeeCode: resolved.employee.employee_code,
    source: String(source || "").toLowerCase(),
    identifier: resolved.identifier,
    deviceId: deviceId || null,
    terminalId: armedTerminalId || null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    consumed: false,
    employee: resolved.publicEmployee,
  };
  sessions.set(verificationSessionId, session);
  return { ok: true, ...session };
}

function getLatestPending() {
  pruneSessions();
  let latest = null;
  for (const session of sessions.values()) {
    if (session.consumed) continue;
    if (!latest || session.createdAt > latest.createdAt) latest = session;
  }
  return latest;
}

function peekSession(id) {
  pruneSessions();
  const session = sessions.get(String(id || ""));
  if (!session) {
    return { ok: false, reason: "EXPIRED", message: "Employee verification expired. Please tap the RFID card again." };
  }
  if (session.consumed || Date.now() > session.expiresAt) {
    sessions.delete(session.verificationSessionId);
    return { ok: false, reason: "EXPIRED", message: "Employee verification expired. Please tap the RFID card again." };
  }
  return { ok: true, ...session };
}

function consumeSession(id) {
  const peeked = peekSession(id);
  if (!peeked.ok) return peeked;
  peeked.consumed = true;
  sessions.set(peeked.verificationSessionId, peeked);
  disarmVerification();
  return peeked;
}

module.exports = {
  SESSION_TTL_MS,
  resolveEmployeeByIdentity,
  armVerification,
  disarmVerification,
  isVerificationArmed,
  createVerificationSession,
  getLatestPending,
  peekSession,
  consumeSession,
};
