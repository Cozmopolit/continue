# OpenRouter Stream Abort Incident (2026-07-25, dev system)

**Status:** For later analysis
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

## 4. To analyze later

- **Pattern match:** 1299 data events over 34.1 s, connection closed **31 ms
  after the last chunk**, no `finish_reason`, no `[DONE]` — a genuine
  mid-stream abort, not a false-positive shape (detection path:
  openai-adapter `guardChatCompletionStream`, `doneSentinelObservable:
false` as designed).
- Distinguish root cause candidates: OpenRouter/upstream (Moonshot)
  provider-side abort vs. internet path issue on the dev machine. Check
  OpenRouter status / error correlation at 2026-07-25 13:34 UTC.
- If confirmed provider-side: first real-world evidence that the detection
  also catches genuine provider aborts (useful contrast case to the
  corporate middlebox hypothesis).
- Message wording: the enriched message leads with "typically caused by a
  network middlebox" — with a clean TLS probe that framing is misleading.
  Consider reordering: when `authorized=true` and no interception vendor is
  found, present provider-side abort as the primary explanation.
- Confirm no user-visible regression beyond the error dialog itself (turn
  ended, user could resubmit).
