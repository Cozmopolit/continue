import {
  ChatMessage,
  ThinkingChatMessage,
  ToolCallState,
  ToolStatus,
} from "core";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToolCallDeltaToState } from "../../util/toolCallState";
import {
  ChatHistoryItemWithMessageId,
  formatInterruptedReasoningContent,
  sessionSlice,
} from "./sessionSlice";

// Mock dependencies
vi.mock("uuid");
vi.mock("core/util/messageContent");
vi.mock("../../util/toolCallState");

const mockUuidv4 = vi.mocked(uuidv4);
const mockRenderChatMessage = vi.mocked(renderChatMessage);
const mockAddToolCallDeltaToState = vi.mocked(addToolCallDeltaToState);

describe("sessionSlice streamUpdate", () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();

    // Mock uuidv4 to return predictable values
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `mock-uuid-${++callCount}`);

    // Mock renderChatMessage to return content as is
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });

    // Mock addToolCallDeltaToState
    mockAddToolCallDeltaToState.mockImplementation((delta, state) => {
      return {
        status: "generating" as const,
        toolCall: {
          id: delta.id || "mock-tool-id",
          type: "function" as const,
          function: {
            name: delta.function?.name || "mock-function",
            arguments: delta.function?.arguments || "{}",
          },
        },
        toolCallId: delta.id || "mock-tool-id",
        parsedArgs: {},
      };
    });
  });

  const createInitialState = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: {
          role: "user" as const,
          content: "This is a test.",
          id: "initial-user-message",
        },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    },
  });

  describe("Basic Chat Message", () => {
    it("should append assistant message to history", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Here is a response to your message without thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message without thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
      expect(newState.history[1].contextItems).toEqual([]);
    });
  });

  describe("Chat Message With Thinking", () => {
    it("should split thinking and assistant content correctly", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content:
              "<think>I should send the user a response.</think> Here is a response to your message with thinking.",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should send the user a response.",
      );

      // Check assistant message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe(
        "Here is a response to your message with thinking.",
      );
      expect(newState.history[1].message.id).toBe("mock-uuid-1");
    });
  });

  describe("Tool Call With Response", () => {
    it("should handle tool call followed by tool response and assistant message", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "I see, the tool found 3 files.",
          },
        ],
      };
      newState = sessionSlice.reducer(newState, toolResponseAction);
      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );
      expect((newState.history[2].message as any).toolCallId).toBe("1234");

      // Check final assistant message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
    });
  });

  describe("Tool Call With Streaming Response", () => {
    it("should handle streaming assistant response after tool call", () => {
      const initialState = createInitialState();
      const toolCallAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "<think>I should use a tool call.</think>",
            toolCalls: [
              {
                id: "1234",
                type: "function" as const,
                function: {
                  name: "builtin_ls",
                  arguments: '{"dirPath":".","recursive":false}',
                },
              },
            ],
          },
        ],
      };

      let newState = sessionSlice.reducer(initialState, toolCallAction);
      expect(newState.history).toHaveLength(2);

      // Check reasoning
      expect(newState.history[0].reasoning?.text).toBe(
        "I should use a tool call.",
      );

      // Check generating message
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].message.content).toBe("");
      expect(newState.history[1].toolCallStates?.[0]?.status).toBe(
        "generating",
      );
      expect(newState.history[1].toolCallStates?.[0]?.toolCallId).toBe("1234");

      const toolResponseAction = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "tool" as const,
            toolCallId: "1234",
            content: "foo.txt\nbar.txt\nexample.php",
          },
          {
            role: "assistant" as const,
            content: "<think>",
          },
          {
            role: "assistant" as const,
            content: "Good, ",
          },
          {
            role: "assistant" as const,
            content: "I received a list",
          },
          {
            role: "assistant" as const,
            content: " of files.",
          },
          {
            role: "assistant" as const,
            content: "</think>",
          },
          {
            role: "assistant" as const,
            content: "\n",
          },
          {
            role: "assistant" as const,
            content: "I see, ",
          },
          {
            role: "assistant" as const,
            content: "the tool ",
          },
          {
            role: "assistant" as const,
            content: "found 3 ",
          },
          {
            role: "assistant" as const,
            content: "files.",
          },
        ],
      };

      newState = sessionSlice.reducer(newState, toolResponseAction);

      expect(newState.history).toHaveLength(4);

      // Check tool message
      expect(newState.history[2].message.role).toBe("tool");
      expect(newState.history[2].message.content).toBe(
        "foo.txt\nbar.txt\nexample.php",
      );

      // Check response message
      expect(newState.history[3].message.role).toBe("assistant");
      expect(newState.history[3].message.content).toBe(
        "I see, the tool found 3 files.",
      );
      expect(newState.history[3].reasoning?.text).toBe(
        "Good, I received a list of files.",
      );
      expect(newState.history[3].reasoning?.active).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty history gracefully", () => {
      const initialState = createInitialState();
      initialState.history = [];

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "Hello",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      // Should not crash and history should remain empty
      expect(newState.history).toHaveLength(0);
    });

    it("should handle redacted thinking messages", () => {
      const initialState = createInitialState();
      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            content: "This should be hidden",
            redactedThinking: true,
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("thinking");
      expect(newState.history[1].message.content).toBe(
        "internal reasoning is hidden due to safety reasons",
      );
      expect((newState.history[1].message as any).redactedThinking).toBe(true);
    });

    it("should handle signature updates for thinking messages", () => {
      const initialState = createInitialState();
      // First add a thinking message
      initialState.history.push({
        message: {
          role: "thinking",
          content: "Some thinking",
          id: "thinking-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "thinking" as const,
            signature: "test-signature",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect((newState.history[1].message as any).signature).toBe(
        "test-signature",
      );
    });

    it("should accumulate content for same role messages", () => {
      const initialState = createInitialState();
      // Add an assistant message first
      initialState.history.push({
        message: {
          role: "assistant",
          content: "Hello ",
          id: "assistant-message",
        },
        contextItems: [],
      });

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "world!",
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.content).toBe("Hello world!");
    });

    it("should handle basic tool call streaming", () => {
      const initialState = createInitialState();
      const toolCallId = "call_123";

      const action = {
        type: "session/streamUpdate",
        payload: [
          {
            role: "assistant" as const,
            content: "",
            toolCalls: [
              {
                id: toolCallId,
                type: "function" as const,
                function: {
                  name: "test_tool",
                  arguments: '{"arg":"value"}',
                },
              },
            ],
          },
        ],
      };

      const newState = sessionSlice.reducer(initialState, action);

      expect(newState.history).toHaveLength(2);
      expect(newState.history[1].message.role).toBe("assistant");
      expect(newState.history[1].toolCallStates).toHaveLength(1);
    });
  });
});

