import { describe, expect, it } from "vitest";

import type { ExternalFileEventBatch } from "./externalFileEventBuffer";
import {
  ExternalFileEventBuffer,
  isIgnoredExternalFileUri,
  isWhitelistedExternalFileUri,
} from "./externalFileEventBuffer";

const WORKSPACE_DIR = "file:///home/u/proj";
const SECOND_DIR = "file:///home/u/other";

const uri = (relPath: string) => `${WORKSPACE_DIR}/${relPath}`;

/** Deterministic clock + timer queue; no dependency on vi.useFakeTimers. */
class FakeClock {
  nowMs = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.nowMs;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance time, firing due timers in chronological order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) {
          next = { id, at: timer.at, fn: timer.fn };
        }
      }
      if (next === null) {
        break;
      }
      this.nowMs = next.at;
      this.timers.delete(next.id);
      next.fn();
    }
    this.nowMs = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

function createBuffer(
  onFlush: (batch: ExternalFileEventBatch) => void,
  workspaceDirs: string[] = [WORKSPACE_DIR],
) {
  const clock = new FakeClock();
  const buffer = new ExternalFileEventBuffer(workspaceDirs, onFlush, {
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
  });
  return { buffer, clock };
}

describe("isWhitelistedExternalFileUri", () => {
  it("whitelists agent files like AGENTS.md", () => {
    expect(isWhitelistedExternalFileUri(uri("AGENTS.md"))).toBe(true);
  });

  it("whitelists colocated rules.md files anywhere in the tree", () => {
    expect(isWhitelistedExternalFileUri(uri("src/feature/rules.md"))).toBe(
      true,
    );
  });

  it("whitelists .continue config files", () => {
    expect(isWhitelistedExternalFileUri(uri(".continue/config.yaml"))).toBe(
      true,
    );
  });

  it("whitelists .gitignore and .continueignore", () => {
    expect(isWhitelistedExternalFileUri(uri(".gitignore"))).toBe(true);
    expect(isWhitelistedExternalFileUri(uri("packages/x/.gitignore"))).toBe(
      true,
    );
    expect(isWhitelistedExternalFileUri(uri(".continueignore"))).toBe(true);
  });

  it("does not whitelist ordinary source files", () => {
    expect(isWhitelistedExternalFileUri(uri("src/index.ts"))).toBe(false);
  });

  it("does not whitelist a bare config.yaml outside .continue/", () => {
    expect(isWhitelistedExternalFileUri(uri("config.yaml"))).toBe(false);
  });
});

describe("isIgnoredExternalFileUri", () => {
  it("passes ordinary source files", () => {
    expect(isIgnoredExternalFileUri(uri("src/index.ts"), [WORKSPACE_DIR])).toBe(
      false,
    );
  });

  it("ignores build output directories", () => {
    expect(
      isIgnoredExternalFileUri(uri("dist/bundle.js"), [WORKSPACE_DIR]),
    ).toBe(true);
    expect(isIgnoredExternalFileUri(uri("out/x.js"), [WORKSPACE_DIR])).toBe(
      true,
    );
  });

  it("ignores node_modules and .git internals", () => {
    expect(
      isIgnoredExternalFileUri(uri("node_modules/lib/index.js"), [
        WORKSPACE_DIR,
      ]),
    ).toBe(true);
    expect(isIgnoredExternalFileUri(uri(".git/HEAD"), [WORKSPACE_DIR])).toBe(
      true,
    );
  });

  it("ignores files under .continue/", () => {
    expect(
      isIgnoredExternalFileUri(uri(".continue/config.yaml"), [WORKSPACE_DIR]),
    ).toBe(true);
  });

  it("ignores URIs outside every workspace dir", () => {
    expect(
      isIgnoredExternalFileUri("file:///elsewhere/file.ts", [WORKSPACE_DIR]),
    ).toBe(true);
  });
});

