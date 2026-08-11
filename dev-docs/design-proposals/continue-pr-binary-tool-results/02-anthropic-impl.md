# Anthropic Implementation

## File: `core/llm/llms/Anthropic.ts`

### Current Code (Lines 146-158)

```typescript
private getContentBlocksFromChatMessage(
  message: ChatMessage,
): ContentBlockParam[] {
  switch (message.role) {
    // One tool message = one tool_result block
    case "tool":
      return [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: renderChatMessage(message) || undefined,  // <- Text only
        },
      ];
    // ... other cases
  }
}
```

### Proposed Change

**GOOD NEWS**: Continue already has `convertMessageContentToBlocks()` (lines 88-129) that handles
`string | MessagePart[]` -> `ContentBlockParam[]` conversion including images!

We can **reuse** this method with one adjustment: filter out any non-text/image blocks since
`tool_result.content` only accepts `TextBlockParam | ImageBlockParam` (not `ToolUseBlockParam`).

```typescript
case "tool":
  // Handle multimodal tool results (text + images)
  if (typeof message.content === "string") {
    // String content - return as-is (existing behavior)
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content || undefined,
      },
    ];
  } else {
    // MessagePart[] - convert and filter to allowed types
    const blocks = this.convertMessageContentToBlocks(message.content);
    // Filter to only text/image blocks (tool_result doesn't allow tool_use blocks)
    const validBlocks = blocks.filter(
      (b): b is TextBlockParam | ImageBlockParam =>
        b.type === "text" || b.type === "image"
    );
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: validBlocks.length > 0 ? validBlocks : undefined,
      },
    ];
  }
```

### Type Imports Needed

Add to existing imports at top of file:

```typescript
import {
  // ... existing imports ...
  TextBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources/messages.mjs";
```

### Why the Filter?

Per reviewer feedback: `convertMessageContentToBlocks` returns `ContentBlockParam[]` which includes
`ToolUseBlockParam`. While our `MessagePart` type currently only has `text` and `imageUrl` (so the
filter is technically redundant), adding the filter:

1. Makes TypeScript happy (type narrowing)
2. Is defensive against future `MessagePart` expansions
3. Documents explicitly what types are valid for tool results

### Anthropic API Reference

Tool result with image content:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_123",
      "content": [
        { "type": "text", "text": "Screenshot captured" },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "iVBORw0KGgo..."
          }
        }
      ]
    }
  ]
}
```

### CITT Reference

See `CITT.Library/Connectors/Anthropic/Core/AnthropicClientCore.Converters.cs`:

- `ConvertFunctionResultContent()` - Lines 264-296
- `ConvertImageResultContent()` - Lines 307-346
