# Prompt Logging Opt-In (promptLogs off by default)

**Status:** Implemented
**Last Updated:** 2026-07-25

## 1. Problem

Stock Continue attaches `promptLogs?: PromptLog[]` to every assistant history
item (reducer `addPromptCompletionPair` in
`gui/src/redux/slices/sessionSlice.ts`, dispatched once per LLM call from
`gui/src/redux/thunks/streamNormalInput.ts`). Each `PromptLog` contains the
**fully rendered prompt** of that call — i.e. the entire conversation so far,
including all tool outputs.

Measured on a real session (2026-07-25, 368 history items):

| Component                                               | Size            |
| ------------------------------------------------------- | --------------- |
| `promptLogs` (113 entries)                              | 66.2 MB (~94 %) |
| toolCallStates + thinking + tool results + visible text | ~2.4 MB         |
| **Total session file**                                  | **72 MB**       |

Growth is quadratic: in agent loops every LLM round re-sends the whole
history, and each of those prompts is stored verbatim on the history item.
Costs:

- **Disk:** `~/.continue/sessions/` had accumulated 1.6 GB across ~100
  sessions (largest single file: 137 MB).
- **Persistence path:** every `history/save` transfers the complete session
  JSON GUI→core over IPC, then stringifies and writes it — with promptLogs
  this is tens of MB per save.
- **RAM:** the Redux store retains all promptLogs of the live session.

The only consumer of `promptLogs` is `FeedbackButtons.tsx` (thumbs up/down →
`devdata/log`). This fork has no use for Continue devdata collection —
audit/logging requirements are served by the CITT platform instead.

## 2. Design

**Opt-in flag `experimental.promptLogging` (boolean, default off)** following
the established shared-config pattern for experimental booleans
(`enableExperimentalTools`, `readResponseTTS`, …):

- `core/config/sharedConfig.ts`: `promptLogging: z.boolean()` in
  `sharedConfigSchema`, salvage handling, and application into
  `configCopy.experimental.promptLogging`.
- Type: `ExperimentalConfig.promptLogging?: boolean` in `core/index.d.ts`
  and `core/config/types.ts`.
- `finalToBrowserConfig` (`core/config/load.ts`) already passes
  `experimental` through to the GUI unchanged — no change needed there.
- Set paths:
  - GUI settings toggle "Prompt logging" in `UserSettingsSection` (same
    pattern as "Enable experimental tools"), persisted to
    `~/.continue/sharedConfig.json`;
  - legacy `config.json` `experimental.promptLogging` also works
    (the experimental block is loaded as-is).

**Guard at the single production site** (`streamNormalInput.ts`):

- flag off (default): neither `dispatch(addPromptCompletionPair(...))` nor
  the `devdata/log` "chatInteraction" posting (which also carries the full
  prompt+completion of every turn) is performed; instead a dedicated
  `endActiveReasoning` reducer is dispatched, preserving the reasoning-end
  side effect that stock upstream couples into `addPromptCompletionPair`
  (this keeps that reducer byte-identical to upstream);
- flag on: current upstream behavior unchanged.

`PromptLog` types and the `history/save` protocol remain untouched (minimal
upstream divergence). The transient per-call `PromptLog` is still delivered
core→GUI at stream end but simply not stored — negligible (one message per
LLM call, not cumulative).

**FeedbackButtons removed.** With promptLogs off by default the thumbs
up/down UI is dead weight (its only payload was promptLogs-based devdata).
Removed: `gui/src/components/FeedbackButtons.tsx` plus its usage in
`gui/src/components/StepContainer/ResponseActions.tsx`. The core-side
`devdata/log` handler stays — other devdata flows (e.g. edit outcome
logging in `editOutcomeLogger.ts`, which reads from `toolCallState`, not
promptLogs) are unaffected.

`prompt.log` file logging (`getPromptLogsPath()`, `LLMLogFormatter`, binary
package) is a separate mechanism and unchanged.

