# Agent self-compaction auto-continue

**Status:** Implementiert
**Date:** 2026-10-06

## Problem / Motivation

`compact_conversation` (agent-self-compaction.md, fork wiring:
agent-self-compaction-fork-wiring.md) is a terminal action: at run end the
conversation forks into a new session with the summary, and control returns
to the user. Any continuation requires an external prompt. In long
multi-phase agent workflows this forces the user to act as a pure "continue"
signal between workstreams, even though the agent knows exactly where the
workstream boundary is and what comes next.

Give the tool an optional auto-continue mode: after the fork, a synthetic
user message ("proceed as planned", or an agent-provided text) is submitted
into the new session, starting the next run without user intervention.

## Scope

- Core: `compact_conversation` tool definition (new optional parameters) and
  implementation (confirmation wording).
- GUI: pending-flag payload (was boolean), budget check in `callToolById`,
  auto-continue dispatch in the run-end trigger, circuit-breaker state.
- `AGENTS.md` compaction rules (auto-continue discipline).

**Out of Scope:**

- Persistence of the circuit-breaker counter across app restarts
  (deliberate — see Analysis).
- Any restriction by run source (board-wake vs. user-started). Decided:
  YAGNI until a concrete need is known.
- GUI affordances for the pending/continuing state beyond what exists.
- The CITT-side tool documentation (different repository).

## Analysis

Existing pieces this extends:

- **Tool definition/impl** (`core/tools/definitions/compactConversation.ts`,
  `core/tools/implementations/compactConversation.ts`): parameterless today;
  core impl returns the scheduling confirmation only, all side effects are
  GUI-side.
- **Pending flag** (`sessionSlice.pendingSelfCompaction`, boolean): set by
  `callToolById` on a successful `compact_conversation` call; consumed by
  the `streamResponseThunk` post-wrapper; dropped on abort (D1), edit mode,
  already-running compaction, and on thunk rejection. Also read by
  `selectIsCompactionRunning` (truthy check — stays compatible with an
  object payload).
- **Run-end trigger** (`streamResponse.ts` post-wrapper): guards, clears
  the flag, dispatches `forkWithSummaryThunk`, which switches into the new
  session via `loadSession` (awaited).
- **Synthetic-run pattern**: `useBoardWatch` already starts runs with a
  synthetic user message — `streamResponseThunk({ editorState: <tiptap
doc>, modifiers })`. Auto-continue reuses exactly this entry point.
- **Tool args in the GUI**: `ToolCallState.parsedArgs` is available in
  `callToolById`, so the new parameters can be evaluated at tool-call time.

**Circuit breaker.** Auto-continue removes the last external gate on run
chaining: an agent could compact-and-continue indefinitely without any
human ever seeing the session. A budget caps consecutive auto-continue
forks at **10**. Placement decisions:

- The counter lives in the redux session state only — not persisted. An app
  restart resets it, which is safe: after a restart only an external
  trigger (user, board wake) can start a run anyway.
- Reset semantics: the counter tracks _uninterrupted_ auto-continue chains.
  Every run enters through `streamResponseThunk` (user submit, board wake,
  edit/resend); tool-loop continuations go through
  `streamResponseAfterToolCall` instead, and `setActive` fires per LLM call
  — so `streamResponseThunk` is the one clean run-entry discriminator.
  A new optional thunk arg marks auto-continue runs; the state flag
  `currentRunWasAutoContinue` is set at run entry from that arg (default
  false — all existing callers reset it implicitly).

**Honest confirmation.** The budget check must happen at tool-call time (in
`callToolById`), not at run end: the agent plans the rest of its run around
the confirmation it receives. When the budget is exhausted, the compaction
itself is still legitimate — it proceeds without auto-continue, and
`callToolById` replaces the confirmation context item with a budget-denied
message before writing it to the history (`updateToolCallOutput`).

**Fork failure.** `forkWithSummaryThunk` catches errors internally (toast)
and returns `void` today; the trigger cannot tell success from failure. It
must return the new session id (or `undefined` on failure) so auto-continue
only dispatches into a session that actually exists. The hook caller
(`useForkWithSummary`) ignores the return value — compatible.

**Degenerate case preserved.** An auto-continued session whose agent
immediately compacts again with no new content throws in
`forkSessionWithSummary` (empty summarize input) — error toast, no fork, no
auto-continue dispatch, and (because the counter increments only after a
successful fork) the chain ends there.

## Solution

