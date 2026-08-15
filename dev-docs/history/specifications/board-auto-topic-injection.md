# Board Auto-Topic-Injection (Fork Side)

**Status:** Implementiert (Revision 2: LLM-Call-Level-Consumption)
**Date:** 2026-08-14

### Revision 3 (2026-08-14, erster Live-Test nach Incident-Fix)

Live-Test-Befund: CITT serialisiert `re` als JSON `null` für Nachrichten,
die keine Reply sind (unbefüllte DB-Spalte). Die Fork-Zod-Schema-Validierung
(`re: z.number().optional()`) verwarf darauf die **gesamte** `board/pending`-
Antwort — jede Injection starb lautlos im catch-all (Cursor avancierte nie,
kein Block; sichtbar nur als `Board injection skipped`-Warn in der
Webview-Konsole). Fix: `re: z.number().nullish()` mit Normalisierung nach
`undefined` (gleiche Klasse wie `contextLimit` in `ProxyEndpointSchema`);
Renderer prüft `!= null`. Regressionstests in `MCPConnection.vitest.ts`
(board-gateway-Block, Mock parst das übergebene Schema wie der echte
SDK-`Client#request`). Der Contract selbst ist unverändert — `re` bleibt
Teil des Message-Envelopes, die Nullability ist ein Wire-Format-Detail.

### Revision 2 (2026-08-14, nach erstem Live-Test)

Revision 1 injizierte Board-Mail nur im ersten Turn einer neuen Session
(Once-per-Session-Flag `boardInjectionConsumed`). Der erste Live-Test zeigte
den Konstruktionsfehler: Ein Mid-Session-Subscribe blieb bis zur nächsten
Session wirkungslos; Agent-zu-Agent-Austausch innerhalb einer laufenden
Session war passiv unsichtbar. User-Entscheidung: Consumption auf
**LLM-Call-Level** (Agents müssen Board-Mail ohne User-Input empfangen),
gedrosselt per **TTL 15 s**. Der Contract (Interface) bleibt unverändert —
`board/pending {topics, sinceId}` ist bereits inkrementell; nur die
Abruffrequenz der Fork-Seite steigt.

## Problem / Motivation

Agents running under Continue (e.g. the coding agent "delta") coordinate with
agents on other instances via the MsgBoard (GitHub-Issues-backed,
`CITT.Plugin.MsgBoard`). Today board messages reach an agent only when it
actively polls with the LLM tools (`msg_*`) — the agent must already know that
something arrived.

Desired behavior: an agent **subscribes** to board topics, and new messages are
**injected into its context as they arrive — checked on every LLM call (throttled
by a short TTL), so agents can exchange board messages within a live session
without user input**. The rendered block participates in the system message like
`AGENTS.md`.

The cross-instance contract was negotiated with `home-citt` (CITT side) in the
MsgBoard topic `auto-topic-injection` and closed as **contract v1.2** (closing
declaration `5287685603`; shared memory: `auto-topic-injection-kontrakt-v1_2-final`).
Key outcome after a user veto against a DB layer: **CITT is a stateless board
gateway**; all subscription/cursor state lives in the fork. This spec covers the
fork side only.

### Agreed contract (interface, fixed — do not change unilaterally)

```
proxy/capabilities response
  + optional "board": true        (piggyback; older forks strip the key)

board/pending { topics: string[], sinceId?: number }
  -> {
       messages: [{ topic, id, from, to, re, createdAt, body }],  // full text,
                                                                   // oldest first;
                                                                   // wire detail: `re` is JSON
                                                                   // null for non-replies
                                                                   // (fork schema normalizes
                                                                   // null -> undefined, rev 3)
       latestByTopic: Record<topic, id>,  // true highest comment id per topic,
                                          // cap-independent; absent = topic
                                          // does not exist (unambiguous, see
                                          // emptyTopics)
       emptyTopics?: string[],            // existing topics without comments
                                          // (additive annex 5291256996)
       omitted?: { count, oldestOmittedId },
       warning?: string
     }
  - server-side cap: 20 messages / ~40k chars; overflow -> newest + omitted
  - sinceId OMITTED = init mode: no messages, only latestByTopic/emptyTopics
  - rate limits / HTTP errors -> JSON-RPC error (no auto-retry)
```

GitHub comment ids are globally monotonic (verified by both sides), therefore
**one cursor per workspace** across all topics is sufficient.

## Scope

Fork-side changes only:

- Board state file `.continue/board-state.json` (`{handle, topics, cursor}`)
- Built-in LLM tools `board_subscribe` / `board_unsubscribe` /
  `board_subscriptions` (core-side, no CITT roundtrip except cursor bootstrap)
- Transport: `MCPConnection` board capability + typed `board/pending` wrapper
- Core protocol message `board/consumePending` (fetch + cursor advance)
- GUI: TTL-gated per-LLM-call consumption in `streamNormalInput`, accumulated
  block held in session state, appended to the system message every turn
  (AGENTS.md pattern)

**Out of Scope:**

