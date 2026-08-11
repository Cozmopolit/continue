# Gemini Implementation

## File: `core/llm/llms/gemini-types.ts`

### Current Definition (Lines ~198-204)

```typescript
export type GeminiFunctionResponseContentPart = {
  functionResponse: {
    id?: string;
    name: string;
    response: JSONSchema7Object;
  };
};
```

### Proposed Change

```typescript
export type GeminiFunctionResponseContentPart = {
  functionResponse: {
    id?: string;
    name: string;
    response: JSONSchema7Object;
    /**
     * Optional parts for multimodal function results.
     * Currently only inlineData (for images) is used in function responses.
     * This is a subset of the full Gemini Part type, scoped to what's valid
     * for function results based on API documentation and tested behavior.
     */
    parts?: GeminiFunctionResponsePart[];
  };
};

/**
 * Part within a function response.
 * Note: Only inlineData is currently supported for function results.
 * The Gemini API may support other part types in the future.
 */
export type GeminiFunctionResponsePart = {
  inlineData?: {
    mimeType: string;
    data: string; // base64 encoded
  };
};
```

---

## File: `core/llm/llms/Gemini.ts`

### Current Code (Lines ~257-278)

```typescript
if (msg.role === "tool") {
  let functionName = toolCallIdToNameMap.get(msg.toolCallId);
  if (!functionName) {
    console.warn("Sending tool call response for unidentified tool call");
  }
  return {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: includeToolIds ? msg.toolCallId : undefined,
          name: functionName || "unknown",
          response: {
            output: msg.content, // <- Text only
          },
        },
      },
    ],
  };
}
```

### Proposed Change

```typescript
if (msg.role === "tool") {
  let functionName = toolCallIdToNameMap.get(msg.toolCallId);
  if (!functionName) {
    console.warn("Sending tool call response for unidentified tool call");
  }

  return {
    role: "user",
    parts: [
      {
        functionResponse: this.buildFunctionResponse(
          msg.toolCallId,
          functionName || "unknown",
          msg.content,
          includeToolIds,
        ),
      },
    ],
  };
}
```

### New Helper Method

```typescript
/**
 * Builds a Gemini function response, supporting both text-only and multimodal content.
 */
private buildFunctionResponse(
  toolCallId: string,
  functionName: string,
  content: string | MessagePart[],
  includeToolIds: boolean
): GeminiFunctionResponseContentPart["functionResponse"] {
  // Text-only content (existing behavior)
  if (typeof content === "string") {
    return {
      id: includeToolIds ? toolCallId : undefined,
      name: functionName,
      response: { output: content },
    };
  }

  // Multimodal content
  const textParts = content.filter((p): p is TextMessagePart => p.type === "text");
  const imageParts = content.filter((p): p is ImageMessagePart => p.type === "imageUrl");

  const result: GeminiFunctionResponseContentPart["functionResponse"] = {
    id: includeToolIds ? toolCallId : undefined,
    name: functionName,
    response: {
      status: "success",
      text: textParts.map((p) => p.text).join("\n") || undefined,
    },
  };

  // Add image parts if present
  if (imageParts.length > 0) {
    result.parts = imageParts.map((img) => {
      const base64Data = extractBase64FromDataUrl(img.imageUrl.url);
      const mimeType = getMimeTypeFromDataUrl(img.imageUrl.url) || "image/png";
      return {
        inlineData: {
          mimeType,
          data: base64Data || "",
        },
      };
    });
  }

  return result;
}
```

### Required Imports

```typescript
import { TextMessagePart, ImageMessagePart } from "../../index.js";
import { extractBase64FromDataUrl } from "../../util/url.js";

// Add helper (or import if exists elsewhere):
function getMimeTypeFromDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}
```

---

## Gemini API Reference

Function response with inline data (Gemini 3+):

```json
{
  "functionResponse": {
    "name": "read_attachment",
    "response": {
      "status": "success",
      "message": "Image data attached"
    },
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
```

---

## CITT Reference

See `CITT.Library/Connectors/Gemini/Core/GeminiClientCore.ChatCompletion.cs`:

- Lines 381-414: ImageContent detection and conversion
- `GeminiFunctionResponse.Parts` property
- `GeminiFunctionResponsePart.InlineData` structure
