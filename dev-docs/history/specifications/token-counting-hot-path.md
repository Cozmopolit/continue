# Token-Counting auf der Hot-Path: synchrone Host-Blocker beseitigen

**Status:** Implementiert (2026-08-12)
**Date:** 2026-08-12

## Problem / Motivation

Die Continue-Extension blockiert den VS-Code-Extension-Host regelmäßig für
Mehr-Sekunden-Intervalle durch **synchrone Tokenisierung** auf dem
Host-Main-Thread. Beleg: VS Code schreibt bei „UNRESPONSIVE extension host"
automatisch cpuprofiles nach `%TEMP%` — in den Incident-Sessions 2026-08-11/12
zeigt `continue.continue` **78–93 % der Blockzeit**, in zwei Hotspots
(alle Frames in `out/extension.js`, vendored JS-BPE):

1. `streamChat → _logEnd → countTokens` — zählt am **Stream-Ende** den
   kompletten Prompt (ganze History) + Completion + Thinking synchron nach,
   ausschließlich für Dev-Data-/Interaction-Logging. Profile: 1,2–3,6 s
   direkt nach Stream-Ende. Erklärt rückwirkend den 08-11-Befund „GUI-Freeze
   beginnt _nach_ `done`".
2. `compileChatMessages → countChatMessageTokens → countTokens` — tokenisiert
   die **komplette History pro Request synchron neu** (vor jedem Send,
   `streamChat`, sofern nicht `precompiled`). Skaliert quadratisch mit der
   Sessionlänge; dazu sichtbare GC-Last.

Folgekette (Unified Theory der Incidents 08-11/12): Host-Blocks → Chunks
stauen sich und gehen bursty an den Renderer → zusammen mit ungedrosseltem
Delta-Rendering saturiert der Renderer/Webview. VS Code 1.132
(Electron 42.7.1/Chromium 148) hat extern belegt eine Renderer-Fragilität
(u.a. `microsoft/vscode#326092`, `openai/codex#33042`, `#33521`,
OpenAI-Forum-Thread vom 2026-08-09: Renderer-Crashes während Chat-Streaming,
Extension Host stirbt als Folge mit code 0) — der Verstärker, der aus Freezes
vollständige Crashes mit Chat-State-Verlust macht. Beide Trigger-Quellen
(Host-Blocks, Renderer-Druck) sind auf unserer Seite fixbar; diese Spec
adressiert die Host-Seite.

Zusätzlicher Befund: `_logEnd` bekommt provider-seitiges `usage` übergeben,
benutzt es aber **nie** für die geloggten Token-Zahlen — es wird immer lokal
nachgezählt (mit gpt-4-Encoding-Schätzung, also ungenauer als die
Provider-Zahlen).

## Scope

- `core/llm/index.ts` — `_logEnd`: usage-first, Counting nur noch als
  Fallback.
- `core/llm/openaiTypeConverters.ts` — `fromChatCompletionChunk`:
  `chunk.usage` → `ChatMessage.usage` mappen (Recon-Fund: hier wird
  Usage im Adapter-Pfad derzeit verworfen).
- `core/llm/countTokens.ts` — begrenzte Memoisierung des synchronen
  `countTokens` (transparent für alle Caller).
- Fallback-Verhalten für „kein `usage`" = Entscheidung 1.

**Out of Scope:**

- GUI-Streaming-Throttling (Renderer-Seite) — eigener Kandidat aus der
  08-11-Analyse; wird bei Bedarf separate Spec/design-proposal.
- Echte Off-Thread-Tokenisierung (Worker/WASM-Refactor) — zu großer
  Eingriff; Memoisierung + usage-first beseitigt die Blocker praktisch.
- `countTokensAsync`-Reparatur (modelltreue async Encoder außerhalb
  `IS_BINARY`) — hängt mit Off-Thread zusammen, nicht Teil dieser Spec.