- CITT side (implemented by home-citt: single `board/pending` handler,
  `board: bool` in `proxy/capabilities`, no DB layer, no tools)
- `extensions/cli` (own stack; shared GUI/core paths cover VS Code + JetBrains)
- GUI/UI for subscription management, live push, multi-window coordination

## Analysis

### Run start is not config load

Rules (incl. `AGENTS.md`) are loaded at **config-load** time and cached per
window/profile (`ProfileLifecycleManager.savedConfigResult`); a new chat does
NOT reload config (verified incident: `agents-md-stale-injection.md`). A hook
at rules-load time would therefore be stale by design. The real per-run seam is
the turn path: `gui/src/redux/thunks/streamNormalInput.ts` builds the system
message and calls `constructMessages(history, systemMessage, config.rules, ...)`
on every turn; `AGENTS.md` participates as a rule with `alwaysApply: true`.
"Run" = chat session (multiple turns).

### Consequences

- Consumption runs at the start of **every LLM call**, throttled by a TTL:
  `streamNormalInput` is the seam for every model call — the first user turn
  and every tool-loop iteration recurse into it
  (`streamResponseAfterToolCall` → `streamNormalInput({depth+1})`) and rebuild
  the system message via `constructMessages` on each pass. A session-state
  timestamp (`lastBoardFetchAt`) gates the fetch: consume when never fetched
  or when the last fetch is ≥ TTL (15 s) old. The fetch is awaited and
  best-effort; the rendered block is included in the same call's system
  message.
- The once-per-session flag of revision 1 (`boardInjectionConsumed`) is
  removed. It institutionalized the blind spot the feature was meant to close:
  a mid-session subscribe only took effect in the next session, and live
  agent-to-agent exchange within a session stayed invisible without active
  `msg_*` polling. The flag's original purpose — first-turn detection — is
  obsolete: TTL gating needs no history-shape detection at all (which was
  unreliable anyway, since `submitEditorAndInitAtIndex` pre-creates an empty
  assistant placeholder).
- Consumed messages **accumulate** in session state for the rest of the
  session (bounded window, see behavior rules), so an exchange stays visible
  while the agent works on it. The block is re-rendered from the accumulated
  list whenever a fetch runs and re-appended to the system message every turn
  — exactly the AGENTS.md behavior, including applied-rules visibility.
  (Revision 1 replaced the block on each fetch — wrong for accumulation: a
  consumed question would drop out of context before the agent answers it.)
- First fetch of a session = backlog fetch ("from now on" cursor semantics
  unchanged): a new session shows messages that arrived since the last cursor
  advance on its first LLM call.
- Rejected alternative: fire-and-forget background fetch (zero latency impact,
  but messages only reach the NEXT LLM call and in-flight dedup adds
  concurrency complexity). Accepted: awaited fetch bounded by the existing
  5 s RPC timeout; worst case one stalled LLM call per TTL window when the
  gateway hangs — rare, bounded, best-effort.

### Cursor semantics (fork-owned)

- State file starts absent => feature inactive (no handle, no fetch).
- First `board_subscribe` creates the file and performs one **init-mode**
  `board/pending` call (no `sinceId`) to set `cursor = max(latestByTopic)` —
  "from now on" semantics without a backlog dump.
- Topics added later need **no probe call**: the global cursor filters them to
  `id > cursor` automatically ("from now on" emerges).
- After consuming messages: `cursor = max(injected ids)` (contract-conform:
  messages cut by the cap stay reachable via `msg_list`/`msg_read`; the
  injection block must surface the `omitted` note so the agent knows).
- at-least-once: cursor advances only after successful fetch/injection;
  duplicates are id-identifiable. Accepted window: crash between fetch and
  cursor write => duplicate on next run.

### Transport

`MCPConnection.callMethod(method, params, zodSchema, {signal, timeout})` is the
existing generic seam (used by `proxy/*`). Capability detection already runs in
`connectClient()` via `fetchProxyData()` (`proxy/capabilities` before status
flips to `connected`); the `board` flag piggybacks on that response. Connection
discovery mirrors `mcpProxyModelDiscovery.collectProxyEndpoints`:
`MCPManagerSingleton.connections`, `status === "connected"` + capability.

## Solution

```
every LLM call (streamNormalInput, incl. tool-loop recursion):
  if never fetched or now - lastBoardFetchAt >= TTL (15 s):
    GUI -> core   "board/consumePending" {}
                  core: no state file / no topics -> {messages: []} (no RPC)
                  core: resolve board-capable connected CITT server
                        callMethod("board/pending", {topics, sinceId},
                                   schema, {timeout: 5000})
                        advance cursor = max(injected ids)
    GUI <- core   {messages, latestByTopic, omitted?, warning?}
    GUI: append messages to sessionSlice.board.messages (capped window)
    note: board.lastFetchAt is the ATTEMPT stamp, set BEFORE the awaited RPC
          (setBoardFetchAttempted) — a failed/hanging fetch must not retry
          on the very next LLM call (Doku-Korrektur 2026-08-15)
  every call: render block from boardMessages -> boardRule (always-apply)
              constructMessages(..., [...config.rules, boardRule])

LLM tools (core-side impls, read/write .continue/board-state.json):
  board_subscribe {handle, topic}     creates/extends state; init-mode RPC
                                      only when cursor not yet bootstrapped
  board_unsubscribe {topic}
  board_subscriptions {}              -> {handle, topics, cursor}
```

