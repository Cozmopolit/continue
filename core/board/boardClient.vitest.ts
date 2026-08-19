import { beforeEach, describe, expect, it, vi } from "vitest";

import { BoardPendingResult, IDE } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import {
  consumeBoardPending,
  fetchBoardLatest,
  findBoardConnection,
  syncBoardSubscription,
} from "./boardClient";
import { BoardState, loadBoardState, saveBoardState } from "./boardState";

// boardState is mocked (its real behavior is covered in boardState.vitest.ts);
// cursorAfterConsume stays real via importActual.
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

const mockLoad = vi.mocked(loadBoardState);
const mockSave = vi.mocked(saveBoardState);
const mockGetInstance = vi.mocked(MCPManagerSingleton.getInstance);

const mockIde = {} as unknown as IDE;

const EMPTY_RESULT: BoardPendingResult = { messages: [], latestByTopic: {} };

function makeConnection({
  status = "connected",
  boardCapability = true,
  boardV2Capability = false,
  boardPending = vi.fn(),
  boardRegister = vi.fn().mockResolvedValue({ ok: true, handle: "delta" }),
  boardMigrateImport = vi.fn().mockResolvedValue({
    ok: true,
    processed: 1,
    subscribed: 1,
    cursorAdvanced: true,
  }),
}: {
  status?: string;
  boardCapability?: boolean;
  boardV2Capability?: boolean;
  boardPending?: ReturnType<typeof vi.fn>;
  boardRegister?: ReturnType<typeof vi.fn>;
  boardMigrateImport?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    status,
    proxyCapabilities: boardCapability
      ? { board: true, ...(boardV2Capability ? { boardV2: true } : {}) }
      : {},
    boardPending,
    boardRegister,
    boardMigrateImport,
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
  topics: ["t1"],
  cursor: 100,
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
  mockSave.mockResolvedValue(undefined);
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
    setConnections({ status: "connected", boardPending: vi.fn() });
    expect(findBoardConnection()).toBeUndefined();
  });
});

