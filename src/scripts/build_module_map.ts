/**
 * build_module_map.ts
 *
 * CLI: Build the module map from existing per-file indexes.
 *
 * Usage:
 *   node dist/scripts/build_module_map.js --index-root <index-root>
 */

import * as path from "path";
import { buildModuleMap } from "../ts_module_scan";

function parseArgs(): { indexRoot: string } {
  const args = process.argv.slice(2);
  let indexRoot: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--index-root" && args[i + 1]) {
      indexRoot = path.resolve(args[++i]!);
    }
  }

  if (!indexRoot) {
    console.error("Error: --index-root is required");
    process.exit(1);
  }

  return { indexRoot };
}

function main(): void {
  const { indexRoot } = parseArgs();

  console.log(`Building module map from: ${indexRoot}`);
  const map = buildModuleMap({ indexRoot });

  const barrelCount = Object.values(map.entries).filter((e) => e.isBarrel).length;
  const withImportedBy = Object.values(map.entries).filter(
    (e) => e.importedBy.length > 0,
  ).length;

  console.log(`Files:             ${map.fileCount}`);
  console.log(`Barrel files:      ${barrelCount}`);
  console.log(`Files imported by: ${withImportedBy}`);
  console.log(`Unresolved:        ${map.unresolvedImports.length}`);
  console.log(`Written:           ${indexRoot}/module_map.json`);
}

main();
