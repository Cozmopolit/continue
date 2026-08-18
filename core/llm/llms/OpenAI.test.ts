import { ChatMessage } from "../..";

import OpenAI from "./OpenAI";

describe("OpenAI", () => {
  test("should identify correct o-series models", () => {
    const openai = new OpenAI({
      model: "o3-mini",
    });
    expect(openai.isOSeriesOrGpt5PlusModel("o4-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o3-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o1-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o1")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o3")).toBeTruthy();

    // artificially correct samples for future models
    expect(openai.isOSeriesOrGpt5PlusModel("o5-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o6")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o77")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("o54-mini")).toBeTruthy();

    // gpt-5+ models
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4-mini")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-5.4-pro")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-6")).toBeTruthy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-7-turbo")).toBeTruthy();
  });
  test("should identify incorrect o-series models", () => {
    const openai = new OpenAI({
      model: "o3-mini",
    });
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-o4-mini")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-4.5")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("gpt-4.1")).toBeFalsy();

    // artificially wrong samples
    expect(openai.isOSeriesOrGpt5PlusModel("os1")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("so1")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("ao31")).toBeFalsy();
    expect(openai.isOSeriesOrGpt5PlusModel("1os")).toBeFalsy();
  });
});

describe("OpenAI _streamComplete thinking guard", () => {
  class ThinkingStubOpenAI extends OpenAI {
    protected async *_streamChat(): AsyncGenerator<ChatMessage> {
      yield { role: "thinking", content: "internal planning monologue" };
      yield { role: "assistant", content: "visible " };
      yield { role: "assistant", content: "answer" };
    }

    // Hermetic access to the adapter's completion-string path (the public
    // streamComplete may branch into the openai-adapters package instead)
    async *completeViaStreamCompleteDelegation(
      prompt: string,
      signal: AbortSignal,
    ): AsyncGenerator<string> {
      yield* this._streamComplete(prompt, signal, { model: this.model });
    }
  }

  test("does not leak thinking chunks into the completion stream", async () => {
    const llm = new ThinkingStubOpenAI({ model: "gpt-4o-mini" });
    let completion = "";
    for await (const chunk of llm.completeViaStreamCompleteDelegation(
      "prompt",
      new AbortController().signal,
    )) {
      completion += chunk;
    }
    expect(completion).toBe("visible answer");
  });
});
