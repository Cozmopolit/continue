# Agent Self-Compaction (`compact_conversation` Base Tool)

**Status:** Implementiert (2026-08-16)
**Date:** 2026-08-16

## Problem / Motivation

Long agent conversations accumulate context. Compaction exists today but is
user-initiated only (UI button / "trim into new conversation"). The agent
itself is the best judge of when a logical unit of work is complete and the
detail of the history is no longer needed for the next steps — e.g. swarm
agents finishing a workstream before the next user message or board wake.

Add a Continue-native base tool that lets the agent schedule an in-place
(Type 1, non-trimming) compaction to run **after the current run completes**.

## Scope

- New base tool `compact_conversation` (definition, registration, core handler).
- GUI: pending flag in session state, set from the tool-call thunk, consumed
  at run end.
- Extract the compaction execution from `useCompactConversation` into a
  hook-free runner reusable by the run-end path.
- Board-wake integration: fold the pending flag into the compaction gate and
  pause the watcher (including priming) until compaction completes.

**Confirmed design decisions (user, 2026-08-16):**

- **D1 — Run abort after tool call:** pending request is discarded, no
  compaction. Same for run errors. Detection per recon: a `streamAborted`
  session flag (set by `abortStream`, cleared by `setActive`);
  thunk-rejected handling as belt-and-suspenders only, because the stream
  wrapper swallows errors and user stops end the stream cleanly (Analysis).
- **D2 — Visibility:** base tool, no experimental gating.
- **D3 — Content after the tool call:** everything the agent does for the
  rest of the run belongs to the same run and is included in the summary —
  nothing is lost, no special handling. The tool description carries the
  usage guidance ("call when the run is winding down").

**Out of Scope:** Type 2 / fork-with-summary; agent-chosen compaction index
(always the end of the run); changes to the summary prompt (separate
workstream, see `continue-conv-compaction` memory tag); UI affordances for
the pending state; CITT/MCP side.

## Analysis

Existing pieces this builds on:

- **Type 1 compaction** (`core/util/conversationCompaction.ts`):
  non-destructive, stores the summary on the target history item, history
  kept. GUI path today (`gui/src/util/compactConversation.ts`,
  `useCompactConversation`): `setCompactionLoading` → core
  `conversation/compact` → `await loadSession` → clear flag in `finally`.
- **Compaction gate** (board-wake-mode.md, amendment 2026-08-16 II):
  `selectIsCompactionRunning` (from `compactionLoading`) gates board-wake
  ticks and wake dispatches. `loadSession` runs the `newSession` reducer,
  which resets the board buffer — hence the gate.
- **Run structure** (GUI): `streamResponseThunk` → `streamThunkWrapper` →
  `streamNormalInput`; tool calls execute via `callToolById` (`tools/call`
  to core for non-client tools), continuation via
  `streamResponseAfterToolCall`. Abort/error rejects the thunk.
- **Tool precedent**: the board tools (`BuiltInToolNames`, definition in
  `core/tools/definitions/`, registered in `getBaseToolDefinitions()`).

**Recon finding — abort propagation (2026-08-16).** `streamThunkWrapper`
swallows stream errors (catch → `cancelStream` + error dialog → fulfilled),
and user stops (stop button, Cmd+Backspace, IDE event — all `cancelStream`)
end `streamNormalInput` cleanly without throwing. Neither abort nor error
rejects `streamResponseThunk`, so the pending request needs an explicit
discriminator: `abortStream` is dispatched on every abort/error path (and
only there). Its reducer leaves no observable flag, so this spec adds one:
`streamAborted`, set by `abortStream`, cleared by `setActive` (which
`streamNormalInput` dispatches — retry-safe under overload retries).

**Key interaction — priming race.** At a run end with pending compaction and
board watch on, two effects coincide at the idle transition: the watcher's
priming consume (`fetchBoardPending` → board buffer) and the compaction's
`loadSession` resetting that same buffer with the cursor already advanced —
consumed messages would be lost permanently. The amendment-II tick gate does
**not** cover this: priming runs once at watcher activation, outside any tick.
Fix below folds the pending flag into the gate and pauses the whole watcher
(including priming) until compaction completes; it then re-activates and
primes into the fresh buffer. Side effect: the watcher also pauses during
user-initiated compaction — consistent with the gate's intent.

## Solution

