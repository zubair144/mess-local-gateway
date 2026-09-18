const { processMealTransaction } = require("../services/transaction-service");
const hardware = require("../hardware");
const logger = require("../logger");

function registerMealRoutes(app) {
  app.post("/api/meal/serve", (req, res) => {
    const { identifier, method, deviceId, timestamp } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "identifier is required.",
      });
    }

    if (!["qr", "rfid", "face", "manual", "manual-test"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be rfid, face, manual, or manual-test.",
      });
    }

    const result = processMealTransaction({
      source: method,
      identifier,
      deviceId,
      timestamp,
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
        success: Boolean(result.mealResult && result.mealResult.success),
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

  app.post("/api/meal/rfid", async (req, res) => {
    const { identifier, print = true } = req.body || {};

    if (!identifier) {
      return res.status(400).json({
        success: false,
        message: "identifier is required.",
      });
    }

    try {
      const result = await hardware.rfid.handleRfidScan(identifier, {
        skipPrint: print === false,
        verificationOnly: req.body && req.body.verificationOnly === true,
      });

      res.json({
        success: Boolean(
          (result.mealResult && result.mealResult.success) ||
          (result.verificationSession && result.verificationSession.ok)
        ),
        printed: Boolean(result.printed),
        ...result,
      });
    } catch (err) {
      logger.error("RFID", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "RFID meal processing failed",
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
      const result = await hardware.rfid.handleRfidScan(identifier, {
        skipPrint: print === false,
      });

      res.json({
        success: Boolean(result.mealResult && result.mealResult.success),
        printed: Boolean(result.printed),
        ...result,
      });
    } catch (err) {
      logger.error("RFID", err.message || err);
      res.status(500).json({
        success: false,
        message: err.message || "RFID meal processing failed",
      });
    }
  });
}

module.exports = {
  registerMealRoutes,
};
