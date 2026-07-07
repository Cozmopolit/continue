# Feature B: Chat Completions via MCP HTTP Tunnel

**Status:** Draft
**Last Updated:** 2026-02-10

## 1. Objective

Route all LLM API calls (chat, embeddings, rerank) for models discovered
via Feature A ([endpoint-discovery.md](./endpoint-discovery.md)) through
the CITT.MCP stdio tunnel (`proxy/http`) instead of direct HTTP.

**Why:** In the corporate environment, localhost loopback is blocked and
clients have no direct network path to LLM providers. stdio is the only
viable transport. The discovered models currently carry a real provider
`apiBase` and the proxy key as `apiKey` — direct HTTP calls with these
credentials cannot succeed. Feature A without Feature B produces models
that appear in the UI but cannot complete a single request.

## 2. Decisions (agreed upfront)

| #   | Decision                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Always tunnel.** Discovered CITT endpoints never make direct HTTP calls. No hybrid/fallback mode.                                                                                                                            |
| 2   | **Lifecycle cleanup.** On MCP reconnect/disconnect, all active tunnel streams are terminated with an error and the stream registry is cleared.                                                                                 |
| 3   | **Abort semantics.** On `AbortSignal`: terminate the local stream immediately, send `proxy/cancel` fire-and-forget, silently discard late chunks for that `streamId` (spec: best-effort cancellation, late chunks acceptable). |
| 4   | **Testing.** Automated unit + wire-format tests are the lasting safety net. One-time manual verification against real CITT.MCP is part of the implementation task's definition of done (see §9).                               |
| 5   | **openai-adapters injection.** Add an optional `fetch` field to the adapter config in `packages/openai-adapters` (in-repo package, consumed via `file:` dependency — no external fork needed).                                 |

## 3. CITT.MCP Wire Protocol (relevant subset)

Full protocol: `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/specifications/citt.mcp-proxy-exposure.md`
and `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/developer-guides/mcp-llm-proxy-client-guide.md`.

### `proxy/http` request

```typescript
interface ProxyHttpParams {
  method: string; // "POST", "GET"
  path: string; // "/v1/chat/completions" (incl. query string)
  headers?: Record<string, string>; // Must include Authorization: Bearer {proxy_key}
  body?: string; // JSON string
}
```

- The client builds the HTTP request **exactly** as it would for a direct
  call. The server constructs a full URI with a dummy host — the host is
  ignored. Endpoint selector resolution (priority order, verified in
  `CITT.Library/LlmProxy/ProxyRequest.cs`): body `model` field →
  `X-Citt-Endpoint` header → Gemini URL path (`/v1beta/models/{model}:`).
- Proxy key header names accepted: `Authorization: Bearer`, `x-api-key`,
  `api-key`, `x-goog-api-key`.

