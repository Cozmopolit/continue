import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchBoardLatest,
  syncBoardSubscription,
} from "../../board/boardClient";
import {
  BoardState,
  loadBoardState,
  saveBoardState,
} from "../../board/boardState";
import {
  boardSubscriptionsImpl,
  boardSubscribeImpl,
  boardUnsubscribeImpl,
} from "./boardTools";

// Only the state IO and the gateway roundtrips are mocked; the validators run
// for real (their behavior is additionally covered in boardState.vitest.ts).
vi.mock("../../board/boardClient", () => ({
  fetchBoardLatest: vi.fn(),
  syncBoardSubscription: vi.fn(),
}));

vi.mock("../../board/boardState", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../board/boardState")>();
  return {
    ...actual,
    loadBoardState: vi.fn(),
    saveBoardState: vi.fn(),
  };
});

const mockLoad = vi.mocked(loadBoardState);
const mockSave = vi.mocked(saveBoardState);
const mockFetchLatest = vi.mocked(fetchBoardLatest);
const mockSync = vi.mocked(syncBoardSubscription);

const extras = { ide: {} } as any;

const existingState = (overrides: Partial<BoardState> = {}): BoardState => ({
  handle: "delta",
  topics: [],
  cursor: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue(undefined);
  mockSync.mockResolvedValue(true);
});

describe("boardSubscribeImpl", () => {
  it("rejects an invalid handle", async () => {
    await expect(
      boardSubscribeImpl({ handle: "bad→handle", topic: "t1" }, extras),
    ).rejects.toThrow("envelope delimiters");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects a missing handle", async () => {
    await expect(boardSubscribeImpl({ topic: "t1" }, extras)).rejects.toThrow(
      "Board handle must not be empty",
    );
  });

  it("rejects an invalid topic", async () => {
    await expect(
      boardSubscribeImpl({ handle: "delta", topic: "bad·topic" }, extras),
    ).rejects.toThrow("envelope delimiters");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects a handle conflict with the existing workspace state", async () => {
    mockLoad.mockResolvedValue(existingState({ handle: "other-agent" }));
    await expect(
      boardSubscribeImpl({ handle: "delta", topic: "t1" }, extras),
    ).rejects.toThrow(/Board handle conflict/);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("is a no-op when the topic is already subscribed", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t1"], cursor: 7 }));
    const result = await boardSubscribeImpl(
      { handle: "delta", topic: "t1" },
      extras,
    );
    expect(result[0].name).toBe("Already subscribed");
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockFetchLatest).not.toHaveBeenCalled();
  });

  it("appends a new topic to existing state and syncs the subscription (no init roundtrip)", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t0"], cursor: 7 }));
    const result = await boardSubscribeImpl(
      { handle: "delta", topic: "t1" },
      extras,
    );
    expect(mockFetchLatest).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledWith(
      extras.ide,
      expect.objectContaining({ topics: ["t0", "t1"] }),
    );
    expect(mockSync).toHaveBeenCalledWith(extras.ide, "t1", true);
    expect(result[0].name).toBe("Subscribed");
    expect(result[0].content).toContain("id > current cursor 7");
    expect(result[0].content).toContain("msg_list");
    expect(result[0].content).not.toContain("subscription sync failed");
  });

  it("surfaces a note when the server-side subscription sync fails", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t0"], cursor: 7 }));
    mockSync.mockResolvedValue(false);
    const result = await boardSubscribeImpl(
      { handle: "delta", topic: "t1" },
      extras,
    );
    expect(result[0].content).toContain("server-side subscription sync failed");
    expect(result[0].content).toContain("re-migrates");
  });

  it("does not sync on the already-subscribed no-op path", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t1"], cursor: 7 }));
    await boardSubscribeImpl({ handle: "delta", topic: "t1" }, extras);
    expect(mockSync).not.toHaveBeenCalled();
  });

  describe("first subscription (cursor bootstrap via init-mode fetch)", () => {
    it("bootstraps the cursor from latestByTopic when the topic has messages", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue({
        messages: [],
        latestByTopic: { t1: 42 },
      });
      const result = await boardSubscribeImpl(
        { handle: "delta", topic: "t1" },
        extras,
      );
      expect(mockFetchLatest).toHaveBeenCalledWith(["t1"]);
      expect(mockSave).toHaveBeenCalledWith(extras.ide, {
        handle: "delta",
        topics: ["t1"],
        cursor: 42,
      });
      expect(result[0].content).toContain("Cursor set to 42");
      expect(result[0].content).not.toContain("does not exist");
      expect(result[0].content).not.toContain("no messages yet");
    });

    it("takes the highest id when the gateway reports several topics", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue({
        messages: [],
        latestByTopic: { other: 10, t1: 42 },
      });
      await boardSubscribeImpl({ handle: "delta", topic: "t1" }, extras);
      expect(mockSave).toHaveBeenCalledWith(
        extras.ide,
        expect.objectContaining({ cursor: 42 }),
      );
    });

    it("notes an existing-but-empty topic via emptyTopics (contract annex)", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue({
        messages: [],
        latestByTopic: {},
        emptyTopics: ["t1"],
      });
      const result = await boardSubscribeImpl(
        { handle: "delta", topic: "t1" },
        extras,
      );
      expect(mockSave).toHaveBeenCalledWith(
        extras.ide,
        expect.objectContaining({ cursor: 0 }),
      );
      expect(result[0].content).toContain("exists but has no messages yet");
    });

    it("warns about typos when the topic does not exist on the board", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue({
        messages: [],
        latestByTopic: {},
        emptyTopics: [],
      });
      const result = await boardSubscribeImpl(
        { handle: "delta", topic: "t1" },
        extras,
      );
      expect(result[0].content).toContain("does not exist on the board");
    });

    it("treats a missing emptyTopics field (pre-annex gateway) as 'does not exist'", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue({ messages: [], latestByTopic: {} });
      const result = await boardSubscribeImpl(
        { handle: "delta", topic: "t1" },
        extras,
      );
      expect(result[0].content).toContain("does not exist on the board");
    });

    it("persists cursor 0 when no board-capable server is connected", async () => {
      mockLoad.mockResolvedValue(undefined);
      mockFetchLatest.mockResolvedValue(undefined);
      const result = await boardSubscribeImpl(
        { handle: "delta", topic: "t1" },
        extras,
      );
      expect(mockSave).toHaveBeenCalledWith(extras.ide, {
        handle: "delta",
        topics: ["t1"],
        cursor: 0,
      });
      expect(result[0].content).toContain("no board-capable MCP server");
    });
  });
});

