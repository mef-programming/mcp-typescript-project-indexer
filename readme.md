# mcp-typescript-project-indexer

Deterministic TypeScript/JavaScript source-range indexer for MCP-based AI code
navigation.

Its job is simple:

```text
Find code. Read code. Do not guess code.
```

The indexer maps TypeScript/JavaScript symbols, files, imports, and exports to
exact source ranges so an AI can read only the code it needs.

---

## 30-Second Overview

`mcp-typescript-project-indexer` builds a lightweight routing index over a
TypeScript/JavaScript source tree. MCP clients can then ask deterministic
questions such as:

- where is this function/class/interface/type?
- which exact source range should be read?
- which file imports or is imported by another file?
- which symbols exist in a given file?

The indexer returns metadata and original source ranges. It does not claim to
understand the program. The AI reads the returned source and reasons from that
evidence.

Minimal workflow:

```text
User asks about buildSubtaskUserMessage
-> find_symbol("buildSubtaskUserMessage")
-> read_symbol(symbolId)
-> AI explains only what was visible in that source range
```

---

## Quick Start

### 1. Install dependencies

```powershell
cd <indexer-root>
npm install
npm run build
```

### 2. Build an index for your TypeScript project

```powershell
node dist/scripts/build_project_index.js ^
  --root <project-root> ^
  --output-root <project-root>\.mcp-ts-project-indexer
```

### 3. Start the MCP server (stdio)

```powershell
node dist/mcp_server.js ^
  --project-root <project-root> ^
  --index-root <project-root>\.mcp-ts-project-indexer
```

### 4. Start the HTTP server

```powershell
node dist/http_server.js ^
  --project-root <project-root> ^
  --index-root <project-root>\.mcp-ts-project-indexer ^
  --http-host 127.0.0.1 ^
  --http-port 8766 ^
  --management-token <token>
```

### 5. MCP client configuration

HTTP (recommended for persistent servers):

```json
{
  "mcpServers": {
    "mcp-typescript-project-indexer": {
      "url": "http://127.0.0.1:8766/mcp"
    }
  }
}
```

Stdio:

```json
{
  "mcpServers": {
    "mcp-typescript-project-indexer": {
      "command": "node",
      "args": [
        "<indexer-root>\\dist\\mcp_server.js",
        "--project-root", "<project-root>",
        "--index-root", "<project-root>\\.mcp-ts-project-indexer"
      ]
    }
  }
}
```

---

## What It Does

The scanner uses the TypeScript Compiler API to extract routing facts:

- files and stable file IDs
- classes, interfaces, type aliases, enums
- functions, methods, constructors, getters, setters
- arrow functions (named, exported)
- import statements (static, dynamic, require, type-only)
- export statements (named, default, re-export, export-all)
- exact `startLine` / `endLine` for every symbol
- leading JSDoc/block comments
- barrel file detection

It is AST-based via `ts.createSourceFile`, not regex-based.

---

## What It Does Not Do

- no call graph
- no `find_references`
- no type resolution or inference
- no semantic analysis
- no refactoring
- no macro/decorator expansion

The AI reads source ranges and reasons from the original code.

---

## Output Layout

```text
<project-root>/.mcp-ts-project-indexer/
  manifest.json
  index.sqlite
  module_map.json
  update_state.json
  files/
    f_<pathHash>.json
```

---

## Tools

| Tool | Purpose |
|---|---|
| `get_project_summary` | Project overview: file count, symbols, imports, state hash |
| `get_index_state` | State fingerprint for cache validation |
| `find_symbol` | Find symbols by name or qualified name |
| `read_symbol` | Read exact source range for a symbol |
| `read_range` | Read arbitrary source lines from a file |
| `list_file_symbols` | List all symbols in a file |
| `get_file_structure` | File overview with optional outline and imports |
| `list_file_imports` | List import statements in a file |
| `list_file_imported_by` | List files that import a given file |
| `search_source` | Raw source text search (regex or literal) |
| `get_symbol_leading_comment` | Leading JSDoc/comment for a symbol |
| `get_nearest_symbol_for_line` | Map a line number to the nearest symbol |

All tools return metadata or exact source ranges. They do not analyze code.

---

## Incremental Update

After a full build, changed files can be re-indexed:

```powershell
node dist/scripts/build_project_index.js ^
  --root <project-root> ^
  --output-root <project-root>\.mcp-ts-project-indexer
```

The updater compares content hashes and only re-indexes changed files.

---

## Module Map

Build the import/export relationship graph:

```powershell
node dist/scripts/build_module_map.js ^
  --index-root <project-root>\.mcp-ts-project-indexer
```

The module map contains:
- per-file imports and exports
- resolved import paths
- importedBy relationships
- barrel file detection
- unresolved imports

---

## HTTP Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP JSON-RPC (tool calls) |
| `GET /health` | Health check |
| `GET /status` | Server status and index stats |
| `GET /server/ui/index.html` | Management UI |
| `GET /server/management/status` | Management status (auth) |
| `POST /server/management/command` | Build/Reload commands (auth) |
| `GET /server/management/log` | Log events (auth) |
| `GET /server/management/log/stream` | SSE live log stream (auth) |

Management endpoints require `x-api-key` or `Authorization: Bearer` when a
token is configured.

---

## Management Commands

```json
{ "command": "build" }
{ "command": "module_map" }
{ "command": "reload_index" }
```

---

## Performance

Tested on `mcp-model-relay` (175 TypeScript files, ~58k lines):

```text
Files:       175
Symbols:     4,588
Imports:     496
Lines:       57,779
Tokens:      195,346
Build time:  2.3s
```

---

## Design Rules

- The indexer is a table of contents, not a compiler.
- Metadata answers "where?" — source answers "what does the code say?"
- No semantic claims from metadata alone.
- Exact source ranges are central.
- Compact output first, escalate only when needed.

---

## Project Structure

```text
src/
  ts_index_model.ts        Data model
  ts_index_utils.ts        Utilities, file discovery, hashing
  ts_structural_scan.ts    TypeScript Compiler API scanner
  ts_file_index.ts         Per-file indexer
  ts_project_index.ts      Full project build + incremental update
  ts_index_sqlite.ts       SQLite routing index
  ts_module_scan.ts        Import/export module map
  ts_change_tracking.ts    Git-based change tracking
  mcp_types.ts             MCP protocol types
  mcp_tools.ts             Tool definitions and handlers
  mcp_server.ts            MCP server (stdio)
  http_server.ts           HTTP server + Management API
  scripts/
    build_project_index.ts CLI: full build
    build_file_index.ts    CLI: single file
    build_module_map.ts    CLI: module map
server_ui/
  index.html               Management UI
  app.js                   UI logic
  styles.css               UI styles
```

---

## License

Apache 2.0
