# Rescue Interrupted Reasoning

**Status:** Implementiert
**Date:** 2026-08-07

## Problem / Motivation

Streams reissen regelmäßig mitten im Reasoning-Block ab — teils überlastete
Provider-APIs, vor allem aber die Palo Alto im Firmennetz, die lang laufende
Streams killt. Der Effekt:

1. Das GUI zeigt den Reasoning-Block bis zum Abbruchpunkt an.
2. Der nächste Run ("go on") schickt das partielle Reasoning **nicht** mit —
   die Reasoning-Daten erreichen das LLM nicht mehr.
3. Der User behilft sich heute damit, das Reasoning manuell per Copy/Paste in
   die nächste User-Message zu kleben.

Besonders ärgerlich ist Fall 2 beim **manuellen Stop**: Der User sieht dem
Reasoning zu, erkennt dass sich das Modell verrennt, bricht ab und korrigiert
— aber das Modell "sieht" sein eigenes vorheriges Reasoning nicht und
versteht die Korrektur nicht.

Gewünschtes Verhalten: Partiell angekommenes Reasoning wird bei Stream-Abbruch
(Fehler **und** manueller Stop) in der History gerettet und beim nächsten Run
als Assistant-Turn an das LLM mitgeschickt — inkl. eines expliziten Hinweises,
dass die Antwort unterbrochen wurde.

## Scope

- `gui/src/redux/slices/sessionSlice.ts` — neuer Reducer
  `rescueInterruptedReasoning` + Marker-Konstante.
- `gui/src/redux/thunks/cancelStream.ts` — Rescue-Dispatch, Skip-Option,
  Session-Save nach Rescue.
- `gui/src/redux/thunks/streamThunkWrapper.tsx` — Skip-Flag an den beiden
  Retry-Call-Sites.
- `gui/src/hooks/ParallelListeners.tsx` — Skip-Flag an der ON-LOAD-Call-Site
  (kein Legacy-Rescue beim Boot).

**Out of Scope:**

- Der Overloaded-Retry-Pfad (529/"overloaded", 3 Retries in
  `streamThunkWrapper`) bleibt unverändert — dort **kein** Rescue (der Retry
  ersetzt den Versuch; ein Rescue-Turn würde duplizieren). Explizite
  User-Entscheidung.
- Natives Resenden von partiellem Reasoning über Provider-Felder
  (`reasoning_content`, `reasoning_details`, Anthropic-Thinking-Blöcke,
  Responses-`reasoning`-Items) — provider-seitig nicht valide machbar,
  siehe Analysis.
- Zweite Reasoning-Segmente **nach** einem Assistant mit bereits vorhandenem
  Content (trailing Thinking hinter validem Assistant) — heute verworfen,
  bleibt so.
- Nachträgliches Retten bereits gespeicherter Alt-Sessions mit dangling
  Thinking-Items (kein Migrations-/Load-Pfad).
- Core-Änderungen, Provider-Adapter, `clearDanglingMessages` selbst.

## Analysis

### Kill-Chain heute

History-Zustand bei Abbruch mitten im Reasoning:

```
Path A (thinking-Role-Items, z.B. Anthropic/OpenAI Responses):
  [ ..., user, assistant(content: ""), thinking(content: partial) ]
  (submitEditorAndInitAtIndex legt user + leeres assistant-Item an;
   streamUpdate pusht thinking-Items dahinter)

Path B (DeepSeek-Style <think>-Tags):
  [ ..., user, assistant(content: "", reasoning: { text: partial, active: true }) ]
```

1. **Abbruch:** Fehler → `streamThunkWrapper.tsx` catch → `cancelStream`;
   manueller Stop (Toolbar/Listener) → `cancelStream` direkt.
2. **`clearDanglingMessages`** (sessionSlice.ts) behält das thinking-Item
   (seine Schleife prüft `message.content` ohne Role-Check und behandelt es
   als "valid assistant") → GUI zeigt Reasoning bis Abbruchpunkt. Das leere
   assistant-Item bleibt ebenfalls stehen.
3. **Nächster Run:** `constructMessages.ts` wirft das leere assistant-Item
   über `chatMessageIsEmpty` (core/llm/messages.ts) weg; das thinking-Item
   gelangt noch in die Message-Liste. Bei Path B ist es schlimmer: dort wird
   das assistant-Item samt `item.reasoning` verworfen — das Feld wird
   outbound nirgends gelesen.
4. **Core-Outbound:** `openaiTypeConverters.ts` gibt für `role: "thinking"`
   `null` zurück. Reasoning wird ausschließlich via `findCorrespondingThinking`
   - `appendReasoningFieldsIfSupported` in die **direkt folgende**
     assistant-Message gemerged. Die existiert nicht mehr → Reasoning wird
     gedroppt.

