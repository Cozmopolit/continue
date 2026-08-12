import { jest } from "@jest/globals";
import { ChatMessage, LLMOptions, Usage } from "..";

import { allModelProviders } from "@continuedev/llm-info";
import { LlmInfo } from "@continuedev/llm-info/dist/types";
import { BaseLLM } from ".";
import { countTokens } from "./countTokens.js";
import { DevDataSqliteDb } from "../data/devdataSqlite.js";
import { DataLogger } from "../data/log.js";
import { DEFAULT_CONTEXT_LENGTH } from "./constants";
import { LLMClasses } from "./llms";
import { LLMLogger } from "./logger";

class DummyLLM extends BaseLLM {
  static providerName = "openai";
  static defaultOptions: Partial<LLMOptions> = {
    model: "dummy-model",
    contextLength: 200_000,
    completionOptions: {
      model: "some-model",
      maxTokens: 4096,
    },
    apiBase: "https://api.test-api-dummy.com/v1/",
  };
}
describe("BaseLLM", () => {
  let baseLLM: BaseLLM;

  beforeEach(() => {
    const options: LLMOptions = {
      model: "dummy-model",
    };
    // Instantiate a DummyLLM instance
    baseLLM = new DummyLLM(options);
  });

  describe("BaseLLM constructor", () => {
    it("should correctly initialize with given options", () => {
      const templatMessagesFunction = (messages: ChatMessage[]) => {
        return messages[0]?.content.toString() ?? "";
      };
      const llmLogger = new LLMLogger();
      const options: LLMOptions = {
        model: "gpt-3.5-turbo",
        uniqueId: "testId",
        contextLength: 1024,
        completionOptions: {
          model: "some-model",
          maxTokens: 150,
        },
        requestOptions: {},
        promptTemplates: {},
        templateMessages: templatMessagesFunction,
        logger: llmLogger,
        llmRequestHook: () => {},
        apiKey: "testApiKey",
        aiGatewaySlug: "testSlug",
        apiBase: "https://api.example.com",
        accountId: "testAccountId",
        deployment: "davinci",
        apiVersion: "v1",
        apiType: "public",
        region: "us",
        projectId: "testProjectId",
      };

      const instance = new DummyLLM(options);

      expect(instance.title).toBeDefined();
      expect(instance.uniqueId).toBe("testId");
      expect(instance.model).toBe("gpt-3.5-turbo");
      expect(instance.contextLength).toBe(1024);
      expect(instance.completionOptions.maxTokens).toBe(150);
      expect(instance.requestOptions).toEqual({});
      expect(instance.promptTemplates).toEqual({});
      expect(instance.templateMessages).toEqual(templatMessagesFunction);
      expect(instance.logger).toBe(llmLogger);
      expect(instance.apiKey).toBe("testApiKey");
      expect(instance.aiGatewaySlug).toBe("testSlug");
      expect(instance.apiBase).toBe("https://api.example.com/");
      expect(instance.accountId).toBe("testAccountId");
      expect(instance.deployment).toBe("davinci");
      expect(instance.apiVersion).toBe("v1");
      expect(instance.apiType).toBe("public");
      expect(instance.region).toBe("us");
      expect(instance.projectId).toBe("testProjectId");
    });
  });

  test("model should return correct provider model", () => {
    expect(baseLLM.model).toBe("dummy-model");
  });

  test("supportsFim should always return false", () => {
    expect(baseLLM.supportsFim()).toBe(false);
  });

  describe("supportsImages", () => {
    test("should return true when modelSupportsImages returns true", () => {
      baseLLM.model = "gpt-4-vision";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "fancy-vision-model";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "gemma3:4b";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "google/gemma-3-270m";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "gemma4:31b";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "google/gemma-4-31b-it";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "foo/paligemma-custom-100";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "foo/medgemma_4b_it_16Q";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "qwen2.5vl";
      expect(baseLLM.supportsImages()).toBe(true);
    });

    test("should return false when modelSupportsImages returns false", () => {
      expect(baseLLM.supportsImages()).toBe(false);

      baseLLM.model = "gemma3n";
      expect(baseLLM.supportsImages()).toBe(false);
    });
  });

  describe("supportsCompletions", () => {
    test("should return correctly under specific conditions", () => {
      // Mocking properties and scenarios to match the conditions in supportsCompletions
      baseLLM.apiBase = "api.groq.com";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "integrate.api.nvidia.com";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "api.mistral.ai";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = ":1337";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "something:3000";
      expect(baseLLM.supportsCompletions()).toBe(true);
    });
  });
  describe("supportsPrefill", () => {
    test("should return correctly under specific conditions", () => {
      expect(baseLLM.supportsPrefill()).toBe(false);

      class PrefillLLM extends BaseLLM {
        static providerName = "ollama";
      }
      const prefillLLM = new PrefillLLM({ model: "some-model" });
      expect(prefillLLM.supportsPrefill()).toBe(true);
    });
  });
  describe("fetch", () => {
    // TODO: Implement tests for fetch method
  });
  describe("*_streamFim", () => {
    // TODO: Implement tests for *_streamFim method
  });
  describe("complete", () => {
    // TODO: Implement tests for complete method
  });
  describe("*streamChat", () => {
    // TODO: Implement tests for *streamChat method
  });

  describe("default context length", () => {
    allModelProviders.map((modelProvider) => {
      const LLMClass = LLMClasses.find(
        (llm) => llm.providerName === modelProvider.id,
      );
      if (!LLMClass) {
        throw new Error(`did not find LLM provider for ${modelProvider.id}`);
      }
      const testContextLength = (llmInfo: LlmInfo) => () => {
        const llm = new LLMClass({ model: llmInfo.model });
        if (llmInfo.contextLength) {
          expect(llm.contextLength).toEqual(llmInfo.contextLength);
        } else {
          expect(llm.contextLength).toEqual(DEFAULT_CONTEXT_LENGTH);
        }
      };
      describe(`${modelProvider.id}`, () => {
        modelProvider.models.forEach((llmInfo) => {
          test(
            `should have correct context length for ${llmInfo.model}`,
            testContextLength(llmInfo),
          );
        });
      });
    });
  });
});

