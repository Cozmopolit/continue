import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  resetNextCodeBlockToApplyIndex,
  setPendingSelfCompaction,
  submitEditorAndInitAtIndex,
  truncateHistoryToLength,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { compactConversationThunk } from "./compactConversation";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";
import { updateFileSymbolsFromFiles } from "./updateFileSymbols";

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async ({ editorState, modifiers, index }, { dispatch, extra, getState }) => {
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

    // Agent self-compaction (agent-self-compaction.md): a successful
    // compact_conversation call during the run scheduled a Type-1 compaction
    // for right here — after the run finished and the session was saved by
    // the wrapper. Aborted runs (D1), edit mode, and already-running
    // compactions drop the request instead. The pending flag doubles as the
    // board-wake gate (selectIsCompactionRunning) for the whole window.
    const state = getState();
    if (state.session.pendingSelfCompaction) {
      const sessionId = state.session.id;
      const lastIndex = state.session.history.length - 1;
      const compactable =
        !state.session.streamAborted &&
        !state.session.isInEdit &&
        !Object.values(state.session.compactionLoading).some(Boolean);
      dispatch(setPendingSelfCompaction(false));
      if (compactable && sessionId && lastIndex >= 0) {
        await dispatch(
          compactConversationThunk({ sessionId, index: lastIndex }),
        );
      }
    }
  },
);