### `proxy/http` response (non-streaming)

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{...}"
}
```

HTTP errors (4xx/5xx) are returned the same way — as a result with error
status, **not** as JSON-RPC errors. JSON-RPC errors (`-32601` etc.) only
occur for protocol-level problems.

### `proxy/http` response (streaming, `"stream":true` in body)

1. Immediate result: `{ "status": 200, "headers": {...}, "streaming": true, "streamId": "s_abc" }`
2. Notifications `proxy/http/chunk`: `{ "streamId": "s_abc", "data": "data: {...}\n\n" }`
   — `data` is the **raw SSE line** including `data: ` prefix and trailing `\n\n`
3. Terminal notification: `proxy/http/done` (success) **or** `proxy/http/error`
   (`{ "streamId", "error": { "code", "message" } }`) — never both

### `proxy/cancel`

`{ "streamId": "s_abc" }` → `{ "cancelled": true }` (or `false` with `reason`).
Best-effort; late chunks may still arrive and must be ignored.

## 4. Continue Architecture: Where HTTP Happens

All LLM traffic flows through exactly **two paths**, both bottoming out in
`fetchwithRequestOptions` (`packages/fetch`):

### Path 1: `BaseLLM.fetch()` (`core/llm/index.ts`)

Used by provider classes with their own `_streamChat`/`_embed`/`_rerank`
implementations (Anthropic, Gemini, Cohere, …). `BaseLLM.fetch()` wraps
`fetchwithRequestOptions` with error mapping (`parseError`) and
`withExponentialBackoff`.

### Path 2: `openaiAdapter` (`packages/openai-adapters`)

Used when `shouldUseOpenAIAdapter()` returns true (notably the OpenAI
class). `BaseLLM.createOpenAiAdapter()` calls `constructLlmApi(config)`;
the adapters build their fetch **internally** via
`customFetch(config.requestOptions)` (`packages/openai-adapters/src/util.ts`).
The OpenAI adapter passes it straight into the OpenAI SDK client:

```typescript
// packages/openai-adapters/src/apis/OpenAI.ts (today)
new OpenAI({ apiKey, baseURL, fetch: customFetch(config.requestOptions), ... });
```

There is currently **no way to inject a custom fetch** into Path 2 — this
is the reason for decision #5.

### Key insight

Intercepting at fetch level means **zero changes to provider classes**
and zero new API semantics — the exact principle of the CITT spec
("clients build standard HTTP requests"). Embeddings and rerank are not
special cases; they are just other paths (`/v1/embeddings`, `/rerank`)
through the same tunnel, and non-streaming (the simpler code path).

## 5. Solution Design

```
Provider class / openai-adapter          (unchanged, unaware of tunnel)
        │ fetch(url, init)
        ▼
createMcpProxyFetch(connection, opts)    NEW: fetch semantics ↔ ProxyHttpParams
        │ { method, path, headers, body }
        ▼
MCPConnection.proxyHttp(params, signal)  NEW: JSON-RPC + stream dispatch
        │ stdio
        ▼
CITT.MCP → ProxyService → Provider
```

### 5.1 MCPConnection extensions (`core/context/mcp/MCPConnection.ts`)

**Notification handlers.** Register handlers on the SDK `Client` for
`proxy/http/chunk`, `proxy/http/done`, `proxy/http/error` via
`client.setNotificationHandler(schema, handler)` with Zod schemas
(`method: z.literal(...)`). Handlers dispatch by `streamId` to a registry.

**Stream registry.**

```typescript
enum ProxyStreamState {
  Active = "active",
  Cancelled = "cancelled",
}

