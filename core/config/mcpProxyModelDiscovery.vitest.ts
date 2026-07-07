import { beforeAll, describe, expect, test } from "vitest";
import {
  ChatMessage,
  Chunk,
  IdeSettings,
  ILLMLogger,
  MCPServerStatus,
  ProxyEndpoint,
} from "..";
import type {
  ProxyHttpParams,
  ProxyHttpResponse,
} from "../context/mcp/MCPConnection";
import { McpProxyTransport } from "../context/mcp/mcpProxyFetch";
import { BaseLLM } from "../llm";
import {
  collectProxyEndpoints,
  discoverProxyModels,
  getRoleForApiType,
  proxyEndpointToModelDescription,
} from "./mcpProxyModelDiscovery";

// The shared vitest setup replaces globalThis.Response with node-fetch's
// implementation, which cannot carry a web ReadableStream body. The tunnel
// fetch used by discovered models targets the native (undici) Response of
// the extension host, so we restore it for this suite.
const NativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = NativeResponse;
});

const createEndpoint = (
  overrides: Partial<ProxyEndpoint> = {},
): ProxyEndpoint => ({
  id: "azure-gpt-4o",
  name: "Azure GPT-4o (Sweden Central)",
  apiType: "OpenAI-compatible",
  model: "gpt-4o",
  apiBase: "https://citt-central-sweden.openai.azure.com/v1",
  timeout: 60,
  ...overrides,
});

type ServerStatusOverrides = Partial<
  Pick<
    MCPServerStatus,
    | "id"
    | "name"
    | "status"
    | "proxyCapabilities"
    | "proxyEndpoints"
    | "proxyKey"
  >
>;

const createServerStatus = (
  overrides: ServerStatusOverrides = {},
): MCPServerStatus => ({
  id: "citt-mcp",
  name: "CITT",
  type: "sse",
  url: "https://example.com/mcp",
  status: "connected",
  errors: [],
  infos: [],
  prompts: [],
  tools: [],
  resources: [],
  resourceTemplates: [],
  isProtectedResource: false,
  ...overrides,
});

describe("getRoleForApiType", () => {
  test.each([
    ["OpenAI-compatible", "chat"],
    ["Anthropic", "chat"],
    ["Gemini", "chat"],
    ["CohereEmbed", "embed"],
    ["CohereRerank", "rerank"],
  ])("maps %s to role %s", (apiType, expectedRole) => {
    expect(getRoleForApiType(apiType)).toBe(expectedRole);
  });

  test("returns undefined for unknown apiType", () => {
    expect(getRoleForApiType("SomeFutureApiType")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(getRoleForApiType("")).toBeUndefined();
  });

  test("is case-sensitive (wire format is exact)", () => {
    expect(getRoleForApiType("openai-compatible")).toBeUndefined();
    expect(getRoleForApiType("anthropic")).toBeUndefined();
  });
});

describe("proxyEndpointToModelDescription", () => {
  test("maps an OpenAI-compatible endpoint", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint(),
      "citt_upk_test-key",
    );

    expect(desc).toEqual({
      // title uses endpoint.id for provider disambiguation; U+FFFF prefix for sort order
      title: "\uFFFF[CITT] azure-gpt-4o",
      provider: "openai",
      underlyingProviderName: "openai",
      // model is endpoint.id (not endpoint.model) for CITT proxy resolution
      model: "azure-gpt-4o",
      apiBase: "https://citt-central-sweden.openai.azure.com/v1",
      apiKey: "citt_upk_test-key",
      requestOptions: { timeout: 60 },
    });
  });

  test("maps an Anthropic endpoint", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        id: "azure-claude-opus-4-5",
        name: "Azure Claude Opus 4.5 (Sweden Central)",
        apiType: "Anthropic",
        model: "claude-opus-4-5",
        apiBase: "https://citt-central-sweden.openai.azure.com/anthropic/v1",
        timeout: 120,
      }),
      "citt_upk_test-key",
    );

    expect(desc?.provider).toBe("anthropic");
    expect(desc?.underlyingProviderName).toBe("anthropic");
    // model is endpoint.id (not endpoint.model) for CITT proxy resolution
    expect(desc?.model).toBe("azure-claude-opus-4-5");
    expect(desc?.requestOptions?.timeout).toBe(120);
  });

  test("maps Gemini, CohereEmbed and CohereRerank to their providers", () => {
    expect(
      proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ apiType: "Gemini" }),
        "key",
      )?.provider,
    ).toBe("gemini");
    expect(
      proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ apiType: "CohereEmbed" }),
        "key",
      )?.provider,
    ).toBe("cohere");
    expect(
      proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ apiType: "CohereRerank" }),
        "key",
      )?.provider,
    ).toBe("cohere");
  });

  test("prefixes title with U+FFFF + server name and uses endpoint.id", () => {
    const desc = proxyEndpointToModelDescription(
      "My Server",
      createEndpoint({ id: "my-endpoint-id" }),
      "key",
    );
    // U+FFFF prefix ensures discovered models sort after manual ones
    expect(desc?.title).toBe("\uFFFF[My Server] my-endpoint-id");
  });

  test("omits requestOptions when timeout is undefined", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ timeout: undefined }),
      "key",
    );
    expect(desc).not.toHaveProperty("requestOptions");
  });

  test("keeps timeout of 0 (falsy but defined)", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ timeout: 0 }),
      "key",
    );
    expect(desc?.requestOptions?.timeout).toBe(0);
  });

  test("returns undefined for unknown apiType", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ apiType: "Unknown" }),
      "key",
    );
    expect(desc).toBeUndefined();
  });
});

