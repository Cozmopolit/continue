import { Readable } from "stream";
import { describe, expect, it, test } from "vitest";
import {
  collectDiagnosticHeaders,
  createResponseError,
  detectCompletionSignal,
  formatPrematureStreamEndMessage,
  isPrematureStreamEndError,
  parseDataLine,
  PrematureStreamEndError,
  StreamForensics,
  streamResponse,
  streamSse,
} from "./stream.js";

function createMockResponse(
  sseLines: string[],
  overrides?: { status?: number; headers?: Record<string, string> },
): Response {
  // Create a Readable stream that emits the SSE lines
  const stream = new Readable({
    read() {
      for (const line of sseLines) {
        this.push(line + "\n\n");
      }
      this.push(null); // End of stream
    },
  }) as any;

  const headersMap = new Map<string, string>(
    Object.entries(overrides?.headers ?? {}),
  );

  // Minimal Response mock
  return {
    status: overrides?.status ?? 200,
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        headersMap.forEach((v, k) => cb(v, k));
      },
      get: (k: string) => headersMap.get(k.toLowerCase()) ?? null,
    },
    body: stream,
    text: async () => "",
  } as unknown as Response;
}

/** Mock response whose body emits the exact given payload (no auto \n\n). */
function createRawMockResponse(payloads: string[]): Response {
  const stream = new Readable({
    read() {
      for (const p of payloads) {
        this.push(p);
      }
      this.push(null);
    },
  }) as any;
  return {
    status: 200,
    body: stream,
    text: async () => "",
  } as unknown as Response;
}

async function collect(stream: AsyncGenerator<any>): Promise<any[]> {
  const results = [];
  for await (const data of stream) {
    results.push(data);
  }
  return results;
}