- VS-Code-Renderer-Fragilität selbst (extern, nicht bei uns fixbar).
- Usage-Mapping für die Responses-API-Pfade (`fromResponsesChunk`) —
  nicht unser Traffic-Pfad (nur offizielles OpenAI o-series/gpt-5).

## Analysis

**Ist-Zustand:**

- `countTokens` (sync) selektiert per `autodetectTemplateType(modelName)`:
  kein Template → js-tiktoken mit `encodingForModel("gpt-4")` (Instanz
  gecacht) — das ist der Pfad für unsere gpt/claude/openrouter-Modelle;
  Template erkannt → `llamaTokenizer`. Danach
  `getAdjustedTokenCountFromModel`.
- `countTokensAsync` liefert außerhalb `IS_BINARY` **immer**
  `llamaAsyncEncoder` — falscher Tokenizer für Nicht-Llama-Modelle und keine
  Adjustments → **kein Drop-in-Ersatz** für den sync-Pfad. Naives
  „einfach async machen" funktioniert also nicht.
- `_logEnd` (core/llm/index.ts ~353–355): `promptTokens`/`generatedTokens`/
  `thinkingTokens` immer synchron via `this.countTokens(...)`; `usage` wird
  nur an `interaction.logItem` durchgereicht. `Usage` (core/index.d.ts) hat
  `promptTokens`, `completionTokens`,
  `completionTokensDetails.reasoningTokens` — die Provider-Ground-Truth
  (z.B. Anthropic-Adapter sammelt sie während des Streams).
- `streamChat` ruft `compileChatMessages` pro Request **synchron** auf
  (1186–1193), das zählt jede History-Message via `countChatMessageTokens`.
- `compileChatMessages` kopiert Messages per Spread (`{...m}`) →
  Objektidentitäts-Caches (WeakMap) wirkungslos; Cache-Key muss
  inhaltsbasiert sein.
- History-Messages sind nach Anhängen **immutable** → inhaltsbasierte
  Memoisierung macht aus „ganze History pro Request" ein
  „nur neuer Content"-Problem; `_logEnd`-Prompt-Counting wird zum Cache-Hit.

**Verifiziert im Recon (2026-08-12):**

- `_logEnd` = `core/llm/index.ts` 344–407. Die drei
  `streamChat`-Calls (1330/1354/1366) übergeben `usage` bereits
  (1336/1360/1372) — kein Call-Site-Wiring nötig. FIM/Complete-Pfade
  (701–981) übergeben `undefined` und ihre Adapter sammeln kein
  Usage → sie bleiben im Fallback (kleine Strings, kein Blocker).
- OpenAI-Adapter requestet `stream_options.include_usage` und emit-
  tet den Usage-Chunk am Stream-Ende (`openai-adapters/src/apis/
OpenAI.ts` 53–56, 163–181). **Aber:** `fromChatCompletionChunk`
  (`openaiTypeConverters.ts` 381–433) mappt nur content/tool_calls/
  reasoning und liefert für den Usage-Chunk `undefined` → Usage
  erreicht `processChatChunk` (index.ts 1062–1064) im Adapter-Pfad
  (OpenRouter-Hauptpfad!) nie. Das ist die eigentliche Lücke für
  usage-first.
- `getAdjustedTokenCountFromModel` ist pure (feste Multiplikatoren
  pro Modellfamilie, claude=1.23) → Cache kann adjustierte Werte
  speichern.
- `countToolsTokens`: einziger Caller `compileChatMessages`
  (countTokens.ts 478), zählt heute **ohne** Multiplikator (inkon-
  sistent zu `countChatMessageTokens`); bei großem Toolset (CITT
  MCP-Tools) ist das Schema-Encoden pro Request nicht vernachlässigbar.

**Readiness-Recon (Phase 1, 2026-08-12, Implementierungs-Chat):**

