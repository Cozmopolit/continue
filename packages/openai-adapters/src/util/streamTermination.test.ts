import {
  isPrematureStreamEndError,
  PrematureStreamEndError,
} from "@continuedev/fetch";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildAdapterStreamForensics,
  createChatStreamTerminationStats,
  guardChatCompletionStream,
  shouldEnforceStreamTermination,
  trackChatStreamChunk,
} from "./streamTermination.js";

function chatChunk(options: {
  content?: string;
  reasoning_content?: string;
  finish_reason?: string | null;
  usage?: object;
  id?: string;
}): any {
  return {
    id: options.id ?? "gen-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "moonshotai/kimi-k3",
    choices: [
      {
        index: 0,
        delta: {
          content: options.content,
          reasoning_content: options.reasoning_content,
        },
        finish_reason: options.finish_reason ?? null,
      },
    ],
    usage: options.usage,
  };
}

async function* streamOf<T>(...chunks: T[]): AsyncGenerator<T> {
  for (const c of chunks) {
    yield c;
  }
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of stream) {
    out.push(c);
  }
  return out;
}

const ENV_KEY = "CONTINUE_STRICT_STREAM_TERMINATION";

describe("trackChatStreamChunk", () => {
  test("counts content, reasoning and tool calls", () => {
    const stats = createChatStreamTerminationStats();
    trackChatStreamChunk(stats, chatChunk({ content: "Hello" }));
    trackChatStreamChunk(
      stats,
      chatChunk({ reasoning_content: "thinking..." }),
    );
    trackChatStreamChunk(stats, {
      id: "x",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ function: { name: "f" } }] },
          finish_reason: null,
        },
      ],
    });
    expect(stats.chunks).toBe(3);
    expect(stats.contentChars).toBe(5);
    expect(stats.reasoningChars).toBe(11);
    expect(stats.toolCallChunks).toBe(1);
    expect(stats.sawFinishReason).toBe(false);
    expect(stats.requestId).toBe("gen-1");
  });

  test("records finish reasons and usage", () => {
    const stats = createChatStreamTerminationStats();
    trackChatStreamChunk(stats, chatChunk({ content: "Hi" }));
    trackChatStreamChunk(stats, chatChunk({ finish_reason: "stop" }));
    trackChatStreamChunk(stats, {
      id: "x",
      choices: [],
      usage: { total_tokens: 3 },
    });
    expect(stats.sawFinishReason).toBe(true);
    expect(stats.finishReasons).toEqual(["stop"]);
    expect(stats.sawUsage).toBe(true);
  });

  test("handles legacy completion shape (choices[].text)", () => {
    const stats = createChatStreamTerminationStats();
    trackChatStreamChunk(stats, {
      id: "c1",
      choices: [{ index: 0, text: "abc", finish_reason: "length" }],
    });
    expect(stats.contentChars).toBe(3);
    expect(stats.sawFinishReason).toBe(true);
    expect(stats.finishReasons).toEqual(["length"]);
  });

  test("ignores non-object chunks gracefully", () => {
    const stats = createChatStreamTerminationStats();
    trackChatStreamChunk(stats, null);
    trackChatStreamChunk(stats, "nope");
    expect(stats.chunks).toBe(0);
  });
});

describe("shouldEnforceStreamTermination", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  test("enforces for well-known hosts", () => {
    expect(
      shouldEnforceStreamTermination("https://openrouter.ai/api/v1/"),
    ).toBe(true);
    expect(shouldEnforceStreamTermination("https://api.openai.com/v1/")).toBe(
      true,
    );
    expect(shouldEnforceStreamTermination("https://api.moonshot.ai/v1")).toBe(
      true,
    );
  });

  test("matches subdomains", () => {
    expect(
      shouldEnforceStreamTermination("https://myres.openai.azure.com/openai/"),
    ).toBe(true);
  });

  test("does not enforce for unknown hosts", () => {
    expect(shouldEnforceStreamTermination("http://localhost:11434/v1")).toBe(
      false,
    );
    expect(shouldEnforceStreamTermination("https://llm.internal.corp/v1")).toBe(
      false,
    );
    expect(shouldEnforceStreamTermination(undefined)).toBe(false);
    expect(shouldEnforceStreamTermination("not a url")).toBe(false);
  });

  test("env override forces on/off", () => {
    process.env[ENV_KEY] = "1";
    expect(shouldEnforceStreamTermination("http://localhost:1/v1")).toBe(true);
    process.env[ENV_KEY] = "off";
    expect(
      shouldEnforceStreamTermination("https://openrouter.ai/api/v1/"),
    ).toBe(false);
  });
});

