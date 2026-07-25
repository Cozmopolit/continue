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
