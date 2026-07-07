import type { ProxyHttpParams, ProxyHttpResponse } from "./MCPConnection";

/**
 * Minimal transport surface of `MCPConnection` required by the tunnel fetch.
 * Structural subset so tests (and discovery) can depend on this instead of
 * the full connection class.
 */
export interface McpProxyTransport {
  proxyHttp(
    params: ProxyHttpParams,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<ProxyHttpResponse>;
  cancelProxyStream(streamId: string): void;
}

export interface McpProxyFetchOptions {
  /** Request timeout in seconds (from the discovered endpoint's timeout). */
  timeout?: number;
  /**
   * Endpoint ID for CITT proxy routing. When set, the `X-Citt-Endpoint`
   * header is added to every request. This is required for providers like
   * Gemini where the model is in the URL path, not in the request body.
   */
  endpointId?: string;
}

/** Statuses for which the Fetch spec requires a null response body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function newAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Translates standard fetch arguments into CITT `proxy/http` params.
 *
 * The host part of the URL is dropped (the proxy ignores it); the path
 * keeps its query string (e.g. Gemini's `?alt=sse`). Headers are passed
 * through (normalized to lowercase names by the `Headers` class — HTTP
 * header names are case-insensitive).
 *
 * Note: `requestOptions.headers` merging happens inside
 * `fetchwithRequestOptions`, which the tunnel bypasses. Discovered models
 * only carry a generated `timeout` in their requestOptions, so nothing is
 * lost — but this is a documented limitation of the tunnel fetch.
 */
export function buildProxyHttpParams(
  url: RequestInfo | URL,
  init?: RequestInit,
): ProxyHttpParams {
  const parsed =
    typeof url === "string" || url instanceof URL
      ? new URL(url)
      : new URL(url.url);

  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  if (
    init?.body !== undefined &&
    init.body !== null &&
    typeof init.body !== "string"
  ) {
    throw new Error(
      "MCP proxy tunnel fetch only supports string request bodies",
    );
  }

  return {
    method: init?.method ?? "GET",
    path: parsed.pathname + parsed.search,
    headers,
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  };
}

function readableStreamFromChunks(
  chunks: AsyncIterable<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A rejected next() rejects pull's promise, which errors the stream —
      // exactly what we want for proxy/http/error and cancellation.
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(value));
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * Builds a web-standard `Response` from a `proxy/http` result.
 *
 * HTTP errors (4xx/5xx) become a `Response` with that status — never an
 * exception — so existing error mapping in `BaseLLM.fetch()` applies
 * unchanged. Streaming results get a `ReadableStream` body fed by the raw
 * SSE chunk iterable, which `streamSse()` consumes as-is.
 */
export function responseFromProxyResult(result: ProxyHttpResponse): Response {
  const headers = new Headers(result.headers);
  if (result.streaming) {
    return new Response(readableStreamFromChunks(result.chunks), {
      status: result.status,
      headers,
    });
  }
  const body =
    NULL_BODY_STATUSES.has(result.status) || result.body === ""
      ? null
      : result.body;
  return new Response(body, { status: result.status, headers });
}

/**
 * Creates a fetch-compatible function that routes HTTP requests through the
 * CITT.MCP stdio tunnel (`proxy/http`) of the given connection.
 *
 * Abort semantics (decision #3 of the tunneling spec): on `init.signal`
 * abort, the local body stream errors with an `AbortError` and
 * `proxy/cancel` is sent fire-and-forget; late chunks are discarded by the
 * connection's stream registry.
 */
export function createMcpProxyFetch(
  connection: McpProxyTransport,
  options?: McpProxyFetchOptions,
): (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const timeoutMs =
    options?.timeout === undefined ? undefined : options.timeout * 1000;
  const endpointId = options?.endpointId;

  return async (url, init) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      throw newAbortError("Request aborted before it was sent");
    }

    const params = buildProxyHttpParams(url, init);

    // Add X-Citt-Endpoint header for reliable endpoint routing. Required for
    // providers like Gemini where the model is in the URL path, not the body.
    if (endpointId && params.headers) {
      params.headers["x-citt-endpoint"] = endpointId;
    }
    const result = await connection.proxyHttp(params, {
      signal,
      timeout: timeoutMs,
    });

    if (!result.streaming) {
      return responseFromProxyResult(result);
    }

    const { streamId } = result;
    const onAbort = () => connection.cancelProxyStream(streamId);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      // Abort raced the stream-start result.
      onAbort();
    }

    const chunks = (async function* () {
      try {
        yield* result.chunks;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        // No-op after done/error/cancel (registry entry already gone);
        // stops the server-side stream when the consumer abandons
        // iteration early (e.g. `response.body.cancel()`).
        connection.cancelProxyStream(streamId);
      }
    })();

    return responseFromProxyResult({ ...result, chunks });
  };
}
