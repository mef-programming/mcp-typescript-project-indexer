# Source Runtime

Purpose: TypeScript source for the standalone TypeScript/JavaScript project indexer.

Use this folder when the question is about:

- TypeScript/JavaScript structural scanning
- project index build and incremental update behavior
- SQLite lookup index writing and reading
- MCP tool definitions, dispatch, and result shaping
- optional project-local MCP prompt support from `indexer-prompt.md`
- HTTP management API, log events, commands, and embedded UI serving
- README/AGENTS/topology orientation metadata extraction
- polling watcher behavior for server-side index updates

Do not use this folder first when the question is about:

- browser-side management UI layout
- generated `dist/` output
- root package scripts or publishing metadata
- downstream MCP client configuration

## Map

```text
http_server.ts          HTTP MCP transport, management API, commands, watcher wiring
mcp_server.ts           stdio MCP server
mcp_tools.ts            MCP tool schemas, handlers, dynamic orientation exposure
mcp_types.ts            JSON-RPC and MCP result types
project_prompt.ts      optional indexer-prompt.md MCP prompt support
ts_change_tracking.ts   git/worktree change and hunk routing helpers
ts_file_index.ts        per-file source range and leading-comment helpers
ts_index_model.ts       manifest, file, symbol, import/export data shapes
ts_index_sqlite.ts      SQLite writer/reader for lookup indexes
ts_index_utils.ts       IDs, hashing, paths, JSON, and file discovery helpers
ts_module_scan.ts       import/export relationship map
ts_orientation_index.ts README/AGENTS/topology discovery and orientation metadata
ts_project_index.ts     full and incremental project indexing pipeline
ts_structural_scan.ts   TypeScript Compiler API structural scanner
ts_watcher.ts           polling watcher and incremental update trigger
```

## Start Here

- MCP tool surface and handlers: `mcp_tools.ts`
- Project prompt support: `project_prompt.ts`
- HTTP transport and management API: `http_server.ts`
- Full/incremental index pipeline: `ts_project_index.ts`
- TypeScript AST scanner: `ts_structural_scan.ts`
- SQLite lookup storage: `ts_index_sqlite.ts`
- Orientation documents: `ts_orientation_index.ts`
- Watcher behavior: `ts_watcher.ts`

## Boundaries

This folder owns the standalone TypeScript indexer runtime and scanner. It is
not the multi-language monorepo shared core. Browser UI assets belong in
`server_ui`, and generated JavaScript belongs in `dist`.
