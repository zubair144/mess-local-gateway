const logger = require("../logger");
const { serveMeal } = require("./meal-service");
const employeeService = require("./employee-service");

const SOURCE_TO_METHOD = {
  face: "face",
  qr: "qr",
  manual: "manual",
};

function processMealTransaction({
  source,
  identifier,
  deviceId = null,
}) {
  const method = SOURCE_TO_METHOD[source];

  if (!method) {
    return {
      success: false,
      code: "INVALID_SOURCE",
      message: `Unknown transaction source: ${source}`,
    };
  }

  if (!identifier) {
    return {
      success: false,
      code: "IDENTIFIER_REQUIRED",
      message: "identifier is required.",
    };
  }

  const employee =
    method === "face"
      ? employeeService.findByFaceDeviceId(identifier)
      : method === "qr"
        ? employeeService.findByQrCode(identifier)
        : employeeService.findByEmployeeCode(identifier);

  if (!employee) {
    logger.info(
      "GATEWAY",
      `Employee not found for ${source} identifier: ${identifier}`
    );
  }

  const result = serveMeal({
    identifier,
    method,
    deviceId,
  });

  if (result.success) {
    logger.info("GATEWAY", "Transaction accepted");
    logger.info("SYNC", "Pending");
  } else {
    logger.info(
      "GATEWAY",
      `${result.code}: ${result.message}`
    );
  }

  return {
    ...result,
    source,
    identifier,
    employee: employee
      ? {
          id: employee.id,
          code: employee.employee_code,
          name: employee.name,
          availableBalance: employee.available_balance,
        }
      : null,
  };
}

module.exports = {
  processMealTransaction,
};
