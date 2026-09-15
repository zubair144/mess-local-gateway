const { registerStatusRoutes } = require("./status.routes");
const { registerHardwareRoutes } = require("./hardware.routes");
const { registerMealRoutes } = require("./meal.routes");
const { registerGatewayRoutes } = require("./gateway.routes");
const { registerLocalRoutes } = require("./local.routes");
const { registerDashboardRoutes } = require("./dashboard.routes");

function registerRoutes(app) {
  registerStatusRoutes(app);
  registerHardwareRoutes(app);
  registerMealRoutes(app);
  registerLocalRoutes(app);
  registerGatewayRoutes(app);
  registerDashboardRoutes(app);
}

module.exports = {
  registerRoutes,
};
