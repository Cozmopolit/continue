# Feature A: MCP-Based Endpoint Discovery

**Status:** Implemented
**Last Updated:** 2026-07-06

## 1. Objective

Replace static config file-based model/endpoint configuration with dynamic discovery from CITT.MCP server via `proxy/endpoints` and `proxy/key` methods.

## 2. Current Continue Architecture

### 2.1 Configuration Flow

```
config.yaml / config.json
        │
        ▼
ConfigHandler (core/config/ConfigHandler.ts)
        │
        ▼
ProfileLifecycleManager → LocalProfileLoader → doLoadConfig
        │
        ▼
loadContinueConfigFromYaml() / loadContinueConfigFromJson()
        │
        ▼
llmFromDescription() / llmsFromModelConfig()
        │
        ▼
BaseLLM instance (with apiKey, apiBase, model, etc.)
```

### 2.2 Key Interfaces

**LLMOptions** (from `core/index.d.ts`):

```typescript
interface LLMOptions {
  model: string;
  title?: string;
  apiKey?: string;
  apiBase?: string;
  // Note: NO provider field - provider is determined by class selection before instantiation
  contextLength?: number;
  completionOptions?: CompletionOptions;
  requestOptions?: RequestOptions;
  // ... many more optional fields
}
```

**JSONModelDescription** (used in config files):

```typescript
interface JSONModelDescription {
  title: string;
  provider: string; // e.g., "openai", "anthropic", "azure"
  underlyingProviderName: string; // Required! Same as provider for direct calls
  model: string; // e.g., "gpt-4", "claude-3-5-sonnet"
  apiKey?: string;
  apiBase?: string;
  contextLength?: number;
  isFromAutoDetect?: boolean;
  // Note: sourceFile is NOT on JSONModelDescription (only on LLMOptions/ModelDescription)
}
```

### 2.3 LLM Instantiation

In `core/llm/llms/index.ts`:

```typescript
const cls = LLMClasses.find((llm) => llm.providerName === desc.provider);
return new cls(options);
```

**Provider Classes** (in `core/llm/llms/`):

- `OpenAI.ts` - providerName: "openai"
- `Anthropic.ts` - providerName: "anthropic"
- `Azure.ts` - providerName: "azure"
- `Gemini.ts` - providerName: "gemini"
- etc.

### 2.4 API Adapter Layer

Continue uses `@continuedev/openai-adapters` package which has adapters for:

- OpenAI (and OpenAI-compatible)
- Anthropic
- Azure
- Gemini
- etc.

## 3. CITT.MCP Proxy Response Format

### `proxy/capabilities`

Returns whether proxy functionality is available:

```json
{ "proxy": true }
```

### `proxy/endpoints`

Returns available endpoints wrapped in an object (MCP SDK requirement):

```json
{
  "endpoints": [
    {
      "id": "azure-gpt-4o",
      "name": "Azure GPT-4o (Sweden Central)",
      "apiType": "OpenAI-compatible",
      "model": "gpt-4o",
      "apiBase": "https://citt-central-sweden.openai.azure.com/v1",
      "timeout": 60
    },
    {
      "id": "azure-claude-opus-4-5",
      "name": "Azure Claude Opus 4.5 (Sweden Central)",
      "apiType": "Anthropic",
      "model": "claude-opus-4-5",
      "apiBase": "https://citt-central-sweden.openai.azure.com/anthropic/v1",
      "timeout": 120
    }
  ]
}
```

### `proxy/key`

Returns the user's proxy key wrapped in an object (MCP SDK requirement):

```json
{
  "key": "citt_upk_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

## 4. Mapping CITT → Continue

| CITT Field           | Continue Field           | Notes                                                        |
| -------------------- | ------------------------ | ------------------------------------------------------------ |
| server name + `name` | `title`                  | Display name with server prefix: `[ServerName] EndpointName` |
| `apiType`            | `provider`               | **Requires mapping** (see below)                             |
| `apiType`            | `underlyingProviderName` | Same value as `provider` after mapping (required field)      |
| `model`              | `model`                  | Direct mapping                                               |
| `apiBase`            | `apiBase`                | Direct mapping                                               |
| `timeout`            | `requestOptions.timeout` | Direct mapping (both use seconds)                            |
| proxy key            | `apiKey`                 | From `proxy/key` response                                    |

### 4.1 ApiType → Provider Mapping

**Chat/Completion Models** (go into `models`):

| CITT apiType        | Continue provider |
| ------------------- | ----------------- |
| `OpenAI-compatible` | `openai`          |
| `Anthropic`         | `anthropic`       |
| `Gemini`            | `gemini`          |

**Embedding/Reranking** (go into `modelsByRole`):

| CITT apiType   | Continue modelsByRole | Continue provider |
| -------------- | --------------------- | ----------------- |
| `CohereEmbed`  | `modelsByRole.embed`  | `cohere`          |
| `CohereRerank` | `modelsByRole.rerank` | `cohere`          |

Continue uses the same LLM classes for all model types, configured via `modelsByRole`:

- `modelsByRole.chat` - chat/completion models
- `modelsByRole.embed` - embeddings (if not user-configured)
- `modelsByRole.rerank` - reranking (if not user-configured)

## 5. Integration Concept

### Key Insight: No Extra Configuration Needed

CITT.MCP is **already configured** as an MCP server in Continue. The integration should:

1. **Detect proxy capability** on existing MCP servers (via `proxy/capabilities`)
2. **Auto-discover endpoints** from servers that support it
3. **Inject discovered models** into the model list

### Flow

```
MCP Server connects (existing flow)
        ↓
