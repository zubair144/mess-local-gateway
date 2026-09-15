const statusCardsEl = document.getElementById("statusCards");
const statsGridEl = document.getElementById("statsGrid");
const lastEventEl = document.getElementById("lastEvent");
const transactionsBodyEl = document.getElementById("transactionsBody");
const syncBodyEl = document.getElementById("syncBody");
const hardwareStatusEl = document.getElementById("hardwareStatus");
const updatedAtEl = document.getElementById("updatedAt");

let pollTimer = null;
let pollIntervalMs = 3000;

function statusClass(label) {
  const value = String(label || "").toUpperCase();
  if (value.includes("ONLINE") || value === "READY") {
    return "status-online";
  }
  if (value.includes("NOT CONFIGURED")) {
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
  renderCards(payload.statusCards);
  renderStats(payload.stats);
  renderLastEvent(payload.lastEvent);
  renderTransactions(payload.recentTransactions);
  renderSync(payload.pendingSync);
  hardwareStatusEl.textContent = JSON.stringify(payload.hardware, null, 2);
  updatedAtEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  const syncConfigured = payload.sync && payload.sync.ready;
  document.getElementById("syncNowBtn").disabled = !syncConfigured;
  document.getElementById("retryFailedBtn").disabled = !syncConfigured;
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

loadDashboard()
  .then(schedulePoll)
  .catch((err) => {
    updatedAtEl.textContent = err.message;
  });
