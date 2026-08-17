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

## Amendment 2026-08-16: Empty-Conversation-Guard

**Anlass:** Live-Review mit dem User am Tag nach dem Rollout: In einer
frischen Conversation ohne User-Messages ist `selectIsConversationIdle`
trivial erfüllt — der erste Tick mit neuen Board-Messages hätte den
synthetischen `[board-wake]`-Run als **erste „User-Message" der
Conversation** gestartet und dem User den ersten Slot seines eigenen Themas
genommen.

**Regel (User-Vorgabe):** Die erste User-Message einer Conversation darf nie
ein Board-Wake sein.

**Umsetzung:** Neuer Selector `selectConversationHasUserMessage`
(`gui/src/redux/selectors/selectToolCalls.ts`, neben
`selectIsConversationIdle`): `history.some(item => item.message.role ===
"user")`. Im Wake-Dispatch-Pfad von `useBoardWatch` zweiter Recheck neben
dem Idle-Recheck — beide lesen `store.getState()` frisch unmittelbar vor dem
Dispatch. Der Watcher pollt und konsumiert in der leeren Phase weiter
(Priming-Semantik): Die Messages akkumulieren im Session-Puffer und
erscheinen im Injection-Block des ersten echten Runs; nichts geht verloren.

**Selbstkonsistenz:** Da der Guard vor dem ersten Dispatch blockiert, kann
ein synthetischer Wake nie der erste History-Eintrag werden — die Regel
erhält sich selbst.

**Tradeoff (bewusst akzeptiert):** Frische Conversation + User abwesend → in
diesem Fenster kein Wake, bis irgendeine Conversation mindestens eine
User-Message hat. VS Code stellt beim Neustart normalerweise die letzte
Session mit History wieder her, daher ist der Fall schmal. Wake-Mode macht
einen _etablierten_ Agenten erreichbar; er gründet keine Conversations gegen
den User-Willen.

**Abgrenzung zur „Keine Guards"-Entscheidung oben:** Jene betrifft
Rate-Limits/Backoff/Wake-Filter/Caps (Lärm-/Last-Policy). Dieser Guard ist
eine UX-Invariante (User-Souveränität über den Conversation-Start) und steht
nicht im Widerspruch dazu.

