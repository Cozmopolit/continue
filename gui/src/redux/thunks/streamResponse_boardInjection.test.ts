import { JSONContent } from "@tiptap/core";
import {
  AssistantChatMessage,
  BoardMessage,
  BoardPendingResult,
  InputModifiers,
  ModelDescription,
} from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  setBoardInjectionBlock,
  setBoardInjectionConsumed,
  streamUpdate,
} from "../slices/sessionSlice";
import { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

// Board auto-topic-injection (board-auto-topic-injection.md): once-per-session
// consumption at run start, exercised through the public streamResponseThunk
// entry point. The consumed-flag gate is the regression guard for the
// assistant-placeholder trap: submitEditorAndInitAtIndex pre-creates an empty
// assistant message before streamNormalInput runs, so history-shape detection
// can never work here.

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);
const mockResolveEditorContent = vi.mocked(resolveEditorContent);

const mockEditorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello, please help me with this code" }],
    },
  ],
};

const mockModifiers: InputModifiers = {
  useCodebase: true,
  noContext: false,
};

// Local copy of the model fixture (kept out of streamResponse.test.ts on
// purpose: importing a test file re-registers its tests/hooks here and
// pollutes the vi.mock registry).
const mockClaudeModel: ModelDescription = {
  title: "Claude 3.5 Sonnet",
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  completionOptions: { reasoningBudgetTokens: 2048 },
};

function getRootStateWithClaude(): RootState {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        experimental: {
          ...state.config.config.experimental,
          promptLogging: true,
        },
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: mockClaudeModel,
        },
      },
    },
  };
}

const BOARD_MESSAGE: BoardMessage = {
  topic: "auto-topic-injection",
  id: 5291369957,
  from: "home-citt",
  to: "*",
  re: 5291256996,
  createdAt: "2026-08-14T09:00:00Z",
  body: "Anhang emptyTopics umgesetzt.",
};

const BOARD_RESULT: BoardPendingResult = {
  messages: [BOARD_MESSAGE],
  latestByTopic: { "auto-topic-injection": 5291369957 },
};

const COMPILE_RESPONSE = {
  compiledChatMessages: [],
  didPrune: false,
  contextPercentage: 0.5,
};

function getInitialState(): RootState {
  const state = getRootStateWithClaude();
  state.session.history = [
    {
      message: { id: "1", role: "user", content: "Hello" },
      contextItems: [],
    },
  ];
  state.session.id = "session-board";
  return state;
}

function setupStreaming(messenger: MockIdeMessenger): void {
  async function* mockStream(): AsyncGenerator<
    AssistantChatMessage[],
    undefined
  > {
    yield [{ role: "assistant", content: "Hi there!" }];
    return undefined;
  }
  const mockStreamChat = vi.fn();
  mockStreamChat.mockReturnValue(mockStream());
  messenger.llmStreamChat =
    mockStreamChat as unknown as typeof messenger.llmStreamChat;
}

