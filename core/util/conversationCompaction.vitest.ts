import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChatHistoryItem,
  ChatMessage,
  ILLM,
  MessageContent,
  Session,
  ToolCall,
} from "..";
import {
  compactConversation,
  generateConversationSummary,
} from "./conversationCompaction";
import type { HistoryManager } from "./history";

// conversation-fork-with-summary.md — Phase 4 tests against the final
// implementation: summary generation (extracted from compactConversation)
// incl. incremental re-compaction, "Tool cancelled" fillers and the
// degenerate-input guard (Decision 8).

function item(
  message: ChatMessage,
  extra?: Partial<ChatHistoryItem>,
): ChatHistoryItem {
  return { message, contextItems: [], ...extra };
}

const user = (content: string): ChatMessage => ({ role: "user", content });

const assistant = (
  content: MessageContent,
  toolCalls?: ToolCall[],
): ChatMessage => ({
  role: "assistant",
  content,
  ...(toolCalls ? { toolCalls } : {}),
});

const toolResult = (toolCallId: string, content = "ok"): ChatMessage => ({
  role: "tool",
  content,
  toolCallId,
});

const fnCall = (id: string): ToolCall => ({
  id,
  type: "function",
  function: { name: "fn", arguments: "{}" },
});

function makeSession(history: ChatHistoryItem[]): Session {
  return {
    sessionId: "source-session",
    title: "Source Session",
    workspaceDirectory: "/ws",
    history,
  };
}

