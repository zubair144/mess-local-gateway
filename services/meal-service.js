const crypto = require("crypto");
const db = require("../db/database");

function getCurrentTime() {
  return new Date();
}

function formatTime(date) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatDate(date) {
  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isTimeBetween(current, start, end) {

  // Normal range, e.g. 06:00 - 10:00
  if (start <= end) {
    return current >= start && current <= end;
  }

  // Overnight range, e.g. 22:00 - 02:00
  return current >= start || current <= end;
}

function getCurrentMeal(date = new Date()) {

  const currentTime = formatTime(date);

  const meals = db.prepare(`
    SELECT *
    FROM meal_settings
    WHERE active = 1
  `).all();

  for (const meal of meals) {

    if (
      isTimeBetween(
        currentTime,
        meal.start_time,
        meal.end_time
      )
    ) {
      return meal;
    }
  }

  return null;
}

function findEmployee(identifier, method) {

  if (method === "qr") {

    return db.prepare(`
      SELECT *
      FROM employees
      WHERE qr_code = ?
      AND active = 1
    `).get(identifier);

  }

  if (method === "face") {

    return db.prepare(`
      SELECT *
      FROM employees
      WHERE face_device_user_id = ?
      AND active = 1
    `).get(String(identifier));

  }

  if (method === "manual") {

    return db.prepare(`
      SELECT *
      FROM employees
      WHERE employee_code = ?
      AND active = 1
    `).get(identifier);

  }

  return null;
}

function serveMeal({
  identifier,
  method,
  deviceId = null
}) {

  const now = getCurrentTime();

  const businessDate = formatDate(now);

  const transactionTime =
    now.toISOString();

  /*
  |--------------------------------------------------------------------------
  | Find Employee
  |--------------------------------------------------------------------------
  */

  const employee =
    findEmployee(identifier, method);

  if (!employee) {

    return {
      success: false,
      code: "EMPLOYEE_NOT_FOUND",
      message: "Employee not found."
    };

  }

  /*
  |--------------------------------------------------------------------------
  | Check Mess Eligibility
  |--------------------------------------------------------------------------
  */

  if (!employee.mess_eligible) {

    return {
      success: false,
      code: "MESS_NOT_ELIGIBLE",
      message:
        `${employee.name} is not eligible for mess service.`
    };

  }

  /*
  |--------------------------------------------------------------------------
  | Find Current Meal
  |--------------------------------------------------------------------------
  */

  const meal =
    getCurrentMeal(now);

  if (!meal) {

    return {
      success: false,
      code: "NO_ACTIVE_MEAL",
      message:
        "No meal is currently being served."
    };

  }

  /*
  |--------------------------------------------------------------------------
  | Check Duplicate
  |--------------------------------------------------------------------------
  */

  const existingTransaction =
    db.prepare(`
      SELECT *
      FROM transactions
      WHERE employee_id = ?
      AND meal_name = ?
      AND business_date = ?
    `).get(
      employee.id,
      meal.meal_name,
      businessDate
    );

  if (existingTransaction) {

    return {
      success: false,
      code: "ALREADY_SERVED",
      message:
        `${employee.name} has already received ${meal.meal_name} today.`,
      transaction:
        existingTransaction
    };

  }

  const mealRate =
    Number(meal.rate || 0);

  const currentBalance =
    Number(employee.available_balance || 0);

  /*
  |--------------------------------------------------------------------------
  | Check Balance
  |--------------------------------------------------------------------------
  */

  if (currentBalance < mealRate) {

    return {
      success: false,
      code: "INSUFFICIENT_BALANCE",
      message:
        `${employee.name} has insufficient mess balance.`,
      availableBalance:
        currentBalance,
      required:
        mealRate
    };

  }

  const newBalance =
    currentBalance - mealRate;

  const transactionId =
    crypto.randomUUID();

  /*
  |--------------------------------------------------------------------------
  | SQLite Atomic Transaction
  |--------------------------------------------------------------------------
  */

  const executeTransaction =
    db.transaction(() => {

      /*
      | Deduct Employee Balance
      */

      const updateResult =
        db.prepare(`
          UPDATE employees

          SET
            available_balance = ?,
            updated_at = ?

          WHERE id = ?
          AND available_balance >= ?
        `).run(
          newBalance,
          transactionTime,
          employee.id,
          mealRate
        );

      if (
        updateResult.changes !== 1
      ) {

        throw new Error(
          "BALANCE_UPDATE_FAILED"
        );

      }

      /*
      | Create Transaction
      */

      db.prepare(`
        INSERT INTO transactions (

          id,

          employee_id,
          employee_code,
          employee_name,

          meal_id,
          meal_name,

          amount,

          previous_balance,
          new_balance,

          identification_method,
          identifier,

          device_id,

          transaction_time,
          business_date,

          sync_status

        )

        VALUES (
          ?, ?, ?, ?,
          ?, ?,
          ?,
          ?, ?,
          ?, ?,
          ?,
          ?, ?,
          'pending'
        )
      `).run(

        transactionId,

        employee.id,
        employee.employee_code,
        employee.name,

        meal.id,
        meal.meal_name,

        mealRate,

        currentBalance,
        newBalance,

        method,
        identifier,

        deviceId,

        transactionTime,
        businessDate

      );

      /*
      | Add To Sync Queue
      */

      const payload = {

        transactionId,

        employeeId:
          employee.id,

        employeeCode:
          employee.employee_code,

        employeeName:
          employee.name,

        mealId:
          meal.id,

        mealName:
          meal.meal_name,

        amount:
          mealRate,

        previousBalance:
          currentBalance,

        newBalance,

        identificationMethod:
          method,

        identifier,

        deviceId,

        transactionTime,

        businessDate

      };

      db.prepare(`
        INSERT INTO sync_queue (

          entity_type,
          entity_id,
          action,
          payload,
          status

        )

        VALUES (
          'meal_transaction',
          ?,
          'create',
          ?,
          'pending'
        )
      `).run(
        transactionId,
        JSON.stringify(payload)
      );

    });

  try {

    executeTransaction();

  } catch (error) {

    if (
      String(error.message)
        .includes(
          "idx_employee_meal_date"
        )
    ) {

      return {
        success: false,
        code: "ALREADY_SERVED",
        message:
          `${employee.name} has already received ${meal.meal_name}.`
      };

    }

    console.error(
      "Meal transaction error:",
      error
    );

    return {
      success: false,
      code: "TRANSACTION_FAILED",
      message:
        "Could not complete local transaction."
    };

  }

  /*
  |--------------------------------------------------------------------------
  | Success
  |--------------------------------------------------------------------------
  */

  return {

    success: true,

    code: "MEAL_SERVED",

    message:
      `${meal.meal_name} served successfully.`,

    transaction: {

      id:
        transactionId,

      employee: {
        id:
          employee.id,

        code:
          employee.employee_code,

        name:
          employee.name
      },

      meal: {
        id:
          meal.id,

        name:
          meal.meal_name,

        rate:
          mealRate
      },

      previousBalance:
        currentBalance,

      newBalance,

      identificationMethod:
        method,

      transactionTime,

      businessDate,

      syncStatus:
        "pending"

    }

  };

}

module.exports = {
  serveMeal,
  getCurrentMeal
};