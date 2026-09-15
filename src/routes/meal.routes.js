const { serveMeal } = require("../services/meal-service");
const hardware = require("../hardware");
const logger = require("../logger");

function registerMealRoutes(app) {
  app.post("/api/meal/serve", (req, res) => {
    const { identifier, method, deviceId } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "identifier is required.",
      });
    }

    if (!["qr", "face", "manual"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be qr, face or manual.",
      });
    }

    const result = serveMeal({
      identifier,
      method,
      deviceId,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  });

  app.post("/api/meal/face", async (req, res) => {
    const { identifier, deviceId, print = true } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "identifier is required.",
      });
    }

    try {
      const result = await hardware.face.handleAttendanceEvent(
        {
          userId: identifier,
          dateTime: new Date().toLocaleString(),
          status: "0",
          verifyMode: "FACE",
          workCode: "",
          serialNumber: deviceId || "API",
        },
        { skipPrint: print === false }
      );

      res.json({
        success: true,
        printed: Boolean(result.printed),
        ...result,
      });
    } catch (err) {
      logger.error("FACE", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "Face meal processing failed",
      });
    }
  });

  app.post("/api/meal/qr", async (req, res) => {
    const { identifier, print = true } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "identifier is required.",
      });
    }

    try {
      const result = await hardware.qr.handleQrScan(identifier, {
        skipPrint: print === false,
      });

      res.json({
        success: true,
        printed: Boolean(result.printed),
        ...result,
      });
    } catch (err) {
      logger.error("QR", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "QR meal processing failed",
      });
    }
  });
}

module.exports = {
  registerMealRoutes,
};
