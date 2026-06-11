# Server UI

Purpose: Embedded browser management UI served by the standalone TypeScript project indexer.

Use this folder when the question is about:

- management page layout or styling for the standalone TypeScript indexer
- status badges, process stats, watcher state, and index counters
- command buttons for build, module map, and reload
- server log display and token handling in the browser
- browser-facing assets served from `/server/ui/*`

Do not use this folder first when the question is about:

- MCP tool implementation
- HTTP management endpoint behavior
- TypeScript scanner extraction logic
- project index persistence
- generated `dist/` output

## Map

```text
index.html  management page shell
app.js      browser-side status, command, log, and token behavior
styles.css  management UI styling
```

## Start Here

- Page structure: `index.html`
- Browser-side behavior: `app.js`
- Visual badges, panels, and layout: `styles.css`

## Boundaries

This UI consumes management endpoints from `src/http_server.ts`. It should not
duplicate indexing logic, MCP tool dispatch, or TypeScript scanner behavior.
