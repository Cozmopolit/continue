import { streamSse } from "@continuedev/fetch";
import { beforeAll, describe, expect, test } from "vitest";
import type {
  ProxyHttpParams,
  ProxyHttpResponse,
  ProxyHttpStreamingResponse,
} from "./MCPConnection";
import {
  buildProxyHttpParams,
  createMcpProxyFetch,
  McpProxyTransport,
  responseFromProxyResult,
} from "./mcpProxyFetch";

// The shared vitest setup replaces globalThis.Response with node-fetch's
// implementation, which cannot carry a web ReadableStream body. The tunnel
// fetch targets the native (undici) Response of the extension host, so we
// restore it for this suite. Captured at module load, before the shared
// beforeAll hook runs.
const NativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = NativeResponse;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface FakeCall {
  params: ProxyHttpParams;
  options?: { signal?: AbortSignal; timeout?: number };
}

interface FakeTransport extends McpProxyTransport {
  calls: FakeCall[];
  cancelledStreamIds: string[];
}

function createFakeTransport(
  respond: (
    params: ProxyHttpParams,
  ) => ProxyHttpResponse | Promise<ProxyHttpResponse>,
  onCancel?: (streamId: string) => void,
): FakeTransport {
  const calls: FakeCall[] = [];
  const cancelledStreamIds: string[] = [];
  return {
    calls,
    cancelledStreamIds,
    async proxyHttp(params, options) {
      calls.push({ params, options });
      return respond(params);
    },
    cancelProxyStream(streamId) {
      cancelledStreamIds.push(streamId);
      onCancel?.(streamId);
    },
  };
}

async function* chunksOf(...items: string[]): AsyncGenerator<string> {
  for (const item of items) {
    yield item;
  }
}

function streamingResult(
  chunks: AsyncIterable<string>,
  overrides?: Partial<ProxyHttpStreamingResponse>,
): ProxyHttpResponse {
  return {
    streaming: true,
    status: 200,
    headers: { "content-type": "text/event-stream" },
    streamId: "s_test",
    chunks,
    ...overrides,
  };
}

/**
 * Push-based chunk source emulating MCPConnection's stream iterable:
 * chunks can be pushed while a consumer awaits, `fail` rejects the pending
 * read (like proxy/http/error or cancelProxyStream), pushes after
 * fail/finish are silently dropped (late-chunk discard).
 */
function createControlledChunks() {
  type Waiter = {
    resolve: (r: IteratorResult<string>) => void;
    reject: (e: Error) => void;
  };
  const queue: string[] = [];
  const waiters: Waiter[] = [];
  let finished = false;
  let error: Error | undefined;

  const settleWaiters = () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (queue.length > 0) {
        waiter.resolve({ value: queue.shift()!, done: false });
      } else if (error) {
        waiter.reject(error);
      } else if (finished) {
        waiter.resolve({ value: undefined, done: true });
      } else {
        waiters.unshift(waiter);
        break;
      }
    }
  };

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (error) {
            return Promise.reject(error);
          }
          if (finished) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) =>
            waiters.push({ resolve, reject }),
          );
        },
        return(): Promise<IteratorResult<string>> {
          finished = true;
          settleWaiters();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(chunk: string) {
      if (finished || error) {
        return; // late chunks are dropped
      }
      queue.push(chunk);
      settleWaiters();
    },
    finish() {
      finished = true;
      settleWaiters();
    },
    fail(e: Error) {
      error = e;
      settleWaiters();
    },
  };
}

// ---------------------------------------------------------------------------
// buildProxyHttpParams
// ---------------------------------------------------------------------------

