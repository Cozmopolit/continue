import { ChatMessage, ModelDescription, PromptLog } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  ChatHistoryItemWithMessageId,
  submitEditorAndInitAtIndex,
} from "../slices/sessionSlice";
import { RootState } from "../store";
import { streamNormalInput } from "./streamNormalInput";

// Mock system message construction to keep tests readable (same as the
// sibling streamResponse suites).
vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);

const mockClaudeModel: ModelDescription = {
  title: "Claude 3.5 Sonnet",
  model: "claude-3-5-sonnet-20241022",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  completionOptions: { reasoningBudgetTokens: 2048 },
};

// Local factory (mirrors getRootStateWithClaude in streamResponse.test) so we
// don't import that module and drag its test suite into this file.
function getRootState(): RootState {
  const state = getEmptyRootState();
  // Keep the board TTL gate closed so no board fetch actions are produced
  // (board-auto-topic-injection.md revision 2).
  state.session.board.lastFetchAt = Date.now();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: mockClaudeModel,
        },
      },
    },
  };
}

const userItem = (): ChatHistoryItemWithMessageId => ({
  message: { id: "user-1", role: "user", content: "Hello" },
  contextItems: [],
});

const emptyAssistantItem = (): ChatHistoryItemWithMessageId => ({
  message: { id: "assistant-1", role: "assistant", content: "" },
  contextItems: [],
});

const buildInitialState = (
  history: ChatHistoryItemWithMessageId[],
): RootState => {
  const state = getRootState();
  state.session.history = history;
  state.session.id = "session-1";
  return state;
};

const makeCompileChatResponse = () => ({
  compiledChatMessages: [{ role: "user", content: "Hello" }],
  didPrune: false,
  contextPercentage: 0.8,
});

