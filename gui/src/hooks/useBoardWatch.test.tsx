import { act, render } from "@testing-library/react";
import { BoardMessage, BoardPendingResult } from "core";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setActive, setCompactionLoading } from "../redux/slices/sessionSlice";
import { setBoardWatchMode } from "../redux/slices/uiSlice";
import { RootState } from "../redux/store";
import { createMockStore, getEmptyRootState } from "../util/test/mockStore";
import { nextWatchDelayMs, useBoardWatch } from "./useBoardWatch";

// Board wake mode (board-wake-mode.md): watcher behavior against a real
// store and the real fetchBoardPending seam (board requests go through
// MockIdeMessenger). Only the two side-effecting boundaries are mocked: the
// TipTap editor instance (useMainEditor) and the wake dispatch
// (streamResponseThunk — its stream pipeline is covered by
// streamResponse*.test.ts).

vi.mock("../redux/thunks/streamResponse", () => {
  const thunk: any = vi.fn((_args: any) => async () => undefined);
  // sessionSlice's extraReducers register thunk.pending/.fulfilled/.rejected
  // via addCase, which accepts plain action-type strings.
  thunk.pending = "chat/streamResponse/pending";
  thunk.fulfilled = "chat/streamResponse/fulfilled";
  thunk.rejected = "chat/streamResponse/rejected";
  return { streamResponseThunk: thunk };
});
import { streamResponseThunk } from "../redux/thunks/streamResponse";

vi.mock(
  "../components/mainInput/TipTapEditor/MainEditorProvider",
  async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, useMainEditor: vi.fn() };
  },
);
import { useMainEditor } from "../components/mainInput/TipTapEditor/MainEditorProvider";

const wakeMock = streamResponseThunk as unknown as Mock;
const useMainEditorMock = useMainEditor as unknown as Mock;

type History = RootState["session"]["history"];

// A conversation with at least one user message — wake dispatches are only
// allowed into started conversations (fresh-conversation guard).
function userHistoryItem(): History[number] {
  return {
    message: { id: "u1", role: "user", content: "hello" },
    contextItems: [],
  };
}

const BOARD_MESSAGE: BoardMessage = {
  topic: "board-wake-mode",
  id: 5305000042,
  from: "home-citt",
  to: "*",
  createdAt: "2026-08-15T21:30:00Z",
  body: "Ping fuer den idle Agenten.",
};

const EMPTY_RESULT: BoardPendingResult = { messages: [], latestByTopic: {} };
const PENDING_RESULT: BoardPendingResult = {
  messages: [BOARD_MESSAGE],
  latestByTopic: { "board-wake-mode": 5305000042 },
};

const EMPTY_EDITOR_JSON = { type: "doc", content: [{ type: "paragraph" }] };
const TYPED_EDITOR_JSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "user is typing" }],
    },
  ],
};

function mockMainEditor(json: object | null) {
  useMainEditorMock.mockReturnValue({
    mainEditor: json === null ? null : { getJSON: () => json },
  });
}

function Probe() {
  useBoardWatch();
  return null;
}

type SetupOptions = {
  boardWatchMode?: boolean;
  isStreaming?: boolean;
  history?: History;
  compactionLoading?: Record<number, boolean>;
};

function setup(options: SetupOptions = {}) {
  const messenger = new MockIdeMessenger();
  const state = getEmptyRootState();
  state.ui.boardWatchMode = options.boardWatchMode ?? true;
  state.session.isStreaming = options.isStreaming ?? false;
  // Default: a started conversation — wake dispatches are only allowed into
  // started conversations (fresh-conversation guard, board-wake-mode.md).
  state.session.history = options.history ?? [userHistoryItem()];
  if (options.compactionLoading) {
    state.session.compactionLoading = options.compactionLoading;
  }
  const store = createMockStore(state, messenger);
  const requestSpy = vi.spyOn(messenger, "request");
  const boardCalls = () =>
    requestSpy.mock.calls.filter(([type]) => type === "board/consumePending");
  return { messenger, store, boardCalls };
}

async function renderProbe(store: any, messenger: MockIdeMessenger) {
  let rendered: any;
  await act(async () => {
    rendered = render(
      <Provider store={store}>
        <IdeMessengerContext.Provider value={messenger}>
          <Probe />
        </IdeMessengerContext.Provider>
      </Provider>,
    );
  });
  return rendered;
}

