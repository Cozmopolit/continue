import { act, render } from "@testing-library/react";
import { BoardMessage, BoardPendingResult } from "core";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { IdeMessengerContext } from "../context/IdeMessenger";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setActive } from "../redux/slices/sessionSlice";
import { setBoardWatchMode } from "../redux/slices/uiSlice";
import { RootState } from "../redux/store";
import { createMockStore, getEmptyRootState } from "../util/test/mockStore";
import { useBoardWatch } from "./useBoardWatch";

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

type SetupOptions = { boardWatchMode?: boolean; isStreaming?: boolean };

function setup(options: SetupOptions = {}) {
  const messenger = new MockIdeMessenger();
  const state = getEmptyRootState();
  state.ui.boardWatchMode = options.boardWatchMode ?? true;
  state.session.isStreaming = options.isStreaming ?? false;
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

async function tick(ms = 30_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const wakeCalls = () => wakeMock.mock.calls;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockMainEditor(EMPTY_EDITOR_JSON);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBoardWatch", () => {
  it("primes on activation without waking, even with messages pending", async () => {
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = PENDING_RESULT;

    await renderProbe(store, messenger);

    expect(boardCalls()).toHaveLength(1);
    expect(wakeCalls()).toHaveLength(0);
    // primed messages are accumulated, not dropped — they render in the
    // injection block of the next run
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

  it("does not wake when the composer has content (user is typing)", async () => {
    mockMainEditor(TYPED_EDITOR_JSON);
    const { messenger, store } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();

    expect(wakeCalls()).toHaveLength(0);
    // still consumed — the messages render in the next run's injection block
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });

  it("does not wake without an editor instance", async () => {
    mockMainEditor(null);
    const { messenger, store } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);

    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await tick();

    expect(wakeCalls()).toHaveLength(0);
    expect((store.getState() as RootState).session.board.messages).toEqual([
      BOARD_MESSAGE,
    ]);
  });

  it("does not wake when a run starts while the fetch is in flight", async () => {
    const { messenger, store } = setup();
    let calls = 0;
    messenger.responseHandlers["board/consumePending"] = async () => {
      calls += 1;
      if (calls === 2) {
        // a user-started run begins while the tick's fetch is in flight
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

  it("re-primes without waking when the mode is toggled off and on", async () => {
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    await renderProbe(store, messenger);
    expect(boardCalls()).toHaveLength(1);

    await act(async () => {
      store.dispatch(setBoardWatchMode(false));
    });
    await tick(60_000);
    expect(boardCalls()).toHaveLength(1);

    // re-activation primes the pending message instead of waking on it
    messenger.responses["board/consumePending"] = PENDING_RESULT;
    await act(async () => {
      store.dispatch(setBoardWatchMode(true));
    });

    expect(boardCalls()).toHaveLength(2);
    expect(wakeCalls()).toHaveLength(0);
  });

  it("stops polling after unmount", async () => {
    const { messenger, store, boardCalls } = setup();
    messenger.responses["board/consumePending"] = EMPTY_RESULT;
    const rendered = await renderProbe(store, messenger);
    expect(boardCalls()).toHaveLength(1);

    rendered.unmount();
    await tick(90_000);

    expect(boardCalls()).toHaveLength(1);
  });
});
