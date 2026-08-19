# Rescue Reasoning bei regulärem Stream-Ende (Token-Limit)

**Status:** Implementiert
**Date:** 2026-08-19

## Problem / Motivation

`rescue-interrupted-reasoning.md` (implementiert 2026-08-07) rettet partielles
Reasoning nur auf den **Abbruch-Pfaden** (`cancelStream`: manueller Stop,
terminale Fehler, Cmd+Backspace, setInactive-Listener).

Der dritte Unterbrechungs-Fall ist ungedeckt: **Der Provider beendet den
Stream regulär mit `finish_reason: "length"`** (maxOutputTokens zu niedrig —
das Reasoning frisst das gesamte Budget, bevor sichtbarer Text entsteht).
Für die GUI ist das ein _normaler_ Stream-Abschluss: kein Fehler, kein
`cancelStream`, keine Rescue. Die Session wird „erfolgreich" persistiert als:

```
[ ..., user, assistant(content: ""), thinking(content: partial) ]
```

Beim nächsten Run greift exakt die Kill-Chain aus
`rescue-interrupted-reasoning.md`: `constructMessages` verwirft das leere
Assistant-Item (`chatMessageIsEmpty`), das verbliebene standalone
thinking-Item liefert outbound `null` (`openaiTypeConverters`) → **das
Reasoning erreicht das LLM nicht**. Der User muss weiterhin manuell
Copy/Paste machen — genau der Zustand, den die ursprüngliche Spec abschaffen
sollte.

## Scope

- `gui/src/redux/thunks/streamNormalInput.ts` — ein zusätzlicher
  `rescueInterruptedReasoning`-Dispatch am regulären Stream-Ende.
- Kein Reducer-Change: der bestehende Reducer
  (`gui/src/redux/slices/sessionSlice.ts`) wird unverändert wiederverwendet;
  seine No-op-Garantien decken alle Nicht-Ziel-Fälle bereits ab.

**Out of Scope:**

- `finish_reason`-Propagation aus Core in die GUI (nicht nötig — siehe
  Analysis; die Rescue ist bewusst generisch).
- Turns mit bereits vorhandenem Assistant-**Content** plus unvollständigem
  Reasoning (Reasoning hinter validem Assistant bleibt verworfen — dieselbe
  Grenze wie in `rescue-interrupted-reasoning.md`).
- Natives Resenden partiellem Reasonings (Signaturen/IDs — weiterhin nicht
  valide machbar, siehe Vorgänger-Spec).
- Turns mit Tool-Calls (Reducer no-op; Tool-Flows sind zuständig).
- Core-, Adapter- oder `constructMessages`-Änderungen.

## Analysis

### Warum generisch statt length-spezifisch

Die GUI kennt den `finish_reason` nicht: `fromChatCompletionChunk`
(`core/llm/openaiTypeConverters.ts`) übernimmt `usage`, aber kein
`finishReason`-Feld in `ChatMessage`; am Ende von `streamNormalInput` ist
nicht erkennbar, ob der Provider mit `stop` oder `length` geschlossen hat.

Das ist kein Nachteil: Die Zielbedingung „Turn endete ohne sichtbaren
Content, aber mit Reasoning" ist provider- und grund-unabhängig. Sie trifft
den `length`-Hauptfall, deckt aber auch den seltenen Fall „sauberer `stop`
mit Reasoning-only" mit ab — auch dort ist der Turn aus User-Sicht leer und
das Reasoning soll erhalten bleiben.

### Einordnung der Rescue am regulären Ende

- **Idempotenz/Doppel-Rescue:** Beim manuellen Stop läuft die Rescue bereits
  über `cancelStream`. Läuft sie danach noch einmal am regulären
  Schleifen-Ende, ist sie no-op — der Assistant hat dann bereits
  Marker-Content (`item.message.content` truthy). Umgekehrt ebenso.
- **Tool-Call-Turns:** Der Reducer ist no-op, sobald im Tail
  `toolCallStates`/`message.toolCalls` existieren — der Agent-Loop
  (Tools danach) ist unberührt. Umgekehrt greift die Rescue korrekt, wenn
  der **Follow-up-Stream nach einem Tool-Call** (Rekursion über
  `streamResponseAfterToolCall` → `streamNormalInput`) mit nur Reasoning
  endet: Tail nach der letzten tool-Message = `[assistant(""), thinking]`.
- **Persistenz gratis:** Anders als in `cancelStream` ist kein expliziter
  Save nötig — `streamThunkWrapper` saved im Erfolgszweig ohnehin
  (`saveCurrentSession`), und das _nach_ `streamNormalInput`, also inkl.
  gerettetem Stand.
- **Anzeige:** Der Marker-Text rendert als normaler Assistant-Markdown —
  konsistent mit dem Abbruch-Rescue, keine Doppelanzeige (Reducer entfernt
  `item.reasoning` und die thinking-Items).
- **Marker-Wortlaut:** Der bestehende Wortlaut („Response interrupted
  mid-stream and left incomplete …") bleibt unverändert — er ist auch für
  `length` faktisch korrekt, und die GUI kann die Ursache ohnehin nicht
  unterscheiden.

## Solution

Ein zusätzlicher Dispatch in `streamNormalInput.ts`, platziert **hinter** dem
Stale-Turn-Guard am Anfang der Tool-Call-Sequenz (CodeRabbit-Review
2026-08-19): der Guard wird um die Controller-Identität
(`state1.session.streamAborter !== streamAborter`) erweitert, damit ein
abgebrochener, in `await gen.next()` hängender Thunk nicht in die History
eines bereits ersetzten neuen Turns rescuen kann (`abortStream`/`newSession`
ersetzen den Controller):

```ts
const state1 = getState();
if (
  streamAborter.signal.aborted ||
  state1.session.streamAborter !== streamAborter ||
  !state1.session.isStreaming
) {
  return;
}

// Rescue partial reasoning when a turn ends regularly but produced no
// visible content (e.g. provider hit the token limit mid-reasoning) —
// same kill-chain as on abort paths, see rescue-reasoning-stream-end.md.
// No-op whenever the turn produced content or tool calls. Placed behind
// the staleness guard so a replaced (aborted) thunk cannot rescue into a
// newer turn's history.
dispatch(rescueInterruptedReasoning());
```

Danach läuft alles unverändert: `setInactive()` im No-Tool-Zweig,
Tool-Call-Sequenz sonst, Session-Save durch `streamThunkWrapper`.

Fehlerpfad unverändert: Exceptions vor diesem Punkt (Stream-Fehler) werfen
weiter in den `streamThunkWrapper`-Catch → dort `cancelStream()` → Rescue
läuft auf dem bekannten Abbruch-Pfad.

## Implementation Checklist

- [x] `gui/src/redux/thunks/streamNormalInput.ts`:
      `rescueInterruptedReasoning` aus `../slices/sessionSlice` importieren und
      an der beschriebenen Stelle dispatchen
- [x] Kommentar am Dispatch mit Doc-Referenz `rescue-reasoning-stream-end.md`
- [x] Stale-Turn-Guard-Erweiterung (CodeRabbit-Review 2026-08-19): Dispatch
      hinter den Guard verschieben, Guard um
      `state1.session.streamAborter !== streamAborter` erweitern
