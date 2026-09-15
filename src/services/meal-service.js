const defaultDb = require("../db/database");
const config = require("../config");
const mealConfig = require("./meal-config.service");
const { processMealTransaction } = require("./meal-transaction.service");
const { getTimeContext } = require("../utils/time");

function getCurrentMeal(date = new Date(), database = defaultDb) {
  const time = getTimeContext(date, config.timezone);
  const forceMealType =
    config.nodeEnv !== "production" ? config.devForceMeal : "";

  return mealConfig.getCurrentMeal(database, time.timeHm, { forceMealType });
}

function serveMeal({ identifier, method, deviceId = null, timestamp } = {}) {
  return processMealTransaction({
    source: method,
    identifier,
    deviceId,
    timestamp,
  });
}

module.exports = {
  serveMeal,
  getCurrentMeal,
};
