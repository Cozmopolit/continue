# OpenAI Adapters Package - OUT OF SCOPE

> **This file documents the openai-adapters package for completeness, but it is OUT OF SCOPE for the initial PR.**

## Architecture Clarification

Continue has **two independent paths** for LLM providers:

### Path A: Core LLM Classes (IN SCOPE)

- `core/llm/llms/Anthropic.ts` - Uses `@anthropic-ai/sdk` directly
- `core/llm/llms/Gemini.ts` - Uses native Gemini API directly
- Instantiated via `llmFromDescription()` -> `LLMClasses`
- **This is what users get when they configure `provider: "anthropic"` or `provider: "gemini"`**

### Path B: OpenAI Adapters (OUT OF SCOPE)

- `packages/openai-adapters/src/apis/Anthropic.ts` - Uses Vercel SDK (`@ai-sdk/anthropic`)
- `packages/openai-adapters/src/apis/Gemini.ts` - Custom implementation
- Used for OpenAI-compatible endpoint scenarios

**The two paths are independent!** Changes to Path A work without any changes to Path B.

---

## Why Out of Scope?

The `packages/openai-adapters/src/apis/Anthropic.ts` uses Vercel SDK which adds an abstraction layer. We would need to:

1. Investigate if Vercel SDK passes through object structures for tool results
2. If not, decide whether to:
   - Contribute to Vercel SDK upstream
   - Create a separate code path (rejected by reviewer as maintenance burden)

**Decision**: Land the feature for direct API users first (Path A), then address Path B in a follow-up.

---

## Future Work (Separate Issue)

If/when we address Path B:

### File: `packages/openai-adapters/src/apis/Gemini.ts`

Same changes as `core/llm/llms/Gemini.ts` - the type definitions and function response building logic.

### File: `packages/openai-adapters/src/apis/Anthropic.ts`

Requires investigation into Vercel AI SDK capabilities:

- Does `@ai-sdk/anthropic` support multimodal tool results?
- If yes: Just ensure TypeScript types are satisfied
- If no: Requires upstream contribution or alternative approach

---

## Note on OpenAI Provider

OpenAI does **not** support images in tool results at the API level, so no changes needed for:

- `packages/openai-adapters/src/apis/OpenAI.ts`
- `core/llm/llms/OpenAI.ts`

Tool results with images targeting OpenAI should gracefully degrade to text-only.
