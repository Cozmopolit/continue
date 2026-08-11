# Type Changes for Binary Tool Results

## File: `core/index.d.ts`

### Current Definition (Line ~369)

```typescript
export interface ToolResultChatMessage {
  role: "tool";
  content: string;
  toolCallId: string;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}
```

### Proposed Change

```typescript
export interface ToolResultChatMessage {
  role: "tool";
  content: string | MessagePart[]; // ← Extended to support multimodal
  toolCallId: string;
  /** Arbitrary per-message metadata (IDs, provider-specific info, etc.) */
  metadata?: Record<string, unknown>;
}
```

### Note on MessagePart

`MessagePart` is already defined in Continue:

```typescript
export type TextMessagePart = {
  type: "text";
  text: string;
};

export type ImageMessagePart = {
  type: "imageUrl";
  imageUrl: { url: string }; // data:image/png;base64,... format
};

export type MessagePart = TextMessagePart | ImageMessagePart;
```

This means tool results can now include images via data URLs, which is the standard Continue format for images.

---

## File: `core/config/types.ts`

Same change needs to be applied here (duplicate type definitions):

### Current (Line ~316)

```typescript
export interface ToolResultChatMessage {
  role: "tool";
  content: string;
  toolCallId: string;
}
```

### Proposed

```typescript
export interface ToolResultChatMessage {
  role: "tool";
  content: string | MessagePart[];
  toolCallId: string;
}
```

---

## Backward Compatibility

This change is **backward compatible**:

- Existing code passing `content: "text string"` continues to work
- New code can pass `content: [{ type: "text", text: "..." }, { type: "imageUrl", ... }]`
- Providers that don't support multimodal can extract text parts only

---

## Helper Function (Suggested)

Add a utility to normalize content:

```typescript
// core/llm/util/toolContent.ts
export function getToolResultText(content: string | MessagePart[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is TextMessagePart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function getToolResultImages(
  content: string | MessagePart[],
): ImageMessagePart[] {
  if (typeof content === "string") {
    return [];
  }
  return content.filter(
    (part): part is ImageMessagePart => part.type === "imageUrl",
  );
}
```
