# Composer File-Context: Repo Files Missing from Selection List

**Status:** Implemented (see `specifications/workspace-filesystem-watcher.md`; tests pending)
**Date:** 2026-08-13

## Problem

Files that exist in the repo regularly cannot be attached as context in the
composer — they simply do not appear in the selection/autocomplete list.

Observed pattern (not yet systematically verified):

- Occurs **massively with newly created, not-yet-committed files**.
- Possibly _only_ there — edited-but-tracked files have not been observed
  carefully enough to say either way.

## Hypothesis

The filesystem watcher (indexing/file-list provider behind the composer
file picker) has a problem with new and/or edited files — the list it
serves appears to be stale (e.g. snapshot-based, index not refreshed on
uncommitted changes).

## Analysis

Recon performed 2026-08-13 (read-only, no code changes).

### Data path

- GUI: `gui/src/context/SubmenuContextProviders.tsx` requests
  `"context/loadSubmenuItems"` and keeps the result in **in-memory React
  state** (`minisearches`, `fallbackResults`) — no TTL, no store; lives for
  the lifetime of the mounted provider (until webview reload).
- Core handler (`core/core.ts` ~L525) forwards to the provider on **every**
  GUI request — there is **no** core-side result cache for the provider.
- `core/context/providers/FileContextProvider.ts::loadSubmenuItems` →
  `walkDirs()` → `core/indexing/walkDir.ts` → `ide.listDir(...)`
  (extension-side live `vscode.workspace.fs.readDirectory` via
  `ideUtils.readDirectory`, `extensions/vscode/src/VsCodeIde.ts:674`). No
  git dependency anywhere — **untracked/uncommitted status is irrelevant**,
  only directory-listing freshness matters.

### The actual staleness layers (root cause hypotheses, ranked)

1. **No file-system watcher for the workspace.** The picker refresh is
   driven only by VS Code workspace events (`onDidCreateFiles`,
   `onDidDeleteFiles`, `onDidSaveTextDocument` → `files/created|deleted|
changed` in `core/core.ts` L824–905). File creations outside these events
   (external editor, terminal `touch/New-Item`, git switch/checkout, agent
   tool writes) produce **no** event → GUI list stays stale indefinitely.
2. **GUI requests submenu items lazily** (when the provider is used / on
   `refreshSubmenuItems`), so even a clean directory listing only reaches
   the picker when a refresh is triggered. Without an event (see 1) there
   is no trigger.
3. **`walkDirCache` 30 s TTL** (`walkDir.ts` `LIST_DIR_CACHE_TIME = 30_000`)
   — only relevant _after_ a reload was triggered; bounded staleness, not
   the main suspect for "massively missing".
4. **`MAX_SUBMENU_ITEMS = 10_000` + `.slice(-10_000)`** in
   `FileContextProvider` — deterministic capping of the walk order. If the
   workspace walk yields >10k entries (invoked from repo root), directories
   later in walk order are **always missing**, regardless of any watcher.
   Worth checking whether our repo + workspace layout can exceed this in
   the walks invoked from the GUI (open tabs are prepended separately via
   `fallbackResults`, so open files should still show up).

### Verified facts (verification points resolved 2026-08-13)

1. **Hypothesis 4 (10k cap) — practically refuted for this repo.**
   `walkDir` always applies `DEFAULT_IGNORES` (`core/indexing/ignore.ts`):
   `node_modules/`, `dist/`, `build/`, `out/`, `bin/`, `.git/` are all
   excluded. Repo has ~3.1k tracked files (git) and only ~3 untracked —
   expected walk result ≈ ~3k entries, far below `MAX_SUBMENU_ITEMS = 10_000`.
   `dev-docs/` matches no ignore pattern. → Cap is not the cause here
   (keep in mind for repos with big generated trees outside the default
   ignore list).

2. **Agent-side file creation fires no VS Code event.** All relevant write
   paths checked (`VsCodeIde.ts:297` `writeFile` = `vscode.workspace.fs.writeFile`;
   edit tools are client-side and end in an editor save → event fires):
   **only editor saves and explorer create/copy fire the events** that drive
   `walkDirCache.invalidate()` + `refreshSubmenuItems`. Files created by
   CITT MCP tools (`file_create`, `run_file_editor`, terminal) are invisible
   until: window/webview reload, an unrelated save triggering a refresh, or
   (for the directory listing only) the 30 s TTL of `walkDirCache` — **but**
   the GUI refetches submenu items only on `refreshSubmenuItems` or when a
   provider is newly added, so the TTL alone does **not** heal the picker.
   → Primary cause confirmed: **missing event source**, like AGENTS.md.

3. **GUI refetch triggers (complete set):** initial config load (new provider
   titles), `refreshSubmenuItems` webview message, webview reload. No polling,
   no session-based refresh. Opening the '@' menu does **not** refetch — it
   only queries the in-memory `minisearches` index.
   → Once stale, the list is stale for the whole webview lifetime.

4. **Open tabs partially mask the bug:** `lastOpenFilesRef`/`fallbackResults`
   prepends currently open files to the 'file' provider results. Newly
   created files that the agent opened in an editor therefore _can_ appear —
   consistent with your observation that the problem feels erratic.

### Root cause statement (final)

Same defect class as `agents-md-stale-injection.md`:
(a) the picker's file list is built from a **cached snapshot** (GUI-side
`minisearches`), refreshed only by explicit `refreshSubmenuItems` signals, and
(b) those signals are only emitted from VS Code workspace events — any file
creation outside the editor/explorer (agent MCP tools, terminal, git
operations) never triggers a refresh. The 30 s `walkDirCache` TTL caps only
the _core-side_ staleness and is irrelevant as long as the GUI never
refetches.

### Fix

Solution decided and specced — see
`dev-docs/specifications/workspace-filesystem-watcher.md`. Decisions taken:
general workspace watcher (covers create+change+delete), CITT-side
self-notification **rejected** (coupling), '@'-menu refetch **deferred**
(revisit only if stale lists observed after the watcher ships).

## Related

- `agents-md-stale-injection.md` — first defect, same root cause
  (stale event source), same fix.
- `specifications/workspace-filesystem-watcher.md` — the fix spec.