describe("ExternalFileEventBuffer", () => {
  describe("debouncing", () => {
    it("flushes a single event exactly after the trailing-edge window", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("a.ts"), "changed");
      clock.advance(399);
      expect(batches).toHaveLength(0);

      clock.advance(1);
      expect(batches).toHaveLength(1);
      expect(batches[0].changed).toEqual([uri("a.ts")]);
      expect(batches[0].created).toEqual([]);
      expect(batches[0].deleted).toEqual([]);
    });

    it("resets the trailing edge on every event", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("a.ts"), "changed");
      clock.advance(300);
      buffer.pushEvent(uri("b.ts"), "changed"); // resets to t=300+400=700

      clock.advance(399);
      expect(batches).toHaveLength(0);

      clock.advance(1);
      expect(batches).toHaveLength(1);
      expect(batches[0].changed.sort()).toEqual([uri("a.ts"), uri("b.ts")]);
    });

    it("forces a flush at the hard cap even while events keep arriving", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      // Burst with intervals below the debounce window: every event resets
      // the trailing edge, so only the hard cap (2000 ms after the first
      // buffered event) can end the window.
      const expected: string[] = [];
      for (const t of [0, 300, 600, 900, 1200, 1500, 1800]) {
        const file = uri(`f${t}.ts`);
        expected.push(file);
        buffer.pushEvent(file, "changed");
        if (t < 1800) {
          clock.advance(300);
        }
      }
      // t=1800: trailing edge would fire at 2200 — the cap at 2000 wins.
      expect(batches).toHaveLength(0);

      clock.advance(199); // t=1999: nothing yet
      expect(batches).toHaveLength(0);

      clock.advance(1); // t=2000: forced flush
      expect(batches).toHaveLength(1);
      expect(batches[0].changed.sort()).toEqual(expected.sort());
    });

    it("lets the last event type per URI win within one window", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      const target = uri("temp.txt");
      buffer.pushEvent(target, "created");
      buffer.pushEvent(target, "changed");
      buffer.pushEvent(target, "deleted");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].created).toEqual([]);
      expect(batches[0].changed).toEqual([]);
      expect(batches[0].deleted).toEqual([target]);
    });

    it("aggregates one batch per flush, grouped by event type", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("new.ts"), "created");
      buffer.pushEvent(uri("edit.ts"), "changed");
      buffer.pushEvent(uri("gone.ts"), "deleted");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual({
        created: [uri("new.ts")],
        changed: [uri("edit.ts")],
        deleted: [uri("gone.ts")],
      });
    });
  });

  describe("TTL suppression of self-reported saves", () => {
    it("suppresses change events for URIs just reported as editor saves", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.noteReportedSave(uri("a.ts"));
      buffer.pushEvent(uri("a.ts"), "changed");

      clock.advance(10_000);
      expect(batches).toHaveLength(0);
    });

    it("does not suppress create/delete events for recently saved URIs", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.noteReportedSave(uri("a.ts"));
      buffer.pushEvent(uri("a.ts"), "created");
      buffer.pushEvent(uri("a.ts"), "deleted"); // last wins → deleted

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].deleted).toEqual([uri("a.ts")]);
    });

    it("stops suppressing once the TTL has expired", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.noteReportedSave(uri("a.ts"));
      clock.advance(2000); // TTL boundary: strictly less than TTL suppresses
      buffer.pushEvent(uri("a.ts"), "changed");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].changed).toEqual([uri("a.ts")]);
    });
  });

  describe("filtering", () => {
    it("dispatches whitelisted URIs even when DEFAULT_IGNORES matches them", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri(".continue/config.yaml"), "changed");
      buffer.pushEvent(uri(".gitignore"), "changed");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].changed.sort()).toEqual(
        [uri(".continue/config.yaml"), uri(".gitignore")].sort(),
      );
    });

    it("drops ignored URIs that are not whitelisted", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("dist/bundle.js"), "changed");
      buffer.pushEvent(uri(".git/HEAD"), "changed");
      buffer.pushEvent(uri("src/a.ts"), "changed");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].changed).toEqual([uri("src/a.ts")]);
    });

    it("does not call onFlush when every buffered URI is filtered out", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("node_modules/lib/x.js"), "created");

      clock.advance(10_000);
      expect(batches).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("flush() is a no-op on an empty buffer", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer } = createBuffer((b) => batches.push(b));

      buffer.flush();
      expect(batches).toHaveLength(0);
    });

    it("dispose() cancels the pending flush", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer((b) => batches.push(b));

      buffer.pushEvent(uri("a.ts"), "changed");
      buffer.dispose();
      expect(clock.pendingTimers).toBe(0);

      clock.advance(10_000);
      expect(batches).toHaveLength(0);
    });

    it("setWorkspaceDirs() extends the ignore-check scope", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer(
        (b) => batches.push(b),
        [WORKSPACE_DIR],
      );

      buffer.setWorkspaceDirs([WORKSPACE_DIR, SECOND_DIR]);
      buffer.pushEvent(`${SECOND_DIR}/src/b.ts`, "created");

      clock.advance(400);
      expect(batches).toHaveLength(1);
      expect(batches[0].created).toEqual([`${SECOND_DIR}/src/b.ts`]);
    });

    it("drops buffered URIs that no longer belong to any workspace dir", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer(
        (b) => batches.push(b),
        [WORKSPACE_DIR, SECOND_DIR],
      );

      buffer.pushEvent(`${SECOND_DIR}/src/b.ts`, "changed");
      buffer.setWorkspaceDirs([WORKSPACE_DIR]); // folder removed

      clock.advance(400);
      expect(batches).toHaveLength(0);
    });

    it("drops buffered whitelisted URIs whose workspace folder was removed before the flush", () => {
      const batches: ExternalFileEventBatch[] = [];
      const { buffer, clock } = createBuffer(
        (b) => batches.push(b),
        [WORKSPACE_DIR, SECOND_DIR],
      );

      // Whitelisted files must not be resurrected by the whitelist once
      // their folder is gone — no reloadConfig/forceReIndex for a workspace
      // that no longer exists
      buffer.pushEvent(`${SECOND_DIR}/rules.md`, "changed");
      buffer.pushEvent(`${SECOND_DIR}/.continue/config.yaml`, "changed");
      buffer.setWorkspaceDirs([WORKSPACE_DIR]); // folder removed

      clock.advance(400);
      expect(batches).toHaveLength(0);
    });
  });
});
