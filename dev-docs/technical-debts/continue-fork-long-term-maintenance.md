# Tech Debt: Long-term maintenance of the Continue fork (post-EOL upstream)

**Status:** Open (accepted risk)
**Date:** 2026-07-25

## Status update 2026-10-17 (autumn window entered)

The "Autumn 2026" window from the timing estimate is now; findings verified and
directions decided:

- **Node toolchain bump started** — spec:
  `specifications/node-24-toolchain-bump.md`. Target: Node 24 LTS (active until
  ~2028). Note: `.nvmrc`/`engines` were still pinned to 20.20.1 while the dev
  machine already ran 22.14.0 — the pin was stale, not the runtime.
- **MCP SDK v2 has shipped** (2026-07-27): the TypeScript v2 line is published
  under new package names (`@modelcontextprotocol/client`, 2.3.1 verified); the
  old `@modelcontextprotocol/sdk` package remains the 1.x maintenance line
  (1.32.1; fixes until ~early 2027). The early-warning signal "SDK flips to 2.x
  stable" has therefore fired — under a different package name. Decision: the
  client port is **out of scope for now** — it is a joint migration to be planned
  with the CITT server side (this repo is the MCP client, CITT.MCP is the server;
  either side migrating alone kills the tunnel handshake). Nothing breaks while
  both sides stay on v1.
- **JetBrains frozen**: no investment in `binary/`/`pkg` compatibility. If it
  breaks under Node 24, JetBrains support dies unmourned (no productive usage).
- **Indexing island declared dead**: the vectordb / onnxruntime /
  @xenova/transformers / sqlite3 stack is unused in our deployments. It only
  needs to _build_ under Node 24, not work; on hard failure it gets removed, not
  repaired. Clean excision (deps + degraded context providers) is a separate
  follow-up project.
- Lockfiles are fresher than this document assumed (core: 2026-07,
  vscode/gui: 2026-10 — not frozen since 2026-03).

## Status update 2026-10-17 (Node 24 done, audit baseline)

The autumn toolchain move landed (spec: `specifications/node-24-toolchain-bump.md`):

- **Node 24.22.0 is the build toolchain** (`.nvmrc`, `engines` in core,
  core/vendor, gui, extensions/vscode). Full clean rebuild reproducible; full
  test runner green (2 catalogued full-load flakes, solo green); VSIX
  `continue-2.2.4.vsix` builds (~16 MB larger than 2.2.3 — freshly resolved
  LanceDB native binary, not investigated further).
- Structural fix along the way: all `packages/*` internal `@continuedev/*`
  refs are now `file:` links (was: registry semver + manual junctions).
- npm audit baseline per workspace (2026-10-17, total/critical/high):

  | workspace    | total | crit | high |     | workspace         | total | crit | high |
  | ------------ | ----- | ---- | ---- | --- | ----------------- | ----- | ---- | ---- |
  | root         | 12    | 1    | 9    |     | config-yaml       | 69    | 2    | 58   |
  | core         | 92    | 7    | 66   |     | continue-sdk      | 16    | 4    | 7    |
  | gui          | 101   | 8    | 36   |     | fetch             | 43    | 4    | 33   |
  | vscode       | 76    | 10   | 38   |     | llm-info          | 35    | 2    | 29   |
  | cli          | 98    | 8    | 50   |     | openai-adapters   | 65    | 5    | 37   |
  | config-types | 0     | 0    | 0    |     | terminal-security | 9     | 3    | 4    |

  Not actioned (would invalidate the freshly green gates): `npm audit fix`
  is its own workstream with its own gate; make it a quarterly ritual.

- New candidates for the follow-up list:
  - **Indexing island excision** (as decided): vectordb / onnxruntime-node /
    @xenova/transformers / sqlite3 + degraded context providers. Note:
    `vectordb` is already removed from `extensions/vscode`; it remains in
    `core` (installs fine there under Node 24 — excision is about maintenance
    surface, not breakage).
  - **dbinfoz / @database provider review**: dbinfoz (pulls sqlite3 into
    vscode) is used by exactly one file (`core/context/providers/
DatabaseContextProvider.ts`). If @database is unused, it is excision
    candidate #2 — removing it also frees the sqlite3 install quirk in
    vscode (`--ignore-scripts` workaround, see environment-gotchas.md).

## Problem

This repo forks Continue at v2.1.0 — the **final release**. Continue was
discontinued (team acqui-hired by Cursor, 2026; repo no longer actively
maintained — verified 2026-07-25 via HN/thenewstack.io). There is no upstream.

The fork works today, but bit-rot is certain: VS Code extension API changes,
Node/Electron toolchain churn, vulnerable transitive dependencies, LLM
provider API changes. At some point solo maintenance becomes infeasible —
**it will happen, only the timing is unknown**. When it does, a different
option is needed (community fork, alternative assistant, own minimal
client, ...). Exit options were deliberately not yet evaluated — there is no
pressure today.

## Context

- Working theory (2026-07-25): no upstream exists → we fork freely, no merge
  hygiene required. Full freedom until the maintenance wall hits.
