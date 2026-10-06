import { createAsyncThunk } from "@reduxjs/toolkit";

import { setCompactionLoading } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { loadSession } from "./session";

/**
 * Agent self-compaction fork wiring (agent-self-compaction-fork-wiring.md):
 * hook-free fork-with-summary runner shared by the UI button
 * (useForkWithSummary) and the run-end trigger (streamResponseThunk).
 * The compactionLoading flag doubles as the board-wake gate and must only
 * clear once the session switch (which resets the board buffer) is done
 * (board-wake-mode.md, amendment 2026-08-16 II). Errors are surfaced via
 * toast — the source session is never touched, nothing is lost.
 *
 * Returns the new session id, or undefined when the fork failed (the error
 * toast has already been shown). The run-end trigger keys the auto-continue
 * dispatch off this (agent-self-compaction-auto-continue.md); the hook
 * caller ignores the return value.
 */
export const forkWithSummaryThunk = createAsyncThunk<
  string | undefined,
  { sessionId: string; index: number },
  ThunkApiType
>("chat/forkWithSummary", async ({ sessionId, index }, { dispatch, extra }) => {
  try {
    dispatch(setCompactionLoading({ index, loading: true }));

    // conversation-fork-with-summary.md: the source session stays untouched;
    // errors are surfaced via toast instead of being swallowed.
    const result = await extra.ideMessenger.request(
      "conversation/forkWithSummary",
      {
        index,
        sessionId,
      },
    );

    if (result.status === "error") {
      throw new Error(result.error);
    }

    // Switch to the freshly created fork session. Awaited so the
    // compactionLoading flag (the board-wake gate) outlives the state swap.
    await dispatch(
      loadSession({
        sessionId: result.content.newSessionId,
        saveCurrentSession: false,
      }),
    );
    return result.content.newSessionId;
  } catch (error) {
    console.error("Error forking conversation:", error);
    extra.ideMessenger.post("showToast", [
      "error",
      "Failed to start new conversation with summary",
    ]);
    return undefined;
  } finally {
    dispatch(setCompactionLoading({ index, loading: false }));
  }
});
