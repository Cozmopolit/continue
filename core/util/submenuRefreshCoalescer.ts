/**
 * Trailing-edge throttle for event-driven `refreshSubmenuItems` sends
 * (watcher-smb-hammering-mitigation.md).
 *
 * Every send makes the GUI run a full recursive workspace walk
 * (`FileContextProvider.loadSubmenuItems`), which is brutal on network
 * shares when the workspace-filesystem-watcher turns external writes into a
 * continuous event stream. This coalescer bounds event-driven sends to one
 * per window per client: the first request sends immediately when the last
 * send is older than the window; while inside the window, further requests
 * are merged (provider union) and exactly one send is scheduled at the
 * window end.
 */

export interface SubmenuRefreshCoalescerOptions {
  /** Coalescing window in ms. Default: 30_000 (matches LIST_DIR_CACHE_TIME). */
  windowMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable timers (tests). */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

const DEFAULT_WINDOW_MS = 30_000;

export class SubmenuRefreshCoalescer<T extends string = string> {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private lastSentAt: number | null = null;
  private pendingProviders = new Set<T>();
  private timerHandle: unknown = null;

  constructor(
    private readonly send: (providers: T[]) => void,
    options: SubmenuRefreshCoalescerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /** Merge a refresh request into the current window, or send immediately. */
  request(providers: T[]): void {
    for (const provider of providers) {
      this.pendingProviders.add(provider);
    }

    if (this.timerHandle !== null) {
      // Trailing send already scheduled — merged providers ride along.
      return;
    }

    const elapsed =
      this.lastSentAt === null ? Infinity : this.now() - this.lastSentAt;
    if (elapsed >= this.windowMs) {
      this.flush();
      return;
    }

    this.timerHandle = this.setTimeoutFn(
      () => this.flush(),
      this.windowMs - elapsed,
    );
  }

  /** Drop a scheduled trailing send; no further send will fire. */
  dispose(): void {
    if (this.timerHandle !== null) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = null;
    }
    this.pendingProviders.clear();
  }

  private flush(): void {
    this.timerHandle = null;
    this.lastSentAt = this.now();
    const providers = [...this.pendingProviders];
    this.pendingProviders.clear();
    this.send(providers);
  }
}
