# Agent self-compaction forks into a new conversation

**Status:** Implementiert
**Date:** 2026-08-23

## Problem / Motivation

The `compact_conversation` base tool (agent-self-compaction.md) schedules an
in-place compaction at the end of the current run: the summary is stored on
the last history item and the entire history before it is kept. Agent
conversations are long-lived (multi-workstream sessions, board wakes), so the
session grows without bound — every compaction adds another summary marker to
the same ever-growing session, and nothing is ever trimmed. Session load,
history rendering and the GUI stay responsive only while sessions stay lean.

A second mechanism exists and is proven on the GUI button:
fork-with-summary (conversation-fork-with-summary.md), "compaction into a new
conversation" — a new session starts with a single synthetic summary item,
the source session remains untouched. The tool was wired to the in-place
mechanism instead; for unattended agent usage the fork semantics are the
better default. Rewire the tool's run-end trigger to fork-with-summary.

## Scope

- GUI: hook-free fork runner extracted from `useForkWithSummary`; the
  run-end trigger dispatches it instead of `compactConversationThunk`.
- Core: tool definition and implementation wording — the semantics change
  from in-place/undoable to fork/preserved.
- Comment updates where the tool path claims "Type 1 / non-trimming".

**Out of Scope:**

- The GUI's inline compaction button and its path — unchanged.
- Summary generation and prompt — unchanged (fork and inline share it).
- Core message handlers (`conversation/compact`,
  `conversation/forkWithSummary`) — unchanged.
- UI affordances for the pending state.
- The CITT-side tool documentation (different repository).

## Analysis

Existing pieces this rewires:

- **Run-end trigger** (`streamResponse.ts` post-wrapper): consumes the
  `pendingSelfCompaction` flag set by `callToolById`, guards on
  `streamAborted` / `isInEdit` / already-running compaction, then dispatches
  `compactConversationThunk` with `index = last history item`.
- **`compactConversationThunk`**: hook-free inline runner (request
  `conversation/compact` → `loadSession` of the same session).
- **`useForkWithSummary`** (gui/src/util/compactConversation.ts): React hook
  only — `setCompactionLoading` → request `conversation/forkWithSummary` →
  toast on error → `await loadSession(newSessionId)` → clear flag in
  `finally`. A redux post-wrapper cannot call hooks, so the body needs a
  hook-free thunk exactly as done for the inline runner.
- **Board-wake gate**: `selectIsCompactionRunning` covers
  `pendingSelfCompaction` and `compactionLoading`; both runners use
  `compactionLoading` around the `loadSession` swap, so the fork path is
  gated exactly like today's GUI button path — no new wiring.
- **Incremental re-compaction**: `generateConversationSummary` integrates the
  most recent previous summary; repeated self-compaction across forks chains
  correctly (the synthetic fork item's summary becomes the "previous
  summary" of the next fork).
- **Tool policy**: stays `allowedWithoutPermission` — the fork is
  non-destructive with respect to the source session.

**Preservation, not undo.** In-place compaction is undoable: deleting the
summary restores the full context _in the live conversation_. Fork
compaction preserves instead: the source session remains untouched and can
be reopened, but work done in the new session never flows back into it. The
tool wording must express preservation, not undoability.

**Degenerate input.** Compacting a session whose only item is the synthetic
fork item (agent compacts again with no new content in between) throws in
`generateConversationSummary`: the item's own summary is excluded from
re-compaction and its message is empty. The in-place path throws identically
today — no regression; the error surfaces via toast and nothing is lost.

## Solution

```
agent calls compact_conversation (mid-run)
  core impl returns the "scheduled" confirmation (unchanged)
  callToolById: on success -> setPendingSelfCompaction(true) (unchanged)
  run ends normally, session saved by the wrapper
  streamResponseThunk post-wrapper:
    not aborted, not edit mode, no compaction running
      -> forkWithSummaryThunk({ sessionId, index: lastIndex })
           request conversation/forkWithSummary (core, unchanged)
           -> await loadSession(newSessionId)   <- session switch
    otherwise -> drop the flag, no fork                [D1 of agent-self-compaction.md]
```

- **New hook-free runner** `forkWithSummaryThunk` in
  `gui/src/redux/thunks/forkWithSummary.ts`: the moved body of
  `useForkWithSummary` — `setCompactionLoading` → request → error toast →
  `await loadSession(newSessionId, saveCurrentSession: false)` → clear flag
  in `finally`. Guard-free like `compactConversationThunk`; the hook keeps
  its `isStreaming`/session-id guards and delegates to the thunk.
- **Run-end trigger**: dispatches `forkWithSummaryThunk` instead of
  `compactConversationThunk`; guards and index unchanged.
- **Tool wording** (definition + impl confirmation): the compaction now
  starts a new conversation with the comprehensive summary at the end of the
  run; the original conversation is preserved untouched and can be reopened
  (nothing is lost). No undoability claim.
- **Error surfacing at the run-end path**: the shared runner toasts like the
  GUI button path — one behavior for both callers.

### Expected behavior

- Normal case: the run ends after the tool call, the GUI switches into the
  new session containing only the summary item (`continuedFromSessionId`
  set); the source session remains untouched in history.
- Aborted run, edit mode, or a compaction already running: the pending
  request is dropped, no fork.
- Repeated self-compaction: each call forks from the current session; the
  previous summary is integrated into the new one.
- Fork-only session with no new content: error toast, session unchanged.

## Implementation Checklist

- [x] `gui/src/redux/thunks/forkWithSummary.ts`: new `forkWithSummaryThunk`
      (moved `useForkWithSummary` body).
- [x] `gui/src/util/compactConversation.ts`: `useForkWithSummary` delegates
      to the thunk, keeping its guards.
- [x] `gui/src/redux/thunks/streamResponse.ts`: post-wrapper dispatches
      `forkWithSummaryThunk`; update the comment.
- [x] `core/tools/definitions/compactConversation.ts`: description +
      `systemMessageDescription` on fork semantics (preserved, not undoable).
- [x] `core/tools/implementations/compactConversation.ts`: confirmation
      text + comment on fork semantics.
- [x] Update "Type 1 / non-trimming" comments at the touched sites
      (`callToolById.ts`, `sessionSlice.ts` pending-flag comment).
