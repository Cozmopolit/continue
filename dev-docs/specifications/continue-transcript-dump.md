# Continue-Transcript-Dump nach CITT-Memory

**Status:** **Implementiert** (2026-08-18) — Build config-yaml grün,
Core-Typecheck grün, gezielte Tests 25/25 grün (core-vitest,
transcriptDump); volle Suite + Commit über zeniths Gate
(#5333927844); CITT-seitige Bau-Reihenfolge: Storage
(`RegisterDataFragment`) → `transcript/dump`-Methode → Fork-Hook (diese
Spec)
**Date:** 2026-08-18
**Vertrag:** Board-Topic „continue-transcript-dump" (#5333526847 +
Renderer-Festlegungen des Users 2026-08-18); CITT-Schwester-Spec
`conversation-transcript-dump.md` (Draft, CITT-Repo)

## Problem / Motivation

Continue-Conversations sind flüchtig (lokale JSON-Sessions) und im
CITT-Memory nicht durchsuchbar. Ziel: pro Session ein kumulatives
Markdown-Transcript im CITT-Memory, keyword-durchsuchbar, selbstheilend
(jeder Dump = Volltext + Replace-by-Name). Der Fork rendert, CITT speichert;
Logik beidseitig minimal. Der große Run-Engine-Ersatz ist parked
(continue-als-citt-gui.md).

## Scope

- Neues Core-Modul `core/transcriptDump/` (Renderer + Client)
- Hook im `history/save`-Handler (core/core.ts), fire-and-forget
- `MCPConnection`: proprietäre Methode `transcriptDump()` + Capability-Feld
  `transcript` (Analogie `boardPending()`)
- `packages/config-yaml`: `transcriptDump`-Block (Schema + Typen)

**Out of Scope:** Thinking/Reasoning (explizit verworfen, User-Entscheidung),
System-Prompt (ebenfalls verworfen; liegt ohnehin nicht im Save-Payload),
Tool-Result-Volltexte, Embeddings/semantische Suche (CITT-seitig LIKE),
Debounce (KISS — erst bei Beobachtung von Save-Stürmen), GUI-Settings,
Edit-Mode-Sessions (speichern nicht → keine Dumps), die CITT-seitige
Implementierung selbst.

## Analysis

Verifizierte Fakten (Recon 2026-08-18):

- **Hook-Punkt:** Jeder abgeschlossene User-Turn (inkl. Tool-Loop) endet in
  genau einem Save: streamThunkWrapper → saveCurrentSession →
  `history/save`. Der Core-Handler ist der einzige Choke-Point; das
  Save-Payload enthält die volle History inkl. toolCallStates.
- **Session-ID:** GUI-generierte UUID, stabil über Session-Lebensdauer,
  Webview-Reloads (redux-persist) und Resume via History. Fresh-Boot
  (workspace-fresh-boot.md) erzeugt bewusst neue Sessions → neue IDs →
  eigene Fragmente; fortgesetzte Chats behalten ihre ID. Replace-by-Name
  funktioniert.
- **Transport-Blaupause:** boardClient.ts — `findBoardConnection()` via
  MCPManagerSingleton + `proxyCapabilities.board`, proprietärer Call auf
  `MCPConnection`. Der Dump reitet denselben Pfad. Generischer
  Erweiterungspunkt verifiziert: `MCPConnection.callMethod(method, params,
resultSchema, { signal, timeout })`; `boardPending()` ist die
  exakte Vorlage.
- **Agent-Handle (Memory-Default-Quelle):** liegt in
  `.continue/board-state.json` (`BoardState.handle`, workspace-lokal,
  `loadBoardState(ide)`) — die „Subscription-Handle = lokaler
  Agent-Name"-Quelle aus dem GO-Post.
- **Config-Plumbing:** zod **strippt** unbekannte Top-Level-Keys (kein
  Fehler) → `transcriptDump` muss in `configYamlSchema`,
  `assistantUnrolledSchema` **und** `assistantUnrolledSchemaNonNullable`
  eingetragen werden (alle in packages/config-yaml/schemas/index.ts),
  sonst verschwindet der Block lautlos. Workspace-Blocks: `blockSchema`
  ist eine geschlossene Union (models/context/data/mcpServers/rules/
  prompts/docs) — Custom-Top-Level-Keys werden nicht gemergt. V1 daher:
  global-only + Handle-basierter Default (der ist bereits workspace-lokal).
