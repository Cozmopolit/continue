# Kimi K3 Instability: Preserved Thinking Requirements

**Implemented:** 2026-07-20

## Problem Summary

Kimi K3 exhibits highly unstable behavior after 2-3 turns in Continue (loops, syntax hallucinations, losing track of active refactoring tasks). This happens because Continue's history serialization logic strips out Kimi's previous reasoning blocks (`reasoning_content`) before making the next API call.

**Root Cause Identified:** When using Kimi K3 via **OpenRouter** (the common configuration), the OpenRouter provider class does not set `supportsReasoningContentField = true`, so `reasoning_content` is **never added to API payloads** - even though all other infrastructure works correctly.

## Official Requirements from Moonshot/Kimi

Kimi K3 is a 2.8T parameter MoE reasoning model with **"Always-On Preserved Thinking"** - meaning `reasoning_content` from previous assistant messages **must** be sent back in the chat history.

### Model-Specific Behavior

| Model          | Preserved Thinking                  | Requirement                                                                 |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| **kimi-k3**    | Always active                       | `reasoning_content` must be preserved in every historical assistant message |
| kimi-k2.7-code | Always active                       | Mandatory                                                                   |
| kimi-k2.6      | Optional via `thinking.keep: "all"` | Only when enabled                                                           |
| kimi-k2.5      | Not supported                       | N/A                                                                         |

**Source:** [Kimi Platform - Thinking Mode Documentation](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model)

> _"Preserved Thinking means that the reasoning_content from previous turns is passed to the model so it can continue its prior chain of thought."_
>
> _"When using thinking.keep: 'all' (or for kimi-k2.7-code where it's always active), the reasoning_content of every historical assistant message in messages must be kept as-is."_

### API Error When `reasoning_content` is Missing

```
HTTP/1.1 400 Bad Request
{
  "error": {
    "message": "thinking is enabled but reasoning_content is missing in assistant tool call message at index N",
    "type": "invalid_request_error"
  }
}
```

## Affected Tools (Same Root Cause)

This is a **widespread issue** across multiple LLM integration tools:

### LiteLLM

- **Issue #26156**: [Moonshot/Kimi K2.6 - reasoning_content is missing](https://github.com/BerriAI/litellm/issues/26156)
- **Issue #21672**: [Moonshot/Kimi K2.5 - reasoning_content is missing](https://github.com/BerriAI/litellm/issues/21672)

> _"The Moonshot API requires that reasoning_content from the assistant's response be preserved and sent back in the conversation history during multi-step tool calling."_

### OpenWebUI

- **Issue #23175**: [reasoning_content is stripped from assistant tool call messages](https://github.com/open-webui/open-webui/issues/23175)

> _"The issue is in how OpenWebUI reconstructs the conversation history when sending requests to the LLM API. When an assistant message contains both tool_calls and reasoning_content, OpenWebUI appears to be dropping the reasoning_content field before sending it to the API."_

### OpenClaw

- **Issue #70565**: [Kimi K2.5 multi-turn tool calling fails: reasoning_content missing](https://github.com/openclaw/openclaw/issues/70565)
- **Issue #7876**: [Support Moonshot/Kimi reasoning_content field for thinking models](https://github.com/openclaw/openclaw/issues/7876)

> _"Moonshot/Kimi's Anthropic-compatible endpoint has a strict requirement: when thinking is enabled, every assistant message containing tool_use blocks must also include a reasoning_content field in the conversation history. Even an empty string is rejected; a minimum of one space is required."_

## Technical Requirements for the Fix

### 1. Capture and Store `reasoning_content`

When receiving API responses from Kimi models, the `reasoning_content` field must be:

- Extracted from the response
- Stored persistently in the `ChatMessage` object (e.g., as `thinkingBlocks` or `reasoningContent`)

### 2. Serialize `reasoning_content` Back to API Payload

When constructing the `messages[]` array for the next API call:

