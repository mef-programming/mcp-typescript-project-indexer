/**
 * ts_file_index.ts
 *
 * Build a FileIndex for a single TypeScript/JavaScript source file.
 * This is the per-file unit of the index — one JSON per file.
 */

import * as fs from "fs";
import type { FileIndex } from "./ts_index_model";
import {
  INDEXER_NAME,
  INDEXER_VERSION,
  SCANNER_VERSION,
  SCHEMA_NAME,
} from "./ts_index_model";
import { scanFile } from "./ts_structural_scan";
import {
  approximateTokenCount,
  fileContentHash,
  fileIdFromRelativePath,
  nowIso,
  toRelativePath,
} from "./ts_index_utils";

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export type BuildFileIndexOptions = {
  absolutePath: string;
  projectRoot: string;
};

// ---------------------------------------------------------------------------
// Build a file index
// ---------------------------------------------------------------------------

export function buildFileIndex(options: BuildFileIndexOptions): FileIndex {
  const { absolutePath, projectRoot } = options;

  const relativePath = toRelativePath(absolutePath, projectRoot);
  const fileId = fileIdFromRelativePath(relativePath);

  // Read source
  const sourceText = fs.readFileSync(absolutePath, "utf-8");
  const contentHash = fileContentHash(absolutePath);
  const lineCount = sourceText.split(/\r?\n/).length;
  const tokenCount = approximateTokenCount(sourceText);

  // Scan
  const scanResult = scanFile({
    fileId,
    relativePath,
    absolutePath,
    projectRoot,
    sourceText,
  });

  return {
    schema: SCHEMA_NAME,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    scannerVersion: SCANNER_VERSION,
    fileId,
    relativePath,
    contentHash,
    indexedAt: nowIso(),
    lineCount,
    tokenCount,
    symbols: scanResult.symbols,
    imports: scanResult.imports,
    exports: scanResult.exports,
    diagnostics: scanResult.diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Read source range from a file
// ---------------------------------------------------------------------------

export function readSourceRange(
  absolutePath: string,
  startLine: number,
  endLine: number,
  beforeLines = 0,
  afterLines = 0,
): string {
  const source = fs.readFileSync(absolutePath, "utf-8");
  const lines = source.split(/\r?\n/);

  const from = Math.max(0, startLine - 1 - beforeLines);
  const to = Math.min(lines.length, endLine + afterLines);

  return lines
    .slice(from, to)
    .map((line, i) => {
      const lineNum = from + i + 1;
      return `${String(lineNum).padStart(5)} | ${line}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Read leading comment for a symbol
// ---------------------------------------------------------------------------

export function readLeadingComment(
  absolutePath: string,
  startLine: number,
  endLine: number,
): string {
  const source = fs.readFileSync(absolutePath, "utf-8");
  const lines = source.split(/\r?\n/);
  const from = Math.max(0, startLine - 1);
  const to = Math.min(lines.length, endLine);
  return lines.slice(from, to).join("\n");
}