- **Renderer-Quellen im Save-Payload:** Tool-Name aus
  `toolCall.function.name`, finale Args aus `processedArgs ?? parsedArgs`,
  Result aus `toolCallStates[].output?.[0]?.content`.
- **Save-Payload-Grenzen:** Keine Per-Message-Timestamps, kein
  `sessionStart`, kein System-Prompt in der persistierten Session.
  Konsequenz: `meta.sessionStart` aus dem Vertragssketch entfällt —
  CITT-seitig decken `dumped-at` bzw. Fragment-`createdAt` den Zeitanker ab
  (erster Dump ≈ Session-Start).
- **Titel:** Wird asynchron per chatDescriber generiert; frühe Dumps
  tragen ggf. den Platzhalter. Durch kumulatives Replace heilt das mit dem
  nächsten Turn von selbst.

## Solution

```
Turn-Ende: streamThunkWrapper → saveCurrentSession → "history/save"
  → core-Handler: HistoryManager.save(session)        (unverändert)
  → void dumpTranscript(session, ide, configHandler)  // fire-and-forget,
      │                                               // niemals await/throw
      ├─ skip wenn: history leer | enabled=false | keine transcript-
      │            fähige Connection (Capability-Gate)
      ├─ text = renderTranscript(session)             // pure
      └─ connection.transcriptDump({ memory, name, text, meta })
            → CittMcpServer: Replace-by-Name, Chunking, Header, Store
```

### JSON-RPC-Vertrag (Fork-Sicht)

```
→ transcript/dump { memory: string, name: string, text: string,
                    meta?: { workspace?: string, agent?: string,
                             title?: string } }
← { ok?: boolean }                    |   JSON-RPC error
```

Abweichung vom Sketch: `sessionStart` entfällt (nicht im Save-Payload),
`title` kommt hinzu (User-Entscheidung: Session-Titel gehört in den
CITT-Header). `name` = `transcript-continue-<sessionId>`.
`meta.agent` = Agent-Handle aus `.continue/board-state.json` (entfällt
ohne Board-State); `meta.workspace` = `session.workspaceDirectory`;
`meta.title` = `session.title`.

### Renderer-Regeln (verbindlich)

Minimal-Transcript — **`user`- und `assistant`-Messages** plus
Compaction-Markierungen:

- Pro Item: `## user` / `## assistant` + Message-Text (Content-Parts: nur
  Text-Parts; Bilder als `[image]`-Zeile)
- **Kein** Thinking/Reasoning, **kein** System-Prompt, keine Timestamps
- Tool-Calls aus `toolCallStates` als Kompaktzeilen, direkt unter der
  zugehörigen Assistant-Message:
  - `[tool: <name> k1=v1 k2=v2]` — Args einzeilig, Werte auf 120 Zeichen
    getrimmt (Pfade/Kommandos sind das Keyword-wertvollste)
  - Result eine Zeile darunter: `[→ ok: <200 Zeichen, einzeilig>]` bzw.
    `[✗ error: <200 Zeichen, einzeilig>]`; kein Result-Volltext
- Context-Items einer User-Message als `[context: <name>]`-Zeilen ohne
  Inhalt
