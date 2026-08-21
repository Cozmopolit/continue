import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tool, ToolCall, ToolExtras } from "..";
import { DEFAULT_MCP_TOOL_CALL_TIMEOUT } from "../context/mcp/MCPConnection";
import { callTool, encodeMCPToolUri } from "./callTool";

// The MCP manager singleton is only a lookup mcpId -> connection; replace it
// with a fake so the assertions can inspect what the SDK client receives
// without a live MCP server.
const fake = vi.hoisted(() => ({
  callTool: vi.fn(),
  options: {} as Record<string, unknown>,
}));

vi.mock("../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: {
    getInstance: () => ({
      getConnection: () => ({
        client: { callTool: fake.callTool },
        options: fake.options,
      }),
    }),
  },
}));

// Blocking CITT tools (msg_poll, msg_post waitForReply) wait up to 10,800 s
// server-side and then return their designed timedOut:true result — the
// client-side budget must clear that cap or the transport cuts the result
// off with -32001 (mcp-transport-timeout-blocking-calls.md).
const SERVER_SIDE_BLOCKING_CAP_MS = 10_800_000;

describe("callTool MCP timeout budget", () => {
  const mcpId = "citt";
  const toolName = "msg_poll";

  const tool: Tool = {
    type: "function",
    function: { name: toolName },
    displayTitle: toolName,
    readonly: true,
    group: "mcp",
    uri: encodeMCPToolUri(mcpId, toolName),
  };

  const toolCall: ToolCall = {
    id: "call_1",
    type: "function",
    function: { name: toolName, arguments: '{"topics":["Allgemein"]}' },
  };

  // The MCP branch only touches extras.tool; the rest of ToolExtras is
  // irrelevant for this wiring test.
  const extras = { tool } as unknown as ToolExtras;

  beforeEach(() => {
    fake.callTool.mockReset();
    fake.callTool.mockResolvedValue({ content: [], isError: false });
    fake.options = {};
  });

  it("default budget clears the server-side blocking cap", () => {
    expect(DEFAULT_MCP_TOOL_CALL_TIMEOUT).toBeGreaterThan(
      SERVER_SIDE_BLOCKING_CAP_MS,
    );
  });

  it("passes the default tool-call timeout when the server config has none", async () => {
    await callTool(tool, toolCall, extras);

    expect(fake.callTool).toHaveBeenCalledTimes(1);
    // Second argument is the result schema — skip it in the comparison.
    const [request, , requestOptions] = fake.callTool.mock.calls[0];
    expect(request).toEqual({
      name: toolName,
      arguments: { topics: ["Allgemein"] },
    });
    expect(requestOptions).toEqual({
      timeout: DEFAULT_MCP_TOOL_CALL_TIMEOUT,
    });
  });

  it("prefers a per-server configured timeout over the default", async () => {
    fake.options = { timeout: 42_000 };

    await callTool(tool, toolCall, extras);

    const [, , requestOptions] = fake.callTool.mock.calls[0];
    expect(requestOptions).toEqual({ timeout: 42_000 });
  });
});