Connection handshake complete
        ↓
SYNCHRONOUS: Call proxy/capabilities
        ↓
If proxy: true:
  → SYNCHRONOUS: Fetch endpoints + key
  → Store all data on connection state
        ↓
Set status = "connected"
        ↓
Status change triggers config reload
        ↓
doLoadConfig() reads proxy data from status, transforms to ILLM instances
        ↓
Models appear in UI
```

**Why synchronous?** A fire-and-forget capability check would complete AFTER the config reload is triggered by `status = "connected"`. This creates a race condition: `doLoadConfig()` reads `proxyCapabilities` while it's still undefined, skips discovery, and no second reload is triggered. Making the check synchronous ensures proxy data is available when the reload happens. The added latency (~100-500ms for 2-3 RPC calls) is negligible compared to MCP connection timeouts (10-60s).

### Where to Hook In

**Proxy Check & Fetch:** In `MCPConnection.connectClient()`, BEFORE setting `status = "connected"`. The proxy calls are synchronous with short timeouts. Errors are logged but don't fail the connection.

**Discovery:** In `doLoadConfig()`, BEFORE model selection rectification. Discovery reads proxy data from status snapshots and transforms to ILLM instances.

## 6. MCP Client Access

Continue already has MCP client infrastructure in:

- `core/context/mcp/MCPConnection.ts`
- `core/context/mcp/MCPManagerSingleton.ts`

We need to extend this to support custom methods like `proxy/endpoints`.

### 6.1 Current MCP Usage

MCP is currently used for:

- Tools (via `tools/call`)
- Context Providers (via `resources/read`)
- Prompts (via `prompts/get`)

### 6.2 Required Extension

Add a generic `callMethod()` to `MCPConnection` that wraps the SDK's `client.request()`. This method should:

- Accept method name, params, and a Zod schema for response validation
- Support AbortSignal and timeout options
- Delegate to the underlying MCP SDK client

## 7. MCP SDK Foundation

The MCP SDK's `Client` class provides a generic `request()` method that accepts a method name, params, and Zod schema for validation. This is already used internally by `listTools()`, `readResource()`, etc.

For CITT proxy methods, define Zod schemas matching the actual wire format (see §3):

- `proxy/capabilities`: `z.object({ proxy: z.boolean() })`
- `proxy/endpoints`: `z.object({ endpoints: z.array(ProxyEndpointSchema) })` where each endpoint has `id`, `name`, `apiType`, `model`, `apiBase`, `timeout` (timeout optional for resilience)
- `proxy/key`: `z.object({ key: z.string() })`

**Note:** MCP SDK requires object-wrapped results (not bare strings/arrays).

## 8. Implementation Plan

### Phase 1: Extend MCPConnection

Add to `core/context/mcp/MCPConnection.ts`:

1. **Generic RPC method** (`callMethod`) - wraps SDK's `client.request()` with schema validation
2. **Proxy state on connection** - `proxyCapabilities`, `proxyEndpoints`, `proxyKey` (all fetched synchronously during connect)
3. **Synchronous proxy check** - called BEFORE setting `status = "connected"`, with short timeouts
4. **Cache invalidation** - clear proxy state on reconnect (in existing reset block) and disconnect

**Timing:** The proxy check runs synchronously before the connection is considered complete. Errors are logged but swallowed - a failing proxy check means no discovered models, not a failed MCP connection.

### Phase 2: Extend MCPServerStatus

Add proxy fields to `MCPServerStatus` type in `core/index.d.ts`:

```typescript
proxyCapabilities?: { proxy: boolean };
proxyEndpoints?: ProxyEndpoint[];  // Already fetched during connect
proxyKey?: string;                  // Already fetched during connect
```

Update `getStatus()` in MCPConnection to include these fields. Since data is fetched synchronously during connect, it's available in the status snapshot.

### Phase 3: Discovery Function

Create a discovery function that:

1. Iterates MCP server statuses with `proxyCapabilities.proxy === true`
2. Reads `proxyEndpoints` and `proxyKey` from each status (already fetched during connect)
3. Routes endpoints by `apiType`:
   - Chat models (`OpenAI-compatible`, `Anthropic`, `Gemini`) → `modelsByRole.chat`
   - Embeddings (`CohereEmbed`) → `modelsByRole.embed` (if not user-configured)
   - Reranker (`CohereRerank`) → `modelsByRole.rerank` (if not user-configured)
4. Transforms to ILLM instances using the mapping from §4
5. Prefixes title with server name: `[ServerName] EndpointName`

### Phase 4: Integration Point

**Location:** `core/config/profile/doLoadConfig.ts`, BEFORE model selection rectification.

**Why here:**

- MCP servers are already connected and statuses available
- Discovered models must be present before `rectifySelectedModelsFromGlobalContext()` runs, otherwise previously selected discovered models won't be restored

## 9. Files to Modify

- `core/context/mcp/MCPConnection.ts` - Add `callMethod()`, proxy state fields, synchronous proxy check in `connectClient()`, cache reset in `connectClient()` and `disconnect()`
- `core/index.d.ts` - Extend `MCPServerStatus` with `proxyCapabilities`, `proxyEndpoints`, `proxyKey`
- `core/config/profile/doLoadConfig.ts` - Add discovery before model selection rectification

## 10. Related Specifications

- **CITT.MCP Wire Format:** See `CITT-Solution/CITT/docs/specifications/mcp-proxy-wire-format.md` for the CITT.MCP side of the protocol.