async function dispatchTurn(store: ReturnType<typeof createMockStore>) {
  await store.dispatch(
    streamResponseThunk({
      editorState: mockEditorState,
      modifiers: mockModifiers,
    }) as any,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

describe("board auto-topic-injection at run start", () => {
  it("consumes pending board messages on the first turn and injects them as a rule", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    messenger.responses["board/consumePending"] = BOARD_RESULT;
    let compilePayload: any;
    messenger.responseHandlers["llm/compileChat"] = async (data) => {
      compilePayload = data;
      return COMPILE_RESPONSE;
    };
    setupStreaming(messenger);
    const requestSpy = vi.spyOn(messenger, "request");

    await dispatchTurn(store);

    // exactly one gateway roundtrip
    expect(requestSpy).toHaveBeenCalledWith("board/consumePending", undefined);

    const actions = store.getActions();
    const consumedActions = actions.filter(
      (a) => a.type === setBoardInjectionConsumed.type,
    );
    expect(consumedActions).toHaveLength(1);
    expect(consumedActions[0].payload).toBe(true);

    const blockActions = actions.filter(
      (a) => a.type === setBoardInjectionBlock.type,
    );
    expect(blockActions).toHaveLength(1);
    expect(blockActions[0].payload).toContain("# MsgBoard");
    expect(blockActions[0].payload).toContain(BOARD_MESSAGE.body);

    expect((store.getState() as RootState).session.boardInjectionConsumed).toBe(
      true,
    );
    expect(
      (store.getState() as RootState).session.boardInjectionBlock,
    ).toContain(BOARD_MESSAGE.body);

    // the block rides along in the system message of this turn
    expect(compilePayload.messages[0].role).toBe("system");
    expect(compilePayload.messages[0].content).toContain(BOARD_MESSAGE.body);
  });

  it("does not consume again on later turns but keeps re-appending the block", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    messenger.responses["board/consumePending"] = BOARD_RESULT;
    let lastCompilePayload: any;
    messenger.responseHandlers["llm/compileChat"] = async (data) => {
      lastCompilePayload = data;
      return COMPILE_RESPONSE;
    };

    setupStreaming(messenger);
    await dispatchTurn(store);
    expect((store.getState() as RootState).session.boardInjectionConsumed).toBe(
      true,
    );

    // second turn in the same session
    store.clearActions();
    setupStreaming(messenger); // fresh stream generator
    const requestSpy = vi.spyOn(messenger, "request");
    await dispatchTurn(store);

    const boardCalls = requestSpy.mock.calls.filter(
      ([messageType]) => messageType === "board/consumePending",
    );
    expect(boardCalls).toHaveLength(0);

    // block persists and is re-appended to the system message every turn
    expect(
      (store.getState() as RootState).session.boardInjectionBlock,
    ).toContain(BOARD_MESSAGE.body);
    expect(lastCompilePayload.messages[0].content).toContain(
      BOARD_MESSAGE.body,
    );
  });

  it("skips injection on error status but still marks the attempt consumed", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    const originalRequest = messenger.request.bind(messenger);
    vi.spyOn(messenger, "request").mockImplementation(
      async (messageType, data) => {
        if (messageType === "board/consumePending") {
          return { status: "error", error: "gateway down", done: true } as any;
        }
        return originalRequest(messageType, data);
      },
    );
    messenger.responseHandlers["llm/compileChat"] = async () =>
      COMPILE_RESPONSE;
    setupStreaming(messenger);

    await dispatchTurn(store);

    const actions = store.getActions();
    expect(actions.some((a) => a.type === setBoardInjectionBlock.type)).toBe(
      false,
    );
    expect((store.getState() as RootState).session.boardInjectionConsumed).toBe(
      true,
    );
    expect(
      (store.getState() as RootState).session.boardInjectionBlock,
    ).toBeUndefined();
    // best-effort: the run itself still completes
    expect(actions.some((a) => a.type === streamUpdate.type)).toBe(true);
  });

  it("survives a thrown transport error during consumption", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    // no responses["board/consumePending"] configured: MockIdeMessenger throws
    messenger.responseHandlers["llm/compileChat"] = async () =>
      COMPILE_RESPONSE;
    setupStreaming(messenger);

    await dispatchTurn(store);

    const actions = store.getActions();
    expect((store.getState() as RootState).session.boardInjectionConsumed).toBe(
      true,
    );
    expect(
      (store.getState() as RootState).session.boardInjectionBlock,
    ).toBeUndefined();
    expect(actions.some((a) => a.type === streamUpdate.type)).toBe(true);
  });

  it("marks consumed without injecting a block when there are no new messages", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    messenger.responses["board/consumePending"] = {
      messages: [],
      latestByTopic: {},
    };
    let compilePayload: any;
    messenger.responseHandlers["llm/compileChat"] = async (data) => {
      compilePayload = data;
      return COMPILE_RESPONSE;
    };
    setupStreaming(messenger);

    await dispatchTurn(store);

    const actions = store.getActions();
    expect(
      actions.filter((a) => a.type === setBoardInjectionBlock.type),
    ).toHaveLength(0);
    expect((store.getState() as RootState).session.boardInjectionConsumed).toBe(
      true,
    );
    // no board rule in the system message of this turn
    expect(compilePayload.messages[0].content).not.toContain("# MsgBoard");
  });
});
