# Stream Forensics & Premature Stream End Detection

**Status:** Implemented
**Last Updated:** 2026-07-25

## 1. Problem

In the corporate environment, streaming LLM responses (observed with Kimi K3
via OpenRouter) are cut **mid-stream** — in the middle of thinking blocks or
assistant output. The connection is closed _cleanly_ (no socket error), so the
HTTP layer reports a normal end-of-stream. Neither the SSE parser
(`packages/fetch/src/stream.ts`) nor the OpenAI SDK stream used by
`openai-adapters` raised an error: the truncated answer looked exactly like a
completed one.

Most likely cause: a TLS-inspecting middlebox (corporate proxy / firewall /
SASE, e.g. Zscaler) terminating long-lived SSE connections — consistent with
openrouter.ai being on an infrastructure blocklist while API traffic
half-works. The fork could not prove this, because no diagnostics were
captured, and development happens on a private machine while the failures
occur on corporate machines.

## 2. What was built

### 2.1 Termination detection (`packages/fetch/src/stream.ts`)

`streamSse()` now tracks termination evidence per stream:

- `data: [DONE]` sentinel seen?
- provider completion signal seen? (OpenAI `choices[*].finish_reason`,
  Anthropic `{"type":"message_stop"}`)
- stats: chars, chunks, SSE lines, comment lines (`: OPENROUTER PROCESSING`
  keepalives), data events, duration, time since last chunk, leftover
  (unterminated) buffer tail, last complete data line, response status +
  diagnostic headers, proxy diagnostics.

**Two modes** (because `streamSse` is shared by many provider dialects, some
of which terminate SSE silently):