const PROMPT_LOG: PromptLog = {
  prompt: "Hello",
  completion: "reasoning only",
  modelProvider: "anthropic",
  modelTitle: "Claude 3.5 Sonnet",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

describe("streamNormalInput reasoning rescue at regular stream end", () => {
  it("rescues reasoning into the assistant turn when the stream ends without visible content", async () => {
    const store = createMockStore(
      buildInitialState([userItem(), emptyAssistantItem()]),
    );
    const messenger = store.mockIdeMessenger;
    messenger.responses["llm/compileChat"] = makeCompileChatResponse() as any;

    // Provider hits the token limit mid-reasoning: only thinking arrives,
    // the turn ends regularly (no error, no abort).
    async function* reasoningOnlyGen(): AsyncGenerator<
      ChatMessage[],
      PromptLog
    > {
      yield [{ role: "thinking", content: "partial reasoning before limit" }];
      return PROMPT_LOG;
    }
    messenger.llmStreamChat = reasoningOnlyGen as any;

    await store.dispatch(streamNormalInput({}) as any);

    const finalHistory = (store.getState() as RootState).session.history;
    expect(finalHistory).toHaveLength(2);
    expect(finalHistory[1].message.role).toBe("assistant");
    expect(finalHistory[1].message.content).toContain(
      "partial reasoning before limit",
    );
    expect(finalHistory[1].message.content).toContain(
      "[Response interrupted mid-stream",
    );
    expect(finalHistory.some((item) => item.message.role === "thinking")).toBe(
      false,
    );
  });

  it("does not add a rescue marker when the turn produced visible content", async () => {
    const store = createMockStore(
      buildInitialState([userItem(), emptyAssistantItem()]),
    );
    const messenger = store.mockIdeMessenger;
    messenger.responses["llm/compileChat"] = makeCompileChatResponse() as any;

    async function* contentGen(): AsyncGenerator<ChatMessage[], PromptLog> {
      yield [{ role: "thinking", content: "some reasoning" }];
      yield [{ role: "assistant", content: "visible answer" }];
      return PROMPT_LOG;
    }
    messenger.llmStreamChat = contentGen as any;

    await store.dispatch(streamNormalInput({}) as any);

    const finalHistory = (store.getState() as RootState).session.history;
    // The visible content is present somewhere in the turn…
    expect(
      finalHistory.some((item) =>
        String(item.message.content).includes("visible answer"),
      ),
    ).toBe(true);
    // …and no rescue marker was added anywhere (turn already produced content).
    expect(
      finalHistory.some((item) =>
        String(item.message.content).includes(
          "[Response interrupted mid-stream",
        ),
      ),
    ).toBe(false);
  });

  it("does not rescue when a stream abort replaced the captured aborter (stale thunk)", async () => {
    const store = createMockStore(
      buildInitialState([userItem(), emptyAssistantItem()]),
    );
    const messenger = store.mockIdeMessenger;
    messenger.responses["llm/compileChat"] = makeCompileChatResponse() as any;

    // First gen.next() yields a thinking chunk, the second one hangs until we
    // release it — simulating a slow stream that resolves only after the turn
    // was already aborted.
    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    async function* hangingGen(): AsyncGenerator<ChatMessage[], PromptLog> {
      yield [{ role: "thinking", content: "partial reasoning" }];
      await hangPromise;
      return PROMPT_LOG;
    }
    messenger.llmStreamChat = hangingGen as any;

    const thunkPromise = store.dispatch(streamNormalInput({}) as any);

    // Wait until the first chunk was streamed and the thunk is parked on the
    // pending gen.next().
    await vi.waitFor(() => {
      expect(
        (store.getState() as RootState).session.history.some(
          (item) => item.message.role === "thinking",
        ),
      ).toBe(true);
    });

    // User aborts: abortStream replaces the captured controller.
    store.dispatch({ type: "session/abortStream" });

    // The hung stream resolves late.
    resolveHang();
    await thunkPromise;

    // The stale thunk must NOT rescue behind the replaced controller: the
    // assistant turn keeps no marker content.
    const finalHistory = (store.getState() as RootState).session.history;
    const assistant = finalHistory.find(
      (item) => item.message.role === "assistant",
    );
    expect(assistant!.message.content).not.toContain(
      "[Response interrupted mid-stream",
    );
  });

  it("does not rescue into a newer turn started after the abort", async () => {
    const store = createMockStore(
      buildInitialState([userItem(), emptyAssistantItem()]),
    );
    const messenger = store.mockIdeMessenger;
    messenger.responses["llm/compileChat"] = makeCompileChatResponse() as any;

    let resolveHang!: () => void;
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });
    async function* hangingGen(): AsyncGenerator<ChatMessage[], PromptLog> {
      yield [{ role: "thinking", content: "stale reasoning" }];
      await hangPromise;
      return PROMPT_LOG;
    }
    messenger.llmStreamChat = hangingGen as any;

    const thunkPromise = store.dispatch(streamNormalInput({}) as any);

    await vi.waitFor(() => {
      expect(
        (store.getState() as RootState).session.history.some(
          (item) => item.message.role === "thinking",
        ),
      ).toBe(true);
    });

    // Abort (replaces the controller), then start a fresh turn — this appends
    // a new user + empty assistant pair, which must not receive the stale
    // turn's reasoning marker.
    store.dispatch({ type: "session/abortStream" });
    store.dispatch(
      submitEditorAndInitAtIndex({
        index: (store.getState() as RootState).session.history.length,
        editorState: { type: "doc", content: [] },
      }),
    );

    resolveHang();
    await thunkPromise;

    const finalHistory = (store.getState() as RootState).session.history;
    // The newest assistant item belongs to the fresh turn and must stay empty.
    const assistantItems = finalHistory.filter(
      (item) => item.message.role === "assistant",
    );
    const newestAssistant = assistantItems[assistantItems.length - 1];
    expect(newestAssistant.message.content).toBe("");
    expect(
      finalHistory.some((item) =>
        String(item.message.content).includes(
          "[Response interrupted mid-stream",
        ),
      ),
    ).toBe(false);
  });
});
