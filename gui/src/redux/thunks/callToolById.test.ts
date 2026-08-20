import { ToolCallState, ToolStatus } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { RootState } from "../store";
import { findToolCallById } from "../util";
import { cancelStream } from "./cancelStream";
import { callToolById } from "./callToolById";

const toolState = (status: ToolStatus): ToolCallState => ({
  toolCallId: "tc-1",
  toolCall: {
    id: "tc-1",
    type: "function",
    function: { name: "mock_tool", arguments: "{}" },
  },
  status,
  parsedArgs: {},
});

const buildHistory = (status: ToolStatus): ChatHistoryItemWithMessageId[] => [
  {
    message: { id: "user-1", role: "user", content: "Hello" },
    contextItems: [],
  },
  {
    message: { id: "assistant-1", role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [toolState(status)],
  },
];

const buildInitialState = (status: ToolStatus): Partial<RootState> => {
  const root = getEmptyRootState();
  return {
    session: {
      ...root.session,
      isStreaming: true,
      history: buildHistory(status),
    },
    config: {
      ...root.config,
      config: {
        ...root.config.config,
        selectedModelByRole: {
          ...root.config.config.selectedModelByRole,
          chat: {
            title: "Mock Model",
            provider: "openai",
            model: "mock-model",
          } as any,
        },
      },
    },
  };
};

describe("callToolById user-abort guard", () => {
  it("completes normally when the run is not cancelled (guard passes through)", async () => {
    const store = createMockStore(buildInitialState("generated") as any);

    await store.dispatch(callToolById({ toolCallId: "tc-1" }) as any);

    const state = store.getState() as RootState;
    expect(findToolCallById(state.session.history, "tc-1")?.status).toBe(
      "done",
    );
    const actionTypes = store.getActions().map((a) => a.type);
    expect(actionTypes).toContain("session/updateToolCallOutput");
    expect(actionTypes).toContain("session/acceptToolCall");
    expect(actionTypes).toContain("chat/streamAfterToolCall/pending");
    // The tool message synthesized by streamResponseAfterToolCall landed
    expect(
      state.session.history.some((item) => item.message.role === "tool"),
    ).toBe(true);
  });

  it("does not overwrite the cancellation marker when the tool completes after the run was cancelled", async () => {
    const store = createMockStore(buildInitialState("generated") as any);

    // Park the tools/call request on a promise the test controls
    let resolveToolCall!: (value: any) => void;
    const toolCallPromise = new Promise((resolve) => {
      resolveToolCall = resolve;
    });
    store.mockIdeMessenger.responseHandlers["tools/call"] = (async () =>
      toolCallPromise) as any;

    const thunkPromise = store.dispatch(
      callToolById({ toolCallId: "tc-1" }) as any,
    );

    // The thunk moved the call to "calling" and is parked on tools/call
    await vi.waitFor(() => {
      const state = store.getState() as RootState;
      expect(findToolCallById(state.session.history, "tc-1")?.status).toBe(
        "calling",
      );
    });

    // User aborts the run (stop button / Cmd+Backspace path)
    await store.dispatch(cancelStream() as any);
    expect(
      findToolCallById((store.getState() as RootState).session.history, "tc-1")
        ?.status,
    ).toBe("canceled");

    // The tool finishes late — the guard must swallow the result
    resolveToolCall({
      contextItems: [
        { name: "Late result", description: "late", content: "late output" },
      ],
    });
    await thunkPromise;

    const state = store.getState() as RootState;
    expect(findToolCallById(state.session.history, "tc-1")?.status).toBe(
      "canceled",
    );
    const actionTypes = store.getActions().map((a) => a.type);
    expect(actionTypes).not.toContain("session/updateToolCallOutput");
    expect(actionTypes).not.toContain("session/acceptToolCall");
    expect(actionTypes).not.toContain("session/errorToolCall");
    expect(actionTypes).not.toContain("chat/streamAfterToolCall/pending");
  });
});
