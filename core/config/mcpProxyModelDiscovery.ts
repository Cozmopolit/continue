import {
  IdeSettings,
  ILLMLogger,
  JSONModelDescription,
  MCPServerStatus,
  ProxyEndpoint,
} from "..";
import {
  createMcpProxyFetch,
  McpProxyTransport,
} from "../context/mcp/mcpProxyFetch";
import { BaseLLM } from "../llm";
import { llmFromDescription } from "../llm/llms";

/**
 * Model roles that MCP proxy endpoints can be discovered for.
 * Subset of Continue's ModelRole.
 */
export type ProxyModelRole = "chat" | "embed" | "rerank";

interface ApiTypeMapping {
  provider: string;
  role: ProxyModelRole;
  /**
   * API version segment the provider class expects as the last apiBase
   * path segment ("v1" for Anthropic, "v1beta" for Gemini). CITT serves
   * apiBase without it; appended during discovery when missing.
   */
  apiVersionPath?: string;
}

/**
 * Maps CITT apiType values to Continue provider names and model roles.
 * Unknown apiTypes are skipped during discovery (forward compatibility).
 */
const API_TYPE_MAPPINGS: Record<string, ApiTypeMapping> = {
  "OpenAI-compatible": { provider: "openai", role: "chat" },
  Anthropic: { provider: "anthropic", role: "chat", apiVersionPath: "v1" },
  Gemini: { provider: "gemini", role: "chat", apiVersionPath: "v1beta" },
  CohereEmbed: { provider: "cohere", role: "embed" },
  CohereRerank: { provider: "cohere", role: "rerank" },
};

/**
 * Returns the Continue model role for a CITT apiType,
 * or undefined for unknown apiTypes.
 */
export function getRoleForApiType(apiType: string): ProxyModelRole | undefined {
  return API_TYPE_MAPPINGS[apiType]?.role;
}

/**
 * Appends the API version segment to apiBase unless the path already ends
 * in a version segment (v1, v1beta, v2, ...). apiBase must end with "/".
 */
function ensureVersionSegment(apiBase: string, version: string): string {
  return /\/v\d+[a-z]*\/$/i.test(apiBase) ? apiBase : `${apiBase}${version}/`;
}

/**
 * Transforms a discovered proxy endpoint into a Continue model description.
 * Returns undefined for unknown apiTypes.
 */
export function proxyEndpointToModelDescription(
  serverName: string,
  endpoint: ProxyEndpoint,
  proxyKey: string,
): JSONModelDescription | undefined {
  const mapping = API_TYPE_MAPPINGS[endpoint.apiType];
  if (!mapping) {
    return undefined;
  }

  // Ensure apiBase ends with trailing slash. Without it, `new URL("path", apiBase)`
  // replaces the last path segment instead of appending:
  //   new URL("embed", "https://host/v2")  → "https://host/embed"  (WRONG)
  //   new URL("embed", "https://host/v2/") → "https://host/v2/embed" (correct)
  // This affects Cohere embed/rerank and other providers that construct URLs this way.
  let apiBase = endpoint.apiBase.endsWith("/")
    ? endpoint.apiBase
    : `${endpoint.apiBase}/`;

  // CITT serves apiBase without the API version segment (e.g.
  // "https://host/anthropic"), but the provider classes expect it as the
  // last apiBase segment (Anthropic: new URL("messages", ".../v1/");
  // Gemini: new URL("models/...", ".../v1beta/")). Without it the tunneled
  // request 404s (verified against the live CITT proxy). Idempotent: a
  // base already ending in a version segment stays untouched.
  if (mapping.apiVersionPath) {
    apiBase = ensureVersionSegment(apiBase, mapping.apiVersionPath);
  }

  return {
    // Use endpoint.id in title so users can distinguish providers
    // (e.g., azure-claude-opus vs anthropic-claude-opus vs openrouter-claude-opus)
    // U+FFFF prefix: invisible noncharacter that localeCompare() sorts after
    // all real letters, so discovered models appear after manually configured
    // ones in the GUI's alphabetically sorted model picker.
    title: `\uFFFF[${serverName}] ${endpoint.id}`,
    provider: mapping.provider,
    underlyingProviderName: mapping.provider,
    // Use endpoint.id (not endpoint.model) so the CITT proxy can resolve
    // the target endpoint from the request body's "model" field.
    model: endpoint.id,
    apiBase,
    apiKey: proxyKey,
    ...(endpoint.timeout !== undefined && {
      requestOptions: { timeout: endpoint.timeout },
    }),
  };
}

