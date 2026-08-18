# CITT Proxy: Gemini Streaming Not Detected

**Status:** Fork-Seite erledigt (2026-08-18); CITT-Server-Fix weiterhin offen

**Update 2026-08-18:** Die Fork-Seite hat den damals als "Rejected"
eingestuften Client-Pfad inzwischen umgesetzt und live mit Rolf verifiziert:
der Fork hängt `?alt=sse` an `:streamGenerateContent`-Requests (Spec
`gemini-alt-sse-streaming.md`, Commit `10d4858b5`). Damit streamt Google
`text/event-stream`, die bestehende Content-Type-Erkennung des Proxies
greift, und CITT.MCP sieht den Stream (inkl. `ExtractGeminiSse` für
`logs.ProxyTokenUsage`). Der unten beschriebene serverseitige Fix ist damit
nicht mehr zwingend für Continue, bleibt aber als Option für andere
MCP-Clients, die ohne `alt=sse` anfragen. Verantwortlich: CITT-Seite
(vesta).

## Problem

When Continue sends a streaming request to a native Gemini endpoint (apiType="Gemini") via the CITT MCP tunnel, the response is buffered instead of streamed. This causes:

1. Long delay before any response appears (entire response is buffered)
2. Client-side timeout/abort
3. Error: `"Unexpected end of JSON input"` when client tries to parse incomplete response

## Root Cause

In `CITT.Library/LlmProxy/ProxyService.cs` (lines 594-635), streaming detection is based on Content-Type:

```csharp
var isStreaming = response.Content.Headers.ContentType?.MediaType?.Contains("event-stream") == true;
```

**Gemini's native streaming format** uses `Content-Type: application/json` and sends a JSON array with chunks separated by `\n,`:

```
[
{"candidates":[...]}
,
{"candidates":[...]}
,
{"candidates":[...]}
]
```

Since Content-Type is `application/json` (not `text/event-stream`), `isStreaming` is `false`, and the proxy buffers the entire response.

## Evidence

Error from Continue when using `google-gemini-3.5-flash` endpoint:

```
SyntaxError: Unexpected end of JSON input
at JSON.parse (<anonymous>)
at _Gemini.parseError
```

URL pattern: `https://generativelanguage.googleapis.com/models/{model}:streamGenerateContent`

## Proposed Server-Side Fix

Enhance streaming detection in `ProxyService.cs` to recognize Gemini streaming by URL pattern:

```csharp
var isStreaming =
    response.Content.Headers.ContentType?.MediaType?.Contains("event-stream") == true
    || (response.Content.Headers.ContentType?.MediaType == "application/json"
        && requestUri.AbsolutePath.Contains(":streamGenerateContent"));
```

This would:

- Still recognize SSE (`text/event-stream`) as streaming
- Also recognize Gemini's JSON array streaming by the `:streamGenerateContent` URL pattern
- Fix the issue for ALL clients (Continue, other MCP clients, etc.)

## Alternative (Rejected)

Client-side fix in Continue: Append `?alt=sse` to Gemini URLs to force SSE format.

**Rejected because:**

- Every client would need to implement this workaround
- Server-side fix is cleaner and benefits all clients

## Affected Endpoints

All endpoints with `ApiType = "Gemini"` in `dbo.ModelEndpoints`:

- `google-gemini-3.5-flash`
- `google-gemini-2.5-flash`
- `google-gemini-2.5-pro`
- etc.

Endpoints via OpenRouter (`ApiType = "OpenAI-compatible"`) are NOT affected — OpenRouter converts to SSE.

## Files to Modify in CITT

1. `CITT.Library/LlmProxy/ProxyService.cs` — streaming detection logic
2. Potentially `UsageCapturingStreamContent.cs` — if JSON array chunks need different handling than SSE

## Test Cases

1. Send streaming request to Gemini endpoint via MCP tunnel
2. Verify chunks arrive incrementally (not buffered)
3. Verify response completes successfully
4. Verify token usage is still captured correctly
