import {
  isColocatedRulesFile,
  isContinueConfigRelatedUri,
} from "core/config/loadLocalAssistants";
import { defaultIgnoreFileAndDir, isIgnoreFile } from "core/indexing/ignore";
import { findUriInDirs } from "core/util/uri";

export type ExternalFileEventKind = "created" | "changed" | "deleted";

export interface ExternalFileEventBatch {
  created: string[];
  changed: string[];
  deleted: string[];
}

export interface ExternalFileEventBufferOptions {
  /** Trailing-edge flush window after the last event. Default: 400 ms. */
  debounceMs?: number;
  /**
   * Forced flush at latest this long after the first buffered event
   * (hard cap so long bursts never starve the pipeline). Default: 2000 ms.
   */
  forcedFlushMs?: number;
  /**
   * Change events for URIs reported as editor saves within this window are
   * suppressed. Default: 2000 ms.
   */
  saveSuppressionTtlMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable timers (tests). */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_FORCED_FLUSH_MS = 2000;
const DEFAULT_SAVE_SUPPRESSION_TTL_MS = 2000;

/**
 * URIs that must always be dispatched even when they match DEFAULT_IGNORES:
 * mirrors the config-related branches of the `files/*` handlers in
 * `core.ts`, which run independently of ignore filtering (see
 * workspace-filesystem-watcher.md, Decision 6). `.gitignore`/
 * `.continueignore` have their own `index/forceReIndex` branch there
 * (`isIgnoreFile`).
 */
export function isWhitelistedExternalFileUri(uri: string): boolean {
  return (
    isContinueConfigRelatedUri(uri) ||
    isColocatedRulesFile(uri) ||
    isIgnoreFile(uri)
  );
}

/**
 * Cheap path-based DEFAULT_IGNORES check on the workspace-relative path —
 * no IDE calls. The async `shouldIgnore(uri, ide)` with its ancestor walk
 * stays reserved for the core handlers.
 */
export function isIgnoredExternalFileUri(
  uri: string,
  workspaceDirUris: string[],
): boolean {
  const { foundInDir, relativePathOrBasename } = findUriInDirs(
    uri,
    workspaceDirUris,
  );
  if (!foundInDir) {
    // Outside every watched workspace folder — nothing to refresh there.
    return true;
  }
  return defaultIgnoreFileAndDir.ignores(relativePathOrBasename);
}

/**
 * Workspace-membership check — the first filter gate at flush time. Events
 * for URIs outside every watched workspace folder (e.g. the folder was
 * removed while the event sat in the debounce buffer) are dropped before
 * the whitelist is consulted: the whitelist must never resurrect an event
 * for a workspace that no longer exists.
 */
export function isInWorkspaceDirs(
  uri: string,
  workspaceDirUris: string[],
): boolean {
  return findUriInDirs(uri, workspaceDirUris).foundInDir;
}

/**
 * Buffers raw FileSystemWatcher events, dedupes them per URI (last event
 * type wins), suppresses change events that duplicate a just-reported
 * editor save, filters against DEFAULT_IGNORES with a config whitelist and
 * hands one aggregated batch per flush to the `files/created|changed|
 * deleted` entry points. See workspace-filesystem-watcher.md.
 */
export class ExternalFileEventBuffer {
  private buffer = new Map<string, ExternalFileEventKind>();
  private recentlySavedUris = new Map<string, number>();
  private firstBufferedAt: number | null = null;
  private timerHandle: unknown = null;
  private workspaceDirUris: string[];

  private readonly debounceMs: number;
  private readonly forcedFlushMs: number;
  private readonly saveSuppressionTtlMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(
    workspaceDirUris: string[],
    private readonly onFlush: (batch: ExternalFileEventBatch) => void,
    options: ExternalFileEventBufferOptions = {},
  ) {
    this.workspaceDirUris = workspaceDirUris;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.forcedFlushMs = options.forcedFlushMs ?? DEFAULT_FORCED_FLUSH_MS;
    this.saveSuppressionTtlMs =
      options.saveSuppressionTtlMs ?? DEFAULT_SAVE_SUPPRESSION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /** Keep the ignore-check scope in sync with the workspace folders. */
  setWorkspaceDirs(workspaceDirUris: string[]): void {
    this.workspaceDirUris = workspaceDirUris;
  }

  /**
   * Record that the extension itself just reported this save to the core
   * (`onDidSaveTextDocument`). Watcher change events for the same URI are
   * suppressed within the TTL window to avoid a double dispatch.
   */
  noteReportedSave(uri: string): void {
    this.pruneExpiredSaves();
    this.recentlySavedUris.set(uri, this.now());
  }

  /** Feed one watcher event. Per URI the last event type wins. */
  pushEvent(uri: string, kind: ExternalFileEventKind): void {
    if (kind === "changed" && this.isRecentlySaved(uri)) {
      return;
    }
    this.buffer.set(uri, kind);
    if (this.firstBufferedAt === null) {
      this.firstBufferedAt = this.now();
    }
    this.scheduleFlush();
  }

  /** Flush immediately. No-op when the buffer is empty. */
  flush(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    const entries = [...this.buffer.entries()];
    this.buffer.clear();
    this.firstBufferedAt = null;

    if (entries.length === 0) {
      return;
    }

    const batch: ExternalFileEventBatch = {
      created: [],
      changed: [],
      deleted: [],
    };
    for (const [uri, kind] of entries) {
      // Outside every watched workspace folder (e.g. the folder was removed
      // while this event sat in the debounce buffer) — nothing to refresh
      // there; the whitelist must not resurrect such events.
      if (!isInWorkspaceDirs(uri, this.workspaceDirUris)) {
        continue;
      }
      if (
        isWhitelistedExternalFileUri(uri) ||
        !isIgnoredExternalFileUri(uri, this.workspaceDirUris)
      ) {
        batch[kind].push(uri);
      }
    }
    if (
      batch.created.length > 0 ||
      batch.changed.length > 0 ||
      batch.deleted.length > 0
    ) {
      this.onFlush(batch);
    }
  }

  dispose(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.buffer.clear();
    this.recentlySavedUris.clear();
    this.firstBufferedAt = null;
  }

  private isRecentlySaved(uri: string): boolean {
    const savedAt = this.recentlySavedUris.get(uri);
    if (savedAt === undefined) {
      return false;
    }
    if (this.now() - savedAt >= this.saveSuppressionTtlMs) {
      // Expired — drop it lazily instead of waiting for the next
      // noteReportedSave prune.
      this.recentlySavedUris.delete(uri);
      return false;
    }
    return true;
  }

  private pruneExpiredSaves(): void {
    const now = this.now();
    for (const [uri, savedAt] of this.recentlySavedUris) {
      if (now - savedAt >= this.saveSuppressionTtlMs) {
        this.recentlySavedUris.delete(uri);
      }
    }
  }

  /**
   * Trailing edge: flush `debounceMs` after the last event, but never later
   * than `forcedFlushMs` after the first buffered event (Decision 8).
   */
  private scheduleFlush(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
    }
    const elapsed = this.now() - (this.firstBufferedAt ?? this.now());
    const delay = Math.max(
      0,
      Math.min(this.debounceMs, this.forcedFlushMs - elapsed),
    );
    this.timerHandle = this.setTimeoutFn(() => this.flush(), delay);
  }
}
