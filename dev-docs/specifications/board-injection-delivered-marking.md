# Board injection: mark delivered, render only undelivered

**Status:** Implementiert
**Date:** 2026-08-22

## Problem / Motivation

The MsgBoard injection block re-displays delivered messages in every run.
The session board window (`state.board` in sessionSlice) accumulates every
fetched message until `newSession`/`loadSession`, and
`renderBoardInjectionBlock` renders the ENTIRE window into an always-apply
system-message rule on every LLM call. Messages already read or answered in
run N therefore reappear in run N+1 as „neue Nachrichten", stamped with a
fresh render-time „Stand:" timestamp; close-notification lines
(`closedTopicsNotified`, by design never cleared) repeat in every run for
the rest of the session. There is no processed/unprocessed marking and no
compaction — only the size caps (20 messages / 40k chars).

Observed impact: ghost-bootstrap incident (2026-08-17, vesta) — the ghost
thinking explicitly referenced the re-displayed block („already read");
documented as a contributing factor in memory `assistant:coding-agent`,
fragment `incident-conversation-history-drop_2026_08_17`. Origin: problem 2
of the board-wake-mode workstream follow-ups (former tech debt
`board-watch-followups.md`).

The 2026-08-21 changes fixed adjacent bugs, not this one: the run-path
fetch kill switch (`BOARD_RUN_PATH_FETCH_ENABLED`) stopped the block from
mutating mid-run; the fetch/ack decoupling (peek + `ackBoardMessages`) with
id-based dedupe stopped fetch-time loss and duplicate delivery — the ack
only advances the server-side high-water mark and never touches the session
window.

## Scope

- `gui/src/util/boardInjection.ts`: delivered marking in
  `BoardSessionState`, new pure `markBoardDelivered`, render restricted to
  undelivered content.
- `gui/src/redux/slices/sessionSlice.ts`: `markBoardDelivered` reducer.
- `gui/src/redux/thunks/streamNormalInput.ts`: dispatch the mark at turn
  end.

**Out of Scope:**

- Fetch/ack mechanics, watcher cadence and gates (`useBoardWatch`,
  `fetchBoardPending`) — unchanged.
- The disabled run-path fetch (kill switch) — stays intact and compatible.
- Compaction/summarization of board content (variant C) — unnecessary with
  delivered marking.
- Core-side board handling.

## Analysis

- The injection block is **not part of the history**: `constructMessages`
  bakes always-apply rules into the freshly built system message of each
  call. Re-rendering the window is currently the ONLY way the model keeps
  seeing delivered messages — and conversely, removing content from the
  window really removes it from the model's view. Delivered marking is
  therefore a render filter, not just bookkeeping.
- The mark must fire at **turn end**, not per LLM call: within the tool
  loop, later calls rebuild the system message from session state, so a
  block marked after call 1 would silently disappear from calls 2..N of the
  same run — exactly the invisible-mutation failure mode the run-path
  shutdown killed.
- Turn end in the normal flow is the zero-tool-calls branch in
  `streamNormalInput` step 4 (`originalToolCalls.length === 0` →
  `setInactive()`). The approval branch's `setInactive()` is NOT a turn
  end — after approval the loop continues at deeper thunk depth, where the
  zero-tool-calls branch eventually fires. Same for the edit-apply pause:
  client edit tools return `respondImmediately: false` ("let apply state
  handle completion"), `callToolById` ends with `setInactive()`, and
  accept/reject resume via `handleApplyStateUpdate` /
  `cancelToolCall` → `streamResponseAfterToolCall` → `streamNormalInput`.
  Every LLM-completed turn ends in the zero-tool-calls branch — one
  dispatch point suffices; user-dead-end pauses (rejected approval,
  aborted apply) deliberately stay unmarked (safe re-display).
- Dedupe must outlive delivery: `accumulateBoardFetch` derives `knownIds`
  from the window (`messages` + `tooLargeIds`). Delivered messages must
  stay in the window; `deliveredIds` is a subset used for render filtering
  only.
- Aborted/stale turns must not mark (same staleness guard as step 1). The
  asymmetry to the per-call ack is benign: a turn aborted after a
  successful LLM call is already acked server-side, but the session
  re-renders the block once in the next run — the safe direction
  (re-display rather than loss).

## Solution

Variant B (design decision 2026-08-22): delivered marking, render only
undelivered. The window keeps its accumulation/dedupe role; delivery becomes
a render filter.

State additions to `BoardSessionState`:

```ts
/** Window ids (message ids + oversized pointers) already delivered by a completed turn. */
deliveredIds: number[];
/** Subset of closedTopicsNotified already delivered. closedTopicsNotified stays the fetch-dedupe guard. */
closedTopicsDelivered: string[];
```

New pure function (boardInjection.ts):

```ts
export function markDelivered(board: BoardSessionState): BoardSessionState;
// - move all window message ids + tooLargeIds into deliveredIds
// - move closedTopicsNotified into closedTopicsDelivered (union)
// - zero droppedCount and omittedTotal, reset omittedOldestId
```

(The pure function and the sessionSlice action deliberately differ in name
— the slice exports `markBoardDelivered`; same split as
`accumulateBoardFetch`/`appendBoardMessages`.)

Rendering (`renderBoardInjectionBlock`): render only messages whose id is
not in `deliveredIds`; the oversized note only for undelivered
`tooLargeIds`; close lines only for `closedTopicsNotified` minus
`closedTopicsDelivered`; the dropped note references the first RENDERED
message. The empty check covers all filtered views, so the block is omitted
entirely once nothing undelivered remains. The header timestamp becomes
honest: the newest `createdAt` among rendered messages — the `fetchedAt`
parameter is removed; when only close lines/notes render, the header
carries no timestamp.

Housekeeping: `accumulateBoardFetch` prunes `deliveredIds` to the ids still
present in `messages` ∪ `tooLargeIds` after both eviction paths (message
cap, char cap); ids out of the window need no render filter.

Reducer (sessionSlice.ts): `markBoardDelivered` →
`state.board = markDelivered(state.board)`.

Dispatch point (streamNormalInput.ts), in the zero-tool-calls branch of
step 4:

```ts
if (originalToolCalls.length === 0) {
  const fresh = getState();
  if (
    !streamAborter.signal.aborted &&
    fresh.session.streamAborter === streamAborter
  ) {
    dispatch(markBoardDelivered());
  }
  dispatch(setInactive());
}
```

### Expected behavior

- Run N delivers the block → run N+1 renders no board block at all until
  fresh content arrives.
- New messages/close lines fetched after a delivery render alone, without
  re-displaying delivered content.
- Close lines appear once per session.
- Aborted or errored turns: the block stays undelivered and re-renders in
  the next run.
- User-dead-end pauses (approval rejected, edit apply aborted without
  continuation) end without a mark; the block re-renders in the next run —
  the safe direction.
- Re-enabling the run-path fetch (kill switch) stays compatible: the fetch
  dedupes, the mark still fires at turn end.

## Implementation Checklist

- [x] `boardInjection.ts`: add `deliveredIds`/`closedTopicsDelivered` to
      `BoardSessionState` and `EMPTY_BOARD_SESSION_STATE`; add pure
      `markDelivered`; render only undelivered content in
      `renderBoardInjectionBlock` (drop the `fetchedAt` parameter; header
      timestamp = newest rendered `createdAt`, omitted for close/notes-only
      blocks); prune `deliveredIds` on eviction in `accumulateBoardFetch`;
      update the existing `boardInjection.test.ts` assertions to the
      changed render behavior (header exact-string test, close-only block,
      note references).
- [x] `sessionSlice.ts`: add and export the reducer `markBoardDelivered`.
- [x] `streamNormalInput.ts`: dispatch `markBoardDelivered` in the
      zero-tool-calls turn-end branch behind the staleness guard; comment
      referencing this file.
