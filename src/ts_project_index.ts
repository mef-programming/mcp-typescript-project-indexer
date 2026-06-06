/**
 * ts_project_index.ts
 *
 * Build a complete project index over all TypeScript/JavaScript source files.
 * Writes per-file JSON indexes and the SQLite routing index.
 *
 * Mirrors the C++ indexer build_project_index.py approach.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { FileIndex, ProjectManifest } from "./ts_index_model";
import {
  INDEXER_NAME,
  INDEXER_VERSION,
  SCHEMA_NAME,
} from "./ts_index_model";
import { buildFileIndex } from "./ts_file_index";
import { SqliteIndexWriter } from "./ts_index_sqlite";
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXTENSIONS,
  discoverSourceFiles,
  fileContentHash,
  fileIdFromRelativePath,
  nowIso,
  sha256Hex,
  stableJson,
  toRelativePath,
} from "./ts_index_utils";

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

export type BuildProjectIndexOptions = {
  projectRoot: string;
  indexRoot: string;
  extensions?: string[];
  excludeDirs?: Set<string>;
  jobs?: number;
  onProgress?: (done: number, total: number, file: string) => void;
  onError?: (file: string, error: Error) => void;
};

export type BuildProjectIndexResult = {
  manifest: ProjectManifest;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  exportCount: number;
  diagnosticsCount: number;
  totalLineCount: number;
  totalTokenCount: number;
  durationMs: number;
  errors: Array<{ file: string; message: string }>;
};

// ---------------------------------------------------------------------------
// Per-file JSON path
// ---------------------------------------------------------------------------

function fileIndexPath(indexRoot: string, fileId: string): string {
  return path.join(indexRoot, "files", `${fileId}.json`);
}

function deleteFileIndex(indexRoot: string, fileId: string): void {
  try {
    fs.unlinkSync(fileIndexPath(indexRoot, fileId));
  } catch {
    // State/SQLite can outlive a missing per-file JSON cache entry.
  }
}

// ---------------------------------------------------------------------------
// State hash
// ---------------------------------------------------------------------------

function computeStateHash(indexes: FileIndex[]): string {
  const parts = indexes
    .map((idx) => `${idx.relativePath}:${idx.contentHash}`)
    .sort()
    .join("\n");
  return `sha256:${sha256Hex(parts).slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Update state (for incremental updates)
// ---------------------------------------------------------------------------

type UpdateState = {
  updatedAt: string;
  files: Record<string, { contentHash: string; fileId: string }>;
};

function loadUpdateState(indexRoot: string): UpdateState {
  const statePath = path.join(indexRoot, "update_state.json");
  if (!fs.existsSync(statePath)) {
    return { updatedAt: "", files: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as UpdateState;
  } catch {
    return { updatedAt: "", files: {} };
  }
}

function saveUpdateState(indexRoot: string, state: UpdateState): void {
  const statePath = path.join(indexRoot, "update_state.json");
  fs.writeFileSync(statePath, stableJson(state), "utf-8");
}

// ---------------------------------------------------------------------------
// Main build function
// ---------------------------------------------------------------------------

export async function buildProjectIndex(
  options: BuildProjectIndexOptions,
): Promise<BuildProjectIndexResult> {
  const {
    projectRoot,
    indexRoot,
    extensions = DEFAULT_EXTENSIONS,
    excludeDirs = DEFAULT_EXCLUDE_DIRS,
    jobs = Math.max(1, os.cpus().length - 1),
    onProgress,
    onError,
  } = options;

  const startMs = Date.now();

  // Prepare output directories
  fs.mkdirSync(indexRoot, { recursive: true });
  const filesDir = path.join(indexRoot, "files");
  fs.rmSync(filesDir, { recursive: true, force: true });
  fs.mkdirSync(filesDir, { recursive: true });

  // Discover source files
  const absolutePaths = discoverSourceFiles(
    projectRoot,
    extensions,
    excludeDirs,
  );

  const total = absolutePaths.length;
  let done = 0;
  let symbolCount = 0;
  let importCount = 0;
  let exportCount = 0;
  let diagnosticsCount = 0;
  let totalLineCount = 0;
  let totalTokenCount = 0;
  const errors: Array<{ file: string; message: string }> = [];
  const allIndexes: FileIndex[] = [];

  // Open SQLite writer
  const writer = new SqliteIndexWriter(indexRoot);

  // Process files — simple sequential for now, parallel in next iteration
  for (const absolutePath of absolutePaths) {
    const relativePath = toRelativePath(absolutePath, projectRoot);

    try {
      const index = buildFileIndex({ absolutePath, projectRoot });

      // Write per-file JSON
      const jsonPath = fileIndexPath(indexRoot, index.fileId);
      fs.writeFileSync(jsonPath, stableJson(index), "utf-8");

      // Write to SQLite
      writer.writeFileIndex(index);

      // Accumulate stats
      symbolCount += index.symbols.length;
      importCount += index.imports.length;
      exportCount += index.exports.length;
      diagnosticsCount += index.diagnostics.length;
      totalLineCount += index.lineCount;
      totalTokenCount += index.tokenCount;
      allIndexes.push(index);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push({ file: relativePath, message: error.message });
      onError?.(relativePath, error);
    }

    done++;
    onProgress?.(done, total, relativePath);
  }

  writer.close();

  // Compute state hash
  const stateHash = computeStateHash(allIndexes);

  // Write manifest
  const manifest: ProjectManifest = {
    schema: SCHEMA_NAME,
    indexer: INDEXER_NAME,
    indexerVersion: INDEXER_VERSION,
    projectRoot: projectRoot.replace(/\\/g, "/"),
    indexRoot: indexRoot.replace(/\\/g, "/"),
    generatedAt: nowIso(),
    fileCount: allIndexes.length,
    symbolCount,
    importCount,
    exportCount,
    diagnosticsCount,
    totalLineCount,
    totalTokenCount,
    stateHash,
  };

  fs.writeFileSync(
    path.join(indexRoot, "manifest.json"),
    stableJson(manifest),
    "utf-8",
  );

  // Write update state
  const updateState: UpdateState = {
    updatedAt: nowIso(),
    files: {},
  };
  for (const index of allIndexes) {
    updateState.files[index.relativePath] = {
      contentHash: index.contentHash,
      fileId: index.fileId,
    };
  }
  saveUpdateState(indexRoot, updateState);

  const durationMs = Date.now() - startMs;

  return {
    manifest,
    fileCount: allIndexes.length,
    symbolCount,
    importCount,
    exportCount,
    diagnosticsCount,
    totalLineCount,
    totalTokenCount,
    durationMs,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Incremental update
// ---------------------------------------------------------------------------

export type UpdateProjectIndexOptions = {
  projectRoot: string;
  indexRoot: string;
  extensions?: string[];
  excludeDirs?: Set<string>;
  changedFiles?: string[];
  knownFilesOnly?: boolean;
  onProgress?: (done: number, total: number, file: string) => void;
  onError?: (file: string, error: Error) => void;
};

export async function updateProjectIndex(
  options: UpdateProjectIndexOptions,
): Promise<BuildProjectIndexResult> {
  const {
    projectRoot,
    indexRoot,
    extensions = DEFAULT_EXTENSIONS,
    excludeDirs = DEFAULT_EXCLUDE_DIRS,
    changedFiles,
    knownFilesOnly = false,
    onProgress,
    onError,
  } = options;

  const startMs = Date.now();
  const state = loadUpdateState(indexRoot);

  // Determine which files to check
  let candidatePaths: string[];

  if (changedFiles && changedFiles.length > 0) {
    // Explicit changed files — only check these
    candidatePaths = changedFiles.map((f) => path.resolve(projectRoot, f));
  } else if (knownFilesOnly) {
    // Only re-check already indexed files
    candidatePaths = Object.keys(state.files).map((rel) =>
      path.resolve(projectRoot, rel),
    );
  } else {
    // Full discovery
    candidatePaths = discoverSourceFiles(projectRoot, extensions, excludeDirs);
  }

  const writer = new SqliteIndexWriter(indexRoot);

  if (!changedFiles?.length && !knownFilesOnly) {
    const currentRelativePaths = new Set(
      candidatePaths.map((absolutePath) => toRelativePath(absolutePath, projectRoot)),
    );
    for (const [relativePath, entry] of Object.entries(state.files)) {
      if (currentRelativePaths.has(relativePath)) continue;
      writer.deleteFile(entry.fileId);
      deleteFileIndex(indexRoot, entry.fileId);
      delete state.files[relativePath];
    }
  }

  const errors: Array<{ file: string; message: string }> = [];
  let symbolCount = 0;
  let importCount = 0;
  let exportCount = 0;
  let diagnosticsCount = 0;
  let totalLineCount = 0;
  let totalTokenCount = 0;
  let done = 0;
  const total = candidatePaths.length;
  const updatedIndexes: FileIndex[] = [];

  for (const absolutePath of candidatePaths) {
    const relativePath = toRelativePath(absolutePath, projectRoot);
    const knownEntry = state.files[relativePath];
    if (!fs.existsSync(absolutePath)) {
      if (knownEntry) {
        writer.deleteFile(knownEntry.fileId);
        deleteFileIndex(indexRoot, knownEntry.fileId);
        delete state.files[relativePath];
      }
      done++;
      onProgress?.(done, total, relativePath);
      continue;
    }

    const currentHash = fileContentHash(absolutePath);

    // Skip if unchanged
    if (knownEntry && knownEntry.contentHash === currentHash) {
      done++;
      onProgress?.(done, total, relativePath);
      continue;
    }

    try {
      const index = buildFileIndex({ absolutePath, projectRoot });

      // Write per-file JSON
      const jsonPath = fileIndexPath(indexRoot, index.fileId);
      fs.writeFileSync(jsonPath, stableJson(index), "utf-8");

      // Update SQLite
      writer.writeFileIndex(index);

      // Update state
      state.files[relativePath] = {
        contentHash: index.contentHash,
        fileId: index.fileId,
      };

      symbolCount += index.symbols.length;
      importCount += index.imports.length;
      exportCount += index.exports.length;
      diagnosticsCount += index.diagnostics.length;
      totalLineCount += index.lineCount;
      totalTokenCount += index.tokenCount;
      updatedIndexes.push(index);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push({ file: relativePath, message: error.message });
      onError?.(relativePath, error);
    }

    done++;
    onProgress?.(done, total, relativePath);
  }

  writer.close();

  // Save updated state
  state.updatedAt = nowIso();
  saveUpdateState(indexRoot, state);

  // Re-read manifest to update stats
  const manifestPath = path.join(indexRoot, "manifest.json");
  let manifest: ProjectManifest;

  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
    manifest.generatedAt = nowIso();
  } catch {
    // No existing manifest — create minimal one
    manifest = {
      schema: SCHEMA_NAME,
      indexer: INDEXER_NAME,
      indexerVersion: INDEXER_VERSION,
      projectRoot: projectRoot.replace(/\\/g, "/"),
      indexRoot: indexRoot.replace(/\\/g, "/"),
      generatedAt: nowIso(),
      fileCount: Object.keys(state.files).length,
      symbolCount,
      importCount,
      exportCount,
      diagnosticsCount,
      totalLineCount,
      totalTokenCount,
      stateHash: sha256Hex(nowIso()),
    };
  }

  fs.writeFileSync(manifestPath, stableJson(manifest), "utf-8");

  return {
    manifest,
    fileCount: updatedIndexes.length,
    symbolCount,
    importCount,
    exportCount,
    diagnosticsCount,
    totalLineCount,
    totalTokenCount,
    durationMs: Date.now() - startMs,
    errors,
  };
}
