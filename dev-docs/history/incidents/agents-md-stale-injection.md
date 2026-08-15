# AGENTS.md: Stale Version Injected in New Chat

**Status:** Resolved (workspace-filesystem-watcher.md; tests green 2026-08-15)
**Date:** 2026-08-13

## Problem

Sequence observed (in another chat session):

1. `AGENTS.md` was edited (changes not committed).
2. A new chat was started.
3. The new chat was injected with the **outdated** version of `AGENTS.md` — not the current edited version from disk.

The system prompt context therefore does not reflect uncommitted working-tree changes to `AGENTS.md`. Where the injected copy comes from (cached snapshot, committed HEAD version, packaged rules copy, etc.) has not been investigated.

## Analysis

Recon performed 2026-08-13 (read-only, no code changes).

### Ingestion path (where the injected AGENTS.md copy comes from)

- `core/config/markdown/loadMarkdownRules.ts` reads `<workspaceRoot>/AGENTS.md`
  (`SUPPORTED_AGENT_FILES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"]`) via
  `ide.readFile(...)` — i.e. always the **live working-tree file from disk**,
  never the committed git HEAD. There is **no snapshot or packaged copy** of
  AGENTS.md anywhere in this chain.
- The rule is added with `source: "agentFile"`, `alwaysApply: true`, and
  merged into the system message by
  `core/llm/rules/getSystemMessageWithRules.ts`.

### Caching / invalidation — root cause hypothesis

The loaded rules are part of the full `ContinueConfig`, cached **per profile**
in `core/config/ProfileLifecycleManager.ts` (`savedConfigResult`). A plain
"new chat" does **not** reload the config — it just consumes the cached rules.
Therefore the observed staleness = **missing config reload between edit and
new chat**, not a stale file copy.

Invalidation chain for a save **inside the VS Code editor** exists and looks
correct: `onDidSaveTextDocument` → `files/changed` → `isContinueConfigRelatedUri`
(matches `*/AGENTS.md`) → `ConfigHandler.reloadConfig(...)` → cache cleared →
next `loadConfig` re-reads AGENTS.md from disk (`core/core.ts`, handlers
`files/changed` ~L824, `files/created`/~L844, `files/deleted` ~L875).

Gaps that match the incident (all leave `savedConfigResult` stale until a
manual reload / profile switch / extension-host restart):

1. **No file-system watcher for workspace AGENTS.md.** The only `fs.watch`/
   `watchFile` registrations cover the _global_ config files and
   `<continue-global>/rules` (`extensions/vscode/src/extension/VsCodeExtension.ts`
   ~L419–460). External edits on disk (other editor, `run_file_editor` MCP
   tool, git operations) produce **no** `files/changed` event and no reload.
2. **Edits made through Continue's own edit tools write via `ide.writeFile`
   but are not reported back through `files/changed`** (to be confirmed for
   the concrete tool path used in the incident).
3. The incident context heavily suggests the edit was applied by the coding
   agent **not via the VS Code editor save path** — which ticks exactly the
   un-watched boxes above.

### Verified facts (verification points resolved 2026-08-13)

1. **Does a "new chat" force a config reload? — No.** `newSession` in the GUI
   (`gui/src/redux/slices/sessionSlice.ts`) only clears local session state;
   it sends no config/submenu requests. Config is loaded once per
   window/profile and cached in `ProfileLifecycleManager.savedConfigResult`.
   → Every un-invalidated AGENTS.md edit stays invisible for **all**
   subsequent sessions in that window until some `reloadConfig` trigger fires.

2. **Which write paths fire `files/changed`/reload and which don't:**

   | Write path                                                                                                          | Fires VS Code events?                                                                                                                                                                            | Config reload for AGENTS.md?                                                                              |
   | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
   | VS Code editor save                                                                                                 | `onDidSaveTextDocument`                                                                                                                                                                          | ✅ yes                                                                                                    |
   | VS Code explorer create/copy                                                                                        | `onDidCreateFiles`                                                                                                                                                                               | ✅ yes                                                                                                    |
   | Continue built-in edit tools (`edit_existing_file`, `single_find_and_replace`, `multi_edit`)                        | These are **client tools** (`CLIENT_TOOLS_IMPLS` in `core/tools/builtIn.ts`): executed GUI-side via `applyToFile`/`overwriteFile` → applied in an editor → saved there → `onDidSaveTextDocument` | ✅ yes (indirectly, via editor save)                                                                      |
   | Continue `create_new_file` tool (`core/tools/implementations/createNewFile.ts`) — not part of our CITT tool surface | `writeFile` + `openFile` + `saveFile` (file opened in editor, then saved)                                                                                                                        | ✅ yes (via editor save); but **no** `refreshSubmenuItems` for the picker                                 |
   | Continue `create_rule_block` tool (`core/tools/implementations/createRuleBlock.ts`) — part of our base tool surface | `writeFile` + `openFile`, **no `saveFile`** (disk write travels the direct-write path, not an editor save)                                                                                       | ❌ no — same gap class as direct `ide.writeFile`, but writes rule files (`.continue/rules/*.md`) directly |
   | **`ide.writeFile` direct** (`VsCodeIde.writeFile` = `vscode.workspace.fs.writeFile`, VsCodeIde.ts:297)              | ❌ no (not an open-document save, not `workspace.applyEdit`)                                                                                                                                     | ❌ no                                                                                                     |
   | **`run_file_editor` / `file_create` / `file_replace_pattern` (our CITT MCP tools)**                                 | ❌ no — they write directly to disk out-of-process; Continue never hears about it                                                                                                                | ❌ no ← **the incident path**                                                                             |
   | **External processes** (terminal, git switches, other editors)                                                      | ❌ no VS Code event; `fs.watchFile` only covers global config paths                                                                                                                              | ❌ no                                                                                                     |

3. **No additional cache below `ProfileLifecycleManager`** for rule content:
   `doLoadConfig` → `loadMarkdownRules` is the only read path; the GUI shows
   the serialized config from the same load, no second source.

4. **Relevant quirk found:** `onDidSaveTextDocument` triggers even for
   non-dirty "saves" only if VS Code actually dispatches a save; a pure
   external change with an already-open editor does **not** trigger it
   (VS Code reloads the document silently instead). External edits stay
   invisible until the next trigger.

### Root cause statement (final)

The stale AGENTS.md injection is the compound of:
(a) config rules cached per-window (`savedConfigResult`), sessions reuse the
cache, and
(b) no file-system watcher plus no own write-path notification — any edit
that does not travel through a VS Code editor save (agent MCP tools like
`run_file_editor`, `file_create`; external processes) never invalidates the
cache.

### Fix

Solution decided and specced — see
`workspace-filesystem-watcher.md`. Decisions taken:
general workspace watcher (no AGENTS.md special path), CITT-side
self-notification **rejected** (coupling), chat-start re-stat **deferred**.

## Related

- `composer-file-context-stale-list.md` — second defect, same root cause
  (stale event source), same fix.
- `workspace-filesystem-watcher.md` — the fix spec.
