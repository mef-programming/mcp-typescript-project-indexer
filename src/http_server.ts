/**
 * http_server.ts
 *
 * HTTP transport for the MCP server + Management API + Plugin UI.
 * Exposes:
 *   POST /mcp                         - MCP JSON-RPC endpoint
 *   GET  /health                      - Health check
 *   GET  /status                      - Server status + dashboard
 *   GET  /management/plugin-ui/manifest - Plugin UI manifest for Relay WebUI
 *   GET  /management/status           - Management status
 *   POST /management/command          - Build/Update/Reload commands
 *   GET  /management/log              - Recent log events
 *   GET  /management/log/stream       - SSE log stream
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp_types";
import { MCP_ERROR_CODES } from "./mcp_types";
import {
  type LoadedIndex,
  loadIndex,
  dispatchTool,
  availableToolDefinitions,
} from "./mcp_tools";
import { buildProjectIndex } from "./ts_project_index";
import { buildModuleMap } from "./ts_module_scan";
import { createWatcher, type Watcher } from "./ts_watcher";
import {
  getProjectPrompt,
  hasProjectPrompt,
  listProjectPrompts,
} from "./project_prompt";

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

const SERVER_NAME = "mcp-typescript-project-indexer";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

type LogEvent = {
  id: number;
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

type ServerState = {
  index: LoadedIndex;
  projectRoot: string;
  indexRoot: string;
  startedAt: string;
  logs: LogEvent[];
  logIdCounter: number;
  sseClients: Set<http.ServerResponse>;
  activeCommand: string | null;
  managementToken: string | null;
  processStatsSample: ProcessStatsSample | null;
  watcher: Watcher | null;
  watcherRunning: boolean;
  watcherLastUpdate: string | null;
  watcherLastError: string | null;
  watcherUpdateCount: number;
};

type ProcessStatsSample = {
  wallMs: number;
  cpuMicros: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function addLog(state: ServerState, level: LogEvent["level"], message: string, data?: Record<string, unknown>): void {
  state.logIdCounter++;
  const event: LogEvent = {
    id: state.logIdCounter,
    timestamp: nowIso(),
    level,
    message,
    data,
  };
  state.logs.push(event);
  if (state.logs.length > 500) {
    state.logs = state.logs.slice(-300);
  }
  // Broadcast to SSE clients
  for (const client of state.sseClients) {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      state.sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function checkAuth(req: http.IncomingMessage, state: ServerState): boolean {
  if (!state.managementToken) return true;
  const auth = req.headers.authorization ?? "";
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (auth === `Bearer ${state.managementToken}`) return true;
  if (apiKey === state.managementToken) return true;
  return false;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
  });
  res.end(json);
}

function send401(res: http.ServerResponse): void {
  sendJson(res, 401, { error: "Unauthorized" });
}

function send404(res: http.ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function serveStaticFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  res.writeHead(200, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function processStatus(state: ServerState): Record<string, unknown> {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const wallMs = Date.now();
  const cpuMicros = cpu.user + cpu.system;
  const previous = state.processStatsSample;
  let cpuCores = 0;
  let cpuPercent = 0;

  if (previous) {
    const wallDeltaMs = Math.max(1, wallMs - previous.wallMs);
    const cpuDeltaMicros = Math.max(0, cpuMicros - previous.cpuMicros);
    cpuCores = cpuDeltaMicros / (wallDeltaMs * 1000);
    cpuPercent = os.cpus().length > 0 ? (cpuCores / os.cpus().length) * 100 : 0;
  }

  state.processStatsSample = { wallMs, cpuMicros };
  const activeResourceCount = typeof process.getActiveResourcesInfo === "function"
    ? process.getActiveResourcesInfo().length
    : null;

  return {
    pid: process.pid,
    uptimeSeconds: process.uptime(),
    cpuTimeSeconds: cpuMicros / 1_000_000,
    cpuCores,
    cpuPercent,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    activeResourceCount,
    threadCount: activeResourceCount,
    logicalCpuCount: os.cpus().length,
  };
}

// ---------------------------------------------------------------------------
// Plugin UI Manifest
// ---------------------------------------------------------------------------

function getPluginUiManifest(state: ServerState): Record<string, unknown> {
  return {
    id: "typescript-project-indexer",
    name: "TypeScript Project Indexer",
    version: SERVER_VERSION,
    ui: {
      mode: "iframe",
      entry: "/server/ui/index.html",
      height: "auto",
    },
    capabilities: ["status", "logs", "metrics", "commands", "tool-test"],
    tools: availableToolDefinitions(state.index).map((tool) => tool.name),
    project: {
      root: state.projectRoot,
      indexRoot: state.indexRoot,
    },
  };
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

function handleMcpRequest(body: string, state: ServerState): JsonRpcResponse {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(body) as JsonRpcRequest;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: MCP_ERROR_CODES.PARSE_ERROR, message: "Invalid JSON" } };
  }

  switch (request.method) {
    case "initialize": {
      const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
      if (hasProjectPrompt(state.projectRoot)) capabilities.prompts = { listChanged: false };
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }

    case "tools/list":
      return { jsonrpc: "2.0", id: request.id, result: { tools: availableToolDefinitions(state.index) } };

    case "prompts/list":
      return { jsonrpc: "2.0", id: request.id, result: listProjectPrompts(state.projectRoot) };

    case "prompts/get": {
      const params = request.params as Record<string, unknown> | undefined;
      const name = typeof params?.name === "string" ? params.name : "";
      if (!name) {
        return { jsonrpc: "2.0", id: request.id, error: { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "prompt name required" } };
      }
      try {
        return { jsonrpc: "2.0", id: request.id, result: getProjectPrompt(state.projectRoot, name) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { jsonrpc: "2.0", id: request.id, error: { code: MCP_ERROR_CODES.INVALID_PARAMS, message } };
      }
    }

    case "tools/call": {
      const params = request.params as Record<string, unknown> | undefined;
      const toolName = typeof params?.name === "string" ? params.name : "";
      const args = typeof params?.arguments === "object" && params.arguments
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (!toolName) {
        return { jsonrpc: "2.0", id: request.id, error: { code: MCP_ERROR_CODES.INVALID_PARAMS, message: "tool name required" } };
      }
      addLog(state, "info", `tools/call: ${toolName}`, { toolName, args });
      const result = dispatchTool(toolName, args, state.index);
      return { jsonrpc: "2.0", id: request.id, result };
    }

    case "ping":
      return { jsonrpc: "2.0", id: request.id, result: {} };

    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: MCP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unknown method: ${request.method}` } };
  }
}

// ---------------------------------------------------------------------------
// Management commands
// ---------------------------------------------------------------------------

async function handleCommand(
  command: string,
  params: Record<string, unknown>,
  state: ServerState,
): Promise<Record<string, unknown>> {
  if (state.activeCommand) {
    return { error: "busy", message: `Command already running: ${state.activeCommand}` };
  }

  state.activeCommand = command;
  addLog(state, "info", `Command started: ${command}`, params);

  try {
    switch (command) {
      case "build": {
        const result = await buildProjectIndex({
          projectRoot: state.projectRoot,
          indexRoot: state.indexRoot,
          onProgress: (done, total) => {
            if (done % 50 === 0 || done === total) {
              addLog(state, "info", `Build progress: ${done}/${total}`);
            }
          },
        });
        // Reload index
        state.index.reader.close();
        state.index = loadIndex(state.projectRoot, state.indexRoot);
        addLog(state, "info", `Build complete: ${result.fileCount} files, ${result.symbolCount} symbols`);
        return { status: "ok", ...result };
      }

      case "module_map": {
        const map = buildModuleMap({ indexRoot: state.indexRoot });
        addLog(state, "info", `Module map rebuilt: ${map.fileCount} files`);
        return { status: "ok", fileCount: map.fileCount, unresolvedImports: map.unresolvedImports.length };
      }

      case "reload_index": {
        state.index.reader.close();
        state.index = loadIndex(state.projectRoot, state.indexRoot);
        const stats = state.index.reader.getStats();
        addLog(state, "info", `Index reloaded: ${stats.fileCount} files, ${stats.symbolCount} symbols`);
        return { status: "ok", ...stats };
      }

      default:
        return { error: "unknown_command", message: `Unknown command: ${command}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(state, "error", `Command failed: ${command}: ${message}`);
    return { error: "command_failed", message };
  } finally {
    state.activeCommand = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin UI HTML (minimal embedded)
// ---------------------------------------------------------------------------

function pluginUiHtml(state: ServerState): string {
  const stats = state.index.reader.getStats();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>TypeScript Project Indexer</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #1e1e1e; color: #d4d4d4; }
    h1 { font-size: 18px; margin: 0 0 12px; color: #569cd6; }
    .card { background: #252526; border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .stat { display: inline-block; margin-right: 24px; }
    .stat-value { font-size: 20px; font-weight: bold; color: #4ec9b0; }
    .stat-label { font-size: 12px; color: #808080; }
    .log { font-family: monospace; font-size: 12px; max-height: 300px; overflow-y: auto; background: #1a1a1a; padding: 8px; border-radius: 4px; }
    .log-entry { margin: 2px 0; }
    .log-info { color: #4ec9b0; }
    .log-warn { color: #ce9178; }
    .log-error { color: #f44747; }
    button { background: #0e639c; color: white; border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; margin-right: 8px; }
    button:hover { background: #1177bb; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <h1>TypeScript Project Indexer</h1>
  <div class="card">
    <div class="stat"><div class="stat-value" id="files">${stats.fileCount}</div><div class="stat-label">Files</div></div>
    <div class="stat"><div class="stat-value" id="symbols">${stats.symbolCount}</div><div class="stat-label">Symbols</div></div>
    <div class="stat"><div class="stat-value" id="imports">${stats.importCount}</div><div class="stat-label">Imports</div></div>
    <div class="stat"><div class="stat-value" id="state">${state.index.stateFingerprint.slice(0, 12)}</div><div class="stat-label">State</div></div>
  </div>
  <div class="card">
    <button onclick="runCommand('build')">Build Index</button>
    <button onclick="runCommand('module_map')">Rebuild Module Map</button>
    <button onclick="runCommand('reload_index')">Reload</button>
  </div>
  <div class="card">
    <div class="log" id="log"></div>
  </div>
  <script>
    const logEl = document.getElementById('log');
    function addLogEntry(event) {
      const div = document.createElement('div');
      div.className = 'log-entry log-' + event.level;
      div.textContent = event.timestamp.slice(11,19) + ' ' + event.message;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }
    async function runCommand(cmd) {
      const res = await fetch('/management/command', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({command: cmd})
      });
      const data = await res.json();
      addLogEntry({level:'info', timestamp: new Date().toISOString(), message: JSON.stringify(data)});
      if (data.fileCount) document.getElementById('files').textContent = data.fileCount;
      if (data.symbolCount) document.getElementById('symbols').textContent = data.symbolCount;
    }
    const evtSource = new EventSource('/management/log/stream');
    evtSource.onmessage = (e) => { try { addLogEntry(JSON.parse(e.data)); } catch {} };
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP request router
// ---------------------------------------------------------------------------

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: ServerState,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = url.pathname;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    });
    res.end();
    return;
  }

  // Public endpoints (no auth)
  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
    return;
  }

  if (method === "GET" && pathname === "/status") {
    const stats = state.index.reader.getStats();
    sendJson(res, 200, {
      server: { name: SERVER_NAME, version: SERVER_VERSION, startedAt: state.startedAt, uptime: process.uptime() },
      process: processStatus(state),
      index: { ...stats, orientationNodeCount: state.index.manifest.orientationNodeCount ?? 0, stateFingerprint: state.index.stateFingerprint, generatedAt: state.index.manifest.generatedAt },
      project: { root: state.projectRoot, indexRoot: state.indexRoot },
      activeCommand: state.activeCommand,
      watcher: {
        running: state.watcherRunning,
        lastUpdate: state.watcherLastUpdate,
        lastError: state.watcherLastError,
        updateCount: state.watcherUpdateCount,
      },
    });
    return;
  }

  // MCP endpoint
  if (method === "POST" && pathname === "/mcp") {
    const body = await readBody(req);
    const response = handleMcpRequest(body, state);
    sendJson(res, 200, response);
    return;
  }

  // Plugin UI assets — public, no auth
  if (method === "GET" && pathname.startsWith("/server/ui")) {
    if (pathname === "/server/ui/index.html" || pathname === "/server/ui/" || pathname === "/server/ui") {
      serveStaticFile(res, path.join(__dirname, "..", "server_ui", "index.html"), "text/html");
      return;
    }
    if (pathname === "/server/ui/styles.css") {
      serveStaticFile(res, path.join(__dirname, "..", "server_ui", "styles.css"), "text/css");
      return;
    }
    if (pathname === "/server/ui/app.js") {
      serveStaticFile(res, path.join(__dirname, "..", "server_ui", "app.js"), "application/javascript");
      return;
    }
    send404(res);
    return;
  }

  // Auth-protected server endpoints
  if (pathname.startsWith("/server/")) {
    if (!checkAuth(req, state)) {
      send401(res);
      return;
    }

    // Plugin UI manifest
    if (method === "GET" && pathname === "/server/ui/manifest") {
      sendJson(res, 200, getPluginUiManifest(state));
      return;
    }

    // Management status
    if (method === "GET" && pathname === "/server/management/status") {
      const stats = state.index.reader.getStats();
      sendJson(res, 200, {
        server: { name: SERVER_NAME, version: SERVER_VERSION, pid: process.pid, ramMb: Math.round(process.memoryUsage().rss / 1024 / 1024), startedAt: state.startedAt },
        process: processStatus(state),
        index: { ...stats, orientationNodeCount: state.index.manifest.orientationNodeCount ?? 0, stateFingerprint: state.index.stateFingerprint, totalLineCount: state.index.manifest.totalLineCount, totalTokenCount: state.index.manifest.totalTokenCount },
        project: { root: state.projectRoot, indexRoot: state.indexRoot },
        activeCommand: state.activeCommand,
        watcher: {
          running: state.watcherRunning,
          lastUpdate: state.watcherLastUpdate,
          lastError: state.watcherLastError,
          updateCount: state.watcherUpdateCount,
        },
        logCount: state.logs.length,
      });
      return;
    }

    // Commands
    if (method === "POST" && pathname === "/server/management/command") {
      const body = await readBody(req);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: "Invalid JSON" }); return; }
      const command = typeof parsed.command === "string" ? parsed.command : "";
      if (!command) { sendJson(res, 400, { error: "command required" }); return; }
      const result = await handleCommand(command, parsed, state);
      sendJson(res, 200, result);
      return;
    }

    // Log retrieval
    if (method === "GET" && (pathname === "/server/management/log" || pathname === "/server/management/server-log")) {
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10), 500);
      const filtered = state.logs.filter((e) => e.id > since).slice(-limit);
      sendJson(res, 200, { events: filtered, total: state.logs.length });
      return;
    }

    // SSE log stream
    if (method === "GET" && (pathname === "/server/management/log/stream" || pathname === "/server/management/server-log/stream")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", logCount: state.logs.length })}\n\n`);
      state.sseClients.add(res);
      req.on("close", () => { state.sseClients.delete(res); });
      return;
    }

    send404(res);
    return;
  }

  send404(res);
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

export type HttpServerOptions = {
  projectRoot: string;
  indexRoot: string;
  host?: string;
  port?: number;
  managementToken?: string;
  watchIndex?: boolean;
  watchPollIntervalMs?: number;
  watchDebounceMs?: number;
};

export function startHttpServer(options: HttpServerOptions): http.Server {
  const {
    projectRoot,
    indexRoot,
    host = "127.0.0.1",
    port = 8766,
    managementToken = null,
    watchIndex = false,
    watchPollIntervalMs = 5000,
    watchDebounceMs = 1000,
  } = options;

  const index = loadIndex(projectRoot, indexRoot);
  const stats = index.reader.getStats();

  const state: ServerState = {
    index,
    projectRoot,
    indexRoot,
    startedAt: nowIso(),
    logs: [],
    logIdCounter: 0,
    sseClients: new Set(),
    activeCommand: null,
    managementToken,
    processStatsSample: null,
    watcher: null,
    watcherRunning: false,
    watcherLastUpdate: null,
    watcherLastError: null,
    watcherUpdateCount: 0,
  };

  addLog(state, "info", `Server starting`, { projectRoot, indexRoot, host, port });
  addLog(state, "info", `Index loaded: ${stats.fileCount} files, ${stats.symbolCount} symbols`);

  if (watchIndex) {
    state.watcher = createWatcher({
      projectRoot,
      indexRoot,
      pollIntervalMs: watchPollIntervalMs,
      debounceMs: watchDebounceMs,
      canUpdate: () => !state.activeCommand,
      onUpdateStart: (changedCount) => {
        state.activeCommand = "watch_update";
        addLog(state, "info", `Watcher update started: ${changedCount} changed file(s)`);
      },
      onUpdate: (changedCount, durationMs) => {
        state.index.reader.close();
        state.index = loadIndex(state.projectRoot, state.indexRoot);
        state.activeCommand = null;
        state.watcherLastUpdate = nowIso();
        state.watcherLastError = null;
        state.watcherUpdateCount++;
        addLog(state, "info", `Watcher update complete: ${changedCount} file(s) in ${durationMs}ms`);
      },
      onError: (error) => {
        state.activeCommand = null;
        state.watcherLastError = error.message;
        addLog(state, "error", `Watcher update failed: ${error.message}`);
      },
    });
    state.watcher.start();
    state.watcherRunning = true;
    addLog(state, "info", "Watcher started", { pollIntervalMs: watchPollIntervalMs, debounceMs: watchDebounceMs });
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(state, "error", `Request error: ${message}`);
      sendJson(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    addLog(state, "info", `Server listening on ${url}`);
    process.stderr.write(
      `${SERVER_NAME} v${SERVER_VERSION}\n` +
      `MCP:        ${url}/mcp\n` +
      `Health:     ${url}/health\n` +
      `Status:     ${url}/status\n` +
      `Management: ${url}/server/management/status\n` +
      `Plugin UI:  ${url}/server/ui/\n` +
      `Manifest:   ${url}/server/ui/manifest\n` +
      `Files: ${stats.fileCount} | Symbols: ${stats.symbolCount} | Imports: ${stats.importCount}\n`,
    );
  });

  server.on("close", () => {
    if (state.watcher) {
      state.watcher.stop();
      state.watcherRunning = false;
      addLog(state, "info", "Watcher stopped");
    }
    state.index.reader.close();
  });

  return server;
}

// ---------------------------------------------------------------------------
// CLI entry (when run directly)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  let indexRoot: string | null = null;
  let host = "127.0.0.1";
  let port = 8766;
  let managementToken: string | null = null;
  let watchIndex = false;
  let watchPollIntervalMs = 5000;
  let watchDebounceMs = 1000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-root" && args[i + 1]) projectRoot = path.resolve(args[++i]!);
    else if (args[i] === "--index-root" && args[i + 1]) indexRoot = path.resolve(args[++i]!);
    else if (args[i] === "--http-host" && args[i + 1]) host = args[++i]!;
    else if (args[i] === "--http-port" && args[i + 1]) port = parseInt(args[++i]!, 10);
    else if (args[i] === "--management-token" && args[i + 1]) managementToken = args[++i]!;
    else if (args[i] === "--watch-index") watchIndex = true;
    else if (args[i] === "--no-watch-index") watchIndex = false;
    else if (args[i] === "--watch-poll-interval-ms" && args[i + 1]) watchPollIntervalMs = parseInt(args[++i]!, 10);
    else if (args[i] === "--watch-debounce-ms" && args[i + 1]) watchDebounceMs = parseInt(args[++i]!, 10);
  }

  if (!indexRoot) indexRoot = path.join(projectRoot, ".mcp-ts-project-indexer");

  if (!fs.existsSync(path.join(indexRoot, "manifest.json"))) {
    process.stderr.write(
      `Error: Index not found at ${indexRoot}.\n` +
      `Run: node dist/scripts/build_project_index.js --root "${projectRoot}" --output-root "${indexRoot}"\n`,
    );
    process.exit(1);
  }

  startHttpServer({
    projectRoot,
    indexRoot,
    host,
    port,
    managementToken: managementToken ?? undefined,
    watchIndex,
    watchPollIntervalMs,
    watchDebounceMs,
  });
}
