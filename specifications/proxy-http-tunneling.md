# Feature B: Chat Completions via MCP HTTP Tunnel

**Status:** Draft (revised: decision #5 replaced by adapter bypass, see §5.4)
**Last Updated:** 2026-07-07

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

| #   | Decision                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Always tunnel.** Discovered CITT endpoints never make direct HTTP calls. No hybrid/fallback mode.                                                                                                                                                                                       |
| 2   | **Lifecycle cleanup.** On MCP reconnect/disconnect, all active tunnel streams are terminated with an error and the stream registry is cleared.                                                                                                                                            |
| 3   | **Abort semantics.** On `AbortSignal`: terminate the local stream immediately, send `proxy/cancel` fire-and-forget, silently discard late chunks for that `streamId` (spec: best-effort cancellation, late chunks acceptable).                                                            |
| 4   | **Testing.** Automated unit + wire-format tests are the lasting safety net. One-time manual verification against real CITT.MCP is part of the implementation task's definition of done (see §9).                                                                                          |
| 5   | **Adapter bypass** (revised 2026-07-07, supersedes "openai-adapters injection"). When `customFetch` is set, `BaseLLM` bypasses the openai-adapter entirely; all traffic uses the native Path 1 implementations. `packages/openai-adapters` stays untouched. Rationale and findings: §5.4. |

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

There is no way to inject a custom fetch into Path 2 that covers all
providers: code verification showed that the Gemini adapter's chat path
does not go through `customFetch` at all (see findings in §5.4). This is
why decision #5 was revised to bypass Path 2 for tunneled models.

### Key insight

Intercepting at fetch level means **no code changes to provider request
logic** (single exception: the Gemini key-header fix, §5.4) and zero new
API semantics — the exact principle of the CITT spec ("clients build
standard HTTP requests"). Note that with `customFetch` set, requests are
built by the native Path 1 implementations, not the openai-adapter
(§5.4) — for OpenAI models the runtime request path therefore differs
from the non-tunneled adapter path. Embeddings and rerank are not
special cases; they are just other paths (`/v1/embeddings`, `/rerank`)
through the same tunnel, and non-streaming (the simpler code path).

## 5. Solution Design

```
Provider class (native Path 1; adapter bypassed when customFetch is set)
        │ fetch(url, init) via BaseLLM.fetch()
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

Notifications for `Cancelled` streamIds are silently discarded
(decision #3 — late chunks after cancel must not throw). Notifications for
**unknown** streamIds are **buffered briefly** instead of discarded: SDK
response resolution and notification dispatch both go through microtasks,
so a chunk arriving in the same stdio batch as the `proxy/http` result can
be dispatched before `proxyHttp()` registers the streamId. Buffered events
are flushed on registration; leftovers are dropped by a TTL sweep (5 s).
To keep late-after-cancel chunks out of that buffer, `Cancelled` entries
stay in the registry until the terminal notification arrives (fallback:
60 s TTL sweep).

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

### 5.4 Adapter bypass (decision #5, revised 2026-07-07)

The original plan was to inject an optional `fetch` field into the
adapter configs in `packages/openai-adapters`. Code verification revealed
three findings that invalidate that approach:

1. **Gemini chat is not tunnelable via adapter injection.** The Gemini
   adapter (`packages/openai-adapters/src/apis/Gemini.ts`) uses the
   `@google/genai` SDK for chat/streaming — deliberately with the _native
   global fetch_ (`withNativeFetch`, to avoid fetch pollution) and
   **without `apiBase`**. The SDK accepts no custom fetch; `customFetch`
   only reaches the adapter's `embed`. Core `Gemini` has
   `useOpenAIAdapterFor: ["chat", "streamChat", ...]`, so discovered
   Gemini chat models would run exactly into this non-tunnelable path.
2. **Anthropic and Cohere never use the adapter.** Their core classes set
   no `useOpenAIAdapterFor` — chat/embed/rerank run entirely over Path 1
   (`this.fetch`). Adapter changes for them would be dead code for
   discovered models. Of the CITT-relevant providers, only OpenAI and
   Gemini use the adapter at all — and Gemini's adapter chat path is not
   tunnelable (finding 1) — so adapter injection would only ever have
   covered the OpenAI class (Azure is unreachable for discovered models).
3. **Core Gemini sends the API key as a query parameter.** `_streamChat`
   builds `models/{model}:streamGenerateContent?key={apiKey}`. CITT
   extracts the proxy key from **headers only** (verified in
   `ProxyRequest.cs` `ExtractUserProxyKey`: `x-api-key`, `api-key`,
   `x-goog-api-key`, `Authorization: Bearer`) → 401 `MISSING_API_KEY`.
   Worse, `ConstructTargetUri` forwards the query string upstream
   unchanged — the proxy key would leak to Google.

**Solution (two changes, both in `core`):**

1. **`customFetch` set ⇒ bypass the openai-adapter.** One condition in
   `BaseLLM.shouldUseOpenAIAdapter()` (`core/llm/index.ts`): return
   `false` when `this._llmOptions.customFetch` is set. All four providers
   then use their complete native Path 1 implementations — a single
   interception point, uniform behavior. The native OpenAI path is
   complete (incl. tools) and is exactly the path `OpenAI.vitest.ts`
   exercises today (adapter explicitly disabled there).
2. **Gemini key fix (`core/llm/llms/Gemini.ts`):** send `x-goog-api-key`
   header instead of the `?key=` query param in `streamChatGemini` and
   `streamChatBison` (`_embed` already does this). Google officially
   supports the header; the GoogleGenAI SDK and the Gemini adapter use it
   too — upstream-friendly, and it closes a key-in-URL logging leak. This
   is the only provider-class change, and it is correct independently of
   the tunnel.

`packages/openai-adapters` is **not modified**. YAML-configured models
never set `customFetch`, so the adapter path is completely unchanged for
them.

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

- Provider classes (`core/llm/llms/*.ts`) — zero changes except the
  Gemini key-header fix (§5.4)
- `packages/openai-adapters` — zero changes (decision #5, revised)
- SSE parsing (`packages/fetch/src/stream.ts`) — consumes the synthetic
  `Response` as-is
- CITT.MCP server side — Feature B is a pure client implementation
- Feature A discovery data flow (statuses, sync fetch during connect)
- YAML/JSON-configured models — `customFetch` is programmatic-only

## 7. Implementation Plan

### Phase 1: BaseLLM customFetch + adapter bypass + Gemini key fix — DONE (2026-07-07)

`core/index.d.ts` (`LLMOptions.customFetch`), `core/llm/index.ts`
(`fetch()` substitution + `shouldUseOpenAIAdapter()` bypass),
`core/llm/llms/index.ts` (`llmFromDescription` overrides param),
`core/llm/llms/Gemini.ts` (`x-goog-api-key` header instead of `?key=`).
No behavior change when `customFetch` unset — except the Gemini header
change, which is intentional and tunnel-independent (§5.4).

Implementation notes: `customFetch` is read via `this._llmOptions` (no
class field). New test suite `core/llm/customFetch.vitest.ts` covers
fetch substitution, adapter bypass (both directions), and the Gemini
header/query-param assertions. The pre-existing Gemini expectation in
`core/llm/llm-pre-fetch.vitest.ts` was updated (`headers` is now sent).

### Phase 2: MCPConnection tunnel transport — DONE (2026-07-07)

Notification handlers, stream registry, `proxyHttp()`,
`cancelProxyStream()`, lifecycle cleanup in reconnect/disconnect.

Implementation notes (`core/context/mcp/MCPConnection.ts`):

- Exported types for Phase 3: `ProxyHttpParams`,
  `ProxyHttpResponse` (discriminated union on `streaming: false | true`;
  streaming variant carries `streamId` + `chunks: AsyncIterable<string>`),
  `ProxyStreamState`.
- Notification handlers are registered once in the constructor — the SDK
  `Client` instance survives reconnects, so no re-registration is needed.
- `proxyHttp` defaults the request timeout to
  `DEFAULT_MCP_TOOL_CALL_TIMEOUT` (15 min) — closes the §10 SDK-60s risk.
- `cancelProxyStream` terminates the local iterable with an error whose
  `name === "AbortError"`, then sends `proxy/cancel` fire-and-forget.
- Early-notification buffering for unknown streamIds (see §5.1) — a
  deviation from the original "discard unknown" rule, required for
  correctness under the microtask result/notification race.
- The chunk iterable is single-consumer and registers the stream
  synchronously inside `proxyHttp` (before the caller starts iterating).
- Tests: 9 new cases in `core/context/mcp/MCPConnection.vitest.ts`
  ("proxy HTTP tunnel" block) — dispatch by streamId, early-buffer flush,
  mid-stream error, cancel semantics incl. late-chunk discard and
  `proxy/cancel` wire assertion, disconnect/reconnect cleanup.
  Notifications are injected via the SDK-private `_onnotification`.

### Phase 3: Tunnel fetch + discovery wiring

`mcpProxyFetch.ts` (new), `mcpProxyModelDiscovery.ts` (server id,
`getConnection` dep, tunnel fetch per endpoint), `doLoadConfig.ts`
(resolver). Wire-format tests (§9) close out this phase.

## 8. Files to Modify

- `core/index.d.ts` — `LLMOptions.customFetch`
- `core/llm/index.ts` — Use `customFetch` in `BaseLLM.fetch()`; bypass openai-adapter in `shouldUseOpenAIAdapter()` when `customFetch` is set
- `core/llm/llms/Gemini.ts` — `x-goog-api-key` header instead of `?key=` query param (chat paths)
- `core/llm/llms/index.ts` — `llmFromDescription` optional `overrides` param
- `core/llm/customFetch.vitest.ts` — **NEW** — Phase 1 unit tests (fetch substitution, adapter bypass, Gemini headers)
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
key in an auth **header** (for Gemini: `x-goog-api-key`, and **no**
`?key=` query param), body shape. Because `customFetch` is set, these
tests run through the native Path 1 provider classes (adapter bypassed) —
assert that too (`shouldUseOpenAIAdapter` returns false). This covers
embeddings/rerank explicitly and catches the most realistic failures:
wrong apiBase→path decomposition and key placement.

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
- **MCP SDK request timeout vs. long non-streaming completions:** resolved
  in Phase 2 — `proxyHttp` defaults to `DEFAULT_MCP_TOOL_CALL_TIMEOUT`
  (15 min) unless the caller passes an endpoint timeout.
- **Concurrent streams:** CITT.MCP processes requests in parallel
  (`McpForceSequential` default off). If a deployment forces sequential
  mode, a streaming response would block other requests — server-side
  concern, documented here for awareness.

## 11. Related Specifications

- **Feature A (implemented):** [endpoint-discovery.md](./endpoint-discovery.md)
- **CITT.MCP protocol:** `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/specifications/citt.mcp-proxy-exposure.md`
- **Client guide:** `C:/Users/Zuser/Documents/Rolf/VSC_Projekte/CITT-Solution/CITT/docs/developer-guides/mcp-llm-proxy-client-guide.md`

---

## Appendix A: Working Practice for Implementation Chats

Context budget is the scarce resource. This spec is the **single source
of truth** — each phase (§7) is implemented in a **fresh chat** that
starts from this spec plus targeted file access. Anything that matters
beyond the current chat belongs in this spec, not in chat history.

Rules for the implementing assistant:

1. **One fresh chat per phase.** Begin by reading this spec. Do not rely
   on prior chat context; assume it is gone.
2. **Delegate comprehension questions** ("does X use Y?", "how does this
   class handle Z?") to `citt_ask_file` / `citt_ask_files` instead of
   reading whole files inline. A sub-agent reads the file and returns a
   condensed answer — the file content never enters the main context.
3. **Read line ranges, not whole files** (`read_file_range`,
   `citt_file_read` with `firstLine`/`lastLine`) once the location is
   known. Full-file reads are the single largest context sink (e.g.
   `MCPConnection.ts` ≈ 700 lines).
4. **Keep grep patterns narrow.** Broad alternations pull in vendor and
   build noise (`core/vendor`, `sync/src`) at up to 7.5k characters per
   call. Prefer one specific pattern over three speculative ones.
5. **Use `citt_run_file_editor` for well-defined edits** (renames,
   find-replace, applying a precisely described change). It is a powerful
   sub-agent (Claude Opus 4.5 based) that reads and edits the file
   autonomously — the file stays out of the main context. Provide the
   full file path and an unambiguous description of the change; review
   via `view_diff` afterwards.
6. **Update this spec when reality deviates from it** (as happened with
   the §5.4 revision) — the next chat must be able to trust it blindly.

Definition of done per phase: touched test suites green (`vitest`), spec
updated if needed, commit with a message referencing this spec. Manual
verification (§9) happens once, after the final phase.
