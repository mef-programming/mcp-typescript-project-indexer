/**
 * ts_change_tracking.ts
 *
 * Git-based change tracking for the TypeScript indexer.
 * Detects changed files and maps hunks to indexed symbols.
 *
 * Mirrors the C++ indexer change tracking approach.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { SourceRange } from "./ts_index_model";
import { SqliteIndexReader, type SymbolRow } from "./ts_index_sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangedFile = {
  relativePath: string;
  status: "modified" | "added" | "deleted" | "renamed";
  oldPath?: string;
};

export type ChangeHunk = {
  startLine: number;
  endLine: number;
  header: string;
  addedLines: number;
  removedLines: number;
};

export type FileChangeHunks = {
  relativePath: string;
  status: string;
  hunks: ChangeHunk[];
  indexedRanges?: Array<{
    symbolId: string;
    kind: string;
    name: string;
    qualifiedName: string;
    startLine: number;
    endLine: number;
    overlapLines: number;
  }>;
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function execGit(projectRoot: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(projectRoot: string): boolean {
  return execGit(projectRoot, "rev-parse --is-inside-work-tree") === "true";
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export function detectChangeTracking(projectRoot: string): boolean {
  return isGitRepo(projectRoot);
}

export function listChangedFiles(
  projectRoot: string,
  scope: "staged" | "unstaged" | "all" = "all",
): ChangedFile[] {
  if (!isGitRepo(projectRoot)) return [];

  const results: ChangedFile[] = [];

  if (scope === "staged" || scope === "all") {
    const staged = execGit(projectRoot, "diff --cached --name-status");
    if (staged) {
      for (const line of staged.split("\n").filter(Boolean)) {
        const parsed = parseNameStatus(line);
        if (parsed) results.push(parsed);
      }
    }
  }

  if (scope === "unstaged" || scope === "all") {
    const unstaged = execGit(projectRoot, "diff --name-status");
    if (unstaged) {
      for (const line of unstaged.split("\n").filter(Boolean)) {
        const parsed = parseNameStatus(line);
        if (parsed && !results.some((r) => r.relativePath === parsed.relativePath)) {
          results.push(parsed);
        }
      }
    }
  }

  return results;
}

function parseNameStatus(line: string): ChangedFile | null {
  const parts = line.split("\t");
  if (parts.length < 2) return null;

  const statusCode = parts[0]!.charAt(0);
  const filePath = parts[parts.length - 1]!.replace(/\\/g, "/");

  const statusMap: Record<string, ChangedFile["status"]> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
  };

  const status = statusMap[statusCode];
  if (!status) return null;

  return {
    relativePath: filePath,
    status,
    oldPath: statusCode === "R" && parts.length >= 3 ? parts[1]!.replace(/\\/g, "/") : undefined,
  };
}

// ---------------------------------------------------------------------------
// Hunk extraction
// ---------------------------------------------------------------------------

export function getFileChangeHunks(
  projectRoot: string,
  relativePath: string,
  options: {
    includeIndexedRanges?: boolean;
    indexRoot?: string;
    contextLines?: number;
  } = {},
): FileChangeHunks | null {
  if (!isGitRepo(projectRoot)) return null;

  const contextLines = options.contextLines ?? 0;
  const diff = execGit(
    projectRoot,
    `diff -U${contextLines} -- "${relativePath.replace(/"/g, '\\"')}"`,
  );

  if (!diff) {
    // Try staged
    const stagedDiff = execGit(
      projectRoot,
      `diff --cached -U${contextLines} -- "${relativePath.replace(/"/g, '\\"')}"`,
    );
    if (!stagedDiff) return null;
    return parseHunks(relativePath, stagedDiff, projectRoot, options);
  }

  return parseHunks(relativePath, diff, projectRoot, options);
}

function parseHunks(
  relativePath: string,
  diff: string,
  projectRoot: string,
  options: {
    includeIndexedRanges?: boolean;
    indexRoot?: string;
  },
): FileChangeHunks {
  const hunks: ChangeHunk[] = [];
  const hunkHeaderRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/;

  const lines = diff.split("\n");
  let currentHunk: ChangeHunk | null = null;

  for (const line of lines) {
    const match = hunkHeaderRegex.exec(line);
    if (match) {
      if (currentHunk) hunks.push(currentHunk);
      const startLine = parseInt(match[1]!, 10);
      const count = match[2] ? parseInt(match[2], 10) : 1;
      currentHunk = {
        startLine,
        endLine: startLine + Math.max(0, count - 1),
        header: match[3]?.trim() ?? "",
        addedLines: 0,
        removedLines: 0,
      };
    } else if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentHunk.addedLines++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        currentHunk.removedLines++;
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  const result: FileChangeHunks = {
    relativePath,
    status: "modified",
    hunks,
  };

  // Map hunks to indexed symbols
  if (options.includeIndexedRanges && options.indexRoot) {
    try {
      const reader = new SqliteIndexReader(options.indexRoot);
      const fileRow = reader.getFile(relativePath);
      if (fileRow) {
        const symbols = reader.listFileSymbols(fileRow.fileId);
        const ranges: FileChangeHunks["indexedRanges"] = [];

        for (const hunk of hunks) {
          for (const sym of symbols) {
            const overlap = computeOverlap(
              hunk.startLine, hunk.endLine,
              sym.startLine, sym.endLine,
            );
            if (overlap > 0) {
              // Avoid duplicates
              if (!ranges.some((r) => r.symbolId === sym.symbolId)) {
                ranges.push({
                  symbolId: sym.symbolId,
                  kind: sym.kind,
                  name: sym.name,
                  qualifiedName: sym.qualifiedName,
                  startLine: sym.startLine,
                  endLine: sym.endLine,
                  overlapLines: overlap,
                });
              }
            }
          }
        }

        result.indexedRanges = ranges;
      }
      reader.close();
    } catch {
      // Non-fatal — skip indexed range mapping
    }
  }

  return result;
}

function computeOverlap(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number,
): number {
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  return Math.max(0, end - start + 1);
}

// ---------------------------------------------------------------------------
// Recent revisions
// ---------------------------------------------------------------------------

export type RecentRevision = {
  hash: string;
  shortHash: string;
  subject: string;
  authorDate: string;
  filesChanged: number;
};

export function listRecentRevisions(
  projectRoot: string,
  limit = 10,
): RecentRevision[] {
  if (!isGitRepo(projectRoot)) return [];

  const log = execGit(
    projectRoot,
    `log --oneline --format="%H|%h|%s|%aI" -n ${limit} --diff-filter=AMRD`,
  );
  if (!log) return [];

  return log.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("|");
    return {
      hash: parts[0] ?? "",
      shortHash: parts[1] ?? "",
      subject: parts[2] ?? "",
      authorDate: parts[3] ?? "",
      filesChanged: 0,
    };
  });
}
