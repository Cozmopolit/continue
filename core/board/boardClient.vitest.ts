import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./boardState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boardState")>();
  return {
    ...actual,
    loadBoardState: vi.fn(),
  };
});

vi.mock("../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: {
    getInstance: vi.fn(),
  },
}));

import { BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";

import { consumeBoardPending, findBoardConnection } from "./boardClient";
import { BoardState, loadBoardState } from "./boardState";

const mockLoad = vi.mocked(loadBoardState);
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
