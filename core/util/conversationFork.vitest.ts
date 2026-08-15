import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatHistoryItem, ChatMessage, ILLM, Session } from "..";
import { NEW_SESSION_TITLE } from "./constants";
import { forkSessionWithSummary } from "./conversationFork";
import type { HistoryManager } from "./history";

// conversation-fork-with-summary.md — Phase 4 tests against the final
// implementation: validation, title rule (Decision 3), metadata takeover
// (Decision 4), read-only source + atomic save (Decisions 5/6) and the
// degenerate-fork guard (Decision 8).

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function item(
  message: ChatMessage,
  extra?: Partial<ChatHistoryItem>,
): ChatHistoryItem {
  return { message, contextItems: [], ...extra };
}

const user = (content: string): ChatMessage => ({ role: "user", content });

const assistant = (content: string): ChatMessage => ({
  role: "assistant",
  content,
});

function makeSession(overrides?: Partial<Session>): Session {
  return {
    sessionId: "source-session",
    title: "Source Session",
    workspaceDirectory: "/ws",
    history: [item(user("u0")), item(assistant("a1")), item(user("u2"))],
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

describe("forkSessionWithSummary", () => {
  let chatMock: ReturnType<typeof vi.fn>;
  let currentModel: ILLM;
  let loadMock: ReturnType<typeof vi.fn>;
  let saveMock: ReturnType<typeof vi.fn>;
  let historyManager: HistoryManager;

  beforeEach(() => {
    chatMock = vi
      .fn()
      .mockResolvedValue({ role: "assistant", content: "SUMMARY" });
    currentModel = { chat: chatMock } as unknown as ILLM;
    loadMock = vi.fn();
    saveMock = vi.fn();
    historyManager = {
      load: loadMock,
      save: saveMock,
    } as unknown as HistoryManager;
  });

  const savedSession = (): Session => saveMock.mock.calls[0][0] as Session;

  const fork = (index: number): Promise<string> =>
    forkSessionWithSummary({
      sessionId: "source-session",
      index,
      historyManager,
      currentModel,
    });

  it("creates a new session with a single synthetic item and returns its id", async () => {
    loadMock.mockReturnValue(
      makeSession({ mode: "chat", chatModelTitle: "GPT-x" }),
    );

    const newId = await fork(1);

    expect(newId).toMatch(UUID_V4_RE);
    expect(newId).not.toBe("source-session");
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith("source-session");
    expect(saveMock).toHaveBeenCalledTimes(1);

    const saved = savedSession();
    expect(saved.sessionId).toBe(newId);
    expect(saved.title).toBe("Source Session (continued)");
    expect(saved.workspaceDirectory).toBe("/ws");
    expect(saved.mode).toBe("chat");
    expect(saved.chatModelTitle).toBe("GPT-x");
    expect(saved.history).toHaveLength(1);

    const [forkItem] = saved.history;
    expect(forkItem.message).toEqual({ role: "assistant", content: "" });
    expect(forkItem.contextItems).toEqual([]);
    expect(forkItem.conversationSummary).toBe("SUMMARY");
    expect(forkItem.continuedFromSessionId).toBe("source-session");
    expect(forkItem.forkedFromIndex).toBe(1);
  });

  it("summarizes the source only up to the fork index", async () => {
    loadMock.mockReturnValue(makeSession());

    await fork(1);

    const contents = (chatMock.mock.calls[0][0] as ChatMessage[]).map(
      (m) => m.content,
    );
    expect(contents).toContain("u0");
    expect(contents).toContain("a1");
    expect(contents).not.toContain("u2");
  });

  it("keeps NEW_SESSION_TITLE when the source is still untitled", async () => {
    loadMock.mockReturnValue(makeSession({ title: NEW_SESSION_TITLE }));

    await fork(1);

    expect(savedSession().title).toBe(NEW_SESSION_TITLE);
  });

  it("omits optional metadata when the source does not have it", async () => {
    loadMock.mockReturnValue(makeSession());

    await fork(1);

    const saved = savedSession();
    expect(saved).not.toHaveProperty("mode");
    expect(saved).not.toHaveProperty("chatModelTitle");
  });

  it("throws when the source history is empty", async () => {
    loadMock.mockReturnValue(makeSession({ history: [] }));

    await expect(fork(0)).rejects.toThrow("history is empty");
    expect(chatMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it.each([-1, 3])("throws when index %i is out of range", async (index) => {
    loadMock.mockReturnValue(makeSession());

    await expect(fork(index)).rejects.toThrow("out of range");
    expect(chatMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("never writes back to the source session (read-only, atomic save)", async () => {
    // deep-frozen source: any mutation attempt would throw in strict mode
    loadMock.mockReturnValue(deepFreeze(makeSession()));

    const newId = await fork(1);

    expect(newId).toMatch(UUID_V4_RE);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(savedSession().sessionId).not.toBe("source-session");
  });

  it("propagates LLM errors and saves nothing", async () => {
    loadMock.mockReturnValue(makeSession());
    chatMock.mockRejectedValue(new Error("LLM down"));

    await expect(fork(1)).rejects.toThrow("LLM down");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("refuses to fork at a synthetic fork item (degenerate summary)", async () => {
    loadMock.mockReturnValue(
      makeSession({
        history: [
          item(assistant(""), {
            conversationSummary: "S1",
            continuedFromSessionId: "older-session",
            forkedFromIndex: 2,
          }),
        ],
      }),
    );

    await expect(fork(0)).rejects.toThrow("Cannot generate summary");
    expect(saveMock).not.toHaveBeenCalled();
  });
});
