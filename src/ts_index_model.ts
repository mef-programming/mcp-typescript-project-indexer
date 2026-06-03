/**
 * ts_index_model.ts
 *
 * Core data model for the TypeScript/JavaScript project indexer.
 * Mirrors the structure of the C++ indexer model, adapted for TS/JS semantics.
 */

export const SCHEMA_NAME = "ts.file_index.v1";
export const INDEXER_NAME = "mcp-typescript-project-indexer";
export const INDEXER_VERSION = "0.1";
export const SCANNER_VERSION = "ts-structural-scan.v1";

// ---------------------------------------------------------------------------
// Symbol kinds
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "namespace"
  | "module"
  | "class"
  | "class_declaration"
  | "abstract_class"
  | "interface"
  | "enum"
  | "enum_member"
  | "type_alias"
  | "function"
  | "function_declaration"
  | "method"
  | "method_declaration"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow_function"
  | "variable"
  | "property"
  | "parameter"
  | "decorator"
  | "unknown";

export const SYMBOL_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  "namespace",
  "module",
  "class",
  "class_declaration",
  "abstract_class",
  "interface",
  "enum",
  "enum_member",
  "type_alias",
  "function",
  "function_declaration",
  "method",
  "method_declaration",
  "constructor",
  "getter",
  "setter",
  "arrow_function",
  "variable",
  "property",
  "parameter",
  "decorator",
  "unknown",
]);

// ---------------------------------------------------------------------------
// Import / Export kinds
// ---------------------------------------------------------------------------

export type ImportKind =
  | "static_import"
  | "dynamic_import"
  | "require_call"
  | "type_import"
  | "side_effect_import"
  | "unknown_import";

export type ExportKind =
  | "named_export"
  | "default_export"
  | "re_export"
  | "export_all"
  | "type_export"
  | "unknown_export";

// ---------------------------------------------------------------------------
// Source range
// ---------------------------------------------------------------------------

export type SourceRange = {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
};

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

export type IndexedSymbol = {
  symbolId: string;
  fileId: string;
  relativePath: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  signature: string;
  container: string | null;
  isExported: boolean;
  isAsync: boolean;
  isAbstract: boolean;
  isStatic: boolean;
  isReadonly: boolean;
  range: SourceRange;
  leadingCommentRange?: SourceRange;
};

// ---------------------------------------------------------------------------
// Import record
// ---------------------------------------------------------------------------

export type ImportRecord = {
  importId: string;
  fileId: string;
  kind: ImportKind;
  moduleSpecifier: string;
  resolvedRelativePath: string | null;
  isExternal: boolean;
  namedBindings: string[];
  defaultBinding: string | null;
  namespaceBinding: string | null;
  isTypeOnly: boolean;
  line: number;
};

// ---------------------------------------------------------------------------
// Export record
// ---------------------------------------------------------------------------

export type ExportRecord = {
  exportId: string;
  fileId: string;
  kind: ExportKind;
  name: string | null;
  moduleSpecifier: string | null;
  resolvedRelativePath: string | null;
  isTypeOnly: boolean;
  line: number;
};

// ---------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------

export type FileIndex = {
  schema: string;
  indexer: string;
  indexerVersion: string;
  scannerVersion: string;
  fileId: string;
  relativePath: string;
  contentHash: string;
  indexedAt: string;
  lineCount: number;
  tokenCount: number;
  symbols: IndexedSymbol[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  diagnostics: IndexDiagnostic[];
};

// ---------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "parse_error"
  | "scan_error"
  | "unresolved_import"
  | "circular_import"
  | "large_file"
  | "unknown";

export type IndexDiagnostic = {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  message: string;
  range?: SourceRange;
};

// ---------------------------------------------------------------------------
// Project manifest
// ---------------------------------------------------------------------------

export type ProjectManifest = {
  schema: string;
  indexer: string;
  indexerVersion: string;
  projectRoot: string;
  indexRoot: string;
  generatedAt: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  exportCount: number;
  diagnosticsCount: number;
  totalLineCount: number;
  totalTokenCount: number;
  stateHash: string;
};

// ---------------------------------------------------------------------------
// Module map entry
// ---------------------------------------------------------------------------

export type ModuleMapEntry = {
  relativePath: string;
  fileId: string;
  isBarrel: boolean;
  imports: Array<{
    moduleSpecifier: string;
    resolvedRelativePath: string | null;
    isExternal: boolean;
    isTypeOnly: boolean;
  }>;
  importedBy: string[];
  exports: Array<{
    name: string | null;
    kind: ExportKind;
    isTypeOnly: boolean;
  }>;
};

export type ModuleMap = {
  generatedAt: string;
  fileCount: number;
  entries: Record<string, ModuleMapEntry>;
  unresolvedImports: Array<{
    fromFile: string;
    moduleSpecifier: string;
  }>;
};
