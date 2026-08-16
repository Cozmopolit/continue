import { ToolCallState, ToolStatus } from "core";
import { describe, expect, it } from "vitest";
import { getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import {
  selectConversationHasUserMessage,
  selectIsCompactionRunning,
  selectIsConversationIdle,
} from "./selectToolCalls";

// Board wake mode (board-wake-mode.md): the watcher may only wake while the
// conversation is idle. Idle = no stream running AND no tool call in flight —
// "generating"/"calling" (active) or "generated" (awaiting approval, where
// isStreaming is already false). Tool calls count only while they are
// "current" (findAllCurToolCalls: after the last user message).

type History = RootState["session"]["history"];

function makeToolCallState(status: ToolStatus): ToolCallState {
  return {
    status,
    toolCall: {
      id: "call-1",
      type: "function",
      function: { name: "readFile", arguments: '{"path":"a.ts"}' },
    },
    toolCallId: "call-1",
    parsedArgs: {},
  };
}

function userItem(id = "u1"): History[number] {
  return {
    message: { id, role: "user", content: "hello" },
    contextItems: [],
  };
}

function assistantItem(toolCallStates?: ToolCallState[]): History[number] {
  return {
    message: { id: "a1", role: "assistant", content: "" },
    contextItems: [],
    ...(toolCallStates ? { toolCallStates } : {}),
  };
}

function stateWith(history: History, isStreaming = false): RootState {
  const state = getEmptyRootState();
  state.session.history = history;
  state.session.isStreaming = isStreaming;
  return state;
}

describe("selectIsConversationIdle", () => {
  it("is idle with an empty history and no stream", () => {
    expect(selectIsConversationIdle(stateWith([]))).toBe(true);
  });

  it("is idle when the last message is a user message", () => {
    expect(selectIsConversationIdle(stateWith([userItem()]))).toBe(true);
  });

  it("is idle after an assistant message without tool calls", () => {
    expect(
      selectIsConversationIdle(stateWith([userItem(), assistantItem()])),
    ).toBe(true);
  });

  it("is not idle while streaming, even without tool calls", () => {
    expect(selectIsConversationIdle(stateWith([userItem()], true))).toBe(false);
  });

  it.each(["generating", "generated", "calling"] as ToolStatus[])(
    "is not idle with a current tool call in status %s",
    (status) => {
      const history = [userItem(), assistantItem([makeToolCallState(status)])];
      expect(selectIsConversationIdle(stateWith(history))).toBe(false);
    },
  );

  it.each(["done", "errored", "canceled"] as ToolStatus[])(
    "is idle with a current tool call in terminal status %s",
    (status) => {
      const history = [userItem(), assistantItem([makeToolCallState(status)])];
      expect(selectIsConversationIdle(stateWith(history))).toBe(true);
    },
  );

  it("ignores tool calls before the last user message (no longer current)", () => {
    // "generated" would block if current — but a newer user message ends the
    // turn, so the pending approval of the previous turn must not block.
    const history = [
      assistantItem([makeToolCallState("generated")]),
      userItem("u2"),
    ];
    expect(selectIsConversationIdle(stateWith(history))).toBe(true);
  });

  it("is not idle while streaming even when all tool calls are done", () => {
    const history = [userItem(), assistantItem([makeToolCallState("done")])];
    expect(selectIsConversationIdle(stateWith(history, true))).toBe(false);
  });
});

// Board wake mode (board-wake-mode.md): a synthetic [board-wake] must never
// be the first user message of a conversation — a fresh conversation belongs
// to the user's first word. The watcher uses this to block wake dispatches
// until the history holds at least one user message.
describe("selectConversationHasUserMessage", () => {
  it("is false with an empty history (fresh conversation)", () => {
    expect(selectConversationHasUserMessage(stateWith([]))).toBe(false);
  });

  it("is true once a user message exists", () => {
    expect(selectConversationHasUserMessage(stateWith([userItem()]))).toBe(
      true,
    );
  });

  it("is true with user and assistant messages", () => {
    expect(
      selectConversationHasUserMessage(
        stateWith([userItem(), assistantItem()]),
      ),
    ).toBe(true);
  });

  it("is false with assistant messages only (no user message yet)", () => {
    expect(selectConversationHasUserMessage(stateWith([assistantItem()]))).toBe(
      false,
    );
  });
});

// Board wake mode (board-wake-mode.md, amendment 2026-08-16 II): while a
// compaction is in flight the watcher must skip the whole tick — the
// finishing loadSession resets the per-session board buffer, so consuming
// mid-compaction would lose messages after the cursor already advanced.
describe("selectIsCompactionRunning", () => {
  function stateWithCompactionLoading(loading: Record<number, boolean>) {
    const state = stateWith([]);
    state.session.compactionLoading = loading;
    return state;
  }

  it("is false when no compaction is running", () => {
    expect(selectIsCompactionRunning(stateWithCompactionLoading({}))).toBe(
      false,
    );
  });

  it("is true while a compaction is loading", () => {
    expect(
      selectIsCompactionRunning(stateWithCompactionLoading({ 2: true })),
    ).toBe(true);
  });

  it("is true when any of multiple compactions is loading", () => {
    expect(
      selectIsCompactionRunning(
        stateWithCompactionLoading({ 0: true, 4: true }),
      ),
    ).toBe(true);
  });

  it("is false after the loading flag was cleared", () => {
    // Mirrors the reducer: clearing deletes the entry instead of storing
    // false — both shapes must read as "not running".
    const cleared: Record<number, boolean> = { 2: true };
    delete cleared[2];
    expect(selectIsCompactionRunning(stateWithCompactionLoading(cleared))).toBe(
      false,
    );
  });
});