describe("guardChatCompletionStream", () => {
  const openrouter = "https://openrouter.ai/api/v1/";

  test("passes chunks through unchanged for a healthy stream", async () => {
    const chunks = [
      chatChunk({ content: "Hello" }),
      chatChunk({ content: " world" }),
      chatChunk({ finish_reason: "stop" }),
      { id: "gen-1", choices: [], usage: { total_tokens: 10 } },
    ];
    const result = await drain(
      guardChatCompletionStream(streamOf(...chunks), {
        apiBase: openrouter,
        model: "moonshotai/kimi-k3",
      }),
    );
    expect(result).toEqual(chunks);
  });

  test("throws PrematureStreamEndError when stream ends without finish_reason on a strict host", async () => {
    const chunks = [
      chatChunk({ reasoning_content: "let me think about " }),
      chatChunk({ reasoning_content: "this problem deeply" }),
    ];
    let error: unknown;
    try {
      await drain(
        guardChatCompletionStream(streamOf(...chunks), {
          apiBase: openrouter,
          model: "moonshotai/kimi-k3",
          context:
            "openai-adapter chat.completions (https://openrouter.ai/api/v1/)",
        }),
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(PrematureStreamEndError);
    expect(isPrematureStreamEndError(error)).toBe(true);
    const err = error as PrematureStreamEndError;
    expect(err.forensics.dataEventsYielded).toBe(2);
    expect(err.forensics.sawCompletionSignal).toBe(false);
    expect(err.forensics.charsReceived).toBe(19 + 19);
    expect(err.forensics.doneSentinelObservable).toBe(false);
    // SDK-level message must not claim that no [DONE] was seen
    expect(err.message).toContain("no finish_reason was received");
    expect(err.message).not.toContain("no [DONE] sentinel, no finish_reason");
    expect(err.message).toContain("middlebox");
  });

  test("does not throw for missing finish_reason on unknown hosts", async () => {
    const chunks = [chatChunk({ content: "hi" })];
    const result = await drain(
      guardChatCompletionStream(streamOf(...chunks), {
        apiBase: "http://localhost:8080/v1",
      }),
    );
    expect(result).toEqual(chunks);
  });

  test("always throws for a completely empty stream", async () => {
    let error: unknown;
    try {
      await drain(
        guardChatCompletionStream(streamOf(), {
          apiBase: "http://localhost:8080/v1",
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(isPrematureStreamEndError(error)).toBe(true);
    expect((error as PrematureStreamEndError).message).toContain(
      "before any data was received",
    );
  });

  test("does not throw when the abort signal fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = [chatChunk({ content: "partial" })];
    const result = await drain(
      guardChatCompletionStream(streamOf(...chunks), {
        apiBase: openrouter,
        signal: controller.signal,
      }),
    );
    expect(result).toEqual(chunks);
  });

  test("explicit enforce option overrides host detection", async () => {
    const chunks = [chatChunk({ content: "hi" })];
    let error: unknown;
    try {
      await drain(
        guardChatCompletionStream(streamOf(...chunks), {
          apiBase: "http://localhost:8080/v1",
          enforce: true,
        }),
      );
    } catch (e) {
      error = e;
    }
    expect(isPrematureStreamEndError(error)).toBe(true);

    // ...and enforcement can be disabled on strict hosts
    const result = await drain(
      guardChatCompletionStream(streamOf(...chunks), {
        apiBase: openrouter,
        enforce: false,
      }),
    );
    expect(result).toEqual(chunks);
  });
});

describe("buildAdapterStreamForensics", () => {
  test("maps stats to StreamForensics", () => {
    const stats = createChatStreamTerminationStats();
    trackChatStreamChunk(stats, chatChunk({ content: "ab" }));
    trackChatStreamChunk(stats, chatChunk({ finish_reason: "stop" }));
    const forensics = buildAdapterStreamForensics(
      stats,
      Date.now() - 1500,
      "test-context",
    );
    expect(forensics.dataEventsYielded).toBe(2);
    expect(forensics.charsReceived).toBe(2);
    expect(forensics.sawCompletionSignal).toBe(true);
    expect(forensics.completionSignal).toBe("finish_reason=stop");
    expect(forensics.context).toBe("test-context");
    expect(forensics.durationMs).toBeGreaterThanOrEqual(1500);
    expect(forensics.doneSentinelObservable).toBe(false);
  });
});
