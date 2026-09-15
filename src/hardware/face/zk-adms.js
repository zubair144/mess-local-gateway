const express = require("express");
const logger = require("../../logger");

function parseAttendanceBody(body) {
  if (!body) {
    logger.warn("FACE", "Attendance body empty");
    return [];
  }

  const lines = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];

  for (const line of lines) {
    logger.debug("FACE", `Raw attendance line: ${line}`);

    const parts = line.split(/\t+/);

    logger.debug("FACE", `Parsed fields: ${JSON.stringify(parts)}`);

    const userId = String(parts[0] || "").trim();
    const dateTime = String(parts[1] || "").trim();
    const status = String(parts[2] || "").trim();
    const verifyMode = String(parts[3] || "").trim();
    const workCode = String(parts[4] || "").trim();

    events.push({
      userId,
      dateTime,
      status,
      verifyMode,
      workCode,
      rawLine: line,
    });
  }

  return events;
}

function createAdmsApp({ onAttendance }) {
  const app = express();

  app.use(
    express.text({
      type: "*/*",
      limit: "5mb",
    })
  );

  app.use((req, res, next) => {
    const isNoisy =
      req.path === "/iclock/getrequest" || req.path === "/iclock/ping";

    if (isNoisy) {
      logger.debug("ZKTECO", `${req.method} ${req.originalUrl}`);
    } else {
      logger.info("ZKTECO", `${req.method} ${req.originalUrl}`);
      if (req.query && Object.keys(req.query).length) {
        logger.debug("ZKTECO", `Query: ${JSON.stringify(req.query)}`);
      }
    }

    next();
  });

  app.get("/", (req, res) => {
    res.type("text/plain").send("ZKTeco ADMS server is running");
  });

  app.get("/iclock/cdata", (req, res) => {
    const serialNumber = req.query.SN || "UNKNOWN";

    logger.info("ZKTECO", `Device connected SN=${serialNumber}`);

    const response =
      `GET OPTION FROM: ${serialNumber}\n` +
      `Stamp=9999\n` +
      `OpStamp=9999\n` +
      `PhotoStamp=9999\n` +
      `ErrorDelay=30\n` +
      `Delay=10\n` +
      `TransTimes=00:00;14:05\n` +
      `TransInterval=1\n` +
      `TransFlag=1111000000\n` +
      `Realtime=1\n` +
      `Encrypt=0\n`;

    res.type("text/plain").send(response);
  });

  app.post("/iclock/cdata", async (req, res) => {
    const table = String(req.query.table || "").toUpperCase();
    const serialNumber = req.query.SN || "UNKNOWN";

    res.type("text/plain").send("OK");

    if (table !== "ATTLOG") {
      logger.debug("ZKTECO", `POST /iclock/cdata table=${table || "(none)"}`);
      return;
    }

    logger.info("FACE", "Event received");
    logger.debug("ZKTECO", `Device SN: ${serialNumber}`);

    try {
      const events = parseAttendanceBody(req.body);

      for (const event of events) {
        await onAttendance({
          ...event,
          serialNumber,
        });
      }
    } catch (err) {
      logger.error("ZKTECO", err.message || err);
    }
  });

  app.post("/iclock/cdata/:type", (req, res) => {
    logger.debug("ZKTECO", `Additional cdata type=${req.params.type}`);
    res.type("text/plain").send("OK");
  });

  app.get("/iclock/getrequest", (req, res) => {
    res.type("text/plain").send("OK");
  });

  app.post("/iclock/devicecmd", (req, res) => {
    logger.debug("ZKTECO", "Device command response received");
    res.type("text/plain").send("OK");
  });

  app.get("/iclock/ping", (req, res) => {
    res.type("text/plain").send("OK");
  });

  app.use((req, res) => {
    logger.debug("ZKTECO", `Unknown endpoint ${req.method} ${req.originalUrl}`);
    res.type("text/plain").send("OK");
  });

  return app;
}

function startAdmsServer({ port, host, onAttendance }) {
  const app = createAdmsApp({ onAttendance });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      logger.info("ZKTECO", `ADMS listening on ${host}:${port}`);
      resolve(server);
    });

    server.on("error", reject);
  });
}

module.exports = {
  parseAttendanceBody,
  createAdmsApp,
  startAdmsServer,
};
