# Always Boot Into a New Chat (Workspace-Aware Resume)

**Status:** Implementiert
**Date:** 2026-08-15

## Problem / Motivation

Today each window auto-restores a chat on boot from a **single global**
redux-persist slot (`persist:root` → `session.id` / `session.lastSessionId`,
no workspace component): `ParallelListeners.tsx` computes
`initialSessionId = sessionId || lastSessionId` and loads it via
`history/load`. With several windows/workspaces this pointer is
workspace-blind and shared (last writer wins), so a window may reopen a chat
from a different repository — and users who want to start fresh always get an
old conversation loaded first.

Since the history list is workspace-scoped and newest-first
(`workspace-scoped-session-history.md`), the last chat of the current
workspace is always the **top entry** of the list. Chosen design (user
decision): **always boot into a fresh chat**; resuming the last chat of this
workspace is one explicit click.

## Scope

- GUI boot path: always start in a fresh session.
- `loadLastSession`: workspace-aware resume — powers both the "Last Session"
  button (shown on an empty chat) and the delete-current-session flow.
- Tab bar reset on boot (follow-up): tabs are per-window-lifetime UI state,
  not persisted; boot leaves exactly one fresh tab. Without the reset,
  `TabBar.handleSessionChange` saw the unknown fresh session id next to a
  bound active tab on every boot and appended one tab per reload
  (persisted tabs accumulated — the observed 13-tab bug).

**Out of Scope:**

- Per-workspace auto-restore — explicitly rejected alternative; fresh boot +
  scoped history replaces it.
- Edit-mode continuation across restarts: edit state is still restored by
  redux-persist but no longer re-attached to the previous session; that
  session remains reachable via history. Accepted.
- Storage-layer changes; the `persist:root` slot stays untouched
  (`lastSessionId` still gates the button's visibility, harmless).
- Non-VS-Code surfaces beyond the shared GUI code path.

## Analysis

- Boot: `initialSessionId` comes from redux-persist (`store.ts`, key "root",
  fields `id`/`lastSessionId`/`title`/`mode`); VS Code webview localStorage
  is one partition per extension installation, so the slot is shared across
  windows and can never represent "last chat per workspace".
- `loadLastSession` today loads that same global pointer (`history/load` by
  id, no workspace filter).
- Core side is ready: `history/list` accepts `workspaceDirectory`
  (case-insensitive filter, `core/util/history.ts`) and returns newest first;
  `core/core.ts` passes the options through.

## Solution

```
Boot (ParallelListeners.initialLoadConfig):
  replace  loadSession(initialSessionId)
  with     dispatch(newSession())
           dispatch(setTabs([createFreshTab()]))
  -> fresh session id; the old chat stays on disk and is the top entry of
     the workspace-scoped history list. newSession() also records the old id
     as lastSessionId, keeping the "Last Session" button visible.
     The tab reset leaves a single unassigned tab; the TabBar session
     listener binds the fresh session to it ("active tab has no session ID"
     branch). Tabs are no longer persisted: `createFilter("tabs", [])` in
     `store.ts` (same pattern as `config`/`indexing`) — the empty whitelist
     also discards legacy stored tabs on rehydrate.

Resume (loadLastSession, rewritten):
  history/list { workspaceDirectory: window.workspacePaths?.[0] || undefined,
                 limit: 2 }
  pick first entry with sessionId != current redux session id
  found    -> history/load it, dispatch newSession(session),
              restore session chat model (existing behavior)
  not found-> dispatch(newSession())   (stay on / return to fresh chat)
```

Behavior rules:

- Windows without workspace folders pass `workspaceDirectory: undefined` →
  unfiltered list → legacy global behavior (nothing to scope against).
- Excluding the current redux session id makes the delete-current-session
  flow correct without reordering `deleteSession` (the deleted file still
  exists on disk at query time); for the empty-chat button the current id is
  unsaved and never in the list, so the exclusion is a no-op there.
- `limit: 2` guarantees an alternative exists when the newest entry is the
  excluded one.
- Consumers stay unchanged: "Last Session" button in `Chat.tsx` (now
  1-click, workspace-correct resume) and `deleteSession`.

## Implementation Checklist

- [x] `gui/src/hooks/ParallelListeners.tsx`: drop the `lastSessionId`
      selector and `initialSessionId`; boot dispatches `newSession()` instead
      of `loadSession`; imports adjusted (`newSession` from sessionSlice,
      `loadSession` removed, `useState` removed), useEffect deps updated.
- [x] `gui/src/redux/thunks/session.ts`: rewrite `loadLastSession` to fetch
      the newest session of this workspace via `history/list` (limit 2,
      exclude current session id) and load it, with `newSession()` fallback;
      remove the stale commented-out block.
- [x] `gui/src/redux/slices/tabsSlice.ts`: `createFreshTab()` factory shared
      by `INITIAL_TABS_STATE` and the boot reset.
- [x] `gui/src/hooks/ParallelListeners.tsx`: boot dispatches
      `setTabs([createFreshTab()])` right after `newSession()`.
- [x] `gui/src/redux/store.ts`: tabs persist filter switched to an empty
      whitelist (no tab persistence, legacy stored tabs discarded).
- [x] `gui/src/hooks/freshBootSingleTab.test.tsx`: regression test — boot
      leaves exactly one tab, bound to the fresh session.