describe("sessionSlice setContextPercentage", () => {
  const createMinimalState = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    },
  });

  it("should store percentage and token counts when full payload is provided", () => {
    const newState = sessionSlice.reducer(createMinimalState(), {
      type: "session/setContextPercentage",
      payload: {
        percentage: 0.42,
        inputTokens: 8432,
        availableTokens: 20000,
      },
    });

    expect(newState.contextPercentage).toBe(0.42);
    expect(newState.contextTokens).toEqual({
      inputTokens: 8432,
      availableTokens: 20000,
    });
  });

  it("should store only percentage and clear token counts when token fields are absent", () => {
    const newState = sessionSlice.reducer(createMinimalState(), {
      type: "session/setContextPercentage",
      payload: { percentage: 0.9 },
    });

    expect(newState.contextPercentage).toBe(0.9);
    expect(newState.contextTokens).toBeUndefined();
  });

  it("should clear previously stored token counts when a later payload omits them", () => {
    const withTokens = sessionSlice.reducer(createMinimalState(), {
      type: "session/setContextPercentage",
      payload: {
        percentage: 0.5,
        inputTokens: 100,
        availableTokens: 200,
      },
    });
    expect(withTokens.contextTokens).toBeDefined();

    const cleared = sessionSlice.reducer(withTokens, {
      type: "session/setContextPercentage",
      payload: { percentage: 0.6, inputTokens: undefined },
    });

    expect(cleared.contextPercentage).toBe(0.6);
    expect(cleared.contextTokens).toBeUndefined();
  });

  it("should clear token counts when only availableTokens is missing", () => {
    const newState = sessionSlice.reducer(createMinimalState(), {
      type: "session/setContextPercentage",
      payload: { percentage: 0.5, inputTokens: 100 },
    });

    expect(newState.contextPercentage).toBe(0.5);
    expect(newState.contextTokens).toBeUndefined();
  });
});

