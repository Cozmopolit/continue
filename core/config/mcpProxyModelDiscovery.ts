import {
  IdeSettings,
  ILLMLogger,
  JSONModelDescription,
  MCPServerStatus,
  ProxyEndpoint,
} from "..";
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
}

/**
 * Maps CITT apiType values to Continue provider names and model roles.
 * Unknown apiTypes are skipped during discovery (forward compatibility).
 */
const API_TYPE_MAPPINGS: Record<string, ApiTypeMapping> = {
  "OpenAI-compatible": { provider: "openai", role: "chat" },
  Anthropic: { provider: "anthropic", role: "chat" },
  Gemini: { provider: "gemini", role: "chat" },
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

  return {
    title: `[${serverName}] ${endpoint.name}`,
    provider: mapping.provider,
    underlyingProviderName: mapping.provider,
    model: endpoint.model,
    apiBase: endpoint.apiBase,
    apiKey: proxyKey,
    ...(endpoint.timeout !== undefined && {
      requestOptions: { timeout: endpoint.timeout },
    }),
  };
}

/**
 * Extracts (server name, endpoint, key) triples from MCP server statuses
 * that advertise proxy support and have complete proxy data.
 */
export function collectProxyEndpoints(
  serverStatuses: Pick<
    MCPServerStatus,
    "name" | "status" | "proxyCapabilities" | "proxyEndpoints" | "proxyKey"
  >[],
): { serverName: string; endpoint: ProxyEndpoint; proxyKey: string }[] {
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

  for (const { serverName, endpoint, proxyKey } of collectProxyEndpoints(
    serverStatuses,
  )) {
    const role = getRoleForApiType(endpoint.apiType);
    const desc = proxyEndpointToModelDescription(
      serverName,
      endpoint,
      proxyKey,
    );
    if (!role || !desc) {
      continue;
    }

    try {
      const llm = await llmFromDescription(
        desc,
        deps.readFile,
        deps.getUriFromPath,
        deps.uniqueId,
        deps.ideSettings,
        deps.llmLogger,
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
