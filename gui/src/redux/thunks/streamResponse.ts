import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  bumpAutoContinueChain,
  resetNextCodeBlockToApplyIndex,
  setCurrentRunWasAutoContinue,
  setPendingSelfCompaction,
  submitEditorAndInitAtIndex,
  truncateHistoryToLength,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { forkWithSummaryThunk } from "./forkWithSummary";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";
import { updateFileSymbolsFromFiles } from "./updateFileSymbols";

/**
 * Auto-continue (agent-self-compaction-auto-continue.md): plain-text tiptap
 * doc for the follow-up run's synthetic user message (same shape as the
 * board-wake doc in useBoardWatch).
 */
function buildAutoContinueDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
    autoContinue?: boolean;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async (
    { editorState, modifiers, index, autoContinue },
    { dispatch, extra, getState },
  ) => {
    // Auto-continue circuit-breaker bookkeeping
    // (agent-self-compaction-auto-continue.md): every run enters through
    // this thunk, and only the post-wrapper auto-continue dispatch passes
    // autoContinue — so any externally triggered run re-bases the chain.
    dispatch(setCurrentRunWasAutoContinue(autoContinue === true));
    // Overloaded retries replace the aborted attempt
    // (overloaded-retry-history-rewind.md): the wrapper re-runs this whole
    // closure, and re-submitting at history.length would append a second
    // copy of the user message whenever the aborted attempt left captured
    // content behind (partial text or thinking items). Snapshot the
    // pre-submit length on the first attempt; retries truncate back to it
    // first. Explicit-index submits (edit/resend) need no rewind — the
    // resubmission branch of submitEditorAndInitAtIndex truncates anyway.
    let rewindLength: number | undefined;
    await dispatch(
      streamThunkWrapper(async () => {
        if (rewindLength !== undefined) {
          dispatch(truncateHistoryToLength(rewindLength));
        }
        const state = getState();
        const selectedChatModel = selectSelectedChatModel(state);
        const inputIndex = index ?? state.session.history.length; // Either given index or concat to end
        if (index === undefined) {
          rewindLength = inputIndex;
        }

        if (!selectedChatModel) {
          throw new Error("No chat model selected");
        }
        dispatch(
          submitEditorAndInitAtIndex({ index: inputIndex, editorState }),
        );

        dispatch(resetNextCodeBlockToApplyIndex());

        const defaultContextProviders =
          state.config.config.experimental?.defaultContext ?? [];

        // Resolve context providers and construct new history
        const {
          selectedContextItems,
          selectedCode,
          content,
          legacyCommandWithInput,
        } = await resolveEditorContent({
          editorState,
          modifiers,
          ideMessenger: extra.ideMessenger,
          defaultContextProviders,
          availableSlashCommands: state.config.config.slashCommands,
          dispatch,
          getState,
        });

        // symbols for both context items AND selected codeblocks
        const filesForSymbols = [
          ...selectedContextItems
            .filter((item) => item.uri?.type === "file" && item?.uri?.value)
            .map((item) => item.uri!.value),
          ...selectedCode.map((rif) => rif.filepath),
        ];
        void dispatch(updateFileSymbolsFromFiles(filesForSymbols));

        dispatch(
          updateHistoryItemAtIndex({
            index: inputIndex,
            updates: {
              message: {
                role: "user",
                content,
                id: uuidv4(),
              },
              contextItems: selectedContextItems,
            },
          }),
        );

        unwrapResult(
          await dispatch(
            streamNormalInput({
              legacySlashCommandData: legacyCommandWithInput
                ? {
                    command: legacyCommandWithInput.command,
                    contextItems: selectedContextItems,
                    historyIndex: inputIndex,
                    input: legacyCommandWithInput.input,
                    selectedCode,
                  }
                : undefined,
            }),
          ),
        );
      }),
    );

    // Agent self-compaction (agent-self-compaction.md, fork wiring:
    // agent-self-compaction-fork-wiring.md, auto-continue:
    // agent-self-compaction-auto-continue.md): a successful
    // compact_conversation call during the run scheduled a fork-with-summary
    // compaction for right here — after the run finished and the session was
    // saved by the wrapper. Aborted runs (D1), edit mode, and
    // already-running compactions drop the request instead. The pending flag
    // doubles as the board-wake gate (selectIsCompactionRunning) for the
    // whole window. When the payload carries an auto-continue message and
    // the fork succeeded, the follow-up run starts immediately in the new
    // session — a normal, visible, abortable user-message run.
    const state = getState();
    const pendingSelfCompaction = state.session.pendingSelfCompaction;
    if (pendingSelfCompaction) {
      const sessionId = state.session.id;
      const lastIndex = state.session.history.length - 1;
      const compactable =
        !state.session.streamAborted &&
        !state.session.isInEdit &&
        !Object.values(state.session.compactionLoading).some(Boolean);
      // Secure the run-source flag before the fork: the fork's loadSession
      // resets it via the newSession reducer, but the chain bookkeeping
      // needs this run's value.
      const wasAutoContinue = state.session.currentRunWasAutoContinue;
      dispatch(setPendingSelfCompaction(false));
      if (compactable && sessionId && lastIndex >= 0) {
        const forkAction = await dispatch(
          forkWithSummaryThunk({ sessionId, index: lastIndex }),
        );
        const newSessionId = forkWithSummaryThunk.fulfilled.match(forkAction)
          ? forkAction.payload
          : undefined;
        if (newSessionId && pendingSelfCompaction.autoContinueMessage) {
          dispatch(bumpAutoContinueChain(wasAutoContinue));
          // Fire-and-forget: a thunk's dispatch promise resolves with its
          // final action (no unhandled rejection), and this post-wrapper
          // must not wait out the whole follow-up run.
          void dispatch(
            streamResponseThunk({
              editorState: buildAutoContinueDoc(
                pendingSelfCompaction.autoContinueMessage,
              ),
              modifiers: { useCodebase: false, noContext: true },
              autoContinue: true,
            }),
          );
        }
      }
    }
  },
);
