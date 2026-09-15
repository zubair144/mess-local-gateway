const statusCardsEl = document.getElementById("statusCards");
const statsGridEl = document.getElementById("statsGrid");
const lastEventEl = document.getElementById("lastEvent");
const transactionsBodyEl = document.getElementById("transactionsBody");
const syncBodyEl = document.getElementById("syncBody");
const hardwareStatusEl = document.getElementById("hardwareStatus");
const updatedAtEl = document.getElementById("updatedAt");
const noticeEl = document.getElementById("notice");
const syncNowBtn = document.getElementById("syncNowBtn");
const forceFullPullBtn = document.getElementById("forceFullPullBtn");
const retryFailedBtn = document.getElementById("retryFailedBtn");
const resetDemoBtn = document.getElementById("resetDemoBtn");
const resetAndPullBtn = document.getElementById("resetAndPullBtn");

let pollTimer = null;
let pollIntervalMs = 3000;
let syncActionRunning = false;
let cloudConfigured = false;

function statusClass(label) {
  const value = String(label || "").toUpperCase();
  if (value.includes("ONLINE") || value === "READY") {
    return "status-online";
  }
  if (value.includes("NOT CONFIGURED") || value.includes("AUTH")) {
    return "status-warn";
  }
  return "status-offline";
}

function formatRs(amount) {
  const numeric = Number(amount || 0);
  return `Rs ${numeric.toLocaleString("en-US")}`;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("en-GB", {
    hour12: true,
  });
}

function showNotice(message, type) {
  if (!noticeEl) {
    return;
  }
  noticeEl.textContent = message;
  noticeEl.classList.remove("hidden", "success", "error");
  noticeEl.classList.add(type === "success" ? "success" : "error");
}

function setSyncButtonsBusy(busy, activeId) {
  syncActionRunning = busy;
  const disable = busy || !cloudConfigured;
  syncNowBtn.disabled = disable;
  if (forceFullPullBtn) forceFullPullBtn.disabled = disable;
  retryFailedBtn.disabled = disable;
  if (resetAndPullBtn) resetAndPullBtn.disabled = disable;
  if (resetDemoBtn) resetDemoBtn.disabled = busy;

  syncNowBtn.classList.toggle("busy", busy && activeId === "syncNowBtn");
  if (forceFullPullBtn) {
    forceFullPullBtn.classList.toggle("busy", busy && activeId === "forceFullPullBtn");
  }
  retryFailedBtn.classList.toggle("busy", busy && activeId === "retryFailedBtn");
  if (resetDemoBtn) {
    resetDemoBtn.classList.toggle("busy", busy && activeId === "resetDemoBtn");
  }
  if (resetAndPullBtn) {
    resetAndPullBtn.classList.toggle("busy", busy && activeId === "resetAndPullBtn");
  }

  syncNowBtn.textContent = busy && activeId === "syncNowBtn" ? "Syncing..." : "Sync Now";
  if (forceFullPullBtn) {
    forceFullPullBtn.textContent =
      busy && activeId === "forceFullPullBtn" ? "Pulling..." : "Force Full Pull";
  }
  retryFailedBtn.textContent =
    busy && activeId === "retryFailedBtn" ? "Retrying..." : "Retry Failed";
  if (resetDemoBtn) {
    resetDemoBtn.textContent =
      busy && activeId === "resetDemoBtn" ? "Resetting..." : "Reset Local Demo Data";
  }
  if (resetAndPullBtn) {
    resetAndPullBtn.textContent =
      busy && activeId === "resetAndPullBtn"
        ? "Resetting & Pulling..."
        : "Reset & Reload From Cloud";
  }
}

function renderCloud(cloud) {
  const connection = cloud && cloud.configured
    ? cloud.online
      ? "Online"
      : "Offline"
    : "Not configured";
  document.getElementById("cloudConnection").textContent = connection;
  document.getElementById("cloudConnection").className = statusClass(
    cloud && cloud.online ? "ONLINE" : connection
  );
  document.getElementById("cloudGatewayId").textContent =
    (cloud && cloud.gatewayId) || "-";
  const pullPushEl = document.getElementById("cloudPullPush");
  if (pullPushEl) {
    const pull = cloud && cloud.pullEnabled === false ? "OFF" : "ON";
    const push = cloud && cloud.pushEnabled === false ? "OFF" : "ON";
    pullPushEl.textContent = `Pull ${pull} · Push ${push}`;
  }
  document.getElementById("cloudLastPull").textContent = formatTime(
    cloud && cloud.lastPullAt
  );
  document.getElementById("cloudLastPush").textContent = formatTime(
    cloud && cloud.lastPushAt
  );
  document.getElementById("cloudSyncVersion").textContent =
    cloud && cloud.syncVersion != null ? String(cloud.syncVersion) : "-";
  document.getElementById("cloudPending").textContent =
    cloud && cloud.pending != null ? String(cloud.pending) : "-";
  document.getElementById("cloudFailed").textContent =
    cloud && cloud.failed != null ? String(cloud.failed) : "-";
  document.getElementById("cloudLastError").textContent =
    (cloud && cloud.lastError) || "-";
}

