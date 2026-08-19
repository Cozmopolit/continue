import { describe, expect, it } from "vitest";

import { SubmenuRefreshCoalescer } from "./submenuRefreshCoalescer";

/**
 * Deterministic single-slot fake clock/timers for the injectable options.
 * The coalescer schedules at most one trailing timer at a time, so a single
 * pending slot is sufficient and makes the invariant observable.
 */
class FakeTime {
  now = 0;
  pending: { cb: () => void; at: number } | null = null;
  scheduledDelays: number[] = [];

  advance(ms: number): void {
    this.now += ms;
    const due = this.pending;
    if (due && due.at <= this.now) {
      this.pending = null;
      due.cb();
    }
  }

  setTimeoutFn = (cb: () => void, ms: number): unknown => {
    this.scheduledDelays.push(ms);
    this.pending = { cb, at: this.now + ms };
    return this.pending;
  };

  clearTimeoutFn = (handle: unknown): void => {
    if (handle !== null && this.pending === handle) {
      this.pending = null;
    }
  };
}

function makeHarness(windowMs?: number) {
  const time = new FakeTime();
  const sends: string[][] = [];
  const coalescer = new SubmenuRefreshCoalescer(
    (providers) => sends.push(providers),
    {
      windowMs,
      now: () => time.now,
      setTimeoutFn: time.setTimeoutFn,
      clearTimeoutFn: time.clearTimeoutFn,
    },
  );
  return { time, sends, coalescer };
}

describe("SubmenuRefreshCoalescer", () => {
  describe("immediate send", () => {
    it("sends immediately on the first request (never sent before)", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      expect(sends).toEqual([["file"]]);
      expect(time.pending).toBeNull();
    });

    it("sends immediately when the last send is older than the window", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      time.advance(30_001);
      coalescer.request(["file"]);
      expect(sends).toHaveLength(2);
      expect(time.pending).toBeNull();
    });

    it("boundary: elapsed exactly equal to the window sends immediately", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      time.advance(30_000);
      coalescer.request(["file"]);
      expect(sends).toHaveLength(2);
      expect(time.pending).toBeNull();
    });

    it("respects a custom window", () => {
      const { sends, coalescer, time } = makeHarness(1_000);
      coalescer.request(["file"]);
      time.advance(1_000);
      coalescer.request(["file"]);
      expect(sends).toHaveLength(2);
    });
  });

  describe("trailing coalescing inside the window", () => {
    it("schedules exactly one trailing send instead of sending immediately", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]); // immediate
      time.advance(10_000);
      coalescer.request(["file"]);
      expect(sends).toHaveLength(1);
      expect(time.pending).not.toBeNull();
      // delay shrinks by the elapsed time since the last send
      expect(time.scheduledDelays).toEqual([20_000]);

      time.advance(20_000);
      expect(sends).toHaveLength(2);
      expect(time.pending).toBeNull();
    });

    it("boundary: elapsed one ms under the window schedules, not sends", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      time.advance(29_999);
      coalescer.request(["file"]);
      expect(sends).toHaveLength(1);
      expect(time.pending).not.toBeNull();
      expect(time.scheduledDelays).toEqual([1]);
    });

    it("merges providers of all requests in the window (deduplicated)", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      time.advance(5_000);
      coalescer.request(["file", "docs"]);
      time.advance(5_000);
      coalescer.request(["docs", "tree"]);
      time.advance(20_000);
      expect(sends).toHaveLength(2);
      expect(sends[1]).toEqual(["file", "docs", "tree"]);
    });

    it("keeps a single pending timer across many requests", () => {
      const { coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      for (let t = 1_000; t <= 25_000; t += 1_000) {
        time.advance(1_000);
        coalescer.request(["file"]);
      }
      // only ever the one trailing timer
      expect(time.scheduledDelays).toHaveLength(1);
    });

    it("trailing send resets the window (lastSentAt updated)", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]); // t=0 immediate
      time.advance(10_000);
      coalescer.request(["file"]); // trailing at t=30_000
      time.advance(20_000); // t=30_000: trailing fires
      expect(sends).toHaveLength(2);

      time.advance(10_000); // t=40_000, 10 s after trailing send
      coalescer.request(["file"]);
      expect(sends).toHaveLength(2); // inside window -> scheduled
      expect(time.pending).not.toBeNull();

      time.advance(20_000); // t=60_000
      expect(sends).toHaveLength(3);
      // next request a full window after the last (trailing) send is immediate
      time.advance(30_000); // t=90_000
      coalescer.request(["file"]);
      expect(sends).toHaveLength(4);
    });
  });

  describe("edge cases", () => {
    it("request with empty providers while idle sends an empty batch", () => {
      const { sends, coalescer } = makeHarness();
      coalescer.request([]);
      expect(sends).toEqual([[]]);
    });

    it("dispose cancels a scheduled trailing send", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]);
      time.advance(10_000);
      coalescer.request(["file"]);
      expect(time.pending).not.toBeNull();
      coalescer.dispose();
      expect(time.pending).toBeNull();
      time.advance(60_000);
      expect(sends).toHaveLength(1);
    });

    it("after dispose, a new request inside the window schedules again", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.request(["file"]); // t=0
      time.advance(10_000);
      coalescer.request(["file"]);
      coalescer.dispose();
      time.advance(5_000); // t=15_000
      coalescer.request(["docs"]);
      expect(time.pending).not.toBeNull();
      time.advance(15_000); // t=30_000 (window end relative to t=0 send)
      expect(sends).toHaveLength(2);
      expect(sends[1]).toEqual(["docs"]);
    });

    it("dispose without a pending timer is a no-op", () => {
      const { sends, coalescer, time } = makeHarness();
      coalescer.dispose();
      coalescer.request(["file"]);
      expect(sends).toEqual([["file"]]);
      expect(time.pending).toBeNull();
    });
  });
});
