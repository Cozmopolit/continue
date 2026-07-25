# Tech Debt: Long-term maintenance of the Continue fork (post-EOL upstream)

**Status:** Open (accepted risk)
**Date:** 2026-07-25

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
