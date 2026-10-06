import { ToolImpl } from ".";
import { MCPManagerSingleton } from "../../context/mcp/MCPManagerSingleton";

// MCP server management (mcp-server-management.md): thin agent-facing
// wrapper over MCPManagerSingleton.setEnabled. No side effects beyond the
// manager call; the agent deploys via terminal between disable and enable.
// In-flight tool calls to a disabled server fail immediately with "MCP
// connection closed" — that is intentional, not an error to be handled.

export const mcpServerManagementImpl: ToolImpl = async (args) => {
  const action = args?.action as string | undefined;
  const serverId = args?.serverId as string | undefined;
  const manager = MCPManagerSingleton.getInstance();

  switch (action) {
    case "list": {
      const statuses = manager
        .getStatuses()
        .map((status) => ({
          id: status.id,
          name: status.name,
          status: status.status,
          type: status.type,
          toolCount: status.tools.length,
          errorCount: status.errors.length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [
        {
          name: "MCP servers",
          description: `${statuses.length} configured server(s)`,
          content: JSON.stringify(statuses, null, 2),
        },
      ];
    }

    case "disable": {
      if (!serverId) {
        throw new Error("serverId is required for action=disable");
      }
      await manager.setEnabled(serverId, false);
      const status = manager.getConnection(serverId)?.status ?? "unknown";
      return [
        {
          name: "MCP server disabled",
          description: serverId,
          content: `Server "${serverId}" is now disabled (status: ${status}). Its stdio process has exited and the executable lock is released. Deploy the new build now, then call this tool with action="enable" and the same serverId to reconnect.`,
        },
      ];
    }

    case "enable": {
      if (!serverId) {
        throw new Error("serverId is required for action=enable");
      }
      await manager.setEnabled(serverId, true);
      const status = manager.getConnection(serverId)?.status ?? "unknown";
      return [
        {
          name: "MCP server enabled",
          description: serverId,
          content: `Server "${serverId}" reconnect triggered (status: ${status}). The refreshed tool list is picked up automatically via config reload.`,
        },
      ];
    }

    default:
      throw new Error(
        `Invalid action "${action}". Expected one of: list, disable, enable.`,
      );
  }
};
