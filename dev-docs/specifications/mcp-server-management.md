# MCP Server Management (`mcp_server_management` Base Tool)

**Status:** Implementiert
**Date:** 2026-09-04

## Problem / Motivation

Coding agents cannot self-deploy a new CITT.MCP build: the running stdio MCP
server keeps its executable locked, and the agent cannot replace the binary
under its own feet. The workaround today is a manual VS Code window reload or
manual UI toggle — outside the agent's reach and easy to forget.

The fork already has all primitives to do this safely from inside the agent:
`MCPManagerSingleton.setEnabled(id, false)` disconnects the client and closes
the stdio transport (releasing the child process and its file locks), and
`setEnabled(id, true)` reconnects on demand. What is missing is an agent-facing
entry point: a small built-in tool that lists MCP servers, disables them, and
re-enables them — using the existing manager primitives, no new protocol
surface, no GUI state.

## Design Constraints (locked)

- **KISS, not over-engineered.** No orchestration, no watcher integration, no
  deployment workflow, no automatic re-enable timers. The tool is a thin,
  explicit control surface.
- **Hidden by default.** The tool does not inflate the tools array. It is
  registered like any other built-in but ships with `disabled` policy applied
  by default in the assistant's YAML (`chatOptions.toolOverrides`), and is
  enabled as an explicit work step before a planned deploy.
- **Use-at-your-own-risk.** Disabling CITT.MCP removes almost all CITT tools
  (memory, board, sql, jira, etc.) until re-enable. In-flight tool calls fail
  with `MCP connection closed`. The tool description must make this obvious.
- **Board watcher is idempotent.** It polls through CITT.MCP; while disabled
  the poll fails and the next tick retries. No special handling.

## Existing Primitives (verified, do not rebuild)

- `core/context/mcp/MCPManagerSingleton.ts`
  - `connections: Map<string, MCPConnection>` — server id → connection.
  - `setEnabled(serverId, enabled)` — disable: `conn.disconnect(true)`
    (status `disabled`); enable: `conn.status = "not-connected"` then
    `refreshConnection(serverId)`.
  - `refreshConnection(serverId)` — `connectClient(true, signal)`; fires
    `onConnectionsRefreshed`.
  - `getStatuses()` — array of `MCPServerStatus & { client }`.
- `core/context/mcp/MCPConnection.ts`
  - `disconnect(disable = false)` (line ~413) — aborts the controller, fails
    active proxy streams with `MCP connection closed`, closes client and
    transport, sets status to `disabled` when `disable=true`.
  - `connectClient(forceRefresh, signal)` (line ~919) — returns early when
    status is `disabled` (no reconnect storm).
  - `getStatus()` — returns options, errors, infos, tools, prompts,
    resources, status.
- `core/core.ts`
  - `on("mcp/setServerEnabled", …)` → `MCPManagerSingleton.getInstance()
.setEnabled(id, enabled)` — the existing GUI toggle path. The new tool
    reuses the same singleton and semantics, it does **not** add a new
    handler.
  - `MCPManagerSingleton.getInstance().onConnectionsRefreshed` triggers
    `configHandler.reloadConfig("MCP Connections refreshed")` — this is what
    refreshes the tool list after re-enable.
- Tool-policy plumbing
  - `core/tools/index.ts` `getBaseToolDefinitions()` — registration point.
  - `gui/src/redux/selectors/selectActiveTools.ts` — filters by
    `toolSettings[tool.function.name] ?? defaultToolPolicy`, and group-level
    `exclude`. Disabled tools never reach the model.
  - `packages/config-yaml/src/schemas/models.ts` — `chatOptions.toolOverrides`
    supports `disabled: true` per tool name. Use this to default-hide the
    tool in the assistant YAML without touching code.

## Tool Definition

Add to `core/tools/builtIn.ts`:

```ts
McpServerManagement = "mcp_server_management",
```

