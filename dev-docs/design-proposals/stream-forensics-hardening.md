# Stream Forensics: Hardening & Follow-Ups

**Status:** Idea (not prioritized)
**Date:** 2026-07-25

Deferred follow-ups from the stream-forensics implementation (extracted from
[stream-forensics.md](../history/specifications/stream-forensics.md) §7). Not
defects of the shipped feature — candidate hardening and scope extensions.

## 1. Bounded retry/resume on PrematureStreamEndError

A premature stream end currently surfaces as an error dialog; the user
resubmits manually. Automatic retries of long reasoning generations were
deliberately rejected (expensive), but an optional **bounded** retry (e.g. max
1–2 attempts, possibly only when chunks were already received) could absorb
transient provider-side aborts like the
[2026-07-25 OpenRouter incident](../history/incidents/openrouter-stream-abort-2026-07-25.md).

## 2. Idle watchdog (`streamIdleTimeoutSeconds`)

If a middlebox holds the connection open without forwarding anything, the
stream hangs forever instead of failing — the termination guard only fires on
connection close. Candidate: configurable
`requestOptions.streamIdleTimeoutSeconds` aborting the request when no bytes
(including SSE comments/keepalives) arrive for the interval. Would turn silent
hangs into diagnosable errors.

## 3. `streamFim` instrumentation

The termination guard covers chat completions only; `streamFim` (autocomplete)
is not instrumented — premature ends there stay invisible. Same guard +
forensics treatment would close the gap.

## Affected Areas

- `packages/fetch/src/stream.ts` (`streamSse`, `requestOptions`)
- `packages/openai-adapters/src/util/streamTermination.ts` (guard)
- `core/llm/streamForensics.ts` (enrichment)
- Autocomplete path (`streamFim` callers)