- **Lenient (default):** only an unparseable buffer tail (connection cut
  mid-frame — previously surfaced as the misleading "Malformed JSON sent
  from server") throws `PrematureStreamEndError`. A stream that delivered
  complete frames but no terminator is tolerated, as before.
- **Strict (`{ expectTerminationSignal: true }`):** additionally throws when
  the stream ends without [DONE] and without a completion signal (including
  completely empty streams). Enabled where the dialect guarantees a
  terminator: `core/llm/llms/OpenAI.ts` `_streamChat` and legacy
  `_streamComplete` (this covers the MCP-tunnel path, which bypasses the
  openai-adapter).

User cancellation is honored (status 499, `AbortError` body errors tracked
via a WeakSet, optional `signal` option) — no error is raised.
`streamJSON` (NDJSON providers like Ollama) is unchanged — silent endings
are normal there.

Ancillary fix: `: ping` comment lines were treated as `done`, discarding
the rest of the buffer. All SSE comments (`:…`) are now correctly ignored.

### 2.2 Network diagnostics (`packages/fetch/src/diagnostics.ts`)

- `fetchwithRequestOptions` registers per-response diagnostics (proxy used,
  credentials-masked proxy origin) in a WeakMap → included in stream
  forensics.
- `analyzeHeadersForMiddlebox(headers)` — heuristics over response headers
  (`via`, `server`, vendor strings: Zscaler, Netskope, Blue Coat, Forcepoint,
  Palo Alto, Fortinet, Squid, …).
- `probeTlsIssuer(url, requestOptions)` — one-off TLS handshake (through the
  configured proxy, using the same CA bundle as real requests) returning the
  **certificate chain** presented by the peer. This is the definitive test
  for TLS interception: if the issuer is a corporate CA (e.g. "Zscaler
  Intermediate Root CA") instead of a public CA, HTTPS is being inspected.

### 2.3 SDK-level guard (`packages/openai-adapters/src/util/streamTermination.ts`)

The OpenAI adapter path (used for OpenRouter) streams via the OpenAI SDK,
which treats a cleanly closed connection as a completed stream. The new
`guardChatCompletionStream()` wraps the SDK stream in
`OpenAIApi.chatCompletionStream` / `completionStream`:

- zero chunks → always throws (never a valid completion),
- chunks but **no `finish_reason`** → throws when enforcement is active.

The guard also carries the provider-issued correlation ids into the
forensics record: `requestId` (e.g. the OpenRouter `gen-…` generation id —
quote it when reporting an abort to the provider; OpenRouter exposes
per-generation details via `/api/v1/generation?id=…`) and `providerModel`
(the model reported in the chunks, which may differ from the requested
model after provider-side routing). Both are included in the error message.

Enforcement defaults to well-known OpenAI-compatible hosts that always send
`finish_reason` + `[DONE]` (openrouter.ai, api.openai.com, openai.azure.com,
api.deepseek.com, api.moonshot._, api.x.ai, api.groq.com, api.cerebras.ai,
api.together._, api.mistral.ai, api.fireworks.ai). Override via environment
variable: `CONTINUE_STRICT_STREAM_TERMINATION=1|0`.

### 2.4 Core enrichment + JSONL log (`core/llm/streamForensics.ts`)

In `BaseLLM.streamChat` / `streamComplete` catch blocks
(`enrichStreamErrorWithForensics`):

1. If the error is a `PrematureStreamEndError`, run the TLS probe against the
   model's `apiBase`.
2. Append a structured JSONL record to
   `<CONTINUE_GLOBAL_DIR>/logs/stream-forensics.jsonl`
   (usually `%USERPROFILE%\.continue\logs\stream-forensics.jsonl`).
3. Enrich the error message shown in the GUI error dialog (which has a
   copy-to-clipboard button) with the probe results and the log path.

The base message (`formatPrematureStreamEndMessage`) deliberately names both
candidate causes (middlebox, provider-side abort) without asserting one —
at throw time there is no evidence yet. After the probe,
`buildStreamAbortAssessment()` appends an evidence-based `Assessment:` line
to the enriched message:

- interception vendor in the chain → middlebox almost certainly the cause,
- `authorized=true`, public CA, no proxy → **provider-side abort** most
  likely (resubmit usually succeeds; check provider status if it repeats),
- `proxyUsed=true` but clean chain → tunneling proxy remains a suspect,
- `authorized=false` without known vendor → unrecognized interception,
- probe failed → network interference is itself evidence,
- no probe (no apiBase) → cause undecided.

Autocomplete/FIM (`streamFim`) is deliberately excluded to avoid log spam.

## 3. Record format (JSONL, one line per failure)

```json
{
  "timestamp": "2026-07-25T10:00:00.000Z",
  "provider": "openrouter",
  "model": "moonshotai/kimi-k3",
  "apiBase": "https://openrouter.ai/api/v1/",
  "requestType": "streamChat",
  "errorName": "PrematureStreamEndError",
  "errorMessage": "The response stream ended prematurely: …",
  "streamForensics": {
    "charsReceived": 12834,
    "chunksReceived": 41,
    "dataEventsYielded": 37,
    "commentLines": 3,
    "sawDoneSentinel": false,
    "sawCompletionSignal": false,
    "durationMs": 4200,
    "lastChunkAgeMs": 200,
    "leftoverBuffer": "data: {\"id\":\"gen-…",
    "responseHeaders": {
      "server": "cloudflare",
      "cf-ray": "…",
      "via": "1.1 proxy.corp"
    },
    "proxyUsed": true,
    "proxyOrigin": "http://proxy.corp:8080",
    "requestId": "gen-1a2b3c4d",
    "providerModel": "moonshotai/kimi-k3"
  },
  "tlsProbe": {
    "ok": true,
    "host": "openrouter.ai",
    "tlsProtocol": "TLSv1.3",
    "authorized": true,
    "chain": [
      {
        "subject": "CN=openrouter.ai",
        "issuer": "CN=Zscaler Intermediate Root CA …"
      }
    ],
    "suspectedInterception": ["Zscaler"]
  }
}
```

## 4. Interpreting the evidence

| Evidence                                                         | Meaning                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `leftoverBuffer` non-empty (unterminated JSON)                   | connection cut **mid-frame** — classic middlebox kill                                                                                |
| `suspectedInterception` / corporate issuer in `tlsProbe.chain`   | TLS inspection in path → almost certainly the cause                                                                                  |
| `responseHeaders.via` / vendor in `server` header                | explicit proxy in path                                                                                                               |
| `commentLines > 0` before cut                                    | provider keepalives arrived; the middlebox killed the connection despite traffic (rules out pure idle timeouts)                      |
| `lastChunkAgeMs` large before cut                                | connection died while waiting for data (reasoning pause)                                                                             |
| probe fails / times out                                          | network interference even for a plain handshake                                                                                      |
| `authorized=true`, public CA chain, no vendor, `proxyUsed=false` | no interception in path → **provider-side abort** most likely (correlate via `requestId`, e.g. OpenRouter `/api/v1/generation?id=…`) |

`requestId` / `providerModel` are only populated on the openai-adapter path
(the SDK guard sees parsed chunks); on the `streamSse` path
`lastDataLineSnippet` is the fallback for identifying the cut position.
Note that `commentLines` is always 0 on the adapter path (SSE comments are
not observable through the SDK) — the keepalive row above only applies to
the `streamSse` path.

Privacy note: `lastDataLineSnippet` may contain small fragments of model
output. The log never contains request payloads or API keys. It stays on the
user's machine; sharing it is a conscious act.

## 5. Collecting logs on a corporate machine (no dev setup needed)

1. Reproduce the failure (chat with the affected model).
2. The GUI error dialog now shows the full diagnostics — use its copy button.
3. Send `%USERPROFILE%\.continue\logs\stream-forensics.jsonl` to the dev team.

Optional cross-check on the corporate machine (PowerShell):
`curl.exe -v https://openrouter.ai/api/v1/models` → inspect the "issuer"
lines in the TLS handshake output for a corporate CA.

## 6. Test coverage

- `packages/fetch/src/stream.test.ts` — strict/lenient termination detection,
  comment handling, abort/499 behavior, forensics content, message
  formatting, header collection.
- `packages/fetch/src/diagnostics.test.ts` — proxy masking, middlebox header
  heuristics, diagnostics registry.
- `packages/openai-adapters/src/util/streamTermination.test.ts` — chunk
  tracking, host enforcement matrix, guard behavior (healthy/premature/empty/
  aborted/enforced streams).
- `core/llm/streamForensics.vitest.ts` — record building, probe summaries,
  end-to-end capture incl. JSONL append (uses test `CONTINUE_GLOBAL_DIR`).
- Unrealistic mock streams fixed to match real protocol behavior
  (`adapter-test-utils.ts` now ends with a `finish_reason` chunk, Anthropic
  mocks end with `message_stop`).

**Mock infrastructure lesson (core llm tests):** the shared core vitest
setup replaces `globalThis.Response` with node-fetch's implementation, which
cannot carry a web `ReadableStream` body — mocked SSE bytes never reached
`streamSse` at all. These tests always passed because they only assert the
outgoing request, and the old lenient code silently accepted the resulting
empty stream. The first (strict-by-default) version of this feature turned
that hidden defect into 177 failures. The mock helpers in `OpenAI.vitest.ts`,
`OpenAI-compatible.vitest.ts`, `OpenAI-compatible-core.vitest.ts` and
`test-utils/openai-test-utils.ts` now return a minimal Response-like object
with a Node `Readable` body terminated by `data: [DONE]` — stream content is
really consumed again.

**Regression-comparison warning:** `packages/*/dist` is gitignored. A
`git stash` comparison does NOT restore the old built code — `dist` must be
rebuilt from the stashed sources before concluding anything is
"pre-existing". (This mistake was made and corrected during this feature's
development.)

Note: `packages/openai-adapters/node_modules/@continuedev/fetch` was an
outdated registry copy (v1.9.0) and was replaced with a junction to
`packages/fetch`, consistent with `core/` and `extensions/vscode/`.

## 7. Known limitations / follow-ups

- Providers that legitimately end SSE without `[DONE]`/`finish_reason` would
  now surface an error instead of a silent completion; mitigate per call
  (`expectTerminationSignal: false`) or globally
  (`CONTINUE_STRICT_STREAM_TERMINATION=0` for the adapter guard).
- Deferred follow-ups (bounded retry/resume, idle watchdog, `streamFim`
  instrumentation) were extracted to
  [design-proposals/stream-forensics-hardening.md](../../design-proposals/stream-forensics-hardening.md).
