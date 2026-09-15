const config = require("./config");

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function currentLevel() {
  return LEVELS[config.logLevel] ?? LEVELS.info;
}

function shouldLog(level) {
  return LEVELS[level] <= currentLevel();
}

function formatMessage(subsystem, message) {
  if (message instanceof Error) {
    return message.stack || message.message;
  }
  return message;
}

function info(subsystem, message, ...args) {
  if (!shouldLog("info")) {
    return;
  }
  console.log(`[${subsystem}]`, formatMessage(subsystem, message), ...args);
}

function warn(subsystem, message, ...args) {
  if (!shouldLog("warn")) {
    return;
  }
  console.warn(`[${subsystem}]`, formatMessage(subsystem, message), ...args);
}

function debug(subsystem, message, ...args) {
  if (!shouldLog("debug")) {
    return;
  }
  console.log(`[${subsystem}]`, formatMessage(subsystem, message), ...args);
}

function error(subsystem, message, ...args) {
  const label =
    subsystem.endsWith(" ERROR") ? subsystem : `${subsystem} ERROR`;
  console.error(`[${label}]`, formatMessage(subsystem, message), ...args);
}

module.exports = {
  info,
  warn,
  debug,
  error,
};