describe("streamSse", () => {
  it("yields parsed SSE data objects that ends with `data:[DONE]`", async () => {
    const sseLines = [
      'data: {"foo": "bar"}',
      'data: {"baz": 42}',
      "data:[DONE]",
    ];
    const response = createMockResponse(sseLines);

    const results = await collect(streamSse(response));

    expect(results).toEqual([{ foo: "bar" }, { baz: 42 }]);
  });

  it("yields parsed SSE data objects that ends with `data: [DONE]` (with a space before [DONE]", async () => {
    const sseLines = [
      'data: {"foo": "bar"}',
      'data: {"baz": 42}',
      "data: [DONE]",
    ];
    const response = createMockResponse(sseLines);

    const results = await collect(streamSse(response));

    expect(results).toEqual([{ foo: "bar" }, { baz: 42 }]);
  });

  it("throws on malformed JSON", async () => {
    const sseLines = ['data: {"foo": "bar"', "data:[DONE]"];
    const response = createMockResponse(sseLines);

    const iterator = streamSse(response)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(/Malformed JSON/);
  });

  it("ignores SSE comment keepalive lines and continues parsing", async () => {
    const sseLines = [
      ": OPENROUTER PROCESSING",
      'data: {"foo": "bar"}',
      ": ping",
      'data: {"baz": 42}',
      "data: [DONE]",
    ];
    const response = createMockResponse(sseLines);

    const results = await collect(streamSse(response));

    expect(results).toEqual([{ foo: "bar" }, { baz: 42 }]);
  });

  it("accepts a stream ending with finish_reason but no [DONE] sentinel", async () => {
    const sseLines = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    ];
    const response = createMockResponse(sseLines);

    const results = await collect(streamSse(response));

    expect(results).toHaveLength(2);
  });

  it("accepts Anthropic-style message_stop without [DONE]", async () => {
    const sseLines = [
      'data: {"type":"content_block_delta","delta":{"text":"Hi"}}',
      'data: {"type":"message_stop"}',
    ];
    const response = createMockResponse(sseLines);

    const results = await collect(streamSse(response));

    expect(results).toHaveLength(2);
  });

  it("throws PrematureStreamEndError when the connection closes mid-stream without [DONE] or finish_reason (strict mode)", async () => {
    const sseLines = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
    ];
    const response = createMockResponse(sseLines, {
      headers: { server: "cloudflare", "cf-ray": "abc123-FRA" },
    });

    let error: unknown;
    try {
      await collect(streamSse(response, { expectTerminationSignal: true }));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PrematureStreamEndError);
    expect(isPrematureStreamEndError(error)).toBe(true);
    const err = error as PrematureStreamEndError;
    expect(err.forensics.dataEventsYielded).toBe(2);
    expect(err.forensics.sawDoneSentinel).toBe(false);
    expect(err.forensics.sawCompletionSignal).toBe(false);
    expect(err.forensics.charsReceived).toBeGreaterThan(0);
    expect(err.forensics.responseHeaders).toEqual({
      server: "cloudflare",
      "cf-ray": "abc123-FRA",
    });
    expect(err.message).toContain("ended prematurely");
    expect(err.message).toContain("2 data events");
    expect(err.message).toContain("middlebox");
  });

  it("throws PrematureStreamEndError when the connection closes without any data (strict mode)", async () => {
    const response = createMockResponse([]);

    let error: unknown;
    try {
      await collect(streamSse(response, { expectTerminationSignal: true }));
    } catch (e) {
      error = e;
    }

    expect(isPrematureStreamEndError(error)).toBe(true);
    expect((error as PrematureStreamEndError).message).toContain(
      "before any data was received",
    );
  });

  it("reports an unterminated tail as leftoverBuffer (cut mid-frame)", async () => {
    // Stream dies in the middle of a data line (no trailing newline)
    const response = createRawMockResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"Hel"',
    ]);

    let error: unknown;
    try {
      await collect(streamSse(response));
    } catch (e) {
      error = e;
    }

    expect(isPrematureStreamEndError(error)).toBe(true);
    const err = error as PrematureStreamEndError;
    expect(err.forensics.leftoverBuffer).toContain('"delta"');
    expect(err.message).toContain("mid-frame");
  });

  it("does not throw on premature end in lenient mode (default) or with expectTerminationSignal: false", async () => {
    const sseLines = ['data: {"foo": "bar"}'];

    // Default: lenient (streamSse is shared by many provider dialects)
    const resultsDefault = await collect(
      streamSse(createMockResponse(sseLines)),
    );
    expect(resultsDefault).toEqual([{ foo: "bar" }]);

    const resultsExplicit = await collect(
      streamSse(createMockResponse(sseLines), {
        expectTerminationSignal: false,
      }),
    );
    expect(resultsExplicit).toEqual([{ foo: "bar" }]);
  });

  it("does not throw on premature end when the abort signal fired", async () => {
    const sseLines = ['data: {"foo": "bar"}'];
    const response = createMockResponse(sseLines);
    const controller = new AbortController();
    controller.abort();

    const results = await collect(
      streamSse(response, { signal: controller.signal }),
    );

    expect(results).toEqual([{ foo: "bar" }]);
  });

  it("returns immediately for status 499 (client cancellation)", async () => {
    const response = createMockResponse([], { status: 499 });

    const results = await collect(streamSse(response));

    expect(results).toEqual([]);
  });

  it("yields a parseable unterminated tail line and does not flag leftover", async () => {
    const response = createRawMockResponse([
      'data: {"foo": "bar"}\n\ndata: [DONE]',
    ]);

    const results = await collect(streamSse(response));

    expect(results).toEqual([{ foo: "bar" }]);
  });
});

