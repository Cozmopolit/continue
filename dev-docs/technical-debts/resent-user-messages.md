# Resent / duplicated user messages without user action

**Status:** Fixed — capture root cause fixed 2026-08-17; resend policy implemented 2026-08-17 (reasoning-resend-policy.md); one follow-up open (corrupted sessions)
**Date:** 2026-08-14 (updated 2026-08-17)

## Problem

User messages occasionally appear to be **resent or duplicated** in a chat
session without any user action: the user sends a message once, does NOT
resend it, yet the message turns up again (e.g. in the run/session state
behind the scenes), while the **GUI shows no visible indication** of the
duplicate — no second message bubble, no hint that a resend happened.

This is a recurring phenomenon ("das passiert uns auch häufig"), not a
one-off. It was observed again during the 2026-08-14 hung-chat incident
work, where runs were repeatedly aborted mid-flight: after an aborted run,
message state surfaced that did not correspond to anything the user had
actually sent.

## Analysis

### 2026-08-17: Root cause found for the non-persisted variant (vesta/zenith incidents)

Forensics of two fresh incidents — vesta session
`ec01edb2-b0e3-41d1-af3c-a7896d835e4a` (ghost re-bootstrap, 08:24–08:52Z)
and zenith session `9d6a6c41-f30d-4abe-88ab-eeeb15d9b4be` ("Go message
delivered twice", 11:29–11:33Z) — showed the persisted history contained
**no real duplicate** of the user message in either case. The duplication
was a **model belief**, and the belief is systematic, caused by a fork bug
plus the reasoning-resend design:

1. **Capture bug (fixed 2026-08-17).** In `sessionSlice.streamUpdate`, the
   first chunk of a new thinking message was spread into the new history
   item (`{ ...message, content: "" }` carries its `reasoning_details`) and
   then merged again by the merge branch in the same reducer pass —
   double-processing the first reasoning delta. Census of the zenith
   session: 62/62 thinking items had `reasoning_details[0].text` =
   first-token + content ("TheThe…", "allallAll…"). Fix: strip
   `reasoning_details` when creating the item (`sessionSlice.ts`);
   `mergeReasoningDetails` made non-mutating/copy-on-write
   (`core/llm/openaiTypeConverters.ts`). Tests: `sessionSlice.test.ts`
   (describe "Thinking reasoning_details stream accumulation"),
   `openaiTypeConverters.test.ts` (describe "mergeReasoningDetails").
2. **Reasoning resend makes the model read its own (corrupted) thinking.**
   `toChatBody` merges thinking into the following assistant message as
   `reasoning` + `reasoning_details` and resends it (OpenRouter flags in
   `OpenRouter.ts`). A live A/B probe against openrouter/qwen3.8-max
   proved the provider feeds these fields back into the model's context —
   the model perceived the replayed block as an extra "developer"-style
   message and could not attribute it ("Wait that appears in user?").
3. **Escalation to the incident symptom.** Replayed thinking quotes the
   user's own words, so the user message appears several times across the
   context (once as the user turn, N times inside reasoning blocks). With
   every block additionally corrupted by the stutter from (1), the
   repetition-prone model escalates from token-level stuttering (thinking
   content "WriteWrite…", "GoodGoodGood…", worsening over turns) to the
   semantic belief "the user sent the same message again". The belief is
   quoted in the model's next thinking → replayed again in every later run
   → **self-reinforcing** (explains "in every run since").

Older incidents (2026-08-10, 2026-08-14) may be a **different variant** in
this family: they reportedly had a persisted/UI-level duplicate, which the
mechanism above cannot produce. Prime suspect there remains the
overloaded-retry path (`streamThunkWrapper.tsx` re-issues
`submitEditorAndInitAtIndex`, which would append a second
[user, assistant] pair) — still open, see below.

## Affected Areas

Fixed path: `gui/src/redux/slices/sessionSlice.ts` (streamUpdate thinking
item creation), `core/llm/openaiTypeConverters.ts` (mergeReasoningDetails).

Resend path involved: `core/llm/openaiTypeConverters.ts` (toChatBody /
appendReasoningFieldsIfSupported), `core/llm/llms/OpenRouter.ts` (reasoning
flags).

## Follow-ups

- **Resend policy decision — RESOLVED 2026-08-17.** Empirical probe matrix
  (testbed `openrouter-reasoning-probe`, spec `reasoning-resend-policy.md`)
  showed the Stufe-1 confusion was a payload/corruption artifact: genuine,
  intact self-reasoning is correctly attributed and recallable by qwen.
  Implemented per-family policy in `OpenRouter.ts`: qwen keeps plain
  `reasoning` (dead `reasoning_details` removed), Kimi/DeepSeek
  `reasoning_content` only, Claude signed `reasoning_details` only,
  Google/Gemini resend stopped entirely. Tests: `OpenRouter.vitest.ts`
  ("reasoning resend policy"), `openaiTypeConverters.test.ts`
  ("toChatBody reasoning resend gating").

## Open follow-ups (2026-08-17)

- **Corrupted existing sessions:** sessions written before the fix carry
  corrupted `reasoning_details` permanently; affected agents should start
  fresh sessions rather than continuing them.
- **Persisted-duplicate variant (08-10/08-14):** check the overloaded-retry
  path in `streamThunkWrapper.tsx` / `streamResponse.ts` for double
  `submitEditorAndInitAtIndex` on 429/overloaded retries.