Add `core/tools/definitions/mcpServerManagement.ts` following the
`compactConversation.ts` pattern (description + `systemMessageDescription`,
usage-guiding). Parameters:

```json
{
  "type": "object",
  "required": ["action"],
  "properties": {
    "action": {
      "type": "string",
      "enum": ["list", "disable", "enable"],
      "description": "list: show all configured MCP servers with status; disable: stop one server and release its process; enable: reconnect a previously disabled server"
    },
    "serverId": {
      "type": "string",
      "description": "Required for disable/enable: the exact server id from the list action"
    }
  }
}
```

`defaultToolPolicy: "allowedWithoutPermission"` — the danger is not in
calling the tool, it is in disabling the wrong server; that judgement is
the caller's. The tool description must state plainly that disabling
CITT.MCP removes almost all CITT tools until re-enable, and that in-flight
calls fail.

## Implementation

Add `core/tools/implementations/mcpServerManagement.ts`:

```ts
import { ToolImpl } from ".";
import { MCPManagerSingleton } from "../../context/mcp/MCPManagerSingleton";

// mcp-server-management.md: thin agent-facing wrapper over
// MCPManagerSingleton.setEnabled. No side effects beyond the manager call;
// the agent deploys via terminal between disable and enable.
```

- **list**: call `getStatuses()`, return a compact table of
  `{ id, name, status, transport type, toolCount, errorCount }`. No
  `client` field. Order by name.
- **disable**: require `serverId`. Call `setEnabled(serverId, false)`.
  Return confirmation including a reminder that the executable is now free
  and that the next step is the terminal deploy, then `enable` with the
  same id.
- **enable**: require `serverId`. Call `setEnabled(serverId, true)`.
  Return confirmation including the reconnect result (status after
  `refreshConnection`).

Wire as a `case BuiltInToolNames.McpServerManagement:` in
`callBuiltInTool` (`core/tools/callTool.ts`). No GUI thunk, no Redux state,
no run-end hook — the impl is synchronous core work.

## Default-Hide Configuration

In the assistant YAML (where the agent persona is defined), add:

```yaml
chatOptions:
  toolOverrides:
    mcp_server_management:
      disabled: true
```

Enable only for the deploy window: flip to `false` (or remove the override),
reload the assistant, run the disable/deploy/enable sequence, flip back.
This is a deliberate, controlled step — not a persistent exposure.

## Deployment Sequence (the actual use case)

1. Agent verifies the target server id via `action: "list"`.
2. Agent calls `action: "disable", serverId: <citt-mcp-id>`. The stdio
   child process exits; the executable lock is released.
3. Agent runs the terminal command to deploy the new build.
4. Agent calls `action: "enable", serverId: <citt-mcp-id>`. The manager
   reconnects; `onConnectionsRefreshed` triggers a config reload and the
   new tool set is picked up.
5. Agent flips the YAML override back to `disabled: true` and reloads.

If the agent crashes mid-sequence, the next session can call `list` and
`enable` to recover — no persistent damage.

## Non-Goals

- Automatic detection of "the CITT.MCP server" (the agent must pass the id).
- Deploy orchestration (the tool does not copy files).
- Health checks, retries, timers, or rollback.
- Board watcher or GUI changes beyond the tool definition.

## Tests

Minimal: `core/tools/implementations/mcpServerManagement.vitest.ts` with a
stubbed `MCPManagerSingleton` covering `list` shape, `disable`/`enable`
dispatch, and error when `serverId` is missing for `disable`/`enable`.
The existing `MCPManagerSingleton.vitest.ts` already covers `setEnabled`
semantics; no duplication.

## References

- `agent-self-compaction.md` — the base-tool pattern this follows.
- `core/context/mcp/MCPManagerSingleton.ts`, `MCPConnection.ts`.
- `packages/config-yaml/src/schemas/models.ts` (`chatOptions.toolOverrides`).