describe("buildProxyHttpParams", () => {
  test("decomposes URL into path incl. query string, drops the host", () => {
    const params = buildProxyHttpParams(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
      { method: "POST" },
    );
    expect(params.method).toBe("POST");
    expect(params.path).toBe(
      "/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
  });

  test("accepts URL instances", () => {
    const params = buildProxyHttpParams(
      new URL("https://api.example.com/v1/chat/completions"),
    );
    expect(params.path).toBe("/v1/chat/completions");
  });

  test("defaults to GET with empty headers and no body", () => {
    const params = buildProxyHttpParams("https://api.example.com/v1/models");
    expect(params.method).toBe("GET");
    expect(params.headers).toEqual({});
    expect(params).not.toHaveProperty("body");
  });

  test("passes headers through from a plain record (lowercased names)", () => {
    const params = buildProxyHttpParams("https://api.example.com/x", {
      headers: {
        Authorization: "Bearer citt_upk_key",
        "Content-Type": "application/json",
      },
    });
    expect(params.headers).toEqual({
      authorization: "Bearer citt_upk_key",
      "content-type": "application/json",
    });
  });

  test("passes headers through from a Headers instance", () => {
    const headers = new Headers();
    headers.set("x-api-key", "citt_upk_key");
    const params = buildProxyHttpParams("https://api.example.com/x", {
      headers,
    });
    expect(params.headers).toEqual({ "x-api-key": "citt_upk_key" });
  });

  test("passes a string body through verbatim", () => {
    const body = JSON.stringify({ model: "gpt-4o", stream: true });
    const params = buildProxyHttpParams("https://api.example.com/x", {
      method: "POST",
      body,
    });
    expect(params.body).toBe(body);
  });

  test("throws for non-string bodies", () => {
    expect(() =>
      buildProxyHttpParams("https://api.example.com/x", {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      }),
    ).toThrow(/string request bodies/);
  });

  test("preserves an empty query string as no query", () => {
    const params = buildProxyHttpParams("https://api.example.com/v1/embed");
    expect(params.path).toBe("/v1/embed");
  });
});

// ---------------------------------------------------------------------------
// responseFromProxyResult (non-streaming)
// ---------------------------------------------------------------------------

describe("responseFromProxyResult (non-streaming)", () => {
  test("builds an ok Response with parseable JSON body", async () => {
    const response = responseFromProxyResult({
      streaming: false,
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "chatcmpl-1" }),
    });
    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "chatcmpl-1" });
  });

  test("returns HTTP errors as Response with that status, not an exception", async () => {
    const response = responseFromProxyResult({
      streaming: false,
      status: 429,
      headers: {},
      body: JSON.stringify({ error: "rate limited" }),
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate limited");
  });

  test("round-trips headers", () => {
    const response = responseFromProxyResult({
      streaming: false,
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "r1" },
      body: "{}",
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("r1");
  });

  test("handles an empty body", async () => {
    const response = responseFromProxyResult({
      streaming: false,
      status: 200,
      headers: {},
      body: "",
    });
    expect(await response.text()).toBe("");
  });

  test("handles null-body statuses (204) without throwing", () => {
    const response = responseFromProxyResult({
      streaming: false,
      status: 204,
      headers: {},
      body: "",
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createMcpProxyFetch
// ---------------------------------------------------------------------------

describe("createMcpProxyFetch", () => {
  test("sends translated params through the transport", async () => {
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 200,
      headers: {},
      body: "{}",
    }));
    const tunnelFetch = createMcpProxyFetch(transport);

    await tunnelFetch("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer key" },
      body: '{"model":"gpt-4o"}',
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].params).toEqual({
      method: "POST",
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      body: '{"model":"gpt-4o"}',
    });
  });

  test("converts the timeout from seconds to milliseconds", async () => {
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 200,
      headers: {},
      body: "{}",
    }));
    const tunnelFetch = createMcpProxyFetch(transport, { timeout: 120 });

    await tunnelFetch("https://api.example.com/x");

    expect(transport.calls[0].options?.timeout).toBe(120_000);
  });

  test("passes no timeout when none is configured", async () => {
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 200,
      headers: {},
      body: "{}",
    }));
    const tunnelFetch = createMcpProxyFetch(transport);

    await tunnelFetch("https://api.example.com/x");

    expect(transport.calls[0].options?.timeout).toBeUndefined();
  });

  test("forwards the abort signal to the transport", async () => {
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 200,
      headers: {},
      body: "{}",
    }));
    const tunnelFetch = createMcpProxyFetch(transport);
    const controller = new AbortController();

    await tunnelFetch("https://api.example.com/x", {
      signal: controller.signal,
    });

    expect(transport.calls[0].options?.signal).toBe(controller.signal);
  });

  test("rejects with AbortError when the signal is already aborted", async () => {
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 200,
      headers: {},
      body: "{}",
    }));
    const tunnelFetch = createMcpProxyFetch(transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      tunnelFetch("https://api.example.com/x", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.calls).toHaveLength(0);
  });

  test("returns a stream:true request answered non-streaming as plain Response", async () => {
    // Per CITT spec, an immediate HTTP error to a streaming request comes
    // back as a regular non-streaming result.
    const transport = createFakeTransport(() => ({
      streaming: false,
      status: 401,
      headers: {},
      body: JSON.stringify({ error: "MISSING_API_KEY" }),
    }));
    const tunnelFetch = createMcpProxyFetch(transport);

    const response = await tunnelFetch("https://api.example.com/v1/chat", {
      method: "POST",
      body: '{"stream":true}',
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("MISSING_API_KEY");
  });

  describe("streaming", () => {
    test("streamSse consumes the synthetic Response and terminates on done", async () => {
      const transport = createFakeTransport(() =>
        streamingResult(
          chunksOf(
            'data: {"n":1}\n\n',
            'data: {"n":2}\n\n',
            "data: [DONE]\n\n",
          ),
        ),
      );
      const tunnelFetch = createMcpProxyFetch(transport);

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
      });

      const events: unknown[] = [];
      for await (const event of streamSse(response)) {
        events.push(event);
      }
      expect(events).toEqual([{ n: 1 }, { n: 2 }]);
    });

    test("errors the body when the chunk iterable throws mid-stream", async () => {
      async function* failingChunks(): AsyncGenerator<string> {
        yield 'data: {"n":1}\n\n';
        throw new Error("Upstream connection lost (proxy/http/error)");
      }
      const transport = createFakeTransport(() =>
        streamingResult(failingChunks()),
      );
      const tunnelFetch = createMcpProxyFetch(transport);

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
      });

      const reader = response.body!.getReader();
      await reader.read(); // first chunk arrives
      await expect(reader.read()).rejects.toThrow(/Upstream connection lost/);
    });

    test("abort mid-stream cancels the proxy stream and errors the body with AbortError", async () => {
      const controlled = createControlledChunks();
      const transport = createFakeTransport(
        () => streamingResult(controlled.iterable, { streamId: "s_abort" }),
        () => {
          // Emulate MCPConnection.cancelProxyStream: local iterable is
          // terminated with an AbortError.
          const abortError = new Error("Proxy stream s_abort cancelled");
          abortError.name = "AbortError";
          controlled.fail(abortError);
        },
      );
      const tunnelFetch = createMcpProxyFetch(transport);
      const controller = new AbortController();

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
        signal: controller.signal,
      });
      const reader = response.body!.getReader();

      controlled.push('data: {"n":1}\n\n');
      await reader.read();

      controller.abort();
      await expect(reader.read()).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(transport.cancelledStreamIds).toContain("s_abort");

      // Late chunks after cancel are discarded without throwing.
      controlled.push('data: {"n":2}\n\n');
    });

    test("cancelling the response body stops the proxy stream", async () => {
      const controlled = createControlledChunks();
      const transport = createFakeTransport(() =>
        streamingResult(controlled.iterable, { streamId: "s_early" }),
      );
      const tunnelFetch = createMcpProxyFetch(transport);

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
      });
      const reader = response.body!.getReader();

      controlled.push('data: {"n":1}\n\n');
      await reader.read();
      await reader.cancel();

      expect(transport.cancelledStreamIds).toContain("s_early");
    });

    test("does not send proxy/cancel after normal stream completion beyond the no-op safeguard", async () => {
      const transport = createFakeTransport(() =>
        streamingResult(chunksOf("data: [DONE]\n\n"), { streamId: "s_done" }),
      );
      const tunnelFetch = createMcpProxyFetch(transport);

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
      });
      for await (const _ of streamSse(response)) {
        // drain
      }

      // The trailing cancelProxyStream call is allowed (it is a no-op on
      // the real connection once the stream is done) but must reference
      // the correct streamId.
      for (const id of transport.cancelledStreamIds) {
        expect(id).toBe("s_done");
      }
    });

    test("exposes streaming status and headers on the Response", async () => {
      const transport = createFakeTransport(() =>
        streamingResult(chunksOf("data: [DONE]\n\n")),
      );
      const tunnelFetch = createMcpProxyFetch(transport);

      const response = await tunnelFetch("https://api.example.com/v1/chat", {
        method: "POST",
        body: '{"stream":true}',
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      await response.body!.cancel();
    });
  });
});
