const hardware = require("../hardware");
const config = require("../config");
const logger = require("../logger");

function registerHardwareRoutes(app) {
  app.get("/api/hardware/status", async (req, res) => {
    const status = await hardware.getHardwareStatus({
      probePrinter: true,
    });

    res.json({
      success: true,
      ...status,
      config: {
        zkAdmsPort: config.zkAdmsPort,
        printer: `${config.printerIp}:${config.printerPort}`,
        zkDevice: `${config.zkDeviceIp}:${config.zkDevicePort}`,
      },
    });
  });

  app.post("/api/printer/test", async (req, res) => {
    try {
      await hardware.printer.printTestReceipt();

      res.json({
        success: true,
        message: "Printer test successful",
      });
    } catch (err) {
      logger.error("PRINTER", err.message || err);

      res.status(500).json({
        success: false,
        message: err.message || "Printer test failed",
      });
    }
  });
}

module.exports = {
  registerHardwareRoutes,
};
