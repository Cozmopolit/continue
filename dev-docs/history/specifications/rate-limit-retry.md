# Rate-Limit Retry (HTTP 429) for Chat/Completion Streams

**Status:** Implementiert & getestet (2026-08-17)
**Date:** 2026-08-17

## Problem / Motivation

Corporate hosts (fides, lumen) run Continue with Azure-hosted `gpt-5.6-sol`
endpoints and hit Azure rate limits (HTTP 429, region germanywestcentral).
Server-side quota has already been raised; client-side absorption is missing.

Today a 429 surfaces in the GUI as an immediate, unhandled error:

- Native OpenAI/Azure path: `OpenAI._streamChat` → `fetch` → `streamSse` →
  `streamResponse` (`packages/fetch`) throws `new Error(await response.text())`
  for non-200 — **status and headers are lost**, so neither the status code
  nor `Retry-After` is observable upstream.
- `BaseLLM.streamChat`/`streamComplete` (`core/llm/index.ts`) catch, add
  forensics, log, and rethrow unchanged.
- Retry infrastructure exists — `core/llm/utils/retry.ts` (429 detection,
  `Retry-After` parsing, exponential backoff + jitter, `withLLMRetry` preset)
  — but has **zero production imports**; only its own test file uses it.

Goal: absorb rate-limit bursts transparently (backoff + retry, honoring
`Retry-After`) without changing behavior for any non-429 error.

## Scope

- Error enrichment in `packages/fetch` (attach status + headers on non-2xx).
- Rate-limit-only retry predicate, abortable sleep, and a stream-aware retry
  helper in `core/llm/utils/retry.ts`.
- Wiring in `BaseLLM.streamChat` and `BaseLLM.streamComplete` around every
  provider iterable source (native, adapter/SDK, Responses, templateMessages).
- Non-streaming `ok` check in the native OpenAI path.

**Out of Scope:**

- Retrying 5xx / network errors / timeouts (the predicate hook makes this a
  one-line extension later; deliberately not part of this change).
- GUI visibility of a pending retry (status toast would need protocol
  changes) — the wait is silent until first token or final error.
- Config knobs (`requestOptions.*`) — always-on for 429.
- Embeddings/reranker models; mid-stream retry/resume
  (see `stream-forensics-hardening.md` §1).
- Capacity measures (quota, fallback deployment/region); the CITT server's
  own LLM transport (not in this repo or this path).

## Analysis

```
llmStreamChat (core/llm/streamChat.ts)
  └─ BaseLLM.streamChat / streamComplete      catch: forensics + log + rethrow
       ├─ templateMessages → this._streamComplete(...)
       ├─ adapter path    → responsesStream / responsesNonStream /
       │                    openAIAdapterStream / openAIAdapterNonStream
       │                    (OpenAI SDK: APIError already carries .status/.headers)
       └─ native path     → this._streamChat(...)  [OpenAI/Azure, others]
              └─ fetch → streamSse → streamResponse
                    non-200: throw Error(bodyText)   ← status/headers lost
```

- **Adapter/SDK path:** errors already carry `.status`/`.headers`. Recon
  (2026-08-17): `packages/openai-adapters` never sets `maxRetries` → the
  OpenAI SDK default (2 internal retries, own backoff + `retry-after`)
  already applies there today. The outer retry stacks on top (worst case
  ~5×3 attempts) — accepted; centralizing by setting SDK `maxRetries: 0`
  is a later option, not part of this spec. The Azure problem case uses
  the native path, where no SDK sits in between.
- **Native path:** the only throw site is `streamResponse`
  (`packages/fetch/src/stream.ts`, non-200 branch). Enriching there is a
  single choke point covering every provider that streams via `streamSse`.
  The embedded-body fallback regex in `retry.ts` (`"code":429`) does not
  match Azure's string form (`"code":"429"`) — detection must ride on the
  attached status, not message matching.
- **Retry timing:** a 429 is an HTTP status and always precedes the response
  body — no tokens have been yielded when it arrives. Retrying after chunks
  reached the consumer would duplicate content, so the retry window is
  strictly "zero chunks yielded".
