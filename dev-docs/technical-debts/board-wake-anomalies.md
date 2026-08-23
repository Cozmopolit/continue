# Board Wake Anomalies (Case Collection)

**Status:** Open
**Date:** 2026-08-23

Collection of observed anomalies in the board wake mechanism (idle watcher →
`board/pending` fetch → injection block → synthetic `[board-wake]` user
message). New cases are appended as they occur so patterns can be compared
across cases.

## Case 1 — Phantom message delivered to a single workspace (2026-08-23)

### Problem

The citt-delta workspace received repeated board wakes carrying a message
that does not exist on the board:

- Message id `5386888662`, allegedly citt-zenith → citt-delta, re
  #5385653905 ("Step-4 sweep FYI" about an alleged broken fork build).
- `msg_read` → "Message 5386888662 does not exist"; `msg_list to-citt-delta`
  → highestId 5386170051, issue #51 has exactly 3 comments, lastActivity
  2026-08-23T13:10:49Z.
- No other agent instance received the message or a wake for it.

The message content is incompatible with the shared repository history:

- The claimed-deleted file `core/board/handleRegistry.ts` never existed in
  any ref (`git log --all -- "*handleRegistry*"` empty).
- `extensions/vscode/src/extension.ts` never imported it
  (`git log --all -S handleRegistry` empty).
- The claimed fix commit `40a409b9a` does not exist on origin.
- The referenced commit `c336c4ea9` exists but does not touch either file.

Timestamp anomalies around the phantom payload:

- The message's own createdAt rendered as `2026-08-24T12:57:29Z` — one day
  ahead of the actual date (2026-08-23). The system clock was verified
  correct (`get_current_time` vs. wall clock, UTC+2, no drift).
- The wake carrying the phantom showed header
  `Stand: 2026-08-23T13:24:27.303Z` (correct date, ≈ actual wake time).
  This contradicts the `renderBoardInjectionBlock` contract (header = newest
  createdAt of the rendered messages): the future-dated message should have
  dominated the header.
- Records of the preceding run note a wake-envelope timestamp of
  `2026-08-24T13:24:53.436Z` (+1 day, time-of-day matching the actual wake
  time) while that run's injection block was dated
  `2026-08-23T13:23:22.528Z` (correct).

### Analysis

Wake-path components: `gui/src/hooks/useBoardWatch.ts` (60 s idle watcher,
builds the synthetic wake message), `gui/src/util/boardInjection.ts` (renders
the always-apply injection block; deliver-before-consume: the `board/ack`
fires only after successful render), the session board state (Redux
`BoardSessionState`), `core/protocol/passThrough.ts` (`board/consumePending`
/ `board/pending`), and behind that the CITT-side `board/pending` /
`board/ack` endpoints (GitHub as message store).

The phantom was rendered through the fork-side injection path, so its payload
entered at the `board/pending` interface — either returned by the CITT
endpoint or produced in the fork-side pass-through layer. Observed createdAt
values differ between observations, cluster around the observation time, and
some carry +1 day; that is consistent with a payload regenerated per fetch
rather than a single stale stored item. The ack that should fire after
successful render ought to have drained the item; repeated delivery means
either the ack did not fire, was silently rejected, or the pending content
was regenerated continuously.

Open: where the payload originates (CITT endpoint vs. fork pass-through),
why the ack did not drain it, and why only this workspace was affected.

Possibly related (different mechanism, not a board wake): on 2026-08-22 a
Lazarus `scan_ship` tool result was injected into a non-kernel conversation
of the same workspace without any tool call.

### Affected Areas

- `gui/src/hooks/useBoardWatch.ts`
- `gui/src/util/boardInjection.ts`
- session board state (`BoardSessionState`)
- `core/protocol/passThrough.ts` (board endpoints)
- CITT-side `board/pending` / `board/ack` (external to this repository)
