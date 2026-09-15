const crypto = require("crypto");
const defaultDb = require("../db/database");
const logger = require("../logger");
const config = require("../config");
const employeeService = require("./employee-service");
const mealConfig = require("./meal-config.service");
const { getTimeContext } = require("../utils/time");
const {
  displayMealName,
  displaySource,
  normalizeSource,
} = require("../utils/format");

const VALID_SOURCES = new Set(["face", "qr", "manual", "manual-test"]);
const recentEvents = [];
const MAX_RECENT_EVENTS = 50;

function declined(reason, extra = {}) {
  return {
    success: false,
    status: "declined",
    reason,
    code: reason,
    message: extra.message || reason,
    ...extra,
  };
}

function declineMessage(reason, employee, meal) {
  const name = employee && employee.name ? employee.name : "Employee";

  switch (reason) {
    case "EMPLOYEE_NOT_FOUND":
      return "Employee not found.";
    case "EMPLOYEE_INACTIVE":
      return `${name} is inactive.`;
    case "MESS_NOT_ELIGIBLE":
      return `${name} is not eligible for mess service.`;
    case "NO_ACTIVE_MEAL":
      return "No meal is currently being served.";
    case "MEAL_RATE_NOT_CONFIGURED":
      return "Meal rate is not configured.";
    case "MEAL_ALREADY_TAKEN":
      return `${name} has already received ${meal ? meal.mealName : "this meal"} today.`;
    case "INSUFFICIENT_BALANCE":
      return `${name} has insufficient mess balance.`;
    default:
      return reason;
  }
}

function recordEvent(event) {
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.pop();
  }
}

function getRecentEvents() {
  return recentEvents.slice();
}

function getLastEvent() {
  return recentEvents[0] || null;
}

function lookupEmployee(database, source, identifier) {
  if (source === "face") {
    return employeeService.findByFaceDeviceId(identifier, database);
  }
  if (source === "qr") {
    return employeeService.findByQrCode(identifier, database);
  }
  return employeeService.findByEmployeeCode(identifier, database);
}

function findDuplicateMeal(database, employeeId, mealType, mealName, businessDate) {
  return database
    .prepare(
      `
      SELECT id, local_transaction_id, meal_name, meal_type, source, status
      FROM transactions
      WHERE employee_id = ?
        AND business_date = ?
        AND COALESCE(status, 'completed') = 'completed'
        AND (
          lower(COALESCE(meal_type, '')) = ?
          OR lower(meal_name) = ?
        )
      LIMIT 1
    `
    )
    .get(employeeId, businessDate, mealType, String(mealName || mealType).toLowerCase());
}

function lockEmployee(database, employeeId) {
  return employeeService.mapEmployee(
    database
      .prepare(
        `
        SELECT *
        FROM employees
        WHERE id = ?
      `
      )
      .get(employeeId)
  );
}

function insertTransaction(database, row) {
  database
    .prepare(
      `
      INSERT INTO transactions (
        id,
        local_transaction_id,
        cloud_transaction_id,
        employee_id,
        employee_code,
        employee_name,
        meal_id,
        meal_name,
        meal_type,
        meal_rate,
        parcel_charge,
        total_amount,
        amount,
        previous_balance,
        new_balance,
        balance_before,
        balance_after,
        identification_method,
        source,
        identifier,
        device_id,
        transaction_time,
        business_date,
        status,
        sync_status,
        print_status,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `
    )
    .run(
      row.id,
      row.localTransactionId,
      null,
      row.employeeId,
      row.employeeCode,
      row.employeeName,
      row.mealId,
      row.mealName,
      row.mealType,
      row.mealRate,
      row.parcelCharge,
      row.totalAmount,
      row.totalAmount,
      row.balanceBefore,
      row.balanceAfter,
      row.balanceBefore,
      row.balanceAfter,
      row.source,
      row.source,
      row.identifier,
      row.deviceId,
      row.transactionTime,
      row.businessDate,
      "completed",
      "pending",
      "pending",
      row.createdAt
    );
}

