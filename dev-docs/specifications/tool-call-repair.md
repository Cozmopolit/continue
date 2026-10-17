# Tool-Call Repair (Deterministic)

**Status:** Implementiert
**Date:** 2026-10-17

Sibling spec: `docs/specifications/tool-call-repair.md` in the CITT repo
(server-side counterpart, same draft stage). The rule values in this spec are
**normative and must match the CITT core** (normalization, distance thresholds,
uniqueness/conflict rules, shape rules) so the two implementations cannot
diverge.

## Problem / Motivation

LLMs produce malformed tool calls that fail at argument binding or silently
degrade. Production-observed with the driving model (Kimi K3):

- **missing keys** — transcript forensics 2026-10-17 (session `f71f154a`):
  six serial `compact_conversation` calls emitted with `autoContinue` only,
  the announced `continueMessage` absent in every single one
- **minimally misspelled keys** (CITT production evidence): `content/`
  instead of `content`, camelCase instead of snake_case (`pageId`),
  small typos (`patth`)
- **scalar/array shape mismatches** in both directions

The LLM-retry baseline does NOT self-heal for the driving model: the same
malformed call fails serially (5–6 identical attempts) instead of being
corrected. Without local repair the call is stuck or burns N round-trips
until abort. The failure is systematic — exactly the class deterministic
repair handles best.

Silent-corruption surfaces in the fork today (see Analysis): a typo'd key
never raises an error on any path, it is silently dropped.

## Scope

- Deterministic pre-execution conformance check (trigger classifier) for
  every generated tool call (built-in, client-executed, MCP, HTTP)
- Deterministic parameter-key repair (normalized comparison + edit distance
  with a uniqueness rule)
- Deterministic scalar/array shape normalization (wrap/unwrap)
- Single repair pass per call; integration at the existing args
  preprocess stage (GUI thunk + `tools/preprocessArgs` core handler),
  insertion-only
- Canonicalization: repaired args replace the call's args in session state
  so policy evaluation, client impls, core re-parse and the transcript dump
  all operate on the repaired form
- Feedback surfacing to the model (repair notes / unknown-key warnings in
  the tool result) — the client-side counterpart of the follow-up the CITT
  spec explicitly defers
- Flag-gated rollout, logging/measurement

**Out of Scope:**

- ML-based repair — discarded; the CITT needle probe (2026-10-16) showed
  the ML alternative invents/corrupts values even on well-formed input.
  Deterministic key-rename never touches values, so value preservation
  holds by construction and no guard is needed.
- Semantic errors (wrong tool chosen, wrong intent) — the LLM's job
- Tool-name typo repair (possible small follow-up: same edit-distance idea
  against `config.tools`; `suggestToolNames` already exists)
- Comma-splitting / -joining transformations (`"a,b"` ↔ `["a","b"]`) — ambiguous
- Malformed-JSON argument parse failures (`safeParseToolCallArgs` returns
  `{}`; related observability: tool-call-args-discard-observability.md)
- Tool calls emitted via the system-message codeblock framework
  (`interceptSystemToolCalls`) — follow-up candidate
- Value-level validation beyond scalar/array shape (formats, patterns,
  ranges) — the impls' job, as today

## Analysis

### Current state (verified 2026-10-17)

No repair and no schema validation exist anywhere in the arg pipeline:

1. **Streaming (GUI):** `addToolCallDeltaToState` assembles the arguments
   string and parses it tolerantly into `parsedArgs` (partial JSON yields
   partial objects). Unknown keys are preserved; nothing checks the tool
   schema.
2. **Preprocess stage:** `streamNormalInput.ts` runs, in order:
   `setToolGenerated` → `preprocessToolCalls` (for **every** generated call;
   the code comment reads "catch invalid args before checking policies") →
   `evaluateToolPolicies` (receives `parsedArgs` **and** `processedArgs`) →
   approval → `callToolById`.
3. **`tools/preprocessArgs` (core):** optional per-tool hook
   (`tool.preprocessArgs`, edit family); its error path already surfaces an
   "Invalid Tool Call" message **to the model**.
