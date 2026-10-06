import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ContextItem, McpUiState } from "core";
import { BuiltInToolNames, CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";

import { callClientTool } from "../../util/clientTools/callClientTool";
import { selectSelectedChatModel } from "../slices/configSlice";
import type { PendingSelfCompaction } from "../slices/sessionSlice";
import {
  acceptToolCall,
  errorToolCall,
  MAX_AUTO_CONTINUE_CHAIN,
  setInactive,
  setPendingSelfCompaction,
  setToolCallCalling,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const callToolById = createAsyncThunk<
  void,
  { toolCallId: string; isAutoApproved?: boolean; depth?: number },
  ThunkApiType
>("chat/callTool", async (inputs, { dispatch, extra, getState }) => {
  const { toolCallId, isAutoApproved, depth = 0 } = inputs;

  const state = getState();
  const toolCallState = findToolCallById(state.session.history, toolCallId);
  if (!toolCallState) {
    console.warn(`Tool call with ID ${toolCallId} not found`);
    return;
  }

  if (toolCallState.status !== "generated") {
    return;
  }

  const selectedChatModel = selectSelectedChatModel(state);

  if (!selectedChatModel) {
    throw new Error("No model selected");
  }

  dispatch(
    setToolCallCalling({
      toolCallId,
    }),
  );

  let output: ContextItem[] | undefined = undefined;
  let mcpUiState: McpUiState | undefined = undefined;
  let error: ContinueError | undefined = undefined;
  let streamResponse: boolean;

  // IMPORTANT:
  // Errors that occur while calling tool call implementations
  // Are caught and passed in output as context items
  // Errors that occur outside specifically calling the tool
  // Should not be caught here - should be handled as normal stream errors
  if (
    CLIENT_TOOLS_IMPLS.find(
      (toolName) => toolName === toolCallState.toolCall.function.name,
    )
  ) {
    // Tool is called on client side
    const {
      output: clientToolOutput,
      respondImmediately,
      error: clientToolError,
    } = await callClientTool(toolCallState, {
      dispatch,
      ideMessenger: extra.ideMessenger,
      getState,
    });
    output = clientToolOutput;
    error = clientToolError;
    streamResponse = respondImmediately;
  } else {
    // Tool is called on core side
    const result = await extra.ideMessenger.request("tools/call", {
      toolCall: toolCallState.toolCall,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    } else {
      output = result.content.contextItems;
      mcpUiState = result.content.mcpUiState;
      error = result.content.errorMessage
        ? new ContinueError(
            result.content.errorReason || ContinueErrorReason.Unspecified,
            result.content.errorMessage,
          )
        : undefined;
    }
    streamResponse = true;
  }

  // User-abort guard: if the run was cancelled while this tool was executing
  // (stop button / Cmd+Backspace / stream error), clearDanglingMessages has
  // already marked the state "canceled". A late result must not overwrite
  // that marker (acceptToolCall/errorToolCall would flip it back to
  // done/errored) and must not resume the stream into the user's
  // intervention.
  const stateAfterExecution = getState();
  const toolCallStateAfterExecution = findToolCallById(
    stateAfterExecution.session.history,
    toolCallId,
  );
  if (
    !toolCallStateAfterExecution ||
    toolCallStateAfterExecution.status !== "calling"
  ) {
    return;
  }

  // Agent self-compaction auto-continue
  // (agent-self-compaction-auto-continue.md): resolve the pending payload
  // and check the circuit-breaker budget at tool-call time, so the
  // confirmation the agent receives is honest. A non-blank continueMessage
  // IS the auto-continue request — there is no separate flag. Budget
  // exhaustion still compacts — only the follow-up run is denied, and the
  // confirmation is replaced before it reaches the history. The trim
  // resolution mirrors compactConversationImpl — keep both in sync.
  const isSelfCompactionCall =
    toolCallState.toolCall.function.name ===
    BuiltInToolNames.CompactConversation;
  let selfCompactionPayload: PendingSelfCompaction | undefined;
  if (isSelfCompactionCall && !error) {
    const args = (toolCallState.parsedArgs ?? {}) as {
      continueMessage?: string;
    };
    const continueMessage = args.continueMessage?.trim();
    if (continueMessage) {
      const session = getState().session;
      const wouldBe = session.currentRunWasAutoContinue
        ? session.consecutiveAutoContinues + 1
        : 1;
      if (wouldBe > MAX_AUTO_CONTINUE_CHAIN) {
        output = output?.map((item) =>
          item.name === "Compaction scheduled"
            ? {
                ...item,
                content: `Compaction request registered — but the auto-continue budget (${MAX_AUTO_CONTINUE_CHAIN} consecutive auto-continues without an externally triggered run) is exhausted, so no follow-up run was scheduled: the compaction proceeds normally at the end of this run and the new session waits for external input. End the run when you are done.`,
              }
            : item,
        );
        selfCompactionPayload = {};
      } else {
        selfCompactionPayload = { autoContinueMessage: continueMessage };
      }
    } else {
      selfCompactionPayload = {};
    }
  }

  if (error) {
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: `${toolCallState.toolCall.function.name} failed with the message: ${error.message}\n\nPlease try something else or request further instructions.`,
            hidden: false,
          },
        ],
      }),
    );
  } else if (output?.length) {
    dispatch(
      updateToolCallOutput({
        toolCallId,
        contextItems: output,
        mcpUiState,
      }),
    );
  }

  if (streamResponse) {
    if (error) {
      logToolUsage(toolCallState, false, false, extra.ideMessenger, output);
      dispatch(
        errorToolCall({
          toolCallId,
        }),
      );
    } else {
      logToolUsage(toolCallState, true, true, extra.ideMessenger, output);
      dispatch(
        acceptToolCall({
          toolCallId,
        }),
      );

      // Agent self-compaction (agent-self-compaction.md, fork wiring:
      // agent-self-compaction-fork-wiring.md, auto-continue:
      // agent-self-compaction-auto-continue.md): a successful
      // compact_conversation call schedules the fork-with-summary compaction
      // for the end of the current run (triggered post-wrapper by
      // streamResponseThunk); the payload carries the resolved auto-continue
      // message when one was requested and budget-approved.
      if (selfCompactionPayload !== undefined) {
        dispatch(setPendingSelfCompaction(selfCompactionPayload));
      }
    }

    // Send to the LLM to continue the conversation
    const wrapped = await dispatch(
      streamResponseAfterToolCall({
        toolCallId,
        depth: depth + 1,
      }),
    );
    unwrapResult(wrapped);
  } else {
    dispatch(setInactive());
  }
});
