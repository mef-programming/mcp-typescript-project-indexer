/**
 * ts_watcher.ts
 *
 * Polling file watcher for the standalone TypeScript project indexer.
 * Polling keeps behavior predictable across Windows, WSL, network drives,
 * and editor save strategies.
 */

import * as path from "path";
import {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_EXTENSIONS,
  discoverSourceFiles,
  fileContentHash,
} from "./ts_index_utils";
import { updateProjectIndex } from "./ts_project_index";

export type WatcherOptions = {
  projectRoot: string;
  indexRoot: string;
  pollIntervalMs?: number;
  debounceMs?: number;
  canUpdate?: () => boolean;
  onUpdateStart?: (changedCount: number) => void;
  onUpdate?: (changedCount: number, durationMs: number) => void;
  onError?: (error: Error) => void;
};

export type Watcher = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

export function createWatcher(options: WatcherOptions): Watcher {
  const {
    projectRoot,
    indexRoot,
    pollIntervalMs = 5000,
    debounceMs = 1000,
    canUpdate,
    onUpdateStart,
    onUpdate,
    onError,
  } = options;

  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const hashCache = new Map<string, string>();
  const pendingChanges = new Set<string>();

  function relative(file: string): string {
    return path.relative(projectRoot, file).replace(/\\/g, "/");
  }

  function buildHashCache(): void {
    hashCache.clear();
    for (const file of discoverSourceFiles(projectRoot, DEFAULT_EXTENSIONS, DEFAULT_EXCLUDE_DIRS)) {
      try {
        hashCache.set(file, fileContentHash(file));
      } catch {
        // Skip unreadable files.
      }
    }
  }

  function poll(): void {
    const files = discoverSourceFiles(projectRoot, DEFAULT_EXTENSIONS, DEFAULT_EXCLUDE_DIRS);
    const current = new Set(files);

    for (const file of files) {
      try {
        const hash = fileContentHash(file);
        const previous = hashCache.get(file);
        if (previous !== hash) {
          hashCache.set(file, hash);
          pendingChanges.add(relative(file));
        }
      } catch {
        // Skip unreadable files for this poll.
      }
    }

    for (const file of [...hashCache.keys()]) {
      if (current.has(file)) continue;
      hashCache.delete(file);
      pendingChanges.add(relative(file));
    }

    if (pendingChanges.size > 0) {
      scheduleUpdate();
    }
  }

  function scheduleUpdate(): void {
    if (debounceTimer) return;
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const changed = [...pendingChanges];
      pendingChanges.clear();
      if (changed.length === 0) return;
      if (canUpdate && !canUpdate()) {
        changed.forEach((file) => pendingChanges.add(file));
        scheduleUpdate();
        return;
      }

      try {
        onUpdateStart?.(changed.length);
        const result = await updateProjectIndex({
          projectRoot,
          indexRoot,
          changedFiles: changed,
        });
        onUpdate?.(changed.length, result.durationMs);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, debounceMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      buildHashCache();
      timer = setInterval(poll, pollIntervalMs);
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
    isRunning() {
      return running;
    },
  };
}