```
agent calls compact_conversation (mid-run)
  core handler returns "scheduled" confirmation (no core side effect)
  callToolById (GUI): on success -> setPendingSelfCompaction(true)
  run continues, ends normally
  streamResponseThunk post-wrapper (session already saved):
    pending flag set + streamAborted false + !isInEdit +
    no other compaction running
      -> compaction runner, index = last history item
    otherwise -> drop the flag, no compaction                [D1]
  streamResponseThunk.rejected -> drop the flag as well
```

- **Tool definition:** `compact_conversation` in `BuiltInToolNames` +
  definition following the board-tool pattern (no parameters, readonly,
  `description` + `systemMessageDescription`). Description guides usage:
  call at the end of a completed unit of work, when conversation detail is
  not needed for upcoming steps; compaction fires after the run completes;
  history is preserved (non-destructive, reversible).
- **No approval required:** compaction is non-destructive and reversible
  (`deleteCompaction`); the tool is treated as auto-allowed (recon verifies
  the policy mechanism in `evaluateToolPolicies.ts`).
- **Extracted runner:** hook-free function/thunk `(sessionId, index)`
  implementing setCompactionLoading → `conversation/compact` →
  `await loadSession` → clear in `finally` (identical semantics to today's
  hook, including the amendment-II await). `useCompactConversation`
  delegates to it.
- **Selector:** `selectIsCompactionRunning` additionally returns true while
  `pendingSelfCompaction` is set — the pending window is gated exactly like
  a running compaction.
- **Watcher:** `active = boardWatchMode && isIdle && !selectIsCompactionRunning`;
  doc comment updated (watcher pauses completely during compaction, priming
  included).
- **Abort discriminator:** new session flag `streamAborted` — `abortStream`
  sets it (dispatched on every abort/error path, and only there), `setActive`
  clears it (retry-safe). The run-end trigger compacts only while it is
  false; otherwise the pending flag is dropped (D1).
- **Guards:** `newSession` reducer resets `pendingSelfCompaction` (session
  switch safety). The trigger also skips edit mode (`isInEdit` — the wrapper
  skips the session save there) and drops the request (no queueing) if
  another compaction is already running. The tool call itself always
  succeeds and returns the confirmation; the drop is a rare race noted in
  the run-end logic. Residual (documentation only): history truncation
  during the pending window.

## Implementation Checklist

- [x] `core/tools/builtIn.ts`: add `CompactConversation = "compact_conversation"`.
- [x] `core/tools/definitions/compactConversation.ts`: new definition,
      board-tool pattern (no params, `readonly: false` — it mutates session
      state, `defaultToolPolicy: "allowedWithoutPermission"` —
      non-destructive and reversible, usage-guiding description +
      systemMessageDescription).
- [x] `core/tools/index.ts`: register in `getBaseToolDefinitions()`.
- [x] `core/tools/implementations/compactConversation.ts`:
      `compactConversationImpl` returns the scheduling confirmation text, no
      side effect; wired as a case in `callBuiltInTool`
      (`core/tools/callTool.ts`).
- [x] `gui/src/redux/slices/sessionSlice.ts`: `pendingSelfCompaction` +
      `streamAborted` state and a `setPendingSelfCompaction` reducer;
      `abortStream` sets `streamAborted`, `setActive` clears it; `newSession`
      resets `pendingSelfCompaction`; explicit `streamResponseThunk.rejected`
      case clears the pending flag (replaces its no-op passthrough case).
- [x] `gui/src/redux/thunks/callToolById.ts`: on successful execution of
      `compact_conversation` → dispatch `setPendingSelfCompaction(true)`.
- [x] New `gui/src/redux/thunks/compactConversation.ts`: hook-free
      compaction runner (`compactConversationThunk`);
      `useCompactConversation` in `gui/src/util/compactConversation.ts`
      delegates.
- [x] `gui/src/redux/thunks/streamResponse.ts`: post-wrapper — pending flag
      set, `streamAborted` false, `!isInEdit`, no other compaction running →
      dispatch runner with `index = history.length - 1`; otherwise drop the
      flag (D1).
- [x] `gui/src/redux/selectors/selectToolCalls.ts`: extend
      `selectIsCompactionRunning` with `|| state.session.pendingSelfCompaction`.
- [x] `gui/src/hooks/useBoardWatch.ts`: gate `active` on
      `!selectIsCompactionRunning`; update doc comment (pauses priming too).
