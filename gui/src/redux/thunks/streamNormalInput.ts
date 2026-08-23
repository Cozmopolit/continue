import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import {
  ChatMessage,
  LLMFullCompletionOptions,
  ModelDescription,
  TextMessagePart,
} from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  endActiveReasoning,
  errorToolCall,
  markBoardDelivered,
  rescueInterruptedReasoning,
  setActive,
  setAppliedRulesAtIndex,
  setBoardFetchAttempted,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setToolGenerated,
  streamUpdate,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";

import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";

import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import { getPlatform } from "../../util";
import {
  BOARD_RUN_PATH_FETCH_ENABLED,
  boardInjectionRule,
  renderBoardInjectionBlock,
  shouldFetchBoard,
} from "../../util/boardInjection";
import { fileUriToNativePath } from "../../util/fileUriToNativePath";
import { callToolById } from "./callToolById";
import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { ackBoardMessages, fetchBoardPending } from "./fetchBoardPending";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0 },
    { dispatch, extra, getState },
  ) => {
    if (process.env.NODE_ENV === "test" && depth > 50) {
      const message = `Max stream depth of ${50} reached in test`;
      console.error(message, JSON.stringify(getState(), null, 2));
      throw new Error(message);
    }
    const state = getState();
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Get tools and apply model-level overrides (disabled, description, etc.)
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    // Use the centralized selector to determine if system message tools should be used
    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    // Construct completion options
    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = {
        tools: activeTools,
      };
    }

    completionOptions = buildReasoningCompletionOptions(
      completionOptions,
      state.session.hasReasoningEnabled,
      selectedChatModel,
    );

    // Construct messages (excluding system message)
    const baseSystemMessage = getBaseSystemMessage(
      state.session.mode,
      selectedChatModel,
      activeTools,
    );

    // Inject workspace environment info into system message
    // This provides the LLM with workspace context for tools requiring absolute paths
    const workspaceDirs = await extra.ideMessenger.ide.getWorkspaceDirs();
    const primaryWorkspace = workspaceDirs[0]
      ? fileUriToNativePath(workspaceDirs[0])
      : "unknown";
    const envBlock = `
<env>
  workspace_root: ${primaryWorkspace}
  platform: ${getPlatform()}
</env>
`;
    const baseSystemMessageWithEnv = baseSystemMessage + envBlock;

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessageWithEnv,
          activeTools,
        )
      : baseSystemMessageWithEnv;

    // Board auto-topic-injection (board-auto-topic-injection.md, revision 2)
    // — the run-path fetch is DISABLED (BOARD_RUN_PATH_FETCH_ENABLED,
    // board-wake-mode.md amendment 2026-08-21 "Run-Pfad-Abschaltung"): an
    // injection block mutating between tool-loop calls of one run is
    // invisible to the model, so the board-wake watcher is the only fetcher
    // now (it polls immediately on every run end). The block below is still
    // rendered every call — that render is the wake's delivery vehicle. The
    // gated path stays intact for re-enabling; while disabled it never
    // fetches and never stamps.
    const now = Date.now();
    if (
      BOARD_RUN_PATH_FETCH_ENABLED &&
      shouldFetchBoard(getState().session.board.lastFetchAt, now)
    ) {
      dispatch(setBoardFetchAttempted(now));
      await fetchBoardPending(dispatch, extra.ideMessenger);
    }

    const boardInjectionBlock = renderBoardInjectionBlock(
      getState().session.board,
    );
    const availableRules = boardInjectionBlock
      ? [...state.config.config.rules, boardInjectionRule(boardInjectionBlock)]
      : state.config.config.rules;

    const withoutMessageIds = state.session.history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      withoutMessageIds,
      systemMessage,
      availableRules,
      state.ui.ruleSettings,
      systemToolsFramework,
    );

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      setAppliedRulesAtIndex({
        index: appliedRuleIndex,
        appliedRules: appliedRules,
      }),
    );

    // [reinject-forensics] (resent-user-messages family): fingerprint every
    // outgoing LLM call so a recurrence is attributable. A duplicate user
    // message in `messages` means injection at/before compile (client side);
    // a clean fingerprint while the model perceives a resend means
    // model-side perception. Temporary tripwire, console-only; pair with
    // experimental.promptLogging for the persisted full payload.
    const textOf = (m: ChatMessage): string =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((p) => ("text" in p ? (p as TextMessagePart).text : ""))
            .join("");
    const lastWireMessage = messages[messages.length - 1];
    const duplicateUserTail =
      lastWireMessage?.role === "user" &&
      messages
        .slice(0, -1)
        .some(
          (m) => m.role === "user" && textOf(m) === textOf(lastWireMessage),
        );
    console.warn(
      `[reinject-forensics] depth=${depth} roles=${messages
        .map((m) => m.role[0])
        .join("")} dupUserTail=${duplicateUserTail} lastHead=${
        lastWireMessage
          ? textOf(lastWireMessage).slice(0, 60).replace(/\s+/g, " ")
          : ""
      }`,
    );

    dispatch(setActive());
    dispatch(setInlineErrorMessage(undefined));

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(setInlineErrorMessage("out-of-context"));
        dispatch(setInactive());
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const {
      compiledChatMessages,
      didPrune,
      contextPercentage,
      inputTokens,
      availableTokens,
    } = precompiledRes.content;

    dispatch(setIsPruned(didPrune));
    dispatch(
      setContextPercentage({
        percentage: contextPercentage,
        ...(inputTokens !== undefined && availableTokens !== undefined
          ? { inputTokens, availableTokens }
          : {}),
      }),
    );

    const start = Date.now();
    const streamAborter = state.session.streamAborter;
    try {
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          legacySlashCommandData,
          messageOptions: { precompiled: true },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && activeTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      let next = await gen.next();
      while (!next.done) {
        if (!getState().session.isStreaming) {
          dispatch(abortStream());
          break;
        }

        dispatch(streamUpdate(next.value));
        next = await gen.next();
      }

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        // Prompt logging is opt-in (prompt-logging-opt-in.md):
        // each PromptLog stores the fully rendered prompt, which grows session
        // state/files quadratically in agent loops. When disabled, only the
        // reasoning-end side effect is kept.
        if (state.config.config.experimental?.promptLogging === true) {
          dispatch(addPromptCompletionPair([next.value]));

          try {
            extra.ideMessenger.post("devdata/log", {
              name: "chatInteraction",
              data: {
                prompt: next.value.prompt,
                completion: next.value.completion,
                modelProvider: selectedChatModel.underlyingProviderName,
                modelName: selectedChatModel.title,
                modelTitle: selectedChatModel.title,
                sessionId: state.session.id,
                ...(!!activeTools.length && {
                  tools: activeTools.map((tool) => tool.function.name),
                }),
                ...(appliedRules.length > 0 && {
                  rules: appliedRules.map((rule) => ({
                    id: getRuleId(rule),
                    slug: rule.slug,
                  })),
                }),
              },
            });
          } catch (e) {
            console.error("Failed to send dev data interaction log", e);
          }
        } else {
          dispatch(endActiveReasoning());
        }
      }
    } catch (e) {
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            errorToolCall({
              toolCallId: tc.toolCallId,
              output: [
                {
                  name: "Tool Call Error",
                  description: "Premature Close",
                  content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                  icon: "problems",
                },
              ],
            }),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    // Stale-turn guard: the captured aborter must still be the current
    // controller — a replacement means this thunk belongs to an aborted turn
    // (see rescue-reasoning-stream-end.md).
    if (
      streamAborter.signal.aborted ||
      state1.session.streamAborter !== streamAborter ||
      !state1.session.isStreaming
    ) {
      return;
    }

    // Fetch/ack decoupling (board-wake-fetch-ack-entkopplung): the LLM call
    // above delivered the accumulated injection block — ack the per-topic
    // high-water marks so the gateway stops re-serving them. Fire-and-forget;
    // a lost ack only costs a dedupe-filtered re-delivery. Aborted/stale
    // turns return above without acking, so an undelivered block stays
    // pending and is re-delivered on the next fetch.
    const boardAcks = Object.entries(getState().session.board.ackByTopic).map(
      ([topic, upToCommentId]) => ({ topic, upToCommentId }),
    );
    if (boardAcks.length > 0) {
      void ackBoardMessages(extra.ideMessenger, boardAcks);
    }

    // Rescue partial reasoning when a turn ends regularly but produced no
    // visible content (e.g. provider hit the token limit mid-reasoning) —
    // same kill-chain as on abort paths, see rescue-reasoning-stream-end.md.
    // No-op whenever the turn produced content or tool calls. Placed behind
    // the staleness guard so a replaced (aborted) thunk cannot rescue into a
    // newer turn's history.
    dispatch(rescueInterruptedReasoning());
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        setToolGenerated({
          toolCallId,
          tools: state1.config.config.tools,
        }),
      );
    }

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted || !state2.session.isStreaming) {
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(dispatch, extra.ideMessenger, generatedCalls2);

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted || !state3.session.isStreaming) {
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const autoApproveAllTools = state3.ui.autoApproveAllTools;
    const policies = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
      autoApproveAllTools,
    );
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      // Board delivered marking (board-injection-delivered-marking.md): the
      // turn completed without further tool calls — the injection block was
      // part of this run's system message, so mark it delivered; the next
      // run renders only fresh content. Staleness guard as in step 1: a
      // replaced/aborted thunk must not mark into the newer turn's state —
      // undelivered blocks re-render in the next run (the safe direction).
      const freshState = getState();
      if (
        !streamAborter.signal.aborted &&
        freshState.session.streamAborter === streamAborter
      ) {
        dispatch(markBoardDelivered());
      }
      dispatch(setInactive());
    } else if (needsApprovalPolicies.length > 0) {
      const builtInReadonlyAutoApproved = autoApprovedPolicies.filter(
        ({ toolCallState }) =>
          toolCallState.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState.tool?.readonly,
      );

      if (builtInReadonlyAutoApproved.length > 0) {
        const state4 = getState();
        if (streamAborter.signal.aborted || !state4.session.isStreaming) {
          return;
        }
        await Promise.all(
          builtInReadonlyAutoApproved.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      }

      dispatch(setInactive());
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted || !state4.session.isStreaming) {
        return;
      }
      if (generatedCalls4.length > 0) {
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                }),
              ),
            );
          }),
        );
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
              }),
            ),
          );
        }
      }
    }
  },
);
