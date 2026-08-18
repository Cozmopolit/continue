# Gemini `alt=sse` Streaming durch den CITT-Tunnel

**Status: IMPLEMENTIERT (citt-delta, 2026-08-18)** — Unit-/Wire-Format-Tests
grün; Exit-Gate ist die Live-Verifikation mit Rolf (§5, letzter Punkt).

Datum: 2026-08-18 · Autor: citt-delta · Anstoß: vesta-Diagnose (Board
`to-delta` #5321002959, Memory-Fragment CITT-seitig:
`proxy-tunnel-gemini-usage-logging-bug`)

## 1. Problem

Der Gemini-Adapter ruft `:streamGenerateContent` **ohne `alt=sse`** auf →
Google streamt ein rohes JSON-Array (`Content-Type: application/json`).
Durch den CITT-Tunnel hat das zwei Folgen (empirisch verifiziert von vesta,
Ein-Turn-Test auf `[CITT] google-gemini-3.1-pro-high`):

1. **Keine Streaming-UX**: CITT.MCP erkennt weder `"stream":true` im Body
   (Gemini-Bodies haben kein solches Feld) noch `text/event-stream` in der
   Antwort → gepufferter Pfad (tunnel-diag: `req` + `reqResult 200`, keine
   chunks/done).
2. **Usage-Logging** bekam ein JsonArray statt eines Objekts →
   `usageMetadata`-Lookup null → stilles Null in `logs.ProxyTokenUsage`.

**CITT-Seite ist bereits defensiv gefixt** (`ExtractGemini` scannt
JsonArrays von hinten nach `usageMetadata`) — Logging funktioniert damit
auch ohne diese Spec. Der Fork-Teil liefert zusätzlich die echte
Streaming-UX und lässt den bestehenden SSE-Logging-Pfad tragen.

## 2. Ist-Zustand (Code-Recon, verifiziert)

- `core/llm/llms/Gemini.ts` `streamChatGemini` (~Z. 463): baut
  `models/{model}:streamGenerateContent` ohne Query-Param, konsumiert die
  Antwort via `processGeminiResponse(streamResponse(response))`.
- `processGeminiResponse` (~Z. 373–454) ist ein handgerollter
  **JSON-Array-Parser**: strippt `[` / `]` / führendes `,`, splittet an
  `\n,`, `JSON.parse` pro Teil, unvollständige Teile bleiben im Puffer.
  Ein `data:`-Präfix würde am `JSON.parse` scheitern — **SSE kann er
  nicht**.
- **VertexAI teilt sich den Parser**: `core/llm/llms/VertexAI.ts`
  `streamChatGemini` (~Z. 278–301) baut eine eigene URL (ohne `alt=sse`)
  und ruft `this.geminiInstance.processGeminiResponse(streamResponse(…))`.
  Eine blinde Formatänderung von `processGeminiResponse` bricht Vertex.
- `streamSse` (`packages/fetch/src/stream.ts`) verarbeitet einzeilige
  `data: {json}`-Events, toleriert fehlendes `[DONE]` (Default
  `expectTerminationSignal` false), ignoriert Kommentar-Keepalives —
  **passt exakt auf Geminis `alt=sse`-Format** (ein `data:`-Event pro
  Zeile, kein Terminator). Kein neuer Parser nötig.
- Historische Spec `proxy-http-tunneling.md` (dev-docs/history) dokumentiert
  das Array-Format als Wire-Format-Realität; der Wire-Format-Test in
  `core/context/mcp/mcpProxyFetch.vitest.ts` assertet heute **kein**
  `alt=sse`.

## 3. Plan

Alle Änderungen in `core/llm/llms/Gemini.ts`; VertexAI und der
Bison-Legacy-Pfad (`generateMessage`, non-streaming) bleiben unangetastet.

