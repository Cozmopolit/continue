# Overloaded retries must replace the attempt, not append to history

**Status:** Implementiert
**Date:** 2026-08-22

## Problem / Motivation

Incident family of `resent-user-messages.md`: without any user action, the
last user message shows up again mid-run — for the agent it looks as if the
user interrupted the run and resent the exact same message, starting a new
run. Persisted duplicates were observed 2026-08-10/08-14; the symptom
reappeared 2026-08-22 (zenith). The open follow-up in
`resent-user-messages.md` already names the suspect: the overloaded-retry
path in `streamThunkWrapper.tsx`.

Root cause (verified in code): the GUI-level overloaded retry re-executes
the whole run closure, including its history-mutating dispatches.

1. `streamResponseThunk` (run start): on an "overloaded"/"529" error from
   the depth-0 LLM call, the retry re-dispatches `submitEditorAndInitAtIndex`
   at `history.length`. If the aborted attempt already captured content
   (partial text or thinking items — a thinking model captures reasoning
   before any visible text), `clearDanglingMessages` keeps that tail, and
   the retry appends a second identical user message plus a fresh empty
   assistant item and starts a new run from there → persisted duplicate,
   exactly the reported symptom.
   When nothing was captured yet, `clearDanglingMessages` removes the
   trailing user message before the retry, so the resubmit stays clean —
   the invisible variant.
2. `streamResponseAfterToolCall` (tool-loop continuation): the retry
   re-dispatches `streamUpdate([toolMessage])`. `streamUpdate` always
   creates a new history item for tool messages (no toolCallId dedupe), so
   the same tool result lands in the history twice. The failed attempt's
   partial assistant content additionally survives and the second attempt's
   tokens are concatenated onto it.

The core transport layers already retry safely: `retryStream`
(rate-limit-retry.md) only inside the zero-yield window;
`withExponentialBackoff` covers overloaded at the fetch level. The GUI
wrapper stacks on top of them and is the only layer that mutates history.

## Scope

- `gui/src/redux/slices/sessionSlice.ts`: new reducer
  `truncateHistoryToLength`.
- `gui/src/redux/thunks/streamResponse.ts`: rewind to the pre-submit
  snapshot before a retry re-submits.
- `gui/src/redux/thunks/streamResponseAfterToolCall.ts`: rewind to the
  pre-tool-message snapshot before a retry re-appends.
- `gui/src/redux/thunks/streamThunkWrapper.tsx`: retry observability.
- `dev-docs/technical-debts/resent-user-messages.md`: resolve the
  persisted-duplicate follow-up.

**Out of Scope:**

- The retry policy itself (attempt count, delays, error matching) —
  unchanged. Unattended board-wake runs keep their automatic retry.
- `streamEditThunk` — its closure does not mutate history (edits go
  through `edit/sendPrompt`).
- Core retry layers (rate-limit-retry.md) — unchanged.
- Repairing already-corrupted sessions (fresh session, as before).

## Analysis

```
user sends X ──► submitEditorAndInitAtIndex appends [user X, assistant ""]
                stream captures thinking / partial content
                LLM call fails with "overloaded" / "529"
wrapper catch ──► cancelStream(skipReasoningRescue)
                  └─ clearDanglingMessages keeps the captured tail
delay 2s·2^n  ──► attempt N+1 re-runs the whole closure:
                  submitEditorAndInitAtIndex at history.length
                  └─ appends [user X, assistant ""] again   ← duplicate
```

- Closure-local state survives across retry attempts (the wrapper invokes
  the same closure instance) → a snapshot can live in the closure, no
  wrapper plumbing needed.
- Explicit-index submits (edit/resend from the GUI) run through
  `submitEditorAndInitAtIndex`' truncating resubmission branch, which is
  self-healing on retry → no rewind needed there.
- `setActive` resets `streamAborted` at every stream start, so a retried
  run starts with clean flags.
- The snapshots sit at safe boundaries: pre-user-submit (history tail
  belongs to finished turns) and pre-tool-message-append (tail is the
  assistant item carrying the toolCallStates) — truncation never creates
  orphaned tool/assistant pairs.
- Parallel tool calls: only the continuation that finds all tools done
  streams, i.e. the one that appended the last tool message. Its snapshot
  covers exactly its own append; sibling continuations' messages precede
  the snapshot and are never truncated.

## Solution

Principle: **a retry replaces the aborted attempt.** Each closure rewinds
the history to its pre-attempt snapshot length before re-executing its
history-mutating dispatches.

```ts
// streamResponse.ts (append case: no explicit index)
let rewindLength: number | undefined;
await dispatch(streamThunkWrapper(async () => {
  if (rewindLength !== undefined) {
    dispatch(truncateHistoryToLength(rewindLength)); // discard the attempt
  }
  const state = getState();
  const inputIndex = index ?? state.session.history.length;
  if (index === undefined) {
    rewindLength = inputIndex;
  }
  dispatch(submitEditorAndInitAtIndex({ index: inputIndex, editorState }));
  // ... unchanged
```

```ts
// streamResponseAfterToolCall.ts, before the tool-message append
let rewindLength: number | undefined;
// inside the closure, after the !toolCallState guard:
if (rewindLength !== undefined) {
  dispatch(truncateHistoryToLength(rewindLength));
} else {
  rewindLength = getState().session.history.length;
}
dispatch(streamUpdate([newMessage])); // tool message exactly once
```

New reducer (sessionSlice):

```ts
truncateHistoryToLength: (state, { payload }: PayloadAction<number>) => {
  const length = Math.max(0, Math.min(payload, state.history.length));
  state.history = state.history.slice(0, length);
};
```

Observability: the wrapper logs every retry with `console.warn` (attempt
number and error message), so future recurrences are attributable to the
retry mechanism from the webview devtools console.

### Expected behavior

- Overloaded at run start, nothing captured: unchanged — clean silent
  resubmit.
- Overloaded mid-stream (content/reasoning captured): the aborted attempt
  is discarded wholesale; the single user message remains; the replacement
  run answers it. No persisted duplicate.
- Overloaded at the tool-loop continuation: exactly one tool message; no
  cross-attempt content concatenation.
- Non-overloaded errors: unchanged (dialog with Resubmit).

## Implementation Checklist

- [x] `sessionSlice.ts`: add and export reducer `truncateHistoryToLength`
      (clamped slice of `state.history`).
- [x] `streamResponse.ts`: closure-local `rewindLength` snapshot (append
      case only); dispatch the truncate at closure start on retries;
      comment referencing this file.
- [x] `streamResponseAfterToolCall.ts`: same pattern around the
      `streamUpdate([newMessage])` append; comment referencing this file.
- [x] `streamThunkWrapper.tsx`: `console.warn` per retry (attempt, error
      message); extend the existing "Retries replace the attempt" comment
      with the rewind reference.
- [x] `resent-user-messages.md`: resolve the persisted-duplicate follow-up
      (mechanism + fix), update the status line.
