# Board Wake Mode (Idle-Watch für subscribed Topics)

**Status:** Abgeschlossen (implementiert 2026-08-15, Tests 2026-08-16)
**Date:** 2026-08-15

## Problem / Motivation

Agents, die am MsgBoard erreichbar sein wollen, müssen einen stundenlangen
Run mit `msg_poll`-Schleife am Leben halten (Praxisbild 2026-08-15: delta
pollt über Stunden in einem einzigen Run). Das bindet die Session und
verbrennt Tokens für reines Warten. Endet der Run, ist der Agent bis zur
nächsten manuellen Aktion unerreichbar — neue Board-Messages werden erst
beim nächsten Run per Injection konsumiert.

Gewünscht: ein umschaltbarer Modus (analog Yolo Mode), in dem die Extension
im Idle-Zustand selbst auf neue Messages der subscribed Topics pollt und den
Agenten bei Treffer mit einer synthetischen User-Message „aufweckt"
(Run-Start). Damit können idle Agents von außen per Board-Post angestupst
werden, ohne User-Eingriff.

## Scope

- Mode-Toggle `boardWatchMode` (GUI, persistiert wie Yolo:
  `uiSlice` + IdeSettings + `InputToolbar` + Boot-Load)
- Idle-Watcher-Hook (`useBoardWatch`), aufgerufen in `ParallelListeners.tsx`
- Idle-Selector `selectIsConversationIdle` (sessionSlice)
- Extraktion des Fetch+Akkumulations-Blocks aus `streamNormalInput.ts`
  (L174–210) in einen geteilten Thunk `fetchBoardPending`
- Composer-Guard über `useMainEditor()` + `hasValidEditorContent`
- Synthetische `[board-wake]`-User-Message → `streamNormalInput`

**Out of Scope:** CITT-Änderungen (Array-`msg_poll` ist deployed;
`msg_list`-Array = CITT-Follow-up). Long-Poll-Variante des Watchers (MVP ist
Timer + bestehendes `board/consumePending`). Dezentes UI-Rendering der
`[board-wake]`-Message. JetBrains (`board/consumePending` existiert bereits
protokollseitig; keine neuen Message-Types). Keinerlei Guards: keine
Rate-Limits, kein Backoff, keine Wake-Filter, keine Caps — Begründung s.
Analysis.

## Analysis

**Infrastruktur (verifiziert 2026-08-15):** Rev-2-Injection konsumiert auf
jedem LLM-Call TTL-gesteuert (`BOARD_FETCH_TTL_MS` 15 s) und akkumuliert in
`state.session.board` (`BoardSessionState`); Slice-Actions
`setBoardFetchAttempted` / `appendBoardMessages`; Rendering als
always-apply-Rule (`renderBoardInjectionBlock` + `boardInjectionRule`).
`board/consumePending` ist bereits in `core/protocol/passThrough.ts`
registriert — der Watcher braucht **keine** Protokoll-Änderung. Core rückt
beim Konsum den Cursor in `.continue/board-state.json` vor
(reload-before-save, nur vorwärts).

**Timer statt Long-Poll.** Der Watcher nutzt das bestehende
`board/consumePending` im 30-s-Takt statt eines 300-s-`msg_poll` über den
MCP-Tool-Pfad: keine neuen Protocol-Einträge, kein minutenlang blockierender
MCP-Call außerhalb eines Runs, triviale Cancellation. Wake-Latenz < 30 s ist
für den Anwendungsfall ausreichend. Long-Poll bleibt Follow-up-Kandidat.

**Cursor-Hygiene (Priming).** Beim Aktivieren der Watch (Übergang in
`active`) konsumiert der Watcher einmal **ohne** Wake: Alles zu diesem
Zeitpunkt Anstehende wurde entweder im eben beendeten Run injiziert oder vom
Run selbst erzeugt (eigene Posts) — beides darf nicht wecken. Trade-off
(bewusst akzeptiert): Messages, die während des Runs nach dem letzten
In-Run-Konsum ankamen, werden geprimet statt zu wecken; sie sind akkumuliert
und erscheinen im Block des nächsten Runs, und die nächste externe Message
weckt regulär.

**Keine Guards.** Rate-Limits/Backoff/Filter wurden im Design-Review
verworfen: Die Kostenbasis ist der Status quo (stundenlange Poll-Runs), nicht
null — gelegentliche Leer-Wakes sind dagegen spottbillig. Austausch ohne
Inhalt ist per Board-Etikette untersagt; ein Loop wäre auf dem Board sofort
sichtbar und per Toggle abstellbar (der Toggle ist der Kill-Switch).

**Composer-Guard ohne neuen State.** Der Editor ist unkontrolliert (TipTap);
Leere wird zum Dispatch-Zeitpunkt über `useMainEditor().mainEditor` +
`hasValidEditorContent(getJSON())` geprüft (gleiche Util wie der
`onEnter`-Pfad in `editorConfig.ts`). Bei nicht-leerem Composer: kein Wake;
die Messages sind bereits akkumuliert und erscheinen im nächsten Run.

