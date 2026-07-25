# OpenRouter Stream Abort Incident (2026-07-25, dev system)

**Status:** Analyzed (2026-07-25) — provider-side abort most likely;
wording + correlation-id measures implemented (see §5)
**Recorded:** 2026-07-25

## 1. What happened

During implementation of `prompt-logging-opt-in.md` (chat running on Kimi K3
via OpenRouter, dev system, first build containing the stream forensics from
`stream-forensics.md`), a `PrematureStreamEndError` fired in production for
the first time. The enrichment pipeline worked end-to-end: GUI error message
with network forensics, TLS probe, JSONL record appended.

Notable: this happened on the **dev system** (no known middlebox), and the
TLS probe shows the **legitimate public certificate chain** (authorized,
Google Trust Services) — i.e. **no TLS interception**. This points to an
OpenRouter-/upstream-provider-side abort rather than corporate
infrastructure — or to a false positive in the new detection (see §4; the
forensics numbers argue against a false positive).

## 2. Error message (verbatim, from the GUI copy button)

```
--- Network forensics ---
TLS probe to openrouter.ai:443: TLSv1.3 / TLS_AES_128_GCM_SHA256, certificate authorized=true
Certificate chain presented by the server (leaf first):
- CN=openrouter.ai  (issued by: CN=WE1, O=Google Trust Services, C=US)
- CN=WE1, O=Google Trust Services, C=US  (issued by: CN=GTS Root R4, O=Google Trust Services LLC, C=US)
- CN=GTS Root R4, O=Google Trust Services LLC, C=US  (issued by: CN=GlobalSign Root CA, O=GlobalSign nv-sa, OU=Root CA, C=BE)
No known TLS-inspection vendor found in the certificate chain. If the chain shows your organization's CA instead of a public CA, traffic is still being intercepted.
Full forensics record appended to: C:\Users\Zuser\.continue\logs\stream-forensics.jsonl
```

## 3. Forensics record (from stream-forensics.jsonl, pretty-printed)

```json
{
  "timestamp": "2026-07-25T13:34:53.454Z",
  "provider": "openrouter",
  "model": "moonshotai/kimi-k3",
  "apiBase": "https://openrouter.ai/api/v1/",
  "requestType": "streamChat",
  "errorName": "PrematureStreamEndError",
  "errorMessage": "The response stream ended prematurely: the connection was closed mid-stream before the completion finished (no finish_reason was received).\nStream context: openai-adapter chat.completions (https://openrouter.ai/api/v1/).\nStream forensics: 1299 data events, 5392 chars received, 34.1s duration, last chunk 0.0s before close.\nThis is typically caused by a network middlebox (corporate proxy, firewall, VPN, TLS inspection, antivirus web filter) terminating long-lived streaming connections.",
  "streamForensics": {
    "charsReceived": 5392,
    "chunksReceived": 1299,
    "sseLinesParsed": 1299,
    "commentLines": 0,
    "dataEventsYielded": 1299,
    "sawDoneSentinel": false,
    "doneSentinelObservable": false,
    "sawCompletionSignal": false,
    "startedAt": "2026-07-25T13:34:19.058Z",
    "durationMs": 34129,
    "lastChunkAgeMs": 31,
    "context": "openai-adapter chat.completions (https://openrouter.ai/api/v1/)"
  },
  "tlsProbe": {
    "host": "openrouter.ai",
    "port": 443,
    "durationMs": 266,
    "proxyUsed": false,
    "ok": true,
    "tlsProtocol": "TLSv1.3",
    "cipher": "TLS_AES_128_GCM_SHA256",
    "chain": [
      {
        "subject": "CN=openrouter.ai",
        "issuer": "CN=WE1, O=Google Trust Services, C=US",
        "validFrom": "Jul  6 18:49:35 2026 GMT",
        "validTo": "Oct  4 19:49:33 2026 GMT"
      },
      {
        "subject": "CN=WE1, O=Google Trust Services, C=US",
        "issuer": "CN=GTS Root R4, O=Google Trust Services LLC, C=US",
        "validFrom": "Dec 13 09:00:00 2023 GMT",
        "validTo": "Feb 20 14:00:00 2029 GMT"
      },
      {
        "subject": "CN=GTS Root R4, O=Google Trust Services LLC, C=US",
        "issuer": "CN=GlobalSign Root CA, O=GlobalSign nv-sa, OU=Root CA, C=BE",
        "validFrom": "Nov 15 03:43:21 2023 GMT",
        "validTo": "Jan 28 00:00:42 2028 GMT"
      }
    ],
    "authorized": true
  }
}
```

