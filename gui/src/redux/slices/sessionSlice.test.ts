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

  it("should be a no-op when only redacted thinking is present", () => {
    const state = createRescueState([
      userItem(),
      emptyAssistantItem(),
      thinkingItem("internal reasoning is hidden due to safety reasons", {
        redactedThinking: "redacted-blob",
      }),
    ]);

    const newState = sessionSlice.reducer(state, rescueAction);

    // Immer returns the same reference when nothing changed
    expect(newState.history).toBe(state.history);
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