describe("boardUnsubscribeImpl", () => {
  it("rejects an invalid topic", async () => {
    await expect(boardUnsubscribeImpl({ topic: "" }, extras)).rejects.toThrow(
      "Board topic must not be empty",
    );
  });

  it("rejects when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    await expect(boardUnsubscribeImpl({ topic: "t1" }, extras)).rejects.toThrow(
      /Not subscribed/,
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects when the topic is not subscribed", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["other"] }));
    await expect(boardUnsubscribeImpl({ topic: "t1" }, extras)).rejects.toThrow(
      /Not subscribed to "t1"/,
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("removes the topic, reports the remaining ones, and syncs the removal", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t0", "t1"] }));
    const result = await boardUnsubscribeImpl({ topic: "t1" }, extras);
    expect(mockSave).toHaveBeenCalledWith(
      extras.ide,
      expect.objectContaining({ topics: ["t0"] }),
    );
    expect(mockSync).toHaveBeenCalledWith(extras.ide, "t1", false);
    expect(result[0].content).toContain("Remaining topics: t0");
    expect(result[0].content).not.toContain("propagation failed");
  });

  it("surfaces a note when server-side removal propagation fails", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t1"] }));
    mockSync.mockResolvedValue(false);
    const result = await boardUnsubscribeImpl({ topic: "t1" }, extras);
    expect(result[0].content).toContain("server-side propagation failed");
    expect(result[0].content).toContain("may still be injected");
  });

  it("reports (none) when the last topic is removed", async () => {
    mockLoad.mockResolvedValue(existingState({ topics: ["t1"] }));
    const result = await boardUnsubscribeImpl({ topic: "t1" }, extras);
    expect(mockSave).toHaveBeenCalledWith(
      extras.ide,
      expect.objectContaining({ topics: [] }),
    );
    expect(result[0].content).toContain("(none)");
  });
});

describe("boardSubscriptionsImpl", () => {
  it("points at board_subscribe when no state exists", async () => {
    mockLoad.mockResolvedValue(undefined);
    const result = await boardSubscriptionsImpl({}, extras);
    expect(result[0].content).toContain("No board subscriptions");
    expect(result[0].content).toContain("board_subscribe");
  });

  it("lists handle, cursor and topics", async () => {
    mockLoad.mockResolvedValue(
      existingState({ handle: "delta", topics: ["t1", "t2"], cursor: 42 }),
    );
    const result = await boardSubscriptionsImpl({}, extras);
    expect(result[0].description).toBe("2 topic(s)");
    expect(result[0].content).toContain("handle: delta");
    expect(result[0].content).toContain("cursor: 42");
    expect(result[0].content).toContain("- t1");
    expect(result[0].content).toContain("- t2");
  });

  it("renders an empty topic list", async () => {
    mockLoad.mockResolvedValue(existingState());
    const result = await boardSubscriptionsImpl({}, extras);
    expect(result[0].description).toBe("0 topic(s)");
    expect(result[0].content).toContain("topics: (none)");
  });
});