function insertLedger(database, row) {
  database
    .prepare(
      `
      INSERT INTO employee_ledger (
        id,
        transaction_id,
        employee_id,
        entry_type,
        amount,
        balance_before,
        balance_after,
        description,
        created_at,
        sync_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `
    )
    .run(
      row.id,
      row.transactionId,
      row.employeeId,
      row.entryType,
      row.amount,
      row.balanceBefore,
      row.balanceAfter,
      row.description,
      row.createdAt
    );
}

function insertSyncQueue(database, row) {
  database
    .prepare(
      `
      INSERT INTO sync_queue (
        entity_type,
        entity_id,
        action,
        payload,
        payload_json,
        status,
        retry_count,
        attempt_count,
        last_attempt_at,
        next_attempt_at,
        created_at,
        updated_at
      ) VALUES (
        'meal_transaction',
        ?,
        'create',
        ?,
        ?,
        'pending',
        0,
        0,
        NULL,
        ?,
        ?,
        ?
      )
    `
    )
    .run(row.entityId, row.payload, row.payload, row.createdAt, row.createdAt, row.createdAt);
}

function updateEmployeeBalance(database, employeeId, newBalance, updatedAt, totalAmount) {
  const result = database
    .prepare(
      `
      UPDATE employees
      SET
        available_balance = ?,
        updated_at = ?,
        is_active = COALESCE(is_active, active, 1),
        active = COALESCE(is_active, active, 1)
      WHERE id = ?
        AND available_balance >= ?
    `
    )
    .run(newBalance, updatedAt, employeeId, totalAmount);

  return result.changes === 1;
}

function resolveForceMealType(options, source) {
  const requested = String(options.mealType || "").trim().toLowerCase();
  if (requested && (source === "manual" || options.allowMealOverride)) {
    return requested;
  }

  if (config.nodeEnv !== "production" && config.devForceMeal) {
    return config.devForceMeal;
  }

  return "";
}