describe("sessionSlice endActiveReasoning", () => {
  const createStateWithReasoning = (reasoning?: {
    active: boolean;
    text: string;
    startAt: number;
    endAt?: number;
  }) => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: { id: "1", role: "assistant", content: "partial answer" },
        contextItems: [],
        reasoning,
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: true,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    },
  });

  it("should end active reasoning and stamp endAt", () => {
    const before = Date.now();
    const newState = sessionSlice.reducer(
      createStateWithReasoning({
        active: true,
        text: "thinking",
        startAt: before - 1000,
      }),
      { type: "session/endActiveReasoning" },
    );

    expect(newState.history[0].reasoning?.active).toBe(false);
    expect(newState.history[0].reasoning?.endAt).toBeGreaterThanOrEqual(before);
  });

  it("should not attach promptLogs", () => {
    const newState = sessionSlice.reducer(
      createStateWithReasoning({ active: true, text: "thinking", startAt: 1 }),
      { type: "session/endActiveReasoning" },
    );

    expect(newState.history[0].promptLogs).toBeUndefined();
  });

  it("should be a no-op when reasoning is not active", () => {
    const reasoning = { active: false, text: "done", startAt: 1, endAt: 2 };
    const newState = sessionSlice.reducer(createStateWithReasoning(reasoning), {
      type: "session/endActiveReasoning",
    });

    expect(newState.history[0].reasoning).toEqual(reasoning);
  });

  it("should handle missing reasoning and empty history gracefully", () => {
    expect(() =>
      sessionSlice.reducer(createStateWithReasoning(undefined), {
        type: "session/endActiveReasoning",
      }),
    ).not.toThrow();

    const emptyHistory = {
      ...createStateWithReasoning(undefined),
      history: [] as ChatHistoryItemWithMessageId[],
    };
    expect(() =>
      sessionSlice.reducer(emptyHistory, {
        type: "session/endActiveReasoning",
      }),
    ).not.toThrow();
  });
});

describe("formatInterruptedReasoningContent", () => {
  it("should wrap the reasoning text with intro marker and continuation hint", () => {
    const result = formatInterruptedReasoningContent("Let me analyze this.");

    expect(result).toContain("Let me analyze this.");
    expect(result.startsWith("[Response interrupted mid-stream")).toBe(true);
    expect(result.endsWith("adjust course as instructed.]")).toBe(true);
  });

  it("should preserve multi-line reasoning verbatim", () => {
    const reasoning = "Step one.\n\nStep two:\n- detail a\n- detail b";

    const result = formatInterruptedReasoningContent(reasoning);

    expect(result).toContain(reasoning);
  });
});

