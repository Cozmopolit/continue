import { BoardMessage, BoardPendingResult } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { appendBoardMessages } from "../slices/sessionSlice";
import { fetchBoardPending } from "./fetchBoardPending";

// Board wake mode (board-wake-mode.md): shared consumption seam used by both
// the run path (streamNormalInput, TTL-gated caller-side) and the idle
// watcher (30 s tick). Best-effort contract: failures are logged and
// swallowed — the promise resolves to undefined instead of throwing and
// nothing is accumulated, so a board failure never blocks a run or the
// watcher.

const BOARD_MESSAGE: BoardMessage = {
  topic: "board-wake-mode",
  id: 5305000001,
  from: "home-citt",
  to: "*",
  createdAt: "2026-08-15T21:00:00Z",
  body: "Neue Nachricht im Topic.",
};

const BOARD_RESULT: BoardPendingResult = {
  messages: [BOARD_MESSAGE],
  latestByTopic: { "board-wake-mode": 5305000001 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchBoardPending", () => {
  it("accumulates the result into session state and returns it", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["board/consumePending"] = BOARD_RESULT;
    const dispatch = vi.fn();

    const result = await fetchBoardPending(dispatch as any, messenger);

    expect(result).toEqual(BOARD_RESULT);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(appendBoardMessages(BOARD_RESULT));
  });

  it("logs a board warning but still accumulates and returns", async () => {
    const messenger = new MockIdeMessenger();
    const withWarning: BoardPendingResult = {
      ...BOARD_RESULT,
      warning: "topic gone",
    };
    messenger.responses["board/consumePending"] = withWarning;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn();

    const result = await fetchBoardPending(dispatch as any, messenger);

    expect(result).toEqual(withWarning);
    expect(warnSpy).toHaveBeenCalledWith("MsgBoard: topic gone");
    expect(dispatch).toHaveBeenCalledWith(appendBoardMessages(withWarning));
  });

  it("returns undefined and accumulates nothing on error status", async () => {
    const messenger = new MockIdeMessenger();
    vi.spyOn(messenger, "request").mockResolvedValue({
      status: "error",
      error: "gateway down",
      done: true,
    } as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn();

    const result = await fetchBoardPending(dispatch as any, messenger);

    expect(result).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Board injection skipped: gateway down",
    );
  });

  it("returns undefined and accumulates nothing when the request throws", async () => {
    const messenger = new MockIdeMessenger();
    vi.spyOn(messenger, "request").mockRejectedValue(
      new Error("socket closed"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn();

    const result = await fetchBoardPending(dispatch as any, messenger);

    expect(result).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Board injection skipped: socket closed",
    );
  });

  it("stringifies non-Error rejections for the log line", async () => {
    const messenger = new MockIdeMessenger();
    vi.spyOn(messenger, "request").mockRejectedValue("plain string failure");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn();

    const result = await fetchBoardPending(dispatch as any, messenger);

    expect(result).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Board injection skipped: plain string failure",
    );
  });
});