describe("collectProxyEndpoints", () => {
  test("collects endpoints from connected servers with full proxy data", () => {
    const endpoint = createEndpoint();
    const result = collectProxyEndpoints([
      createServerStatus({
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [endpoint],
        proxyKey: "key-1",
      }),
    ]);

    expect(result).toEqual([
      { serverId: "citt-mcp", serverName: "CITT", endpoint, proxyKey: "key-1" },
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(collectProxyEndpoints([])).toEqual([]);
  });

  test("skips servers without proxy capability", () => {
    const result = collectProxyEndpoints([
      createServerStatus(),
      createServerStatus({ proxyCapabilities: { proxy: false } }),
    ]);
    expect(result).toEqual([]);
  });

  test("skips servers that are not connected", () => {
    const result = collectProxyEndpoints([
      createServerStatus({
        status: "error",
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [createEndpoint()],
        proxyKey: "key-1",
      }),
    ]);
    expect(result).toEqual([]);
  });

  test("skips servers with proxy capability but missing endpoints or key", () => {
    const result = collectProxyEndpoints([
      createServerStatus({
        proxyCapabilities: { proxy: true },
        proxyKey: "key-1",
      }),
      createServerStatus({
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [createEndpoint()],
      }),
    ]);
    expect(result).toEqual([]);
  });

  test("collects from multiple servers, each with its own key", () => {
    const endpointA = createEndpoint({ id: "a" });
    const endpointB1 = createEndpoint({ id: "b1" });
    const endpointB2 = createEndpoint({ id: "b2" });

    const result = collectProxyEndpoints([
      createServerStatus({
        id: "server-a",
        name: "Server A",
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [endpointA],
        proxyKey: "key-a",
      }),
      createServerStatus({
        id: "server-b",
        name: "Server B",
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [endpointB1, endpointB2],
        proxyKey: "key-b",
      }),
    ]);

    expect(result).toEqual([
      {
        serverId: "server-a",
        serverName: "Server A",
        endpoint: endpointA,
        proxyKey: "key-a",
      },
      {
        serverId: "server-b",
        serverName: "Server B",
        endpoint: endpointB1,
        proxyKey: "key-b",
      },
      {
        serverId: "server-b",
        serverName: "Server B",
        endpoint: endpointB2,
        proxyKey: "key-b",
      },
    ]);
  });

  test("returns empty list for server with proxy support but zero endpoints", () => {
    const result = collectProxyEndpoints([
      createServerStatus({
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [],
        proxyKey: "key-1",
      }),
    ]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverProxyModels + wire format through the tunnel fetch
// ---------------------------------------------------------------------------

const testIdeSettings: IdeSettings = {
  remoteConfigServerUrl: undefined,
  remoteConfigSyncPeriod: 60,
  userToken: "",
  continueTestEnvironment: "none",
  pauseCodebaseIndexOnStart: false,
};

const testLlmLogger: ILLMLogger = {
  createInteractionLog: () => ({ logItem: () => {} }),
};

function createDeps(
  getConnection: (serverId: string) => McpProxyTransport | undefined,
) {
  return {
    readFile: async () => "",
    getUriFromPath: async () => undefined,
    uniqueId: "test-unique-id",
    ideSettings: testIdeSettings,
    llmLogger: testLlmLogger,
    getConnection,
  };
}

interface RecordedCall {
  params: ProxyHttpParams;
  options?: { signal?: AbortSignal; timeout?: number };
}

interface RecordingTransport extends McpProxyTransport {
  calls: RecordedCall[];
}

function createRecordingTransport(
  respond: (params: ProxyHttpParams) => ProxyHttpResponse,
): RecordingTransport {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async proxyHttp(params, options) {
      calls.push({ params, options });
      return respond(params);
    },
    cancelProxyStream() {},
  };
}

async function* emptySseStream(): AsyncGenerator<string> {}

function emptyStreamingResponse(): ProxyHttpResponse {
  return {
    streaming: true,
    status: 200,
    headers: { "content-type": "text/event-stream" },
    streamId: "s_wire",
    chunks: emptySseStream(),
  };
}

function jsonResponse(body: unknown): ProxyHttpResponse {
  return {
    streaming: false,
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function statusWithEndpoint(
  endpoint: ProxyEndpoint,
  proxyKey = "citt_upk_test-key",
): MCPServerStatus {
  return createServerStatus({
    proxyCapabilities: { proxy: true },
    proxyEndpoints: [endpoint],
    proxyKey,
  });
}

async function drainStreamChat(llm: BaseLLM): Promise<void> {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const controller = new AbortController();
  for await (const _ of llm.streamChat(messages, controller.signal, {})) {
    // drain
  }
}

describe("discoverProxyModels", () => {
  test("resolves the tunnel connection by server id", async () => {
    const transport = createRecordingTransport(emptyStreamingResponse);
    const seenServerIds: string[] = [];

    const models = await discoverProxyModels(
      [statusWithEndpoint(createEndpoint())],
      createDeps((serverId) => {
        seenServerIds.push(serverId);
        return transport;
      }),
    );

    expect(seenServerIds).toEqual(["citt-mcp"]);
    expect(models.chat).toHaveLength(1);
    expect(models.chat[0].title).toBe("\uFFFF[CITT] azure-gpt-4o");
  });

  test("skips endpoints whose connection cannot be resolved (no tunnel, no model)", async () => {
    const models = await discoverProxyModels(
      [statusWithEndpoint(createEndpoint())],
      createDeps(() => undefined),
    );

    expect(models.chat).toHaveLength(0);
    expect(models.embed).toHaveLength(0);
    expect(models.rerank).toHaveLength(0);
  });

  test("discovered model sends its traffic through the tunnel, not the network", async () => {
    const transport = createRecordingTransport(emptyStreamingResponse);
    const models = await discoverProxyModels(
      [statusWithEndpoint(createEndpoint())],
      createDeps(() => transport),
    );

    await drainStreamChat(models.chat[0]);

    // Native provider path through the tunnel fetch — the OpenAI adapter
    // (which would go to the real network) is bypassed when customFetch
    // is set.
    expect(transport.calls).toHaveLength(1);
  });
});

describe("wire format through the tunnel fetch", () => {
  test("OpenAI-compatible chat request", async () => {
    const transport = createRecordingTransport(emptyStreamingResponse);
    const models = await discoverProxyModels(
      [statusWithEndpoint(createEndpoint())],
      createDeps(() => transport),
    );

    await drainStreamChat(models.chat[0]);

    const { params, options } = transport.calls[0];
    expect(params.method).toBe("POST");
    expect(params.path).toBe("/v1/chat/completions");
    expect(params.headers?.authorization).toBe("Bearer citt_upk_test-key");
    // X-Citt-Endpoint header ensures reliable routing for all provider types
    expect(params.headers?.["x-citt-endpoint"]).toBe("azure-gpt-4o");

    const body = JSON.parse(params.body!) as {
      model: string;
      stream: boolean;
    };
    // body.model is endpoint.id so CITT proxy can resolve the target
    expect(body.model).toBe("azure-gpt-4o");
    expect(body.stream).toBe(true);

    // Endpoint timeout (seconds) is applied as JSON-RPC timeout (ms).
    expect(options?.timeout).toBe(60_000);
  });

  test("Anthropic chat request", async () => {
    const transport = createRecordingTransport(emptyStreamingResponse);
    const models = await discoverProxyModels(
      [
        statusWithEndpoint(
          createEndpoint({
            id: "azure-claude-opus-4-5",
            name: "Azure Claude Opus 4.5",
            apiType: "Anthropic",
            model: "claude-opus-4-5",
            apiBase: "https://citt.example.com/anthropic/v1",
            timeout: 120,
          }),
        ),
      ],
      createDeps(() => transport),
    );

    await drainStreamChat(models.chat[0]);

    const { params } = transport.calls[0];
    expect(params.method).toBe("POST");
    expect(params.path).toBe("/anthropic/v1/messages");
    expect(params.headers?.["x-api-key"]).toBe("citt_upk_test-key");
    expect(params.headers?.["anthropic-version"]).toBeDefined();

    const body = JSON.parse(params.body!) as {
      model: string;
      stream: boolean;
    };
    // body.model is endpoint.id so CITT proxy can resolve the target
    expect(body.model).toBe("azure-claude-opus-4-5");
    expect(body.stream).toBe(true);
  });

  test("Gemini chat request uses x-goog-api-key header, not a key= query param", async () => {
    const transport = createRecordingTransport(emptyStreamingResponse);
    const models = await discoverProxyModels(
      [
        statusWithEndpoint(
          createEndpoint({
            id: "gemini-flash",
            name: "Gemini Flash",
            apiType: "Gemini",
            model: "gemini-2.0-flash",
            apiBase: "https://citt.example.com/gemini/v1beta",
          }),
        ),
      ],
      createDeps(() => transport),
    );

    await drainStreamChat(models.chat[0]);

    const { params } = transport.calls[0];
    expect(params.method).toBe("POST");
    // Path uses endpoint.id (not endpoint.model) so CITT proxy can resolve.
    expect(params.path).toBe(
      "/gemini/v1beta/models/gemini-flash:streamGenerateContent",
    );
    // Proxy key travels in the header, never as key= query param.
    expect(params.path).not.toContain("key=");
    expect(params.headers?.["x-goog-api-key"]).toBe("citt_upk_test-key");
  });

  test("Cohere embed request", async () => {
    const transport = createRecordingTransport((params) => {
      const { texts } = JSON.parse(params.body!) as { texts: string[] };
      return jsonResponse({
        embeddings: { float: texts.map(() => [0.1, 0.2]) },
      });
    });
    const models = await discoverProxyModels(
      [
        statusWithEndpoint(
          createEndpoint({
            id: "cohere-embed",
            name: "Cohere Embed",
            apiType: "CohereEmbed",
            model: "embed-multilingual-v3.0",
            apiBase: "https://citt.example.com/cohere/v2",
          }),
        ),
      ],
      createDeps(() => transport),
    );

    const embeddings = await models.embed[0].embed(["hello world"]);

    expect(embeddings).toEqual([[0.1, 0.2]]);
    const { params } = transport.calls[0];
    expect(params.method).toBe("POST");
    expect(params.path).toBe("/cohere/v2/embed");
    expect(params.headers?.authorization).toBe("Bearer citt_upk_test-key");
    const body = JSON.parse(params.body!) as {
      model: string;
      texts: string[];
    };
    // body.model is endpoint.id so CITT proxy can resolve the target
    expect(body.model).toBe("cohere-embed");
    expect(body.texts).toEqual(["hello world"]);
  });

  test("Cohere rerank request", async () => {
    const transport = createRecordingTransport((params) => {
      const { documents } = JSON.parse(params.body!) as {
        documents: string[];
      };
      return jsonResponse({
        results: documents.map((_, index) => ({
          index,
          relevance_score: 0.5,
        })),
      });
    });
    const models = await discoverProxyModels(
      [
        statusWithEndpoint(
          createEndpoint({
            id: "cohere-rerank",
            name: "Cohere Rerank",
            apiType: "CohereRerank",
            model: "rerank-multilingual-v3.0",
            apiBase: "https://citt.example.com/cohere/v2",
          }),
        ),
      ],
      createDeps(() => transport),
    );

    const chunks: Chunk[] = [
      {
        content: "first document",
        startLine: 0,
        endLine: 1,
        digest: "d1",
        filepath: "a.ts",
        index: 0,
      },
      {
        content: "second document",
        startLine: 0,
        endLine: 1,
        digest: "d2",
        filepath: "b.ts",
        index: 1,
      },
    ];
    const scores = await models.rerank[0].rerank("query", chunks);

    expect(scores).toEqual([0.5, 0.5]);
    const { params } = transport.calls[0];
    expect(params.method).toBe("POST");
    expect(params.path).toBe("/cohere/v2/rerank");
    expect(params.headers?.authorization).toBe("Bearer citt_upk_test-key");
    const body = JSON.parse(params.body!) as {
      model: string;
      query: string;
      documents: string[];
    };
    // body.model is endpoint.id so CITT proxy can resolve the target
    expect(body.model).toBe("cohere-rerank");
    expect(body.query).toBe("query");
    expect(body.documents).toEqual(["first document", "second document"]);
  });
});
