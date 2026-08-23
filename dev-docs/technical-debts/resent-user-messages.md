# Re-injizierte / duplizierte User-Messages ohne User-Aktion

**Status:** Offen — Forensik ausgerollt 2026-08-23 (Tripwire + promptLogging, Build + Reload erforderlich), erster Fang ausstehend. Dieses Dokument ist der Wiedereinstiegspunkt: bei erneutem Auftreten zuerst hier lesen, dann der Re-Entry-Checkliste folgen.
**Date:** 2026-08-23

## Der problematische Effekt

Eine User-Message wird einmal gesendet, erscheint dem Modell aber **ein oder
mehrmals erneut** — ohne jede User-Aktion. Beobachtete Signatur der
2026-08-23-Variante (Session `66f6ab09-5591-40ab-a411-03e6791c47c8`,
Workspace `continue`, Modell `OpenRouter: Qwen3.8 max`, Mode agent):

- Die „Wiederholung" ist der Text der **ersten** User-Message der Session
  (nicht der jeweils letzten) und trifft beim Modell am Ende des **voll
  aktuellen** Conversations-Zustands ein.
- Sie tritt **mitten im Run** an Continuation-Punkten auf (direkt nach
  Tool-Results): Reasoning-Blöcke wie „The user resent the same message …"
  mitten in einem Assistant-Turn; das Modell antwortet die Phantom-Nachricht
  inline an („Kurzer Status: Ich bin da bereits dran …").
- **GUI rendert keine zusätzliche User-Bubble**; die Phänomene liegen
  innerhalb eines laufenden Assistant-Turns (Screenshot: Tool-Call →
  Reasoning „resent" → sichtbarer Text → Tool-Call → Reasoning „resent
  again").
- **Persistierte History ist sauber:** exakt die echten User-Messages
  (in der 08-23-Session drei: Bootstrap, „Option A …", „Shit …"), keine
  Duplikate, keine abgeschnittenen Tails.
- Das Reasoning wirkt **semantisch korrekt/kohärent** — das unterscheidet
  bewusst NICHT zwischen echtem Input und Halluzination (eine Fehlwahrnehmung
  reasoniert von innen immer kohärent).
- Tritt auch auf, nachdem längst eine neue echte User-Message gesendet wurde.
- Häufigkeit „gefühlt selten", aber seriebildend: Vorfälle dokumentiert
  08-10, 08-14, 08-17 (vesta/zenith), 08-22, 08-23.

## Familien-Historie (bereits gefixt — erklärt diese Variante NICHT)

1. **Persisted-duplicate-Variante (08-10/08-14, zuletzt 08-22 zenith):**
   echte Duplikate IN der History. Ursache: der Overloaded-Retry in
   `streamThunkWrapper.tsx` führte die ganze Run-Closure erneut aus und
   re-dispatchte `submitEditorAndInitAtIndex` bzw. re-appendete
   Tool-Messages. Fix 2026-08-22 `eba0b9d1f` (overloaded-retry-history-rewind):
   Retries rewinden per `truncateHistoryToLength` auf den Pre-Attempt-
   Snapshot; `console.warn("[stream-retry] …")` pro Retry.
2. **Capture-Bug + Reasoning-Resend (08-17):** `streamUpdate` doubelte das
   erste Reasoning-Delta („TheThe.") → korrupte `reasoning_details`; dazu
   Reasoning-Resend, das dem Modell eigenes Thinking vorspielt, das
   User-Text zitiert → Eskalation zur Resend-Überzeugung. Fixes: Capture-Bug
   behoben; Per-Familien-Resend-Policy in `OpenRouter.ts` (`5ab32eade`):
   Qwen plain `reasoning`, Kimi/DeepSeek `reasoning_content`, Claude
   signierte `reasoning_details`, Gemini keines.
3. Dieses Dokument ersetzte `resent-user-messages.md`, das in `2097879a8`
   voreilig als resolved gelöscht wurde — die Familie ist es nicht.

## Für die 08-23-Variante ausgeschlossen (mit Begründung)

1. **GUI-Submit/Persist-Pfad (alte Familie):** History sauber, keine
   Bubble; der Rewind-Fix ist zudem auf HEAD.
2. **Alle Retry-Pfade:** rewinden ZUERST (`streamResponse.ts`,
   `streamResponseAfterToolCall.ts`) — können per Konstruktion nicht „alte
   User-Message hinten am aktuellen Zustand ohne Truncate" erzeugen; ein
   verspäteter Retry einer alten Closure würde truncaten (sichtbar als
   Kontextverlust) — nicht beobachtet.
3. **`constructMessages`:** pure History-Transformation, keine Injection.
4. **`toChatBody`/`openaiTypeConverters`:** Thinking-Items → `null` im Body,
   gemerged ins `reasoning`-Feld des folgenden Assistant; Rollen korrekt.
5. **`OpenAI.modifyChatBody`:** nur Stop-Words/max_tokens/O-Series-
   Formatierung, keine Message-Chirurgie.
6. **Board-Injection:** landet als Regel im System-Prompt, nie als
   User-Message; Run-Pfad-Fetch ist zudem abgeschaltet.
7. **Korruptes-Reasoning-Variante (08-17):** heutige Reasoning-Blöcke sauber,
   keine Stutter-Signatur.
8. **User-Aktion:** nichts getippt; Resend-Klick auf eine History-Bubble
   würde den Tail truncaten — History intakt.
9. **Unbewiesen, aber NICHT erledigt:** Modell-seitige Fehlattribution durch
   replayed Reasoning, das User-Text zitiert (7 Thinking-Items der
   08-23-Session zitieren die erste User-Message). Fix-Vorschläge auf dieser
   Basis sind bewusst verworfen bzw. zurückgestellt:
   - v1 „Qwen-Resend abschalten" — **verworfen**: das Resend ist bezahlter
     Nutzen (Planungskontinuität über Tool-Loops; Kimi K3 braucht es
     zwingend, Qwen3.8-max arbeitsstilistisch ebenso).
   - v2 „Attributions-Marker/Regel" — zurückgestellt bis Payload-Daten die
     Hypothese tragen.

## Offene Hypothesen (durch Payload-Daten entscheidbar)

- **H1 — Injection unterhalb des GUI-Render-Pfads:** etwas hängt die alte
  User-Message nach `constructMessages` an den Request (core `compileChat`/
  Pruning, OpenRouter-serverseitiges Reasoning-Replay-Verhalten, oder eine
  noch ununtersuchte Schicht).
- **H2 — Modell-seitige Perception auf sauberem Payload.**
  Diskriminator: der vollständige Request-Payload zum Zeitpunkt des
  Auftretens. Dafür ist die Forensik unten ausgerollt.

## Forensik: wo liegt was, worauf schauen

Ausgerollt 2026-08-23; **wirkt erst nach Build der Extension + Window-
Reload** (GUI-Code!). Commit-Status zur Abfassungszeit: uncommitted, fährt
mit dem nächsten Commit mit — bei Re-Entry per `git log` prüfen, ob
`[reinject-forensics]` in HEAD ist.

1. **Prompt-Logging (persistierte Payloads):**
   `~/.continue/config.yaml` enthält am Ende `experimental: promptLogging: true`
   (Opt-in, bläht Session-Dateien quadratisch — **nach dem Fang
   abschalten**). Wirkung: pro LLM-Call landet der voll gerenderte Prompt als
   `promptLogs[]` am jeweils letzten History-Item → in der Session-Datei
   `~/.continue/sessions/<sessionId>.json` unter
   `history[i].promptLogs[j].prompt`. Darauf schauen: tritt die erste
   User-Message im Prompt häufiger/auffälliger auf, als die History
   User-Turns hat (insb. als scheinbar neuer User-Block am Ende)?
2. **Tripwire (Live-Konsole):** `gui/src/redux/thunks/streamNormalInput.ts`,
   Marker `[reinject-forensics]`, direkt nach `constructMessages` vor dem
   Wire-Call. Loggt pro LLM-Call: `depth`, Rollen-Fingerabdruck
   (Anfangsbuchstaben jeder Rolle in Sequenz), `dupUserTail` (true = exakt
   doppelte User-Message am Payload-Ende → **H1 auf GUI-Ebene bestätigt**),
   `lastHead` (erste 60 Zeichen der letzten Message). Sichtbar in den
   Webview-Devtools: Command Palette → **„Developer: Open Webview Developer
   Tools"** bei fokussiertem Continue-Panel; Console-Tab.
3. **Ebenfalls in derselben Konsole:** `redux-logger` loggt jede Action
   (collapsed groups) — zum Zeitpunkt eines Auftretens suchen nach
   `session/submitEditorAndInitAtIndex` (wer hat submitted?) und
   `session/truncateHistoryToLength` (Rewind-Aktivität), sowie
   `[stream-retry]` (Overloaded-Retries).

## Re-Entry-Checkliste (nächster Vorfall)

1. Session-Datei bestimmen: `~/.continue/sessions/sessions.json` → jüngster
   Eintrag des Workspaces → `<sessionId>.json` öffnen.
2. Rollen-Zensus: `history[*].message.role` — Anzahl User-Items gegen die
   gefühlt injizierten Wiederholungen halten.
3. `promptLogs` am Turn des Auftretens extrahieren: Rollen-Sequenz und
   User-Texte des Payloads rekonstruieren, mit der History vergleichen.
   Duplikat im Payload → H1 (dann redux-Logger/Devtools-Auszug heranziehen,
   Submit-Ursprung finden). Payload sauber → H2 (dann erst Fix-Diskussion:
   Resend-Policy/Marker, mit Beleg).
4. Devtools-Auszug sichern, falls offen (`[reinject-forensics]`,
   `[stream-retry]`, redux-Actions um den Zeitpunkt).
5. Ergebnis + Mechanismus hier nachtragen; Status-Zeile aktualisieren;
   `promptLogging` wieder abschalten.