- Historical assistant messages must include their original `reasoning_content`
- The field must not be stripped during message transformation

### 3. Provider-Specific Detection

Add a flag like `requiresReasoningContentOnAssistantMessages: true` for Kimi models to trigger the preservation logic.

**Reference implementation from OpenCode:**

> _"When requiresReasoningContentOnAssistantMessages is set on an OpenAI-compatible completions provider, carry the prior turn's actual reasoning in the replayed reasoning_content field."_
>
> Source: [OpenCode Issue #3655](https://github.com/earendil-works/pi/issues/3655)

## DeepSeek vs. Kimi Difference

**DeepSeek** is more tolerant:

- `reasoning_content` is only mandatory for **tool-call turns**
- For normal multi-turn without tools, it can be omitted

**Kimi K3** is stricter:

- `reasoning_content` must **always** be preserved (Preserved Thinking is always-on)

**Source:** [DeepSeek Thinking Mode Documentation](https://api-docs.deepseek.com/guides/thinking_mode/)

## OpenRouter API Verification ✅

**Verified 2026-07-20:** OpenRouter fully supports `reasoning_content` for Kimi K3.

### OpenRouter Model Metadata (from `/api/v1/models`)

```json
{
  "id": "moonshotai/kimi-k3",
  "supported_parameters": [
    "include_reasoning",
    "reasoning",
    "reasoning_effort",
    "tool_choice",
    "tools"
  ],
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["max", "high", "low"],
    "default_effort": "max"
  }
}
```

### OpenRouter Reasoning API Fields

From [OpenRouter Reasoning Tokens Documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens):

| Field                       | Direction        | Description                                   |
| --------------------------- | ---------------- | --------------------------------------------- |
| `include_reasoning: true`   | Request          | Request reasoning tokens in response          |
| `message.reasoning`         | Response         | Reasoning content from model                  |
| `message.reasoning_content` | Request/Response | **Alias for `reasoning`** - works identically |
| `message.reasoning_details` | Request/Response | Array with signatures (Claude)                |
| `reasoning.context`         | Request          | `"all_turns"` or `"current_turn"`             |

**Key Finding:** OpenRouter **normalizes** different provider formats:

- Accepts both `reasoning` and `reasoning_content` (identical behavior)
- Transforms and forwards correctly to upstream providers (Moonshot)
- Supports "Preserving Reasoning" for multi-turn continuity

### Preserving Reasoning Documentation

From OpenRouter docs:

> _"Preserving reasoning blocks is useful specifically for tool calling. When models like Claude invoke tools, it is pausing its construction of a response to await external information. When tool results are returned, the model will continue building that existing response."_
>
> _"Use `reasoning_details` when working with models that return special reasoning types (such as encrypted or summarized) - this preserves the full structure needed for those models. For models that only return raw reasoning strings, you can use the simpler `reasoning` field. You can also use `reasoning_content` as an alias - it functions identically to `reasoning`."_

**Conclusion:** The problem is NOT that OpenRouter lacks support. The problem is that Continue's OpenRouter provider class doesn't enable `supportsReasoningContentField` for Kimi models, so the field is never added to outgoing requests.

## Expected Behavior in Continue

### Current (Broken)

1. User sends message
2. Kimi K3 responds with `content` + `reasoning_content`
3. Continue displays `<thinking>` block in UI (collapsible spoiler)
4. User sends follow-up message
5. Continue serializes chat history **without** `reasoning_content`
6. Kimi K3 becomes unstable / returns 400 error

### Target (Fixed)

1. User sends message
2. Kimi K3 responds with `content` + `reasoning_content`
3. Continue stores `reasoning_content` in ChatMessage
4. Continue displays `<thinking>` block in UI
5. User sends follow-up message
6. Continue serializes chat history **with** `reasoning_content` for Kimi models
7. Kimi K3 continues coherent reasoning

## Continue Codebase Analysis

### Existing Infrastructure (What Already Works ✅)

Continue already has **substantial infrastructure** for reasoning models:

#### 1. ThinkingChatMessage Type (`core/index.d.ts`)

```typescript
export interface ThinkingChatMessage {
  role: "thinking";
  content: MessageContent;
  signature?: string;
  redactedThinking?: string;
  toolCalls?: ToolCallDelta[];
  reasoning_details?: { signature?: string; [key: string]: any }[];
  metadata?: Record<string, unknown>;
}
```

#### 2. Response Parsing (`core/llm/openaiTypeConverters.ts`)

`fromChatCompletionChunk` correctly extracts `reasoning_content` from API responses and creates `ThinkingChatMessage`:

```typescript
} else if (
  delta?.reasoning_content ||
  delta?.reasoning ||
  delta?.reasoning_details?.length
) {
  const message: ThinkingChatMessage = {
    role: "thinking",
    content: delta.reasoning_content || delta.reasoning || "",
    signature: delta?.reasoning_details?.[0]?.signature,
    reasoning_details: delta?.reasoning_details as any[],
  };
  return message;
}
```

#### 3. History Persistence (`gui/src/redux/slices/sessionSlice.ts`)

- `streamUpdate` correctly stores `ThinkingChatMessage` in Redux state
- Thinking messages are persisted to `~/.continue/sessions/{id}.json`
- Order is always `[thinking] → [assistant]` (guaranteed by streaming order)

#### 4. Message Construction (`gui/src/redux/util/constructMessages.ts`)

- `constructMessages` includes thinking messages in the output array
- No filtering of thinking role before sending to core

#### 5. Moonshot Provider (`core/llm/llms/Moonshot.ts`)

```typescript
constructor(options: LLMOptions) {
  super(options);
  this.supportsReasoningContentField = this.model?.startsWith("kimi") ?? false;
}
```

#### 6. Provider Capability Flags (`core/llm/index.ts`)

```typescript
protected supportsReasoningField: boolean = false;
protected supportsReasoningDetailsField: boolean = false;
protected supportsReasoningContentField: boolean = false;  // ← Used by Moonshot/Kimi
```

### Identified Problems 🐛

#### Problem 1: `prevMessage` Only Looks at Direct Predecessor

The bug is in `appendReasoningFieldsIfSupported` (`core/llm/openaiTypeConverters.ts`, lines 45-107):

```typescript
function appendReasoningFieldsIfSupported(
  msg,
  options,
  prevMessage, // ← Only looks at IMMEDIATELY preceding message
  providerFlags,
) {
  // ...
  const hasThinkingContent = prevMessage && prevMessage.role === "thinking";

  if (includeReasoningContent) {
    msg.reasoning_content = hasThinkingContent
      ? stripImages(prevMessage.content)
      : ""; // ← Empty string fallback - Kimi REJECTS this for tool calls!
  }
}
```

**Problem 1: `prevMessage` Only Looks at Direct Predecessor**

When `toChatBody` iterates, it passes `messages[index - 1]` as `prevMessage`:

```typescript
messages.map((m, index) =>
  toChatMessage(m, options, messages[index - 1], providerFlags),
);
```

This works for simple cases:

```
[0] user
[1] thinking   ← reasoning for turn 1
[2] assistant  ← prevMessage = [1] thinking ✅
```

But breaks when tool results intervene:

```
[0] user
[1] thinking   ← reasoning for turn 1
[2] assistant  ← with tool_calls, prevMessage = [1] thinking ✅
[3] tool       ← tool result
[4] assistant  ← Kimi's response to tool result, prevMessage = [3] tool ❌
                  (Kimi may or may not send new reasoning_content here)
```

**Problem 2: Empty String Fallback is Rejected by Kimi**

The code falls back to `""` when no thinking message precedes:

```typescript
msg.reasoning_content = hasThinkingContent
  ? stripImages(prevMessage.content)
  : ""; // Kimi rejects empty string for tool call messages!
```

Kimi's error message explicitly states:

> `"thinking is enabled but reasoning_content is missing in assistant tool call message at index N"`

An empty string is treated as "missing" by Kimi K3.

### Message Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         KIMI K3 API RESPONSE                             │
│  { "reasoning_content": "Let me think...", "content": "Here's...",      │
│    "tool_calls": [...] }                                                 │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  fromChatCompletionChunk() extracts reasoning_content                    │
│  Creates ThinkingChatMessage { role: "thinking", content: "..." }       │
│  ✅ WORKS                                                                │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Redux sessionSlice stores in history:                                   │
│    [thinking] → [assistant+toolCalls] → [tool-result]                   │
│  ✅ WORKS                                                                │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  constructMessages() builds ChatMessage[] including thinking role        │
│  ✅ WORKS                                                                │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  toChatBody() → toChatMessage() for each message                         │
│                                                                          │
│  For assistant message at index N:                                       │
│    prevMessage = messages[N-1]  ← Only direct predecessor!              │
│                                                                          │
│  If prevMessage.role !== "thinking":                                     │
│    reasoning_content = ""  ← EMPTY STRING = REJECTED BY KIMI            │
│                                                                          │
│  ❌ BUG IS HERE                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Kimi K3 API receives:                                                   │
│  { role: "assistant", content: "...", tool_calls: [...],                │
│    reasoning_content: "" }  ← REJECTED!                                 │
│                                                                          │
│  HTTP 400: "thinking is enabled but reasoning_content is missing"       │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Problem 2: Context Pruning May Remove Thinking Messages (Hypothesis)

**Observed Symptom:** User reports that Kimi K3 "repeatedly thinks through the same things over and over" - as if it has no memory of previous reasoning.

This suggests that even if Problem 1 is fixed, there may be **another issue**: thinking messages from earlier turns might be **pruned** before they can be merged with their assistant messages.

**How Pruning Works (`core/llm/countTokens.ts`):**

1. `compileChatMessages` counts total tokens in the message history
2. If total exceeds available context, messages are pruned **from the top (oldest first)**
3. Thinking messages are counted and pruned like any other message
4. Only the trailing "tool sequence" (last assistant + tool messages) is protected

**The Problem Scenario:**

```
Original History (before pruning):
  [0] system
  [1] user (turn 1)
  [2] thinking (turn 1 reasoning)     ← May be pruned!
  [3] assistant (turn 1)              ← Its reasoning_content source is gone
  [4] user (turn 2)
  [5] thinking (turn 2 reasoning)     ← May be pruned!
  [6] assistant (turn 2)              ← Its reasoning_content source is gone
  [7] user (turn 3)

After Aggressive Pruning:
  [0] system
  [3] assistant (turn 1)              ← No thinking message before it!
  [6] assistant (turn 2)              ← No thinking message before it!
  [7] user (turn 3)
```

When `toChatMessage` processes assistant messages after pruning:

- `prevMessage` is no longer the thinking message
- `reasoning_content` becomes `""` (empty string)
- Kimi has no memory of previous reasoning chains

**Why This Explains the Symptoms:**

- Kimi "thinks the same thoughts repeatedly" → previous reasoning was pruned
- No 400 error (maybe) → empty string accepted in non-tool-call contexts, or error is swallowed
- Instability after 2-3 turns → context fills up, pruning kicks in

**Verification Method:**
Check `~/.continue/logs/prompt.log` to see:

1. Are `thinking` messages present in the `messages` array sent to Kimi?
2. Do `assistant` messages have `reasoning_content` fields populated?
3. Is pruning happening (`didPrune: true` in logs)?

#### Problem 3: OpenRouter Provider Missing `supportsReasoningContentField` 🔴 CRITICAL

**Discovered via config analysis:** The user's `config.yaml` configures Kimi K3 via **OpenRouter**:

```yaml
- name: "MoonshotAI: Kimi K3"
  provider: openrouter # ← NOT "moonshot"!
  model: moonshotai/kimi-k3
```

This means the **Moonshot provider** (`core/llm/llms/Moonshot.ts`) is **never used**. Instead, the **OpenRouter provider** handles all Kimi K3 requests.

**The OpenRouter provider** (`core/llm/llms/OpenRouter.ts`, lines 10-21):

```typescript
class OpenRouter extends OpenAI {
  static providerName = "openrouter";
  protected supportsReasoningField = true;
  protected supportsReasoningDetailsField = true;
  // ❌ supportsReasoningContentField is NOT SET (defaults to false!)
```

**The Moonshot provider** (which is NOT being used):

```typescript
constructor(options: LLMOptions) {
  super(options);
  this.supportsReasoningContentField = this.model?.startsWith("kimi") ?? false;  // ✅
}
```

**Impact:**
When `appendReasoningFieldsIfSupported` runs for OpenRouter → Kimi K3:

```typescript
const includeReasoningContent = !!providerFlags?.includeReasoningContentField;
// includeReasoningContentField = false for OpenRouter!

if (includeReasoningContent) {
  // ← This is FALSE, so reasoning_content is NEVER added!
  msg.reasoning_content = hasThinkingContent
    ? stripImages(prevMessage.content)
    : "";
}
```

**Result:** Kimi K3 via OpenRouter **never receives `reasoning_content`** in the API payload, even though:

1. ThinkingChatMessages are correctly stored in history
2. The merging logic exists
3. Everything else works

This is the **root cause** of the issue!

## Solution Design

### Philosophy: Always Preserve Reasoning Content

Rather than treating this as a Kimi-specific workaround, reasoning content should **always** be preserved and sent back to reasoning models. This benefits:

- **Kimi K3/K2.7**: Mandatory requirement (Always-On Preserved Thinking)
- **DeepSeek**: Required for tool-call turns, improves coherence otherwise
- **Claude (via OpenRouter)**: Requires `reasoning_details` with signatures
- **Future reasoning models**: Built-in support

### Implementation Strategy

#### Step 1: Find Corresponding Thinking Message

Instead of only looking at `prevMessage`, search backwards to find the thinking message that belongs to each assistant message:

```typescript
// New helper function in openaiTypeConverters.ts
function findCorrespondingThinking(
  messages: ChatMessage[],
  assistantIndex: number,
): ThinkingChatMessage | undefined {
  // Search backwards from the assistant message
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    // Found the thinking message for this assistant turn
    if (msg.role === "thinking") {
      return msg as ThinkingChatMessage;
    }
    // Hit a user/system message = this assistant has no preceding thinking
    if (msg.role === "user" || msg.role === "system") {
      return undefined;
    }
    // Skip tool messages - they're part of the same turn
    // Continue searching...
  }
  return undefined;
}
```

#### Step 2: Modify toChatBody to Use Correct Thinking Message

```typescript
export function toChatBody(
  messages: ChatMessage[],
  options: CompletionOptions,
  providerFlags?: { ... },
): ChatCompletionCreateParams {
  const params: ChatCompletionCreateParams = {
    messages: messages
      .map((m, index) => {
        // For assistant messages, find the corresponding thinking message
        const prevForReasoning = m.role === "assistant"
          ? findCorrespondingThinking(messages, index)
          : messages[index - 1];

        return toChatMessage(m, options, prevForReasoning, providerFlags);
      })
      .filter((m) => m !== null) as ChatCompletionMessageParam[],
    // ...
  };
  return params;
}
```

#### Step 3: Handle Missing Reasoning Content Gracefully

For Kimi specifically, an empty string is rejected. Options:

1. **Use a minimal placeholder**: `" "` (single space) instead of `""`
2. **Use a semantic placeholder**: `"[No prior reasoning for this turn]"`
3. **Omit the field entirely** if no thinking exists (may cause different error)

Based on OpenClaw issue #70565:

> _"Even an empty string is rejected; a minimum of one space is required."_

Recommendation: Use `" "` (single space) as fallback.

### Files to Modify

| File                                   | Change                                                                                                           | Priority                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `core/llm/llms/OpenRouter.ts`          | Add model detection for Kimi and set `supportsReasoningContentField = true`                                      | 🔴 **CRITICAL - Fixes root cause**         |
| `core/llm/openaiTypeConverters.ts`     | Add `findCorrespondingThinking()` helper; modify `toChatBody()` to use it; change empty string fallback to `" "` | 🟡 Secondary - improves robustness         |
| (Optional) `core/llm/llms/Moonshot.ts` | May need adjustments if additional Kimi-specific handling required                                               | 🟢 Low - only if using direct Moonshot API |

### Exact File Locations and Line References

#### `core/llm/llms/OpenRouter.ts`

- **Full path:** `c:\Users\Zuser\Documents\Rolf\VSC_Projekte\continue\core\llm\llms\OpenRouter.ts`
- **Class definition:** Lines 10-21
- **Current state:** Sets `supportsReasoningField` and `supportsReasoningDetailsField` but NOT `supportsReasoningContentField`

#### `core/llm/openaiTypeConverters.ts`

- **Full path:** `c:\Users\Zuser\Documents\Rolf\VSC_Projekte\continue\core\llm\openaiTypeConverters.ts`
- **`appendReasoningFieldsIfSupported`:** Lines 45-107
- **`toChatBody`:** Lines 210-252 (calls `toChatMessage` with `messages[index - 1]`)
- **`toChatMessage`:** Lines 129-207 (delegates to `appendReasoningFieldsIfSupported`)

#### `core/llm/index.ts`

- **Full path:** `c:\Users\Zuser\Documents\Rolf\VSC_Projekte\continue\core\llm\index.ts`
- **Provider capability flags:** Lines 94-96
- **`streamChat` calling `toChatBody`:** Line 1199

#### `core/llm/llms/Moonshot.ts`

- **Full path:** `c:\Users\Zuser\Documents\Rolf\VSC_Projekte\continue\core\llm\llms\Moonshot.ts`
- **Constructor with Kimi detection:** Lines 10-14 (correct implementation, for reference)

### Quick Fix for Problem 3 (OpenRouter) - IMPLEMENTATION DETAILS

**File:** `core/llm/llms/OpenRouter.ts`

**Current Code (approximately lines 10-40):**

```typescript
class OpenRouter extends OpenAI {
  static providerName = "openrouter";
  protected supportsReasoningField = true;
  protected supportsReasoningDetailsField = true;

  constructor(options: LLMOptions) {
    super({
      ...options,
      requestOptions: {
        ...options.requestOptions,
        headers: {
          ...OPENROUTER_HEADERS,
          ...options.requestOptions?.headers,
        },
      },
    });
  }
  // ...
}
```

**Required Change - Add after `super()` call:**

```typescript
constructor(options: LLMOptions) {
  super({
    ...options,
    requestOptions: {
      ...options.requestOptions,
      headers: {
        ...OPENROUTER_HEADERS,
        ...options.requestOptions?.headers,
      },
    },
  });

  // Enable reasoning_content for Kimi models (required for preserved thinking)
  // OpenRouter supports reasoning_content as an alias for reasoning
  // See: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
  if (this.model?.toLowerCase().includes("kimi")) {
    this.supportsReasoningContentField = true;
  }

  // Also consider DeepSeek models that benefit from reasoning_content
  if (this.model?.toLowerCase().includes("deepseek")) {
    this.supportsReasoningContentField = true;
  }
}
```

**Why This Works:**

1. `this.model` is set by the parent `OpenAI` constructor via `super()`
2. After `super()` returns, we can inspect `this.model` and set provider flags
3. OpenRouter normalizes `reasoning_content` and forwards it correctly to Moonshot/DeepSeek

### Secondary Fix: Robust Thinking Message Lookup - IMPLEMENTATION DETAILS

**File:** `core/llm/openaiTypeConverters.ts`

**Problem:** `toChatBody` passes only `messages[index - 1]` as `prevMessage`, which fails when tool messages intervene between thinking and assistant messages.

**Fix 1: Add Helper Function (insert around line 45, before `appendReasoningFieldsIfSupported`):**

```typescript
/**
 * Find the corresponding thinking message for an assistant message.
 * Searches backwards, skipping tool messages (which are part of the same turn).
 * Stops at user/system messages (which indicate a new turn without thinking).
 */
function findCorrespondingThinking(
  messages: ChatMessage[],
  assistantIndex: number,
): ThinkingChatMessage | undefined {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "thinking") {
      return msg as ThinkingChatMessage;
    }
    if (msg.role === "user" || msg.role === "system") {
      return undefined; // New turn boundary - no thinking for this assistant
    }
    // Skip tool messages - continue searching
  }
  return undefined;
}
```

**Fix 2: Modify `toChatBody` (around line 235):**

**Current:**

```typescript
messages: messages.map((m, index) =>
  toChatMessage(m, options, messages[index - 1], providerFlags),
);
```

**Change to:**

```typescript
messages: messages.map((m, index) => {
  // For assistant messages, find the corresponding thinking message
  // (may not be the direct predecessor due to tool messages)
  const prevForReasoning =
    m.role === "assistant"
      ? (findCorrespondingThinking(messages, index) ?? messages[index - 1])
      : messages[index - 1];

  return toChatMessage(m, options, prevForReasoning, providerFlags);
});
```

**Fix 3: Change Empty String Fallback (in `appendReasoningFieldsIfSupported`, around line 74):**

**Current:**

```typescript
msg.reasoning_content = hasThinkingContent
  ? stripImages(prevMessage.content)
  : "";
```

**Change to:**

```typescript
msg.reasoning_content = hasThinkingContent
  ? stripImages(prevMessage.content)
  : " "; // Single space - Kimi rejects empty string for tool call messages
```

### Test Cases

- User → Kimi (with reasoning) → User → Kimi
- Verify: Second Kimi response receives first turn's `reasoning_content`

2. **Multi-turn with tool calls**

   - User → Kimi (reasoning + tool_call) → Tool result → Kimi response
   - Verify: All assistant messages have valid `reasoning_content`

3. **Resumed session**

   - Load session from disk → Continue conversation
   - Verify: Historical `reasoning_content` is preserved

4. **Mixed model conversation** (edge case)
   - Start with non-reasoning model → Switch to Kimi
   - Verify: Kimi receives appropriate fallback for messages without reasoning

### Rollout Considerations

- **Backwards compatible**: Only affects providers with `supportsReasoningContentField = true`
- **No UI changes**: Existing `<thinking>` block display continues to work
- **Session migration**: Existing sessions with thinking messages will work automatically

## Additional Context

### Kimi K3 Specifications

- **Architecture:** 2.8T-parameter Mixture of Experts (16 of 896 experts active)
- **Context window:** 1,048,576 tokens
- **Reasoning:** Always on; only `reasoning_effort="max"` available at launch
- **API pricing:** $3.00 input / $0.30 cache-hit / $15.00 output per 1M tokens

**Source:** [Kimi K3 API Guide](https://www.verdent.ai/guides/agents/kimi-k3-api-guide)

### Multi-Turn Requirements from Kimi Launch

> _"Multi-turn agents must return the complete assistant message to the next request, including the reasoning and tool-call fields the API supplies."_
>
> Source: [Kimi K3 Launch Coverage](https://trilogyai.substack.com/p/kimi-k3-is-live-pricing-benchmarks)

---

## Implementation Checklist

### Phase 1: Critical Fix (OpenRouter Provider)

- [ ] **1.1** Open `core/llm/llms/OpenRouter.ts`
- [ ] **1.2** Locate the constructor (after `super()` call)
- [ ] **1.3** Add Kimi model detection:
  ```typescript
  if (this.model?.toLowerCase().includes("kimi")) {
    this.supportsReasoningContentField = true;
  }
  ```
- [ ] **1.4** (Optional) Add DeepSeek model detection:
  ```typescript
  if (this.model?.toLowerCase().includes("deepseek")) {
    this.supportsReasoningContentField = true;
  }
  ```
- [ ] **1.5** Test: Kimi K3 multi-turn conversation should now preserve reasoning

### Phase 2: Robustness Improvements (openaiTypeConverters.ts)

- [ ] **2.1** Open `core/llm/openaiTypeConverters.ts`
- [ ] **2.2** Add `findCorrespondingThinking()` helper function (before `appendReasoningFieldsIfSupported`)
- [ ] **2.3** Modify `toChatBody()` to use backward search for assistant messages
- [ ] **2.4** Change empty string fallback `""` to `" "` (single space) in `appendReasoningFieldsIfSupported`
- [ ] **2.5** Test: Multi-turn with tool calls should work correctly

### Phase 3: Verification

- [ ] **3.1** Test simple multi-turn (no tools): User → Kimi → User → Kimi
- [ ] **3.2** Test with tool calls: User → Kimi (tool_call) → Tool result → Kimi
- [ ] **3.3** Test session resume: Close and reopen session
- [ ] **3.4** Check `~/.continue/logs/prompt.log` for `reasoning_content` in payloads
- [ ] **3.5** Verify no 400 errors from Kimi API

### Phase 4: Edge Cases (Optional)

- [ ] **4.1** Test mixed model conversation (non-reasoning → Kimi)
- [ ] **4.2** Test context pruning scenarios (very long conversations)
- [ ] **4.3** Test with `reasoning_effort` variations (max/high/low)

---

## Quick Reference: Key Code Locations

| Component                     | File                                      | Line(s)        | Purpose                              |
| ----------------------------- | ----------------------------------------- | -------------- | ------------------------------------ |
| OpenRouter provider           | `core/llm/llms/OpenRouter.ts`             | 10-40          | Add `supportsReasoningContentField`  |
| Moonshot provider (reference) | `core/llm/llms/Moonshot.ts`               | 10-14          | Correct implementation pattern       |
| Message serialization         | `core/llm/openaiTypeConverters.ts`        | 210-252        | `toChatBody()`                       |
| Reasoning field injection     | `core/llm/openaiTypeConverters.ts`        | 45-107         | `appendReasoningFieldsIfSupported()` |
| Provider flags                | `core/llm/index.ts`                       | 94-96          | Flag definitions                     |
| ThinkingChatMessage type      | `core/index.d.ts`                         | ~line 150      | Type definition                      |
| Session storage               | `gui/src/redux/slices/sessionSlice.ts`    | `streamUpdate` | Redux state                          |
| Message construction          | `gui/src/redux/util/constructMessages.ts` | 100-104        | History building                     |

---

## Related Issues and References

| Source                    | Link                                                              | Relevance               |
| ------------------------- | ----------------------------------------------------------------- | ----------------------- |
| Kimi Thinking Mode Docs   | https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model    | Official requirements   |
| OpenRouter Reasoning Docs | https://openrouter.ai/docs/guides/best-practices/reasoning-tokens | API field documentation |
| LiteLLM Issue #26156      | https://github.com/BerriAI/litellm/issues/26156                   | Same issue in LiteLLM   |
| OpenWebUI Issue #23175    | https://github.com/open-webui/open-webui/issues/23175             | Same stripping issue    |
| DeepSeek Thinking Mode    | https://api-docs.deepseek.com/guides/thinking_mode/               | DeepSeek requirements   |
| OpenRouter Kimi K3 Model  | https://openrouter.ai/moonshotai/kimi-k3                          | Model capabilities      |
