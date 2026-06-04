const $ = (selector) => document.querySelector(selector);
const MANAGEMENT_TOKEN_STORAGE_KEY = "managedMcp.managementToken";

const state = {
  statusTimer: null,
  apiToken: sessionStorage.getItem(MANAGEMENT_TOKEN_STORAGE_KEY) || "",
  logSince: 0,
  logEvents: [],
  previousProcessStats: null,
};

function initializeTokenFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token");
  if (!token) return;
  state.apiToken = token;
  sessionStorage.setItem(MANAGEMENT_TOKEN_STORAGE_KEY, token);
  history.replaceState(null, document.title, window.location.pathname);
}

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
  const number = Number(value === null || value === undefined || value === "" ? 0 : value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatMiB(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "-";
  return `${(value / 1024 / 1024).toFixed(value >= 1024 * 1024 * 100 ? 0 : 1)} MiB`;
}

function formatCpu(processStats) {
  const cores = Number(processStats.cpuCores);
  const percent = Number(processStats.cpuPercent);
  if (!Number.isFinite(cores) || !Number.isFinite(percent)) return "-";
  return `${cores.toFixed(2)}c / ${percent.toFixed(1)}%`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function pickCount(source, keys) {
  const counts = source && typeof source.counts === "object" ? source.counts : {};
  for (const key of keys) {
    const direct = Number(source && source[key]);
    if (Number.isFinite(direct)) return direct;
    const nested = Number(counts && counts[key]);
    if (Number.isFinite(nested)) return nested;
  }
  return 0;
}

function normalizeIndex(index) {
  return {
    fileCount: pickCount(index, ["fileCount", "files"]),
    symbolCount: pickCount(index, ["symbolCount", "symbols"]),
    importCount: pickCount(index, ["importCount", "imports"]),
    exportCount: pickCount(index, ["exportCount", "exports"]),
    diagnosticsCount: pickCount(index, ["diagnosticsCount", "diagnostics"]),
    totalLineCount: pickCount(index, ["totalLineCount", "lineCount", "lines"]),
    totalTokenCount: pickCount(index, ["totalTokenCount", "tokenCount", "tokens"]),
    stateFingerprint: (index && (index.stateFingerprint || index.fingerprint || index.stateHash)) || "",
  };
}

function normalizeProcess(processStats) {
  const memory = processStats && typeof processStats.memory === "object" ? processStats.memory : {};
  return {
    memoryRssMiB: Number(memory.rssBytes) / 1024 / 1024,
    heapUsedMiB: Number(memory.heapUsedBytes) / 1024 / 1024,
    cpuCores: Number(processStats && processStats.cpuCores),
    cpuPercent: Number(processStats && processStats.cpuPercent),
    uptimeSeconds: Number(processStats && processStats.uptimeSeconds),
    cpuTimeSeconds: Number(processStats && processStats.cpuTimeSeconds),
    activeResourceCount: Number(processStats && processStats.activeResourceCount),
    threadCount: Number(processStats && (processStats.threadCount ?? processStats.threads ?? processStats.activeResourceCount)),
    logicalCpuCount: Number(processStats && processStats.logicalCpuCount),
  };
}

function formatServerName(name) {
  const normalized = String(name || "mcp-project-indexer")
    .replace(/^mcp-/, "")
    .replace(/-project-indexer$/, "");
  const labels = {
    typescript: "TypeScript",
    python: "Python",
    csharp: "C#",
    go: "Go",
    java: "Java",
    rust: "Rust",
  };
  const label = labels[normalized] || normalized
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${label} Project Indexer`;
}

function renderDetails(status) {
  const server = status.server || {};
  const index = normalizeIndex(status.index || {});
  const processStats = normalizeProcess(status.process || {});
  const project = status.project || {};
  const watcher = status.watcher || {};
  const displayName = formatServerName(server.name);
  const details = [
    ["Server", displayName],
    ["Version", server.version || "-"],
    ["Started", server.startedAt || "-"],
    ["PID", server.pid || processStats.pid || "-"],
    ["RAM", Number.isFinite(processStats.memoryRssMiB) ? `${processStats.memoryRssMiB.toFixed(1)} MiB` : "-"],
    ["Heap", Number.isFinite(processStats.heapUsedMiB) ? `${processStats.heapUsedMiB.toFixed(1)} MiB` : "-"],
    ["CPU", formatCpu(processStats)],
    ["CPU time", Number.isFinite(processStats.cpuTimeSeconds) ? `${processStats.cpuTimeSeconds.toFixed(1)}s` : "-"],
    ["Uptime", formatDuration(processStats.uptimeSeconds)],
    ["Threads", Number.isFinite(processStats.threadCount) ? formatNumber(processStats.threadCount) : "-"],
    ["Project", project.root || "-"],
    ["Index", project.indexRoot || "-"],
    ["Files", formatNumber(index.fileCount)],
    ["Symbols", formatNumber(index.symbolCount)],
    ["Imports", formatNumber(index.importCount)],
    ["Exports", formatNumber(index.exportCount)],
    ["Lines", formatNumber(index.totalLineCount)],
    ["Tokens", formatNumber(index.totalTokenCount)],
    ["Diagnostics", formatNumber(index.diagnosticsCount)],
    ["State", index.stateFingerprint || "-"],
    ["Watcher", watcher.running ? "running" : "stopped"],
    ["Watcher updates", formatNumber(watcher.updateCount)],
    ["Watcher last update", watcher.lastUpdate || "-"],
    ["Watcher last error", watcher.lastError || "-"],
  ];
  $("#detailsList").innerHTML = details
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join("");
}

function pulseProcessBadge(key, currentValue) {
  const badge = document.querySelector(`[data-process-key="${key}"]`);
  if (!badge || !Number.isFinite(currentValue)) return;
  const previous = state.previousProcessStats ? state.previousProcessStats[key] : undefined;
  badge.classList.remove("trend-up", "trend-down", "trend-same", "trend-live");
  if (key === "uptimeSeconds") {
    badge.classList.add("trend-live");
    window.setTimeout(() => badge.classList.remove("trend-live"), 900);
    return;
  }
  if (Number.isFinite(previous)) {
    const epsilon = key.includes("MiB") ? 0.05 : 0.001;
    const delta = currentValue - previous;
    badge.classList.add(Math.abs(delta) <= epsilon ? "trend-same" : delta > 0 ? "trend-up" : "trend-down");
    window.setTimeout(() => badge.classList.remove("trend-up", "trend-down", "trend-same"), 900);
  }
}

function renderProcessStats(rawProcessStats) {
  const processStats = normalizeProcess(rawProcessStats || {});
  setText("#memoryValue", Number.isFinite(processStats.memoryRssMiB) ? `${processStats.memoryRssMiB.toFixed(1)} MiB` : "-");
  setText("#heapValue", Number.isFinite(processStats.heapUsedMiB) ? `${processStats.heapUsedMiB.toFixed(1)} MiB` : "-");
  setText("#cpuValue", formatCpu(processStats));
  setText("#cpuTimeValue", Number.isFinite(processStats.cpuTimeSeconds) ? `${processStats.cpuTimeSeconds.toFixed(1)}s` : "-");
  setText("#uptimeValue", Number.isFinite(processStats.uptimeSeconds) ? formatDuration(processStats.uptimeSeconds) : "-");
  setText("#threadsValue", Number.isFinite(processStats.threadCount) ? formatNumber(processStats.threadCount) : "-");

  for (const key of ["memoryRssMiB", "heapUsedMiB", "cpuCores", "cpuTimeSeconds", "uptimeSeconds", "threadCount"]) {
    pulseProcessBadge(key, processStats[key]);
  }
  state.previousProcessStats = processStats;
}

function renderStatus(status) {
  const server = status.server || {};
  const index = normalizeIndex(status.index || {});
  const watcher = status.watcher || {};
  const title = formatServerName(server.name);
  document.title = title;
  setText("#serverTitle", title);
  $("#statusPill").textContent = "online";
  $("#statusPill").classList.add("online");
  setText("#filesValue", formatNumber(index.fileCount));
  setText("#symbolsValue", formatNumber(index.symbolCount));
  setText("#importsValue", formatNumber(index.importCount));
  setText("#linesValue", formatNumber(index.totalLineCount));
  setText("#stateValue", (index.stateFingerprint || "").slice(0, 12));
  setText("#watcherValue", watcher.running ? "running" : "stopped");
  setText("#updatesValue", formatNumber(watcher.updateCount));
  setText("#commandValue", status.activeCommand || "idle");
  renderProcessStats(status.process || {});
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
initializeTokenFromHash();
startPolling();
