import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

// MCP server management (mcp-server-management.md): thin agent-facing
// wrapper over MCPManagerSingleton.setEnabled. Hidden by default via
// assistant YAML `chatOptions.toolOverrides.mcp_server_management.disabled:
// true`; enabled as a deliberate work step around a CITT.MCP deploy window.

export const mcpServerManagementTool: Tool = {
  type: "function",
  displayTitle: "MCP Server Management",
  wouldLikeTo: "manage MCP servers (list/disable/enable)",
  isCurrently: "managing MCP servers",
  hasAlready: "managed MCP servers",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.McpServerManagement,
    description: `Manage MCP servers: list them with status, disable one (stops its process and releases the executable lock), or re-enable a previously disabled one.

Use this when you need to deploy a new build of a stdio MCP server (e.g. CITT.MCP) that the agent itself depends on: disable releases the lock, you deploy via terminal, then enable reconnects and picks up the new binary.

Important:
- Disabling a server removes all of its tools until you re-enable it. For CITT.MCP that means almost all citt_* tools (memory, board, sql, jira, ...) are gone in between.
- Any in-flight tool call to that server fails immediately with "MCP connection closed".
- You must pass the exact server id from the list action to disable/enable.
- This is a use-at-your-own-risk control surface, not an orchestrator. No timers, no rollback, no health checks.`,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["list", "disable", "enable"],
          description:
            "list: show all configured MCP servers with status. disable: stop one server and release its process. enable: reconnect a previously disabled server.",
        },
        serverId: {
          type: "string",
          description:
            "Required for disable and enable: the exact server id returned by the list action.",
        },
      },
    },
  },
  systemMessageDescription: {
    prefix: `To manage MCP servers (list/disable/enable) — for example to deploy a new CITT.MCP build by releasing its executable lock — use the ${BuiltInToolNames.McpServerManagement} tool.`,
  },
  defaultToolPolicy: "allowedWithoutPermission",
};
