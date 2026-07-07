import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InternalSseMcpOptions,
  InternalStdioMcpOptions,
  InternalWebsocketMcpOptions,
} from "../..";
import * as ideUtils from "../../util/ideUtils";
import MCPConnection, { DEFAULT_MCP_TOOL_CALL_TIMEOUT } from "./MCPConnection";

// Mock the shell path utility
vi.mock("../../util/shellPath", () => ({
  getEnvPathFromUserShell: vi
    .fn()
    .mockResolvedValue("/usr/local/bin:/usr/bin:/bin"),
}));

describe("MCPConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create instance with stdio transport", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test-cmd",
        args: ["--test"],
        env: { TEST: "true" },
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with stdio transport including cwd", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test-cmd",
        args: ["--test"],
        env: { TEST: "true" },
        cwd: "/path/to/working/directory",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
      if (conn.options.type === "stdio") {
        expect(conn.options.cwd).toBe("/path/to/working/directory");
      }
    });

    it("should create instance with websocket transport", () => {
      const options: InternalWebsocketMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "websocket",
        url: "ws://test.com",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with SSE transport", () => {
      const options: InternalSseMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "sse",
        url: "http://test.com/events",
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should create instance with SSE transport and custom headers", () => {
      const options: InternalSseMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "sse",
        url: "http://test.com/events",
        requestOptions: {
          headers: {
            Authorization: "Bearer token123",
            "X-Custom-Header": "custom-value",
          },
        },
      };

      const conn = new MCPConnection(options);
      expect(conn).toBeInstanceOf(MCPConnection);
      expect(conn.status).toBe("not-connected");
    });

    it("should throw on invalid transport type", async () => {
      const options = {
        name: "test-mcp",
        id: "test-id",
        type: "invalid" as any,
        url: "",
      };

      const conn = new MCPConnection(options);
      const abortController = new AbortController();

      // The validation now happens during connectClient, not constructor
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain("Unsupported transport type: invalid");
    });
  });

  describe("getStatus", () => {
    it("should return current status", () => {
      const options: InternalStdioMcpOptions = {
        name: "test-mcp",
        id: "test-id",
        type: "stdio",
        command: "test",
        args: [],
      };

      const conn = new MCPConnection(options);
      const status = conn.getStatus();

      expect(status).toEqual({
        ...options,
        errors: [],
        infos: [],
        isProtectedResource: false,
        prompts: [],
        resources: [],
        resourceTemplates: [],
        tools: [],
        status: "not-connected",
      });
    });
  });

  describe("resolveCwd", () => {
    const baseOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio" as const,
      command: "test-cmd",
      args: [],
    };

    it("should return absolute cwd unchanged", async () => {
      const conn = new MCPConnection(baseOptions);

      await expect((conn as any).resolveCwd("/tmp/project")).resolves.toBe(
        "/tmp/project",
      );
    });

    it("should resolve relative cwd using IDE workspace", async () => {
      const ide = {} as any;
      // Use platform-appropriate file URL (Windows requires drive letter)
      const isWindows = process.platform === "win32";
      const mockFileUrl = isWindows
        ? "file:///C:/workspace/src"
        : "file:///workspace/src";
      const expectedPath = isWindows ? "C:\\workspace\\src" : "/workspace/src";

      const mockResolve = vi
        .spyOn(ideUtils, "resolveRelativePathInDir")
        .mockResolvedValue(mockFileUrl);
      const conn = new MCPConnection(baseOptions, { ide });

      await expect((conn as any).resolveCwd("src")).resolves.toBe(expectedPath);
      expect(mockResolve).toHaveBeenCalledWith("src", ide);
    });

    it("should fall back to homedir for remote URIs that cannot be used as local cwd", async () => {
      const ide = {} as any;
      vi.spyOn(ideUtils, "resolveRelativePathInDir").mockResolvedValue(
        "vscode-remote://ssh-remote+192.168.137.2/home/user/project",
      );
      const conn = new MCPConnection(baseOptions, { ide });

      const { homedir } = require("os");
      await expect((conn as any).resolveCwd("src")).resolves.toBe(homedir());
    });
  });

  describe("connectClient", () => {
    const options: InternalStdioMcpOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio",
      command: "test-cmd",
      args: [],
    };

    it("should connect successfully", async () => {
      const conn = new MCPConnection(options);
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockResolvedValue(undefined);
      const mockGetServerCapabilities = vi
        .spyOn(Client.prototype, "getServerCapabilities")
        .mockReturnValue({
          resources: {},
          tools: {},
          prompts: {},
        });

      const mockListResources = vi
        .spyOn(Client.prototype, "listResources")
        .mockResolvedValue({
          resources: [{ name: "test-resource", uri: "test-uri" }],
        });
      const mockListTools = vi
        .spyOn(Client.prototype, "listTools")
        .mockResolvedValue({
          tools: [
            {
              name: "test-tool",
              inputSchema: {
                type: "object",
              },
            },
          ],
        });
      const mockListPrompts = vi
        .spyOn(Client.prototype, "listPrompts")
        .mockResolvedValue({ prompts: [{ name: "test-prompt" }] });

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("connected");
      expect(conn.resources).toHaveLength(1);
      expect(conn.tools).toHaveLength(1);
      expect(conn.prompts).toHaveLength(1);
      expect(mockConnect).toHaveBeenCalled();
    });

    it("should handle custom connection timeout", async () => {
      const conn = new MCPConnection({ ...options, timeout: 1500 });
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 1000)),
        );

      // Mock the required methods for successful connection
      const mockGetServerCapabilities = vi
        .spyOn(Client.prototype, "getServerCapabilities")
        .mockReturnValue({
          resources: {},
          tools: {},
          prompts: {},
        });

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("connected");
      expect(mockConnect).toHaveBeenCalled();
    });

    it("should handle connection timeout", async () => {
      const conn = new MCPConnection({ ...options, timeout: 50 });
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 100)),
        );

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain("Failed to connect");
      // The connection should timeout before connect is called due to transport construction
      // Since transport construction happens first, and we're not mocking that,
      // the timeout will happen during transport construction or connect attempt
    });

    it("should handle already connected state", async () => {
      const conn = new MCPConnection(options);
      conn.status = "connected";

      const mockConnect = vi.spyOn(Client.prototype, "connect");
      const abortController = new AbortController();

      await conn.connectClient(false, abortController.signal);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(conn.status).toBe("connected");
    });

    it("should handle transport errors", async () => {
      const conn = new MCPConnection(options);
      const mockConnect = vi
        .spyOn(Client.prototype, "connect")
        .mockRejectedValue(new Error("spawn test-cmd ENOENT"));

      const abortController = new AbortController();
      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors[0]).toContain('command "test-cmd" not found');
      expect(mockConnect).toHaveBeenCalled();
    });

    it.skip("should include stderr output in error message when stdio command fails", async () => {
      // Clear any existing mocks to ensure we get real behavior
      vi.restoreAllMocks();

      // Use a command that will definitely fail and produce stderr output
      const failingOptions: InternalStdioMcpOptions = {
        name: "failing-mcp",
        id: "failing-id",
        type: "stdio",
        command: "node",
        args: [
          "-e",
          "console.error('Custom error message from stderr'); process.exit(1);",
        ],
        timeout: 5000, // Give enough time for the command to run and fail
      };

      const conn = new MCPConnection(failingOptions);
      const abortController = new AbortController();

      await conn.connectClient(false, abortController.signal);

      expect(conn.status).toBe("error");
      expect(conn.errors).toHaveLength(1);
      expect(conn.errors[0]).toContain("Failed to connect");
      expect(conn.errors[0]).toContain("Process output:");
      expect(conn.errors[0]).toContain("STDERR:");
      expect(conn.errors[0]).toContain("Custom error message from stderr");
    });
  });

  describe("proxy HTTP tunnel", () => {
    const options: InternalStdioMcpOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio",
      command: "test-cmd",
      args: [],
    };

    const proxyHttpParams = {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { Authorization: "Bearer key" },
      body: '{"model":"gpt-4o","stream":true}',
    };

    /**
     * Notification dispatch goes through Promise.resolve().then(...) inside
     * the SDK, so tests must flush microtasks after emitting.
     */
    const flushMicrotasks = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    };

    const emitNotification = async (
      conn: MCPConnection,
      method: string,
      params: Record<string, unknown>,
    ) => {
      (conn.client as any)._onnotification({
        jsonrpc: "2.0",
        method,
        params,
      });
      await flushMicrotasks();
    };

    /** Mocks Client.request for proxy/http (and proxy/cancel). */
    const mockRequest = (proxyHttpResult: unknown) =>
      vi
        .spyOn(Client.prototype, "request")
        .mockImplementation(async (req: any) => {
          if (req.method === "proxy/http") {
            return proxyHttpResult as any;
          }
          if (req.method === "proxy/cancel") {
            return { cancelled: true } as any;
          }
          throw new Error(`Unexpected request: ${req.method}`);
        });

    const streamingResult = (streamId: string) => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      streaming: true,
      streamId,
    });

    /** Starts consuming the chunks iterable; rejections are pre-caught. */
    const consumeChunks = (chunks: AsyncIterable<string>) => {
      const collected: string[] = [];
      const done = (async () => {
        for await (const chunk of chunks) {
          collected.push(chunk);
        }
      })();
      done.catch(() => {}); // avoid unhandled rejection noise
      return { collected, done };
    };

    it("returns non-streaming responses whole, including HTTP errors", async () => {
      const requestSpy = mockRequest({
        status: 429,
        headers: { "content-type": "application/json" },
        body: '{"error":"rate limited"}',
      });
      const conn = new MCPConnection(options);

      const resp = await conn.proxyHttp(proxyHttpParams);

      expect(resp).toEqual({
        streaming: false,
        status: 429,
        headers: { "content-type": "application/json" },
        body: '{"error":"rate limited"}',
      });
      expect(requestSpy).toHaveBeenCalledWith(
        { method: "proxy/http", params: proxyHttpParams },
        expect.anything(),
        { signal: undefined, timeout: DEFAULT_MCP_TOOL_CALL_TIMEOUT },
      );
    });

    it("defaults missing headers and body on non-streaming responses", async () => {
      mockRequest({ status: 204 });
      const conn = new MCPConnection(options);

      const resp = await conn.proxyHttp(proxyHttpParams);

      expect(resp).toEqual({
        streaming: false,
        status: 204,
        headers: {},
        body: "",
      });
    });

    it("throws when streaming=true comes without a streamId", async () => {
      mockRequest({ status: 200, streaming: true });
      const conn = new MCPConnection(options);

      await expect(conn.proxyHttp(proxyHttpParams)).rejects.toThrow(
        /without streamId/,
      );
    });

    it("dispatches chunks by streamId and terminates on done", async () => {
      mockRequest(streamingResult("s_1"));
      const conn = new MCPConnection(options);

      const resp = await conn.proxyHttp(proxyHttpParams);
      expect(resp.streaming).toBe(true);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { collected, done } = consumeChunks(resp.chunks);

      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_1",
        data: "data: one\n\n",
      });
      // Chunk for a different (unknown) stream must not leak in or throw
      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_other",
        data: "data: wrong\n\n",
      });
      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_1",
        data: "data: two\n\n",
      });
      await emitNotification(conn, "proxy/http/done", { streamId: "s_1" });

      await done;
      expect(collected).toEqual(["data: one\n\n", "data: two\n\n"]);
    });

    it("flushes notifications that arrive before the stream is registered", async () => {
      mockRequest(streamingResult("s_2"));
      const conn = new MCPConnection(options);

      // Race: chunk notification is dispatched before proxyHttp() has
      // processed the JSON-RPC result and registered the stream.
      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_2",
        data: "data: early\n\n",
      });

      const resp = await conn.proxyHttp(proxyHttpParams);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { collected, done } = consumeChunks(resp.chunks);

      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_2",
        data: "data: late\n\n",
      });
      await emitNotification(conn, "proxy/http/done", { streamId: "s_2" });

      await done;
      expect(collected).toEqual(["data: early\n\n", "data: late\n\n"]);
    });

    it("errors the iteration on proxy/http/error", async () => {
      mockRequest(streamingResult("s_3"));
      const conn = new MCPConnection(options);

      const resp = await conn.proxyHttp(proxyHttpParams);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { collected, done } = consumeChunks(resp.chunks);

      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_3",
        data: "data: partial\n\n",
      });
      await emitNotification(conn, "proxy/http/error", {
        streamId: "s_3",
        error: { code: "UPSTREAM_TIMEOUT", message: "provider timed out" },
      });

      await expect(done).rejects.toThrow(
        "Proxy stream error UPSTREAM_TIMEOUT: provider timed out",
      );
      expect(collected).toEqual(["data: partial\n\n"]);
    });

    it("cancelProxyStream aborts locally, sends proxy/cancel, discards late chunks", async () => {
      const requestSpy = mockRequest(streamingResult("s_4"));
      const conn = new MCPConnection(options);

      const resp = await conn.proxyHttp(proxyHttpParams);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { collected, done } = consumeChunks(resp.chunks);

      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_4",
        data: "data: before-cancel\n\n",
      });

      conn.cancelProxyStream("s_4");

      await expect(done).rejects.toMatchObject({ name: "AbortError" });
      expect(collected).toEqual(["data: before-cancel\n\n"]);
      expect(requestSpy).toHaveBeenCalledWith(
        { method: "proxy/cancel", params: { streamId: "s_4" } },
        expect.anything(),
        expect.anything(),
      );

      // Late chunks and the terminal notification are silently discarded
      await emitNotification(conn, "proxy/http/chunk", {
        streamId: "s_4",
        data: "data: late\n\n",
      });
      await emitNotification(conn, "proxy/http/done", { streamId: "s_4" });
      expect(collected).toEqual(["data: before-cancel\n\n"]);

      // Cancelling again or cancelling unknown streams is a no-op
      conn.cancelProxyStream("s_4");
      conn.cancelProxyStream("does-not-exist");
    });

    it("disconnect errors out active streams", async () => {
      mockRequest(streamingResult("s_5"));
      const conn = new MCPConnection(options);
      vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
      (conn as any).transport = { close: vi.fn().mockResolvedValue(undefined) };

      const resp = await conn.proxyHttp(proxyHttpParams);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { done } = consumeChunks(resp.chunks);

      await conn.disconnect();

      await expect(done).rejects.toThrow("MCP connection closed");
    });

    it("reconnect errors out active streams", async () => {
      mockRequest(streamingResult("s_6"));
      const conn = new MCPConnection(options);
      vi.spyOn(Client.prototype, "connect").mockRejectedValue(
        new Error("connect failed"),
      );

      const resp = await conn.proxyHttp(proxyHttpParams);
      if (!resp.streaming) {
        throw new Error("expected streaming response");
      }
      const { done } = consumeChunks(resp.chunks);

      await conn
        .connectClient(true, new AbortController().signal)
        .catch(() => {});

      await expect(done).rejects.toThrow("MCP connection closed");
    });
  });

  describe.skip("actually connect to Filesystem MCP", () => {
    it("should connect and include correct tools", async () => {
      const conn = new MCPConnection({
        id: "filesystem",
        name: "Filesystem",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      });

      try {
        const abortController = new AbortController();
        await conn.connectClient(false, abortController.signal);
        expect(conn.status).toBe("connected");
      } finally {
        await conn.disconnect();
      }
    });
  });

  describe("resolveCommandForPlatform", () => {
    const baseOptions: InternalStdioMcpOptions = {
      name: "test-mcp",
      id: "test-id",
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    };

    it("should NOT wrap with cmd.exe when Windows host connects to WSL remote", async () => {
      const mockIde = {
        getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "wsl" }),
      } as any;

      const conn = new MCPConnection(baseOptions, { ide: mockIde });

      // Mock process.platform to be win32
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        const result = await (conn as any).resolveCommandForPlatform("npx", [
          "-y",
          "test",
        ]);
        // Should NOT wrap with cmd.exe when in WSL
        expect(result.command).toBe("npx");
        expect(result.args).toEqual(["-y", "test"]);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("should wrap with cmd.exe when Windows host is local (not WSL)", async () => {
      const mockIde = {
        getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "" }),
      } as any;

      const conn = new MCPConnection(baseOptions, { ide: mockIde });

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        const result = await (conn as any).resolveCommandForPlatform("npx", [
          "-y",
          "test",
        ]);
        // Should wrap with cmd.exe for local Windows
        expect(result.command).toBe("cmd.exe");
        expect(result.args).toEqual(["/c", "npx", "-y", "test"]);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("should NOT wrap with cmd.exe on Linux regardless of batch command", async () => {
      const conn = new MCPConnection(baseOptions);

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });

      try {
        const result = await (conn as any).resolveCommandForPlatform("npx", [
          "-y",
          "test",
        ]);
        expect(result.command).toBe("npx");
        expect(result.args).toEqual(["-y", "test"]);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("should NOT wrap non-batch commands even on Windows", async () => {
      const mockIde = {
        getIdeInfo: vi.fn().mockResolvedValue({ remoteName: "" }),
      } as any;

      const conn = new MCPConnection(baseOptions, { ide: mockIde });

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        const result = await (conn as any).resolveCommandForPlatform("python", [
          "script.py",
        ]);
        // python is not in WINDOWS_BATCH_COMMANDS, so no wrapping
        expect(result.command).toBe("python");
        expect(result.args).toEqual(["script.py"]);
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });
  });
});