- `conversationSummary` eines Items als `## summary`-Sektion direkt nach dem
  tragenden Item (Compaction ist non-destruktiv — die History bleibt
  vollständig im Dump; die Sektion markiert „LLM-Kontext ab hier
  verdichtet"). Bei Forks steht sie allein am Transcript-Anfang, da das
  synthetische Fork-Item leer rendert — so überlebt die Fork-Überleitung im
  Archiv der neuen Session (Amendment 2026-08-18, after-hours)
- Kumulativ: jeder Dump rendert die komplette History neu; Skip bei leerer
  History. Kein inkrementelles Protokoll, kein Debounce.

### Config

```yaml
transcriptDump:
  memory: transcripts:custom # optionaler Override (Default s.u.)
  enabled: true # Kill-Switch (Default true)
```

Global in `~/.continue/config.yaml`. **Memory-Default (User-Präzisierung
via GO-Post):** `transcripts:<agentHandle>` — Handle aus der
workspace-lokalen `.continue/board-state.json`; `transcriptDump.memory`
ist nur Override, Fallback ohne Board-State `transcripts:continue`.
`meta.agent` = Handle — **kein** eigenes `agent`-Config-Feld (KISS, der
Handle ist die autoritative Quelle). **Keine Workspace-Blocks** (s.
Analysis: geschlossene `blockSchema`-Union); die Per-Workspace/Agent-
Differenzierung liefert der Handle bereits workspace-lokal. Capability-
Gate macht `enabled: true` gefahrlos zum Default: Server ohne
`transcript`-Support → stiller Skip.

### Failure-UX

Board-Pattern (`consumeBoardPending` ist die Vorlage): alles try/catch,
`console.warn`, niemals werfen, kein UI-Signal. Fehler heilt der nächste
Turn (kumulativ + Replace). Die Response ist eine Bare-Ack: `{ ok?: boolean }`,
permissiv validiert (BoardAck-Muster — der Server darf Felder ergänzen oder
`ok` ganz weglassen, Zod strippt den Rest). `ok === false` → warn; sonst wird
nur der lokal bekannte Name debug-loggt. Es gibt nichts weiter zu lesen —
Diagnostik ist Serversache.

## Implementation Checklist

- [x] `packages/config-yaml/src/schemas/index.ts`: `transcriptDumpSchema`
      (`{ memory?: string, enabled?: boolean }`) definiert und in
      `configYamlSchema`, `assistantUnrolledSchema` und
      `assistantUnrolledSchemaNonNullable` eingetragen — plus
      `load/unroll.ts`: Passthrough im `unrollBlocks`-Initializer und
      `"transcriptDump"` in der `sections`-Omit-Liste (kein Block-
      Section); `merge.ts` unangetastet (Spread übernimmt den Block)
- [x] `core/index.d.ts`: `ContinueConfig.transcriptDump?:
TranscriptDumpConfig` + `ProxyCapabilities.transcript?: boolean` +
      neue Typen `TranscriptDumpConfig`/`TranscriptDumpPayload`/
      `TranscriptDumpResult`
- [x] `core/config/yaml/loadYaml.ts`: Passthrough
      (`transcriptDump: unrolledAssistant.transcriptDump`) — Assembly
      liegt hier, nicht in yamlToContinueConfig.ts
- [x] `core/context/mcp/MCPConnection.ts`: `ProxyCapabilitiesSchema` um
      `transcript: z.boolean().optional()`; neue Methode
      `transcriptDump(payload)` via `callMethod` — eigener Timeout (10 s,
      größere Payloads als board/pending)
- [x] `core/transcriptDump/renderer.ts` (neu):
      `renderTranscript(session): string` — pure, Regeln wie oben; leere
      Raw-Args (`{}`) werden unterdrückt
- [x] `core/transcriptDump/client.ts` (neu):
      `findTranscriptConnection()` + `dumpTranscript(session, ide,
configHandler)` — Skip-Logik (leere History, enabled=false, kein
      transcript-fähiger Server), Handle via `loadBoardState(ide)`,
      Memory-Default `transcripts:<handle>` (Fallback
      `transcripts:continue`), meta `{ workspace, agent: handle, title }`
- [x] `core/core.ts`: Hook im `history/save`-Handler (~L322) nach dem
      Save: `void dumpTranscript(...)` — Handler bleibt sync, Dump intern
      async, alles try/catch → console.warn
- [x] Spec nachziehen: Checklist `[x]`, Status → Implementiert

---

**Verwandt:** continue-als-citt-gui.md (parked, CITT-Briefing),
board-auto-topic-injection.md (Spec-Archiv; board/pending-Muster),
workspace-fresh-boot.md + workspace-scoped-session-history.md
(Spec-Archiv; Session-ID-Semantik), CITT-Spec
conversation-transcript-dump.md (Draft).
