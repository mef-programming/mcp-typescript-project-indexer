/**
 * mcp_tools.ts
 *
 * MCP tool definitions and handlers for the TypeScript project indexer.
 * Each tool returns routing metadata or exact source ranges.
 *
 * Tool philosophy (same as C++ indexer):
 *   metadata answers "where?"
 *   source answers "what does the code say?"
 *   the model answers "what does it mean?"
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { McpTool, McpToolResult } from "./mcp_types";
import { SqliteIndexReader } from "./ts_index_sqlite";
import { readLeadingComment, readSourceRange } from "./ts_file_index";
import type { FileIndex, ProjectManifest } from "./ts_index_model";
import { loadOrientationIndex, type OrientationNode } from "./ts_orientation_index";
import { safeParseJson, stableJson } from "./ts_index_utils";

// ---------------------------------------------------------------------------
// Loaded index state
// ---------------------------------------------------------------------------

export type LoadedIndex = {
  projectRoot: string;
  indexRoot: string;
  reader: SqliteIndexReader;
  manifest: ProjectManifest;
  stateFingerprint: string;
};

export function loadIndex(projectRoot: string, indexRoot: string): LoadedIndex {
  const manifestPath = path.join(indexRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Index manifest not found: ${manifestPath}. Run build_project_index first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
  const reader = new SqliteIndexReader(indexRoot);
  const stateFingerprint = manifest.stateHash.slice(0, 16);
  return { projectRoot, indexRoot, reader, manifest, stateFingerprint };
}

function withMeta(result: unknown, index: LoadedIndex): unknown {
  if (typeof result !== "object" || result === null) return result;
  return {
    ...(result as Record<string, unknown>),
    _meta: { stateFingerprint: index.stateFingerprint },
  };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(data: unknown): McpToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : stableJson(data) }] };
}

// ---------------------------------------------------------------------------
// File index loader (cached per request)
// ---------------------------------------------------------------------------

function loadFileIndex(indexRoot: string, fileId: string): FileIndex | null {
  const jsonPath = path.join(indexRoot, "files", `${fileId}.json`);
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as FileIndex;
  } catch {
    return null;
  }
}

function absolutePath(projectRoot: string, relativePath: string): string {
  return path.resolve(projectRoot, relativePath.replace(/\//g, path.sep));
}

// ---------------------------------------------------------------------------
// Tool: get_project_summary
// ---------------------------------------------------------------------------

export function handleGetProjectSummary(
  _args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const stats = index.reader.getStats();
  return okResult(withMeta({
    projectRoot: index.manifest.projectRoot,
    indexRoot: index.manifest.indexRoot,
    generatedAt: index.manifest.generatedAt,
    fileCount: stats.fileCount,
    symbolCount: stats.symbolCount,
    importCount: stats.importCount,
    exportCount: index.manifest.exportCount,
    orientationNodeCount: index.manifest.orientationNodeCount ?? 0,
    diagnosticsCount: index.manifest.diagnosticsCount,
    totalLineCount: index.manifest.totalLineCount,
    totalTokenCount: index.manifest.totalTokenCount,
    stateHash: index.manifest.stateHash,
    indexerVersion: index.manifest.indexerVersion,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: get_index_state
// ---------------------------------------------------------------------------

export function handleGetIndexState(
  _args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const stats = index.reader.getStats();
  return okResult({
    stateFingerprint: index.stateFingerprint,
    stateHash: index.manifest.stateHash,
    generatedAt: index.manifest.generatedAt,
    fileCount: stats.fileCount,
    symbolCount: stats.symbolCount,
    importCount: stats.importCount,
    orientationNodeCount: index.manifest.orientationNodeCount ?? 0,
  });
}

function compactOrientationNode(node: OrientationNode): Record<string, unknown> {
  return {
    orientationId: node.orientationId,
    kind: node.kind,
    folder: node.folder,
    file: node.file,
    title: node.title,
    purpose: node.purpose,
    useWhen: node.useWhen,
    doNotUseFirstWhen: node.doNotUseFirstWhen,
    startHere: node.startHere,
    childFolders: node.childFolders,
  };
}

export function handleGetProjectOrientation(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const orientation = loadOrientationIndex(index.indexRoot);
  const maxNodes = typeof args.maxNodes === "number" ? Math.min(Math.max(args.maxNodes, 1), 50) : 12;
  const selected: OrientationNode[] = [];
  const root = orientation.nodes.find((node) => node.folder === ".");
  if (root) selected.push(root);
  for (const node of orientation.nodes) {
    if (selected.length >= maxNodes) break;
    if (node.folder !== "." && !node.folder.includes("/")) selected.push(node);
  }
  const nodes = selected.length > 0 ? selected : orientation.nodes.slice(0, maxNodes);
  return okResult(withMeta({
    schema: "ts.project_orientation.summary.v1",
    totalNodes: orientation.nodes.length,
    returnedNodes: nodes.length,
    nodes: nodes.map(compactOrientationNode),
  }, index));
}

export function handleListOrientationNodes(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const orientation = loadOrientationIndex(index.indexRoot);
  const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 500) : 200;
  const nodes = orientation.nodes.slice(0, limit);
  return okResult(withMeta({
    schema: "ts.project_orientation.list.v1",
    totalNodes: orientation.nodes.length,
    returnedNodes: nodes.length,
    nodes: nodes.map(compactOrientationNode),
  }, index));
}

export function handleGetOrientationNode(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const queryPath = typeof args.path === "string" ? args.path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
  if (!queryPath) return errorResult("path is required");
  const orientation = loadOrientationIndex(index.indexRoot);
  const node = orientation.nodes.find((candidate) =>
    candidate.orientationId === queryPath ||
    candidate.folder.replace(/^\/+|\/+$/g, "") === queryPath ||
    candidate.file.replace(/^\/+|\/+$/g, "") === queryPath
  );
  if (!node) return errorResult(`Orientation node not found: ${queryPath}`);
  return okResult(withMeta(node, index));
}

export function handleSearchOrientation(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return errorResult("query is required");
  const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 100) : 20;
  const needle = query.toLowerCase();
  const orientation = loadOrientationIndex(index.indexRoot);
  const matches: Array<Record<string, unknown>> = [];
  for (const node of orientation.nodes) {
    const haystack = [
      node.title,
      node.folder,
      node.file,
      node.purpose,
      node.boundaries,
      node.useWhen.join(" "),
      node.doNotUseFirstWhen.join(" "),
      node.startHere.join(" "),
      node.map.map((entry) => `${entry.path} ${entry.description}`).join(" "),
      node.headings.join(" "),
    ].join(" ").toLowerCase();
    if (!haystack.includes(needle)) continue;
    matches.push({ ...compactOrientationNode(node), matchKind: "text_substring" });
    if (matches.length >= limit) break;
  }
  return okResult(withMeta({
    schema: "ts.project_orientation.search.v1",
    query,
    totalNodes: orientation.nodes.length,
    returnedMatches: matches.length,
    matches,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: find_symbol
// ---------------------------------------------------------------------------

export function handleFindSymbol(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return errorResult("query is required");

  const exactOnly = args.exactOnly === true;
  const compact = args.compact === true;
  const symbolTypes = Array.isArray(args.symbolTypes)
    ? (args.symbolTypes as string[])
    : undefined;
  const file = typeof args.file === "string" ? args.file : undefined;
  const container = typeof args.container === "string" ? args.container : undefined;
  const limit = typeof args.limit === "number" ? args.limit : 20;

  const rows = index.reader.findSymbol(query, {
    exactOnly,
    symbolTypes,
    file,
    container,
    limit,
  });

  if (rows.length === 0) {
    return okResult(withMeta({ results: [], count: 0, query }, index));
  }

  const results = rows.map((row) => {
    const base: Record<string, unknown> = {
      symbolId: row.symbolId,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualifiedName,
      relativePath: row.relativePath,
      startLine: row.startLine,
      endLine: row.endLine,
    };
    if (!compact) {
      base.signature = row.signature;
      base.container = row.container;
      base.isExported = row.isExported === 1;
      base.isAsync = row.isAsync === 1;
      base.isAbstract = row.isAbstract === 1;
      base.isStatic = row.isStatic === 1;
    }
    return base;
  });

  return okResult(withMeta({ results, count: results.length, query }, index));
}

// ---------------------------------------------------------------------------
// Tool: read_symbol
// ---------------------------------------------------------------------------

export function handleReadSymbol(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const symbolId = typeof args.symbolId === "string" ? args.symbolId.trim() : "";
  if (!symbolId) return errorResult("symbolId is required");

  const row = index.reader.getSymbol(symbolId);
  if (!row) return errorResult(`Symbol not found: ${symbolId}`);

  const startOffset = typeof args.startOffset === "number" ? args.startOffset : 0;
  const endOffset = typeof args.endOffset === "number" ? args.endOffset : 0;
  const startLine = Math.max(1, row.startLine + startOffset);
  const endLine = row.endLine + endOffset;

  const absPath = absolutePath(index.projectRoot, row.relativePath);
  if (!fs.existsSync(absPath)) {
    return errorResult(`Source file not found: ${row.relativePath}`);
  }

  const source = readSourceRange(absPath, startLine, endLine);

  return okResult(withMeta({
    symbolId: row.symbolId,
    kind: row.kind,
    name: row.name,
    qualifiedName: row.qualifiedName,
    relativePath: row.relativePath,
    startLine,
    endLine,
    signature: row.signature,
    container: row.container,
    isExported: row.isExported === 1,
    isAsync: row.isAsync === 1,
    isAbstract: row.isAbstract === 1,
    isStatic: row.isStatic === 1,
    source,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: read_range
// ---------------------------------------------------------------------------

export function handleReadRange(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  if (!file) return errorResult("file is required");

  // Support both startLine/endLine and line/beforeLines/afterLines
  let startLine: number;
  let endLine: number;

  if (typeof args.line === "number") {
    const beforeLines = typeof args.beforeLines === "number" ? args.beforeLines : 0;
    const afterLines = typeof args.afterLines === "number" ? args.afterLines : 0;
    startLine = Math.max(1, args.line - beforeLines);
    endLine = args.line + afterLines;
  } else {
    startLine = typeof args.startLine === "number" ? args.startLine : 1;
    endLine = typeof args.endLine === "number" ? args.endLine : startLine;
  }

  // Resolve file — try as relative path first, then fuzzy match
  let resolvedPath: string | null = null;
  const direct = path.resolve(index.projectRoot, file.replace(/\//g, path.sep));
  if (fs.existsSync(direct)) {
    resolvedPath = direct;
  } else {
    // Try SQLite lookup
    const row = index.reader.getFile(file);
    if (row) {
      resolvedPath = absolutePath(index.projectRoot, row.relativePath);
    }
  }

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return errorResult(`File not found: ${file}`);
  }

  const source = readSourceRange(resolvedPath, startLine, endLine);
  return okResult(withMeta({ file, startLine, endLine, source }, index));
}

// ---------------------------------------------------------------------------
// Tool: list_file_symbols
// ---------------------------------------------------------------------------

export function handleListFileSymbols(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  if (!file) return errorResult("file is required");

  const row = index.reader.getFile(file);
  if (!row) return errorResult(`File not found in index: ${file}`);

  const symbolTypes = Array.isArray(args.symbolTypes)
    ? (args.symbolTypes as string[])
    : undefined;
  const container = typeof args.container === "string" ? args.container : undefined;
  const compact = args.compact === true;
  const limit = typeof args.limit === "number" ? args.limit : 200;

  const symbols = index.reader.listFileSymbols(row.fileId, { symbolTypes, container, limit });

  const results = symbols.map((sym) => {
    const base: Record<string, unknown> = {
      symbolId: sym.symbolId,
      kind: sym.kind,
      name: sym.name,
      qualifiedName: sym.qualifiedName,
      startLine: sym.startLine,
      endLine: sym.endLine,
    };
    if (!compact) {
      base.signature = sym.signature;
      base.container = sym.container;
      base.isExported = sym.isExported === 1;
    }
    return base;
  });

  return okResult(withMeta({
    file: row.relativePath,
    fileId: row.fileId,
    symbolCount: results.length,
    symbols: results,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: get_file_structure
// ---------------------------------------------------------------------------

export function handleGetFileStructure(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  if (!file) return errorResult("file is required");

  const row = index.reader.getFile(file);
  if (!row) return errorResult(`File not found in index: ${file}`);

  const includeOutline = args.includeOutline !== false;
  const includeImports = args.includeImports !== false;
  const compact = args.compact === true;
  const symbolTypes = Array.isArray(args.symbolTypes)
    ? (args.symbolTypes as string[])
    : undefined;

  const result: Record<string, unknown> = {
    fileId: row.fileId,
    relativePath: row.relativePath,
    lineCount: row.lineCount,
    tokenCount: row.tokenCount,
    indexedAt: row.indexedAt,
  };

  if (includeOutline) {
    const symbols = index.reader.listFileSymbols(row.fileId, { symbolTypes });
    result.symbolCount = symbols.length;
    result.outline = symbols.map((sym) => {
      const entry: Record<string, unknown> = {
        symbolId: sym.symbolId,
        kind: sym.kind,
        name: sym.name,
        startLine: sym.startLine,
        endLine: sym.endLine,
      };
      if (!compact) {
        entry.qualifiedName = sym.qualifiedName;
        entry.container = sym.container;
        entry.isExported = sym.isExported === 1;
      }
      return entry;
    });
  }

  if (includeImports) {
    const imports = index.reader.getFileImports(row.fileId);
    result.importCount = imports.length;
    if (!compact) {
      result.imports = imports.map((imp) => ({
        kind: imp.kind,
        moduleSpecifier: imp.moduleSpecifier,
        resolvedRelativePath: imp.resolvedRelativePath,
        isExternal: imp.isExternal === 1,
        isTypeOnly: imp.isTypeOnly === 1,
        line: imp.line,
      }));
    }
  }

  return okResult(withMeta(result, index));
}

// ---------------------------------------------------------------------------
// Tool: list_file_imports
// ---------------------------------------------------------------------------

export function handleListFileImports(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  if (!file) return errorResult("file is required");

  const row = index.reader.getFile(file);
  if (!row) return errorResult(`File not found in index: ${file}`);

  const imports = index.reader.getFileImports(row.fileId);
  const externalOnly = args.externalOnly === true;
  const projectOnly = args.projectOnly === true;

  const filtered = imports.filter((imp) => {
    if (externalOnly && imp.isExternal === 0) return false;
    if (projectOnly && imp.isExternal === 1) return false;
    return true;
  });

  return okResult(withMeta({
    file: row.relativePath,
    fileId: row.fileId,
    importCount: filtered.length,
    imports: filtered.map((imp) => ({
      kind: imp.kind,
      moduleSpecifier: imp.moduleSpecifier,
      resolvedRelativePath: imp.resolvedRelativePath,
      isExternal: imp.isExternal === 1,
      isTypeOnly: imp.isTypeOnly === 1,
      line: imp.line,
    })),
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: list_file_imported_by
// ---------------------------------------------------------------------------

export function handleListFileImportedBy(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  if (!file) return errorResult("file is required");

  const row = index.reader.getFile(file);
  if (!row) return errorResult(`File not found in index: ${file}`);

  const importedBy = index.reader.getImportedBy(row.relativePath);

  const results = importedBy.map((imp) => {
    const fromFile = index.reader.getFile(imp.fileId);
    return {
      fromFileId: imp.fileId,
      fromRelativePath: fromFile?.relativePath ?? imp.fileId,
      moduleSpecifier: imp.moduleSpecifier,
      isTypeOnly: imp.isTypeOnly === 1,
      line: imp.line,
    };
  });

  return okResult(withMeta({
    file: row.relativePath,
    fileId: row.fileId,
    importedByCount: results.length,
    importedBy: results,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: search_source
// ---------------------------------------------------------------------------

export function handleSearchSource(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return errorResult("query is required");

  const filePattern = typeof args.file === "string" ? args.file.trim() : undefined;
  const useRegex = args.useRegex === true;
  const caseSensitive = args.caseSensitive === true;
  const wholeWord = args.wholeWord === true;
  const contextLines = typeof args.contextLines === "number"
    ? Math.min(args.contextLines, 5)
    : 0;
  const limit = typeof args.limit === "number" ? Math.min(args.limit, 200) : 50;

  // Build regex
  let pattern: RegExp;
  try {
    let regexSource = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord && !useRegex) {
      regexSource = `\\b${regexSource}\\b`;
    }
    pattern = new RegExp(regexSource, caseSensitive ? "g" : "gi");
  } catch (err) {
    return errorResult(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Get files to search
  const allFiles = index.reader.listFiles();
  const filesToSearch = filePattern
    ? allFiles.filter((f) =>
        f.relativePath.toLowerCase().includes(filePattern.toLowerCase()),
      )
    : allFiles;

  const matches: Array<{
    relativePath: string;
    line: number;
    column: number;
    text: string;
    context?: string[];
  }> = [];

  for (const file of filesToSearch) {
    if (matches.length >= limit) break;

    const absPath = absolutePath(index.projectRoot, file.relativePath);
    if (!fs.existsSync(absPath)) continue;

    let source: string;
    try {
      source = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const lines = source.split(/\r?\n/);
    pattern.lastIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= limit) break;
      const line = lines[i]!;
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        const entry: typeof matches[0] = {
          relativePath: file.relativePath,
          line: i + 1,
          column: match.index + 1,
          text: line.trim(),
        };
        if (contextLines > 0) {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length, i + contextLines + 1);
          entry.context = lines.slice(from, to).map(
            (l, idx) => `${String(from + idx + 1).padStart(5)} ${from + idx === i ? ">" : "|"} ${l}`,
          );
        }
        matches.push(entry);
      }
    }
  }

  return okResult(withMeta({
    query,
    matchCount: matches.length,
    truncated: matches.length >= limit,
    matches,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: get_symbol_leading_comment
// ---------------------------------------------------------------------------

export function handleGetSymbolLeadingComment(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const symbolId = typeof args.symbolId === "string" ? args.symbolId.trim() : "";
  if (!symbolId) return errorResult("symbolId is required");

  const row = index.reader.getSymbol(symbolId);
  if (!row) return errorResult(`Symbol not found: ${symbolId}`);

  const fileIndex = loadFileIndex(index.indexRoot, row.fileId);
  if (!fileIndex) return errorResult(`File index not found for: ${row.relativePath}`);

  const sym = fileIndex.symbols.find((s) => s.symbolId === symbolId);
  if (!sym?.leadingCommentRange) {
    return okResult(withMeta({
      symbolId,
      qualifiedName: row.qualifiedName,
      hasComment: false,
      comment: null,
    }, index));
  }

  const absPath = absolutePath(index.projectRoot, row.relativePath);
  const comment = readLeadingComment(
    absPath,
    sym.leadingCommentRange.startLine,
    sym.leadingCommentRange.endLine,
  );

  return okResult(withMeta({
    symbolId,
    qualifiedName: row.qualifiedName,
    hasComment: true,
    commentRange: sym.leadingCommentRange,
    comment,
  }, index));
}

// ---------------------------------------------------------------------------
// Tool: get_nearest_symbol_for_line
// ---------------------------------------------------------------------------

export function handleGetNearestSymbolForLine(
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  const file = typeof args.file === "string" ? args.file.trim() : "";
  const line = typeof args.line === "number" ? args.line : 0;
  if (!file) return errorResult("file is required");
  if (!line) return errorResult("line is required");

  const row = index.reader.getFile(file);
  if (!row) return errorResult(`File not found in index: ${file}`);

  const symbols = index.reader.listFileSymbols(row.fileId);

  // Find the symbol whose range contains the line, or the nearest one above
  let best = symbols.find(
    (s) => s.startLine <= line && s.endLine >= line,
  );

  if (!best) {
    // Find nearest symbol above the line
    const above = symbols.filter((s) => s.endLine < line);
    if (above.length > 0) {
      best = above[above.length - 1];
    }
  }

  if (!best) {
    return okResult(withMeta({ file: row.relativePath, line, symbol: null }, index));
  }

  return okResult(withMeta({
    file: row.relativePath,
    line,
    symbol: {
      symbolId: best.symbolId,
      kind: best.kind,
      name: best.name,
      qualifiedName: best.qualifiedName,
      startLine: best.startLine,
      endLine: best.endLine,
      containsLine: best.startLine <= line && best.endLine >= line,
    },
  }, index));
}

// ---------------------------------------------------------------------------
// Tool definitions (MCP schema)
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: McpTool[] = [
  {
    name: "get_project_summary",
    description: "Return a compact summary of the indexed project. Returns JSON counts for files, symbols, imports, exports, diagnostics, lines/tokens, state hash, indexer version, and orientation node count. Metadata only; does not return source.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_index_state",
    description: "Return a compact state fingerprint for the currently loaded project index. Returns JSON with stateFingerprint/stateHash, generatedAt, file/symbol/import counts, and orientation node count. Use for staleness checks; metadata only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_project_orientation",
    description: "Return compact README/AGENTS orientation nodes for project navigation. Returns JSON with schema, totalNodes, returnedNodes, and nodes[] containing orientationId, kind, folder, file, title, purpose, useWhen, doNotUseFirstWhen, startHere, and childFolders. Metadata only; not source behavior evidence.",
    inputSchema: {
      type: "object",
      properties: {
        maxNodes: { type: "number", description: "Maximum nodes to return. Default 12, max 50." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_orientation_nodes",
    description: "List indexed README/AGENTS orientation nodes as compact routing metadata. Returns JSON with totalNodes, returnedNodes, and nodes[]. If no orientation evidence is available, the tool is not exposed. Metadata only; not source behavior evidence.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum nodes to return. Default 200, max 500." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_orientation_node",
    description: "Return one structured README/AGENTS orientation node by folder, file, or orientationId. Returns the full node with headings, map, parent/child data, and content hash when available. If the node is not found, returns an error.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path, README/AGENTS file path, or orientationId." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_orientation",
    description: "Search README/AGENTS orientation metadata before source navigation. Returns JSON with query, totalNodes, returnedMatches, and matches[] containing compact orientation nodes plus matchKind. Matches are routing hints only; expand selected nodes with get_orientation_node before source navigation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search in title, purpose, use-when, boundaries, headings, and map fields." },
        limit: { type: "number", description: "Maximum matches. Default 20, max 100." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "find_symbol",
    description: "Find symbols by name or qualified name. Returns JSON with results[] and count; each result has symbolId, kind, name/qualifiedName, relativePath, startLine, endLine, and optional signature/container fields. If nothing matches, results is an empty array. Metadata only; use symbolId with read_symbol to get source.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or qualified name to search for." },
        exactOnly: { type: "boolean", description: "If true, only exact name/qualifiedName matches are returned." },
        compact: { type: "boolean", description: "If true, omit signature and modifier fields." },
        symbolTypes: { type: "array", items: { type: "string" }, description: "Filter by symbol kinds: class, interface, function, method, type_alias, enum, arrow_function, property, constructor, getter, setter, variable, namespace." },
        file: { type: "string", description: "Restrict to files matching this path fragment." },
        container: { type: "string", description: "Restrict to symbols inside this container class/namespace." },
        limit: { type: "number", description: "Maximum results to return. Default 20." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_symbol",
    description: "Read the exact source range for a symbol by symbolId. Returns JSON with symbol metadata, relativePath, startLine, endLine, and source lines with line numbers. If symbolId is unknown or the file is missing, returns an error. This is source evidence for the returned range only.",
    inputSchema: {
      type: "object",
      properties: {
        symbolId: { type: "string", description: "The symbolId returned by find_symbol or list_file_symbols." },
        startOffset: { type: "number", description: "Lines to offset the start (negative = expand upward)." },
        endOffset: { type: "number", description: "Lines to offset the end (positive = expand downward)." },
      },
      required: ["symbolId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_range",
    description: "Read an exact source range from a file by line numbers or around a center line. Returns JSON with file, startLine, endLine, and source lines with line numbers. If the file/range is invalid, returns an error. Use for compact source evidence around known locations.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
        startLine: { type: "number", description: "First line to read (1-based). Use with endLine." },
        endLine: { type: "number", description: "Last line to read (1-based). Use with startLine." },
        line: { type: "number", description: "Center line. Use with beforeLines/afterLines instead of startLine/endLine." },
        beforeLines: { type: "number", description: "Lines before center line." },
        afterLines: { type: "number", description: "Lines after center line." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "list_file_symbols",
    description: "List indexed symbols in a file. Returns JSON with file, fileId, symbolCount, and symbols[] containing ids, names, kinds, containers/signatures when requested, and line ranges. If the file is unknown, returns an error. Metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
        symbolTypes: { type: "array", items: { type: "string" }, description: "Filter by symbol kinds." },
        container: { type: "string", description: "Filter by containing class/namespace." },
        compact: { type: "boolean", description: "If true, omit signature and modifier fields." },
        limit: { type: "number", description: "Maximum results. Default 200." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "get_file_structure",
    description: "Return a file overview: metadata, symbol count, optional ordered outline, and optional import list. Returns routing metadata only; source behavior still requires read_symbol or read_range. If the file is unknown, returns an error.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
        includeOutline: { type: "boolean", description: "Include ordered symbol outline. Default true." },
        includeImports: { type: "boolean", description: "Include import list. Default true." },
        compact: { type: "boolean", description: "Compact outline entries." },
        symbolTypes: { type: "array", items: { type: "string" }, description: "Filter outline by symbol kinds." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "list_file_imports",
    description: "List import statements in a file. Returns JSON with file, fileId, importCount, and imports[] containing module specifier, resolved path, kind, type-only/external flags, and source line. If none exist, imports is an empty array. Metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
        externalOnly: { type: "boolean", description: "Only return external (node_modules) imports." },
        projectOnly: { type: "boolean", description: "Only return project-local imports." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "list_file_imported_by",
    description: "List files that import a given file. Returns JSON with file, fileId, importedByCount, and importedBy[] entries with importer file and source line. If no importers are known, importedBy is an empty array. Metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
      },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "search_source",
    description: "Search for raw source text matches across the project or in a specific file. Returns JSON with query, matchCount, truncated, and matches[] containing relativePath, line, column, text, and optional context. If no lexical matches are found, matches is an empty array. This is raw text search only, not semantic reference resolution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex pattern to search for." },
        file: { type: "string", description: "Restrict search to files matching this path fragment." },
        useRegex: { type: "boolean", description: "Treat query as a regex pattern." },
        caseSensitive: { type: "boolean", description: "Case-sensitive search. Default false." },
        wholeWord: { type: "boolean", description: "Match whole identifiers only." },
        contextLines: { type: "number", description: "Lines of context around each match (0-5)." },
        limit: { type: "number", description: "Maximum matches to return. Default 50." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_symbol_leading_comment",
    description: "Return the leading JSDoc/block comment for a symbol. Returns hasComment, commentRange, and comment text when present; if no leading comment exists, returns hasComment:false and comment:null. Comment text is source evidence for stated intent, not runtime behavior proof.",
    inputSchema: {
      type: "object",
      properties: {
        symbolId: { type: "string", description: "The symbolId returned by find_symbol." },
      },
      required: ["symbolId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_nearest_symbol_for_line",
    description: "Return the indexed symbol at or nearest to a given line number in a file. Returns JSON with file, line, and symbol metadata including containsLine. If no symbol is nearby, symbol is null. Metadata only; read the symbol/range before behavior claims.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Relative file path or path fragment." },
        line: { type: "number", description: "Line number (1-based)." },
      },
      required: ["file", "line"],
      additionalProperties: false,
    },
  },
];

export const ORIENTATION_TOOL_NAMES = new Set([
  "get_project_orientation",
  "list_orientation_nodes",
  "get_orientation_node",
  "search_orientation",
]);

export function hasOrientationEvidence(index: LoadedIndex): boolean {
  return (index.manifest.orientationNodeCount ?? 0) > 0;
}

export function availableToolDefinitions(index: LoadedIndex): McpTool[] {
  if (hasOrientationEvidence(index)) return TOOL_DEFINITIONS;
  return TOOL_DEFINITIONS.filter((tool) => !ORIENTATION_TOOL_NAMES.has(tool.name));
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

export type ToolHandler = (args: Record<string, unknown>, index: LoadedIndex) => McpToolResult;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_project_summary: handleGetProjectSummary,
  get_index_state: handleGetIndexState,
  get_project_orientation: handleGetProjectOrientation,
  list_orientation_nodes: handleListOrientationNodes,
  get_orientation_node: handleGetOrientationNode,
  search_orientation: handleSearchOrientation,
  find_symbol: handleFindSymbol,
  read_symbol: handleReadSymbol,
  read_range: handleReadRange,
  list_file_symbols: handleListFileSymbols,
  get_file_structure: handleGetFileStructure,
  list_file_imports: handleListFileImports,
  list_file_imported_by: handleListFileImportedBy,
  search_source: handleSearchSource,
  get_symbol_leading_comment: handleGetSymbolLeadingComment,
  get_nearest_symbol_for_line: handleGetNearestSymbolForLine,
};

export function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  index: LoadedIndex,
): McpToolResult {
  if (ORIENTATION_TOOL_NAMES.has(toolName) && !hasOrientationEvidence(index)) {
    return errorResult("Orientation evidence is not available for this index.");
  }
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return errorResult(`Unknown tool: ${toolName}`);
  }
  try {
    return handler(args, index);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(`Tool error: ${message}`);
  }
}