Nebeneffekte heute: `endActiveReasoning` wird nur bei normalem Stream-Ende
dispatcht (`streamNormalInput.ts`); im Fehlerpfad wird die Session nicht
gespeichert (`streamThunkWrapper` saved nur im Erfolgsfall) → nach
Window-Reload ist auch die GUI-Anzeige weg.

### Warum natives Resenden keine Option ist

Der naheliegende Fix — leeres Assistant-Item durch Platzhalter ersetzen und
das thinking-Item über den bestehenden Merge-Mechanismus mitschicken —
scheitert an den Providern:

- **Anthropic** verlangt gültige Signaturen auf zurückgeschickten
  Thinking-Blöcken; partielle Blöcke haben keine → API-Fehler. Ein Claude-
  Guard in `appendReasoningFieldsIfSupported` omitting Reasoning ohne
  Signatur bereits.
- **Responses-API** braucht `id` + `encrypted_content` pro Reasoning-Item —
  partiell nicht vorhanden.
- **Kimi/DeepSeek** erwarten `reasoning_content` nur für **komplette** Turns
  (siehe kimi-k3-preserved-thinking-issue.md).

Der manuelle Workaround des Users funktioniert gerade deshalb, weil er
Plain-Text ist. Die Lösung automatisiert exakt diesen Workaround — als
Assistant-Turn, providerunabhängig, ohne Core-/Adapter-Änderungen.

## Solution

**Kernidee:** Bei jeder Stream-Beendigung außer Overloaded-Retry wird vor
`clearDanglingMessages` geprüft, ob nach der letzten User-/Tool-Message
Reasoning ohne zugehörigen Assistant-Content hängt. Wenn ja, wird es in den
Assistant-Turn **als Plain-Text-Content** konsolidiert — mit explizitem
Unterbrechungs-Hinweis (User-Entscheidung). Damit ist der Turn nicht mehr
"empty", überlebt `constructMessages` und geht beim nächsten Run regulär als
Assistant-Message an das LLM.

### Neuer Reducer `rescueInterruptedReasoning` (sessionSlice.ts)

Algorithmus:

1. `history.length < 2` → no-op (analog `clearDanglingMessages`).
2. Letztes User-/Tool-Item suchen; dahinter prüfen:
   - Gibt es bereits einen Assistant mit Content oder (generierten)
     ToolCalls → no-op (nichts zu retten).
   - Hat ein Assistant-Item dort `toolCallStates`/`message.toolCalls`
     (auch "generating") → no-op (Tool-Flüsse nicht anfassen; der
     "premature close"-Pfad in `streamNormalInput` ist zuständig).
3. Rescubares Reasoning sammeln:
   - Path A: Text aller thinking-Items nach dem letzten User/Tool, in
     chronologischer Reihenfolge (Items mit `redactedThinking` werden
     übersprungen — ihr Content ist nur Boilerplate).
   - Path B: `item.reasoning.text` eines trailing Assistant-Items mit leerem
     Content.
   - Nichts gefunden → kein Marker (z.B. Stop vor dem ersten Token; das
     heutige Input-Restore-Verhalten bleibt so unverändert), aber die
     thinking-Items des Turns werden trotzdem entfernt (Follow-up
     2026-08-15, CodeRabbit-Review): Cleanup ist von der Rescue-Entscheidung
     getrennt, damit redacted Items samt ihrer nativen Reasoning-Metadaten
     nicht in native Resend-Pfade leaken können.
4. Konsolidieren in das (von `submitEditorAndInitAtIndex` angelegte) leere
   Assistant-Item nach dem letzten User/Tool:
   - `message.content` = Marker-Konstante mit Reasoning-Text (Format unten).
   - `item.reasoning` entfernen: Der Reasoning-Text lebt jetzt im
     Message-Content; ein verbleibendes (auch nur geschlossenes) Feld würde
     denselben Text im GUI doppelt rendern — ThinkingBlockPeek zusätzlich
     zum Content.
   - Sämtliche thinking-Items des Turns aus der History entfernen — auch
     redacted, deren Boilerplate nicht gesammelt wurde: stehengelassen würde
     sie über `findCorrespondingThinking` in native Reasoning-Felder leaken.
     Mit den Items verschwinden auch deren native Reasoning-Metadaten
     (`signature`, `reasoning_details`, `redactedThinking`) — nichts davon
     darf in native Resend-Pfade gelangen. Die Entfernung läuft in beiden
     Pfaden — auch wenn kein rescubarer Text gefunden wurde (dann ohne
     Marker, s. Schritt 3).

Anzeige: Das gerettete Reasoning rendert als normaler Assistant-Markdown
(einmalig, kein zusätzlicher ThinkingBlockPeek — keine Doppelanzeige).

Marker-Format (Konstante in sessionSlice.ts, Wortlaut kann bei der
Implementierung noch leicht angepasst werden — die Form ist verbindlich):

