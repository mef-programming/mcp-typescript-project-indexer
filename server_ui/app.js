const $ = (selector) => document.querySelector(selector);
const MANAGEMENT_TOKEN_STORAGE_KEY = "managedMcp.managementToken";

const state = {
  statusTimer: null,
  apiToken: sessionStorage.getItem(MANAGEMENT_TOKEN_STORAGE_KEY) || "",
  logSince: 0,
  logEvents: [],
};

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.apiToken ? { "x-api-key": state.apiToken } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value ?? "-";
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  return Number(value).toLocaleString();
}

function renderDetails(status) {
  const server = status.server || {};
  const index = status.index || {};
  const project = status.project || {};
  const details = [
    ["Server", server.name || "mcp-typescript-project-indexer"],
    ["Version", server.version || "-"],
    ["Started", server.startedAt || "-"],
    ["Project", project.root || "-"],
    ["Index", project.indexRoot || "-"],
    ["Files", formatNumber(index.fileCount)],
    ["Symbols", formatNumber(index.symbolCount)],
    ["Imports", formatNumber(index.importCount)],
    ["State", index.stateFingerprint || "-"],
  ];
  $("#detailsList").innerHTML = details
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");
}

function renderStatus(status) {
  const index = status.index || {};
  $("#statusPill").textContent = "online";
  $("#statusPill").classList.add("online");
  setText("#filesValue", formatNumber(index.fileCount));
  setText("#symbolsValue", formatNumber(index.symbolCount));
  setText("#importsValue", formatNumber(index.importCount));
  setText("#linesValue", formatNumber(index.totalLineCount));
  setText("#stateValue", (index.stateFingerprint || "").slice(0, 12));
  setText("#commandValue", status.activeCommand || "idle");
  renderDetails(status);
}

async function refreshStatus() {
  try {
    renderStatus(await requestJson("/server/management/status"));
  } catch (error) {
    $("#statusPill").textContent = "offline";
    $("#statusPill").classList.remove("online");
    setText("#commandState", error.message);
  }
}

function renderLogs() {
  $("#serverLog").textContent = state.logEvents.map((e) => {
    const ts = (e.timestamp || "").slice(11, 19);
    return `${ts}  ${e.level || "info"}  ${e.message || ""}`;
  }).join("\n");
}

async function refreshLogs() {
  try {
    const payload = await requestJson(`/server/management/log?since=${state.logSince}&limit=200`);
    state.logEvents.push(...(payload.events || []));
    state.logEvents = state.logEvents.slice(-500);
    if (payload.events && payload.events.length > 0) {
      state.logSince = payload.events[payload.events.length - 1].id || state.logSince;
    }
    renderLogs();
  } catch {}
}

async function runCommand(command) {
  setText("#commandState", `Starting ${command}...`);
  try {
    const result = await requestJson("/server/management/command", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    setText("#commandState", `${command}: ${result.status || "done"}`);
    await refreshStatus();
    await refreshLogs();
  } catch (error) {
    setText("#commandState", error.message);
  }
}

window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "managed-mcp-management-token" || typeof data.token !== "string") return;
  state.apiToken = data.token;
  sessionStorage.setItem(MANAGEMENT_TOKEN_STORAGE_KEY, data.token);
  void refreshStatus();
  void refreshLogs();
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => void runCommand(button.dataset.command));
});

$("#refreshButton").addEventListener("click", () => {
  void refreshStatus();
  void refreshLogs();
});

$("#clearLog").addEventListener("click", () => {
  state.logEvents = [];
  renderLogs();
});

function startPolling() {
  window.clearInterval(state.statusTimer);
  void refreshStatus();
  void refreshLogs();
  state.statusTimer = window.setInterval(() => {
    void refreshStatus();
    void refreshLogs();
  }, document.hidden ? 5000 : 1500);
}

document.addEventListener("visibilitychange", startPolling);
startPolling();
