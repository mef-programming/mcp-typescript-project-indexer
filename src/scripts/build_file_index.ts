/**
 * build_file_index.ts
 *
 * CLI: Index a single TypeScript/JavaScript file and write the result as JSON.
 *
 * Usage:
 *   node dist/scripts/build_file_index.js \
 *     --file <absolute-path-to-file> \
 *     --project-root <project-root> \
 *     --output <output.json>
 */

import * as fs from "fs";
import * as path from "path";
import { buildFileIndex } from "../ts_file_index";
import { stableJson } from "../ts_index_utils";

function parseArgs(): {
  file: string;
  projectRoot: string;
  output: string | null;
} {
  const args = process.argv.slice(2);
  let file: string | null = null;
  let projectRoot: string | null = null;
  let output: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      file = path.resolve(args[++i]!);
    } else if (args[i] === "--project-root" && args[i + 1]) {
      projectRoot = path.resolve(args[++i]!);
    } else if (args[i] === "--output" && args[i + 1]) {
      output = path.resolve(args[++i]!);
    }
  }

  if (!file) {
    console.error("Error: --file is required");
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    process.exit(1);
  }

  // Default project root: file's parent directory
  if (!projectRoot) {
    projectRoot = path.dirname(file);
  }

  return { file, projectRoot, output };
}

function main(): void {
  const { file, projectRoot, output } = parseArgs();

  console.error(`Indexing: ${file}`);
  console.error(`Project root: ${projectRoot}`);

  const index = buildFileIndex({
    absolutePath: file,
    projectRoot,
  });

  const json = stableJson(index);

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json, "utf-8");
    console.error(`Written: ${output}`);
  } else {
    process.stdout.write(json + "\n");
  }

  // Summary
  console.error(`File:     ${index.relativePath}`);
  console.error(`Symbols:  ${index.symbols.length}`);
  console.error(`Imports:  ${index.imports.length}`);
  console.error(`Exports:  ${index.exports.length}`);
  console.error(`Lines:    ${index.lineCount}`);
  console.error(`Tokens:   ${index.tokenCount}`);
  if (index.diagnostics.length > 0) {
    console.error(`Diagnostics: ${index.diagnostics.length}`);
  }
}

main();
