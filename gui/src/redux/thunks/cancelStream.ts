import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearDanglingMessages,
  rescueInterruptedReasoning,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";

export const cancelStream = createAsyncThunk<
  void,
  { skipReasoningRescue?: boolean } | undefined,
  ThunkApiType
>("chat/cancelStream", async (options, { dispatch, getState }) => {
  dispatch(setInactive());
  dispatch(abortStream());

  if (options?.skipReasoningRescue) {
    // Overloaded retries and webview init keep the stock cleanup behavior.
    dispatch(clearDanglingMessages());
    return;
  }

  // Rescue partial reasoning from streams interrupted mid-reasoning before
  // the dangling cleanup (rescue-interrupted-reasoning.md). Immer only
  // replaces the history reference if the reducer actually changed state,
  // so the reference comparison detects whether anything was rescued.
  const historyBeforeRescue = getState().session.history;
  dispatch(rescueInterruptedReasoning());
  const didRescue = getState().session.history !== historyBeforeRescue;

  // Clear any dangling incomplete tool calls, thinking messages, etc.
  dispatch(clearDanglingMessages());

  // Persist rescued content so it survives a window reload.
  if (didRescue) {
    await dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: true,
      }),
    );
  }
});
