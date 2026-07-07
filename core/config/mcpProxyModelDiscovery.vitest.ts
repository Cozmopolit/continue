import { describe, expect, test } from "vitest";
import { MCPServerStatus, ProxyEndpoint } from "..";
import {
  collectProxyEndpoints,
  getRoleForApiType,
  proxyEndpointToModelDescription,
} from "./mcpProxyModelDiscovery";

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
    "name" | "status" | "proxyCapabilities" | "proxyEndpoints" | "proxyKey"
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
      title: "[CITT] Azure GPT-4o (Sweden Central)",
      provider: "openai",
      underlyingProviderName: "openai",
      model: "gpt-4o",
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
    expect(desc?.model).toBe("claude-opus-4-5");
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

  test("prefixes title with server name", () => {
    const desc = proxyEndpointToModelDescription(
      "My Server",
      createEndpoint({ name: "Endpoint Name" }),
      "key",
    );
    expect(desc?.title).toBe("[My Server] Endpoint Name");
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
      { serverName: "CITT", endpoint, proxyKey: "key-1" },
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
        name: "Server A",
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [endpointA],
        proxyKey: "key-a",
      }),
      createServerStatus({
        name: "Server B",
        proxyCapabilities: { proxy: true },
        proxyEndpoints: [endpointB1, endpointB2],
        proxyKey: "key-b",
      }),
    ]);

    expect(result).toEqual([
      { serverName: "Server A", endpoint: endpointA, proxyKey: "key-a" },
      { serverName: "Server B", endpoint: endpointB1, proxyKey: "key-b" },
      { serverName: "Server B", endpoint: endpointB2, proxyKey: "key-b" },
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