## 4. Analysis (done 2026-07-25)

**Verdict: genuine mid-stream abort, most likely provider-side (OpenRouter
gateway or upstream Moonshot). Not a false positive.**

Timeline: stream started 13:34:19.058Z; 1299 chunks / 5392 chars over
34.1 s (~38 events/s, sustained generation); the connection closed cleanly
**31 ms after the last chunk** — no `finish_reason`, no `[DONE]`. The
record timestamp is 267 ms after the close, exactly matching
`tlsProbe.durationMs` (266 ms): detection → probe → JSONL append ran
back-to-back, and the probe succeeded instantly — the local network path
was healthy at the moment of the abort.

Evidence against a false positive:

- OpenRouter always terminates completions with a `finish_reason` chunk +
  `[DONE]`; 1299 chunks without either = truncated generation.
- `lastChunkAgeMs: 31` — the connection died mid-flow, roughly one
  inter-chunk gap after the previous chunk. Not an idle-timeout shape.
- ~4.1 chars/chunk — fine-grained deltas typical of reasoning streaming
  (Kimi K3 thinking); the answer was cut mid-generation.

Root-cause weighing:

- **Provider-side abort (most likely):** clean TCP/TLS close right after a
  delivered chunk = orderly FIN from the peer. No middlebox on this path
  (probe: `authorized=true`, public Google Trust Services chain,
  `proxyUsed=false`). OpenRouter proxies to upstream providers; an
  upstream failure (instance crash/deploy, load shedding, generation
  timeout on a long reasoning stream) surfaces exactly like this.
- Dev-machine internet path (unlikely): NAT/conntrack timeouts hit _idle_
  connections, not one streaming 38 events/s; consumer-path blips produce
  RST/timeout, not a clean FIN; and the probe 267 ms later was fast and
  clean.
- User abort: excluded by design (signal/499 tracking; the guard returns
  silently on abort).

Caveats discovered during analysis (now documented in
stream-forensics.md §4):

- `commentLines: 0` is **not** evidence on the adapter path — SSE comments
  are unobservable through the OpenAI SDK, the field is hardcoded 0 (same
  category as `doneSentinelObservable: false`). The "keepalives rule out
  idle timeouts" interpretation only applies to the `streamSse` path.
  (Idle is excluded anyway by `lastChunkAgeMs`.)
- The guard had captured the OpenRouter generation id (`stats.requestId`,
  a `gen-…` id present in every chunk) but dropped it when building the
  forensics object — the single most valuable correlation key (OpenRouter
  `/api/v1/generation?id=…`) was lost for this incident. Fixed, see §5.

User-visible regression: none beyond the intended error dialog. The turn
ended, the user resubmitted, the session continued. Before stream
forensics, this incident would have been a **silent truncation** (a
partial answer looking complete) — the first production firing converted a
data-integrity failure into a visible, diagnosable error, on a machine
with no middlebox at all.

## 5. Measures implemented (2026-07-25)

1. **Probe-dependent message wording.** The base message
   (`formatPrematureStreamEndMessage`, `packages/fetch/src/stream.ts`) no
   longer asserts "typically caused by a network middlebox"; it names both
   candidate causes neutrally. The enrichment
   (`buildStreamAbortAssessment`, `core/llm/streamForensics.ts`) appends an
   evidence-based `Assessment:` line: clean probe without proxy →
   provider-side abort as the primary explanation (with resubmit advice);
   interception vendor / foreign CA → middlebox; tunneling proxy → proxy
   remains a suspect; failed probe → network interference.
2. **Provider correlation ids captured.** `StreamForensics` gained
   `requestId` + `providerModel`, populated by the openai-adapter guard
   (both were already tracked and then discarded). They are rendered in
   the error message and stored in the JSONL record, enabling
   `/api/v1/generation?id=…` correlation for future incidents.

Tests: new/updated unit tests in `packages/fetch/src/stream.test.ts`,
`packages/openai-adapters/src/util/streamTermination.test.ts` and
`core/llm/streamForensics.vitest.ts` (including the incident-shaped
clean-probe case asserting the provider-side assessment).
