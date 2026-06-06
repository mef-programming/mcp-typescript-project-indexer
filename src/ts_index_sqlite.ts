/**
 * ts_index_sqlite.ts
 *
 * SQLite-backed routing index for fast symbol and file lookup.
 * Mirrors the C++ indexer index.sqlite approach.
 *
 * The SQLite index is the routing layer — it answers "where is X?"
 * The per-file JSON indexes remain the source of truth for exact source ranges.
 */

import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type { FileIndex, IndexedSymbol, ImportRecord } from "./ts_index_model";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const CREATE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  fileId      TEXT PRIMARY KEY,
  relativePath TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  lineCount   INTEGER NOT NULL,
  tokenCount  INTEGER NOT NULL,
  indexedAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  symbolId      TEXT PRIMARY KEY,
  fileId        TEXT NOT NULL REFERENCES files(fileId) ON DELETE CASCADE,
  relativePath  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  qualifiedName TEXT NOT NULL,
  signature     TEXT NOT NULL,
  container     TEXT,
  isExported    INTEGER NOT NULL DEFAULT 0,
  isAsync       INTEGER NOT NULL DEFAULT 0,
  isAbstract    INTEGER NOT NULL DEFAULT 0,
  isStatic      INTEGER NOT NULL DEFAULT 0,
  startLine     INTEGER NOT NULL,
  endLine       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  importId              TEXT PRIMARY KEY,
  fileId                TEXT NOT NULL REFERENCES files(fileId) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  moduleSpecifier       TEXT NOT NULL,
  resolvedRelativePath  TEXT,
  isExternal            INTEGER NOT NULL DEFAULT 0,
  isTypeOnly            INTEGER NOT NULL DEFAULT 0,
  line                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_name          ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified     ON symbols(qualifiedName COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_file          ON symbols(fileId);
CREATE INDEX IF NOT EXISTS idx_symbols_kind          ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_imports_file          ON imports(fileId);
CREATE INDEX IF NOT EXISTS idx_imports_resolved      ON imports(resolvedRelativePath);
CREATE INDEX IF NOT EXISTS idx_files_path            ON files(relativePath);
`;

// ---------------------------------------------------------------------------
// Index writer
// ---------------------------------------------------------------------------

export class SqliteIndexWriter {
  private db: Database.Database;

  constructor(indexRoot: string) {
    fs.mkdirSync(indexRoot, { recursive: true });
    const dbPath = path.join(indexRoot, "index.sqlite");
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(CREATE_SCHEMA);

    const version = this.db
      .prepare("SELECT version FROM schema_version LIMIT 1")
      .get() as { version: number } | undefined;

    if (!version) {
      this.db
        .prepare("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
    }
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM symbols").run();
      this.db.prepare("DELETE FROM imports").run();
      this.db.prepare("DELETE FROM files").run();
    })();
  }

  writeFileIndex(index: FileIndex): void {
    const tx = this.db.transaction(() => {
      // Remove existing data for this file
      this.db
        .prepare("DELETE FROM symbols WHERE fileId = ?")
        .run(index.fileId);
      this.db
        .prepare("DELETE FROM imports WHERE fileId = ?")
        .run(index.fileId);
      this.db
        .prepare("DELETE FROM files WHERE fileId = ?")
        .run(index.fileId);

      // Insert file
      this.db
        .prepare(`
          INSERT INTO files (fileId, relativePath, contentHash, lineCount, tokenCount, indexedAt)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          index.fileId,
          index.relativePath,
          index.contentHash,
          index.lineCount,
          index.tokenCount,
          index.indexedAt,
        );

      // Insert symbols
      const insertSymbol = this.db.prepare(`
        INSERT INTO symbols
          (symbolId, fileId, relativePath, kind, name, qualifiedName, signature,
           container, isExported, isAsync, isAbstract, isStatic, startLine, endLine)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const sym of index.symbols) {
        insertSymbol.run(
          sym.symbolId,
          sym.fileId,
          sym.relativePath,
          sym.kind,
          sym.name,
          sym.qualifiedName,
          sym.signature,
          sym.container ?? null,
          sym.isExported ? 1 : 0,
          sym.isAsync ? 1 : 0,
          sym.isAbstract ? 1 : 0,
          sym.isStatic ? 1 : 0,
          sym.range.startLine,
          sym.range.endLine,
        );
      }

      // Insert imports
      const insertImport = this.db.prepare(`
        INSERT INTO imports
          (importId, fileId, kind, moduleSpecifier, resolvedRelativePath,
           isExternal, isTypeOnly, line)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const imp of index.imports) {
        insertImport.run(
          imp.importId,
          imp.fileId,
          imp.kind,
          imp.moduleSpecifier,
          imp.resolvedRelativePath ?? null,
          imp.isExternal ? 1 : 0,
          imp.isTypeOnly ? 1 : 0,
          imp.line,
        );
      }
    });

    tx();
  }

  deleteFile(fileId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM symbols WHERE fileId = ?").run(fileId);
      this.db.prepare("DELETE FROM imports WHERE fileId = ?").run(fileId);
      this.db.prepare("DELETE FROM files WHERE fileId = ?").run(fileId);
    })();
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Index reader
// ---------------------------------------------------------------------------

export type SymbolRow = {
  symbolId: string;
  fileId: string;
  relativePath: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  container: string | null;
  isExported: number;
  isAsync: number;
  isAbstract: number;
  isStatic: number;
  startLine: number;
  endLine: number;
};

