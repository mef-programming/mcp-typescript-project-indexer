/**
 * ts_module_scan.ts
 *
 * Build a module map from the per-file indexes.
 * Maps import/export relationships between project files.
 *
 * This is the TypeScript equivalent of the C++ indexer's module_map.json.
 * Instead of C++20 modules, it maps ES module imports/exports and barrel files.
 */

import * as fs from "fs";
import * as path from "path";
import type { FileIndex, ModuleMap, ModuleMapEntry, ExportKind } from "./ts_index_model";
import { nowIso, stableJson } from "./ts_index_utils";

// ---------------------------------------------------------------------------
// Barrel file detection
// ---------------------------------------------------------------------------

/**
 * A barrel file is an index.ts/index.js that primarily re-exports from other files.
 */
function isBarrelFile(index: FileIndex): boolean {
  const baseName = path.basename(index.relativePath).replace(path.extname(index.relativePath), "");
  if (baseName !== "index") return false;

  // A barrel has mostly re-exports and few own symbols
  const reExports = index.exports.filter(
    (e) => e.kind === "re_export" || e.kind === "export_all",
  );
  const ownSymbols = index.symbols.filter(
    (s) => s.kind !== "variable" && s.kind !== "property",
  );
  return reExports.length > 0 && reExports.length >= ownSymbols.length;
}

// ---------------------------------------------------------------------------
// Build module map
// ---------------------------------------------------------------------------

export type BuildModuleMapOptions = {
  indexRoot: string;
};

export function buildModuleMap(options: BuildModuleMapOptions): ModuleMap {
  const { indexRoot } = options;
  const filesDir = path.join(indexRoot, "files");

  if (!fs.existsSync(filesDir)) {
    throw new Error(`Files directory not found: ${filesDir}`);
  }

  // Load all file indexes
  const fileIndexes: FileIndex[] = [];
  const entries = fs.readdirSync(filesDir);

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(filesDir, entry);
    try {
      const index = JSON.parse(fs.readFileSync(filePath, "utf-8")) as FileIndex;
      fileIndexes.push(index);
    } catch {
      // Skip malformed files
    }
  }

  // Build the map
  const moduleEntries: Record<string, ModuleMapEntry> = {};
  const unresolvedImports: Array<{ fromFile: string; moduleSpecifier: string }> = [];

  // First pass: create entries for each file
  for (const index of fileIndexes) {
    const entry: ModuleMapEntry = {
      relativePath: index.relativePath,
      fileId: index.fileId,
      isBarrel: isBarrelFile(index),
      imports: index.imports
        .filter((imp) => !imp.isExternal)
        .map((imp) => ({
          moduleSpecifier: imp.moduleSpecifier,
          resolvedRelativePath: imp.resolvedRelativePath,
          isExternal: false,
          isTypeOnly: imp.isTypeOnly,
        })),
      importedBy: [],
      exports: index.exports.map((exp) => ({
        name: exp.name,
        kind: exp.kind,
        isTypeOnly: exp.isTypeOnly,
      })),
    };

    moduleEntries[index.relativePath] = entry;

    // Track unresolved imports
    for (const imp of index.imports) {
      if (!imp.isExternal && !imp.resolvedRelativePath) {
        unresolvedImports.push({
          fromFile: index.relativePath,
          moduleSpecifier: imp.moduleSpecifier,
        });
      }
    }
  }

  // Second pass: build importedBy relationships
  for (const index of fileIndexes) {
    for (const imp of index.imports) {
      if (imp.isExternal || !imp.resolvedRelativePath) continue;
      const target = moduleEntries[imp.resolvedRelativePath];
      if (target && !target.importedBy.includes(index.relativePath)) {
        target.importedBy.push(index.relativePath);
      }
    }
  }

  const moduleMap: ModuleMap = {
    generatedAt: nowIso(),
    fileCount: fileIndexes.length,
    entries: moduleEntries,
    unresolvedImports,
  };

  // Write to disk
  const outputPath = path.join(indexRoot, "module_map.json");
  fs.writeFileSync(outputPath, stableJson(moduleMap), "utf-8");

  return moduleMap;
}

// ---------------------------------------------------------------------------
// Load module map
// ---------------------------------------------------------------------------

export function loadModuleMap(indexRoot: string): ModuleMap | null {
  const mapPath = path.join(indexRoot, "module_map.json");
  if (!fs.existsSync(mapPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(mapPath, "utf-8")) as ModuleMap;
  } catch {
    return null;
  }
}
