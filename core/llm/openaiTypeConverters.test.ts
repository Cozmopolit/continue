import {
  fromChatCompletionChunk,
  isItemType,
  toResponsesInput,
} from "./openaiTypeConverters";
import { AssistantChatMessage, ChatMessage } from "..";
import type {
  EasyInputMessage,
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseReasoningItem,
  ResponseOutputMessage,
} from "openai/resources/responses/responses.mjs";

function getFunctionCalls(
  items: ResponseInputItem[],
): ResponseFunctionToolCall[] {
  return items.filter((i): i is ResponseFunctionToolCall =>
    isItemType<ResponseFunctionToolCall>(i, "function_call"),
  );
}

function getFunctionCallOutputs(
  items: ResponseInputItem[],
): ResponseInputItem.FunctionCallOutput[] {
  return items.filter((i): i is ResponseInputItem.FunctionCallOutput =>
    isItemType<ResponseInputItem.FunctionCallOutput>(i, "function_call_output"),
  );
}

function getReasoningItems(
  items: ResponseInputItem[],
): ResponseReasoningItem[] {
  return items.filter((i): i is ResponseReasoningItem =>
    isItemType<ResponseReasoningItem>(i, "reasoning"),
  );
}

function getMessagesByRole(items: ResponseInputItem[], role: string) {
  return items.filter((item) => {
    if (!("role" in item) || item.role !== role) return false;
    return !("type" in item) || item.type === "message";
  });
}