async function tick(ms = 60_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const wakeCalls = () => wakeMock.mock.calls;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Deterministic cadence: pin the jitter to the interval midpoint
  // (0.75 + 0.25 = 1.0 × 60 s). Individual tests override to exercise the
  // jittered delay itself.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockMainEditor(EMPTY_EDITOR_JSON);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBoardWatch", () => {
  it("does not consume on activation — the first tick consumes and wakes", async () => {
    // Paket 3 (msgboard-v2-fork-packages.md): priming is gone — CITT-side
    // self-exclusion keeps own posts out of board/pending, so activation no
    // longer needs a silent consume. Messages pending at activation wake in
    // the first tick.
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = PENDING_RESULT;

    await renderProbe(store, messenger);

    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);

    await tick();

    expect(boardCalls()).toHaveLength(1);
    expect(wakeCalls()).toHaveLength(1);
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });

  it("wakes with the [board-wake] doc when new messages arrive at a tick", async () => {
    const { messenger, store } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();

    expect(wakeCalls()).toHaveLength(1);
    const arg = wakeCalls()[0][0] as any;
    expect(arg.modifiers).toEqual({ useCodebase: false, noContext: true });
    expect(arg.editorState.content[0].content[0].text).toContain(
      "[board-wake]",
    );
  });

  it("does not wake again while no new messages arrive", async () => {
    const { messenger, store } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();
    expect(wakeCalls()).toHaveLength(1);

    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await tick(90_000);
    expect(wakeCalls()).toHaveLength(1);
  });

  it("does not consume when the composer has content (user is typing)", async () => {
    // Deliver-before-consume (board-wake-mode.md, amendment 2026-08-21):
    // the messages stay server-side; the run the user sends delivers them
    // via its run-start fetch.
    mockMainEditor(TYPED_EDITOR_JSON);
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await renderProbe(store, messenger);

    await tick();

    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);
    expect((store.getState() as RootState).session.board.messages).toEqual([]);
  });

  it("does not consume without an editor instance", async () => {
    mockMainEditor(null);
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await renderProbe(store, messenger);

    await tick();

    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);
    expect((store.getState() as RootState).session.board.messages).toEqual([]);
  });

  it("does not consume into a fresh conversation (no user message, no summary)", async () => {
    // Deliver-before-consume (board-wake-mode.md, amendment 2026-08-21):
    // the messages stay server-side; the first real run's run-start fetch
    // delivers them.
    const { messenger, store, boardCalls } = setup({ history: [] });
    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await renderProbe(store, messenger);

    await tick();

    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);
    expect((store.getState() as RootState).session.board.messages).toEqual([]);
  });

  it("wakes into a forked conversation whose only item carries a summary", async () => {
    // conversation-fork-with-summary.md + board-wake-mode.md amendment
    // 2026-08-17: a fork session holds a single synthetic assistant item
    // with the summary — it is a continuation, so wakes are allowed even
    // though it has no user message yet.
    const { messenger, store } = setup({
      history: [
        {
          message: { id: "fork-1", role: "assistant", content: "" },
          contextItems: [],
          conversationSummary: "Summary of the source session.",
        },
      ],
    });
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();

    expect(wakeCalls()).toHaveLength(1);
  });

  it("pauses fully while a compaction runs, consumes and wakes on the first tick after", async () => {
    const { messenger, store, boardCalls } = setup({
      compactionLoading: { 2: true },
    });
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);
    // fully paused (agent-self-compaction.md): no consume may race the
    // loadSession that resets the board buffer
    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);

    // a message arrives on the board while the compaction still runs: it
    // stays on the board (no consume, no wake, cursor untouched)
    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();
    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);
    expect((store.getState() as RootState).session.board.messages).toEqual([]);

    // compaction done: re-activation itself consumes nothing (no priming) —
    // the pending message wakes in the first tick
    await act(async () => {
      store.dispatch(setCompactionLoading({ index: 2, loading: false }));
    });
    expect(boardCalls()).toHaveLength(0);
    expect(wakeCalls()).toHaveLength(0);

    await tick();
    expect(boardCalls()).toHaveLength(1);
    expect(wakeCalls()).toHaveLength(1);
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });

  it("does not wake when a compaction starts while the fetch is in flight", async () => {
    const { messenger, store } = setup();
    let calls = 0;
    messenger.responseHandlers["board/consumePending"] = async () => {
      calls += 1;
      if (calls === 1) {
        // the user starts a compaction while the (first) tick's fetch is in
        // flight
        store.dispatch(setCompactionLoading({ index: 0, loading: true }));
        return PENDING_RESULT;
      }
      return EMPTY_RESULT;
    };
    await renderProbe(store, messenger);

    await tick();

    expect(wakeCalls()).toHaveLength(0);
    // consumed anyway (consume happens before the re-check) — the residual
    // ms-window of deliver-before-consume (board-wake-mode.md, amendment
    // 2026-08-21); the messages render in the next run's injection block
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });

  it("does not wake when a run starts while the fetch is in flight", async () => {
    // Residual ms-window of deliver-before-consume (board-wake-mode.md,
    // amendment 2026-08-21): the pre-gate passed, then the run started
    // mid-fetch — no wake; the messages render in the run that started.
    const { messenger, store } = setup();
    let calls = 0;
    messenger.responseHandlers["board/consumePending"] = async () => {
      calls += 1;
      if (calls === 1) {
        // a user-started run begins while the (first) tick's fetch is in
        // flight
        store.dispatch(setActive());
        return PENDING_RESULT;
      }
      return EMPTY_RESULT;
    };
    await renderProbe(store, messenger);

    await tick();

    expect(wakeCalls()).toHaveLength(0);
  });

  it("does not poll while the mode is off", async () => {
    const { messenger, store, boardCalls } = setup({ boardWatchMode: false });
    await renderProbe(store, messenger);

    await tick(90_000);

    expect(boardCalls()).toHaveLength(0);
  });

  it("does not poll while a run is active", async () => {
    const { messenger, store, boardCalls } = setup({ isStreaming: true });
    await renderProbe(store, messenger);

    await tick(60_000);

    expect(boardCalls()).toHaveLength(0);
  });

  it("resumes ticking when the mode is toggled off and on", async () => {
    // no priming on re-activation either — the pending message wakes in the
    // first tick after re-enabling
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);
    expect(boardCalls()).toHaveLength(0);

    await act(async () => {
      store.dispatch(setBoardWatchMode(false));
    });
    await tick(60_000);
    expect(boardCalls()).toHaveLength(0);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await act(async () => {
      store.dispatch(setBoardWatchMode(true));
    });
    expect(boardCalls()).toHaveLength(0);

    await tick();
    expect(boardCalls()).toHaveLength(1);
    expect(wakeCalls()).toHaveLength(1);
  });

  it("stops polling after unmount", async () => {
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    const rendered = await renderProbe(store, messenger);
    expect(boardCalls()).toHaveLength(0);

    rendered.unmount();
    await tick(90_000);

    expect(boardCalls()).toHaveLength(0);
  });

  it("ticks on the jittered delay, not the bare interval", async () => {
    // random = 0 → delay = 0.75 × 60 s = 45 s (rate-limit interim:
    // decorrelates phase-locked windows)
    vi.mocked(Math.random).mockReturnValue(0);
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);
    expect(boardCalls()).toHaveLength(0);

    await tick(44_000);
    expect(boardCalls()).toHaveLength(0);
    await tick(1_000);
    expect(boardCalls()).toHaveLength(1); // first jittered tick at 45 s

    await tick(45_000);
    expect(boardCalls()).toHaveLength(2); // re-rolled with the pinned value
  });
});

describe("nextWatchDelayMs", () => {
  it("maps Math.random onto [0.75, 1.25) × interval", () => {
    vi.mocked(Math.random).mockReturnValue(0);
    expect(nextWatchDelayMs()).toBe(45_000);
    vi.mocked(Math.random).mockReturnValue(0.5);
    expect(nextWatchDelayMs()).toBe(60_000);
    vi.mocked(Math.random).mockReturnValue(0.999);
    expect(nextWatchDelayMs()).toBeCloseTo(74_970);
  });
});
