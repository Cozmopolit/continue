import { Readable } from "stream";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatMessage } from "../..";
import Gemini from "./Gemini";

/**
 * The shared vitest setup replaces globalThis.Response with node-fetch's
 * implementation, which cannot carry a web ReadableStream body — bytes never
 * reach the consumer. We therefore return a minimal Response-like object
 * whose body is a Node Readable (works with streamSse via
 * ReadableStream.from), so the stream content is really consumed.
 *
 * Google's `alt=sse` wire format is one `data: {json}` event per line with
 * no `[DONE]` terminator — mirrored here.
 */
function createGeminiSSEResponse(events: Array<object | string>): Response {
  const encoder = new TextEncoder();
  const chunks: Buffer[] = events.map((event) =>
    Buffer.from(
      encoder.encode(
        `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
      ),
    ),
  );
  return {
    status: 200,
    ok: true,
    headers: {
      forEach: (cb: (value: string, key: string) => void) =>
        cb("text/event-stream", "content-type"),
      get: (key: string) =>
        key.toLowerCase() === "content-type" ? "text/event-stream" : null,
    },
    body: Readable.from(chunks),
    text: async () => "",
  } as unknown as Response;
}

/** Non-200 response: streamResponse surfaces the body text as the error. */
function createGeminiErrorResponse(body: string, status: number): Response {
  return {
    status,
    ok: false,
    headers: {
      forEach: (cb: (value: string, key: string) => void) =>
        cb("application/json", "content-type"),
      get: (key: string) =>
        key.toLowerCase() === "content-type" ? "application/json" : null,
    },
    body: Readable.from([Buffer.from(body)]),
    text: async () => body,
  } as unknown as Response;
}

function setupReadableStreamPolyfill() {
  // This can be removed if https://github.com/nodejs/undici/issues/2888 is resolved
  // @ts-ignore
  const originalFrom = ReadableStream.from;
  // @ts-ignore
  ReadableStream.from = (body) => {
    if (body?.source) {
      return body;
    }
    return originalFrom(body);
  };
}

function textEvent(text: string): object {
  return { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

function createGemini(customFetch?: (url: any, init: any) => Promise<any>) {
  const llm = new Gemini({
    model: "gemini-2.0-flash",
    apiKey: "test-key",
    ...(customFetch ? { customFetch } : {}),
  });
  // Disable the OpenAI adapter so our fetch mock is really used.
  (llm as any).useOpenAIAdapterFor = [];
  return llm;
}

beforeEach(() => {
  setupReadableStreamPolyfill();
  vi.restoreAllMocks();
});

describe("processGeminiChunk", () => {
  test("text part yields assistant message with text parts", async () => {
    const llm = createGemini();
    const messages = await collect(
      llm.processGeminiChunk({
        candidates: [{ content: { parts: [{ text: "Hello" }] } }],
      } as any),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("functionCall part yields toolCall with stringified args", async () => {
    const llm = createGemini();
    const messages = await collect(
      llm.processGeminiChunk({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: "call-1",
                    name: "get_weather",
                    args: { city: "Berlin" },
                  },
                  thoughtSignature: "sig-abc",
                },
              ],
            },
          },
        ],
      } as any),
    );
    expect(messages).toHaveLength(1);
    const toolCalls = (messages[0] as any).toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      type: "function",
      id: "call-1",
      function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
    });
    expect(toolCalls[0].extra_content.google.thought_signature).toBe("sig-abc");
  });

  test("error field throws with the upstream message", async () => {
    const llm = createGemini();
    await expect(
      collect(
        llm.processGeminiChunk({
          error: { message: "SAFETY: blocked" },
        } as any),
      ),
    ).rejects.toThrow("SAFETY: blocked");
  });

  test("chunk without candidates yields nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = createGemini();
    const messages = await collect(llm.processGeminiChunk({} as any));
    expect(messages).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("processGeminiResponse (legacy JSON array wire format)", () => {
  async function* chunksOf(...parts: string[]) {
    for (const part of parts) {
      yield part;
    }
  }

  test("parses a multi-object array split mid-event", async () => {
    const llm = createGemini();
    const wire = `[${JSON.stringify(textEvent("Hello"))}\n,${JSON.stringify(
      textEvent(" world"),
    )}]`;
    // Split inside the second object to exercise the buffering path.
    const splitAt = wire.length - 10;
    const messages = await collect(
      llm.processGeminiResponse(
        chunksOf(wire.slice(0, splitAt), wire.slice(splitAt)),
      ),
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toEqual([{ type: "text", text: "Hello" }]);
    expect(messages[1].content).toEqual([{ type: "text", text: " world" }]);
  });

  test("error object inside the array throws", async () => {
    const llm = createGemini();
    const wire = `[${JSON.stringify({ error: { message: "quota" } })}]`;
    await expect(
      collect(llm.processGeminiResponse(chunksOf(wire))),
    ).rejects.toThrow("quota");
  });
});

describe("streamChat (alt=sse path)", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

  test("requests streamGenerateContent with alt=sse", async () => {
    const customFetch = vi.fn(async () => createGeminiSSEResponse([]));
    const llm = createGemini(customFetch);

    await collect(llm.streamChat(messages, new AbortController().signal, {}));

    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toContain(
      "models/gemini-2.0-flash:streamGenerateContent",
    );
    expect(url.searchParams.get("alt")).toBe("sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "test-key",
    );
  });

  test("yields one message per SSE event, in order", async () => {
    const customFetch = vi.fn(async () =>
      createGeminiSSEResponse([textEvent("Hello"), textEvent(" world")]),
    );
    const llm = createGemini(customFetch);

    const result = await collect(
      llm.streamChat(messages, new AbortController().signal, {}),
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual([{ type: "text", text: "Hello" }]);
    expect(result[1].content).toEqual([{ type: "text", text: " world" }]);
  });

  test("SSE event with error field rejects", async () => {
    const customFetch = vi.fn(async () =>
      createGeminiSSEResponse([
        textEvent("partial"),
        { error: { message: "SAFETY: blocked mid-stream" } },
      ]),
    );
    const llm = createGemini(customFetch);

    await expect(
      collect(llm.streamChat(messages, new AbortController().signal, {})),
    ).rejects.toThrow(/SAFETY: blocked mid-stream/);
  });

  test("non-200 response surfaces the upstream error body", async () => {
    const body = JSON.stringify({
      error: { message: "API key not valid", status: "INVALID_ARGUMENT" },
    });
    const customFetch = vi.fn(async () => createGeminiErrorResponse(body, 400));
    const llm = createGemini(customFetch);

    await expect(
      collect(llm.streamChat(messages, new AbortController().signal, {})),
    ).rejects.toThrow(/API key not valid/);
  });
});
