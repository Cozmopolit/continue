import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChatMessage } from "..";
import { DevDataSqliteDb } from "../data/devdataSqlite.js";
import { DataLogger } from "../data/log.js";
import { Logger } from "../util/Logger.js";
import OpenAI from "./llms/OpenAI";

/**
 * Regression tests for rate-limit retry on the native provider path
 * (rate-limit-retry.md). On this path a non-OK response is thrown by
 * BaseLLM.fetch via parseError before any SSE data flows; retryStream
 * must detect the 429 via the preserved status/headers — even when the
 * response body carries no numeric status/code — and honor Retry-After.
 *
 * `customFetch` is the built-in transport seam (proxy-http-tunneling.md):
 * it routes around fetchwithRequestOptions and the openai-adapter, so the
 * full native chain runs: customFetch -> BaseLLM.fetch -> parseError ->
 * retryStream -> OpenAI._streamChat.
 */

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

/**
 * 429 with Retry-After whose body deliberately contains NO numeric
 * status/code field — detection must come from the preserved response
 * status, not from parsing the body. The wording also avoids the
 * "overloaded"/"malformed json" tokens so withExponentialBackoff stays
 * dormant (no retry stacking, see rate-limit-retry.md amendment).
 */
function rateLimitedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Requests to the Chat Completions API have exceeded the call rate limit of your plan. Please retry after some time.",
        type: "rate_limit",
      },
    }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "0.01",
      },
    },
  );
}

/** Well-formed OpenAI chat completion SSE stream. */
function chatCompletionSseResponse(): Response {
  const sse =
    [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function drainStreamChat(llm: OpenAI): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of llm.streamChat(
    messages,
    new AbortController().signal,
    {},
  )) {
    chunks.push(chunk.content as string);
  }
  return chunks;
}

describe("rate-limit retry on the native provider path", () => {
  beforeEach(() => {
    // Avoid real sqlite/file writes and noisy logs during tests
    vi.spyOn(DevDataSqliteDb, "logTokensGenerated").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(DataLogger.prototype, "logDevData").mockResolvedValue(
      undefined as any,
    );
    vi.spyOn(Logger, "warn").mockImplementation(() => {});
    vi.spyOn(Logger, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("native 429 with Retry-After and no numeric status in the body is retried", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(chatCompletionSseResponse());

    const llm = new OpenAI({
      model: "gpt-4o",
      apiKey: "test-key",
      customFetch,
    });

    const chunks = await drainStreamChat(llm);

    expect(chunks.join("")).toBe("Hello world");
    // Exactly one retry: no double-retry stacking with
    // withExponentialBackoff (rate-limit-retry.md amendment)
    expect(customFetch).toHaveBeenCalledTimes(2);
  });

  test("persistent 429 exhausts all attempts and surfaces the error", async () => {
    // Fresh Response per call — like a real HTTP request per attempt
    const customFetch = vi.fn().mockImplementation(() => rateLimitedResponse());

    const llm = new OpenAI({
      model: "gpt-4o",
      apiKey: "test-key",
      customFetch,
    });

    await expect(drainStreamChat(llm)).rejects.toThrow(/HTTP 429/);

    // RATE_LIMIT_RETRY: maxAttempts = 5
    expect(customFetch).toHaveBeenCalledTimes(5);
  });

  test("non-429 errors are not retried", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const llm = new OpenAI({
      model: "gpt-4o",
      apiKey: "test-key",
      customFetch,
    });

    await expect(drainStreamChat(llm)).rejects.toThrow(/HTTP 401/);

    expect(customFetch).toHaveBeenCalledTimes(1);
  });
});