- `fromChatCompletionChunk` hat vier Konsumenten: `openAIAdapterStream`
  (index.ts, Zielpfad → `processChatChunk`), der `streamFim`-Adapter-Pfad
  (ein Usage-Chunk rendert dort als leerer String — harmlos),
  `llms/OpenAI.ts` (raw SSE) und `llms/WatsonX.ts` (beide setzen kein
  `stream_options` → keine Usage-Chunks, keine Verhaltensänderung).
- `processChatChunk` (index.ts 1062–1064) übernimmt `usage` nur bei
  `chunk.role === "assistant"`; der Chunk wird per `yield result.chunk`
  (1288/1314) bis zur GUI durchgereicht — konsistent mit heute schon
  yieldeten leeren Tool-Call-Chunks. Phase-4-Test auf
  `processChatChunk`-Ebene einplanen.
- Die Spread-Kopie der Messages passiert in `compileChatMessages` selbst
  (`historyWithTokens`-Map, countTokens.ts ~510–519) → bestätigt den
  inhaltsbasierten Cache-Key.
- Weitere `countTokens`-Caller außerhalb dieses Scopes profitieren
  transparent (pure Funktion, keine Signaturänderung):
  `autocomplete/templating/*`, `autocomplete/util/HelperVars.ts`,
  `core.ts::isItemTooBig`, `nextEdit/BaseNextEditProvider.ts` (pro Zeile),
  `edit/recursiveStream.ts` (pro Chunk, Default-Modell),
  `indexing/chunk/markdown.ts`, `util/generateRepoMap.ts`.
- `countTokens(content, modelName = "llama2")`: der Cache-Key muss den
  aufgelösten Parameterwert verwenden (Default greift vor dem Lookup).
- Junction-Regel greift nicht: alle Änderungen in `core/`
  (Usage-Chunk kommt bereits aus dem gebauten `openai-adapters`-dist).
- Test-Landschaft: `countTokens.test.ts` vorhanden, aber der synchrone
  `countTokens`-Block ist `describe.skip`; aktiv sind
  `getAdjustedTokenCount.test.ts` und `openaiTypeConverters.test.ts`
  (Jest, Tests liegen neben dem Code).

**Warum nicht simpler:** Ein kompletter async-Refactor von
`compileChatMessages`/`prune*` zieht Signaturen durch viele Caller
(Context-Provider etc.) und löst das Falsch-Tokenizer-Problem von
`countTokensAsync` nicht. usage-first + Memoisierung sind zwei kleine,
caller-transparente Eingriffe mit großer Wirkung.

## Solution

**1. usage-first in `_logEnd`** — Kürzel für eine einfache Prioritätsumkehr:
die Token-Zahlen, die der Provider selbst in der Antwort liefert (`usage`,
die abrechnungsrelevante Ground Truth), bevorzugt verwenden und nur mangels
`usage` auf lokales Zählen ausweichen. Heute ist es umgekehrt: `_logEnd`
zählt immer lokal (synchron, gesamter Prompt) und ignoriert das übergebene
`usage`:

```ts
// Konzept, keine Implementierungsvorgabe
promptTokens    = usage?.promptTokens    ?? <Fallback>
generatedTokens = usage?.completionTokens ?? <Fallback>
thinkingTokens  = usage?.completionTokensDetails?.reasoningTokens ?? <Fallback>
```

Provider-`usage` ist Ground Truth und genauer als die lokale
gpt-4-Schätzung. Die drei streamChat-Call-Sites übergeben `usage`
bereits (verifiziert); FIM/Complete-Pfade haben keines und bleiben
im Fallback.

**2. Usage-Mapping in `fromChatCompletionChunk`
(`core/llm/openaiTypeConverters.ts`):** `chunk.usage`
(`prompt_tokens`, `completion_tokens`,
`completion_tokens_details.reasoning_tokens`,
`prompt_tokens_details.cached_tokens`) auf das `Usage`-Feld der
zurückgegebenen `ChatMessage` mappen; für den Usage-only-Final-Chunk
`{ role: "assistant", content: "", usage }` liefern, damit
`processChatChunk` (index.ts 1062) es aufnimmt. Leere
Assistant-Chunks gibt es heute schon (Tool-Call-Chunks) → downstream
sicher. Pure, unit-testbare Converter-Erweiterung in core — keine
openai-adapters-Änderung, keine Junction-Regel.