describe("consumeBoardPending", () => {
  it("returns the empty result without RPC when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    const boardPending = vi.fn();
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(boardPending).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns the empty result without RPC when no topics are subscribed", async () => {
    mockLoad.mockResolvedValue(state({ topics: [] }));
    const boardPending = vi.fn();
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(boardPending).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns the empty result when no board-capable server is connected", async () => {
    mockLoad.mockResolvedValue(state());
    setConnections(makeConnection({ status: "disconnected" }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("passes the result through without reload or save when there are no new messages", async () => {
    mockLoad.mockResolvedValue(state());
    const result: BoardPendingResult = {
      messages: [],
      latestByTopic: { t1: 100 },
    };
    const boardPending = vi.fn().mockResolvedValue(result);
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(result);
    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("reloads state before saving: fresh topics are authoritative, cursor only moves forward", async () => {
    const initial = state({ topics: ["t1"], cursor: 100 });
    // During the RPC window another session subscribed to "t2" and its cursor
    // already moved to 120.
    const fresh = state({ topics: ["t1", "t2"], cursor: 120 });
    mockLoad.mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);
    const boardPending = vi.fn().mockResolvedValue({
      messages: [message(150), message(175)],
      latestByTopic: { t1: 175 },
    });
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);

    expect(result.messages).toHaveLength(2);
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenCalledTimes(1);
    // saved state = fresh topics + max(fresh.cursor, consumedCursor)
    expect(mockSave).toHaveBeenCalledWith(mockIde, {
      handle: "delta",
      topics: ["t1", "t2"],
      cursor: 175,
    });
  });

  it("keeps the fresh cursor when it already exceeds the consumed one", async () => {
    mockLoad
      .mockResolvedValueOnce(state({ cursor: 100 }))
      .mockResolvedValueOnce(state({ cursor: 300 }));
    const boardPending = vi.fn().mockResolvedValue({
      messages: [message(175)],
      latestByTopic: { t1: 175 },
    });
    setConnections(makeConnection({ boardPending }));

    await consumeBoardPending(mockIde);

    expect(mockSave).toHaveBeenCalledWith(
      mockIde,
      expect.objectContaining({ cursor: 300 }),
    );
  });

  it("does not resurrect the state file when it was removed during the RPC", async () => {
    mockLoad.mockResolvedValueOnce(state()).mockResolvedValueOnce(undefined);
    const boardPending = vi.fn().mockResolvedValue({
      messages: [message(150)],
      latestByTopic: { t1: 150 },
    });
    setConnections(makeConnection({ boardPending }));

    const result = await consumeBoardPending(mockIde);

    expect(result.messages).toHaveLength(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns the empty result when the RPC fails (best-effort)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi.fn().mockRejectedValue(new Error("timeout"));
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns the empty result when saving fails (at-least-once: next run refetches)", async () => {
    mockLoad
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({ cursor: 100 }));
    mockSave.mockRejectedValue(new Error("disk full"));
    const boardPending = vi.fn().mockResolvedValue({
      messages: [message(150)],
      latestByTopic: { t1: 150 },
    });
    setConnections(makeConnection({ boardPending }));

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
  });

  it("returns the empty result when the initial load fails", async () => {
    mockLoad.mockRejectedValue(new Error("read error"));
    setConnections(makeConnection());

    await expect(consumeBoardPending(mockIde)).resolves.toEqual(EMPTY_RESULT);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("consumeBoardPending on v2 gateways (msgboard-v2 migration)", () => {
  // Frozen contract (02-board-state-watcher.md): register -> migrateImport ->
  // mode (b) pending. Every failure must fall back to the proven mode (a).

  it("registers, migrates once and switches to mode (b) on first v2 contact", async () => {
    mockLoad.mockResolvedValueOnce(state()).mockResolvedValueOnce(state()); // reload before the flag save
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn().mockResolvedValue({
      ok: true,
      processed: 1,
      subscribed: 1,
      cursorAdvanced: true,
    });
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardPending,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await consumeBoardPending(mockIde);

    expect(boardRegister).toHaveBeenCalledWith("delta");
    expect(boardMigrateImport).toHaveBeenCalledWith([
      { topic: "t1", sinceId: 100, subscribed: true },
    ]);
    expect(mockSave).toHaveBeenCalledWith(mockIde, {
      handle: "delta",
      topics: ["t1"],
      cursor: 100,
      migrated: true,
    });
    // mode (b): no topics, no sinceId
    expect(boardPending).toHaveBeenCalledTimes(1);
    expect(boardPending).toHaveBeenCalledWith();
  });

  it("skips the migration when the flag is already set, but registers per connection", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn();
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardPending,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await consumeBoardPending(mockIde);

    expect(boardRegister).toHaveBeenCalledWith("delta");
    expect(boardMigrateImport).not.toHaveBeenCalled();
    expect(boardPending).toHaveBeenCalledWith();
  });

  it("stays on mode (a) when registration fails (migrateImport requires registration)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi.fn().mockRejectedValue(new Error("-32002"));
    const boardMigrateImport = vi.fn();
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardPending,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await consumeBoardPending(mockIde);

    expect(boardMigrateImport).not.toHaveBeenCalled();
    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("stays on mode (a) and leaves the flag absent when the migration fails", async () => {
    mockLoad.mockResolvedValue(state());
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi
      .fn()
      .mockRejectedValue(new Error("method not found"));
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardPending,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await consumeBoardPending(mockIde);

    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("stays on mode (a) when the store is removed during the migration RPC", async () => {
    mockLoad.mockResolvedValueOnce(state()).mockResolvedValueOnce(undefined);
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn().mockResolvedValue({
      ok: true,
      processed: 1,
      subscribed: 1,
      cursorAdvanced: true,
    });
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardPending,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await consumeBoardPending(mockIde);

    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("falls back to mode (a) when migrated but registration fails on this tick", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi.fn().mockRejectedValue(new Error("timeout"));
    setConnections(
      makeConnection({ boardV2Capability: true, boardPending, boardRegister }),
    );

    await consumeBoardPending(mockIde);

    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
  });

  it("does not register or migrate against a non-v2 gateway (downgrade-safe)", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardPending = vi
      .fn()
      .mockResolvedValue({ messages: [], latestByTopic: {} });
    const boardRegister = vi.fn();
    const boardMigrateImport = vi.fn();
    setConnections(
      makeConnection({ boardPending, boardRegister, boardMigrateImport }),
    );

    await consumeBoardPending(mockIde);

    expect(boardRegister).not.toHaveBeenCalled();
    expect(boardMigrateImport).not.toHaveBeenCalled();
    expect(boardPending).toHaveBeenCalledWith(["t1"], 100);
  });

  it("keeps advancing the store cursor under mode (b) (fallback integrity)", async () => {
    mockLoad
      .mockResolvedValueOnce(state({ migrated: true }))
      .mockResolvedValueOnce(state({ migrated: true }));
    const boardPending = vi.fn().mockResolvedValue({
      messages: [message(150)],
      latestByTopic: { t1: 150 },
    });
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    setConnections(
      makeConnection({ boardV2Capability: true, boardPending, boardRegister }),
    );

    const result = await consumeBoardPending(mockIde);

    expect(result.messages).toHaveLength(1);
    expect(boardPending).toHaveBeenCalledWith();
    expect(mockSave).toHaveBeenCalledWith(
      mockIde,
      expect.objectContaining({ cursor: 150, migrated: true }),
    );
  });
});

describe("fetchBoardLatest", () => {
  it("returns undefined when no board-capable server is connected", async () => {
    setConnections();
    await expect(fetchBoardLatest(["t1"])).resolves.toBeUndefined();
  });

  it("calls boardPending in init mode: no sinceId parameter at all", async () => {
    const result: BoardPendingResult = {
      messages: [],
      latestByTopic: { t1: 42 },
    };
    const boardPending = vi.fn().mockResolvedValue(result);
    setConnections(makeConnection({ boardPending }));

    await expect(fetchBoardLatest(["t1", "t2"])).resolves.toEqual(result);
    expect(boardPending).toHaveBeenCalledTimes(1);
    expect(boardPending).toHaveBeenCalledWith(["t1", "t2"]);
    expect(boardPending.mock.calls[0]).toHaveLength(1);
  });

  it("propagates RPC errors (the caller decides how to handle them)", async () => {
    const boardPending = vi.fn().mockRejectedValue(new Error("boom"));
    setConnections(makeConnection({ boardPending }));

    await expect(fetchBoardLatest(["t1"])).rejects.toThrow("boom");
  });
});

describe("syncBoardSubscription", () => {
  it("is a no-op before migration (the migration carries changes over)", async () => {
    mockLoad.mockResolvedValue(state());
    const boardRegister = vi.fn();
    const boardMigrateImport = vi.fn();
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await expect(syncBoardSubscription(mockIde, "t2", true)).resolves.toBe(
      true,
    );
    expect(boardRegister).not.toHaveBeenCalled();
    expect(boardMigrateImport).not.toHaveBeenCalled();
  });

  it("is a no-op when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    setConnections(makeConnection({ boardV2Capability: true }));

    await expect(syncBoardSubscription(mockIde, "t1", true)).resolves.toBe(
      true,
    );
  });

  it("is a no-op against a non-v2 gateway (mode (a) semantics apply)", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi.fn();
    const boardMigrateImport = vi.fn();
    setConnections(makeConnection({ boardRegister, boardMigrateImport }));

    await expect(syncBoardSubscription(mockIde, "t2", true)).resolves.toBe(
      true,
    );
    expect(boardRegister).not.toHaveBeenCalled();
    expect(boardMigrateImport).not.toHaveBeenCalled();
  });

  it("pushes a subscribe as an upsert with the current cursor", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn().mockResolvedValue({
      ok: true,
      processed: 1,
      subscribed: 1,
      cursorAdvanced: false,
    });
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await expect(syncBoardSubscription(mockIde, "t2", true)).resolves.toBe(
      true,
    );
    expect(boardRegister).toHaveBeenCalledWith("delta");
    expect(boardMigrateImport).toHaveBeenCalledWith([
      { topic: "t2", sinceId: 100, subscribed: true },
    ]);
  });

  it("pushes an unsubscribe as a removal", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn().mockResolvedValue({
      ok: true,
      processed: 1,
      subscribed: 0,
      cursorAdvanced: false,
    });
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await expect(syncBoardSubscription(mockIde, "t1", false)).resolves.toBe(
      true,
    );
    expect(boardMigrateImport).toHaveBeenCalledWith([
      { topic: "t1", sinceId: 100, subscribed: false },
    ]);
  });

  it("clears the migrated flag when a subscribe sync fails (self-heal)", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi.fn().mockRejectedValue(new Error("down"));
    setConnections(makeConnection({ boardV2Capability: true, boardRegister }));

    await expect(syncBoardSubscription(mockIde, "t2", true)).resolves.toBe(
      false,
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty("migrated");
  });

  it("keeps the migrated flag when an unsubscribe sync fails (no self-heal for removals)", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi.fn().mockRejectedValue(new Error("down"));
    setConnections(makeConnection({ boardV2Capability: true, boardRegister }));

    await expect(syncBoardSubscription(mockIde, "t1", false)).resolves.toBe(
      false,
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("clears the migrated flag when the migrateImport sync fails on a subscribe (self-heal)", async () => {
    mockLoad.mockResolvedValue(state({ migrated: true }));
    const boardRegister = vi
      .fn()
      .mockResolvedValue({ ok: true, handle: "delta" });
    const boardMigrateImport = vi.fn().mockRejectedValue(new Error("-32602"));
    setConnections(
      makeConnection({
        boardV2Capability: true,
        boardRegister,
        boardMigrateImport,
      }),
    );

    await expect(syncBoardSubscription(mockIde, "t2", true)).resolves.toBe(
      false,
    );
    // subscribed=true → self-heal applies: flag is cleared for re-migration
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty("migrated");
  });
});
