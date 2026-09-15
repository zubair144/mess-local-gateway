const path = require("path");
const express = require("express");
const config = require("../config");

function registerDashboardRoutes(app) {
  const publicDir = path.join(config.projectRoot, "public");

  app.use("/gateway", express.static(publicDir));
  app.use(express.static(publicDir));

  app.get("/", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

module.exports = {
  registerDashboardRoutes,
};
