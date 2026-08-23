import { createAsyncThunk } from "@reduxjs/toolkit";

import { setCompactionLoading } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { loadSession } from "./session";

/**
 * Agent self-compaction (agent-self-compaction.md): hook-free Type-1
 * (in-place) compaction runner for the UI button (useCompactConversation).
 * The agent run-end trigger uses the fork runner instead (forkWithSummary.ts,
 * agent-self-compaction-fork-wiring.md). The compactionLoading flag doubles
 * as the board-wake gate and must only clear once the state swap (which
 * resets the board buffer) is done (board-wake-mode.md, amendment
 * 2026-08-16 II). Errors are logged and swallowed — the flag always clears,
 * the watcher re-activates.
 */
export const compactConversationThunk = createAsyncThunk<
  void,
  { sessionId: string; index: number },
  ThunkApiType
>(
  "chat/compactConversation",
  async ({ sessionId, index }, { dispatch, extra }) => {
    try {
      dispatch(setCompactionLoading({ index, loading: true }));

      await extra.ideMessenger.request("conversation/compact", {
        index,
        sessionId,
      });

      await dispatch(loadSession({ sessionId, saveCurrentSession: false }));
    } catch (error) {
      console.error("Error compacting conversation:", error);
    } finally {
      dispatch(setCompactionLoading({ index, loading: false }));
    }
  },
);