- **Abort semantics:** user cancellation today never throws — `packages/fetch`
  converts `AbortError` into a synthetic 499 response and `streamSse`
  completes silently. The backoff sleep must therefore be _interruptible_,
  not _abort-throwing_: on abort the sleep returns early, the next attempt
  starts, and the existing 499 translation ends the stream cleanly.
- **Amplification caveat:** multiple hosts share one Azure quota. Jittered
  backoff mitigates herding on bursts; sustained overload remains a capacity
  problem that retry cannot fix (quota was raised server-side; fallback
  deployments are out of scope).
- **Junction rule:** `packages/fetch` is consumed via its `dist/` — build it
  before building/testing `core`.

## Solution

### 1. Error enrichment — `packages/fetch/src/stream.ts`

```ts
/** Error carrying HTTP status + lowercased headers; message = body text. */
export async function createResponseError(response: Response): Promise<Error>;
```

- `streamResponse`'s non-200 branch throws via this helper (message text
  unchanged — purely additive properties, no caller-visible change beyond
  `.status` / `.headers: Record<string, string>`).
- Exported from the package index; referenced by filename in a code comment
  (`rate-limit-retry.md`).

### 2. Retry building blocks — `core/llm/utils/retry.ts`

```ts
export function isRateLimitError(error: any): boolean;
// true on: error.status/statusCode === 429,
//          embedded '"code":429' / '"status":429' (number or string) in message,
//          AWS ThrottlingException

export const RATE_LIMIT_RETRY: RetryOptions;
// { maxAttempts: 5, baseDelay: 2000, maxDelay: 90000, jitterFactor: 0.4,
//   shouldRetry: isRateLimitError }

export function retryStream<T>(
  factory: () => AsyncGenerator<T> | AsyncIterable<T>,
  options?: RetryOptions & { signal?: AbortSignal },
): AsyncGenerator<T>;
```

`retryStream` semantics:

- On error: retry only while **zero chunks have been yielded** to the
  consumer and `shouldRetry` passes; otherwise rethrow immediately.
- Each attempt calls `factory()` fresh (lazy — no HTTP happens before the
  first `next()`).
- Delay via existing `calculateDelay` (honors `retry-after` /
  `x-ratelimit-reset`, capped at `maxDelay`); `sleep(ms, signal?)` becomes
  abortable (early return on abort, see Analysis).
- `onRetry` default stays `console.warn`; wiring sites pass a `Logger.warn`
  closure with model/provider/attempt/delay context.
- Existing `retryAsync` / `withRetry` / `createRetryableAsyncGenerator`
  remain untouched.

### 3. Wiring — `core/llm/index.ts`

Wrap every iterable source at its creation site (the surrounding
logging/forensics stays single-shot; retries are invisible except for the
`onRetry` log line):

- `BaseLLM.streamChat`:
  - templateMessages branch: `() => this._streamComplete(...)`
  - adapter branch: factory reproducing the existing conditional
    (`responsesStream` / `responsesNonStream` / `openAIAdapterStream` /
    `openAIAdapterNonStream`)
  - native branch: `() => this._streamChat(...)`
- `BaseLLM.streamComplete`:
  - adapter `stream: false`: factory that awaits `completionNonStream` and
    yields the single result
  - adapter `stream: true`: `() => this.openaiAdapter.completionStream(...)`
  - native branch: `() => this._streamComplete(...)`

All wrap sites use `RATE_LIMIT_RETRY` + the call's `AbortSignal` + the
logging `onRetry`.

### 4. Native non-streaming path — `core/llm/llms/OpenAI.ts`

In `_streamChat`'s `body.stream === false` branch, after the existing 499
check: `if (!response.ok) throw await createResponseError(response);`
(today a 429 there degenerates into an opaque `TypeError` from
`data.choices[0].message`).

### Expected behavior

Bursty 429 → silent backoff (2s/4s/8s/16s exponential, or server
`Retry-After` capped at 90s per attempt), up to 5 attempts, then the error
surfaces exactly as today. Non-429 errors: unchanged. Mid-stream errors:
unchanged (no retry). Worst-case added wait before a final 429 error:
~30s exponential (longer only if the server sends large `Retry-After`).