describe("openaiTypeConverters", () => {
  describe("toResponsesInput", () => {
    describe("tool calls handling - OpenAI Responses API", () => {
      it("should emit function_call items when fc_ ID is in metadata", () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "List files in current directory",
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_abc123",
                type: "function",
                function: {
                  name: "filesystem_list_directory",
                  arguments: '{"path": "."}',
                },
              },
            ],
            metadata: { responsesOutputItemId: "fc_abc123" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_abc123");
        expect(functionCalls[0].call_id).toBe("call_abc123");
        expect(functionCalls[0].name).toBe("filesystem_list_directory");
      });

      it("should emit function_call WITHOUT id when no fc_ ID in metadata", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "I'll help.",
            toolCalls: [
              {
                id: "call_xyz",
                type: "function",
                function: {
                  name: "some_tool",
                  arguments: "{}",
                },
              },
            ],
            // No metadata with fc_ ID
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Should still emit function_call (without id) so tool results aren't orphaned
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBeUndefined();
        expect(functionCalls[0].call_id).toBe("call_xyz");

        // Text should still be emitted
        const assistantMessages = getMessagesByRole(result, "assistant");
        expect(assistantMessages.length).toBe(1);
      });

      it("should emit text content alongside tool calls", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "Let me help you with that.",
            toolCalls: [
              {
                id: "call_xyz",
                type: "function",
                function: {
                  name: "some_tool",
                  arguments: "{}",
                },
              },
            ],
            metadata: { responsesOutputItemId: "fc_xyz" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const functionCalls = getFunctionCalls(result);
        const assistantMessages = getMessagesByRole(result, "assistant");

        expect(functionCalls.length).toBe(1);
        expect(assistantMessages.length).toBe(1);
        expect((assistantMessages[0] as EasyInputMessage).content).toBe(
          "Let me help you with that.",
        );
      });

      it("should filter out msg_ IDs from responsesOutputItemIds", () => {
        // When streaming, both msg_ and fc_ IDs accumulate in responsesOutputItemIds.
        // Only fc_ IDs should be used for function_call items.
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "Let me read those files.",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"test.py"}',
                },
              },
            ],
            metadata: {
              // msg_ ID came first (from message output_item.added),
              // fc_ ID came second (from function_call output_item.added)
              responsesOutputItemIds: ["msg_abc123", "fc_001"],
              responsesOutputItemId: "fc_001",
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        // Must use fc_ ID, not msg_ ID
        expect(functionCalls[0].id).toBe("fc_001");
        expect(functionCalls[0].call_id).toBe("call_001");
      });
    });

    describe("function_call_output handling", () => {
      it("should emit function_call_output when preceded by matching function_call", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_abc123",
                type: "function",
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          } as ChatMessage,
          {
            role: "tool",
            content: '{"files": ["a.txt", "b.txt"]}',
            toolCallId: "call_abc123",
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const outputs = getFunctionCallOutputs(result);
        expect(outputs.length).toBe(1);
        expect(outputs[0].call_id).toBe("call_abc123");
      });

      it("should remove orphaned function_call_output with no matching function_call", () => {
        const messages: ChatMessage[] = [
          {
            role: "tool",
            content: '{"files": ["a.txt", "b.txt"]}',
            toolCallId: "call_abc123",
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Orphaned — no function_call with call_id "call_abc123" exists
        const outputs = getFunctionCallOutputs(result);
        expect(outputs.length).toBe(0);
      });
    });

    // Complete conversation flow tests
    it("should handle full tool call cycle with fc_ IDs", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: "List files",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_list",
              type: "function",
              function: {
                name: "list_files",
                arguments: "{}",
              },
            },
          ],
          metadata: { responsesOutputItemId: "fc_list" },
        } as ChatMessage,
        {
          role: "tool",
          content: '["file1.txt", "file2.txt"]',
          toolCallId: "call_list",
        } as ChatMessage,
      ];

      const result = toResponsesInput(messages);

      const userMsgs = getMessagesByRole(result, "user");
      const functionCalls = getFunctionCalls(result);
      const functionOutputs = getFunctionCallOutputs(result);

      expect(userMsgs.length).toBe(1);
      expect(functionCalls.length).toBe(1);
      expect(functionOutputs.length).toBe(1);

      expect(functionCalls[0].id).toBe("fc_list");
      expect(functionCalls[0].call_id).toBe("call_list");
      expect(functionOutputs[0].call_id).toBe("call_list");
    });

    it("should handle parallel tool calls merged into ONE message with responsesOutputItemIds array", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: "Read these 3 files",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_001",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.py"}',
              },
            },
            {
              id: "call_002",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.js"}',
              },
            },
            {
              id: "call_003",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.ts"}',
              },
            },
          ],
          metadata: {
            responsesOutputItemIds: ["fc_001", "fc_002", "fc_003"],
            responsesOutputItemId: "fc_003",
          },
        } as ChatMessage,
        {
          role: "tool",
          content: "# Python code",
          toolCallId: "call_001",
        } as ChatMessage,
        {
          role: "tool",
          content: "// JS code",
          toolCallId: "call_002",
        } as ChatMessage,
        {
          role: "tool",
          content: "// TS code",
          toolCallId: "call_003",
        } as ChatMessage,
      ];

      const result = toResponsesInput(messages);

      const functionCalls = getFunctionCalls(result);
      expect(functionCalls.length).toBe(3);

      expect(functionCalls[0].id).toBe("fc_001");
      expect(functionCalls[0].call_id).toBe("call_001");
      expect(functionCalls[1].id).toBe("fc_002");
      expect(functionCalls[1].call_id).toBe("call_002");
      expect(functionCalls[2].id).toBe("fc_003");
      expect(functionCalls[2].call_id).toBe("call_003");

      const functionOutputs = getFunctionCallOutputs(result);
      expect(functionOutputs.length).toBe(3);
    });

    it("should handle 3 parallel tool calls when each has its own fc_ ID (separate messages)", () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: "Read these 3 files",
        },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_001",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.py"}',
              },
            },
          ],
          metadata: { responsesOutputItemId: "fc_001" },
        } as ChatMessage,
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_002",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.js"}',
              },
            },
          ],
          metadata: { responsesOutputItemId: "fc_002" },
        } as ChatMessage,
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_003",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"test.ts"}',
              },
            },
          ],
          metadata: { responsesOutputItemId: "fc_003" },
        } as ChatMessage,
        {
          role: "tool",
          content: "# Python code",
          toolCallId: "call_001",
        } as ChatMessage,
        {
          role: "tool",
          content: "// JS code",
          toolCallId: "call_002",
        } as ChatMessage,
        {
          role: "tool",
          content: "// TS code",
          toolCallId: "call_003",
        } as ChatMessage,
      ];

      const result = toResponsesInput(messages);

      const functionCalls = getFunctionCalls(result);
      expect(functionCalls.length).toBe(3);

      const fcIds = functionCalls.map((fc) => fc.id);
      expect(fcIds).toContain("fc_001");
      expect(fcIds).toContain("fc_002");
      expect(fcIds).toContain("fc_003");

      const functionOutputs = getFunctionCallOutputs(result);
      expect(functionOutputs.length).toBe(3);
    });

    describe("reasoning item sanitization", () => {
      it("should remove reasoning items without encrypted_content", () => {
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              { type: "summary_text", text: "Thinking about the problem" },
              // No encrypted_content
            ],
            metadata: { reasoningId: "rs_001" },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Here is the answer.",
            metadata: { responsesOutputItemId: "msg_001" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(0);

        // Assistant message should still be present
        const assistantMsgs = getMessagesByRole(result, "assistant");
        expect(assistantMsgs.length).toBe(1);
      });

      it("should keep reasoning items WITH encrypted_content followed by function_call", () => {
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              { type: "summary_text", text: "Let me use a tool" },
              {
                type: "encrypted_content",
                encrypted_content: "encrypted_data_here",
              },
            ],
            metadata: { reasoningId: "rs_001" },
          } as ChatMessage,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
            metadata: {
              responsesOutputItemIds: ["fc_001"],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(1);
        expect(reasoning[0].id).toBe("rs_001");

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_001");
      });

      it("should strip fc_ id from function_calls after removed reasoning", () => {
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              // No encrypted_content — will be removed
            ],
            metadata: { reasoningId: "rs_001" },
          } as ChatMessage,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
            metadata: {
              responsesOutputItemIds: ["fc_001"],
            },
          } as ChatMessage,
          {
            role: "tool",
            content: "file contents",
            toolCallId: "call_001",
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Reasoning should be removed
        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(0);

        // function_call should still be emitted but without id
        // (so API doesn't look for the missing reasoning)
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBeUndefined();
        expect(functionCalls[0].call_id).toBe("call_001");

        // function_call_output should still match
        const outputs = getFunctionCallOutputs(result);
        expect(outputs.length).toBe(1);
        expect(outputs[0].call_id).toBe("call_001");
      });

      it("should strip msg_ id from message after removed reasoning", () => {
        // When reasoning is removed, a following message item's msg_ ID
        // also references that reasoning — must be stripped too.
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              // No encrypted_content — will be removed
            ],
            metadata: { reasoningId: "rs_001" },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Here is the answer.",
            metadata: { responsesOutputItemId: "msg_001" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(0);

        // Message should still exist but without its msg_ ID
        const assistantMsgs = getMessagesByRole(result, "assistant");
        expect(assistantMsgs.length).toBe(1);
        expect((assistantMsgs[0] as ResponseOutputMessage).id).toBeUndefined();
      });

      it("should recover encrypted_content from metadata fallback", () => {
        // When reasoning_details doesn't contain encrypted_content but
        // metadata does (e.g. metadata was preserved but details were incomplete)
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              { type: "summary_text", text: "Thinking..." },
              // No encrypted_content in reasoning_details
            ],
            metadata: {
              reasoningId: "rs_001",
              encrypted_content: "recovered_encrypted_data",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
            metadata: { responsesOutputItemIds: ["fc_001"] },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Reasoning should be KEPT because encrypted_content was recovered from metadata
        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(1);
        expect(reasoning[0].encrypted_content).toBe("recovered_encrypted_data");

        // function_call should keep its id since reasoning is present
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_001");
      });

      it("should remove trailing reasoning items (no valid successor)", () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "Hello",
          },
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              {
                type: "encrypted_content",
                encrypted_content: "encrypted_data",
              },
            ],
            metadata: { reasoningId: "rs_001" },
          } as ChatMessage,
          // No assistant/function_call follows — interrupted conversation
        ];

        const result = toResponsesInput(messages);

        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(0);
      });
    });

    describe("orphaned function_call_output removal", () => {
      it("should remove function_call_output with no matching function_call", () => {
        // This can happen when conversation history is truncated/pruned
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "Hello",
          },
          // function_call was pruned, but tool result remains
          {
            role: "tool",
            content: "result data",
            toolCallId: "call_orphan",
          } as ChatMessage,
          {
            role: "assistant",
            content: "Here are the results.",
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const outputs = getFunctionCallOutputs(result);
        expect(outputs.length).toBe(0);

        // Other items should be preserved
        const userMsgs = getMessagesByRole(result, "user");
        expect(userMsgs.length).toBe(1);
        const assistantMsgs = getMessagesByRole(result, "assistant");
        expect(assistantMsgs.length).toBe(1);
      });

      it("should keep function_call_output that has a matching function_call", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_valid",
                type: "function",
                function: { name: "tool", arguments: "{}" },
              },
            ],
            metadata: { responsesOutputItemIds: ["fc_valid"] },
          } as ChatMessage,
          {
            role: "tool",
            content: "result",
            toolCallId: "call_valid",
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const outputs = getFunctionCallOutputs(result);
        expect(outputs.length).toBe(1);
        expect(outputs[0].call_id).toBe("call_valid");
      });
    });

    describe("edge cases", () => {
      it("should handle empty messages array", () => {
        const result = toResponsesInput([]);
        expect(result).toEqual([]);
      });

      it("should handle assistant message with empty toolCalls array", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "No tools needed",
            toolCalls: [],
            metadata: { responsesOutputItemId: "msg_empty" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(0);

        // Should emit as message with msg_ ID
        const assistantMessages = getMessagesByRole(result, "assistant");
        expect(assistantMessages.length).toBe(1);
      });

      it("should handle assistant message with undefined metadata", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "Hello",
            toolCalls: [
              {
                id: "call_test",
                type: "function",
                function: {
                  name: "test_tool",
                  arguments: "{}",
                },
              },
            ],
            // metadata is undefined
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Should still emit function_call (without id)
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBeUndefined();
        expect(functionCalls[0].call_id).toBe("call_test");
      });

      it("should handle more toolCalls than responsesOutputItemIds", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "tool1", arguments: "{}" },
              },
              {
                id: "call_002",
                type: "function",
                function: { name: "tool2", arguments: "{}" },
              },
              {
                id: "call_003",
                type: "function",
                function: { name: "tool3", arguments: "{}" },
              },
            ],
            metadata: {
              // Only 2 IDs for 3 tool calls
              responsesOutputItemIds: ["fc_001", "fc_002"],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // All 3 function_calls should be emitted; third one without id
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(3);
        expect(functionCalls[0].id).toBe("fc_001");
        expect(functionCalls[1].id).toBe("fc_002");
        expect(functionCalls[2].id).toBeUndefined();
      });

      it("should handle toolCall with missing function name", () => {
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "", arguments: "{}" }, // Empty name
              },
            ],
            metadata: { responsesOutputItemIds: ["fc_001"] },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Should skip tool calls with empty name
        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(0);
      });

      it("should handle user message with various content types", () => {
        const messages: ChatMessage[] = [
          { role: "user", content: "Simple string" },
          {
            role: "user",
            content: [{ type: "text", text: "Array content" }],
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const userMessages = getMessagesByRole(result, "user");
        expect(userMessages.length).toBe(2);
      });

      it("should handle system message (converted to developer role)", () => {
        const messages: ChatMessage[] = [
          { role: "system", content: "You are a helpful assistant" },
        ];

        const result = toResponsesInput(messages);

        const devMessages = getMessagesByRole(result, "developer");
        expect(devMessages.length).toBe(1);
      });
    });

    // Regression tests for the GPT-5.6 multi-turn failure:
    // provider emits reasoning -> message -> function_call per turn, and the
    // replay must preserve that mixed order via metadata.responsesOutputItemIds.
    // See dev-docs/specifications/preserve-openai-responses-output-order.md.
    describe("output-item order preservation (preserve-openai-responses-output-order.md)", () => {
      it("should preserve provider order msg_ -> fc_ (the exact failing GPT-5.6 turn)", () => {
        // Failing replay: reasoning -> message -> function_call was rebuilt as
        // reasoning -> function_call -> message, and Azure rejected the history
        // because msg_ lost its required preceding reasoning item.
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "List the files and tell me what you see",
          },
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_001" },
              {
                type: "encrypted_content",
                encrypted_content: "encrypted_data_here",
              },
            ],
            metadata: {
              reasoningId: "rs_001",
              encrypted_content: "encrypted_data_here",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Let me check the directory contents.",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: {
                  name: "list_files",
                  arguments: '{"path":"."}',
                },
              },
            ],
            metadata: {
              responsesOutputItemIds: ["msg_001", "fc_001"],
              responsesOutputItemId: "fc_001",
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        // Order must match the original provider emission:
        // user message, reasoning, output message, function_call.
        const observed = result.map((item) => {
          if (isItemType<ResponseReasoningItem>(item, "reasoning"))
            return "reasoning";
          if (isItemType<ResponseFunctionToolCall>(item, "function_call"))
            return "function_call";
          if ("type" in item && item.type === "message")
            return `message:${(item as any).role}`;
          return `other:${(item as any).type}`;
        });

        expect(observed).toEqual([
          "message:user",
          "reasoning",
          "message:assistant",
          "function_call",
        ]);

        // IDs must follow the same mixed order.
        const assistantMsg = result.find(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        ) as ResponseOutputMessage;
        expect(assistantMsg.id).toBe("msg_001");
        expect(assistantMsg.content[0]).toMatchObject({
          type: "output_text",
          text: "Let me check the directory contents.",
        });

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_001");
        expect(functionCalls[0].call_id).toBe("call_001");
      });

      it("should preserve provider order for parallel calls: msg_ -> fc_ -> fc_ -> fc_", () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "Read these 3 files",
          },
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_parallel" },
              {
                type: "encrypted_content",
                encrypted_content: "encrypted_data",
              },
            ],
            metadata: {
              reasoningId: "rs_parallel",
              encrypted_content: "encrypted_data",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Reading all three files.",
            toolCalls: [
              {
                id: "call_001",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.py"}' },
              },
              {
                id: "call_002",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"b.js"}' },
              },
              {
                id: "call_003",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"c.ts"}' },
              },
            ],
            metadata: {
              responsesOutputItemIds: [
                "msg_parallel",
                "fc_001",
                "fc_002",
                "fc_003",
              ],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const fcItems = getFunctionCalls(result);
        expect(fcItems.length).toBe(3);

        // Positional mapping: nth fc_ ID stays with nth tool call.
        expect(fcItems[0].id).toBe("fc_001");
        expect(fcItems[0].call_id).toBe("call_001");
        expect(fcItems[1].id).toBe("fc_002");
        expect(fcItems[1].call_id).toBe("call_002");
        expect(fcItems[2].id).toBe("fc_003");
        expect(fcItems[2].call_id).toBe("call_003");

        // And the message must appear before the function calls, matching the
        // original provider interleaving.
        const messageIndex = result.findIndex(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        );
        const firstFcIndex = result.findIndex((i) =>
          isItemType<ResponseFunctionToolCall>(i, "function_call"),
        );
        expect(messageIndex).toBeGreaterThan(-1);
        expect(firstFcIndex).toBeGreaterThan(-1);
        expect(messageIndex).toBeLessThan(firstFcIndex);
      });

      it("should deduplicate repeated metadata IDs without duplicating items", () => {
        // The streaming reducer can append the same responsesOutputItemId more
        // than once; replay must not duplicate the message or function_call.
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_dedup" },
              {
                type: "encrypted_content",
                encrypted_content: "enc",
              },
            ],
            metadata: {
              reasoningId: "rs_dedup",
              encrypted_content: "enc",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Done once.",
            toolCalls: [
              {
                id: "call_once",
                type: "function",
                function: { name: "noop", arguments: "{}" },
              },
            ],
            metadata: {
              responsesOutputItemIds: [
                "msg_dedup",
                "msg_dedup",
                "fc_once",
                "fc_once",
              ],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const assistantMessages = result.filter(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        );
        expect(assistantMessages.length).toBe(1);

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_once");
      });

      it("should keep legacy behavior when no ordered metadata exists", () => {
        // Without responsesOutputItemIds there is no authoritative order; the
        // previous deterministic layout (calls first, then text) is retained.
        const messages: ChatMessage[] = [
          {
            role: "assistant",
            content: "Working on it.",
            toolCalls: [
              {
                id: "call_legacy",
                type: "function",
                function: { name: "legacy_tool", arguments: "{}" },
              },
            ],
            // no metadata
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBeUndefined();
        expect(functionCalls[0].call_id).toBe("call_legacy");

        const assistantMessages = getMessagesByRole(result, "assistant");
        expect(assistantMessages.length).toBe(1);

        // Legacy ordering: calls before text.
        const fcIndex = result.findIndex((i) =>
          isItemType<ResponseFunctionToolCall>(i, "function_call"),
        );
        const msgIndex = result.findIndex(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        );
        expect(fcIndex).toBeLessThan(msgIndex);
      });

      it("should keep an empty text message when only a msg_ ID is present", () => {
        // A text-only assistant turn can carry an empty content string but a
        // msg_ ID; the empty message must still be emitted with that ID.
        const messages: ChatMessage[] = [
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_empty" },
              { type: "encrypted_content", encrypted_content: "enc" },
            ],
            metadata: {
              reasoningId: "rs_empty",
              encrypted_content: "enc",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "",
            metadata: { responsesOutputItemId: "msg_empty" },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const assistantMessages = getMessagesByRole(result, "assistant");
        expect(assistantMessages.length).toBe(1);
        expect((assistantMessages[0] as ResponseOutputMessage).id).toBe(
          "msg_empty",
        );
        expect(
          (assistantMessages[0] as ResponseOutputMessage).content[0],
        ).toMatchObject({ type: "output_text", text: "" });
      });
    });

    describe("reasoning-group safety invariant", () => {
      it("should strip msg_/fc_ IDs when a previous reasoning was removed", () => {
        // A stored reasoning id without encrypted_content cannot be replayed;
        // the downstream msg_/fc_ IDs still reference that lost reasoning and
        // must be stripped (content and call_id stay).
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "Do the thing",
          },
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_stale" },
              // No encrypted_content — will be removed, breaking the group.
            ],
            metadata: { reasoningId: "rs_stale" },
          } as ChatMessage,
          {
            role: "assistant",
            content: "Working.",
            toolCalls: [
              {
                id: "call_stale",
                type: "function",
                function: { name: "stale_tool", arguments: "{}" },
              },
            ],
            metadata: {
              responsesOutputItemIds: ["msg_stale", "fc_stale"],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const assistantMsg = result.find(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        ) as ResponseOutputMessage;
        expect(assistantMsg.id).toBeUndefined();
        expect(assistantMsg.content[0]).toMatchObject({
          type: "output_text",
          text: "Working.",
        });

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBeUndefined();
        expect(functionCalls[0].call_id).toBe("call_stale");
        expect(functionCalls[0].name).toBe("stale_tool");
      });

      it("should keep msg_/fc_ IDs when a valid reasoning group precedes them", () => {
        const messages: ChatMessage[] = [
          {
            role: "user",
            content: "Go",
          },
          {
            role: "thinking",
            content: "",
            reasoning_details: [
              { type: "reasoning_id", id: "rs_kept" },
              { type: "encrypted_content", encrypted_content: "enc" },
            ],
            metadata: {
              reasoningId: "rs_kept",
              encrypted_content: "enc",
            },
          } as ChatMessage,
          {
            role: "assistant",
            content: "On it.",
            toolCalls: [
              {
                id: "call_kept",
                type: "function",
                function: { name: "kept_tool", arguments: "{}" },
              },
            ],
            metadata: {
              responsesOutputItemIds: ["msg_kept", "fc_kept"],
            },
          } as ChatMessage,
        ];

        const result = toResponsesInput(messages);

        const reasoning = getReasoningItems(result);
        expect(reasoning.length).toBe(1);
        expect(reasoning[0].id).toBe("rs_kept");

        const assistantMsg = result.find(
          (i) =>
            "type" in i &&
            i.type === "message" &&
            "role" in i &&
            i.role === "assistant",
        ) as ResponseOutputMessage;
        expect(assistantMsg.id).toBe("msg_kept");

        const functionCalls = getFunctionCalls(result);
        expect(functionCalls.length).toBe(1);
        expect(functionCalls[0].id).toBe("fc_kept");
      });
    });
  });
});