describe("detectCompletionSignal", () => {
  test("detects OpenAI chat chunk finish_reason", () => {
    expect(
      detectCompletionSignal({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ).toBe("finish_reason=stop");
  });

  test("detects finish_reason in any choice", () => {
    expect(
      detectCompletionSignal({
        choices: [
          { index: 0, delta: {}, finish_reason: null },
          { index: 1, delta: {}, finish_reason: "tool_calls" },
        ],
      }),
    ).toBe("finish_reason=tool_calls");
  });

  test("ignores null finish_reason", () => {
    expect(
      detectCompletionSignal({
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
      }),
    ).toBeUndefined();
  });

  test("detects Anthropic message_stop", () => {
    expect(detectCompletionSignal({ type: "message_stop" })).toBe(
      "message_stop",
    );
  });

  test("detects top-level finish_reason", () => {
    expect(detectCompletionSignal({ finish_reason: "length" })).toBe(
      "finish_reason=length",
    );
  });

  test("returns undefined for non-objects", () => {
    expect(detectCompletionSignal(null)).toBeUndefined();
    expect(detectCompletionSignal("foo")).toBeUndefined();
    expect(detectCompletionSignal(42)).toBeUndefined();
  });
});

describe("formatPrematureStreamEndMessage", () => {
  const base: StreamForensics = {
    charsReceived: 12834,
    chunksReceived: 41,
    sseLinesParsed: 40,
    commentLines: 3,
    dataEventsYielded: 37,
    sawDoneSentinel: false,
    sawCompletionSignal: false,
    startedAt: "2026-07-25T10:00:00.000Z",
    durationMs: 4200,
    lastChunkAgeMs: 200,
  };

  test("renders stats, keepalives and balanced cause hint", () => {
    const msg = formatPrematureStreamEndMessage(base);
    expect(msg).toContain("37 data events");
    expect(msg).toContain("12834 chars");
    expect(msg).toContain("4.2s duration");
    expect(msg).toContain("0.2s before close");
    expect(msg).toContain("3 keepalive/comment lines");
    // balanced: both causes named, neither asserted
    expect(msg).toContain("Possible causes");
    expect(msg).toContain("middlebox");
    expect(msg).toContain("provider-side abort");
    expect(msg).not.toContain("typically caused");
  });

  test("renders provider request id and provider-reported model", () => {
    const msg = formatPrematureStreamEndMessage({
      ...base,
      requestId: "gen-abc123",
      providerModel: "moonshotai/kimi-k3",
    });
    expect(msg).toContain("Provider request id: gen-abc123");
    expect(msg).toContain("Provider-reported model: moonshotai/kimi-k3");
  });

  test("omits provider id lines when not captured", () => {
    const msg = formatPrematureStreamEndMessage(base);
    expect(msg).not.toContain("Provider request id");
    expect(msg).not.toContain("Provider-reported model");
  });

  test("renders leftover buffer and headers", () => {
    const msg = formatPrematureStreamEndMessage({
      ...base,
      leftoverBuffer: 'data: {"id":"gen-1"',
      responseHeaders: { server: "Zscaler", via: "1.1 proxy.corp" },
      proxyUsed: true,
      proxyOrigin: "http://proxy.corp:8080",
    });
    expect(msg).toContain("cut mid-frame");
    expect(msg).toContain('data: {"id":"gen-1"');
    expect(msg).toContain("server=Zscaler");
    expect(msg).toContain("via=1.1 proxy.corp");
    expect(msg).toContain("http://proxy.corp:8080");
  });

  test("renders no-data variant", () => {
    const msg = formatPrematureStreamEndMessage({
      ...base,
      dataEventsYielded: 0,
      charsReceived: 0,
    });
    expect(msg).toContain("before any data was received");
  });
});

describe("collectDiagnosticHeaders", () => {
  test("keeps diagnostic and x- headers only", () => {
    const headers = {
      forEach: (cb: (v: string, k: string) => void) => {
        cb("cloudflare", "server");
        cb("ray-1", "cf-ray");
        cb("secret", "set-cookie");
        cb("custom", "x-custom");
      },
    };
    expect(collectDiagnosticHeaders(headers)).toEqual({
      server: "cloudflare",
      "cf-ray": "ray-1",
      "x-custom": "custom",
    });
  });

  test("returns undefined for invalid header objects", () => {
    expect(collectDiagnosticHeaders(undefined)).toBeUndefined();
    expect(collectDiagnosticHeaders({})).toBeUndefined();
  });
});

describe("parseDataLine", () => {
  test("parseDataLine should parse valid JSON data with 'data: ' prefix", () => {
    const line = 'data: {"message":"hello","status":"ok"}';
    const result = parseDataLine(line);
    expect(result).toEqual({ message: "hello", status: "ok" });
  });

  test("parseDataLine should parse valid JSON data with 'data:' prefix (no space)", () => {
    const line = 'data:{"message":"hello","status":"ok"}';
    const result = parseDataLine(line);
    expect(result).toEqual({ message: "hello", status: "ok" });
  });

  test("parseDataLine should throw error for malformed JSON", () => {
    const line = "data: {invalid json}";
    expect(() => parseDataLine(line)).toThrow(
      "Malformed JSON sent from server",
    );
  });

  test("parseDataLine should throw error when data contains error field", () => {
    const line = 'data: {"error":"something went wrong"}';
    expect(() => parseDataLine(line)).toThrow(
      'Error streaming response: "something went wrong"',
    );
  });

  test("parseDataLine should throw error when data contains error object with message", () => {
    const line = 'data: {"error":{"message":"detailed error message"}}';
    expect(() => parseDataLine(line)).toThrow(
      "Error streaming response: detailed error message",
    );
  });

  test("parseDataLine should handle empty objects", () => {
    const line = "data: {}";
    const result = parseDataLine(line);
    expect(result).toEqual({});
  });

  test("parseDataLine should handle arrays", () => {
    const line = "data: [1,2,3]";
    const result = parseDataLine(line);
    expect(result).toEqual([1, 2, 3]);
  });

  test("parseDataLine should handle nested objects", () => {
    const line = 'data: {"user":{"name":"John","age":30}}';
    const result = parseDataLine(line);
    expect(result).toEqual({ user: { name: "John", age: 30 } });
  });
});

describe("createResponseError", () => {
  function mockErrorResponse(overrides: {
    status: number;
    body: string;
    headers?: Record<string, string>;
  }): Response {
    const headersMap = new Map<string, string>(
      Object.entries(overrides.headers ?? {}),
    );
    return {
      status: overrides.status,
      text: async () => overrides.body,
      headers: {
        forEach: (cb: (value: string, key: string) => void) => {
          headersMap.forEach((v, k) => cb(v, k));
        },
      },
    } as unknown as Response;
  }

  test("uses the body text as message and attaches status + lowercased headers", async () => {
    const response = mockErrorResponse({
      status: 429,
      body: '{"error":"rate limited"}',
      headers: { "Retry-After": "0.5", "Content-Type": "application/json" },
    });

    const error = await createResponseError(response);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('{"error":"rate limited"}');
    expect(error.status).toBe(429);
    expect(error.headers).toEqual({
      "retry-after": "0.5",
      "content-type": "application/json",
    });
  });

  test("handles responses without forEach-able headers", async () => {
    const response = {
      status: 503,
      text: async () => "unavailable",
      headers: {},
    } as unknown as Response;

    const error = await createResponseError(response);

    expect(error.message).toBe("unavailable");
    expect(error.status).toBe(503);
    expect(error.headers).toEqual({});
  });
});

describe("streamResponse error enrichment (rate-limit-retry.md)", () => {
  test("throws a ResponseError with status and headers on non-200", async () => {
    const response = createMockResponse([], {
      status: 429,
      headers: { "Retry-After": "1" },
    });
    // The mock body text is empty — the message stays the body text,
    // but status/headers must be preserved for rate-limit detection.
    let thrown: unknown;
    try {
      for await (const _ of streamResponse(response)) {
        // no chunks expected
      }
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as any).status).toBe(429);
    expect((thrown as any).headers).toEqual({ "retry-after": "1" });
  });

  test("499 (client cancellation) completes silently without throwing", async () => {
    const response = createMockResponse([], { status: 499 });

    const results = await collect(streamResponse(response));

    expect(results).toEqual([]);
  });
});
