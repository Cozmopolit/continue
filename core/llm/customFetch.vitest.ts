import { fetchwithRequestOptions } from "@continuedev/fetch";
import * as openAiAdapters from "@continuedev/openai-adapters";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatMessage, ILLM } from "..";
import Gemini from "./llms/Gemini";
import OpenAI from "./llms/OpenAI";

vi.mock("@continuedev/fetch");
vi.mock("@continuedev/openai-adapters");

/** Consume a streamChat generator, swallowing any errors. */
async function drainStreamChat(llm: ILLM, messages: ChatMessage[]) {
  try {
    const abortController = new AbortController();
    for await (const _ of llm.streamChat(
      messages,
      abortController.signal,
      {},
    )) {
      // drain
    }
  } catch (e) {
    // Errors from dud responses are expected; assertions below check calls.
  }
}

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

function sseResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("LLMOptions.customFetch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("BaseLLM.fetch routes through customFetch instead of fetchwithRequestOptions", async () => {
    const customFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const llm = new OpenAI({
      model: "gpt-4o",
      apiKey: "proxy-key",
      customFetch,
    });

    const resp = await llm.fetch("https://example.com/v1/chat/completions");

    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(customFetch).toHaveBeenCalledWith(expect.any(URL), undefined);
    expect(fetchwithRequestOptions).not.toHaveBeenCalled();
    expect(await resp.text()).toBe("ok");
  });

  test("BaseLLM.fetch uses fetchwithRequestOptions when customFetch is unset", async () => {
    vi.mocked(fetchwithRequestOptions).mockResolvedValue(
      new Response("ok", { status: 200 }) as any,
    );
    const llm = new OpenAI({ model: "gpt-4o", apiKey: "key" });

    await llm.fetch("https://example.com/v1/models");

    expect(fetchwithRequestOptions).toHaveBeenCalledTimes(1);
  });

  test("customFetch set: openai-adapter is bypassed, native path used", async () => {
    const chatCompletionStream = vi.fn(async function* () {
      // never yields
    });
    vi.mocked(openAiAdapters.constructLlmApi).mockReturnValue({
      chatCompletionStream,
    } as any);

    const customFetch = vi.fn(async () => sseResponse());
    const llm = new OpenAI({
      model: "gpt-4o",
      apiKey: "proxy-key",
      customFetch,
    });

    await drainStreamChat(llm, messages);

    expect(chatCompletionStream).not.toHaveBeenCalled();
    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.pathname).toContain("/chat/completions");
    expect(init.method).toBe("POST");
  });

  test("customFetch unset: openai-adapter is used for OpenAI streamChat", async () => {
    const chatCompletionStream = vi.fn(async function* () {
      // never yields
    });
    vi.mocked(openAiAdapters.constructLlmApi).mockReturnValue({
      chatCompletionStream,
    } as any);

    const llm = new OpenAI({ model: "gpt-4o", apiKey: "key" });

    await drainStreamChat(llm, messages);

    expect(chatCompletionStream).toHaveBeenCalledTimes(1);
    expect(fetchwithRequestOptions).not.toHaveBeenCalled();
  });

  test("Gemini chat sends x-goog-api-key header and no ?key= query param", async () => {
    const customFetch = vi.fn(async () => new Response("", { status: 200 }));
    const llm = new Gemini({
      model: "gemini-2.0-flash",
      apiKey: "proxy-key",
      customFetch,
    });

    await drainStreamChat(llm, messages);

    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.searchParams.has("key")).toBe(false);
    expect(url.toString()).not.toContain("proxy-key");
    expect(url.pathname).toContain(
      "models/gemini-2.0-flash:streamGenerateContent",
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "proxy-key",
    );
  });
});
