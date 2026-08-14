import { JSONContent } from "@tiptap/core";
import {
  AssistantChatMessage,
  BoardMessage,
  BoardPendingResult,
  InputModifiers,
  ModelDescription,
} from "core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  appendBoardMessages,
  setBoardFetchAttempted,
  streamUpdate,
} from "../slices/sessionSlice";
import { RootState } from "../store";
import { BOARD_FETCH_TTL_MS } from "../../util/boardInjection";
import { streamResponseThunk } from "./streamResponse";

// Board auto-topic-injection (board-auto-topic-injection.md, revision 2):
// TTL-gated consumption on every LLM call, exercised through the public
// streamResponseThunk entry point. The TTL gate replaces revision 1's
// once-per-session flag: within the window no second board/consumePending
// request may go out; after it, the next call re-fetches and accumulates.

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

const BOARD_MESSAGE_2: BoardMessage = {
  topic: "auto-topic-injection",
  id: 5292160690,
  from: "home-citt",
  to: "*",
  createdAt: "2026-08-14T10:14:54Z",
  body: "Build bestaetigt, bereit fuer den Live-Test.",
};

const BOARD_RESULT: BoardPendingResult = {
  messages: [BOARD_MESSAGE],
  latestByTopic: { "auto-topic-injection": 5291369957 },
};

const BOARD_RESULT_2: BoardPendingResult = {
  messages: [BOARD_MESSAGE_2],
  latestByTopic: { "auto-topic-injection": 5292160690 },
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

const NOW = 1_755_160_000_000;
let nowMs = NOW;

beforeEach(() => {
  vi.clearAllMocks();
  nowMs = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("board auto-topic-injection at LLM-call level", () => {
  it("consumes pending board messages on the first call and injects them as a rule", async () => {
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

    // exactly one gateway roundtrip, attempt stamped with the gated now
    expect(requestSpy).toHaveBeenCalledWith("board/consumePending", undefined);
    const actions = store.getActions();
    const attemptActions = actions.filter(
      (a) => a.type === setBoardFetchAttempted.type,
    );
    expect(attemptActions).toHaveLength(1);
    expect(attemptActions[0].payload).toBe(NOW);
    expect(
      actions.filter((a) => a.type === appendBoardMessages.type),
    ).toHaveLength(1);

    const board = (store.getState() as RootState).session.board;
    expect(board.lastFetchAt).toBe(NOW);
    expect(board.messages).toEqual([BOARD_MESSAGE]);

    // the block rides along in the system message of this call
    expect(compilePayload.messages[0].role).toBe("system");
    expect(compilePayload.messages[0].content).toContain(BOARD_MESSAGE.body);
  });

  it("does not re-fetch within the TTL window but keeps appending the block", async () => {
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
    expect((store.getState() as RootState).session.board.lastFetchAt).toBe(NOW);

    // second call just inside the TTL window
    nowMs = NOW + BOARD_FETCH_TTL_MS - 1;
    store.clearActions();
    setupStreaming(messenger); // fresh stream generator
    const requestSpy = vi.spyOn(messenger, "request");
    await dispatchTurn(store);

    const boardCalls = requestSpy.mock.calls.filter(
      ([messageType]) => messageType === "board/consumePending",
    );
    expect(boardCalls).toHaveLength(0);

    // accumulated block is still re-appended to the system message
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
    expect(lastCompilePayload.messages[0].content).toContain(
      BOARD_MESSAGE.body,
    );
  });

  it("re-fetches after the TTL and accumulates new messages", async () => {
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

    // second call just outside the TTL window, with a new board message
    nowMs = NOW + BOARD_FETCH_TTL_MS;
    messenger.responses["board/consumePending"] = BOARD_RESULT_2;
    store.clearActions();
    setupStreaming(messenger);
    const requestSpy = vi.spyOn(messenger, "request");
    await dispatchTurn(store);

    const boardCalls = requestSpy.mock.calls.filter(
      ([messageType]) => messageType === "board/consumePending",
    );
    expect(boardCalls).toHaveLength(1);

    // both messages accumulated, oldest first; attempt re-stamped
    const board = (store.getState() as RootState).session.board;
    expect(board.lastFetchAt).toBe(NOW + BOARD_FETCH_TTL_MS);
    expect(board.messages).toEqual([BOARD_MESSAGE, BOARD_MESSAGE_2]);

    // both bodies visible in the system message of the second call
    expect(lastCompilePayload.messages[0].content).toContain(
      BOARD_MESSAGE.body,
    );
    expect(lastCompilePayload.messages[0].content).toContain(
      BOARD_MESSAGE_2.body,
    );
  });

  it("skips injection on error status but still stamps the attempt", async () => {
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

    const board = (store.getState() as RootState).session.board;
    expect(board.lastFetchAt).toBe(NOW);
    expect(board.messages).toEqual([]);
    // best-effort: the run itself still completes
    expect(store.getActions().some((a) => a.type === streamUpdate.type)).toBe(
      true,
    );
  });

  it("survives a thrown transport error during consumption", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    // no responses["board/consumePending"] configured: MockIdeMessenger throws
    messenger.responseHandlers["llm/compileChat"] = async () =>
      COMPILE_RESPONSE;
    setupStreaming(messenger);

    await dispatchTurn(store);

    const board = (store.getState() as RootState).session.board;
    expect(board.lastFetchAt).toBe(NOW);
    expect(board.messages).toEqual([]);
    expect(store.getActions().some((a) => a.type === streamUpdate.type)).toBe(
      true,
    );
  });

  it("stamps the attempt without injecting a block when there are no new messages", async () => {
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

    expect(
      store.getActions().filter((a) => a.type === appendBoardMessages.type),
    ).toHaveLength(1);
    expect((store.getState() as RootState).session.board.lastFetchAt).toBe(NOW);
    // no board rule in the system message of this call
    expect(compilePayload.messages[0].content).not.toContain("# MsgBoard");
  });

  it("overlapping calls: only one board/consumePending request", async () => {
    const store = createMockStore(getInitialState());
    const messenger = store.mockIdeMessenger;
    messenger.responses["board/consumePending"] = BOARD_RESULT;
    messenger.responseHandlers["llm/compileChat"] = async () =>
      COMPILE_RESPONSE;
    setupStreaming(messenger);
    const requestSpy = vi.spyOn(messenger, "request");

    // two concurrent turns: the second gate must see the first attempt stamp
    await Promise.all([dispatchTurn(store), dispatchTurn(store)]);

    const boardCalls = requestSpy.mock.calls.filter(
      ([messageType]) => messageType === "board/consumePending",
    );
    expect(boardCalls).toHaveLength(1);
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });
});