**Tests:** `selectToolCalls.test.ts` +4 (leer / User-only / User+Assistant /
Assistant-only), `useBoardWatch.test.tsx` +1 (leere Conversation: kein Wake,
aber Konsum in den Session-Puffer); das Setup der Hook-Tests seedet jetzt
per Default eine User-Message (Default-Fall „gestartete Conversation").
gui-Suite: 525 → 530 Tests.

## Amendment 2026-08-16 (II): Compaction-Gate

**Anlass:** Feature Request des Users nach beobachtetem Chaos: Während eine
Compaction läuft (inline `conversation/compact` oder „trim in eine neue
Conversation" = `conversation/forkWithSummary`) darf der Board-Watcher
weder konsumieren noch wecken.

**Befund (Evaluation):** Das Problem ist real, mit drei Mechanismen:

1. **Verlust der Session-Fenster-Inhalte (Hauptgrund):** Der Watcher
   konsumiert zuerst (Cursor im `board-state.json` wird sofort
   weitergeschoben). Beide Compaction-Modi beenden mit `loadSession`, das
   durch den `newSession`-Reducer geht — der setzt explizit
   `state.board = { ...EMPTY_BOARD_SESSION_STATE }`. Messages, die während
   der Compaction konsumiert wurden, sind danach dauerhaft aus dem
   Kontext-Fenster weg (Cursor schon vorgerückt, kein Re-Consume).
2. **Wake-Injektion überlebt den History-Umbau:** `insertMessageAtNextRunStart`
   wird vom `newSession`-Reducer nicht angefasst; ein während der Compaction
   gesetzter Wake landet im nächsten Run in der umgeschriebenen Conversation.
3. **Flag-Race in den Compaction-Hooks:** `dispatch(loadSession(...))` wurde
   in `useCompactConversation`/`useForkWithSummary` nicht awaited — das
   `finally` räumte das Loading-Flag ab, bevor der State-Swap durch war.

**Umsetzung:**

- Neuer Selector `selectIsCompactionRunning`
  (`gui/src/redux/selectors/selectToolCalls.ts`):
  `Object.values(state.session.compactionLoading).some(Boolean)` — dasselbe
  Redux-Flag, das auch der Compaction-Spinner nutzt; beide Compaction-Hooks
  setzen/räumen es per `setCompactionLoading` in try/finally, daher kein
  Stuck-Flag (auch nicht bei Fork-Mode: das Flag wird nach dem
  Session-Wechsel auf der neuen, leeren Session gelöscht).
- `useBoardWatch`: **ganzer Tick wird geskippt** (kein Consume, kein Wake),
  solange eine Compaction läuft — Gate am Tick-Anfang vor
  `fetchBoardPending` plus Recheck unmittelbar vor dem Wake-Dispatch (deckt
  den Fall „Compaction beginnt, während der Fetch in flight ist"; dort ist
  der Konsum bereits passiert, nur der Wake wird blockiert — akzeptiertes
  Restrisiko, dieselbe Klasse wie der bestehende „Run beginnt in
  flight"-Guard). Die Messages bleiben auf dem Board und werden im ersten
  Tick nach Abschluss abgeholt — kein Verlust, nur Delay.
- `compactConversation.ts`: beide `loadSession`-Dispatches werden jetzt
  awaited, damit das Loading-Flag exakt „fertig inkl. State-Swap" bedeutet.
  Nebeneffekt: der Spinner bleibt korrekt stehen, bis die UI den neuen
  Zustand zeigt.
- Priming (Mount/Toggle-on) bleibt bewusst ungegatet: es aktiviert nur,
  wenn der User den Toggle setzt — da läuft keine Compaction. Ein
  Webview-Reload mitten in einer Compaction verliert das Flag
  (in-memory) — derselbe Rand, an dem heute auch der Compaction-Spinner
  verloren geht.

**Interaktion mit Amendment I:** Nach Fork-Mode ist die neue Conversation
leer (keine User-Message) → zusätzlich greift der Empty-Conversation-Guard,
d. h. kein Wake in die frische Conversation bis zur ersten echten
User-Message. Konsistente Semantik.

**Abgrenzung zur „Keine Guards"-Entscheidung:** wie bei Amendment I —
dies ist Korrektheit (State-Konsistenz), keine Lärm-/Last-Policy.

**Tests:** `selectToolCalls.test.ts` +4 (leer / ein Index / mehrere Indizes /
cleared per delete), `useBoardWatch.test.tsx` +2 (Tick-Skip während
Compaction + Wake nach Abschluss; Compaction beginnt in flight → kein Wake,
aber Konsum). gui-Suite: 530 → 536 Tests.

## Amendment 2026-08-17: Summary zählt als „gestartet" (Ausnahme vom Empty-Conversation-Guard)

**Anlass:** Detail-Wunsch des Users nach Live-Erfahrung mit der
Self-Compaction: Nach einem Fork-mit-Summary (`conversation/forkWithSummary`,
auch der Run-Ende-Pfad von `compact_conversation`) ist die neue Conversation
aus Sicht des Empty-Conversation-Guards „frisch" — die History besteht aus
genau einem synthetischen Assistant-Item (`conversationSummary` +
`continuedFromSessionId`, keine User-Message). Der Watcher pollt und
konsumiert zwar weiter, dispatcht aber nie einen Wake. Damit ist ausgerechnet
die für den Langzeitbetrieb kompactierte Conversation taub fürs Board, bis
der User von Hand tippt.

**Bewertung:** Der Guard schützt die Invariante „die erste Nachricht einer
frischen Conversation gehört dem User". Eine Fork-Session ist aber keine
frische Conversation: sie trägt `continuedFromSessionId`, den Titel-Suffix
„(continued)" und die Summary des Vorgängers. „Es gibt eine Summary" ist das
korrekte Kriterium für „Fortsetzung" — die Ausnahme von der Ausnahme weicht
das Prinzip nicht auf, sie korrigiert nur einen zu groben Proxy
(`role === "user"`). Dies revidiert die Einschätzung aus Amendment II
(„Interaktion mit Amendment I … Konsistente Semantik"): das damalige
Verhalten war nicht konsistent, sondern ein faktischer Wake-Deadlock für
Langzeit-Sessions. Type-1-Compaction (inline, `conversation/compact`) war nie
betroffen — dort bleibt die History erhalten, User-Messages existieren
weiter.

**Umsetzung:** `selectConversationHasUserMessage` →
`selectConversationIsStarted` (Rename; einziger Konsument ist
`useBoardWatch`):
`history.some(item => item.message.role === "user") ||
history.some(item => Boolean(item.conversationSummary))`.
Ein leerer String zählt nicht als Summary. Frische Conversations (leere
History) bleiben geschützt; der Wake in eine Fork-Session ist unproblematisch,
weil die Summary beim Request-Aufbau in den Kontext geht und der geweckte Run
den Injection-Block sieht.

**Tests:** `selectToolCalls.test.ts` +2 (nur Fork-Summary-Item → true;
Summary als Leerstring → false), `useBoardWatch.test.tsx` +1 (Wake in die
Fork-Conversation; der bestehende Frisch-Conversation-Fall bleibt grün).