export type FileRow = {
  fileId: string;
  relativePath: string;
  contentHash: string;
  lineCount: number;
  tokenCount: number;
  indexedAt: string;
};

export type ImportRow = {
  importId: string;
  fileId: string;
  kind: string;
  moduleSpecifier: string;
  resolvedRelativePath: string | null;
  isExternal: number;
  isTypeOnly: number;
  line: number;
};

export class SqliteIndexReader {
  private db: Database.Database;

  constructor(indexRoot: string) {
    const dbPath = path.join(indexRoot, "index.sqlite");
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Index not found: ${dbPath}. Run build_project_index first.`);
    }
    this.db = new Database(dbPath, { readonly: true });
  }

  // ---------------------------------------------------------------------------
  // Symbol lookup
  // ---------------------------------------------------------------------------

  findSymbol(query: string, options: {
    exactOnly?: boolean;
    caseSensitive?: boolean;
    symbolTypes?: string[];
    file?: string;
    container?: string;
    limit?: number;
  } = {}): SymbolRow[] {
    const {
      exactOnly = false,
      caseSensitive = false,
      symbolTypes,
      file,
      container,
      limit = 50,
    } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (exactOnly) {
      if (caseSensitive) {
        conditions.push("(name = ? OR qualifiedName = ?)");
        params.push(query, query);
      } else {
        conditions.push("(name = ? COLLATE NOCASE OR qualifiedName = ? COLLATE NOCASE)");
        params.push(query, query);
      }
    } else {
      if (caseSensitive) {
        conditions.push("(name LIKE ? OR qualifiedName LIKE ?)");
        params.push(`%${query}%`, `%${query}%`);
      } else {
        conditions.push("(name LIKE ? COLLATE NOCASE OR qualifiedName LIKE ? COLLATE NOCASE)");
        params.push(`%${query}%`, `%${query}%`);
      }
    }

    if (symbolTypes && symbolTypes.length > 0) {
      const placeholders = symbolTypes.map(() => "?").join(", ");
      conditions.push(`kind IN (${placeholders})`);
      params.push(...symbolTypes);
    }

    if (file) {
      conditions.push("relativePath LIKE ? COLLATE NOCASE");
      params.push(`%${file}%`);
    }

    if (container) {
      conditions.push("container = ? COLLATE NOCASE");
      params.push(container);
    }

    params.push(limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM symbols ${where} ORDER BY name COLLATE NOCASE LIMIT ?`;

    return this.db.prepare(sql).all(...params) as SymbolRow[];
  }

  getSymbol(symbolId: string): SymbolRow | undefined {
    return this.db
      .prepare("SELECT * FROM symbols WHERE symbolId = ?")
      .get(symbolId) as SymbolRow | undefined;
  }

  listFileSymbols(fileId: string, options: {
    symbolTypes?: string[];
    container?: string;
    limit?: number;
  } = {}): SymbolRow[] {
    const { symbolTypes, container, limit = 200 } = options;
    const conditions: string[] = ["fileId = ?"];
    const params: unknown[] = [fileId];

    if (symbolTypes && symbolTypes.length > 0) {
      const placeholders = symbolTypes.map(() => "?").join(", ");
      conditions.push(`kind IN (${placeholders})`);
      params.push(...symbolTypes);
    }

    if (container) {
      conditions.push("container = ? COLLATE NOCASE");
      params.push(container);
    }

    params.push(limit);

    const sql = `
      SELECT * FROM symbols
      WHERE ${conditions.join(" AND ")}
      ORDER BY startLine
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...params) as SymbolRow[];
  }

  // ---------------------------------------------------------------------------
  // File lookup
  // ---------------------------------------------------------------------------

  getFile(fileIdOrPath: string): FileRow | undefined {
    // Try by fileId first
    let row = this.db
      .prepare("SELECT * FROM files WHERE fileId = ?")
      .get(fileIdOrPath) as FileRow | undefined;

    if (!row) {
      // Try by relative path (partial match)
      row = this.db
        .prepare("SELECT * FROM files WHERE relativePath LIKE ? COLLATE NOCASE LIMIT 1")
        .get(`%${fileIdOrPath}%`) as FileRow | undefined;
    }

    return row;
  }

  listFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files ORDER BY relativePath").all() as FileRow[];
  }

  // ---------------------------------------------------------------------------
  // Import lookup
  // ---------------------------------------------------------------------------

  getFileImports(fileId: string): ImportRow[] {
    return this.db
      .prepare("SELECT * FROM imports WHERE fileId = ? ORDER BY line")
      .all(fileId) as ImportRow[];
  }

  getImportedBy(resolvedRelativePath: string): ImportRow[] {
    return this.db
      .prepare("SELECT * FROM imports WHERE resolvedRelativePath = ? COLLATE NOCASE")
      .all(resolvedRelativePath) as ImportRow[];
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  getStats(): {
    fileCount: number;
    symbolCount: number;
    importCount: number;
  } {
    const fileCount = (this.db.prepare("SELECT COUNT(*) as n FROM files").get() as { n: number }).n;
    const symbolCount = (this.db.prepare("SELECT COUNT(*) as n FROM symbols").get() as { n: number }).n;
    const importCount = (this.db.prepare("SELECT COUNT(*) as n FROM imports").get() as { n: number }).n;
    return { fileCount, symbolCount, importCount };
  }

  close(): void {
    this.db.close();
  }
}
