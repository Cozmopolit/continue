# Workspace-Scoped Session History

**Status:** Implementiert
**Date:** 2026-08-14

## Problem / Motivation

Continue stores all chat sessions globally in `~/.continue/sessions/` and the
GUI history lists sessions from **every** workspace. With several VS Code
windows open on different repos the history becomes unusable: it is no longer
recognizable which conversation belongs to which workspace.

Goal: each workspace window lists only the sessions that were created in that
workspace.

## Scope

- GUI only: session **listing** becomes workspace-scoped.
- New UI escape hatch: a per-window "Show all workspaces" toggle on the
  History page.

**Out of Scope:**

- Core/storage changes — `HistoryManager` already supports everything needed
  (see Analysis). Session files stay in the global directory.
- Scoping `history/clear` ("Clear chats" still deletes all sessions globally —
  pre-existing behavior).
- Retroactive repair of untagged sessions (none exist in practice; sessions
  from surfaces without `window.workspacePaths`, e.g. CLI, remain visible via
  the "all workspaces" toggle).
- `extensions/cli`, JetBrains-specific behavior (the shared GUI mechanism
  works identically wherever `window.workspacePaths` is populated).

## Analysis

All building blocks already exist and are verified against the code:

- **Tagging on save:** the GUI save thunk already writes
  `workspaceDirectory: window.workspacePaths?.[0] || ""` into every saved
  session (`saveCurrentSession` in `gui/src/redux/thunks/session.ts`).
  `window.workspacePaths` is injected by the VS Code webview provider as
  `workspaceFolders.map(f => f.uri.toString())` (file URIs); both window
  globals are declared in `core/index.d.ts`.
- **Filtering in core:** `HistoryManager.list(ListHistoryOptions)` filters
  case-insensitively by `workspaceDirectory` (`core/util/history.ts`, covered
  by the existing "Workspace directory filtering" suite in
  `core/util/history.test.ts`). The `history/list` protocol message already
  carries `ListHistoryOptions` and `core/core.ts` passes it through.
- **The only gap:** the GUI listing thunk `refreshSessionMetadata`
  (`gui/src/redux/thunks/session.ts`) requests `history/list` with
  `{ limit, offset }` only — never passing `workspaceDirectory`. All UI
  listing flows through this single thunk (call sites: initial refresh in
  `ParallelListeners.tsx`, `deleteSession`, `updateSession`, History
  "Clear chats"); the sole list consumer is `allSessionMetadata`, rendered by
  the History page (`gui/src/components/History/index.tsx`).
- **No migration needed:** sessions are matched by exact (case-insensitive)
  URI equality between the stored tag and the querying window's
  `window.workspacePaths[0]` — same source on both sides. Empirically, the
  entire existing session backlog is already tagged.
- Multi-root workspaces: save and list both use `workspacePaths[0]` —
  consistent. `history/load` stays workspace-agnostic (deep links keep
  working); opening and saving a session in another window retags it to that
  window's workspace (acceptable, only reachable via the toggle).

## Solution

```
GUI listing (refreshSessionMetadata thunk):
  effective allWorkspaces = explicit arg ?? persisted per-window preference
                            (localStorage historyAllWorkspaces_<window.windowId>)
  if effective allWorkspaces or window.workspacePaths?.[0] is empty:
      history/list { limit, offset }          (today's behavior)
  else:
      history/list { limit, offset, workspaceDirectory: workspacePaths[0] }

History page:
  "Show all workspaces" ToggleSwitch below the search input
  (rendered only when window.workspacePaths is non-empty)
  state: localStorage key historyAllWorkspaces_<window.windowId>
  on toggle: persist + re-fetch
```

Behavioral notes:

- Scoping applies automatically at every existing call site — no call-site
  changes; the filter lives inside the thunk. Because the thunk reads the
  persisted preference on every refresh, the initial one-shot fetch
  (ParallelListeners) honors it too — no mount-time re-fetch and no race in
  the History page.
- Windows without workspace folders (`window.workspacePaths` empty) and
  surfaces where the `window.workspacePaths` global does not exist at all
  (e.g. CLI) keep today's unfiltered behavior.
- localStorage is keyed by `window.windowId` so the toggle is per window
  regardless of webview storage sharing; the key follows the
  `LocalStorageTypes` template-key pattern (`inputHistory_${string}`
  precedent).

## Implementation Checklist

- [x] `gui/src/redux/thunks/session.ts`: extend the `refreshSessionMetadata`
      arg type by optional `allWorkspaces?: boolean`; `workspaceDirectory:
    window.workspacePaths?.[0]` is included in the `history/list` request
      only when the _effective_ allWorkspaces value is false — explicit arg,
      falling back to the persisted per-window preference
      (`historyAllWorkspaces_<window.windowId>` in localStorage) when the
      arg is omitted (an explicit `false` therefore keeps scoping even with
      a persisted `true`).
- [x] `gui/src/util/localStorage.ts`: add typed template key
      `[key: \`historyAllWorkspaces\_${string}\`]: boolean`.
- [x] `gui/src/components/History/index.tsx`: add the "Show all workspaces"
      `ToggleSwitch` (`components/gui/Switch.tsx`) below the search input,
      rendered only when `window.workspacePaths?.length` is truthy; state
      initialized from localStorage (`historyAllWorkspaces_${window.windowId}`),
      persisted on change; dispatch `refreshSessionMetadata` with the new
      toggle state on change.
- [x] `gui/src/pages/history/historyWorkspaceScoping.test.tsx`: page-level
      coverage — default scoping, toggle visibility by `workspacePaths`,
      toggle click persists + re-fetches unscoped, persisted preference.
- [x] `gui/src/redux/thunks/session.test.ts`: thunk-level coverage of the
      scoping matrix — explicit `allWorkspaces` true/false (explicit `false`
      wins over a persisted `true`), persisted-preference fallback, and the
      empty-`workspacePaths` fallback (CodeRabbit follow-up).
