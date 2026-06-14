/**
 * mcp_server.ts
 *
 * MCP server for the TypeScript project indexer.
 * Supports stdio transport (JSON-RPC over stdin/stdout).
 *
 * Usage:
 *   node dist/mcp_server.js \
 *     --project-root <project-root> \
 *     --index-root <index-root>
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp_types";
import { MCP_ERROR_CODES } from "./mcp_types";
import {
  type LoadedIndex,
  loadIndex,
  dispatchTool,
  availableToolDefinitions,
} from "./mcp_tools";
import { updateProjectIndex } from "./ts_project_index";
import {
  getProjectPrompt,
  hasProjectPrompt,
  listProjectPrompts,
} from "./project_prompt";

// ---------------------------------------------------------------------------
// Server info
// ---------------------------------------------------------------------------

const SERVER_NAME = "mcp-typescript-project-indexer";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { projectRoot: string; indexRoot: string; startUpdate: boolean } {
  const args = process.argv.slice(2);
  let projectRoot: string | null = null;
  let indexRoot: string | null = null;
  let startUpdate = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-root" && args[i + 1]) {
      projectRoot = path.resolve(args[++i]!);
    } else if (args[i] === "--index-root" && args[i + 1]) {
      indexRoot = path.resolve(args[++i]!);
    } else if (args[i] === "--no-start-update") {
      startUpdate = false;
    }
  }

  if (!projectRoot) {
    projectRoot = process.cwd();
  }

  if (!indexRoot) {
    indexRoot = path.join(projectRoot, ".mcp-ts-project-indexer");
  }

  return { projectRoot, indexRoot, startUpdate };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}

function makeError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function makeResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

// ---------------------------------------------------------------------------
// MCP request handlers
// ---------------------------------------------------------------------------

function handleInitialize(
  id: number | string | null,
  _params: unknown,
  projectRoot: string,
): JsonRpcResponse {
  const capabilities: Record<string, unknown> = {
    tools: { listChanged: false },
  };
  if (hasProjectPrompt(projectRoot)) {
    capabilities.prompts = { listChanged: false };
  }
  return makeResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  });
}

function handleToolsList(
  id: number | string | null,
  _params: unknown,
  index: LoadedIndex,
): JsonRpcResponse {
  return makeResult(id, { tools: availableToolDefinitions(index) });
}

function handlePromptsList(id: number | string | null, projectRoot: string): JsonRpcResponse {
  return makeResult(id, listProjectPrompts(projectRoot));
}

function handlePromptsGet(
  id: number | string | null,
  params: unknown,
  projectRoot: string,
): JsonRpcResponse {
  if (!params || typeof params !== "object") {
    return makeError(id, MCP_ERROR_CODES.INVALID_PARAMS, "params required");
  }
  const name = typeof (params as Record<string, unknown>).name === "string"
    ? String((params as Record<string, unknown>).name)
    : "";
  if (!name) {
    return makeError(id, MCP_ERROR_CODES.INVALID_PARAMS, "prompt name required");
  }
  try {
    return makeResult(id, getProjectPrompt(projectRoot, name));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeError(id, MCP_ERROR_CODES.INVALID_PARAMS, message);
  }
}

function handleToolsCall(
  id: number | string | null,
  params: unknown,
  index: LoadedIndex,
): JsonRpcResponse {
  if (!params || typeof params !== "object") {
    return makeError(id, MCP_ERROR_CODES.INVALID_PARAMS, "params required");
  }

  const p = params as Record<string, unknown>;
  const toolName = typeof p.name === "string" ? p.name : "";
  const args = typeof p.arguments === "object" && p.arguments !== null
    ? (p.arguments as Record<string, unknown>)
    : {};

  if (!toolName) {
    return makeError(id, MCP_ERROR_CODES.INVALID_PARAMS, "tool name required");
  }

  const result = dispatchTool(toolName, args, index);
  return makeResult(id, result);
}

// ---------------------------------------------------------------------------
// Main server loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { projectRoot, indexRoot, startUpdate } = parseArgs();

  // Validate index exists
  const manifestPath = path.join(indexRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(
      `Error: Index not found at ${indexRoot}.\n` +
      `Run: node dist/scripts/build_project_index.js --root "${projectRoot}" --output-root "${indexRoot}"\n`,
    );
    process.exit(1);
  }

  if (startUpdate) {
    process.stderr.write(`Checking index updates for ${projectRoot}...\n`);
    try {
      const result = await updateProjectIndex({ projectRoot, indexRoot });
      process.stderr.write(
        `Startup update complete: ${result.fileCount} changed file(s) in ${result.durationMs}ms\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Startup update failed, loading existing index: ${message}\n`);
    }
  } else {
    process.stderr.write(`Startup index update disabled by --no-start-update.\n`);
  }

  // Load index
  let index: LoadedIndex;
  try {
    index = loadIndex(projectRoot, indexRoot);
  } catch (err) {
    process.stderr.write(`Error loading index: ${err}\n`);
    process.exit(1);
  }

  const stats = index.reader.getStats();
  process.stderr.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n` +
    `Project: ${projectRoot}\n` +
    `Index:   ${indexRoot}\n` +
    `Files:   ${stats.fileCount} | Symbols: ${stats.symbolCount} | Imports: ${stats.importCount}\n` +
    `Ready.\n`,
  );

  // Read JSON-RPC messages from stdin
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      sendResponse(makeError(null, MCP_ERROR_CODES.PARSE_ERROR, "Invalid JSON"));
      return;
    }

    if (request.jsonrpc !== "2.0") {
      sendResponse(makeError(request.id, MCP_ERROR_CODES.INVALID_REQUEST, "Expected jsonrpc 2.0"));
      return;
    }

    let response: JsonRpcResponse;

    switch (request.method) {
      case "initialize":
        response = handleInitialize(request.id, request.params, projectRoot);
        break;

      case "notifications/initialized":
        // Client acknowledgement — no response needed for notifications
        return;

      case "tools/list":
        response = handleToolsList(request.id, request.params, index);
        break;

      case "prompts/list":
        response = handlePromptsList(request.id, projectRoot);
        break;

      case "prompts/get":
        response = handlePromptsGet(request.id, request.params, projectRoot);
        break;

      case "tools/call":
        response = handleToolsCall(request.id, request.params, index);
        break;

      case "ping":
        response = makeResult(request.id, {});
        break;

      default:
        response = makeError(
          request.id,
          MCP_ERROR_CODES.METHOD_NOT_FOUND,
          `Unknown method: ${request.method}`,
        );
    }

    sendResponse(response);
  });

  rl.on("close", () => {
    index.reader.close();
    process.exit(0);
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
