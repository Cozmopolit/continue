import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./boardState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boardState")>();
  return {
    ...actual,
    loadBoardState: vi.fn(),
    saveBoardState: vi.fn(),
  };
});

vi.mock("../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: {
    getInstance: vi.fn(),
  },
}));

import { BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";

import {
  consumeBoardPending,
  findBoardConnection,
  registerBoardIdentity,
  tryRegisterBoardIdentity,
} from "./boardClient";
import { BoardState, loadBoardState, saveBoardState } from "./boardState";

const mockLoad = vi.mocked(loadBoardState);
const mockSave = vi.mocked(saveBoardState);
const mockGetInstance = vi.mocked(MCPManagerSingleton.getInstance);

const mockIde = {} as unknown as IDE;

const EMPTY_RESULT: BoardPendingResult = { messages: [], latestByTopic: {} };

function makeConnection({
  status = "connected",
  boardCapability = true,
  boardV2Capability = true,
  boardPending = vi.fn(),
  boardRegister = vi.fn().mockResolvedValue({ ok: true, handle: "delta" }),
}: {
  status?: string;
  boardCapability?: boolean;
  boardV2Capability?: boolean;
  boardPending?: ReturnType<typeof vi.fn>;
  boardRegister?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    status,
    proxyCapabilities: boardCapability
      ? { board: true, ...(boardV2Capability ? { boardV2: true } : {}) }
      : {},
    boardPending,
    boardRegister,
  };
}

function setConnections(...connections: any[]) {
  const map = new Map<string, unknown>();
  connections.forEach((connection, index) =>
    map.set(`conn-${index}`, connection),
  );
  mockGetInstance.mockReturnValue({ connections: map } as any);
}

const state = (overrides: Partial<BoardState> = {}): BoardState => ({
  handle: "delta",
  ...overrides,
});

const message = (id: number) => ({
  topic: "t1",
  id,
  from: "home-citt",
  to: "*",
  createdAt: "2026-08-14T00:00:00Z",
  body: `body ${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("findBoardConnection", () => {
  it("returns undefined when no connections exist", () => {
    setConnections();
    expect(findBoardConnection()).toBeUndefined();
  });

  it("returns the first connected, board-capable connection", () => {
    const skippedNotConnected = makeConnection({ status: "connecting" });
    const skippedNoCapability = makeConnection({ boardCapability: false });
    const match1 = makeConnection();
    const match2 = makeConnection();
    setConnections(skippedNotConnected, skippedNoCapability, match1, match2);
    expect(findBoardConnection()).toBe(match1);
  });

  it("skips connections without proxyCapabilities", () => {
    setConnections({ status: "connected" }, makeConnection());
    expect(findBoardConnection()).toBeTruthy();
  });
});

describe("consumeBoardPending", () => {
  it("returns the empty result without RPC when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    const boardPending = vi.fn();
    const boardRegister = vi.fn();
    setConnections(makeConnection({ boardPending, boardRegister }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(boardRegister).not.toHaveBeenCalled();
    expect(boardPending).not.toHaveBeenCalled();
  });

  it("returns the empty result when no board-capable server is connected", async () => {
    mockLoad.mockResolvedValue(state());
    setConnections(makeConnection({ status: "disconnected" }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
  });

  it("skips registration and consumption against a non-v2 gateway", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi.fn();
    const boardRegister = vi.fn();
    setConnections(
      makeConnection({
        boardV2Capability: false,
        boardPending,
        boardRegister,
      }),
    );

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(boardRegister).not.toHaveBeenCalled();
    expect(boardPending).not.toHaveBeenCalled();
  });

  it("registers the handle, then consumes with no topics and no sinceId", async () => {
    mockLoad.mockResolvedValue(state());
    const result: BoardPendingResult = {
      messages: [message(150)],
      latestByTopic: { t1: 150 },
    };
    const boardPending = vi.fn().mockResolvedValue(result);
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    setConnections(makeConnection({ boardPending, boardRegister }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(result);
    expect(boardRegister).toHaveBeenCalledWith("delta");
    expect(boardPending).toHaveBeenCalledTimes(1);
    expect(boardPending).toHaveBeenCalledWith();
  });

  it("returns the empty result when registration fails (best-effort)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi.fn();
    const boardRegister = vi.fn().mockRejectedValue(new Error("-32002"));
    setConnections(makeConnection({ boardPending, boardRegister }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(boardPending).not.toHaveBeenCalled();
  });

  it("returns the empty result when the consumption RPC fails (best-effort)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi.fn().mockRejectedValue(new Error("timeout"));
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
  });

  it("returns the empty result when loading the state fails (best-effort)", async () => {
    mockLoad.mockRejectedValue(new Error("disk error"));
    setConnections(makeConnection());

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
  });
});

// Board handle registration at connection setup (msgboard-v2-fork-packages.md,
// Revision 2026-08-21): identity must never depend on the board-watch toggle.
describe("tryRegisterBoardIdentity", () => {
  it("returns skipped without RPC when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    const boardRegister = vi.fn();
    setConnections(makeConnection({ boardRegister }));

    await expect(tryRegisterBoardIdentity(mockIde)).resolves.toBe("skipped");
    expect(boardRegister).not.toHaveBeenCalled();
  });

  it("returns retryable when no board connection is connected", async () => {
    mockLoad.mockResolvedValue(state());
    setConnections();

    await expect(tryRegisterBoardIdentity(mockIde)).resolves.toBe("retryable");
  });

  it("returns retryable against a non-v2 gateway", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn();
    setConnections(makeConnection({ boardV2Capability: false, boardRegister }));

    await expect(tryRegisterBoardIdentity(mockIde)).resolves.toBe("retryable");
    expect(boardRegister).not.toHaveBeenCalled();
  });

  it("registers the handle from the state file", async () => {
    mockLoad.mockResolvedValue(state({ handle: "citt-delta" }));
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "citt-delta" });
    setConnections(makeConnection({ boardRegister }));

    await expect(tryRegisterBoardIdentity(mockIde)).resolves.toBe("registered");
    expect(boardRegister).toHaveBeenCalledWith("citt-delta");
  });

  it("returns retryable when the RPC fails", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn().mockRejectedValue(new Error("-32002"));
    setConnections(makeConnection({ boardRegister }));

    await expect(tryRegisterBoardIdentity(mockIde)).resolves.toBe("retryable");
  });
});

describe("registerBoardIdentity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers on the first attempt without waiting", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    setConnections(makeConnection({ boardRegister }));

    await expect(registerBoardIdentity(mockIde)).resolves.toBe(true);
    expect(boardRegister).toHaveBeenCalledTimes(1);
  });

  it("retries every 2 s until the gateway comes up", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi
      .fn()
      .mockRejectedValueOnce(new Error("econnrefused"))
      .mockRejectedValueOnce(new Error("econnrefused"))
      .mockResolvedValue({ ok: true, handle: "delta" });
    setConnections(makeConnection({ boardRegister }));

    const result = registerBoardIdentity(mockIde);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toBe(true);
    expect(boardRegister).toHaveBeenCalledTimes(3);
  });

  it("gives up after the 20 s window (attempts at t=0..20, 11 total)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn().mockRejectedValue(new Error("down"));
    setConnections(makeConnection({ boardRegister }));

    const result = registerBoardIdentity(mockIde);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toBe(false);
    expect(boardRegister).toHaveBeenCalledTimes(11);
    expect(console.warn).toHaveBeenCalled();
  });

  it("stops without retrying when there is no board identity", async () => {
    mockLoad.mockResolvedValue(undefined);
    const boardRegister = vi.fn();
    setConnections(makeConnection({ boardRegister }));

    const result = registerBoardIdentity(mockIde);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toBe(false);
    expect(boardRegister).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not stack a second loop while one is in flight", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn().mockRejectedValue(new Error("down"));
    setConnections(makeConnection({ boardRegister }));

    const first = registerBoardIdentity(mockIde);
    await vi.advanceTimersByTimeAsync(0); // first attempt done, now sleeping
    await expect(registerBoardIdentity(mockIde)).resolves.toBe(false);
    expect(boardRegister).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(first).resolves.toBe(false);
  });

  it("picks up a gateway that becomes ready mid-window", async () => {
    mockLoad.mockResolvedValue(state());
    setConnections(); // nothing connected yet

    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const result = registerBoardIdentity(mockIde);
    await vi.advanceTimersByTimeAsync(1_000);
    setConnections(makeConnection({ boardRegister }));
    await vi.advanceTimersByTimeAsync(1_000); // t=2 s attempt sees the connection

    await expect(result).resolves.toBe(true);
    expect(boardRegister).toHaveBeenCalledTimes(1);
  });

  it("respects intervalMs/windowMs overrides", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn().mockRejectedValue(new Error("down"));
    setConnections(makeConnection({ boardRegister }));

    const result = registerBoardIdentity(mockIde, {
      intervalMs: 1_000,
      windowMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe(false);
    expect(boardRegister).toHaveBeenCalledTimes(6); // t=0..5
  });
});

describe("consumeBoardPending — close notification (diffClosedTopics)", () => {
  // Close notification (msgboard-v2-fork-packages.md, Revision 2026-08-21):
  // the gateway lists ALL subscribed closed topics on every response (state
  // listing) — core diffs against the board-state last-seen set, reports
  // only fresh entries and persists the new seen set.
  const closedResult = (closedTopics?: string[]): BoardPendingResult => ({
    messages: [],
    latestByTopic: { t1: 10 },
    ...(closedTopics ? { closedTopics } : {}),
  });

  it("reports new closed topics and persists the seen state", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi.fn().mockResolvedValue(closedResult(["a", "b"]));
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual({
      ...closedResult(["a", "b"]),
      newClosedTopics: ["a", "b"],
    });
    expect(mockSave).toHaveBeenCalledWith(
      mockIde,
      state({ closedTopicsSeen: ["a", "b"] }),
    );
  });

  it("does not re-report already-seen closes and does not rewrite unchanged state", async () => {
    mockLoad.mockResolvedValue(state({ closedTopicsSeen: ["a"] }));
    const boardPending = vi.fn().mockResolvedValue(closedResult(["a"]));
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(
      closedResult(["a"]),
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("reports only the unseen entries when the closed set grows", async () => {
    mockLoad.mockResolvedValue(state({ closedTopicsSeen: ["a"] }));
    const boardPending = vi.fn().mockResolvedValue(closedResult(["a", "b"]));
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);
    expect(result.newClosedTopics).toEqual(["b"]);
    expect(mockSave).toHaveBeenCalledWith(
      mockIde,
      state({ closedTopicsSeen: ["a", "b"] }),
    );
  });

  it("drops the seen-mark of reopened topics", async () => {
    mockLoad.mockResolvedValue(state({ closedTopicsSeen: ["a", "b"] }));
    const boardPending = vi.fn().mockResolvedValue(closedResult(["a"]));
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);
    expect(result.newClosedTopics).toBeUndefined();
    expect(mockSave).toHaveBeenCalledWith(
      mockIde,
      state({ closedTopicsSeen: ["a"] }),
    );
  });

  it("wipes the seen state when no topics are closed anymore", async () => {
    mockLoad.mockResolvedValue(state({ closedTopicsSeen: ["a"] }));
    const boardPending = vi.fn().mockResolvedValue(closedResult(undefined));
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);
    expect(result.newClosedTopics).toBeUndefined();
    expect(mockSave).toHaveBeenCalledWith(mockIde, state());
  });

  it("keeps delivering the diff when persistence fails (best-effort)", async () => {
    mockLoad.mockResolvedValue(state());
    mockSave.mockRejectedValue(new Error("disk full"));
    const boardPending = vi.fn().mockResolvedValue(closedResult(["a"]));
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);
    expect(result.newClosedTopics).toEqual(["a"]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("close-seen state not persisted"),
    );
  });
});