1. **URL**: in `streamChatGemini` `apiURL.searchParams.set("alt", "sse")`.
2. **Chunk-Logik extrahieren**: die per-Objekt-Verarbeitung aus
   `processGeminiResponse` (~Z. 399–445: error-Feld, Text-Parts,
   functionCall-Parts) in eine Methode `processGeminiChunk(data:
GeminiChatResponse)`.
3. **SSE-Konsum**: `streamChatGemini` iteriert `streamSse(response)` und
   yieldet über `processGeminiChunk`.
4. **Rückwärtskompatibilität**: `processGeminiResponse` bleibt als
   JSON-Array-Parser bestehen und delegiert pro geparstem Objekt an
   `processGeminiChunk` — identisches Verhalten für VertexAI.

## 4. Risiken / Side-Effects

- **Direkter (nicht getunnelter) Gemini-Betrieb** wechselt ebenfalls auf
  SSE. Bewusst: ein Wire-Format überall; Google supportet `alt=sse`
  offiziell (das GoogleGenAI-SDK nutzt es). Trotzdem eine
  Verhaltensänderung auch ohne Tunnel.
- **Fehler-Responses unter `alt=sse`**: non-2xx-Antworten kommen ggf. als
  JSON-Body ohne SSE-Framing. Fehlerpfad prüfen (heute: error-Feld im
  Chunk wirft; non-OK-Handling ansehen). `streamSse` wirft bei
  `data.error` und bei Malformed JSON — Verhalten gegen echte
  Fehlerantworten verifizieren.
- **CITT.MCP-Streaming-Erkennung** muss auf `text/event-stream` im
  Response-Header triggern (laut vesta ja). Verifikationspunkt vor
  Abschluss, keine Annahme.
- **`streamSse` kennt kein Gemini-Completion-Signal** — irrelevant,
  solange `expectTerminationSignal` nicht gesetzt wird (wird es nicht).

## 5. Tests (nach Implementierung, Hard Rule 1)

- **Neu `core/llm/llms/Gemini.vitest.ts`**: SSE-Fixtures (Multi-Event,
  error-Event, non-200) gegen den `streamChat`-Pfad inkl.
  `alt=sse`-URL-Assertion; `processGeminiChunk` direkt (Text,
  functionCall/args-Stringifizierung/thoughtSignature, error, leeres
  Chunk); JSON-Array-Regression für `processGeminiResponse` (Split
  mitten im Event, error-Objekt) — sichert den Vertex-Pfad.
- **`core/config/mcpProxyModelDiscovery.vitest.ts`**: Wire-Format-Assertion
  umgedreht — Gemini-Pfad enthält jetzt `alt=sse`
  (`…:streamGenerateContent?alt=sse`). _(Korrektur gegenüber der
  Ursprungs-Spec: dort war fälschlich `mcpProxyFetch.vitest.ts` genannt —
  dessen `alt=sse`-Stelle ist ein Input-Passthrough-Test für
  `buildProxyHttpParams` und unverändert.)_
- **`core/llm/customFetch.vitest.ts`**: bestehender Gemini-Test um
  `alt=sse`-Assertion ergänzt (assertierte zuvor nur `pathname`).
  _(Korrektur: `llm-pre-fetch.vitest.ts` hat keine Gemini-URL-Expectation —
  nur `expect.any(URL)` — und brauchte keine Änderung.)_
- **Live-Verifikation** (mit Rolf): Ein-Turn auf
  `[CITT] google-gemini-3.1-pro-high` — Erwartung: tunnel-diag zeigt
  chunks/done, GUI streamt sichtbar, `logs.ProxyTokenUsage` bekommt eine
  Row über den SSE-Pfad (`ExtractGeminiSse`).

## 6. Referenzen

- vesta: Board `to-delta` #5321002959 (Diagnose + CITT-Fix + Aufteilung)
- CITT-seitiges Memory-Fragment: `proxy-tunnel-gemini-usage-logging-bug`
- Historie: `proxy-http-tunneling.md` (§ Wire-Format reality check)
- Forensik: `~/.continue/logs/tunnel-diag.jsonl` (Toggle
  `tunnel-diag.enabled`), CITT: `logs.ProxyTokenUsage` (lokale Zeit) vs.
  `logs.ApplicationLog` (UTC)