## 3. Behavior

|                                     | flag off (default)   | flag on     |
| ----------------------------------- | -------------------- | ----------- |
| `promptLogs` in session state/files | none                 | as upstream |
| session file size (example thread)  | ~2.4 MB              | ~72 MB      |
| feedback thumbs in UI               | removed (both modes) | removed     |
| `prompt.log` (binary path)          | unchanged            | unchanged   |

Old sessions keep their stored promptLogs (no migration). Stripping them
from old files is an optional cleanup follow-up.

## 4. Files modified

- `core/index.d.ts`, `core/config/types.ts` — `ExperimentalConfig.promptLogging`.
  NOTE: `core/config/types.ts` is one giant template literal
  (``const Types = `...`; export default Types``) — doc comments inside it
  must escape backticks (backslash-backtick), like the existing comments
  there; an unescaped backtick terminates the template and breaks tsc AND
  SWC with a misleading "Expected a semicolon" error at the backtick line.
- `core/config/sharedConfig.ts` — schema field + apply (no salvage entry:
  not security-relevant)
- `gui/src/redux/thunks/streamNormalInput.ts` — guard at dispatch site
  (covers `addPromptCompletionPair` AND the `devdata/log` chatInteraction
  posting); else-branch dispatches `endActiveReasoning`
- `gui/src/redux/slices/sessionSlice.ts` — new `endActiveReasoning` reducer
  (+ export); `addPromptCompletionPair` itself untouched (upstream-identical)
- `gui/src/pages/config/sections/UserSettingsSection.tsx` — settings toggle
  ("Enable prompt logging", Experimental section)
- removed: `gui/src/components/FeedbackButtons.tsx`; usage removed in
  `gui/src/components/StepContainer/ResponseActions.tsx`
- tests: `gui/src/redux/thunks/streamResponse.test.ts` (shared builder
  `getRootStateWithClaude` enables the flag; new flag-off test),
  `streamResponse_toolCalls.test.ts`, `streamResponse_errorHandling.test.ts`
  (both consume the shared builder), `gui/src/redux/slices/sessionSlice.test.ts`
  (`endActiveReasoning` suite)

## 5. Test plan

- Thunk tests asserting `session/addPromptCompletionPair` run with
  `experimental: { promptLogging: true }` from the shared builder — behavior
  identical to upstream.
- New flag-off test: no `addPromptCompletionPair` dispatched,
  `session/endActiveReasoning` dispatched instead, stream completes
  normally.
- `endActiveReasoning` reducer suite (ends active reasoning + endAt, no
  promptLogs, no-op cases).
- Result: 39/39 green across the four touched files; `tsc --noEmit` clean
  for gui and core.
- Manual: chat with flag off → session file stays small and contains no
  `promptLogs` keys; enable the toggle, reload, chat → promptLogs present
  again.

### 5.1 Pre-existing test-baseline repair (same commit)

The three thunk test files were already red at the previous HEAD (verified
via stash baseline): stale expectations from upstream drift, independent of
this feature — `<env>` block appended to the system message, additional IDE
calls (`getWorkspaceDirs`, `chatDescriber/describe`), content shapes,
`symbols/updateFromContextItems/fulfilled` dispatch order, plus a latent
self-recursive spy fallback exposed by the new calls. Expectations were
aligned to the deterministic current behavior (using
`expect.stringContaining`/`expect.objectContaining` where appropriate).

## 6. Upstream divergence & rollback

Small and localized: one `if` in the thunk, one shared-config field, one
settings toggle, one deleted component. Rollback = enable the flag (behavior
equals upstream) or revert the commit. If upstream ever introduces its own
prompt-logging switch, adopt theirs and drop this guard.

## 7. Follow-ups (deliberately not included)

- Cleanup script stripping `promptLogs` from old session files
  (~1.6 GB reclaimable on the dev machine).
- `history/save` payload slimming (strip-on-save) — unnecessary once
  promptLogs are off.
