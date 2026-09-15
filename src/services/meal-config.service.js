const { isTimeBetween } = require("../utils/time");
const { displayMealName } = require("../utils/format");

function getActiveTimings(database) {
  return database
    .prepare(
      `
      SELECT *
      FROM meal_timings
      WHERE is_active = 1
      ORDER BY start_time ASC
    `
    )
    .all();
}

function getActiveRate(database, mealType) {
  if (!mealType) {
    return null;
  }

  return database
    .prepare(
      `
      SELECT *
      FROM meal_rates
      WHERE meal_type = ?
        AND is_active = 1
      ORDER BY effective_from DESC
      LIMIT 1
    `
    )
    .get(String(mealType).toLowerCase());
}

function getLegacyMeal(database, currentTimeHm) {
  const meals = database
    .prepare(
      `
      SELECT *
      FROM meal_settings
      WHERE active = 1
    `
    )
    .all();

  for (const meal of meals) {
    if (isTimeBetween(currentTimeHm, meal.start_time, meal.end_time)) {
      return {
        id: meal.id,
        mealType: String(meal.meal_name || "").trim().toLowerCase(),
        mealName: displayMealName(meal.meal_name),
        startTime: meal.start_time,
        endTime: meal.end_time,
        rate: Number(meal.rate || 0),
        parcelCharge: Number(meal.parcel_charge || 0),
      };
    }
  }

  return null;
}

function getMealByType(database, mealType) {
  const type = String(mealType || "").trim().toLowerCase();
  if (!type) {
    return null;
  }

  const timing = database
    .prepare(
      `
      SELECT *
      FROM meal_timings
      WHERE meal_type = ?
        AND is_active = 1
    `
    )
    .get(type);

  const rate = getActiveRate(database, type);

  if (!timing && !rate) {
    return null;
  }

  return {
    id: (rate && rate.id) || (timing && timing.id) || type,
    mealType: type,
    mealName: displayMealName(type),
    startTime: timing ? timing.start_time : null,
    endTime: timing ? timing.end_time : null,
    rate: rate ? Number(rate.rate || 0) : null,
    parcelCharge: rate ? Number(rate.parcel_charge || 0) : 0,
    rateConfigured: Boolean(rate),
  };
}

function getCurrentMeal(database, currentTimeHm, options = {}) {
  const forced = String(options.forceMealType || "").trim().toLowerCase();
  if (forced) {
    return getMealByType(database, forced);
  }

  const timings = getActiveTimings(database);

  if (timings.length === 0) {
    return getLegacyMeal(database, currentTimeHm);
  }

  for (const timing of timings) {
    if (isTimeBetween(currentTimeHm, timing.start_time, timing.end_time)) {
      const rate = getActiveRate(database, timing.meal_type);
      return {
        id: (rate && rate.id) || timing.id || timing.meal_type,
        mealType: timing.meal_type,
        mealName: displayMealName(timing.meal_type),
        startTime: timing.start_time,
        endTime: timing.end_time,
        rate: rate ? Number(rate.rate || 0) : null,
        parcelCharge: rate ? Number(rate.parcel_charge || 0) : 0,
        rateConfigured: Boolean(rate),
      };
    }
  }

  return null;
}

module.exports = {
  getCurrentMeal,
  getMealByType,
  getActiveRate,
  getActiveTimings,
};