function renderCards(cards) {
  statusCardsEl.innerHTML = Object.entries(cards || {})
    .map(
      ([key, value]) => `
      <article class="card">
        <div class="card-label">${key.replace(/([A-Z])/g, " $1")}</div>
        <div class="card-value ${statusClass(value)}">${value}</div>
      </article>
    `
    )
    .join("");
}

function renderStats(stats) {
  statsGridEl.innerHTML = [
    ["Employees", stats.employees],
    ["Today's Transactions", stats.todayTransactions],
    ["Today's Amount", formatRs(stats.todayAmount)],
    ["Pending Sync", stats.pendingSync],
    ["Failed Sync", stats.failedSync],
  ]
    .map(
      ([label, value]) => `
      <article class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
      </article>
    `
    )
    .join("");
}

function renderLastEvent(event) {
  if (!event) {
    lastEventEl.textContent = "No events yet.";
    return;
  }

  lastEventEl.innerHTML = `
    <div><strong>Employee:</strong> ${event.employeeName || "-"} (${event.employeeCode || "-"})</div>
    <div><strong>Meal:</strong> ${event.mealType || "-"}</div>
    <div><strong>Source:</strong> ${event.source || "-"}</div>
    <div><strong>Amount:</strong> ${event.amount != null ? formatRs(event.amount) : "-"}</div>
    <div><strong>Time:</strong> ${formatTime(event.at)}</div>
    <div><strong>Status:</strong> ${event.success ? "completed" : event.reason || "declined"}</div>
  `;
}

function renderTransactions(rows) {
  if (!rows || rows.length === 0) {
    transactionsBodyEl.innerHTML =
      '<tr><td colspan="6">No transactions yet.</td></tr>';
    return;
  }

  transactionsBodyEl.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${formatTime(row.transaction_time)}</td>
        <td>${row.employee_name}<br /><small>${row.employee_code}</small></td>
        <td>${row.meal_name || row.meal_type || "-"}</td>
        <td>${row.source || row.identification_method || "-"}</td>
        <td>${formatRs(row.total_amount ?? row.amount)}</td>
        <td>${row.status || "-"}</td>
      </tr>
    `
    )
    .join("");
}

function renderSync(rows) {
  if (!rows || rows.length === 0) {
    syncBodyEl.innerHTML = '<tr><td colspan="5">Queue is empty.</td></tr>';
    return;
  }

  syncBodyEl.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${formatTime(row.created_at)}</td>
        <td>${row.entity_type} #${row.entity_id}</td>
        <td>${row.action}</td>
        <td>${row.status}</td>
        <td>${row.attempt_count ?? 0}</td>
      </tr>
    `
    )
    .join("");
}

async function loadDashboard() {
  const response = await fetch("/api/local/dashboard");
  const payload = await response.json();

  pollIntervalMs = payload.pollIntervalMs || 3000;
  cloudConfigured = Boolean(payload.cloud && payload.cloud.configured);
  renderCards(payload.statusCards);
  renderCloud(payload.cloud || {});
  renderStats(payload.stats);
  renderLastEvent(payload.lastEvent);
  renderTransactions(payload.recentTransactions);
  renderSync(payload.pendingSync);
  hardwareStatusEl.textContent = JSON.stringify(payload.hardware, null, 2);
  updatedAtEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  if (!syncActionRunning) {
    syncNowBtn.disabled = !cloudConfigured;
    retryFailedBtn.disabled = !cloudConfigured;
    syncNowBtn.title = cloudConfigured
      ? "Pull master data and push pending transactions"
      : "Cloud sync not configured";
    retryFailedBtn.title = cloudConfigured
      ? "Retry failed uploads"
      : "Cloud sync not configured";
  }
}

function schedulePoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  pollTimer = setInterval(() => {
    loadDashboard().catch(() => {});
  }, pollIntervalMs);
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  loadDashboard().catch((err) => {
    updatedAtEl.textContent = err.message;
  });
});

document.getElementById("testPrinterBtn").addEventListener("click", async () => {
  const response = await fetch("/api/printer/test", { method: "POST" });
  const payload = await response.json();
  updatedAtEl.textContent = payload.message || "Printer test requested";
});

async function runSyncAction(buttonId, url, successMessage, options = {}) {
  if (syncActionRunning) {
    return;
  }
  if (!options.allowOffline && !cloudConfigured) {
    return;
  }

  setSyncButtonsBusy(true, buttonId);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body || {}),
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) {
      showNotice(
        payload.message ||
          payload.push?.error ||
          payload.pull?.error ||
          payload.cloudPull?.error ||
          "Request failed",
        "error"
      );
    } else {
      const detail =
        typeof options.formatSuccess === "function"
          ? options.formatSuccess(payload)
          : successMessage;
      showNotice(detail, "success");
    }
    await loadDashboard();
  } catch (err) {
    showNotice(err.message || "Request failed", "error");
  } finally {
    setSyncButtonsBusy(false);
    await loadDashboard().catch(() => {});
  }
}

syncNowBtn.addEventListener("click", () => {
  runSyncAction("syncNowBtn", "/api/local/sync/now", "Cloud sync completed.");
});

if (forceFullPullBtn) {
  forceFullPullBtn.addEventListener("click", () => {
    if (
      !window.confirm(
        "Force Full Pull re-downloads cloud master data and removes local master rows that are not in the cloud snapshot. Local meal/attendance history is kept. Continue?"
      )
    ) {
      return;
    }
    runSyncAction(
      "forceFullPullBtn",
      "/api/local/sync/force-full-pull",
      "Force full pull completed.",
      {
        formatSuccess: (payload) => {
          const p = payload.pull || {};
          return `Force full pull: employees ${p.employeesReceived || 0} received (${p.employeesInserted || 0} inserted, ${p.employeesRemoved || 0} removed) → version ${p.toVersion || payload.newVersion || "?"}.`;
        },
      }
    );
  });
}

retryFailedBtn.addEventListener("click", () => {
  runSyncAction(
    "retryFailedBtn",
    "/api/local/sync/retry-failed",
    "Failed uploads queued for retry."
  );
});

if (resetDemoBtn) {
  resetDemoBtn.addEventListener("click", () => {
    if (
      !window.confirm(
        "Reset Local Demo Data will DELETE local employees, meal rates/timings, transactions, sync queue, and failed uploads. Hardware/cloud .env settings are kept. Sync cursor resets to 0. Continue?"
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        "This cannot be undone without reloading from cloud. Type-confirm: click OK to permanently clear local business/demo data."
      )
    ) {
      return;
    }
    runSyncAction(
      "resetDemoBtn",
      "/api/local/admin/reset-demo-data",
      "Local demo data cleared.",
      {
        allowOffline: true,
        body: { confirm: true },
        formatSuccess: (payload) => {
          const r = payload.localReset || {};
          return `Reset complete: ${r.employeesDeleted || 0} employees, ${r.transactionsDeleted || 0} transactions, ${r.syncQueueDeleted || 0} sync queue rows deleted. Cursor=0.`;
        },
      }
    );
  });
}

if (resetAndPullBtn) {
  resetAndPullBtn.addEventListener("click", () => {
    if (
      !window.confirm(
        "Reset & Reload From Cloud will delete local business/demo data, then Force Full Pull from the web app. Transaction push will NOT run. Continue?"
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        "Final confirmation: local SQLite business data will be wiped and replaced with the cloud master snapshot."
      )
    ) {
      return;
    }
    runSyncAction(
      "resetAndPullBtn",
      "/api/local/admin/reset-and-pull",
      "Reset and reload completed.",
      {
        body: { confirm: true },
        formatSuccess: (payload) => {
          const r = payload.localReset || {};
          const p = payload.cloudPull || {};
          return `Reset & reload: cleared ${r.employeesDeleted || 0} employees / ${r.transactionsDeleted || 0} txs; pulled ${p.employeesReceived || 0} employees → version ${p.toVersion || "?"}.`;
        },
      }
    );
  });
}

loadDashboard()
  .then(schedulePoll)
  .catch((err) => {
    updatedAtEl.textContent = err.message;
  });