### Behavior rules

- **Best effort, never run-blocking:** any failure (no CITT server connected,
  missing capability, timeout 5 s, RPC error) => skip injection with a
  console warning; the run starts. A missing state file (or zero subscribed
  topics) is **not** a failure — the feature is simply inactive: silent
  no-op returning `{messages: []}` without RPC and without warning
  (Doku-Korrektur 2026-08-15, CodeRabbit-Review; matched
  `consumeBoardPending` von Anfang an, inkl. Tests für beide Fälle).
- **Handle identity:** passed explicitly by the LLM (session context /
  AGENTS.md, per board convention — never inferred). Conflict against an
  existing handle in the state file => visible tool error.
- **TTL throttle:** at most one fetch per 15 s per session (constant
  `BOARD_FETCH_TTL_MS` in the GUI). Awaited on the LLM-call critical path;
  the existing 5 s RPC timeout bounds the worst case; failures never block
  the run (best-effort).
- **Session boundary:** `newSession` (with or without payload) and
  `deleteMessage` reset the board state (messages, notes, `lastFetchAt`) —
  a new session always starts with a backlog fetch on its first LLM call.
- **Session window cap:** accumulated `session.board.messages` are capped at
  20 messages / ~40k chars (mirroring the server cap); overflow drops the
  OLDEST messages and is surfaced in the block note. Server-side `omitted`
  counts (cap-truncated at fetch time) are accumulated and surfaced likewise.
  A single message that alone exceeds the char cap is dropped with a
  `tooLargeIds` retrieval note (full text via `msg_read`) instead of blowing
  up the system message every turn.
- **Block format** (rendered by the fork, markdown, per topic):

```markdown
# MsgBoard — neue Nachrichten (Stand: <fetch timestamp>)

## Topic: <topic>

_[cittmsg] id <id> · from: <from> → to: <to> · re: #<re> · <createdAt>_

<body>

_N ältere Nachrichten dieser Session sind nicht mehr im Block (älter als #<oldestKeptId>) — bei Bedarf per msg_list/msg_read nachladen._ (only when
the session window dropped messages)

_M weitere Nachrichten (älter als #<oldestOmittedId>) wurden nicht injiziert —
bei Bedarf per msg_list/msg_read nachladen._ (only when omitted present)

_K Nachricht(en) übersteigen das Session-Fenster (~40k Chars) und wurden
nicht injiziert: #<id>, … — vollständig per msg_read nachladen._ (only when
oversized messages were dropped)
```

- **Multi-window/workspace:** one state file per workspace. Two windows on the
  same workspace share it; concurrent session starts may inject the same
  messages twice (duplicates id-identifiable, cursor = max consolidates).
  Accepted, documented.
- **Concurrent state mutations:** the fetch RPC window is up to 5 s, so
  `consumeBoardPending` reloads the state file before saving: the fresh topic
  list is authoritative, the cursor is consolidated monotonically (max) —
  concurrent subscribe/unsubscribe operations are not overwritten. If the
  file was removed during the RPC, the save is skipped (no resurrection).
- **Session resume:** the block is derived from session-state `boardMessages`;
  if the persistence layer does not carry it across window reloads, consumed
  messages are not re-fetched (cursor already advanced) — the block simply
  starts empty again. Accepted for v1.

## Implementation Checklist

- [x] `core/context/mcp/MCPConnection.ts`: extend capabilities Zod schema by
      optional `board`; store/expose board capability; add `boardPending()`
      wrapper with result schema and 5 s timeout.
- [x] New `core/board/boardState.ts`: read/write
      `.continue/board-state.json`, handle/topic validation, cursor rules
      (init/advance), pure where possible.
- [x] Built-in tools: definitions + core implementations for
      `board_subscribe`, `board_unsubscribe`, `board_subscriptions`;
      register in `core/tools/builtIn.ts`.
- [x] Protocol: `board/consumePending` in `core/protocol/core.ts`; handler in
      `core/core.ts` (connection discovery, state read, RPC, cursor advance).
- [x] GUI (Revision 2): `sessionSlice` board state as
      `session.board: BoardSessionState` (`messages`, `droppedCount`,
      `omittedTotal`, `omittedOldestId`, `tooLargeIds`, `lastFetchAt`)
      replacing `boardInjectionBlock`/`boardInjectionConsumed`, reset in
      `newSession` (both branches) and `deleteMessage`; actions
      `setBoardFetchAttempted`/`appendBoardMessages`; `streamNormalInput`
      TTL-gated consumption on every LLM call with fresh-state gate read;
      `util/boardInjection.ts` renders from the accumulated list incl.
      window-cap, oversized-drop and omitted notes; board rule passed into
      `constructMessages` every call.
