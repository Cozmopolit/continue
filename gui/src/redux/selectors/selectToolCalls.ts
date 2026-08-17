import { createSelector } from "@reduxjs/toolkit";
import { ToolStatus } from "core";
import { RootState } from "../store";
import {
  findAllCurToolCalls,
  findAllCurToolCallsByStatus,
  findToolCallById,
  hasCurrentToolCalls,
} from "../util";

// Primary selectors for tool calls
export const selectCurrentToolCalls = createSelector(
  (store: RootState) => store.session.history,
  (history) => findAllCurToolCalls(history),
);

export const selectHasCurrentToolCalls = createSelector(
  (store: RootState) => store.session.history,
  (history) => hasCurrentToolCalls(history),
);

export const selectToolCallsByStatus = createSelector(
  [
    (store: RootState) => store.session.history,
    (_store: RootState, status: ToolStatus) => status,
  ],
  (history, status) => findAllCurToolCallsByStatus(history, status),
);

export const selectFirstPendingToolCall = createSelector(
  (store: RootState) => store.session.history,
  (history) => {
    const pendingToolCalls = findAllCurToolCallsByStatus(history, "generated");
    return pendingToolCalls[0] || undefined;
  },
);

// ID-based selectors for specific tool calls
export const selectToolCallById = createSelector(
  [
    (store: RootState) => store.session.history,
    (_store: RootState, toolCallId: string) => toolCallId,
  ],
  (history, toolCallId) => findToolCallById(history, toolCallId),
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (store: RootState) => store.session.codeBlockApplyStates,
    (_store: RootState, toolCallId: string) => toolCallId,
  ],
  (applyStates, toolCallId) => {
    return applyStates.states.findLast(
      (state) => state.toolCallId === toolCallId,
    );
  },
);

// Status-specific convenience selectors
export const selectPendingToolCalls = createSelector(
  (store: RootState) => store.session.history,
  (history) => findAllCurToolCallsByStatus(history, "generated"),
);

export const selectDoneApplyStates = createSelector(
  (store: RootState) => store.session.codeBlockApplyStates.states,
  (states) => states.filter((applyState) => applyState.status === "done"),
);

// Board wake mode (board-wake-mode.md): idle = no stream running and no tool
// call in flight — "generating"/"calling" (active) or "generated" (awaiting
// approval; isStreaming is already false in that state).
export const selectIsConversationIdle = createSelector(
  (store: RootState) => store.session.history,
  (store: RootState) => store.session.isStreaming,
  (history, isStreaming) =>
    !isStreaming &&
    !findAllCurToolCallsByStatus(history, "generating").length &&
    !findAllCurToolCallsByStatus(history, "generated").length &&
    !findAllCurToolCallsByStatus(history, "calling").length,
);

// Board wake mode (board-wake-mode.md): a synthetic [board-wake] must never
// open a fresh conversation — the first message of a fresh conversation
// belongs to the user. "Started" means: at least one user message OR at
// least one item carrying a conversation summary — a fork-with-summary
// session holds only the synthetic summary item and is a continuation, not
// a fresh conversation (amendment 2026-08-17). The watcher keeps polling
// and consuming while blocked (accumulated messages render in the first
// real run's injection block), but never dispatches a wake into a
// conversation that has not started yet.
export const selectConversationIsStarted = createSelector(
  (store: RootState) => store.session.history,
  (history) =>
    history.some((item) => item.message.role === "user") ||
    history.some((item) => Boolean(item.conversationSummary)),
);

// Board wake mode (board-wake-mode.md, amendment 2026-08-16 II): while a
// compaction is in flight (inline compact or fork-with-summary), the watcher
// must neither consume nor wake — the finishing loadSession runs through the
// newSession reducer, which resets the per-session board buffer; messages
// consumed mid-compaction would advance the board cursor and then vanish
// from the context window. Both compaction hooks set/clear compactionLoading
// around the whole operation (including the awaited state swap), so any
// truthy entry means "compaction in progress". A pending self-compaction
// (compact_conversation tool call, agent-self-compaction.md) gates the same
// way: from the tool call until the post-run compaction finishes.
export const selectIsCompactionRunning = createSelector(
  (store: RootState) => store.session.compactionLoading,
  (store: RootState) => store.session.pendingSelfCompaction,
  (compactionLoading, pendingSelfCompaction) =>
    pendingSelfCompaction || Object.values(compactionLoading).some(Boolean),
);