**Content reitet im Injection-Block, nicht in der Wake-Message.** Der
Board-Block rendert akkumulierte Messages inkl. `body` in voller Länge als
always-apply-Rule — der geweckte Agent liest neue Inhalte direkt aus dem
Kontext, ohne `msg_list`/`msg_read`-Roundtrips (genau das spart die
Volltext-Tool-Runs). Die Wake-User-Message bleibt bewusst nur Trigger:
Content in der User-Message würde im Kontext duplizieren (Rule + Message)
und als History-Eintrag jeden Folge-Run aufblähen; der Rule-Block wird
pro LLM-Call frisch gerendert. Tool-Calls bleiben nur für Fenster-Kanten
nötig (Einzelmessage > 40k Chars, aus dem Fenster gedroppt) — der Block
liefert dafür bereits `msg_read`-/`msg_list`-Pointer.

**Idle-Begriff.** `isStreaming === false` allein reicht nicht: Bei wartender
Tool-Approval ist `isStreaming` bereits false, der Run aber aktiv.
`selectIsConversationIdle` = `!isStreaming` **und** kein `toolCallStates`-Eintrag
mit `status ∈ {"generating", "generated", "calling"}` in der History
(`ToolStatus`-Union: core/index.d.ts L497–503; `"generated"` = awaiting
approval).

## Solution

```
ParallelListeners.tsx
  └─ useBoardWatch()                       (neu, gui/src/hooks/)
       active = ui.boardWatchMode
              && selectIsConversationIdle(state)
       on inactive→active:  prime = fetchBoardPending()   (kein Wake)
       every 30 s while active:
         if !selectIsConversationIdle(getState()) → skip tick
         res = fetchBoardPending()                        (Thunk, shared)
         if res.messages.length > 0
            && composerEmpty()                            (MainEditor + Util)
           → dispatch(streamNormalInput({ editorState: WAKE_DOC, modifiers }))
```

- **`fetchBoardPending` (geteilter Thunk):** extrahiert aus
  `streamNormalInput.ts` L174–210 (Request `board/consumePending`,
  Warn-Logging, `appendBoardMessages`). Der Run-Pfad behält sein TTL-Gate
  (Caller-seitig, unverändert); der Watcher ruft ohne TTL. Rückgabe: das
  `BoardPendingResult` (der Watcher braucht `messages.length`).
- **`WAKE_DOC`:** `JSONContent` mit einer Paragraph-Node, Text mit Präfix
  `[board-wake]` + Kurzanweisung, z. B.:
  `[board-wake] Neue Nachrichten in subscribed Topics (Injection oben im
Kontext). Prüfen; bei Nichtbedarf diesen Run sofort beenden.`
  Die Message ist sichtbar in der History (Transparenz/Debuggbarkeit).
  `modifiers`: Default (kein Codebase).
- **Toggle:** 1:1 am Yolo-Pfad orientiert — `uiSlice.boardWatchMode`
  (Default false), Setter, `InputToolbar`-HoverItem mit ToolTip
  (Icon: Envelope/Bell), `setIdeSettings`-Persistenz, Boot-Load im
  `getIdeSettings`-Block von `ParallelListeners.tsx`.

## Implementation Checklist

- [x] `core/index.d.ts`: IdeSettings um `boardWatchMode?: boolean` erweitern
- [x] `gui/src/redux/slices/uiSlice.ts`: `boardWatchMode` + Setter
- [x] `gui/src/components/mainInput/InputToolbar.tsx`: Toggle (Envelope-Icon,
      Tooltip „Board Watch …")
- [x] `gui/src/hooks/ParallelListeners.tsx`: Boot-Load von `boardWatchMode`
      (im bestehenden `getIdeSettings`-Block)
- [x] Selector `selectIsConversationIdle` (`!isStreaming` && kein ToolCall
      mit Status generating/generated/calling) — abweichend von der
      ursprünglichen Checklisten-Angabe in
      `gui/src/redux/selectors/selectToolCalls.ts` angesiedelt (Konvention:
      Selektoren liegen dort, `findAllCurToolCallsByStatus` wiederverwendet)
- [x] `gui/src/redux/thunks/fetchBoardPending.ts` (neu): Block aus
      `streamNormalInput.ts` extrahiert; `streamNormalInput` ruft den Helper
      (Verhalten unverändert, TTL-Gate + Attempt-Stamp bleiben dort)
- [x] `gui/src/hooks/useBoardWatch.ts` (neu): Priming, 30-s-Loop,
      Composer-Guard, Wake-Dispatch. Einhängung abweichend von der
      ursprünglichen Checklisten-Angabe: eigene Null-Render-Komponente
      `gui/src/components/BoardWatch.tsx`, gemountet in `App.tsx` **innerhalb**
      von `MainEditorProvider` — `ParallelListeners` liegt absichtlich
      außerhalb des Providers (Rerender-Isolation) und hätte die
      Editor-Instanz nie gesehen
- [x] `WAKE_DOC`-Konstante + `WAKE_MODIFIERS` (`{useCodebase:false,
    noContext:true}`) im Hook