interface ProxyStreamEntry {
  state: ProxyStreamState;
  onChunk: (data: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

private activeProxyStreams = new Map<string, ProxyStreamEntry>();
```

Notifications for unknown or `Cancelled` streamIds are silently discarded
(decision #3 — late chunks after cancel must not throw).

**`proxyHttp(params, options)`** sends `proxy/http` via the existing
`callMethod()` and validates the result against a union schema:

```typescript
const ProxyHttpResultSchema = z.object({
  status: z.number(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(), // non-streaming
  streaming: z.boolean().optional(), // streaming
  streamId: z.string().optional(),
});
```

- Non-streaming result (`streaming` absent): return `{status, headers, body}`.
- Streaming result: register the streamId in the registry and return
  `{status, headers, chunks: AsyncIterable<string>}` where the iterable is
  fed by the notification handlers.

**`cancelProxyStream(streamId)`**: set registry state to `Cancelled`,
terminate the local iterable, send `proxy/cancel` fire-and-forget
(errors logged, never thrown).

**Request timeout:** the JSON-RPC `proxy/http` request itself completes
quickly for streaming (initial response confirms stream start). For
non-streaming requests, use the endpoint timeout (or a generous default,
e.g. `DEFAULT_MCP_TOOL_CALL_TIMEOUT`) — chat completions can take minutes.

**Lifecycle (decision #2):** in the reconnect reset block of
`connectClient()` and in `disconnect()`: call `onError(new Error("MCP
connection closed"))` for every `Active` entry, then clear the registry.

### 5.2 Tunnel fetch (`core/context/mcp/mcpProxyFetch.ts`, NEW)

```typescript
interface McpProxyFetchOptions {
  timeout?: number; // seconds, from endpoint.timeout
}

function createMcpProxyFetch(
  connection: MCPConnection,
  options?: McpProxyFetchOptions,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

Behavior:

1. **Request translation:** `path` = `url.pathname + url.search` (query
   string preserved — Gemini uses `?alt=sse` etc.). Headers taken from
   `init` verbatim. Body passed through as string.
2. **Non-streaming:** build a standard `Response` from
   `{status, headers, body}` (global/undici `Response` — `streamSse`,
   `resp.ok`, `resp.text()` all work with it). HTTP errors (4xx/5xx)
   become a `Response` with that status — **not** an exception. The
   existing error mapping in `BaseLLM.fetch()` / the SDK handles them
   exactly as with direct HTTP.
3. **Streaming:** build a `Response` whose body is a `ReadableStream`
   fed by the chunk iterable (raw SSE bytes, UTF-8 encoded).
   `streamSse()` (`packages/fetch/src/stream.ts`) consumes
   `response.body` via `ReadableStream.from()` — no changes needed there.
   `proxy/http/error` → error the stream (iteration throws).
4. **Abort (decision #3):** on `init.signal` abort: error the body stream
   with an `AbortError`, call `cancelProxyStream(streamId)`
   fire-and-forget.

Pure helpers, exported for testing:

- `buildProxyHttpParams(url, init): ProxyHttpParams`
- `responseFromProxyResult(result): Response`

**Note on retries:** `BaseLLM.fetch()` wraps calls in
`withExponentialBackoff`. This stays as-is — the CITT proxy does its own
retry/throttling server-side; occasional client-side retries of failed
tunnel calls are harmless.

**Note on `requestOptions.headers`:** direct HTTP merges
`requestOptions.headers` inside `fetchwithRequestOptions`, which the
tunnel bypasses. For discovered models this is irrelevant (their
`requestOptions` are generated by discovery and contain only `timeout`),
but it is a documented limitation of the tunnel fetch.

### 5.3 Injection Path 1: `BaseLLM` (`core/llm/index.ts`)

Extend `LLMOptions` (`core/index.d.ts`):

```typescript
/** Overrides network transport (e.g. MCP stdio tunnel). Programmatic only — not configurable via YAML/JSON. */
customFetch?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
```

In `BaseLLM.fetch()`, substitute the inner `fetchwithRequestOptions` call
with `this.customFetch` when set. Error mapping (`parseError`, status
checks) and `withExponentialBackoff` remain wrapped around it unchanged.

### 5.4 Injection Path 2: `packages/openai-adapters` (decision #5)

1. **`src/types.ts`:** add to `BasePlusConfig`:

   ```typescript
   fetch: z.custom<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>().optional(),
   ```

2. **`src/util.ts`:** `customFetch` gets an optional override parameter:

   ```typescript
   export function customFetch(
     requestOptions: RequestOptions | undefined,
     fetchOverride?: typeof patchedFetch,
   ): typeof patchedFetch {
     if (fetchOverride) return fetchOverride;
     // ... existing behavior unchanged
   }
   ```

3. **Adapter call sites:** change `customFetch(this.config.requestOptions)`
   to `customFetch(this.config.requestOptions, this.config.fetch)`.
   Required for the adapters behind CITT apiTypes: **OpenAI, Anthropic,
   Gemini, Cohere, Azure**. Remaining adapters may be updated mechanically
   in the same pass or left as-is (they are unreachable for discovered
   models).

4. **`core/llm/index.ts` `createOpenAiAdapter()`:** pass
   `fetch: this._llmOptions.customFetch` into `constructLlmApi()`.

This is an additive change to an in-repo package (`file:` dependency from
`core`), built by the existing pipeline. Upstream merge risk: low.

### 5.5 Discovery wiring (`core/config/mcpProxyModelDiscovery.ts`)

1. `collectProxyEndpoints` additionally returns the server `id`
   (`MCPServerStatus` includes it via `InternalMcpOptions`).
2. `ProxyModelDiscoveryDeps` gets an injectable resolver (testability —
   no singleton access inside the pure module):

   ```typescript
   getConnection: (serverId: string) => MCPConnection | undefined;
   ```

   `doLoadConfig.ts` passes
   `(id) => MCPManagerSingleton.getInstance().getConnection(id)`.

3. Per endpoint, `discoverProxyModels` creates a tunnel fetch:

   ```typescript
   const tunnelFetch = createMcpProxyFetch(connection, {
     timeout: endpoint.timeout,
   });
   ```

   and passes it into instantiation. `llmFromDescription()`
   (`core/llm/llms/index.ts`) gets an optional
   `overrides?: Partial<LLMOptions>` parameter merged into the final
   options (`{ ...desc, ..., ...overrides }`).

4. If `getConnection` returns `undefined` (race with disconnect), the
   endpoint is skipped — consistent with decision #1: no tunnel, no model.

**Endpoint routing: standard `model` selector only — no special handling.**
The CITT proxy resolves the endpoint selector from three sources in
priority order (verified in `CITT.Library/LlmProxy/ProxyRequest.cs`,
`CreateFromIncomingAsync`):

1. Body `model` field (`ExtractEndpointFromBody`)
2. `X-Citt-Endpoint` header (`ExtractHeader`)
3. URL path pattern `/v1beta/models/{model}:` (`ExtractEndpointFromUrlPath`)
   — built for Gemini; the proxy even rewrites the path with the real
   provider `ModelId` before forwarding upstream

`model` values are unique per CITT instance, and each MCP connection
tunnels to exactly one instance, so no ambiguity is possible. Discovered
models keep `model: endpoint.model` (unchanged from Feature A):
OpenAI-compatible, Anthropic and Cohere send it in the body (source 1),
Gemini encodes it in the URL path (source 3). All mapped apiTypes route
via the standard mechanism — the tunnel never sets `X-Citt-Endpoint`.
Keeping `model: endpoint.model` also keeps `findLlmInfo()` autodetection
(context length etc.) working, which relies on real model names like
`gpt-4o`.

`apiKey` (= proxy key) needs no special handling either — provider
classes/SDKs place it in `Authorization`/`x-api-key`/`x-goog-api-key`
headers as usual, and the tunnel forwards headers verbatim.

## 6. What Does NOT Change

- Provider classes (`core/llm/llms/*.ts`) — zero changes
- SSE parsing (`packages/fetch/src/stream.ts`) — consumes the synthetic
  `Response` as-is
- CITT.MCP server side — Feature B is a pure client implementation
- Feature A discovery data flow (statuses, sync fetch during connect)
- YAML/JSON-configured models — `customFetch` is programmatic-only

## 7. Implementation Plan

### Phase 1: openai-adapters fetch injection

`packages/openai-adapters`: `types.ts` (config field), `util.ts`
(override param), adapter call sites (OpenAI, Anthropic, Gemini, Cohere,
Azure). Independently testable, no behavior change when `fetch` unset.

### Phase 2: BaseLLM customFetch

`core/index.d.ts` (`LLMOptions.customFetch`), `core/llm/index.ts`
(`fetch()` substitution + `createOpenAiAdapter()` pass-through),
`core/llm/llms/index.ts` (`llmFromDescription` overrides param).

### Phase 3: MCPConnection tunnel transport

Notification handlers, stream registry, `proxyHttp()`,
`cancelProxyStream()`, lifecycle cleanup in reconnect/disconnect.

### Phase 4: Tunnel fetch + discovery wiring

`mcpProxyFetch.ts` (new), `mcpProxyModelDiscovery.ts` (server id,
`getConnection` dep, tunnel fetch per endpoint), `doLoadConfig.ts`
(resolver).

## 8. Files to Modify

- `packages/openai-adapters/src/types.ts` — Optional `fetch` on `BasePlusConfig`
- `packages/openai-adapters/src/util.ts` — `customFetch` override parameter
- `packages/openai-adapters/src/apis/{OpenAI,Anthropic,Gemini,Cohere,Azure}.ts` — Pass `config.fetch` to `customFetch`
- `core/index.d.ts` — `LLMOptions.customFetch`
- `core/llm/index.ts` — Use `customFetch` in `BaseLLM.fetch()`; forward to `constructLlmApi`
- `core/llm/llms/index.ts` — `llmFromDescription` optional `overrides` param
- `core/context/mcp/MCPConnection.ts` — Notification handlers, stream registry, `proxyHttp`, `cancelProxyStream`, lifecycle cleanup
- `core/context/mcp/mcpProxyFetch.ts` — **NEW** — tunnel fetch factory + pure helpers
- `core/context/mcp/mcpProxyFetch.vitest.ts` — **NEW** — unit tests
- `core/config/mcpProxyModelDiscovery.ts` — Server id, `getConnection` dep, attach tunnel fetch
- `core/config/mcpProxyModelDiscovery.vitest.ts` — Extend tests
- `core/config/profile/doLoadConfig.ts` — Pass connection resolver

## 9. Testing (decision #4)

### Automated (lasting safety net)

**Unit tests — `mcpProxyFetch.vitest.ts`** (mocked `MCPConnection`):

- `buildProxyHttpParams`: URL decomposition (path + query string), header
  merge incl. `extraHeaders` precedence, body pass-through, method
- Non-streaming: 200 → Response with parseable JSON body; 429/503 →
  Response with that status (no exception); header round-trip
- Streaming: chunk notifications → `streamSse()` over the synthetic
  Response yields the parsed objects; `done` terminates cleanly
- `proxy/http/error` mid-stream → body iteration throws
- Abort mid-stream → body errors with `AbortError`, `proxy/cancel` sent,
  late chunks discarded without throwing
- Edge cases: empty body, missing headers, `stream:true` request answered
  non-streaming (immediate HTTP error per CITT spec)

**Unit tests — `MCPConnection`** (extend existing suite):

- Registry dispatch by streamId; unknown/cancelled streamIds ignored
- Lifecycle: reconnect/disconnect errors out active streams, clears registry

**Wire-format tests:** instantiate discovered models (OpenAI, Anthropic,
Gemini chat; Cohere embed/rerank) with a capturing fake tunnel fetch,
invoke `streamChat`/`embed`/`rerank`, assert the captured
`ProxyHttpParams`: correct path, endpoint selector via standard routing
(`model` field in the body for OpenAI/Anthropic/Cohere; model segment in
the URL path for Gemini), `X-Citt-Endpoint` header **never** set, proxy
key in auth header, body shape. This covers embeddings/rerank explicitly
and catches the most realistic failure: wrong apiBase→path decomposition.

**Discovery tests:** tunnel fetch attached per endpoint; endpoint skipped
when connection unresolvable.

### Manual — one-time, definition of done for the implementation task

Against real CITT.MCP in VS Code:

1. Chat with a discovered model — streaming output + Stop Generation
2. Non-streaming HTTP error surfaces as a readable error (e.g. invalid key)
3. Codebase indexing on a small repo (embed path)
4. `@codebase` query with reranker configured (rerank path)

Not a recurring process, not a spec artifact — done once, then the
automated tests carry the weight.

## 10. Open Risks

- **Global `Response` availability:** the tunnel builds web-standard
  `Response` objects. Node ≥ 20 (VS Code extension host) provides them
  globally; `streamResponse()` already prefers the web-stream path for
  Node ≥ 20. Verify no consumer depends on node-fetch-specific `Response`
  internals for the tunneled models.
- **MCP SDK request timeout vs. long non-streaming completions:** must set
  per-request timeout in `callMethod` options (§5.1), otherwise the SDK
  default (60s) kills long non-streaming requests.
- **Concurrent streams:** CITT.MCP processes requests in parallel
  (`McpForceSequential` default off). If a deployment forces sequential
  mode, a streaming response would block other requests — server-side
  concern, documented here for awareness.

## 11. Related Specifications

- **Feature A (implemented):** [endpoint-discovery.md](./endpoint-discovery.md)
- **CITT.MCP protocol:** `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/specifications/citt.mcp-proxy-exposure.md`
- **Client guide:** `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/developer-guides/mcp-llm-proxy-client-guide.md`