- Corporate usage depends on this fork + the CITT MCP tunnel (see
  `history/specifications/mcp-proxy/`).
- Consequence for today: keep the dependency footprint small — every added
  dependency is future solo-maintenance load.

## Affected Areas

- The entire repo; first pressure points expected: VS Code extension API,
  Node/Electron toolchain, LLM provider API changes (provider drift is
  already absorbed by us: `packages/openai-adapters`).
- Ranking revised by the break-first analysis dated 2026-07-25 (see below):
  MCP client first (externally dated forcing event), build toolchain
  second, VS Code extension API re-ranked to _lowest_ risk.

## Break-first analysis (educated guess, 2026-07-25)

Method: local inspection (package.json across 9 workspaces, lockfile date,
`.nvmrc`, grep for proposed APIs / native modules / MCP feature usage) plus
web research (Node.js EOL schedule, VS Code API compatibility policy, MCP
spec/SDK announcements). Confidence: **high** for Node/VS Code facts,
**medium** for MCP details (spec date 2026-07-28 confirmed by multiple
sources; individual breaking-change details from a single secondary
source — direction certain, detail uncertain).

### Ranked: what breaks first

1. **MCP protocol break** — the only externally _dated_ forcing event.
   Spec revision 2026-07-28 ("largest revision since launch") and
   TypeScript SDK v2 both land on 2026-07-28. The fork pins
   `@modelcontextprotocol/sdk ^1.25.2` (last 1.x: 1.29.0). Per migration
   analyses, v1↔v2 do not silently interoperate (changed transport model);
   client-side migration effort rated "medium to high". Mitigations found
   in the code:
   - The client uses only tools/prompts/resources/resource-templates — the
     deprecated features (Roots, Sampling, Logging) are **not** used
     (verified in `core/context/mcp/MCPConnection.ts`).
   - The MCP client is well encapsulated (`MCPConnection.ts`,
     `MCPManagerSingleton.ts`, `MCPOauth.ts`) — an SDK v2 port is a bounded
     project, not a rewrite.
   - The CITT tunnel server side is corporate-controlled → we choose when
     the server migrates. No overnight break, but SDK v1 enters maintenance
     and ecosystem/docs/fixes move on.
2. **Build toolchain rot** (build-time only — an installed VSIX is immune).
   `.nvmrc` pins Node 20 (EOL since 2026-04-30); package-lock frozen
   2026-03-26; `pkg` (devDep for the JetBrains `binary/` build) deprecated;
   node-gyp natives: sqlite3, vectordb. Bites on the next _forced_ rebuild,
   not before.
3. **Dependency / security drift** (~230 direct deps across 9 workspaces).
   Notably behind or abandoned: `openai` ^5.13.1 (latest 6.49.0),
   `@anthropic-ai/sdk` ^0.62.0 (latest 0.115.0), `vectordb` pinned exactly
   0.4.20 (abandoned, superseded by `@lancedb/lancedb`),
   `@xenova/transformers` 2.14.0 (line abandoned, superseded by
   `@huggingface/transformers`), `onnxruntime-node` 1.14.0 (from 2023).
   No functional break today; audit/compliance pressure grows monthly. The
   native indexing island (vectordb + sqlite3 + onnxruntime + xenova) is
   the first candidate to become functionally untenable — escape hatch:
   configure remote embeddings, making the whole island optional.
4. **LLM provider API drift** — continuous but buffered (OpenRouter + own
   `packages/openai-adapters` fork). Solo-maintainable indefinitely; never
   a cliff.
5. **VS Code itself — last, not first.** The extension is in the
   officially recommended compatibility posture: `@types/vscode` hard-set
   to 1.70, `engines.vscode ^1.70.0`, stable API only, **zero proposed
   APIs** (no `enabledApiProposals`). Core runs in-process
   (`InProcessMessenger`); native modules are N-API (sqlite3, `@lancedb`
   index.node) and survive Electron/Node bumps. `binary/` is JetBrains-only
   → `pkg` deprecation does not affect VS Code usage. Realistic horizon:
   2028+.

### Timing estimate

- **Autumn 2026**: MCP port decision on the table; bump build toolchain to
  Node 22/24 LTS _while everything is green_ (cheap now, expensive under
  pressure).
- **2027**: MCP SDK v2 port due (when the server side migrates — our
  choice, but ecosystem moves on); quarterly lockfile refresh + `npm audit`
  hygiene becomes mandatory.
- **2028+**: the "wall" is not a single event but _simultaneity_ (MCP v1
  EOL + rotted toolchain + possible VS Code surprise). Unmaintained:
  multiple breaks ≈2027; with the two prophylactic moves (MCP port, Node
  bump) pushable well beyond 2028.

### Early-warning signals (check periodically)

- `npm view @modelcontextprotocol/sdk version` flips to 2.x stable → the
  clock is running
- CITT server roadmap: when does the tunnel migrate spec versions?
- VS Code release notes: extension host / Electron / Node changes
- After every VS Code update: smoke-test codebase indexing (native modules)
- `npm audit` trend on each lockfile refresh