describe("BaseLLM token usage integration (token-counting-hot-path.md)", () => {
  let llm: BaseLLM;

  const mockInteraction = () => ({ logItem: jest.fn() });

  beforeEach(() => {
    llm = new DummyLLM({ model: "dummy-model" });
    // Avoid real sqlite/file writes during tests
    jest
      .spyOn(DevDataSqliteDb, "logTokensGenerated")
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(DataLogger.prototype, "logDevData")
      .mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("processChatChunk", () => {
    it("extracts usage from assistant chunks carrying usage", () => {
      const usage: Usage = { promptTokens: 11, completionTokens: 22 };
      const chunk: ChatMessage = { role: "assistant", content: "", usage };
      const result = (llm as any).processChatChunk(chunk, undefined);
      expect(result.usage).toEqual(usage);
    });

    it("returns usage null for assistant chunks without usage", () => {
      const chunk: ChatMessage = { role: "assistant", content: "hi" };
      const result = (llm as any).processChatChunk(chunk, undefined);
      expect(result.usage).toBeNull();
    });

    it("collects thinking content from thinking chunks", () => {
      const chunk = { role: "thinking", content: "hmm" } as any;
      const result = (llm as any).processChatChunk(chunk, undefined);
      expect(result.thinking).toEqual(["hmm"]);
      expect(result.usage).toBeNull();
    });

    it("logs each chunk to the interaction log", () => {
      const interaction = mockInteraction();
      const chunk: ChatMessage = { role: "assistant", content: "hi" };
      (llm as any).processChatChunk(chunk, interaction);
      expect(interaction.logItem).toHaveBeenCalledWith({
        kind: "message",
        message: chunk,
      });
    });
  });

  describe("_logEnd usage-first", () => {
    const fullUsage: Usage = {
      promptTokens: 1234,
      completionTokens: 567,
      completionTokensDetails: { reasoningTokens: 89 },
    };

    it("prefers provider usage over local counting", () => {
      const interaction = mockInteraction();
      const status = (llm as any)._logEnd(
        "dummy-model",
        "some prompt that is longer than any usage value",
        "some completion",
        "some thinking",
        interaction,
        fullUsage,
      );
      expect(status).toBe("success");
      expect(interaction.logItem).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "success",
          promptTokens: 1234,
          generatedTokens: 567,
          thinkingTokens: 89,
          usage: fullUsage,
        }),
      );
    });

    it("falls back to local counting when usage is missing", () => {
      const interaction = mockInteraction();
      const prompt = "fallback prompt";
      const completion = "fallback completion";
      (llm as any)._logEnd(
        "dummy-model",
        prompt,
        completion,
        undefined,
        interaction,
        undefined,
      );
      expect(interaction.logItem).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "success",
          promptTokens: countTokens(prompt, "dummy-model"),
          generatedTokens: countTokens(completion, "dummy-model"),
          thinkingTokens: 0,
        }),
      );
    });

    it("counts thinking when usage lacks reasoning details", () => {
      const interaction = mockInteraction();
      const thinking = "deep thoughts";
      (llm as any)._logEnd("dummy-model", "p", "c", thinking, interaction, {
        promptTokens: 10,
        completionTokens: 5,
      });
      expect(interaction.logItem).toHaveBeenCalledWith(
        expect.objectContaining({
          thinkingTokens: countTokens(thinking, "dummy-model"),
        }),
      );
    });

    it("applies usage-first on the error path too", () => {
      const interaction = mockInteraction();
      const status = (llm as any)._logEnd(
        "dummy-model",
        "p",
        "c",
        undefined,
        interaction,
        fullUsage,
        new Error("boom"),
      );
      expect(status).toBe("error");
      expect(interaction.logItem).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "error",
          promptTokens: 1234,
          generatedTokens: 567,
        }),
      );
    });
  });
});