## Amendment 2026-08-17 (Phase 3 — CodeRabbit review)

**Finding (verified):** on the native OpenAI/Azure path, non-OK responses
never reach `streamResponse` — `BaseLLM.fetch` throws on `!resp.ok` (via
`parseError`) before any SSE processing. `parseError` returned a plain
`Error` without `.status`/`.headers`, so `retryStream` could neither detect
429 nor honor `Retry-After`. The `streamResponse` enrichment (§1) remains
correct but only covers paths bypassing `BaseLLM.fetch`.

**Fix:**

- `parseError` now returns a `ResponseError` (single exit; status +
  lowercased headers attached via new `attachHttpStatusAndHeaders` helper).
  Covers the native and Responses API paths (both use `this.fetch`);
  detection no longer depends on a numeric status/code in the body.
- `isRateLimitError` additionally matches the `HTTP 429` message prefix
  produced by `parseError` (fallback for wrapped errors losing properties).

**No new retry stacking:** `withExponentialBackoff` (the `BaseLLM.fetch`
wrapper) detects 429 only via `error.response.status`; `parseError` errors
carry no `.response` and messages are unchanged, so its 429 behavior is
unchanged (dormant unless the body embeds `"code":429` — as before).

## Implementation Checklist

- [x] `packages/fetch/src/stream.ts`: add `createResponseError(response)`;
      use it in `streamResponse`'s non-200 branch; export via package index;
      comment referencing `rate-limit-retry.md`. Then `npm run build` in
      `packages/fetch` (junction).
- [x] `core/llm/utils/retry.ts`: add `isRateLimitError`, `RATE_LIMIT_RETRY`
      preset, abortable `sleep(ms, signal)`, `retryStream(factory, options)`
      with the zero-yield retry window; leave existing exports untouched;
      comment referencing `rate-limit-retry.md`.
- [x] `core/llm/index.ts` — `BaseLLM.streamChat`: wrap the three iterable
      sources with `retryStream` (`RATE_LIMIT_RETRY` + `signal` + `Logger`
      `onRetry`).
- [x] `core/llm/index.ts` — `BaseLLM.streamComplete`: wrap the three sources
      analogously (non-stream adapter case as await-and-yield-once factory).
- [x] `core/llm/llms/OpenAI.ts`: non-streaming branch — throw
      `createResponseError(response)` on `!response.ok` before parsing JSON.
- [x] Tests (Phase 4, gegen die finale Implementierung):
  - `core/llm/utils/retry.test.ts` (+16): `isRateLimitError`-Matrix
    (status/statusCode, ThrottlingException, `HTTP 429`-Prefix inkl.
    Negativfall `HTTP 4290`, embedded 429 als Zahl/String, 400/500/null),
    `RATE_LIMIT_RETRY`-Shape, `retryStream`-Semantik (Pass-through, Retry
    nur im Zero-Yield-Fenster, keine Duplikation nach erstem Chunk,
    sofortige Propagation bei 400, maxAttempts-Exhaustion, Retry-After
    schlägt Exponential-Backoff, interruptible Sleeps: bereits-abortet und
    Abort während des Backoff).
  - `core/llm/rateLimitRetry.vitest.ts` (neu, 3 Tests): Native-Pfad-
    Regression über den `customFetch`-Seam (volle Kette customFetch →
    `BaseLLM.fetch` → `parseError` → `retryStream` → `OpenAI._streamChat`):
    429 mit `Retry-After` und **ohne** numerischen Status/Code im Body wird
    genau einmal retried (kein Stacking mit `withExponentialBackoff`);
    persistente 429 erschöpft alle 5 Versuche und wirft `HTTP 429`;
    401 wird nicht retried. Erfüllt die CodeRabbit-Forderung aus Phase 3.
  - `packages/fetch/src/stream.test.ts` (+4): `createResponseError`
    (Bodytext als Message, status + lowercased Headers, Headers ohne
    `forEach`) und `streamResponse`-Anreicherung (non-200 wirft
    `ResponseError` mit status/headers; 499 bleibt still).
