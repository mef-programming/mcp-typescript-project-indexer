/**
 * build_project_index.ts
 *
 * CLI: Build a complete project index for a TypeScript/JavaScript project.
 *
 * Usage:
 *   node dist/scripts/build_project_index.js \
 *     --root <project-root> \
 *     --output-root <index-root>
 *
 * Defaults:
 *   --root:         current working directory
 *   --output-root:  <root>/.mcp-ts-project-indexer
 */

import * as path from "path";
import * as process from "process";
import { buildProjectIndex } from "../ts_project_index";

function parseArgs(): { root: string; outputRoot: string } {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let outputRoot: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[++i]!);
    } else if (args[i] === "--output-root" && args[i + 1]) {
      outputRoot = path.resolve(args[++i]!);
    }
  }

  if (!outputRoot) {
    outputRoot = path.join(root, ".mcp-ts-project-indexer");
  }

  return { root, outputRoot };
}

async function main(): Promise<void> {
  const { root, outputRoot } = parseArgs();

  console.log(`Building TypeScript project index`);
  console.log(`Root:   ${root}`);
  console.log(`Output: ${outputRoot}`);
  console.log();

  let lastPct = -1;

  const result = await buildProjectIndex({
    projectRoot: root,
    indexRoot: outputRoot,
    onProgress: (done, total, file) => {
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct) {
        process.stdout.write(`\r  ${String(done).padStart(5)} / ${total} (${pct}%)`);
        lastPct = pct;
      }
    },
    onError: (file, error) => {
      process.stderr.write(`\n  Error: ${file}: ${error.message}\n`);
    },
  });

  console.log("\n");
  console.log(`Built ts.project_index.v1`);
  console.log(`Root:        ${root}`);
  console.log(`Output:      ${outputRoot}`);
  console.log(`Files:       ${result.fileCount}`);
  console.log(`Symbols:     ${result.symbolCount}`);
  console.log(`Imports:     ${result.importCount}`);
  console.log(`Exports:     ${result.exportCount}`);
  console.log(`Diagnostics: ${result.diagnosticsCount}`);
  console.log(`Lines:       ${result.totalLineCount}`);
  console.log(`Tokens:      ${result.totalTokenCount}`);
  console.log(`Duration:    ${(result.durationMs / 1000).toFixed(1)}s`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`  ${e.file}: ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
