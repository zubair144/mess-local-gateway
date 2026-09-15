const mealTransaction = require("./meal-transaction.service");

function processMealTransaction(input) {
  return mealTransaction.processMealTransaction(input);
}

module.exports = {
  processMealTransaction,
  updatePrintStatus: mealTransaction.updatePrintStatus,
  getReceiptData: mealTransaction.getReceiptData,
  getLastEvent: mealTransaction.getLastEvent,
  getRecentEvents: mealTransaction.getRecentEvents,
};
