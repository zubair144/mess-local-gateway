const { registerStatusRoutes } = require("./status.routes");
const { registerHardwareRoutes } = require("./hardware.routes");
const { registerMealRoutes } = require("./meal.routes");
const { registerGatewayRoutes } = require("./gateway.routes");

function registerRoutes(app) {
  registerStatusRoutes(app);
  registerHardwareRoutes(app);
  registerMealRoutes(app);
  registerGatewayRoutes(app);
}

module.exports = {
  registerRoutes,
};
