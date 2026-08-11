# Testing Notes

## Manual Testing

### Test Tool Definition

```typescript
const testTool = {
  type: "function",
  function: {
    name: "get_test_image",
    description: "Returns a test image",
    parameters: { type: "object", properties: {} },
  },
};
```

### Test Tool Result (Text Only - Backward Compat)

```typescript
const textResult: ToolResultChatMessage = {
  role: "tool",
  toolCallId: "call_123",
  content: "This is a text result",
};
```

### Test Tool Result (Multimodal)

```typescript
// Small 1x1 red PNG for testing
const RED_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const imageResult: ToolResultChatMessage = {
  role: "tool",
  toolCallId: "call_123",
  content: [
    { type: "text", text: "Here is the image:" },
    {
      type: "imageUrl",
      imageUrl: {
        url: `data:image/png;base64,${RED_PIXEL_PNG}`,
      },
    },
  ],
};
```

### Test Tool Result (Mixed Content - Multiple Text and Images)

```typescript
// Per reviewer feedback: explicitly test interleaved text/image patterns
const mixedResult: ToolResultChatMessage = {
  role: "tool",
  toolCallId: "call_456",
  content: [
    { type: "text", text: "First text block" },
    {
      type: "imageUrl",
      imageUrl: { url: `data:image/png;base64,${RED_PIXEL_PNG}` },
    },
    { type: "text", text: "Second text block" },
    {
      type: "imageUrl",
      imageUrl: { url: `data:image/jpeg;base64,/9j/4AAQ...` },
    },
  ],
};
```

---

## Provider-Specific Validation

### Anthropic

Verify the API request contains:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_123",
      "content": [
        { "type": "text", "text": "Here is the image:" },
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

### Gemini

Verify the API request contains:

```json
{
  "role": "user",
  "parts": [
    {
      "functionResponse": {
        "name": "get_test_image",
        "response": { "status": "success" },
        "parts": [
          {
            "inlineData": {
              "mimeType": "image/png",
              "data": "iVBORw0KGgo..."
            }
          }
        ]
      }
    }
  ]
}
```

---

## Edge Cases to Test

1. **Empty image data** - Should fall back to text-only
2. **Invalid data URL format** - Should be skipped with warning
3. **Unsupported MIME type** - Should default to image/jpeg (Anthropic) or pass through (Gemini)
4. **Mixed content** - Multiple text + multiple images (see test above)
5. **Image-only** - No text parts, only images
6. **Large images** - Performance/size limits
7. **Empty content array** - Should handle gracefully (return undefined)

---

## Existing Tests to Check

Look for existing tool result tests in:

- `core/llm/llms/Anthropic.vitest.ts`
- `core/llm/llms/Gemini.ts` (no dedicated test file found)

Extend existing tests with multimodal variants.

---

## Integration Test Prompt

```
User: Call the get_test_image tool and describe what you see.

Expected: Model calls tool, receives image, describes the red pixel.
```