**3. Fallback ohne `usage` (Entscheidung 1):** synchron zählen, über die
memoisierte `countTokens` — nach Cache-Einführung ist nur noch **neuer**
Content (Completion/Thinking, ggf. letzte User-Message) zu zählen; die
Mehr-Sekunden-Blocks verschwinden damit auch im Fallback-Pfad. Verworfene
Alternativen: Schätzung `chars/4` (zu ungenau für Interaction-Logs),
deferred-async (kein modelltreuer async Encoder vorhanden, s. Analysis).

**4. Memoisierung in `countTokens` (core/llm/countTokens.ts):**

- Begrenzte LRU (Map mit Eviction, 5.000 Einträge, Entscheidung 2).
- Key: `modelName` + Content-Länge + Content-Hash (FNV-1a über den String —
  billig, keine `crypto`-Kosten; **nicht** den Content-String selbst als Key
  halten, sonst Memory-Bloat).
- Value: adjustierter Endwert (nach `getAdjustedTokenCountFromModel`).
- Nur für `typeof content === "string"` cachen; `MessagePart[]`-Inhalte
  gehen uncached durch den alten Pfad (Seltenheit, kein Blocker).
- Caller-transparent: `countChatMessageTokens`, `prune*`, `_logEnd`
  profitieren ohne Signaturänderung.
- Hash-Kollisionen: vernachlässigbar und harmlos (Counts sind per
  `getAdjustedTokenCountFromModel` ohnehin Schätzwerte).

**5. Konvention:** Code-Kommentare zitieren diese Spec nur per Dateiname
(`token-counting-hot-path.md`).

## Entscheidungen (bestätigt 2026-08-12)

1. **Fallback ohne usage** = memoized sync Counting. (Deferred-async
   verworfen: außerhalb `IS_BINARY` existiert kein modelltreuer async
   Encoder; `chars/4`-Schätzung zu ungenau für Interaction-Logs.)
2. **Cache-Parameter**: 5.000 Einträge; Key = `modelName` +
   Content-Länge + FNV-1a-Hash; kein Kill-Switch.
3. **`countToolsTokens`** wird durch den gecachten `countTokens`
   geroutet. (Zahlenänderung ×1.23 bei Claude akzeptiert; bringt
   Konsistenz mit `countChatMessageTokens` + Cache-Gewinn bei
   großem Toolset.)
4. **`thinkingTokens`** aus
   `usage.completionTokensDetails.reasoningTokens`, falls vorhanden;
   sonst Zählung wie heute.

## Implementation Checklist

- [x] `core/llm/index.ts` `_logEnd`: usage-first für
      `promptTokens`/`generatedTokens`/`thinkingTokens` (Fallback =
      memoisiertes Counting).
- [x] `core/llm/openaiTypeConverters.ts` `fromChatCompletionChunk`:
      `chunk.usage` → `ChatMessage.usage` mappen (inkl. Usage-only-
      Final-Chunk als leere Assistant-Message; Felder: promptTokens,
      completionTokens, reasoningTokens, cachedTokens).
- [x] `core/llm/countTokens.ts`: LRU-Memoisierung um `countTokens`
      (Key: modelName + Länge + FNV-1a-Hash; nur String-Content; Value
      adjustiert; begrenzt).
- [x] `countToolsTokens` durch den gecachten `countTokens` routen
      (Entscheidung 3).
- [x] Build `core` grün (`npm run build`); Abweichungen von dieser Spec im
      Abschluss-Report nennen, Status → **Implementiert**, Checklist auf
      `[x]` (gemäß `_IMPLEMENTATION.md` Phase 2).