4. **Execution args diverge:**
   - client tools (`callClientTool`): `parsedArgs`
   - core tools (`core/tools/callTool.ts`): re-parse of the raw
     `toolCall.function.arguments` via `safeParseToolCallArgs` — which
     returns `{}` on parse failure (silent)
   - MCP (`callToolFromUri`): `coerceArgsToSchema` (re-stringifies objects
     for string-typed params only), then the server binds — CITT's
     `ToolsApp` **silently ignores unknown keys**
   - built-in impls read plain JS properties — unknown keys are silently
     dropped, a typo'd optional parameter produces a _successful_ call
     with default behavior

### Consequences

- Typo'd optional key → silent ignore on **every** path (built-in, client,
  MCP). Worst case produces "successful" calls with unintended defaults.
- Missing/typo'd required key → error round-trip; the driving model
  repeats the identical malformed call (no self-heal, see Problem).
- **Security invariant:** policy evaluation runs on the _emitted_ args —
  a typo'd key hides its value from policy (`comand` instead of `command`
  shows the policy no command at all). Repair must therefore run **before**
  policy evaluation. The preprocess stage already satisfies this ordering.

### Why deterministic (and why no ML)

All observed failure classes are deterministically solvable: slashed keys
and case/style mismatches yield to normalized comparison, small typos to
edit distance against one tool's parameter list (a handful of candidates),
shape mismatches to wrap/unwrap. Key-rename never touches values.

### Why naive approaches fail

- **Repair at execution (`callTool`):** too late — policy already ran on
  unrepaired args (bypass surface), and client-executed tools never pass
  that point.
- **Catch-block repair:** blind to the worst case — silent key drops never
  throw.
- **Do nothing:** serial stuck loops plus silent corruption.

## Solution

### Pipeline

```
tool call generated (parsedArgs complete)
      │
      ▼
ARG REPAIR (new; runs inside the tools/preprocessArgs stage,
            BEFORE tool.preprocessArgs)
  conformance check (missing / unknown / shape)
  against tool.function.parameters (JSON Schema)
      │
      ├─ unknown keys → key repair (rename pass) → re-classify
      ├─ shape mismatches → wrap/unwrap
      ├─ declines / residuals → args untouched (today's path)
      ▼
CANONICALIZE (GUI thunk, only when repair changed anything):
  repaired args REPLACE parsedArgs AND toolCall.function.arguments
  in the ToolCallState; repair events stored on the state
      ▼
policy evaluation (sees repaired args — security invariant holds)
      ▼
approval → execution (client impls read repaired parsedArgs;
  core re-parses the repaired raw string; MCP coercion composes)
      ▼
tool result + one-line repair note (keys only, never values)
```

### ParameterDescriptor derivation

One pure derivation from `tool.function.parameters` (JSON Schema):
parameter name from `properties`, required from `required[]`, isArray from
`type: "array"`. MCP schemas arrive verbatim
(`doLoadConfig.ts`: `parameters: tool.inputSchema`), built-ins carry their
own schemas — one abstraction serves both.

### Trigger Classifier (deterministic)

Derived sets: `missing` (required properties absent), `unknown` (argument
keys that are no exact property key — fork impls read exact JS properties,
so a case mismatch is _unknown_ here and repairable via normalized
comparison), `shape` (scalar vs array-typed). Pure function.

### Key Repair (values never touched)

Each unknown key is evaluated independently.

1. **Normalized comparison:** normalize both sides (lowercase; strip
   `_ - / .` and whitespace). Exact match → rename. Covers `content/` →
   `content`, `pageId` → `page_id`, `suggestedName` → `suggested_name`.
2. **Edit-distance fallback:** Levenshtein over normalized keys against the
   called tool's properties only. Threshold: distance ≤ 1 for normalized
   keys of length ≤ 4, ≤ 2 for length ≥ 5.
3. **Uniqueness rule (safety core):** rename only if exactly ONE candidate
   lies within threshold; ties or multiple candidates → no rename.
4. **Conflict rule:** the target key already exists in the call → no
   rename for that key. Targets are reserved as renames are committed:
   a later unknown key must not rename onto an already-reserved target
   (decline; key and value left unchanged) — otherwise the collision
   would silently drop one of the two values.
