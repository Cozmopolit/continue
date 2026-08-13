# Preserve OpenAI Responses Output-Item Order

**Status:** Ready for implementation  
**Date:** 2026-08-13

## Problem / Motivation

OpenAI Responses output items have provider-defined ordering and dependency relationships. GPT-5.6 can emit a single assistant turn as:

```text
reasoning (rs_...)
message (msg_...)          # visible preamble
function_call (fc_...)
```

Continue represents the visible text and tool calls as one `AssistantChatMessage`. The streaming reducer correctly persists the provider order in:

```text
metadata.responsesOutputItemIds = [msg_..., fc_...]
```

During replay, `toResponsesInput()` currently separates the IDs by prefix, emits every `function_call` first, and emits the text `message` afterwards. It therefore reconstructs the turn as:

```text
reasoning (rs_...)
function_call (fc_...)
message (msg_...)
```

Azure OpenAI rejects the reordered history because the `msg_...` item is no longer in its original dependency position:

```text
Item 'msg_...' of type 'message' was provided without its required
'reasoning' item: 'rs_...'.
```

The failure was independently reproduced locally and on the corporate laptop with the same installed extension bundle. The `out/extension.js` SHA256 is identical in both environments:

```text
D2D920A20E7C563D23CBF94B9B6C687241F3BBFA76D570797A01E58281B356E5
```

## Scope

- Preserve provider output-item order when converting a mixed assistant turn with text and tool calls back to OpenAI Responses input.
- Retain existing behavior for text-only, tools-only, parallel-tool, and ID-less assistant turns.
- Add a defensive replay invariant so server-originated `msg_...` and `fc_...` IDs are not submitted when their retained Responses reasoning group is absent or invalid.
- Keep all changes in `core/llm/openaiTypeConverters.ts` unless implementation reconnaissance disproves that boundary.

### Out of Scope

- Chat Completions reasoning fields (`reasoning`, `reasoning_content`, `reasoning_details`).
- OpenRouter/Kimi/DeepSeek preserved-thinking behavior.
- Changing the GUI representation that combines assistant text and tool calls.
- Replacing `ChatMessage` history with raw Responses output-item persistence.
- Adding `response.completed` stream-event handling.
- Preserving new Responses fields such as assistant `phase`.
- Repairing already persisted malformed history files on disk.
- Changing prompt logging, stream forensics, or tunnel diagnostics.

## Analysis

### Verified capture behavior

`gui/src/redux/slices/sessionSlice.ts` processes stream updates in arrival order and appends each `responsesOutputItemId` to `metadata.responsesOutputItemIds`. For the failing GPT-5.6 turn, both environments persisted:

```text
[msg_..., fc_...]
```

No GUI change is required for the primary fix. The singular `responsesOutputItemId` remains a compatibility fallback; the ordered array is authoritative when present.

### Current replay behavior

The assistant branch in `toResponsesInput()` currently:

1. filters all `fc_...` values into a separate ordered list;
2. finds the first `msg_...` value;
3. emits all function calls;
4. emits the assistant text message.

Filtering preserves order within each prefix class but destroys the mixed provider order.

### Required invariants

1. **Provider order:** When `responsesOutputItemIds` contains recognized IDs, emitted `message` and `function_call` items with those IDs must follow that mixed order.
2. **Stable tool association:** The nth distinct `fc_...` ID remains associated with the nth emitted tool call, matching current parallel-call behavior.
3. **Single text item:** Continue can represent one assistant text item per internal assistant message. The first distinct `msg_...` ID is associated with that text item; additional message IDs cannot be reconstructed from the flattened representation and must not be emitted as duplicate text.
4. **No duplication:** Duplicate metadata IDs must not duplicate text or tool-call items.
5. **Lossless fallback:** Generated content and tool calls remain present when provider IDs are missing or unusable; only server-originated item IDs may be omitted.
6. **Reasoning safety:** A retained server-originated `msg_...` or `fc_...` ID must belong to a valid retained reasoning group. If that cannot be established after sanitization, remove the item ID while preserving the item content and `call_id`.
7. **Turn boundary:** A reasoning group covers the contiguous provider output items (`message` and/or `function_call`) that follow it. User/developer messages, tool outputs, or a new reasoning item end or replace that group.

### Compatibility behavior

When no authoritative mixed ID array exists, retain the current content ordering and positional `fc_...` assignment. This avoids changing legacy and non-Responses histories that do not carry complete output metadata.

Removing a server output-item `id` is an intentional degradation path: the visible assistant content, function name/arguments, and `call_id` remain replayable without asking OpenAI to resolve an invalid stored-item dependency.

## Solution

### Ordered assistant-item construction

Extract the assistant branch of `toResponsesInput()` into a pure helper that returns `ResponseInputItem[]`.

The helper will:

1. read the ordered ID source from `responsesOutputItemIds`, falling back to the singular compatibility field only when necessary;
2. deduplicate recognized IDs by first occurrence;
3. construct at most one text-message item and one function-call item per valid internal tool call;
4. associate distinct `fc_...` IDs positionally with tool calls;
5. emit ID-bearing items according to the original mixed ID sequence;
6. append any remaining ID-less generated items using existing fallback behavior;
7. preserve current handling when no usable ordered metadata exists.

For the reproduced case:

```text
input metadata: [msg_1, fc_1]
internal data:   text + toolCall
emitted items:  message(msg_1), function_call(fc_1)
```

For parallel calls:

```text
input metadata: [msg_1, fc_1, fc_2, fc_3]
emitted items:  message(msg_1), function_call(fc_1),
                function_call(fc_2), function_call(fc_3)
```

### Defensive sanitizer postcondition

After invalid reasoning items have been removed, walk the final Responses input in order while tracking whether a valid reasoning group is active.

- A retained reasoning item with `encrypted_content` starts a group.
- Consecutive `message` and `function_call` output items belong to that group.
- A user/developer message, `function_call_output`, or later unrelated item ends the group.
- If an output `message` or `function_call` carries a server-originated `msg_...`/`fc_...` ID outside an active valid group, remove only its `id`.
- Preserve `call_id`, function arguments, message content, and relative item order.

This postcondition covers both the reproduced ordering defect and histories in which a thinking message was removed before `sanitizeResponsesInput()` received an actual reasoning item.

## Implementation Checklist

- [ ] `core/llm/openaiTypeConverters.ts`: introduce a pure assistant-to-Responses-items helper.
- [ ] `core/llm/openaiTypeConverters.ts`: preserve the authoritative mixed order of `responsesOutputItemIds` for text-plus-tool turns.
- [ ] `core/llm/openaiTypeConverters.ts`: retain positional parallel-tool ID association and ID-less fallback behavior.
- [ ] `core/llm/openaiTypeConverters.ts`: deduplicate repeated output-item IDs without duplicating generated items.
- [ ] `core/llm/openaiTypeConverters.ts`: enforce the final reasoning-group ID safety invariant.
- [ ] Core build verification after implementation.
