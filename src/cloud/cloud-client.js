const axios = require("axios");
const config = require("../config");
const logger = require("../logger");

class CloudRequestError extends Error {
  constructor({ message, status = 0, code = "", retryable = true, authFailure = false } = {}) {
    super(message || "Cloud request failed");
    this.name = "CloudRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.authFailure = authFailure;
  }
}

function normalizeBaseUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function responseMessage(error) {
  const data = error && error.response && error.response.data;
  if (!data || typeof data !== "object") {
    return "";
  }
  return data.message || data.error || data.reason || "";
}

function toCloudError(error) {
  const status = Number(error && error.response && error.response.status) || 0;
  const code = String((error && error.code) || "");
  const fromBody = responseMessage(error);
  const baseMessage = fromBody || (error && error.message) || "Cloud request failed";

  if (status === 401 || status === 403) {
    return new CloudRequestError({
      message: `Authentication failed (${status})`,
      status,
      code: "AUTH",
      retryable: false,
      authFailure: true,
    });
  }

  if (status === 400) {
    return new CloudRequestError({
      message: baseMessage,
      status,
      code: "VALIDATION",
      retryable: false,
    });
  }

  const networkCodes = new Set([
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ECONNABORTED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ]);

  if (!status && networkCodes.has(code)) {
    return new CloudRequestError({
      message: `Network error (${code})`,
      status: 0,
      code,
      retryable: true,
    });
  }

  if (status >= 500 || status === 503) {
    return new CloudRequestError({
      message: `Cloud HTTP ${status}`,
      status,
      code: "HTTP",
      retryable: true,
    });
  }

  if (status > 0) {
    return new CloudRequestError({
      message: `Cloud HTTP ${status}${fromBody ? `: ${fromBody}` : ""}`,
      status,
      code: "HTTP",
      retryable: status >= 500,
    });
  }

  return new CloudRequestError({
    message: baseMessage,
    status: 0,
    code: code || "UNKNOWN",
    retryable: true,
  });
}

function isCloudConfigured(cfg = config) {
  const syncOn =
    cfg.cloudSyncEnabled !== undefined ? cfg.cloudSyncEnabled : cfg.syncEnabled;
  return Boolean(
    syncOn &&
      String(cfg.cloudApiUrl || "").trim() &&
      String(cfg.gatewayApiKey || "").trim()
  );
}

function createCloudClient(options = {}) {
  const baseURL = normalizeBaseUrl(options.cloudApiUrl || config.cloudApiUrl);
  const gatewayId = options.gatewayId || config.gatewayId;
  const apiKey = options.gatewayApiKey || config.gatewayApiKey;
  const timeout = options.timeoutMs || config.syncRequestTimeoutMs;

  const http = axios.create({
    baseURL,
    timeout,
    headers: {
      "content-type": "application/json",
      "x-gateway-id": gatewayId,
      "x-gateway-api-key": apiKey,
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  async function request(method, url, payload) {
    const options = { method, url };
    if (method === "get") {
      options.params = payload;
    } else {
      options.data = payload;
    }

    try {
      const response = await http.request(options);
      return response.data;
    } catch (error) {
      const cloudError = toCloudError(error);
      logger.warn(
        "CLOUD",
        `${method.toUpperCase()} ${url} failed: ${cloudError.message}`
      );
      throw cloudError;
    }
  }

  async function pullChanges(since) {
    const version = Number(since) || 0;
    return request("get", "/api/gateway/sync", { since: version });
  }

  async function pushTransactions(transactions) {
    return request("post", "/api/gateway/transactions", {
      gatewayId,
      transactions,
    });
  }

  async function sendHeartbeat(status) {
    return request("post", "/api/gateway/heartbeat", {
      gatewayId,
      pendingSyncCount: Number(status.pendingSyncCount || 0) || 0,
      failedSyncCount: Number(status.failedSyncCount || 0) || 0,
      gatewayTime: status.gatewayTime || new Date().toISOString(),
      version: status.version || status.gatewayVersion || "",
    });
  }

  return {
    baseURL,
    gatewayId,
    pullChanges,
    pushTransactions,
    sendHeartbeat,
  };
}

module.exports = {
  CloudRequestError,
  createCloudClient,
  isCloudConfigured,
  toCloudError,
};
