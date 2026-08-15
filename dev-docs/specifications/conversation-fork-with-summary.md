# Conversation Fork with Summary

**Status:** Implementiert (Rev 2)
**Date:** 2026-08-15 (Rev 2: 2026-08-15 — Phase-1-Recon-Funde eingearbeitet:
uuid-Konvention, Toast-Mechanismus, Streaming-Guard-Herkunft,
Fork-am-Fork-Item-Edge-Case)

## Problem / Motivation

Das bestehende Compact-Feature (`conversation/compact`) ist nicht-destruktiv:
Es schreibt eine `conversationSummary` auf ein History-Item; `constructMessages`
filtert beim Prompt-Bau alles davor weg. Die volle History bleibt aber in
Session-Datei und GUI-State — nach mehrfachem Compacten (Realfall: 5× in einer
Conversation) werden Session-Dateien riesig und die GUI träge (lange
Step-Listen), obwohl das LLM die alten Items nie sieht.

Gewünscht: Ein „Start new conversation with summary up to here"-Act
(**Fork**) an jeder Assistant-Message. Die neue Session beginnt mit genau
einem synthetischen Item, das die Summary trägt; die alte Session bleibt zu
100 % unangetastet (kein Trim, kein Backup nötig — sie ist das Archiv).

Abgrenzung zum klassischen Compact (disjunkte Semantiken):

- **Compact** (existiert): in _derselben_ Session weiter; Vorgeschichte als
  Summary, Items nach dem Compact-Punkt bleiben wörtlich im Prompt.
- **Fork** (diese Spec): _neue_ Session ab Wissensstand an Position X; alles
  andere lebt ausschließlich im Archiv (alte Session). Tail-Items nach X
  werden **verworfen** (nicht kopiert) — ein „Summary bis hier" fordert
  bewusst den Wissensstand an X an, inkl. Rewind-Szenarien (ab X lief die
  Conversation in eine Sackgasse).

## Scope

- `core/util/conversationCompaction.ts` — Refactoring: Summary-Generierung
  als wiederverwendbare Funktion extrahieren; bestehendes Compact-Verhalten
  unverändert.
- `core/util/conversationFork.ts` (neu) — `forkSessionWithSummary()`:
  validiert, generiert Summary, legt neue Session an, returnt neue ID.
- `core/index.d.ts` — zwei optionale Felder auf `ChatHistoryItem`
  (Verkettung, s. Decisions).
- Protokoll: `core/protocol/core.ts`, `core/core.ts`,
  `core/protocol/passThrough.ts` + Sync-Pendant `MessageTypes.kt`.
- GUI: `gui/src/util/compactConversation.ts` (neuer Hook),
  `gui/src/components/StepContainer/ResponseActions.tsx` (neuer Button),
  `gui/src/components/StepContainer/ConversationSummary.tsx`
  (Vorgänger-Link).

**Out of Scope:**

- Trim in der bestehenden Session (verworfen zugunsten dieser Variante).
- Auto-Fork bei Kontext-Schwellwert; dediziertes `summarize`-ModelRole
  (Compaction nutzt weiter das aktuelle Chat-Modell).
- JetBrains-GUI (Button nur VS Code); Protokoll-Sync in `MessageTypes.kt`
  ist trotzdem Pflicht (s. `passThrough.ts`-Konvention).
- Scroll-to-Index im Vorgänger (Luxus; Link öffnet Vorgänger-Session).
- Test-Planung (separate Phase laut `_IMPLEMENTATION.md`).

## Analysis

### Verifizierte Ist-Zusammenhänge (Recon 2026-08-15)

- **Summary-Erzeugung** (`core/util/conversationCompaction.ts`): Suche der
  letzten `conversationSummary` rückwärts (inkrementelle Verdichtung),
  „Tool cancelled"-Ergänzung für dangling Tool-Calls, fester
  6-Punkte-Compaction-Prompt, `currentModel.chat()` (nicht gestreamt),
  `stripImages(response.content)`. `compactConversation` schreibt die
  Summary auf Item `index` und speichert die Session.