describe("generateConversationSummary", () => {
  let chatMock: ReturnType<typeof vi.fn>;
  let currentModel: ILLM;

  beforeEach(() => {
    chatMock = vi
      .fn()
      .mockResolvedValue({ role: "assistant", content: "SUMMARY" });
    currentModel = { chat: chatMock } as unknown as ILLM;
  });

  const sentMessages = (): ChatMessage[] =>
    chatMock.mock.calls[0][0] as ChatMessage[];

  it("summarizes history up to and including index, ignoring later items", async () => {
    const session = makeSession([
      item(user("u0")),
      item(assistant("a1")),
      item(user("u2")),
    ]);

    const result = await generateConversationSummary(session, 1, currentModel);

    expect(result).toBe("SUMMARY");
    expect(chatMock).toHaveBeenCalledTimes(1);
    const contents = sentMessages().map((m) => m.content);
    expect(contents).toContain("u0");
    expect(contents).toContain("a1");
    expect(contents).not.toContain("u2");
  });

  it("appends the fixed compaction prompt as the last message", async () => {
    const session = makeSession([item(user("u0"))]);

    await generateConversationSummary(session, 0, currentModel);

    const messages = sentMessages();
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("Create a comprehensive summary");
  });

  it("calls the model non-streaming with an abort signal and empty options", async () => {
    const session = makeSession([item(user("u0"))]);

    await generateConversationSummary(session, 0, currentModel);

    expect(chatMock.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(chatMock.mock.calls[0][2]).toEqual({});
  });

  it("integrates the most recent previous summary and excludes everything up to it", async () => {
    const session = makeSession([
      item(user("u0")),
      item(assistant("a1"), { conversationSummary: "S1" }),
      item(user("u2")),
      item(assistant("a3")),
    ]);

    await generateConversationSummary(session, 3, currentModel);

    const messages = sentMessages();
    expect(messages[0]).toEqual({
      role: "user",
      content: "Previous conversation summary:\n\nS1",
    });
    const contents = messages.map((m) => m.content);
    expect(contents).not.toContain("u0");
    expect(contents).not.toContain("a1");
    expect(contents).toContain("u2");
    expect(contents).toContain("a3");
  });

  it("excludes a summary on the target item itself when re-compacting", async () => {
    const session = makeSession([
      item(assistant("a0"), { conversationSummary: "S1" }),
      item(user("u1")),
      item(assistant("a2"), { conversationSummary: "S2" }),
    ]);

    await generateConversationSummary(session, 2, currentModel);

    const messages = sentMessages();
    expect(messages[0]).toEqual({
      role: "user",
      content: "Previous conversation summary:\n\nS1",
    });
    expect(JSON.stringify(messages)).not.toContain("S2");
  });

  it("re-compacting the same item reuses no summary at all", async () => {
    const session = makeSession([
      item(user("u0")),
      item(assistant("a1"), { conversationSummary: "S1" }),
    ]);

    await generateConversationSummary(session, 1, currentModel);

    const messages = sentMessages();
    expect(messages[0]).toEqual({ role: "user", content: "u0" });
    expect(JSON.stringify(messages)).not.toContain(
      "Previous conversation summary",
    );
  });

  it("adds explicit 'Tool cancelled' results for dangling tool calls", async () => {
    const session = makeSession([
      item(user("u0")),
      item(assistant("", [fnCall("tc1")])),
    ]);

    await generateConversationSummary(session, 1, currentModel);

    const messages = sentMessages();
    const fillerIndex = messages.findIndex(
      (m) => m.role === "tool" && m.content === "Tool cancelled",
    );
    // directly after the assistant message carrying the tool call
    expect(fillerIndex).toBe(2);
    expect((messages[fillerIndex] as { toolCallId?: string }).toolCallId).toBe(
      "tc1",
    );
  });

  it("does not add fillers when the tool result exists", async () => {
    const session = makeSession([
      item(user("u0")),
      item(assistant("", [fnCall("tc1")])),
      item(toolResult("tc1", "real result")),
    ]);

    await generateConversationSummary(session, 2, currentModel);

    const tools = sentMessages().filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].content).toBe("real result");
  });

  it("throws when the effective input contains no non-empty message", async () => {
    const session = makeSession([item(assistant(""))]);

    await expect(
      generateConversationSummary(session, 0, currentModel),
    ).rejects.toThrow("Cannot generate summary");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("treats whitespace-only strings and empty part arrays as empty", async () => {
    for (const content of ["   ", []] as MessageContent[]) {
      const session = makeSession([item(assistant(content))]);
      await expect(
        generateConversationSummary(session, 0, currentModel),
      ).rejects.toThrow("Cannot generate summary");
    }
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("throws when forking at a synthetic fork item (own summary excluded)", async () => {
    // Decision 8: the fork item's only message is empty and its own summary
    // is excluded from the re-compaction search
    const session = makeSession([
      item(assistant(""), {
        conversationSummary: "S1",
        continuedFromSessionId: "older-session",
        forkedFromIndex: 0,
      }),
    ]);

    await expect(
      generateConversationSummary(session, 0, currentModel),
    ).rejects.toThrow("Cannot generate summary");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("accepts input that consists of a previous summary only", async () => {
    const session = makeSession([
      item(assistant(""), { conversationSummary: "S1" }),
      item(assistant("")),
    ]);

    const result = await generateConversationSummary(session, 1, currentModel);

    expect(result).toBe("SUMMARY");
    expect(sentMessages()[0]).toEqual({
      role: "user",
      content: "Previous conversation summary:\n\nS1",
    });
  });

  it("strips image parts from the model response", async () => {
    chatMock.mockResolvedValue({
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "imageUrl", imageUrl: { url: "http://example.com/x.png" } },
        { type: "text", text: "World" },
      ],
    });
    const session = makeSession([item(user("u0"))]);

    const result = await generateConversationSummary(session, 0, currentModel);

    expect(result).toBe("Hello\nWorld");
  });
});

describe("compactConversation", () => {
  let chatMock: ReturnType<typeof vi.fn>;
  let currentModel: ILLM;
  let saveMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chatMock = vi
      .fn()
      .mockResolvedValue({ role: "assistant", content: "SUMMARY" });
    currentModel = { chat: chatMock } as unknown as ILLM;
    saveMock = vi.fn();
  });

  const makeHistoryManager = (session: Session): HistoryManager =>
    ({
      load: vi.fn().mockReturnValue(session),
      save: saveMock,
    }) as unknown as HistoryManager;

  it("writes the summary onto the target item and saves the session", async () => {
    const session = makeSession([item(user("u0")), item(assistant("a1"))]);

    await compactConversation({
      sessionId: "source-session",
      index: 1,
      historyManager: makeHistoryManager(session),
      currentModel,
    });

    expect(saveMock).toHaveBeenCalledTimes(1);
    const saved = saveMock.mock.calls[0][0] as Session;
    expect(saved.sessionId).toBe("source-session");
    expect(saved.title).toBe("Source Session");
    expect(saved.history[1].conversationSummary).toBe("SUMMARY");
    // other items pass through untouched (same reference)
    expect(saved.history[0]).toBe(session.history[0]);
  });

  it("does not mutate the loaded session object", async () => {
    const session = makeSession([item(user("u0")), item(assistant("a1"))]);

    await compactConversation({
      sessionId: "source-session",
      index: 1,
      historyManager: makeHistoryManager(session),
      currentModel,
    });

    expect(session.history[1].conversationSummary).toBeUndefined();
  });
});
