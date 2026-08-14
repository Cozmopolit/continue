# Board Auto-Topic-Injection (Fork Side)

**Status:** Implementiert
**Date:** 2026-08-14

## Problem / Motivation

Agents running under Continue (e.g. the coding agent "delta") coordinate with
agents on other instances via the MsgBoard (GitHub-Issues-backed,
`CITT.Plugin.MsgBoard`). Today board messages reach an agent only when it
actively polls with the LLM tools (`msg_*`) — the agent must already know that
something arrived.

Desired behavior: an agent **subscribes** to board topics, and new messages are
**injected into its context at run start** (first turn of a new chat session),
the same way `AGENTS.md` is injected.

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
                                                                   // oldest first
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
- GUI: run-start injection in `streamNormalInput`, block held in session state,
  appended to the system message every turn (AGENTS.md pattern)

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

- Fetch happens on the **first turn of a new session**, guarded by an
  explicit session-state flag (`boardInjectionConsumed`), NOT by history
  shape: `submitEditorAndInitAtIndex` pre-creates an empty assistant
  placeholder before `streamNormalInput` runs, so a "no assistant message
  yet" check would never fire. The attempt is marked once per session even
  when the fetch fails or returns nothing. The rendered block is stored in
  session state and passed as an additional always-apply rule into
  `constructMessages` on every turn — exactly the AGENTS.md behavior,
  including applied-rules visibility.
- No re-fetch within a session; a new session fetches again.

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
new session, 1st turn (streamNormalInput):
  GUI -> core   "board/consumePending" {}
                core: no state file / no topics -> {messages: []} (no RPC)
                core: resolve board-capable connected CITT server
                      callMethod("board/pending", {topics, sinceId},
                                 schema, {timeout: 5000})
                      advance cursor = max(injected ids)
  GUI <- core   {messages, latestByTopic, omitted?, warning?}
  GUI: render block -> sessionSlice.boardInjection
       every turn: constructMessages(..., [...config.rules, boardRule])

LLM tools (core-side impls, read/write .continue/board-state.json):
  board_subscribe {handle, topic}     creates/extends state; init-mode RPC
                                      only when cursor not yet bootstrapped
  board_unsubscribe {topic}
  board_subscriptions {}              -> {handle, topics, cursor}
```

### Behavior rules

- **Best effort, never run-blocking:** any failure (no CITT server connected,
  missing capability, timeout 5 s, RPC error, missing state file) => skip
  injection with a console warning; the run starts.
- **Handle identity:** passed explicitly by the LLM (session context /
  AGENTS.md, per board convention — never inferred). Conflict against an
  existing handle in the state file => visible tool error.
- **Block format** (rendered by the fork, markdown, per topic):

```markdown
# MsgBoard — neue Nachrichten (Stand: <fetch timestamp>)

## Topic: <topic>

_[cittmsg] id <id> · from: <from> → to: <to> · re: #<re> · <createdAt>_

<body>

_N weitere Nachrichten (älter als #<oldestOmittedId>) wurden nicht injiziert —
bei Bedarf per msg_list/msg_read nachladen._ (only when omitted present)
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
- **Session resume:** the injection block lives in redux session state; if the
  persistence layer does not carry it across window reloads, consumed messages
  are not re-fetched (cursor already advanced). Accepted for v1.

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
- [x] GUI: `sessionSlice` board-injection state + actions; `streamNormalInput`
      first-turn fetch (once-per-session `boardInjectionConsumed` flag —
      history-shape detection is broken by the pre-created assistant
      placeholder) + block rendering; pass board rule into
      `constructMessages`.
