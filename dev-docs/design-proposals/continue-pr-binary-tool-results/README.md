# PR Draft: Binary Data in Tool/Function Results

## Summary

Add support for **binary data (images) in tool/function call results** for Anthropic Claude and Google Gemini providers.

Currently, Continue's `ToolResultChatMessage` only supports text content. Both Anthropic and Gemini APIs support returning images/binary data as part of tool results, which is essential for tools that return visual content (screenshots, generated images, charts, etc.).

## Scope

**In Scope:**

- `core/llm/llms/Anthropic.ts` - Direct Anthropic API
- `core/llm/llms/Gemini.ts` - Direct Gemini API
- `core/llm/llms/gemini-types.ts` - Type definitions
- `core/index.d.ts` - `ToolResultChatMessage` type extension

**Out of Scope (requires separate investigation):**

- `packages/openai-adapters/` - These use Vercel SDK which may or may not support multimodal tool results. The core providers are independent and work without the adapters package.

> **Note**: Binary tool results are supported for direct Anthropic/Gemini providers only. OpenAI-compatible endpoints (including Vercel SDK adapters) do not yet support this feature.

## Motivation

### Use Case

A tool like `read_attachment` or `take_screenshot` needs to return an image to the model:

```typescript
// Tool returns image data
{
  role: "tool",
  toolCallId: "call_123",
  content: [
    { type: "text", text: "Screenshot captured successfully" },
    { type: "imageUrl", imageUrl: { url: "data:image/png;base64,iVBORw0KGgo..." } }
  ]
}
```

### Current Limitation

```typescript
// core/index.d.ts - Current definition
export interface ToolResultChatMessage {
  role: "tool";
  content: string; // <- Only string supported!
  toolCallId: string;
}
```

### Provider Support

| Provider             | API Support | Continue Support (Current) | Continue Support (After PR) |
| -------------------- | ----------- | -------------------------- | --------------------------- |
| **Anthropic Claude** | Yes         | No (text only)             | Yes                         |
| **Google Gemini 3**  | Yes         | No (text only)             | Yes                         |
| **OpenAI**           | No          | N/A                        | N/A                         |

## Implementation Notes

- This draft is based on a **working and tested implementation in CITT**
- CITT source: `AnthropicClientCore.Converters.cs` and `GeminiClientCore.ChatCompletion.cs`
- Both implementations are production-ready and have been validated against the respective APIs

## Proposed Changes

### 1. Type Changes (`core/index.d.ts`)

Extend `ToolResultChatMessage.content` to support multimodal content:

```typescript
export interface ToolResultChatMessage {
  role: "tool";
  content: string | MessagePart[]; // <- Extended
  toolCallId: string;
  metadata?: Record<string, unknown>;
}
```

### 2. Anthropic Provider

Reuse existing `convertMessageContentToBlocks()` with type filtering for tool results.
See `02-anthropic-impl.md` for details.

### 3. Gemini Provider

Add `parts` property to `functionResponse` for inline binary data.
See `03-gemini-impl.md` for details.

## Files to Modify

| File                            | Changes                                            |
| ------------------------------- | -------------------------------------------------- |
| `core/index.d.ts`               | Extend `ToolResultChatMessage.content` type        |
| `core/llm/llms/Anthropic.ts`    | Handle `MessagePart[]` in `tool_result`            |
| `core/llm/llms/Gemini.ts`       | Handle `MessagePart[]` in `functionResponse`       |
| `core/llm/llms/gemini-types.ts` | Add `parts` to `GeminiFunctionResponseContentPart` |

## Estimated Size

- **~100-150 lines** of code changes
- **4 files** modified
- **Medium complexity** - Provider-specific serialization logic

## References

- [Anthropic Vision Docs](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- [Gemini Multimodal Docs](https://ai.google.dev/gemini-api/docs/vision)
- CITT implementation: `CITT.Library/Connectors/Anthropic/Core/AnthropicClientCore.Converters.cs`
- CITT implementation: `CITT.Library/Connectors/Gemini/Core/GeminiClientCore.ChatCompletion.cs`
