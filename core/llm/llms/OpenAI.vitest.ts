import { Readable } from "stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ILLM } from "../../index.js";
import OpenAI from "./OpenAI.js";

interface LlmTestCase {
  llm: ILLM;
  methodToTest: keyof ILLM;
  params: any[];
  expectedRequest: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Record<string, any>;
  };
  mockResponse?: any;
  mockStream?: any[];
}

/**
 * The shared vitest setup replaces globalThis.Response with node-fetch's
 * implementation, which cannot carry a web ReadableStream body — bytes never
 * reach the consumer. We therefore return a minimal Response-like object
 * whose body is a Node Readable (works with streamSse via
 * ReadableStream.from), so the stream content is really consumed.
 * Real OpenAI-compatible servers always terminate with [DONE].
 */
function createMockSSEResponse(mockStream: any[]): Response {
  const encoder = new TextEncoder();
  const chunks: Buffer[] = [];
  for (const chunk of mockStream) {
    chunks.push(
      Buffer.from(
        encoder.encode(
          `data: ${
            typeof chunk === "string" ? chunk : JSON.stringify(chunk)
          }\n\n`,
        ),
      ),
    );
  }
  chunks.push(Buffer.from(encoder.encode("data: [DONE]\n\n")));

  return {
    status: 200,
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

function setupMockFetch(mockResponse?: any, mockStream?: any[]) {
  const mockFetch = vi.fn();

  if (mockStream) {
    mockFetch.mockResolvedValue(createMockSSEResponse(mockStream));
  } else {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  return mockFetch;
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

async function executeLlmMethod(
  llm: ILLM,
  methodToTest: keyof ILLM,
  params: any[],
) {
  if (typeof (llm as any)[methodToTest] !== "function") {
    throw new Error(
      `Method ${String(methodToTest)} does not exist on the LLM instance.`,
    );
  }

  const result = await (llm as any)[methodToTest](...params);
  if (result?.next) {
    for await (const _ of result) {
    }
  }
}

function assertFetchCall(mockFetch: any, expectedRequest: any) {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mockFetch.mock.calls[0];

  expect(url.toString()).toBe(expectedRequest.url);
  expect(options.method).toBe(expectedRequest.method);

  if (expectedRequest.headers) {
    expect(options.headers).toEqual(
      expect.objectContaining(expectedRequest.headers),
    );
  }

  if (expectedRequest.body) {
    const actualBody = JSON.parse(options.body as string);
    expect(actualBody).toEqual(expectedRequest.body);
  }
}

async function runLlmTest(testCase: LlmTestCase) {
  const {
    llm,
    methodToTest,
    params,
    expectedRequest,
    mockResponse,
    mockStream,
  } = testCase;

  const mockFetch = setupMockFetch(mockResponse, mockStream);
  setupReadableStreamPolyfill();

  (llm as any).fetch = mockFetch;

  // Disable OpenAI adapter to use our custom fetch mock
  (llm as any).useOpenAIAdapterFor = [];

  await executeLlmMethod(llm, methodToTest, params);
  assertFetchCall(mockFetch, expectedRequest);
}

describe("OpenAI", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("streamChat should send a valid request", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "streamChat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_tokens: 2048,
        },
      },
      mockStream: [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ],
    });
  });

  test("chat should send a valid request", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
      ],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_tokens: 2048,
        },
      },
      mockStream: [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ],
    });
  });

  test("streamComplete should send a valid request", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "streamComplete",
      params: ["Hello", new AbortController().signal],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          max_tokens: 2048,
        },
      },
      mockStream: [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ],
    });
  });

  test("complete should send a valid request", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "complete",
      params: ["Hello", new AbortController().signal],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          max_tokens: 2048,
        },
      },
      mockStream: [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
      ],
    });
  });

  test("should handle O1 models correctly", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "o3-mini",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
        { maxTokens: 100 },
      ],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "o3-mini",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_completion_tokens: 100,
        },
      },
      mockStream: [{ choices: [{ delta: { content: "Hello world" } }] }],
    });
  });

  test("should handle tools", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "test_function",
          description: "Test function",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    await runLlmTest({
      llm: openai,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
        { tools },
      ],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_tokens: 2048,
          tools: [
            {
              type: "function",
              function: {
                name: "test_function",
                description: "Test function",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
      },
      mockStream: [{ choices: [{ delta: { content: "I'll help you" } }] }],
    });
  });

  test("should handle custom max tokens", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "gpt-4",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "chat",
      params: [
        [{ role: "user", content: "hello" }],
        new AbortController().signal,
        { maxTokens: 500 },
      ],
      expectedRequest: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-api-key",
          "api-key": "test-api-key",
        },
        body: {
          model: "gpt-4",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          max_tokens: 500,
        },
      },
      mockStream: [{ choices: [{ delta: { content: "Hello" } }] }],
    });
  });

  test("should handle embeddings", async () => {
    const openai = new OpenAI({
      apiKey: "test-api-key",
      model: "text-embedding-ada-002",
      apiBase: "https://api.openai.com/v1/",
    });

    await runLlmTest({
      llm: openai,
      methodToTest: "embed",
      params: [["Hello", "World"]],
      expectedRequest: {
        url: "https://api.openai.com/v1/embeddings",
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
          "api-key": "test-api-key",
        },
        body: {
          input: ["Hello", "World"],
          model: "text-embedding-ada-002",
        },
      },
      mockResponse: {
        data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
      },
    });
  });
});