```
agent calls compact_conversation({ autoContinue?: boolean, continueMessage?: string })
  core impl: scheduling confirmation (wording reflects auto-continue mode)
  callToolById (on success):
    autoContinue not requested -> setPendingSelfCompaction({})   [today's behavior]
    autoContinue requested:
      wouldBe = currentRunWasAutoContinue ? consecutiveAutoContinues + 1 : 1
      wouldBe > MAX_AUTO_CONTINUE_CHAIN (10)
        -> setPendingSelfCompaction({})                         [compaction only]
           replace the confirmation context item with a
           budget-denied message before updateToolCallOutput
      otherwise
        -> setPendingSelfCompaction({ autoContinueMessage:
             continueMessage ?? DEFAULT_AUTO_CONTINUE_MESSAGE })
  run ends normally, session saved by the wrapper
  streamResponseThunk post-wrapper:
    pending flag set; guards unchanged (not aborted, not edit, no compaction
    running) — otherwise drop, no fork, no auto-continue
      -> forkWithSummaryThunk({ sessionId, index })
         note: read currentRunWasAutoContinue BEFORE dispatching the fork —
         the fork's loadSession runs the session-switch reducer, which
         resets the flag; on success (newSessionId returned):
           consecutiveAutoContinues = wasAutoContinue
             ? consecutiveAutoContinues + 1 : 1
           payload.autoContinueMessage present
             -> dispatch streamResponseThunk({
                  editorState: <plain-text tiptap doc of the message>,
                  modifiers: <default modifiers>,
                  autoContinue: true,          // new optional thunk arg
                })
                run entry sets currentRunWasAutoContinue = true
           payload without autoContinueMessage -> done (today's behavior)
         on failure: toast only — no counter change, chain ends
```

- **Tool parameters**: `autoContinue?: boolean` (default false),
  `continueMessage?: string` (only meaningful with `autoContinue: true`).
  `DEFAULT_AUTO_CONTINUE_MESSAGE` is exported from the core tool definition
  file (single source for definition description, impl confirmation, and
  the GUI fallback): `"Proceed with the next step as planned."`
- **Pending-flag type**: `pendingSelfCompaction: false | { autoContinueMessage?: string }`.
  Presence of `autoContinueMessage` marks the auto-continue request.
- **New session state**: `consecutiveAutoContinues: number` (init 0),
  `currentRunWasAutoContinue: boolean` (init false, reset by the session-
  switch reducer alongside `pendingSelfCompaction`). The counter needs no
  explicit reset: `currentRunWasAutoContinue === false` re-bases it to 1 at
  the next auto-continue.
- **Repeated tool calls within one run**: the last call wins (payload
  overwrite), same as today's implicit boolean behavior.
- The auto-continue message is a normal, visible, abortable user message in
  the new session's history — all user controls (stop, edit) apply.
- **Tool description / systemMessageDescription** keep their usage-guiding
  role and gain the auto-continue discipline: auto-continue is for
  workstream boundaries where the next step would otherwise be a user
  "continue" prompt — not mid-task while details are still needed.

### Expected behavior

- Normal case: run ends, fork switches into the new session, and a follow-up
  run starts there with the continue message as its first user message;
  the source session remains untouched.
- Budget exhausted (11th consecutive auto-continue requested): compaction
  proceeds, no auto-continue; the agent's confirmation says so, and the run
  ends waiting for external input.
- Aborted run, edit mode, or a compaction already running: the pending
  request is dropped — no fork, no auto-continue (D1 unchanged).
- User or board wake starting a run in a continued session re-bases the
  chain: the next auto-continue counts as 1.
- App restart: counter resets to 0 (redux-only state, deliberate).

## Implementation Checklist

- [x] `core/tools/definitions/compactConversation.ts`: add `autoContinue` /
      `continueMessage` parameters; export `DEFAULT_AUTO_CONTINUE_MESSAGE`;
      description + `systemMessageDescription` cover auto-continue
      semantics and discipline.
- [x] `core/tools/implementations/compactConversation.ts`: read args,
      confirmation wording reflects auto-continue (with the resolved
      message); comment update.
- [x] `gui/src/redux/slices/sessionSlice.ts`: `pendingSelfCompaction`
      payload type; `consecutiveAutoContinues` + `currentRunWasAutoContinue`
      state; `MAX_AUTO_CONTINUE_CHAIN = 10`; `setPendingSelfCompaction`
      payload typing; new `setCurrentRunWasAutoContinue` reducer; session-
      switch reset; keep `streamResponseThunk.rejected` cleanup compatible;
      comment updates.
- [x] `gui/src/redux/thunks/callToolById.ts`: evaluate `parsedArgs` for
      `CompactConversation`; budget check; set payload; on budget-denied
      replace the confirmation context item before `updateToolCallOutput`.
- [x] `gui/src/redux/thunks/forkWithSummary.ts`: return
      `newSessionId | undefined` (hook caller unchanged).
- [x] `gui/src/redux/thunks/streamResponse.ts`: new optional `autoContinue`
      thunk arg; set `currentRunWasAutoContinue` at run entry; post-wrapper
      consumes the payload — on successful fork increment the counter and,
      when `autoContinueMessage` is present, dispatch the follow-up
      `streamResponseThunk` with a plain-text tiptap doc (small local
      helper); comment update.
- [x] `AGENTS.md`: compaction section — auto-continue triggers and
      discipline (workstream boundaries only; default remains no
      compaction).
- [x] Comment updates at sites referencing the boolean pending flag
      (`selectIsCompactionRunning` stays truthy-compatible).
