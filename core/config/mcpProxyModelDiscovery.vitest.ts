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
  ProxyHttpStreamingResponse,
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
      // Trailing slash ensures new URL("path", apiBase) appends instead of replaces
      apiBase: "https://citt-central-sweden.openai.azure.com/v1/",
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

  test("appends v1 to Anthropic apiBase missing the version segment", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "Anthropic",
        apiBase: "https://host.openai.azure.com/anthropic",
      }),
      "key",
    );
    expect(desc?.apiBase).toBe("https://host.openai.azure.com/anthropic/v1/");
  });

  test("appends v1beta to Gemini apiBase missing the version segment", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "Gemini",
        apiBase: "https://generativelanguage.googleapis.com",
      }),
      "key",
    );
    expect(desc?.apiBase).toBe(
      "https://generativelanguage.googleapis.com/v1beta/",
    );
  });

  test("keeps an already-versioned Anthropic apiBase (idempotent)", () => {
    for (const base of [
      "https://host.openai.azure.com/anthropic/v1",
      "https://host.openai.azure.com/anthropic/v1/",
      "https://host.openai.azure.com/anthropic/v2/",
      "https://host.openai.azure.com/anthropic/V1/",
      "https://host.openai.azure.com/anthropic/v1beta/",
    ]) {
      const desc = proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ apiType: "Anthropic", apiBase: base }),
        "key",
      );
      expect(desc?.apiBase).toBe(base.endsWith("/") ? base : `${base}/`);
    }
  });

  test("keeps an already-versioned Gemini apiBase (idempotent)", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "Gemini",
        apiBase: "https://generativelanguage.googleapis.com/v1beta/",
      }),
      "key",
    );
    expect(desc?.apiBase).toBe(
      "https://generativelanguage.googleapis.com/v1beta/",
    );
  });

  test("appends the version segment when it is not the last path segment", () => {
    // The version check anchors at the end of the path: a version-like
    // segment earlier in the path does not count.
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "Anthropic",
        apiBase: "https://host.example.com/v1/anthropic",
      }),
      "key",
    );
    expect(desc?.apiBase).toBe("https://host.example.com/v1/anthropic/v1/");
  });

  test("does not add a version segment for apiTypes without apiVersionPath", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "OpenAI-compatible",
        apiBase: "https://openrouter.ai/api/v1",
      }),
      "key",
    );
    expect(desc?.apiBase).toBe("https://openrouter.ai/api/v1/");
  });

  test("maps OpenAI-compatible endpoints on openrouter.ai to the openrouter provider", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "OpenAI-compatible",
        apiBase: "https://openrouter.ai/api/v1",
      }),
      "key",
    );
    expect(desc?.provider).toBe("openrouter");
    expect(desc?.underlyingProviderName).toBe("openrouter");
  });

  test("keeps the generic openai provider for non-openrouter hosts", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "OpenAI-compatible",
        apiBase: "https://citt-central-sweden.openai.azure.com/v1",
      }),
      "key",
    );
    expect(desc?.provider).toBe("openai");
    expect(desc?.underlyingProviderName).toBe("openai");
  });

  test("does not remap non-OpenAI-compatible apiTypes by host", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({
        apiType: "Anthropic",
        apiBase: "https://openrouter.ai/api/v1",
      }),
      "key",
    );
    expect(desc?.provider).toBe("anthropic");
  });
});

describe("contextLimit / maxOutputTokens mapping", () => {
  test("maps contextLimit to contextLength", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ contextLimit: 200000 }),
      "key",
    );
    expect(desc?.contextLength).toBe(200000);
  });

  test("maps maxOutputTokens to completionOptions.maxTokens", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ maxOutputTokens: 32000 }),
      "key",
    );
    expect(desc?.completionOptions?.maxTokens).toBe(32000);
  });

  test("maps both fields together", () => {
    const desc = proxyEndpointToModelDescription(
      "CITT",
      createEndpoint({ contextLimit: 1048576, maxOutputTokens: 64000 }),
      "key",
    );
    expect(desc?.contextLength).toBe(1048576);
    expect(desc?.completionOptions?.maxTokens).toBe(64000);
  });

  test.each([undefined, null, 0, -1])(
    "leaves contextLength unset for contextLimit %p",
    (contextLimit) => {
      const desc = proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ contextLimit }),
        "key",
      );
      expect(desc?.contextLength).toBeUndefined();
    },
  );

  test.each([undefined, null, 0, -1])(
    "leaves completionOptions unset for maxOutputTokens %p",
    (maxOutputTokens) => {
      const desc = proxyEndpointToModelDescription(
        "CITT",
        createEndpoint({ maxOutputTokens }),
        "key",
      );
      expect(desc?.completionOptions).toBeUndefined();
    },
  );
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

// OpenAI-native streaming response with protocol-correct termination.
// streamSse (packages/fetch, stream forensics) treats a stream that closes
// without a [DONE] sentinel as a premature end and throws
// PrematureStreamEndError — so the empty mock stream only works for
// provider paths that don't go through the instrumented streamSse.
async function* terminatingSseStream(): AsyncGenerator<string> {
  yield 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"azure-gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
  yield "data: [DONE]\n\n";
}

function terminatingStreamingResponse(): ProxyHttpResponse {
  return {
    ...emptyStreamingResponse(),
    streamId: "s_wire_terminating",
    chunks: terminatingSseStream(),
  };
}

function emptyStreamingResponse(): ProxyHttpStreamingResponse {
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
    const transport = createRecordingTransport(terminatingStreamingResponse);
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
    const transport = createRecordingTransport(terminatingStreamingResponse);
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
    // alt=sse switches Google to one `data:` event per chunk — the tunnel
    // only recognizes text/event-stream, so this is required for streaming.
    expect(params.path).toBe(
      "/gemini/v1beta/models/gemini-flash:streamGenerateContent?alt=sse",
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