describe("fromChatCompletionChunk usage mapping (token-counting-hot-path.md)", () => {
  const baseChunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4",
  };

  const fullUsage = {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
    completion_tokens_details: { reasoning_tokens: 5 },
    prompt_tokens_details: { cached_tokens: 8 },
  };

  it("maps a usage-only final chunk to an empty assistant message", () => {
    const chunk = { ...baseChunk, choices: [], usage: fullUsage };
    const result = fromChatCompletionChunk(chunk as any);
    expect(result).toEqual({
      role: "assistant",
      content: "",
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        completionTokensDetails: { reasoningTokens: 5 },
        promptTokensDetails: { cachedTokens: 8 },
      },
    });
  });

  it("maps usage without detail fields to the two required fields only", () => {
    const chunk = {
      ...baseChunk,
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    };
    const result = fromChatCompletionChunk(chunk as any);
    expect(result?.role).toBe("assistant");
    expect((result as AssistantChatMessage)?.usage).toEqual({
      promptTokens: 3,
      completionTokens: 4,
    });
  });

  it("attaches usage to content chunks", () => {
    const chunk = {
      ...baseChunk,
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
      usage: fullUsage,
    };
    const result = fromChatCompletionChunk(chunk as any);
    expect(result?.role).toBe("assistant");
    expect(result?.content).toBe("Hi");
    expect((result as AssistantChatMessage)?.usage?.promptTokens).toBe(10);
  });

  it("leaves usage undefined for chunks without usage", () => {
    const chunk = {
      ...baseChunk,
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    };
    const result = fromChatCompletionChunk(chunk as any);
    expect(result?.content).toBe("Hi");
    expect((result as AssistantChatMessage)?.usage).toBeUndefined();
  });

  it("attaches usage to tool call chunks", () => {
    const chunk = {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: fullUsage,
    };
    const result = fromChatCompletionChunk(chunk as any);
    expect(
      (result as AssistantChatMessage)?.toolCalls?.[0]?.function?.name,
    ).toBe("get_weather");
    expect((result as AssistantChatMessage)?.usage?.completionTokens).toBe(20);
  });

  it("does not attach usage to thinking chunks", () => {
    const chunk = {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "hmm" },
          finish_reason: null,
        },
      ],
      usage: fullUsage,
    };
    const result = fromChatCompletionChunk(chunk as any);
    expect(result?.role).toBe("thinking");
    expect((result as any).usage).toBeUndefined();
  });

  it("still returns undefined for empty chunks without usage", () => {
    const chunk = { ...baseChunk, choices: [] };
    expect(fromChatCompletionChunk(chunk as any)).toBeUndefined();
  });
});
