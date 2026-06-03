/**
 * ts_index_utils.ts
 *
 * Shared utility functions for the TypeScript indexer.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function fileContentHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// File ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable file ID from the relative path.
 * Mirrors the C++ indexer f_<pathHash> convention.
 */
export function fileIdFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  return `f_${sha256Hex(normalized).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Symbol ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable symbol ID from file ID + qualified name + start line + order.
 * Uses order to prevent hash collisions for symbols with identical names at same line.
 */
export function symbolId(
  fileId: string,
  qualifiedName: string,
  startLine: number,
  order = 0,
): string {
  return `s_${sha256Hex(`${fileId}\n${qualifiedName}\n${startLine}\n${order}`).slice(0, 24)}`;
}

/**
 * Generate a stable import ID.
 */
export function importId(
  fileId: string,
  moduleSpecifier: string,
  line: number,
): string {
  return `i_${sha256Hex(`${fileId}\n${moduleSpecifier}\n${line}`).slice(0, 24)}`;
}

/**
 * Generate a stable export ID.
 */
export function exportId(
  fileId: string,
  name: string | null,
  kind: string,
  line: number,
): string {
  return `e_${sha256Hex(`${fileId}\n${name ?? ""}\n${kind}\n${line}`).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Normalize a path to use forward slashes.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Get the relative path from a project root.
 */
export function toRelativePath(absolutePath: string, projectRoot: string): string {
  return normalizePath(path.relative(projectRoot, absolutePath));
}

/**
 * Resolve a module specifier relative to a source file.
 * Returns null for external modules (node_modules, etc.).
 */
export function resolveModuleSpecifier(
  moduleSpecifier: string,
  sourceFilePath: string,
  projectRoot: string,
  extensions: string[],
): string | null {
  // External module — not a relative or absolute path
  if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
    return null;
  }

  const sourceDir = path.dirname(sourceFilePath);
  const resolved = path.resolve(sourceDir, moduleSpecifier);

  // Try exact match first
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return toRelativePath(resolved, projectRoot);
  }

  // Try with extensions
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (fs.existsSync(withExt)) {
      return toRelativePath(withExt, projectRoot);
    }
  }

  // Try index file in directory
  for (const ext of extensions) {
    const indexFile = path.join(resolved, `index${ext}`);
    if (fs.existsSync(indexFile)) {
      return toRelativePath(indexFile, projectRoot);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token counting (approximate)
// ---------------------------------------------------------------------------

/**
 * Approximate token count for a source file.
 * Uses whitespace/punctuation splitting — not LLM billing tokens.
 */
export function approximateTokenCount(source: string): number {
  return source.split(/[\s\r\n\t,;(){}[\]<>.:+\-*\/=!&|^~@#$%`'"?\\]+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Safe JSON
// ---------------------------------------------------------------------------

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

export const DEFAULT_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
];

export const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".git",
  ".vs",
  ".idea",
  ".cache",
  "coverage",
  "__pycache__",
]);

/**
 * Recursively discover all source files in a directory.
 */
export function discoverSourceFiles(
  rootDir: string,
  extensions: string[] = DEFAULT_EXTENSIONS,
  excludeDirs: Set<string> = DEFAULT_EXCLUDE_DIRS,
): string[] {
  const result: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name) && !entry.name.startsWith(".")) {
          walk(fullPath);
        }
        continue;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          result.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return result;
}
