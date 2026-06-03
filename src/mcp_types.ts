/**
 * mcp_types.ts
 *
 * MCP JSON-RPC protocol types for stdio transport.
 * Minimal implementation — only what the indexer needs.
 */

// ---------------------------------------------------------------------------
// JSON-RPC base
// ---------------------------------------------------------------------------

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

export type McpTool = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type McpToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
