# Continue-Extension als CITT-GUI („CITT Conversations" in VSC)

**Status:** **Parked** (User-Entscheidung 2026-08-18): Das eigentliche Ziel
ist Persistenz/Durchsuchbarkeit der Continue-Chats, nicht der
Run-Engine-Ersatz. Weiterführend: continue-transcript-dump.md. Dieses
Dokument bleibt als Referenz bestehen (inkl. vestas code-verifiziertem
CITT-Briefing); Kliff für eine spätere Wiederaufnahme: client-seitige Tools.
**Date:** 2026-08-18
**Quellen:** Fork-Analyse durch citt-delta; CITT-seitiges Architektur-Briefing
durch citt-vesta, code-verifiziert (Board-Topic „Continue-GUI als
CITT-Frontend (Run-Engine-Ersatz)", #5333215428, 2026-08-18)

## Motivation

Der Fork und CITT werden aktuell dual-faced betrieben, und jede
Schnittstelle doppelt gepflegt:

- Modelle/Endpoints werden in Continue (config.yaml) **und** in CITT
  (Endpoint-/Alias-System) konfiguriert.
- CITT-Tools laufen über den MCP-Tunnel (CITT.MCP) — ein Umweg, der die
  native ToolSet-Konfiguration, Sub-Agenten und das CITT-Logging umgeht.
- Jeder Reasoning-/Streaming-API-Umbruch eines neuen Modells wird **zweimal**
  gefixt: hier (openai-adapters, core/llm) und in CITT (LLM-Proxy).

Die Idee: Die Run-Engine des Forks abhängen und die Extension zur **GUI für
CITT-Conversations** machen — dieselbe Conversation-Engine wie in der
CoreApp: Run/Turn/FICC-Logik, ToolSets, Sub-Agenten, CITT-Logging, alles
über den CITT-LLM-Proxy. Der MCP-Tunnel für Chat-Zwecke entfällt.
Behalten werden soll die GUI-Stärke des Forks: Chat-Rendering inkl.
Thinking-Blöcken, Tool-Call-Darstellung, Input-UX, History-UX.

Übergeordnete Richtung (User): das duale Continue+CITT-Ding näher
zusammenführen statt zwei parallele Systeme zu pflegen.

**Explizite Non-Goals (aus dem tatsächlichen Nutzungsprofil des Users):**

- Keine IDE-wirkenden Tools: Diff-Preview/Accept-Reject, Editor-State-,
  Selection- und Approval-UX werden nicht genutzt (Yolo-Mode war der erste
  Fork-Eingriff überhaupt). Datei-Explorer, Viewer und Terminal liefert VSC
  selbst.
- Damit: **keine Client-Tool-Bridge** (kein „RunExecutor delegiert Tool-Call
  an den Client und wartet"). Tools wirken aufs Dateisystem — das können
  CITT-Tools in-process, wie heute bereits in der täglichen Arbeit.
- Autocomplete/NextEdit/Apply sind separate Modell-Rollen-Pfade und nicht
  Teil dieser Idee (De-Scoping-Frage, s. offene Entscheidungen).

## Analyse

### Fork-Seite (delta)

Der Fork hat keine „Run Engine" als Einheit — der Agenten-Loop lebt in der
**GUI** (Redux-Thunks):

```
streamResponseThunk → streamNormalInput → callToolById
    ↑__________________| (streamResponseAfterToolCall)
```

- GUI-Thunks bauen Prompt (`llm/compileChat`), streamen via
  `llmStreamChat` und dispatchen jedes Delta als `streamUpdate`; Tool-Calls
  werden GUI-seitig erkannt, policy-bewertet und ausgeführt (Client-Tools
  lokal, Rest via `tools/call` im Core).
- Core ist LLM-IO (`llm/streamChat` → `model.streamChat`), Tool-Dispatch
  (`callTool.ts`: Built-ins / HTTP / MCP) und Session-Persistenz
  (`history/*` → JSON-Dateien via HistoryManager).

**Die Nahtstelle ist sauber benennbar:** Der Redux-Store ist komplett
delta-getrieben — den Renderern (StepContainer, ToolCallDiv,
ThinkingBlockPeek) ist es egal, woher Deltas kommen. Ein CITT-Run-Eventstrom
kann auf `ChatMessage`-Deltas gemappt und in denselben `streamUpdate`-
Reducer gespeist werden; die gesamte Render-Pracht bleibt unangetastet.
`history/list|load|save` wird auf CITT-Conversations gemappt;
Continue-Sessions hören auf, die Wahrheit zu sein.

**Fork-spezifische Kopplungen** in genau diesen Dateien (müssen umziehen
oder bewusst entfallen): Board-Injection (pro Turn in streamNormalInput),
Self-Compaction (compact_conversation-Tool → compactConversationThunk →
`conversation/compact`), Reasoning-Rescue bei Cancel, Prompt-Logging,
Overload-Retry. CITT hat für mehrere davon eigene Pendants (Mid-Run-
Injection, Compaction, Logging).

### CITT-Seite (vesta, code-verifiziert 2026-08-18)

- **HTTP/SSE-Fläche ist nahezu komplett und nicht Blazor-spezifisch** (3
  Controller: Conversations ~20 Routen, Configuration inkl. generischem
  Op-Endpunkt, Assistants-Liste): Conversation-CRUD, Run starten/canceln,
  Run-SSE, Status-SSE + Polling, Messages-History, Attachments,
  Fork/Revert, Feedback, Token-Usage, Families, User-Settings.
- **Streaming:** Text-Deltas + Reasoning-Deltas (first-class), terminale
  Events (completed/failed/cancelled) mit Usage. **Keine Live-Tool-Call-
  Events** — Tool-Details nur post-hoc über die Op `conversation_reasoning`.
  Sub-Agenten flach: eigene Conversations in der Family, Status-Texte
  blubbern über den Status-Stream hoch.
- **Backpressure:** Event-Channel bounded DropOldest(5000) — Deltas können
  unter Druck verloren gehen, terminale Events nie. Client muss nach
  Run-Ende Messages neu laden (etabliertes Reconcile-Pattern).
- **Client-Tools existieren nicht** (wäre Feature-Projekt) — für dieses
  Nutzungsprofil **nicht nötig**: Workspace-Datei-/Terminal-Tools laufen
  host-seitig (FileSystem-Plugin existiert).
- **Auth/Betrieb zuhause: kein Hindernis.** Kein Auth-Layer (by design),
  Identity = Host-Prozess-Identität; lokaler Windows-Account + lokale
  SQL-Instanz läuft, de-facto Single-User.
- **Lücken (klein):** kein Compaction-Trigger über HTTP (intern); keine
  Per-Run-Endpoint-/Fidelity-Wahl (Alias-System server-seitig, Per-User-
  Alias-Overrides plausibel, Detail offen); kein paketierter lokaler
  WebApi-Deployment-Pfad (technisch plain Kestrel; ServiceHost = zentraler
  Windows-Dienst); Assistant-/ToolSet-Auswahl nur aus vorkonfigurierten
  Assistants (Authoring = DB).
- CITT will dumme Frontends — ein drittes Frontend auf derselben Fläche ist
  architektur-konform.

### Konsequenz

V1 braucht **kein CITT-Feature-Projekt**. Das ursprünglich vermutete
Make-or-Break (Client-Tool-Delegation mit suspendiertem Run) entfällt
durch das Nutzungsprofil vollständig. Die verbleibende Arbeit liegt fast
vollständig im Fork und ist gut umgrenzt; CITT-seitig nur kleine
Ergänzungen.

## Affected Areas

**Fork (Hauptarbeit):**

- `gui/src/redux/thunks/`: streamNormalInput.ts (Kern-Ersatz: CITT-Run
  subscriben statt LLM streamen), streamResponse.ts,
  streamResponseAfterToolCall.ts, callToolById.ts (v1 ungenutzt, Bridging
  erst bei evtl. späteren Client-Tools), compactConversation.ts,
  session.ts, streamThunkWrapper.tsx
- `gui/src/redux/slices/sessionSlice.ts` — `streamUpdate`-Reducer bleibt
  Konsument; neue Mapping-Schicht CITT-Event → ChatMessage-Delta speist ihn
- Neu: CITT-Transport-Modul (SSE/HTTP-Client). Platzierung Core statt GUI
  empfohlen, weil `packages/fetch` den Corporate-Proxy/SSL-Schmerz bereits
  löst
- `core/core.ts` — `history/*`-Handler als Adapter auf CITT-Conversations
  (alternativ GUI-direkt)
- Config-Oberflächen: Modell-Auswahl → Assistant-Picker; MCP-/Modell-
  Konfig schrittweise entschlacken
- Umzuziehende Fork-Features: boardInjection.ts, compactConversation.ts
  (Thunk), Prompt-Logging, Reasoning-Rescue

**CITT (kleine Ergänzungen, separat zu spezifizieren):**

- Compaction-Trigger über HTTP (Route oder Op)
- Lokaler Standalone-Lauf der WebApi paketieren (Kestrel; SQLite-Frage
  offen)
- Optional: Live-Tool-Call-Events in der RunStreamEvent-Hierarchie (auch
  Voraussetzung für etwaige spätere Client-Tools)
- Optional: Alias-/Fidelity-Override pro User/Run klären

## Offene Entscheidungen (User)

1. WebApi-Betrieb zuhause: lokal standalone vs. zentraler ServiceHost.
2. Modellwahl-UX: assistant-gebunden + Alias-Overrides — genügt das?
3. Live-Tool-Events in CITT bauen oder post-hoc (conversation_reasoning)
   vorerst ausreichend?
4. Schicksal von Edit/Apply/NextEdit/Autocomplete im Fork: behalten (auf
   CITT-LLM-Proxy zeigen), einfrieren oder entfernen?
5. Continue-internes MCP: für Nicht-CITT-Server behalten oder entfernen?

## Mögliche Stufen (Richtung, noch keine Spec)

1. **Read-only:** CITT-Conversation-Liste + History im Continue-Chat
   rendern (beweist Transport + Mapping).
2. **Live-Run:** Message posten, Run-SSE → streamUpdate, Cancel; Reconcile
   nach terminalem Event.
3. **Tool-/Sub-Agent-Fidelity:** Status-Stream live, post-hoc Anreicherung
   via conversation_reasoning.
4. **Compaction + Assistant-Picker + Config-Entschlackung.**
5. **De-Scoping:** Entscheidungen zu Edit/Apply/Autocomplete/MCP;
   Fork-Feature-Umzug (Board-Injection, Prompt-Logging, Reasoning-Rescue).

## Risiken

- Regressionsrisiko in den am stärksten gepatchten Fork-Dateien
  (streamNormalInput, sessionSlice, callToolById) — dort hängen die meisten
  Fork-Eingriffe.
- DropOldest-Delta-Verlust erzwingt diszipliniertes Reconcile im Client.
- Übergangsphase mit zwei Modi (Continue-Engine + CITT-Engine) bewusst
  managen und kurz halten.
- Lokaler CITT-WebApi-Lauf ist aktuell kein paketierter Pfad.

---

**Verwandt:** continue-fork-long-term-maintenance.md (Tech-Debt,
Motivationskontext), proxy-http-tunneling.md + endpoint-discovery.md
(Spec-Archiv, der bisherige MCP-Tunnel), agent-self-compaction.md
(Spec-Archiv), Board-Topic „Continue-GUI als CITT-Frontend
(Run-Engine-Ersatz)" (2026-08-18, vestas CITT-Briefing).
