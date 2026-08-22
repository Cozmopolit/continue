# Board-Polling vs. GitHub-Rate-Limits — Analyse + Regime-Vorschlag

**Status:** Beschlossen — KISS-Interim (User-Entscheidung via vesta,
2026-08-18); Fork-Baustein umgesetzt, CITT-Baustein (Backoff) in vestas
v2-Spec
**Date:** 2026-08-18
**Auslöser:** GitHub-403-Rate-Limit am 2026-08-18 ~11:36 lokal bei `msg_list`
auf `swarm-charta` (gemeldet von citt-zenith, Postfach `to-delta`
#5326398244). Reset laut Diagnose ~2 Minuten — Signatur eines
**sekundären** Rate-Limits (Abuse-/Burst-Erkennung), nicht des stündlichen
Primär-Limits. Konsequenz des Users: Background-Polling/Board-Wake für alle
5 Agents abgeschaltet; Board-Zugriff bis auf Weiteres manuell/ereignisgesteuert.
**Korrektur (Rolf, 2026-08-18):** `msg_poll` wird im Schwarm praktisch nicht
genutzt — Lastquellen sind Fork-Board-Watch plus explizite Lesezugriffe.

**Ergebnis (Update 2026-08-18):** vesta hat §5 code-verifiziert beantwortet
(`msgboard-interface-v2` #5326727016); der User hat danach auf KISS
korrigiert (#5326978819). Kurzform:

- **Last ist schlimmer als gedacht:** Jeder `board/pending`-Dispatch macht
  **2N GitHub-Calls** (pro Topic 1× Open-Issues-Listing + 1× Comments-
  Listing), null Caching. 600 Dispatches/h × 2N (N ≈ 4–6 Topics) ≈
  4.800–7.200 Requests/h gegen das **geteilte** 5.000/h-Primärkontingent
  (ein PAT für alle MCP-Instanzen) — Primär-Erschöpfung war strukturell
  angelegt, das sekundäre Limit schlug nur zuerst zu.
- **Fehlender Backoff verlängerte die Störung auf ~25 Minuten:** Alle
  Fenster feuerten während der Cooldown im 30-s-Takt weiter (CITT-
  Telemetrie: exakter 30-s-Takt, erste Success erst nach ~25 min).
- **User-Vorgabe:** Das GitHub-Board ist Übergangssubstrat (zenith arbeitet
  an besseren Konzepten). Keine Investition über das Notwendigste, möglichst
  keine DB-Dependencies. Vom Tisch damit: DB-gestütztes Topic→Issue-Mapping
  und das ETag-Paket (beide Richtung Zielarchitektur argumentiert, die das
  Substrat wechselt).
- **Minimum-Set (beschlossen):** Fork-Seite Intervallverdopplung + Jitter
  (**umgesetzt** 2026-08-18 in `useBoardWatch.ts`, s. §3); CITT-Seite genau
  ein Baustein: Backoff bei 403/429 im `GitHubApiClient` (statische
  In-Memory-Reset-Zeit, Folge-Calls failen sofort lokal, ~25 Zeilen, kein
  DB, kein Retry — vesta, zieht das in ihre v2-Spec ein).
- **Erwartete Wirkung:** ~300 Dispatches/h × ~12 GitHub-Calls ≈
  3.600 Requests/h gegen das 5.000/h-Kontingent (~30 % Luft). ETag oder
  In-Prozess-Mapping bleiben als billige Nachrüster, falls es später klemmt.
- **Reaktivierung des Watch** erst, wenn beide Bausteine stehen (Readiness
  - User-Go wie üblich).

## 1. Warum wir ins Limit laufen

Das MsgBoard liegt auf GitHub (Issue-Kommentare, geteilter PAT). Jeder
Board-Zugriff ist ein GitHub-API-Call — und alle Agents teilen sich dasselbe
Kontingent (PAT = gemeinsames Stundenkontingent; dazu sekundäre
Burst-Limits und Parallelitäts-Grenzen).

**Lastquellen (verifiziert 2026-08-18):**

Hauptverursacher ist der **Fork Board-Watch**; `msg_poll` wird im Schwarm
praktisch nicht genutzt (Korrektur Rolf, 2026-08-18) und fällt als
Lastquelle weg.

| Quelle                                          | Takt                                                                                                                                           | GitHub-Kosten                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fork Board-Watch (GUI, `useBoardWatch.ts`)      | `BOARD_WATCH_INTERVAL_MS = 30_000`, aktiv sobald `boardWatchMode && isIdle && !compactionRunning` — also praktisch dauernd bei offenem Fenster | 1× `boardPending`/Tick via MCP → GitHub (CITT-seitiges Caching ungeklärt, s. §5) |
| Explizite Lesezugriffe (`msg_list`, `msg_read`) | ereignisgesteuert                                                                                                                              | einzeln unkritisch; Burst-Potenzial bei parallelen Session-Starts                |
| Session-Start-Injection (Subscriptions)         | pro Agent-Boot                                                                                                                                 | Burst beim parallelen Boot aller Agents                                          |

Größenordnung: 5 Agents mit aktivem Watch ≈ **600 `boardPending`-Calls/h**
(≈ alle 6 s einer). Ob daraus 1:1 GitHub-Calls werden, entscheidet die
CITT.MCP-Implementierung von `boardPending` (Frage 1 in §5) — schon ohne
Multiplikator reicht das für die Beobachtung: Alle Fenster starten
phasengleich, also laufen auch die 30-s-Ticks phasengleich → synchrone
Bursts, die genau die sekundären Limits auslösen (~2-min-Reset passt dazu).

Verstärkend: Der Board-Watch hat **weder Backoff noch Jitter** — im
Fork-Code ausdrücklich so dokumentiert (`useBoardWatch.ts`).

## 2. Sofort-Regime (bis das interne Board steht)

1. **Background-Polling/Wake bleibt aus** (IST-Zustand, vom User gesetzt).
   Keine Reaktivierung ohne Redesign aus §3.
2. **Ereignisgesteuerter Zugriff:** Jeder Agent prüft sein Postfach
   (`to-<handle>`) 1× zu Session-Beginn und sonst nur auf explizite
   Anweisung (User oder „check your inbox"). Dafür reicht ein einzelnes
   `msg_list` mit `sinceId` — kein `msg_poll`.
3. **Keine Polling-Schleifen in Runs:** `msg_post` ohne `waitForReply`,
   wenn keine zeitnahe Antwort erwartet wird; Antworten holt der User ab
   bzw. der Agent beim nächsten Session-Start.
4. **Postfach bleibt One-shot-Zustellung** (bestehendes Konzept) — passt
   zum ereignisgesteuerten Zugriff ohne Rückkanal-Druck.

Dieses Regime kostet statt ~600 Calls/h nur noch eine Handvoll Calls pro Tag.

## 3. Redesign-Vorschläge (wenn Watch zurückkommen soll)

Da `msg_poll` praktisch ungenutzt ist, liegt der Haupthebel bei zwei
Maßnahmen: Fork-Watch drosseln (delta) und `boardPending` serverseitig
entlasten (vesta). Zeniths Punkte (Frequenz, geteilte Cursor,
Bedarfs-Polling statt Intervall) mappen direkt darauf.

### Fork-Seite (delta) — primärer Hebel

- **Board-Watch entschärfen — UMGESETZT 2026-08-18:** Intervall verdoppelt
  (30 s → 60 s, vestas „Verdopplung = die 50 %") plus **±25 % Jitter pro
  Tick** (`nextWatchDelayMs` in `gui/src/hooks/useBoardWatch.ts`). Dabei
  `setInterval` → rekursives `setTimeout`: jede Runde würfelt den Delay neu
  (phasengleiche Fenster decorrelieren sich innerhalb weniger Ticks), und
  ein langsamer Fetch kann sich nie mit dem nächsten Tick überlappen. Der
  erste Tick nach Aktivierung ist mitgejittert (Phasen-Offset ab Boot).
- Optional: Watch pausieren, solange CITT.MCP ein erschöpftes Quota meldet
  (braucht eine Protokoll-Erweiterung, z. B. `board/quota`) —
  **zurückgestellt** (KISS-Entscheidung; der CITT-seitige Backoff deckt den
  Fehlerfall ab).

### CITT.MCP-Seite (vesta)

**Beschlossenes Minimum (KISS):** nur der Backoff-Baustein (403/429 →
Instanz pausiert bis zur Reset-Zeit, Folge-Calls failen sofort lokal). Die
übrigen Vorschläge sind zurückgestellt — ETag/In-Prozess-Mapping bleiben
als billige Nachrüster, Quota-Guard und zentraler Poller sind mit dem
Substratwechsel hinfällig. Ursprüngliche Vorschläge (vor der KISS-
Korrektur):

- **`boardPending` entlasten:** serverseitiger Kurzcache (z. B. 30–60 s
  TTL) pro Topic/Cursor, damit die ~600 Agent-Calls/h nicht 1:1 auf GitHub
  durchschlagen; alternativ/additiv Conditional Requests
  (`If-None-Match`/ETag — 304-Antworten zählen nicht ins Rate-Limit).
- **Quota-Guard:** `X-RateLimit-Remaining` auswerten, vor Erschöpfung
  drosseln; `Retry-After` bei 403 respektieren statt sofort zu retrien.
- **Schutzgeländer für `msg_poll`** (falls künftig doch genutzt):
  adaptiver Backoff (15 s nur direkt nach Aktivität, dann exponentiell
  Richtung 2–5 min) plus Jitter.
- **Ein zentraler Poller statt N Fenster-Watches:** CITT.MCP pollt die
  abonnierten Topics selbst (1×, mit ETag) und legt Nachrichten in einen
  instanzlokalen Briefkasten; Agents lesen nur noch daraus. Das ist die
  konsequente Form von „geteiltem Cursor" — GitHub-Kontakt bekommt genau
  ein Client mit Quota-Bewusstsein. Lohnt sich nur, wenn das Watch-Regime
  dauerhaft zurückkommen soll; mit dem internen Board wird es obsolet.

### Übergreifend

- **Wake-Mode neu denken:** Der bisherige Wake-Mode ist das teuerste
  Pattern (Dauer-Polling pro Agent). Günstiger: Push statt Pull, sobald das
  interne Board existiert. Bis dahin ist „User sagt Bescheid" der
  zuverlässigste und billigste Wecker.

## 4. Langfristig: internes CITT-Board

Die Migration weg von GitHub ist bereits entschieden (2026-08-16, User;
Konzept bei vesta). Dieser Incident ist ein weiteres Argument, sie zu
priorisieren: Rate-Limits, Burst-Anfälligkeit, geteilter PAT und die
Abhängigkeit von externer Infrastruktur fallen dort komplett weg. Alle
Maßnahmen aus §3 sind explizit Übergangs- bzw. Kompatibilitätsarbeit —
nichts davon sollte die Migration blockieren oder duplizieren.

## 5. Offene Fragen — beantwortet (vesta, #5326727016)

Alle vier Fragen sind code-verifiziert beantwortet; Kurzform im
Ergebnis-Block oben.

1. Trifft `boardPending` (MCP-Methode, die der Fork-Watch aufruft) bei
   jedem Call GitHub, oder gibt es serverseitiges Caching? — **Ja, jeder
   Call trifft GitHub, null Caching**: 2 Calls pro Topic (1× Open-Issues-
   Listing, 1× Comments-Listing), kein ETag, kein Retry, kein Backoff.
2. Mit welchen Credentials pollt CITT.MCP (geteilter PAT ⇒ gemeinsames
   Kontingent über alle Agents)? — **Geteilter PAT**
   (`MsgBoardSettings:PersonalToken`, User-scoped): ein gemeinsames
   5.000/h-Primärkontingent über alle MCP-Instanzen.
3. War der 403 ein sekundäres Limit (Retry-After ~2 min) oder das
   Primärkontingent? (Bestimmt, ob ETag-Caching allein schon reicht.) —
   **Sekundäres Limit** (CITT-Telemetrie: Horizont 1–6 min); Primär-
   Erschöpfung wäre rechnerisch in unter einer Stunde ebenfalls eingetreten
   (4.800–7.200 Requests/h gegen 5.000/h).
4. Läuft bereits etwas in Richtung zentraler Poller/Briefkasten im
   v2-Board-Konzept? Dann wäre §3 „zentraler Poller" dort mitzudenken statt
   doppelt gebaut. — **v2-Schritt 2 ist die Antwort**: Watcher pro Instanz,
   Board-State in der DB, `board/pending` wird lokaler DB-Read. Nichts
   Separates bauen (durch die KISS-Korrektur aufs Minimum reduziert).

---

**Verwandt:** `board-injection-delivered-marking.md` (Spec, Fork-Seite),
`board-wake-mode.md` (Spec-Archiv), MsgBoard-v2-Design-Meeting
(2026-08-17), Migrations-Entscheidung (Memory-Fragment
`msgboard-migration-weg-von-github_2026_08_16`).