```
[Response interrupted mid-stream and left incomplete. My reasoning up to the point of interruption:]

<reasoning text>

[End of the interrupted response. Continue from here or adjust course as instructed.]
```

### Wiring in `cancelStream.ts`

`cancelStream` erhält einen optionalen Payload `{ skipReasoningRescue?: boolean }`:

- Ohne Skip-Flag (Default): wie bisher `setInactive`, `abortStream`, dann
  `rescueInterruptedReasoning` vor `clearDanglingMessages`. Durch das Rescue
  findet `clearDanglingMessages` danach einen validen Assistant mit Content
  und behält den Turn komplett.
- **Session-Save nach Rescue:** Der Thunk vergleicht die
  `state.session.history`-Referenz vor/nach dem Rescue-Dispatch
  (Immer verändert die Referenz nur bei tatsächlicher Änderung). Hat das
  Rescue etwas geändert → `saveCurrentSession({ openNewSession: false,
generateTitle: true })` dispatchen, damit der gerettete Stand einen
  Window-Reload überlebt. Ohne Rescue kein zusätzlicher Save (Verhalten
  unverändert).

### Call-Sites

| Call-Site                                                                                                                                                                         | Verhalten                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `streamThunkWrapper.tsx` catch, terminal                                                                                                                                          | Rescue aktiv (unverändert `cancelStream()`)                                                                |
| `streamThunkWrapper.tsx` Retry-Zweig (2×)                                                                                                                                         | `cancelStream({ skipReasoningRescue: true })`                                                              |
| `ParallelListeners.tsx` ON LOAD (Webview-Init)                                                                                                                                    | `cancelStream({ skipReasoningRescue: true })` — kein Legacy-Rescue beim Boot, Init-Pfad bleibt unverändert |
| Toolbar-Stop (`LumpToolbar.tsx`, 2×), `ParallelListeners.tsx` "setInactive"-Listener (IDE-getriggert), `Chat.tsx` (Cmd+Backspace, "delete current step"), `IsApplyingToolbar.tsx` | Rescue aktiv (unverändert `cancelStream()`)                                                                |

Edit-Modus: `IsApplyingToolbar` dispatched ebenfalls `cancelStream`;
Edit-Streams erzeugen keine thinking-Items in der Chat-History → der Reducer
ist dort ein No-op. Keine Sonderbehandlung nötig.

### Ergebnis-Verhalten

| Szenario                                 | Vorher                                                       | Nachher                                                             |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| Fehler mitten im Reasoning               | Reasoning nur im GUI sichtbar, beim nächsten Run verloren    | Als Assistant-Turn mit Marker gerettet, persisted, wird mitgesendet |
| Manueller Stop mitten im Reasoning       | dito                                                         | dito (User-Entscheidung)                                            |
| Stop/Fehler vor dem ersten Token         | Input wird in den Editor restored                            | Unverändert (Rescue no-op)                                          |
| Abbruch mit nur redacted/leerem Thinking | Boilerplate blieb in der History, konnte nativ leaken        | Items entfernt, kein Marker (Follow-up 2026-08-15)                  |
| Overloaded-Retry                         | `cancelStream`, Retry                                        | Unverändert                                                         |
| Abbruch nach bereits vorhandenem Content | Turn bleibt, Reasoning-Merge via `findCorrespondingThinking` | Unverändert                                                         |

## Implementation Checklist

- [x] `gui/src/redux/slices/sessionSlice.ts`: Marker-Konstante + Reducer
      `rescueInterruptedReasoning` gemäß Solution (inkl. Guards für
      ToolCall-Flüsse und No-op-Fälle); Export in der Actions-Liste.
- [x] `gui/src/redux/thunks/cancelStream.ts`: Payload-Typ um
      `{ skipReasoningRescue?: boolean }` erweitern; ohne Skip-Flag
      `rescueInterruptedReasoning` vor `clearDanglingMessages` dispatchen;
      Session-Save (`saveCurrentSession`) bei tatsächlicher Rescue-Änderung
      (Immer-Referenzvergleich).
- [x] `gui/src/redux/thunks/streamThunkWrapper.tsx`: An den beiden
      Call-Sites im Retry-Zweig `{ skipReasoningRescue: true }` übergeben.
- [x] `gui/src/hooks/ParallelListeners.tsx`: An der ON-LOAD-Call-Site
      `{ skipReasoningRescue: true }` übergeben.
- [x] `gui/src/redux/slices/sessionSlice.ts` (Follow-up 2026-08-15,
      CodeRabbit-Review): Thinking-Cleanup von der Rescue-Entscheidung
      getrennt — trailing thinking-Items (redacted/leer) werden auch ohne
      rescubaren Text entfernt, ohne dass ein Marker entsteht; Tests in
      `sessionSlice.test.ts` entsprechend aktualisiert/ergänzt.
- [x] Build-Verifikation des GUI-Pakets (`tsc`/`npm run build` in `gui/`).
