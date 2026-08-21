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

## Amendment 2026-08-21: Deliver-before-consume (to-zenith Nachrichtenverlust-Incident)

**Anlass:** Incident 2026-08-20, entdeckt durch den User, forensisch
dokumentiert von zenith (to-delta-Nachricht 5362472562): deltas Nachricht
5362014552 (to-zenith, gepostet 21:33:19 UTC) wurde 21:34:03 UTC vom
zenith-Fork via `board/pending` abgeholt — der CITT-Cursor
(`WatcherTopics.ConsumedCommentId`) wurde dabei server-seitig fortgesetzt —
aber der zenith-Agent hat sie nie gesehen: Die Session war busy (DONE-Post
erst 21:35:52 UTC), unmittelbar danach lief eine Compaction, dann idle.
Kein Wake, keine sichtbare Injection, keine Re-Delivery möglich.

**Root Cause (strukturell):** `board/pending` IST der Consume — CITT setzt
den Cursor beim Fetch hoch. Fork-seitig lebt eine konsumierte Nachricht nur
im volatilen, **pro-Session** geführten Board-Buffer (Redux
`session.board`), bis sie erstmals in einen Injection-Block gerendert wird.
`newSession` setzt diesen Buffer **bedingungslos** zurück — bei jedem
Session-Wechsel, jeder frischen Session und jeder abschließenden Compaction
(`loadSession` läuft durch `newSession`). Jeder Consume, dessen Buffer-Eintrag
vor dem ersten Render zurückgesetzt wird, ist damit endgültig verloren:
Cursor fort, Buffer fort, kein Retry, keine Queue. Das bisherige Design
(„Watcher konsumiert auch bei blockiertem Wake; angesammelte Messages
rendern im nächsten Run") verließ sich darauf, dass dieser nächste Run vor
jedem Session-Reset kommt — die Compaction am Run-Ende widerlegt das.
Betroffen sind alle Agenten (gleicher Code), nicht nur zenith.

**Verlustpfade (vor dem Fix):**

1. Watcher-Tick konsumiert, Wake durch Guard blockiert (busy-Race,
   Composer, frische Conversation) → Buffer-Reset vor dem nächsten Run →
   Verlust. (Beobachteter Incident; Kandidat A.)
2. Run-Start-Pfad (`streamNormalInput`, TTL-gegatet auf jedem LLM-Call)
   konsumiert → Run abortet/fehlt vor dem Request → Verlust.
3. Session-Wechsel des Users mit ungerenderten Messages im Buffer →
   Verlust.

Für den konkreten Incident kommt zusätzlich Kandidat B in Betracht: Der
Consume 21:34:03 stammte vom Run-Start-Pfad des noch laufenden zenith-Runs
— dann war die Nachricht im System-Prompt genau dieses LLM-Calls
(der Block wird unmittelbar nach dem Fetch, vor dem Message-Aufbau
gerendert) und wurde nur durch die anschließende Compaction aus dem
sichtbaren Kontext entfernt. Diskriminierender Beleg: der CITT-Proxylog
zeniths LLM-Requests um 21:34 UTC (enthält der System-Prompt den
Nachrichtentext?).

**Änderung:** Deliver-before-consume — ein Watcher-Tick fetcht nur noch,
wenn er zustellen kann. Die Gates (idle, Conversation gestartet, keine
Compaction laufend/pending, Composer leer, Editor vorhanden) wandern **vor**
den `fetchBoardPending`-Aufruf; der Recheck nach dem Fetch bleibt (er fasst
jetzt auch den Editor-Check). Damit rückt der Cursor nur noch, wenn
unmittelbar danach der Wake-Dispatch in einen Run geht, der den Buffer
rendert. Blockierte Phasen (busy, Composer, frische Conversation,
Compaction) lassen die Nachrichten server-seitig stehen; Zustellung dann
über den Run-Start-Fetch des nächsten Runs (rendert im selben Call) oder
den ersten freien Tick. Nebenwirkung erwünscht: weniger `board/pending`-
Aufrufe in blockierten Phasen (GitHub-Quota, board-rate-limit-polling-regime.md).

**Restrisiken (dokumentiert, akzeptiert):**

- ms-Fenster zwischen Pre-Gate und Post-Fetch-Recheck: beginnt ein Run
  oder eine Compaction während des Fetches, ist der Consume bereits
  geschehen und der Wake blockiert — Buffer-Zustand wie vor dem Fix, aber
  das Fenster ist jetzt Millisekunden statt Minuten.
- Run-Start-Pfad: Consume gehört dort zur Zustellung selbst; abortiert der
  Run zwischen Consume und erfolgreichem Request, ist die Nachricht weg
  (Verlustpfad 2). Vollständig schließt das nur Fetch/Ack-Entkopplung:
  `board/pending` ohne Cursor-Fortschritt plus expliziter `board/ack` nach
  erfolgreichem Request — CITT-seitige Änderung, Anker im geparkten
  Mid-Turn-Injection-Workstream (vesta), bei Bedarf später.

**Umsetzung:** `useBoardWatch.ts` (Gates vor den Fetch verlegt, Header-Doc),
`useBoardWatch.test.tsx` (Composer-/Editor-/Frisch-Conversation-Tests auf
„kein Consume" umgestellt; Restfenster-Tests dokumentieren das akzeptierte
Verhalten), Kommentar in `selectToolCalls.ts` aktualisiert.

**Tests:** `node scripts/run-all-tests.mjs --only gui --filter board` —
54 Tests grün; `tsc:check` gui sauber.

## Amendment 2026-08-21 (Fetch/Ack-Entkopplung, "Option B")

**Kontext:** User-GO aus Topic `board-wake-fetch-ack-entkopplung`
(GitHub issue #43) — die im Fix-A-Amendment benannte vollständige
Schließung von Verlustpfad 2. Beidseitige Umsetzung (Fork + CITT) mit
simultanem Deploy, bewusst ohne Kompat-Mechanik (KISS-Vorgabe des Users).
Server-Seite (vesta/CITT): `board/pending` wird zum nicht-konsumierenden
Peek, Gateway-Selektion FIFO (oldest-first), neuer `board/ack`-Handler
mit Max-Merge über `UpdateWatcherTopicAsync`.

**Änderung Fork-Seite:**

- `board/pending` rückt keinen Cursor mehr; Fortschritt nur über
  `board/ack` — Array von `{topic, upToCommentId}`, ein Call pro Run,
  idempotent durch serverseitiges Max-Merge.
- `accumulateBoardFetch` deduped per Message-Id gegen Buffer +
  `tooLargeIds` (Re-Delivery nach verlorenem Ack ist der Normalfall) und
  trackt `ackByTopic`-High-Water-Marken im Session-State — inklusive der
  tooLarge-Ids: unter FIFO würde eine ungeackte übergroße Nachricht die
  Pending-Spitze dauerhaft verstopfen.
- Ack-Firing in `streamNormalInput` hinter dem Stale-Turn-Guard nach
  erfolgreichem Abschluss des LLM-Calls, der den Block gerendert hat
  (fire-and-forget); abortierte/stale Runs acken nicht, der Block bleibt
  pending und wird neu zugestellt.
- Transport: `board/ack` in `core/protocol/core.ts` + `passThrough.ts`
  (inkl. IntelliJ-`MessageTypes.kt`-Sync), `ackBoardMessages` in
  `fetchBoardPending.ts`, `ackBoard` in `core/board/boardClient.ts`,
  `boardAck` in `MCPConnection.ts` (5-s-Budget wie register/pending).

**Akzeptierte Randfälle:** Ack verloren → Doppelinjektion (Dedupe
filtert sie); Ack gegen einen Gateway-Build ohne `board/ack`-Handler
schlägt fehl → self-healing wie verlorener Ack.

**Verifikation:** User-Vorgabe für diese Umsetzung: keine neuen Tests,
Build/Typecheck als Gate (core-Build + gui `tsc:check`). Gezielte Tests
gegen die finale Implementierung sind nachgeschoben.

## Amendment 2026-08-21 (Run-Pfad-Abschaltung, Post-Run-Poll)

**Kontext:** Revision 2 der In-Turn-Injection
(board-auto-topic-injection.md) hat sich in der Praxis nicht bewährt:
ein Injections-Block, der sich zwischen Tool-Loop-Calls eines Runs
verändert, ist für das Modell unsichtbar — Agents reagieren nicht auf
Nachrichten, die mitten im Turn ankommen. User-Entscheidung (2026-08-21):
Funktionalität auf das reine Board-Wake reduzieren; der Codepfad wird
nicht entfernt, sondern abgeschaltet (Reaktivierung im Zuge eines
späteren Refactorings möglich).

**Änderung 1 — Run-Pfad-Abschaltung:** Der TTL-gated Fetch auf
LLM-Call-Ebene in `streamNormalInput` liegt hinter
`BOARD_RUN_PATH_FETCH_ENABLED = false` (gui/src/util/boardInjection.ts);
der Watcher ist der einzige Fetcher. Rendering des Blocks (weiterhin bei
jedem Call) und der Ack hinter dem Stale-Turn-Guard bleiben aktiv — das
Rendering ist das Transportvehikel des Wake-Blocks, der Ack räumt die
Cursor ab. Die Testsuite des abgeschalteten Pfads
(`streamResponse_boardInjection.test.ts`) wurde auf User-Anweisung
gelöscht; die TTL-Gate-Tests in `boardInjection.test.ts` ebenfalls.

**Änderung 2 — unmittelbarer Post-Run-Poll:** Der Watcher-Effekt
re-mountet bei jedem busy→idle-Übergang; der erste Tick nach
(Re-)Aktivierung feuert jetzt mit Delay 0 (`scheduleNext(first)`), erst
die Folgeticks nutzen die gejitterte 60-s-Kadenz. Nachrichten, die
während eines Runs auflaufen, werden unmittelbar nach Run-Ende
zugestellt statt mit bis zu ~75 s Delay; Wake-Ketten drainieren ohne
Wartezeit. Alle bestehenden Gates gelten unverändert.

**Superseded:** Alle älteren Aussagen in diesem Dokument und in
Code-Kommentaren, wonach blockierte Zustellung über den Run-Start-Fetch
des nächsten Runs erfolgt — einen Run-Start-Fetch gibt es nicht mehr;
Zustellung ausschließlich über den ersten freien Watcher-Tick, der nach
Änderung 2 unmittelbar nach Ende des blockierenden Runs kommt.

**Konsequenzen:** Wake-Mode aus = Board komplett still (keine
Run-Start-Zustellung mehr). Poll-Frequenz koppelt an Run-Frequenz statt
an die Uhr — ein `board/pending`-RPC pro Run-Ende; Hinweis für das
CITT-seitige 403/429-Backoff. Ein Abort löst den Post-Run-Poll ebenfalls
aus (ggf. Wake direkt nach manuellem Stopp) — ohne Zusatzlogik
akzeptiert; der Mode-Toggle bleibt der Kill Switch.