function createProcessor(database, processorOptions = {}) {
  const timeZone = processorOptions.timeZone || config.timezone;
  const log = processorOptions.logger || logger;

  function logDecline(result, identifier) {
    log.info("TRANSACTION", "DECLINED");
    log.info(
      "TRANSACTION",
      (result.employee && result.employee.employeeCode) || identifier || "-"
    );
    log.info("TRANSACTION", result.reason);
  }

  function processMealTransaction(input = {}) {
    const rawSource = String(input.source || "").trim().toLowerCase();
    const source = normalizeSource(rawSource);
    const identifier = String(input.identifier || "").trim();
    const timestamp = input.timestamp;
    const deviceId = input.deviceId || null;

    if (!VALID_SOURCES.has(rawSource) && !VALID_SOURCES.has(source)) {
      return declined("INVALID_SOURCE", {
        message: `Unknown transaction source: ${input.source}`,
      });
    }

    if (!identifier) {
      return declined("IDENTIFIER_REQUIRED", {
        message: "identifier is required.",
      });
    }

    const time = getTimeContext(timestamp, timeZone);
    const forceMealType = resolveForceMealType(input, source);

    const execute = database.transaction(() => {
      const employee = lookupEmployee(database, source, identifier);

      if (!employee) {
        return declined("EMPLOYEE_NOT_FOUND", {
          message: declineMessage("EMPLOYEE_NOT_FOUND"),
          identifier,
          source,
        });
      }

      if (!employee.isActive) {
        return declined("EMPLOYEE_INACTIVE", {
          message: declineMessage("EMPLOYEE_INACTIVE", employee),
          employee: employeeService.toPublicEmployee(employee),
          source,
        });
      }

      if (!employee.messEligible) {
        return declined("MESS_NOT_ELIGIBLE", {
          message: declineMessage("MESS_NOT_ELIGIBLE", employee),
          employee: employeeService.toPublicEmployee(employee),
          source,
        });
      }

      const meal = mealConfig.getCurrentMeal(database, time.timeHm, {
        forceMealType,
      });

      if (!meal) {
        return declined("NO_ACTIVE_MEAL", {
          message: declineMessage("NO_ACTIVE_MEAL"),
          employee: employeeService.toPublicEmployee(employee),
          source,
        });
      }

      if (!meal.rateConfigured || meal.rate === null || meal.rate === undefined) {
        return declined("MEAL_RATE_NOT_CONFIGURED", {
          message: declineMessage("MEAL_RATE_NOT_CONFIGURED"),
          employee: employeeService.toPublicEmployee(employee),
          meal: {
            type: meal.mealType,
            name: meal.mealName,
          },
          source,
        });
      }

      const mealRate = Number(meal.rate || 0);
      const parcelCharge = Number(meal.parcelCharge || 0);
      const totalAmount = mealRate + parcelCharge;

      const duplicate = findDuplicateMeal(
        database,
        employee.id,
        meal.mealType,
        meal.mealName,
        time.operationalDate
      );

      if (duplicate) {
        return declined("MEAL_ALREADY_TAKEN", {
          message: declineMessage("MEAL_ALREADY_TAKEN", employee, meal),
          employee: employeeService.toPublicEmployee(employee),
          meal: {
            type: meal.mealType,
            name: meal.mealName,
            amount: totalAmount,
          },
          existingTransactionId:
            duplicate.local_transaction_id || duplicate.id,
          source,
        });
      }

      const lockedEmployee = lockEmployee(database, employee.id);
      const balanceBefore = Number(
        lockedEmployee && lockedEmployee.available_balance
      );

      if (!Number.isFinite(balanceBefore) || balanceBefore < totalAmount) {
        return declined("INSUFFICIENT_BALANCE", {
          message: declineMessage("INSUFFICIENT_BALANCE", employee),
          employee: employeeService.toPublicEmployee(lockedEmployee || employee),
          currentBalance: Number.isFinite(balanceBefore) ? balanceBefore : 0,
          requiredAmount: totalAmount,
          meal: {
            type: meal.mealType,
            name: meal.mealName,
            amount: totalAmount,
          },
          source,
        });
      }

      const balanceAfter = Number((balanceBefore - totalAmount).toFixed(2));
      if (balanceAfter < 0) {
        return declined("INSUFFICIENT_BALANCE", {
          message: declineMessage("INSUFFICIENT_BALANCE", employee),
          employee: employeeService.toPublicEmployee(lockedEmployee || employee),
          currentBalance: balanceBefore,
          requiredAmount: totalAmount,
          source,
        });
      }

      const localTransactionId = crypto.randomUUID();
      const ledgerId = crypto.randomUUID();
      const createdAt = time.iso;

      log.info("TRANSACTION", "Processing");
      log.info("TRANSACTION", `Employee: ${employee.employee_code}`);
      log.info("TRANSACTION", `Meal: ${meal.mealName}`);
      log.info("TRANSACTION", `Source: ${source}`);

      insertTransaction(database, {
        id: localTransactionId,
        localTransactionId,
        employeeId: employee.id,
        employeeCode: employee.employee_code,
        employeeName: employee.name,
        mealId: meal.id,
        mealName: meal.mealName,
        mealType: meal.mealType,
        mealRate,
        parcelCharge,
        totalAmount,
        balanceBefore,
        balanceAfter,
        source,
        identifier,
        deviceId,
        transactionTime: createdAt,
        businessDate: time.operationalDate,
        createdAt,
      });

      insertLedger(database, {
        id: ledgerId,
        transactionId: localTransactionId,
        employeeId: employee.id,
        entryType: "meal",
        amount: -totalAmount,
        balanceBefore,
        balanceAfter,
        description: `${meal.mealName} buffet`,
        createdAt,
      });

      const balanceUpdated = updateEmployeeBalance(
        database,
        employee.id,
        balanceAfter,
        createdAt,
        totalAmount
      );

      if (!balanceUpdated) {
        throw new Error("BALANCE_UPDATE_FAILED");
      }

      const payload = {
        localTransactionId,
        cloudTransactionId: null,
        employeeId: employee.id,
        employeeCloudId: employee.cloud_id || null,
        employeeCode: employee.employee_code,
        employeeName: employee.name,
        source,
        identifier,
        deviceId,
        mealType: meal.mealType,
        mealName: meal.mealName,
        mealRate,
        parcelCharge,
        totalAmount,
        balanceBefore,
        balanceAfter,
        transactionTime: createdAt,
        businessDate: time.operationalDate,
        timezone: timeZone,
        status: "completed",
        printStatus: "pending",
      };

      insertSyncQueue(database, {
        entityId: localTransactionId,
        payload: JSON.stringify(payload),
        createdAt,
      });

      return {
        success: true,
        status: "completed",
        code: "MEAL_SERVED",
        localTransactionId,
        printStatus: "pending",
        employee: {
          id: employee.id,
          employeeCode: employee.employee_code,
          name: employee.name,
        },
        meal: {
          type: meal.mealType,
          name: meal.mealName,
          amount: totalAmount,
          rate: mealRate,
          parcelCharge,
        },
        balanceBefore,
        balanceAfter,
        source,
        identifier,
        deviceId,
        transactionTime: createdAt,
        businessDate: time.operationalDate,
        timezone: timeZone,
      };
    });

    let result;

    try {
      result = execute.immediate();
    } catch (error) {
      const message = String(error && error.message ? error.message : error);

      if (message.includes("idx_employee_meal_date")) {
        result = declined("MEAL_ALREADY_TAKEN", {
          message: "This meal has already been taken today.",
          source,
          identifier,
        });
      } else {
        log.error("TRANSACTION", message);
        result = declined("TRANSACTION_FAILED", {
          message: "Could not complete local transaction.",
          source,
          identifier,
        });
      }
    }

    const event = {
      at: time.iso,
      source,
      identifier,
      success: Boolean(result.success),
      status: result.status,
      reason: result.reason || null,
      employeeName: result.employee ? result.employee.name : null,
      employeeCode: result.employee ? result.employee.employeeCode : null,
      mealType: result.meal ? result.meal.type : null,
      amount: result.meal ? result.meal.amount : null,
      localTransactionId: result.localTransactionId || null,
    };
    recordEvent(event);

    if (result.success) {
      log.info("TRANSACTION", "Completed");
      log.info("TRANSACTION", `TXN: ${result.localTransactionId}`);
      log.info("TRANSACTION", `Before: ${result.balanceBefore}`);
      log.info("TRANSACTION", `After: ${result.balanceAfter}`);
      return result;
    }

    logDecline(result, identifier);
    return result;
  }

  function updatePrintStatus(localTransactionId, printStatus) {
    if (!localTransactionId) {
      return;
    }

    database
      .prepare(
        `
        UPDATE transactions
        SET print_status = ?
        WHERE id = ?
           OR local_transaction_id = ?
      `
      )
      .run(printStatus, localTransactionId, localTransactionId);
  }

  function getReceiptData(result) {
    if (!result || !result.success) {
      return null;
    }

    return {
      employeeName: result.employee.name,
      employeeCode: result.employee.employeeCode,
      mealName: displayMealName(result.meal.type),
      amount: result.meal.amount,
      balanceAfter: result.balanceAfter,
      source: displaySource(result.source),
      dateTime: result.transactionTime,
      localTransactionId: result.localTransactionId,
    };
  }

  return {
    processMealTransaction,
    updatePrintStatus,
    getReceiptData,
    getLastEvent,
    getRecentEvents,
  };
}

const defaultProcessor = createProcessor(defaultDb);

module.exports = {
  createProcessor,
  processMealTransaction: (input) =>
    defaultProcessor.processMealTransaction(input),
  updatePrintStatus: (id, status) => defaultProcessor.updatePrintStatus(id, status),
  getReceiptData: (result) => defaultProcessor.getReceiptData(result),
  getLastEvent: () => defaultProcessor.getLastEvent(),
  getRecentEvents: () => defaultProcessor.getRecentEvents(),
  declined,
};