- **Konsum** (`gui/src/redux/util/constructMessages.ts`): letzte Summary
  rückwärts suchen → `filteredHistory = history.slice(i + 1)`; Summary wird
  an die System-Message angehängt. Ein synthetisches Item an Position 0 mit
  `conversationSummary` liefert also ohne jede Änderung: Prompt =
  System-Message + Summary + alle nachfolgenden (neuen) Messages. Die
  leere Assistant-Message des Items wird per `chatMessageIsEmpty`
  verworfen — sie trägt nur die Summary.
- **Persistenz-Falle Session-Felder:** `HistoryManager.save()` baut das
  geschriebene Objekt mit expliziter Whitelist neu (`sessionId`, `title`,
  `workspaceDirectory`, `history`, `mode?`, `chatModelTitle?`, `usage?`);
  GUI-seitig konstruiert `saveCurrentSession` (`gui/src/redux/thunks/
session.ts`) das `Session`-Objekt ebenfalls neu. Neue Felder auf
  Session-Ebene würden beim nächsten Save **still verworfen**.
  `history` wird dagegen überall 1:1 durchgereicht.
- **Titel-Generierung:** `saveCurrentSession` generiert nur dann via
  `chatDescriber/describe`, wenn `title === NEW_SESSION_TITLE`. Ein beim
  Fork gesetzter Titel bleibt dauerhaft stabil. Ist der Vorgänger-Titel
  selbst noch `NEW_SESSION_TITLE`, muss die neue Session ebenfalls
  `NEW_SESSION_TITLE` bekommen (kein „New Session (continued)"), damit der
  normale Titel-Flow nach der ersten echten Antwort greift.
- **loadSession-Thunk** (`gui/src/redux/thunks/session.ts`):
  `getSession` → `dispatch(newSession(session))` → stellt
  `chatModelTitle` wieder her. Direkt wiederverwendbar für den
  Session-Wechsel nach dem Fork.
- **GUI-Panel:** `ConversationSummary.tsx` rendert oberhalb eines Items
  mit `conversationSummary` ein einklappbares Panel inkl. Loading-State
  (`compactionLoading[index]`) und Delete-Button — das Fork-Item bekommt
  die etablierte Darstellung gratis.
- **Fehlerbehandlung heute:** der `conversation/compact`-Handler in
  `core/core.ts` schluckt Exceptions (`Logger.error`, `undefined`). Für
  den Fork nicht übernehmen (s. Decisions).
- **Session-ID-Konvention:** `import { v4 as uuidv4 } from "uuid"` ist der
  etablierte Weg im Core (nicht `crypto.randomUUID()`).
- **Toast-Mechanismus (GUI):** `ideMessenger.post("showToast", ["error",
msg])` — Präzedenz: `Auth.tsx`, `edit.ts`-Thunk.
- **Streaming-Guard kommt gratis:** `StepContainer.tsx` deaktiviert die
  komplette ResponseActions-Leiste bei `isStreaming` bereits
  (`pointer-events-none` auf dem Container); der Hook prüft zusätzlich
  `state.session.isStreaming` (defense in depth).
- **`deleteCompaction`-Reducer** (sessionSlice) setzt nur
  `conversationSummary: undefined` — das Item bleibt bestehen, die
  Verkettungsfelder überleben das Löschen der Summary. (Das Panel samt
  Vorgänger-Link rendert dann nicht mehr — akzeptiert.)
- **Fork-am-Fork-Item:** Das synthetische Item rendert die
  ResponseActions-Leiste (leerer Content ist kein Render-Guard). Ein Fork
  an Index 0 einer Fork-Session hätte nur die leere Message als
  Summarize-Input, weil die Re-Compaction-Logik die Summary am Ziel-Item
  ausschließt → degenerierte Summary. Guards s. Decisions.
- **`MessageTypes.kt`** (IntelliJ-Sync): `"conversation/compact"` steht in
  der PassThrough-Liste (L127) — `"conversation/forkWithSummary"` kommt
  daneben.

### Datenfluss

```
[GUI] ResponseActions (Fork-Button, index i)
  → useForkWithSummary(i): setCompactionLoading(i,true)
  → ideMessenger.request("conversation/forkWithSummary", {index: i, sessionId})
      [Core] load(alte Session, read-only!)
        → generateConversationSummary(session, i, currentModel)  (extrahiert)
        → neue Session { neueId, title(+Suffix), workspaceDirectory,
                         mode/chatModelTitle übernommen,
                         history: [syntheticItem] }
        → historyManager.save(neue Session)   // alte nie schreiben
      ← { newSessionId }
  → dispatch(loadSession({sessionId: newSessionId, saveCurrentSession: false}))
  → finally setCompactionLoading(i,false)

syntheticItem = {
  message: { role: "assistant", content: "" },
  contextItems: [],
  conversationSummary: <Summary>,
  continuedFromSessionId: <alte sessionId>,
  forkedFromIndex: i,
}
```

## Solution

### Decisions (getroffen)

1. **Neue Session = genau ein synthetisches Item.** Kein Deep-Copy von
   Tail-Items (`toolCallStates`/`contextItems`/`editorState`/`promptLogs`),
   keine Duplikation, keine ID-Fragen. KISS.
2. **Verkettung auf dem Item, nicht auf der Session.**
   `ChatHistoryItem` erhält `continuedFromSessionId?: string` und
   `forkedFromIndex?: number`. Grund: Persistenz-Falle (s. Analysis) —
   Item-Felder überleben `HistoryManager.save()` und
   `saveCurrentSession` ohne deren Änderung; der GUI-State
   (`session.history`) hält sie ebenfalls ohne Slice-Änderung.
3. **Titel:** `old.title === NEW_SESSION_TITLE ? NEW_SESSION_TITLE :
old.title + " (continued)"` (englisch, GUI-Sprache).
4. **Metadaten-Übernahme:** `workspaceDirectory` (Pflicht — sonst fehlt
   die neue Session im workspace-gefilterten Verlauf), `mode` und
   `chatModelTitle` (wenn vorhanden) von der alten Session kopieren.
5. **Alte Session strikt read-only.** Kein Marker, kein Re-Save. Die
   Summary wird nur in-memory erzeugt und ausschließlich in der neuen
   Session persistiert.
6. **Fehler propagieren, nicht schlucken.** Der Core-Handler lässt
   Exceptions an den Messenger durchlaufen (`status: "error"`); der
   GUI-Hook zeigt einen Toast und legt keine/halbe Sessions an — die
   neue Session wird erst nach erfolgreicher Summary-Generierung
   gespeichert (atomar: ein Save).
7. **Per-Message-Button** in `ResponseActions` (neben Compact/Delete),
   nicht global. `index = letzte Message` ist der abgedeckte Hauptfall.
8. **Guards:** Streaming ist UI-seitig bereits abgedeckt (StepContainer
   deaktiviert die Leiste per `pointer-events-none`), der Hook prüft
   zusätzlich `state.session.isStreaming`. Core validiert
   `history.length > 0`, `0 <= index < history.length` und wirft, wenn
   der effektive Summarize-Input leer ist (keine nicht-leere Message in
   `filteredHistory`) — schützt vor degenerierten Forks. GUI blendet den
   Fork-Button an Items mit `continuedFromSessionId` aus (Re-Fork erst
   wieder sinnvoll, wenn neue Messages nach dem Fork-Item existieren —
   die tragen den Button dann an ihrem eigenen Index).

### Interfaces

```ts
// core/index.d.ts — ChatHistoryItem (additiv)
export interface ChatHistoryItem {
  // ... bestehend ...
  conversationSummary?: string;
  /** conversation-fork-with-summary.md: Vorgänger-Session, aus der dieses
      Item geforkt wurde (nur auf synthetischem Fork-Item) */
  continuedFromSessionId?: string;
  /** conversation-fork-with-summary.md: History-Index im Vorgänger, bis zu
      dem (inkl.) die Summary reicht */
  forkedFromIndex?: number;
}

// core/protocol/core.ts — ToCoreProtocol (additiv)
"conversation/forkWithSummary": [
  { index: number; sessionId: string },
  { newSessionId: string },
];
```

```ts
// core/util/conversationCompaction.ts — extrahiert, Signatur
export async function generateConversationSummary(
  session: Session,
  index: number,
  currentModel: ILLM,
): Promise<string>; // inkl. Re-Compaction-Logik, Tool-Cancelled-Ergänzung,
// 6-Punkte-Prompt, stripImages

// core/util/conversationFork.ts — neu
export async function forkSessionWithSummary(params: {
  sessionId: string;
  index: number;
  historyManager: HistoryManager;
  currentModel: ILLM;
}): Promise<string>; // newSessionId; wirft bei Validierung/LLM-Fehlern
```

`compactConversation` (bestehend) ruft nach dem Refactoring intern
`generateConversationSummary` — Verhalten unverändert.

### GUI

- **`useForkWithSummary()`** in `gui/src/util/compactConversation.ts`:
  Loading-State (`setCompactionLoading` wiederverwenden — die alte
  Session zeigt während der Generierung das bekannte „Generating
  conversation summary…"-Panel am Item), Request, bei `status==="error"`
  `ideMessenger.post("showToast", ["error", …])` + Abbruch, bei Erfolg
  `dispatch(loadSession({ sessionId: newSessionId, saveCurrentSession:
false }))`.
- **Button in `ResponseActions.tsx`** neben dem Compact-Button:
  Heroicon (Vorschlag `ArrowTopRightOnSquareIcon`), Tooltip „Start new
  conversation with summary up to here", `testId="fork-button-${index}"`,
  nicht rendern wenn `item.continuedFromSessionId` gesetzt (Decision 8);
  Streaming-Deaktivierung kommt vom StepContainer-Container (bestehend).
- **Vorgänger-Link in `ConversationSummary.tsx`:** wenn
  `item.continuedFromSessionId` gesetzt ist, Link „← Vorgänger" in der
  Panel-Headerzeile; `onClick` → `loadSession` auf die Vorgänger-ID
  (aktuelle Session vorher speichern, wie beim History-Panel-Wechsel).

## Implementation Checklist

- [x] `core/index.d.ts`: `ChatHistoryItem` um `continuedFromSessionId?` + `forkedFromIndex?` erweitern (JSDoc mit Spec-Dateiname).
- [x] `core/util/conversationCompaction.ts`:
      `generateConversationSummary` extrahieren; `compactConversation`
      darauf umstellen (Verhalten unverändert).
- [x] `core/util/conversationFork.ts` (neu): `forkSessionWithSummary`
      — Validierung (History nicht leer, Index in Range, effektiver
      Summarize-Input nicht leer — Decision 8), read-only Load,
      Summary generieren, neue Session anlegen (ID via `uuidv4()`,
      Repo-Konvention), Titel-Regel (Decision 3), Metadaten-Übernahme
      (Decision 4), synthetisches Item, ein `historyManager.save`, return
      `newSessionId`.
- [x] `core/protocol/core.ts`: `"conversation/forkWithSummary"` in
      `ToCoreProtocol`.
- [x] `core/core.ts`: Handler — Chat-Model laden (wie
      `conversation/compact`), `forkSessionWithSummary` aufrufen, Fehler
      **durchreichen** (Decision 6).
- [x] `core/protocol/passThrough.ts`: Eintrag +
      `extensions/intellij/.../MessageTypes.kt` synchron ziehen.
- [x] `gui/src/util/compactConversation.ts`: `useForkWithSummary`-Hook.
- [x] `gui/src/components/StepContainer/ResponseActions.tsx`: Fork-Button
      (nicht rendern bei `item.continuedFromSessionId`, Decision 8).
- [x] `gui/src/components/StepContainer/ConversationSummary.tsx`:
      Vorgänger-Link.
- [x] Build grün (`npm run build` betroffener Pakete); Spec-Status →
      Implementiert, Checklist abhaken.