5. **Required coverage (acceptance):** handles at minimum `content/` →
   `content`, `pageId` → `page_id`, `patth` → `path`; declines keys without
   a unique near candidate (e.g. `verbose` for a schema with no such
   parameter) and all ambiguous/conflicting cases.

Ordering: classify (raw) → key repair → **re-classify** (a renamed key may
fill a required parameter) → shape normalization → canonicalize. A call
executes whenever the post-repair state is bindable under today's
semantics.

### Shape Normalization

When keys are known and the only violation is scalar-vs-array shape:

- scalar for an array-typed parameter → wrap into a single-element array
  (**never split**: `keywords: "a,b"` becomes `["a,b"]`)
- single-element array for a scalar-typed parameter → unwrap

Shape actions require an **unambiguous schema**: wrap only when the
parameter schema exclusively expects an array (`type: "array"`, or a
union of `"array"` with only `"null"` — null is the absence of a value,
not a scalar shape), unwrap only when the schema explicitly types the
parameter as non-array. Schemas without an explicit `type`, and union
types permitting both array and scalar shapes (e.g.
`["array", "string"]`), are ambiguous → no shape action (today's path);
their valid array and scalar values are preserved untouched. `null`
values are never wrapped.

- multi-element array for a scalar-typed parameter → not normalizable →
  today's path

Composes with the existing coercions (`coerceArgsToSchema` on the MCP
path, the scalar accessors in `core/tools/parseArgs.ts`); repair runs
first, they keep doing their job.

### Decline Semantics (worst case = today)

Any key not repaired, any residual finding → the call proceeds exactly as
it would without this feature. Repair never worsens the outcome;
misclassification degrades to today's behavior by construction.

### Single-Pass Policy

Repair runs at most once per tool call (no repair-of-repair). If the
repaired call fails semantically at execution, its error is returned
as-is.

### Canonicalization (the critical integration decision)

`processedArgs` is **not** a vehicle: it is only set for tools with a
`preprocessArgs` hook and is bypassed by both execution surfaces (client
impls read `parsedArgs`, core re-parses the raw arguments string). When —
and only when — repair changed the args, the GUI thunk dispatches a
reducer that replaces `parsedArgs` **and** rewrites
`toolCall.function.arguments` (re-serialized repaired JSON) in the
ToolCallState. Every downstream consumer then sees the repaired form with
no per-consumer wiring: policy (`evaluatePolicy` receives `parsedArgs`),
client impls (`parsedArgs`), core impls (`safeParseToolCallArgs` re-parses
the raw string), transcript dump (renders `processedArgs ?? parsedArgs`).
The raw emission is not lost to forensics: the repair events record the
from→to keys (never values).

Two guards keep this safe: the canonicalization dispatch in the thunk is
independent of the `preprocessedArgs` branch — tools without a
`preprocessArgs` hook (the majority) are exactly the silently corruptible
cases and must be covered. And re-serialization must never silently drop
values: argument objects containing `undefined` values (partial-parse
artifacts from streaming) are not repaired at all — no events, no
canonicalization (`JSON.stringify` would drop undefined-valued keys).

### Feedback to the model (client-side bonus)

Repair events are stored on the ToolCallState; `callToolById` prepends a
one-line note to the tool result:

- repairs: `Note: argument keys were automatically repaired: from → to.
Use the exact schema names next time.`
- declined unknown keys: `Warning: unknown argument(s) x — this tool does
not declare them; they were ignored.`
- shape normalization: `Note: argument shape was automatically normalized
for: x (wrapped into a single-element array) / y (unwrapped to a
scalar).`

Notes carry key names only, never values. This is the feedback enhancement
the CITT spec defers; here it rides the existing output path.

### Change Discipline & Risk Containment

- **Repair core is new code only** (`core/tools/argRepair/`) — no
  modifications to existing files beyond the hooks below.
- **Hooks are insertion-only** — top of the `tools/preprocessArgs` core
  handler, the canonicalization dispatch in the thunk, the note prepend in
  `callToolById`. The well-formed path keeps byte-identical behavior
  (repair returns the args untouched, no events, no state writes).
- **Flag-gated:** `toolCallRepair.enabled` (config, default **false**) →
  every hook is a strict no-op. Transitory rollout aid; intended end state
  is always-on, with flag removal as a later explicit step.
- **Rule parity with CITT:** normalization set, distance thresholds,
  uniqueness/conflict rules and shape rules are normative and identical to
  the CITT spec; a change on one side must land on both.

### Logging / Measurement

Repair events: tool name, from→to keys, decline reason class, flag-disabled
no-ops at debug level. **Never log argument values** — key names and
decisions only. Channels: console/dev log plus the artifacts that already
exist (repaired args visible as `parsedArgs` in the transcript dump; events
on the ToolCallState). Accept/decline rates make any residual failure class
visible in data (decision input for ever reconsidering ML-based repair).

## Implementation Checklist

Sliced per the rollout order (Solution → Change Discipline).

**Slice 1 — repair core (new code only):**

- [x] 1. `core/tools/argRepair/`: ParameterDescriptor derivation from JSON
     Schema, classifier, key-repair matcher (normalizer, Levenshtein,
     uniqueness/conflict rules), shape normalizer, orchestrator
     `repairToolCallArgs(args, parameters) → { args, events }`

**Slice 2 — preprocess-stage hook (flag-gated):**

- [x] 2. `core/core.ts` `on("tools/preprocessArgs")`: run repair before
     `tool.preprocessArgs`, extend the response with `repairedArgs` and
     `repairEvents`
- [x] 3. config plumbing: `toolCallRepair.enabled` flag (default false)

**Slice 3 — canonicalization (GUI):**

- [x] 4. sessionSlice: reducer replacing `parsedArgs` and
     `toolCall.function.arguments` + storing `repairEvents` on the
     ToolCallState (new optional field)
- [x] 5. `gui/src/redux/thunks/preprocessToolCallArgs.ts`: dispatch the
     canonicalization when `repairedArgs` differs

**Slice 4 — feedback to the model:**

- [x] 6. `gui/src/redux/thunks/callToolById.ts`: prepend the repair note /
     unknown-key warning to the tool result when events are present
     (keys only)

## Appendix — Anchor Cheat Sheet

Verified against the code on 2026-10-17 (symbol names are the stable
handle; line numbers drift):

**`gui/src/redux/thunks/streamNormalInput.ts`**

- stage order: `setToolGenerated` → `preprocessToolCalls` (all generated
  calls; comment: "catch invalid args before checking policies") →
  `evaluateToolPolicies` → approval → `callToolById`

**`gui/src/redux/thunks/preprocessToolCallArgs.ts`**

- requests `tools/preprocessArgs` per call; dispatches
  `setProcessedToolCallArgs` / error output ("Invalid Tool Call …")

**`core/core.ts`**

- `on("tools/preprocessArgs")` — resolves tool from `config.tools`, runs
  `tool.preprocessArgs?.(args)`; hook runs before that call
- `on("tools/evaluatePolicy")` — receives `parsedArgs` + `processedArgs`

**`core/tools/callTool.ts`**

- `callTool` → `safeParseToolCallArgs(toolCall)` (raw-string re-parse,
  `{}` on parse failure) → `callBuiltInTool` / `callToolFromUri`
- MCP path: `coerceArgsToSchema(args, tool.function.parameters)` before
  `client.callTool`

**`gui/src/util/clientTools/callClientTool.ts`**

- client impls (edit family) receive `parsedArgs`

**`core/tools/parseArgs.ts`**

- existing scalar coercions (`getStringArg` / `getNumberArg` /
  `getBooleanArg`) and `coerceArgsToSchema` — compose, don't replace

**`core/transcriptDump/renderer.ts`**

- renders `processedArgs ?? parsedArgs` as `key=value`

**`core/config/profile/doLoadConfig.ts`**

- MCP tools: `parameters: tool.inputSchema` (verbatim)

**Evidence (read-only):**

- memory fragment `compact-conversation-drops-entwarnung-modell-emission_2026_10_17`
  (transcript forensics, serial-failure signature)
- memory fragment `llm-tool-param-no-gate-flags_2026_10_06` (related
  design lesson: models drop one of two coupled parameters)
- CITT repo `docs/specifications/tool-call-repair.md` (sibling spec,
  normative rule source)