describe("sessionSlice rescueInterruptedReasoning", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // renderChatMessage is auto-mocked module-wide; the pass-through
    // implementation is only configured in the streamUpdate describe, so it
    // must be set again here.
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });
  });

  const rescueAction = { type: "session/rescueInterruptedReasoning" };

  const createRescueState = (history: ChatHistoryItemWithMessageId[]) => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history,
    isStreaming: true,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: {
      states: [],
      curIndex: 0,
    },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    },
  });

  const userItem = (): ChatHistoryItemWithMessageId => ({
    message: { id: "user-1", role: "user", content: "Hello" },
    contextItems: [],
  });

  const emptyAssistantItem = (): ChatHistoryItemWithMessageId => ({
    message: { id: "assistant-1", role: "assistant", content: "" },
    contextItems: [],
  });

  const thinkingItem = (
    content: string,
    extra?: { redactedThinking?: string; signature?: string },
  ): ChatHistoryItemWithMessageId => ({
    message: {
      id: `thinking-${content.length}`,
      role: "thinking",
      content,
      ...extra,
    } as ThinkingChatMessage & { id: string },
    contextItems: [],
  });

  const toolCallState = (status: ToolStatus): ToolCallState => ({
    status,
    toolCallId: "tc-1",
    toolCall: {
      id: "tc-1",
      type: "function",
      function: { name: "mock_tool", arguments: "{}" },
    },
    parsedArgs: {},
  });

  it("should rescue a dangling thinking item into the empty assistant turn (Path A)", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("Let me analyze this step by step"),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(2);
    expect(newState.history[1].message.role).toBe("assistant");
    expect(newState.history[1].message.content).toBe(
      formatInterruptedReasoningContent("Let me analyze this step by step"),
    );
    expect(newState.history[1].reasoning).toBeUndefined();
  });

  it("should rescue partial item reasoning from an empty assistant turn (Path B)", () => {
    const assistant = emptyAssistantItem();
    assistant.reasoning = {
      text: "First I need to check the files",
      active: true,
      startAt: 123,
    };
    const state = createRescueState([userItem(), assistant]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(2);
    expect(newState.history[1].message.content).toBe(
      formatInterruptedReasoningContent("First I need to check the files"),
    );
    expect(newState.history[1].reasoning).toBeUndefined();
  });

  it("should join multiple thinking items chronologically", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("part one"),
      thinkingItem("part two"),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(2);
    expect(newState.history[1].message.content).toBe(
      formatInterruptedReasoningContent("part one\n\npart two"),
    );
  });

  it("should skip redacted thinking items but rescue real ones", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("internal reasoning is hidden due to safety reasons", {
        redactedThinking: "redacted-blob",
      }),
      thinkingItem("real thought"),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(2);
    expect(newState.history[1].message.content).toBe(
      formatInterruptedReasoningContent("real thought"),
    );
  });

  it("should remove redacted thinking items without creating a marker when no rescuable text exists", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("internal reasoning is hidden due to safety reasons", {
        redactedThinking: "redacted-blob",
      }),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    // The redacted item is stripped so its native metadata cannot leak into
    // native resend paths, but no marker is created without rescued text
    expect(newState.history).toHaveLength(2);
    expect(
      newState.history.some((item) => item.message.role === "thinking"),
    ).toBe(false);
    expect(newState.history[1].message.role).toBe("assistant");
    expect(newState.history[1].message.content).toBe("");
  });

  it("should also strip thinking items with only whitespace text and create no marker", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("   "),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(2);
    expect(
      newState.history.some((item) => item.message.role === "thinking"),
    ).toBe(false);
    expect(newState.history[1].message.content).toBe("");
  });

  it("should be a no-op when the assistant already has content", () => {
    const assistant = emptyAssistantItem();
    assistant.message.content = "partial answer";
    const state = createRescueState([
      userItem(),
      thinkingItem("some reasoning"),
      assistant,
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should be a no-op when the assistant has generated tool calls", () => {
    const assistant = emptyAssistantItem();
    assistant.toolCallStates = [toolCallState("canceled")];
    const state = createRescueState([
      userItem(),
      assistant,
      thinkingItem("some reasoning"),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should be a no-op while tool calls are still generating", () => {
    const assistant = emptyAssistantItem();
    assistant.toolCallStates = [toolCallState("generating")];
    const state = createRescueState([userItem(), assistant]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should be a no-op when there is no reasoning (stop before first token)", () => {
    const state = createRescueState([userItem(), emptyAssistantItem()]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should be a no-op for histories with fewer than two items", () => {
    const state = createRescueState([userItem()]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should be a no-op when the history ends with a user message", () => {
    const assistant = emptyAssistantItem();
    assistant.message.content = "earlier answer";
    const state = createRescueState([assistant, userItem()]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toBe(state.history);
  });

  it("should only rescue the tail after the last tool message", () => {
    const completedAssistant = emptyAssistantItem();
    completedAssistant.message.id = "assistant-0";
    completedAssistant.message.content = "earlier answer";
    const state = createRescueState([
      userItem(),
      thinkingItem("from the completed turn"),
      completedAssistant,
      {
        message: {
          id: "tool-1",
          role: "tool",
          content: "tool output",
          toolCallId: "tc-0",
        },
        contextItems: [],
      },
      emptyAssistantItem(),
      thinkingItem("new reasoning after tool call"),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    expect(newState.history).toHaveLength(5);
    // The thinking of the completed turn is untouched
    expect(newState.history[1].message.role).toBe("thinking");
    expect(newState.history[1].message.content).toBe("from the completed turn");
    // The empty assistant after the tool message carries the rescued text
    expect(newState.history[4].message.content).toBe(
      formatInterruptedReasoningContent("new reasoning after tool call"),
    );
    expect(
      newState.history.some((item) => item.message.role === "thinking"),
    ).toBe(true);
  });
});

describe("sessionSlice newSession board reset", () => {
  const createStateWithBoard = () => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: { states: [], curIndex: 0 },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [
        {
          topic: "t",
          id: 1,
          from: "a",
          to: "*",
          createdAt: "2026-08-14T09:00:00Z",
          body: "old session mail",
        },
      ],
      droppedCount: 1,
      omittedTotal: 1,
      omittedOldestId: 3,
      tooLargeIds: [5],
      lastFetchAt: 123,
    },
  });

  it("resets board state on newSession(undefined)", () => {
    const newState = sessionSlice.reducer(createStateWithBoard(), {
      type: "session/newSession",
      payload: undefined,
    });
    expect(newState.board).toEqual({
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    });
    expect(newState.history).toHaveLength(0);
    expect(newState.id).not.toBe("test-session-id");
    expect(newState.lastSessionId).toBe("test-session-id");
  });

  it("resets board state on newSession(payload)", () => {
    const payload = {
      history: [
        {
          message: { id: "u1", role: "user", content: "hi" },
          contextItems: [],
        },
      ],
      title: "Restored",
      sessionId: "restored-id",
      mode: "agent",
    };
    const newState = sessionSlice.reducer(createStateWithBoard(), {
      type: "session/newSession",
      payload: payload as any,
    });
    expect(newState.board.messages).toEqual([]);
    expect(newState.board.lastFetchAt).toBeUndefined();
    expect(newState.history).toHaveLength(1);
    expect(newState.id).toBe("restored-id");
    expect(newState.title).toBe("Restored");
  });
});

describe("Thinking reasoning_details stream accumulation (resent-user-messages incident)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let callCount = 0;
    mockUuidv4.mockImplementation(() => `mock-uuid-${++callCount}`);
    mockRenderChatMessage.mockImplementation((message: ChatMessage) => {
      if (typeof message.content === "string") {
        return message.content;
      }
      return "";
    });
    mockAddToolCallDeltaToState.mockImplementation((delta, state) => {
      return {
        status: "generating" as const,
        toolCall: {
          id: delta.id || "mock-tool-id",
          type: "function" as const,
          function: {
            name: delta.function?.name || "mock-function",
            arguments: delta.function?.arguments || "{}",
          },
        },
        toolCallId: delta.id || "mock-tool-id",
        parsedArgs: {},
      };
    });
  });

  // Self-contained state factory (the createInitialState above is scoped to
  // the streamUpdate describe). Shape mirrors "sessionSlice newSession board
  // reset" below.
  const createInitialState = (): any => ({
    lastSessionId: undefined,
    allSessionMetadata: [],
    history: [
      {
        message: {
          role: "user" as const,
          content: "This is a test.",
          id: "initial-user-message",
        },
        contextItems: [],
      },
    ] as ChatHistoryItemWithMessageId[],
    isStreaming: false,
    title: "Test Session",
    id: "test-session-id",
    streamAborter: new AbortController(),
    symbols: {},
    mode: "chat" as const,
    isInEdit: false,
    codeBlockApplyStates: { states: [], curIndex: 0 },
    newestToolbarPreviewForInput: {},
    isSessionMetadataLoading: false,
    compactionLoading: {},
    pendingSelfCompaction: false,
    streamAborted: false,
    board: {
      messages: [],
      droppedCount: 0,
      omittedTotal: 0,
      omittedOldestId: undefined,
      tooLargeIds: [],
      lastFetchAt: undefined,
    },
  });

  // OpenRouter-style thinking chunks: every chunk carries both content and a
  // reasoning_details block for the same delta.
  const thinkingChunk = (text: string): ChatMessage => ({
    role: "thinking",
    content: text,
    reasoning_details: [
      { type: "reasoning_text", text, format: "unknown", index: 0 },
    ],
  });

  const applyChunks = (
    state: ReturnType<typeof sessionSlice.reducer>,
    payload: ChatMessage[],
  ) =>
    sessionSlice.reducer(state, {
      type: "session/streamUpdate",
      payload,
    });

  it("does not duplicate the first reasoning delta in reasoning_details", () => {
    let state = createInitialState();
    for (const text of ["The", " user", " wants this."]) {
      state = applyChunks(state, [thinkingChunk(text)]);
    }

    const thinking = state.history[1].message as ThinkingChatMessage;
    expect(thinking.role).toBe("thinking");
    expect(thinking.content).toBe("The user wants this.");
    // Regression: before the fix, the first chunk's reasoning_details were
    // carried into the new history item via spread AND merged again in the
    // same reducer pass, producing "TheThe user wants this." — the stutter
    // signature found in all 62 thinking items of incident session
    // 9d6a6c41 (zenith).
    expect(thinking.reasoning_details).toHaveLength(1);
    expect(thinking.reasoning_details![0].text).toBe("The user wants this.");
  });

  it("keeps every thinking phase clean across a tool loop", () => {
    let state = createInitialState();
    // Phase 1: thinking -> assistant tool call
    state = applyChunks(state, [thinkingChunk("Check")]);
    state = applyChunks(state, [thinkingChunk(" the files.")]);
    state = applyChunks(state, [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "readFile", arguments: "{}" },
          },
        ],
      },
    ]);
    state = applyChunks(state, [
      { role: "tool", content: "ok", toolCallId: "call_1" },
    ]);
    // Phase 2: new thinking phase right after the tool result — exactly the
    // transition where the "user sent the same message again" belief formed.
    state = applyChunks(state, [thinkingChunk("Done")]);
    state = applyChunks(state, [thinkingChunk(" now.")]);

    const thinkingItems = state.history.filter(
      (item: ChatHistoryItemWithMessageId) => item.message.role === "thinking",
    );
    expect(thinkingItems).toHaveLength(2);
    const [first, second] = thinkingItems.map(
      (item: ChatHistoryItemWithMessageId) =>
        item.message as ThinkingChatMessage,
    );
    expect(first.content).toBe("Check the files.");
    expect(first.reasoning_details![0].text).toBe("Check the files.");
    expect(second.content).toBe("Done now.");
    expect(second.reasoning_details![0].text).toBe("Done now.");
  });

  it("still records signature-only chunks and merges later deltas once", () => {
    let state = createInitialState();
    state = applyChunks(state, [
      { role: "thinking", content: "", signature: "sig-1" },
    ]);
    state = applyChunks(state, [thinkingChunk("Think.")]);

    const thinking = state.history[1].message as ThinkingChatMessage;
    expect(thinking.signature).toBe("sig-1");
    expect(thinking.content).toBe("Think.");
    expect(thinking.reasoning_details).toHaveLength(1);
    expect(thinking.reasoning_details![0].text).toBe("Think.");
  });

  it("survives chunks whose reasoning_details arrive only on the first chunk", () => {
    let state = createInitialState();
    state = applyChunks(state, [thinkingChunk("Only")]);
    state = applyChunks(state, [{ role: "thinking", content: " first." }]);

    const thinking = state.history[1].message as ThinkingChatMessage;
    expect(thinking.content).toBe("Only first.");
    expect(thinking.reasoning_details).toHaveLength(1);
    expect(thinking.reasoning_details![0].text).toBe("Only");
  });
});