/**
 * Extracts (server id, server name, endpoint, key) tuples from MCP server
 * statuses that advertise proxy support and have complete proxy data.
 */
export function collectProxyEndpoints(
  serverStatuses: Pick<
    MCPServerStatus,
    | "id"
    | "name"
    | "status"
    | "proxyCapabilities"
    | "proxyEndpoints"
    | "proxyKey"
  >[],
): {
  serverId: string;
  serverName: string;
  endpoint: ProxyEndpoint;
  proxyKey: string;
}[] {
  return serverStatuses
    .filter(
      (server) =>
        server.status === "connected" &&
        server.proxyCapabilities?.proxy === true &&
        server.proxyEndpoints !== undefined &&
        server.proxyKey !== undefined,
    )
    .flatMap((server) =>
      server.proxyEndpoints!.map((endpoint) => ({
        serverId: server.id,
        serverName: server.name,
        endpoint,
        proxyKey: server.proxyKey!,
      })),
    );
}

export interface ProxyModelDiscoveryDeps {
  readFile: (filepath: string) => Promise<string>;
  getUriFromPath: (path: string) => Promise<string | undefined>;
  uniqueId: string;
  ideSettings: IdeSettings;
  llmLogger: ILLMLogger;
  /**
   * Resolves the MCP connection whose stdio tunnel carries the traffic of
   * a discovered model. Returns undefined when the server disconnected in
   * the meantime — the endpoint is then skipped (no tunnel, no model).
   */
  getConnection: (serverId: string) => McpProxyTransport | undefined;
}

/**
 * Discovers LLM instances from MCP servers that support proxy-based
 * endpoint discovery (proxy/capabilities, proxy/endpoints, proxy/key).
 *
 * Endpoints with unknown apiTypes and endpoints whose provider cannot be
 * instantiated are silently skipped.
 */
export async function discoverProxyModels(
  serverStatuses: MCPServerStatus[],
  deps: ProxyModelDiscoveryDeps,
): Promise<Record<ProxyModelRole, BaseLLM[]>> {
  const result: Record<ProxyModelRole, BaseLLM[]> = {
    chat: [],
    embed: [],
    rerank: [],
  };

  for (const {
    serverId,
    serverName,
    endpoint,
    proxyKey,
  } of collectProxyEndpoints(serverStatuses)) {
    const role = getRoleForApiType(endpoint.apiType);
    const desc = proxyEndpointToModelDescription(
      serverName,
      endpoint,
      proxyKey,
    );
    if (!role || !desc) {
      continue;
    }

    // Discovered models are tunnel-only (decision #1 of the tunneling
    // spec, see proxy-http-tunneling.md) — without a live
    // connection there is no transport, so the endpoint is skipped.
    const connection = deps.getConnection(serverId);
    if (!connection) {
      continue;
    }
    const tunnelFetch = createMcpProxyFetch(connection, {
      timeout: endpoint.timeout,
      endpointId: endpoint.id,
    });

    try {
      const llm = await llmFromDescription(
        desc,
        deps.readFile,
        deps.getUriFromPath,
        deps.uniqueId,
        deps.ideSettings,
        deps.llmLogger,
        undefined,
        { customFetch: tunnelFetch },
      );
      if (llm) {
        result[role].push(llm);
      }
    } catch (e) {
      console.warn(
        `Failed to instantiate discovered model "${desc.title}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  return result;
}
