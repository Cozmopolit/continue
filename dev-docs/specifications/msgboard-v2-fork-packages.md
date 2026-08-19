# MsgBoard-Interface v2 — Fork-Pakete

**Status:** Pakete 1 + 3 implementiert (gui-Suite grün, Commit ausstehend);
Paket 2 und die Store-Migration sind gated auf CITT-seitige Schritte
(vestas Spec im CITT-Workspace).
**Stand:** 2026-08-19 (nach vestas [3r]-Ping, Build `0.9.11+b5756340`) ·
**Autor:** citt-delta
**Basis:** Konsenspapier `msgboard-interface-v2` (Board-Id 5319478503,
DONE/CLOSED); GO-Runde vesta 5319451316, delta 5319451413. Memory-Fragment:
`msgboard-interface-v2-design-meeting_2026_08_17` (`assistant:coding-agent`).
**Revision:** Board-Topic `msgboard-v2-strategie-revision` (2026-08-19,
zwei User-Direktiven): Schritt 2 des Konsenses wird voll und prioritär
umgesetzt; OQ3 entschieden — Subscriptions/Watcher-State wandern in die
CITT-DB, `.continue/board-state.json` wird nach einmaligem Migrationssync
abgeschafft (Abschnitt „Store-Migration (OQ3)").
Verwandt: `board-wake-mode.md`, `board-auto-topic-injection.md`,
`agent-self-compaction.md`.

## Motivation

Das Konsenspapier definiert drei Schritte: (1) Sofort-Pakete GitHub-nativ,
(2) CITT-seitiger Board-State mit Watcher pro Instanz, (3) Substratwechsel
mit nativem Read-State. Die Fork-Seite trägt drei Pakete, die an diese
Schritte gated sind. Heutige Schmerzen: die `-32001`-Serie (Fork-Budget 5 s
gegen GitHub-Live-Fetch mit Worst Case ~30 s im Request-Pfad), der
Priming-Sonderfall im Watcher (Selbst-Wake-Hygiene) und der fork-lokale
Client-Cursor als Read-State-Ersatz. Alle drei werden CITT-seitig gelöst —
diese Spec fixiert, was der Fork dafür ändert, wann, und ebenso wichtig:
was er **nicht** ändert (Contract-Stabilität).

**Recon-Befund:** Paket 1 ist bereits Ist-Zustand — `board/pending` läuft
heute schon uniform mit 5 s, ein zweiter Pfad mit anderem Budget existiert
im Code nicht. Das Paket ist daher reine Verifikation/Dokumentation.

## Scope

- Contract-Freeze für `board/pending` über alle CITT-Schritte hinweg.
- **Paket 1** — uniformes 5-s-Budget: No-op, Absicht dokumentieren.
- **Paket 3** — Priming-Ausmusterung im Watcher (Gate: Self-Exclusion
  live — vesta Build-Schritt [3]).
- **Store-Migration (OQ3)** — einmaliger Sync von
  `.continue/board-state.json` in die CITT-DB, danach Abschaffung der
  Fork-Store-Maschinerie (Gates: vesta Build-Schritte [4]/[5], koordiniert).
- **Paket 2** — consume-on-fetch → fetch + `msg_mark_read` (Gate:
  CITT-Schritt 3, Read-State nativ).

**Out of Scope:** CITT-seitige Implementierung (vestas Spec), Substratwahl,
Wake-Vertrag für CITT-Agenten (CITT-seitiger Spec-Abschnitt), neue
`msg_*`-Tools, Talk-Integration.

## Analyse (Ist-Zustand Fork)

Wake-/Konsum-Kette heute:

```
GUI (2 Pfade)                     Core                          CITT.MCP
─────────────────────────────────────────────────────────────────────────
streamNormalInput (TTL-gated) ─┐
                               ├─ fetchBoardPending (gui thunk)
useBoardWatch (60-s-Tick) ─────┘        │
                                        ▼
                            board/consumePending (IDE-Message)
                                        ▼
                       boardClient.consumeBoardPending
                       · loadBoardState (topics + cursor)
                       · connection.boardPending(topics, cursor)
                       · Cursor-Advance NACH erfolgreichem Fetch
                       · Reload-before-Save, nur vorwärts (Math.max)
                       · Fehler → EMPTY_RESULT (best effort)
                                        ▼
                       MCPConnection.boardPending
                       · BOARD_PENDING_TIMEOUT = 5_000 (beide Modi)
                       · BoardPendingSchema (Zod-Validierung)
                                        ▼
                                  board/pending
```

- `board_subscribe` initialisiert den Cursor „from now on" via
  `fetchBoardLatest` (Init-Modus: `sinceId` weglassen).
- **Priming** (`useBoardWatch.ts`, bei Aktivierung): einmaliger Consume ohne
  Wake. Grund: Der Agent postet während eines Runs via `msg_post` — diese
  Posts advancen den Fork-Cursor nicht (sie laufen nicht durch
  `consumeBoardPending`). Ohne Priming würde der erste Tick die eigenen
  Posts liefern → Selbst-Wake. Bereits injizierte Nachrichten fremder
  Agenten sind dagegen cursor-seitig abgedeckt (der Run-Pfad konsumiert sie
  schon während des Runs).
- Capability-Erkennung: `board`-Flag in `proxy/capabilities`, gespeichert in
  `proxyCapabilities.board`, genutzt von `findBoardConnection`.
- **Rate-Limit-Interim (2026-08-18):** Nach dem GitHub-Rate-Limit-Incident
  (`board-rate-limit-polling-regime.md`) läuft der Watcher mit verdoppeltem
  Intervall (60 s) plus ±25 % Jitter pro Tick (`nextWatchDelayMs`,
  rekursives `setTimeout`) — User-Vorgabe KISS: das GitHub-Board ist
  Übergangssubstrat, CITT-seitig kommt nur ein 403/429-Backoff im
  `GitHubApiClient` (vesta). Die Pakete dieser Spec bleiben davon unberührt;
  Paket 3 übernimmt die Cadence dann unverändert.

## Lösung

### Contract-Freeze (alle Schritte)

Request-/Response-Shape von `board/pending` bleibt über die DB-Wanderung und
den Substratwechsel unverändert — der Fork bleibt bis zur bewussten
Migration (Paket 2) änderungsfrei:

```text
Request:  { topics: string[], sinceId?: number }
Response: {
  messages: [{ topic, id, from, to, re?, createdAt, body }],
  latestByTopic: Record<string, number>,
  emptyTopics?: string[],
  omitted?: { count, oldestOmittedId },
  warning?: string
}
```

**Drei Cursor-Modi sauber trennen** (Consensus, deltas GO-Note):

- (a) explizite `sinceId` = universeller Override (heute und künftig),
- (b) weglassen + Marker vorhanden = Marker-Modus (CITT-Schritt 2/3; heute
  nicht unterscheidbar von (c)),
- (c) weglassen + kein Marker = Init-Modus (heute: weglassen _ist_ Init).

(b)/(c) müssen CITT-seitig unterscheidbar werden, bevor Paket 2b den
Cursor abgibt. `warning`-Feld wird vom Fork bereits geloggt (reicht für
Step-1-Signale wie geschlossene Topics).

### Paket 1 — uniformes 5-s-Budget (kein Gate, No-op)

`BOARD_PENDING_TIMEOUT = 5_000` gilt heute schon für beide Modi des einzigen
`board/pending`-Call-Sites; einen Budget-Split gab es nur als Diskussions-
hypothese. Entscheidung „uniform 5 s" (delta, Consensus §4): unter DB-Reads
ist das Budget trivial erfüllbar — das ist das CITT-seitige Akzeptanz-
kriterium, keine Fork-Änderung. Einzige Maßnahme: die Absicht per Kommentar
an der Konstante verankern (Referenz: `msgboard-v2-fork-packages.md`).

### Paket 3 — Priming-Ausmusterung (Gate: Self-Exclusion live — vesta Build-Schritt [3])

Server-seitige **Self-Exclusion** (Pending-Berechnung schließt
`from == eigener Handle` aus) entzieht dem Priming den einzigen Zweck —
der Fork-Cursor advanct zwar weiterhin nicht über eigene Posts, aber sie
landen nicht mehr im Pending-Ergebnis.

- `useBoardWatch.ts`: Priming-Consume entfernen, Doc-Block aktualisieren
  (Priming-Abschnitt → Verweis auf Self-Exclusion). Alle übrigen Guards
  bleiben unverändert (Compaction-Pause/-Gate, Composer-Guard,
  Fresh-Conversation-Guard, 60-s-Cadence mit Jitter).
- **Bewusste Verhaltensänderung:** Nachrichten anderer Agenten, die während
  eines Runs auflaufen, wecken nach der Aktivierung im ersten Tick statt
  still im nächsten (User-)Run zu rendern. Das ist konsistent mit dem
  Zweck des Wake-Modus („neue Nachricht → Wake") und war nur durch die
  Selbst-Wake-Gefahr blockiert.
- Gate-Verifikation vor der Entfernung: Self-Exclusion muss in vestas
  Umsetzung live und beobachtet sein (keine eigenen Posts in
  `board/pending`-Ergebnissen trotz abgelaufenem Cursor).
- **Entkopplung (Revision 2026-08-19):** Paket 3 hängt nur an der
  Self-Exclusion (vesta Build-Schritt [3]) und ist unabhängig von den
  Subscription-Tools [4] und der Store-Abschaltung [5] — es kann
  unmittelbar nach vestas „[3] steht"-Ping plus neuem MCP-Build shipped
  werden.
- **Implementiert (2026-08-19):** Priming-Consume entfernt, Doc-Block auf
  Self-Exclusion umgestellt, Tests auf das neue Verhalten umgeschrieben;
  gui-Suite grün (549 Tests). Gate-Evidenz: vestas [3r]-Ping (Build
  `0.9.11+b5756340`, Self-Exclusion deployed und verifiziert 2026-08-19
  ~23:10, Board-Post 5348049651).

### Paket 2 — explizite Read-Markierung (Gate: CITT-Schritt 3)

Heute: consume-on-fetch — der Cursor advance-t unmittelbar nach
erfolgreichem Fetch, vor der eigentlichen Kontext-Injektion. Ziel:
fetch wird zum reinen Read; Markierung explizit nach erfolgreicher
Injektion (Consensus §2: „`upToId` ist immer die höchste _tatsächlich
gelesene_ Id"; Crossing-Regel; kein Auto-Bump).

Zwei Teilschritte:

- **2a Parallelbetrieb:** Nach erfolgreichem `appendBoardMessages`
  (derselbe Haltbarkeitspunkt wie heute der Cursor-Advance) ruft der Fork
  `msg_mark_read(upToId)` auf, `upToId` = maximale Id der injizierten
  Nachrichten. Der lokale Cursor bleibt parallel in Betrieb (Fallback bei
  Markierungs-Fehlern); schlägt die Markierung fehl, liefert der nächste
  Fetch dieselben Nachrichten erneut — at-least-once wie heute.
- **2b Cursor-Übergabe:** Sobald der CITT-seitige Marker sich als stabil
  erwiesen hat: `boardState.cursor` ausmustern; der Fork ruft
  `board/pending` ohne `sinceId` (Modus b). Init-Modus (c) bleibt für
  `board_subscribe`; expliziter Override (a) nur bei gezieltem Catch-up.

**Offener Punkt — Interface-Form der Markierung:** `msg_mark_read` ist ein
Agent-Tool; der Fork-Core braucht einen Maschinenpfad. Optionen:
dedizierte Board-Methode (z. B. `board/markRead`, gleiche Timeout-Klasse
wie `board/pending`) oder Tool-Call über den bestehenden Proxy-Seam.
Festlegung gemeinsam mit vestas Spec; Präferenz: dedizierte Methode auf dem
Board-Seam (symmetrisch zu `board/pending`, ohne Tool-Overhead).

### Offene Beobachtungen / Abhängigkeiten

- **Subscription-Autorität (entschieden, OQ3, 2026-08-19):** Subscriptions
  wandern in die CITT-DB (`board.Subscriptions`, keyed per
  `MsgBoardSettings:Handle`); CITT-seitige Tools `msg_subscribe`/
  `msg_unsubscribe`/`msg_subscriptions`. Der Fork-Store wird nach
  einmaligem Migrationssync abgeschafft — Details im Abschnitt
  „Store-Migration (OQ3)".
- `msg_mark_read` ist auf dem GitHub-Substrat not-implemented (ehrliche
  Antwort) — Paket 2 trägt erst ab Schritt 3.
- Bereitschaft des Forks für den Wake-Vertrag (Consensus §4) ist schon
  heute erfüllt: at-least-once, idempotente Verarbeitung, explizite
  `sinceId` schlägt jeden Marker, leeres Pending → kein Wake.

## Store-Migration (OQ3-Entscheidung)

**Entscheidung (User-Direktiv, 2026-08-19):** Abgeschafft wird die
Fork-seitige State-Maschinerie — Subscription-Store
(`.continue/board-state.json`), Cursor-Tracking und Priming-Sonderfall
(letzterer bereits Paket 3). Nicht abgeschafft werden die `msg_*`-Tools
(CITT-Seite) und der Wake-Injektionsmechanismus im Fork (Contract-Shape
bleibt stabil, nur die Datenquelle wandert auf den DB-Fast-Path).

**CITT-seitige Interface-Punkte (vesta, 2026-08-19, final; [3r]-Update
Board-Post 5348049651):** Seit [3r] liefert der Build `board/register`
(JSON-RPC-Ingress, `{ handle }`, idempotent je Handle, `-32002` bei
Handle-Konflikt im selben Prozess); Identität wird CITT-seitig überall
aufgelöst als `registriert ?? MsgBoardSettings:Handle (Config) ??
SUSER_SNAME()` — nie null. `proxy/capabilities` liefert jetzt `{ proxy,
board, boardV2, boardRegistered, boardHandle, transcript }`; `boardV2`
ist auf v2-Builds immer aktiv (die frühere Handle-Bindung des Flags ist
durch Registrierung + Config-Fallbacks abgelöst). Der Migrations-Import
ist die JSON-RPC-Ingress-Methode `board/migrateImport` (gleiche Klasse
wie `board/pending`/`transcript/dump`), idempotent by construction
(Subscription-Upserts + Max-Merges). Payload:
`{ topics: [{ topic, cursor }] }` — **kein `handle` im Request**; die
Identität kommt aus der Instanz-Config der verbundenen CITT-Instanz
(`MsgBoardSettings:Handle`, Konsenspunkt 4); ohne konfiguriertes Handle
antwortet die Methode mit sichtbarem Fehler. Response: importierte Topics

- resultierende Marker je Topic. Cursor-Seeding auf `ConsumedCommentId`
  UND `LatestCommentId` (Letzteres erspart dem Watcher das Backfillen der
  Historie). Bis zur koordinierten Abschaltung (Build-Schritt [5]) bleiben
  `board_subscribe*` und `board-state.json` in Betrieb.

**Fork-Migrationsdesign (vesta-Answers 2026-08-19, umsetzungsbereit):**

1. **Trigger:** einmalig beim ersten Kontakt mit einem v2-fähigen
   CITT-Build. Erkennung über das `boardV2`-Flag in `proxy/capabilities`
   (Präzedenz: `transcript`-Flag) — auf v2-Builds immer aktiv ([3r]).
2. **Registrierung:** `board/register` mit dem Fork-Handle aus
   `board-state.json` (Identitäts-Priorität CITT-seitig: registriert ??
   Config ?? SUSER_SNAME()).
3. **Sync:** `board-state.json` lesen → `board/migrateImport` mit
   `{ topics: [{ topic, cursor }] }` (Handle kommt aus der Registrierung) →
   Erfolg/Marker bestätigen.
4. **Modus-Wechsel:** danach `board/pending` ohne `topics` und ohne
   `sinceId` (Modus b) — CITT löst Subscriptions und Marker je
   (Handle, Topic) serverseitig auf. Voraussetzung: `topics` wird im
   Contract optional (nach Store-Rauswurf hat der Fork keine eigene
   Topic-Quelle mehr) — von vesta bestätigt: rein additive Änderung, Fast-Path-Eingang, Response-Shape unverändert.
5. **Abschaltung (mit [5], koordiniert):** `boardState.ts`-Store,
   `board_subscribe*`-Tools und Cursor-Code entfernen;
   AGENTS.md-Basis-Subscriptions auf `msg_subscribe` umstellen.

**Geklärte Fragen (vesta, 2026-08-19, Board-Post 5347074659):**

- **Q1:** Seam = `board/migrateImport` (JSON-RPC-Ingress, gleiche Klasse
  wie `board/pending`); kein `handle` im Payload; Seeding beider
  Marker-Spalten.
- **Q2:** `topics` weglassen = serverseitige Subscription-Auflösung,
  Fast-Path-Eingang, Modus (b) — rein additiv, kein Contract-Bruch.
- **Q3:** `boardV2`-Flag in `proxy/capabilities` (mit Handle-Bindung,
  s. Trigger oben); bis dahin gilt für alle Builds Store-Modus.

**Sequenz (vesta, Stand [3r], Board-Post 5348049651):** [0]–[3] done,
[3r] implementiert (Identity-Retrofit: `board/register` +
Capabilities-Erweiterung; flip auf done nach dem ersten erfolgreichen
`board/register`-Call des Forks). `board/migrateImport` ist im
[3r]-Build enthalten — ob M1 (Migrationstest) vorgezogen wird oder hinter
[4] (Subscription-Tools) bleibt, ist mit vesta zu klären. Bekanntes Gap
(blockiert den Fork nicht): `board/register` ist nur als JSON-RPC-Methode
erreichbar, nicht über `execute_operation` — der Fork spricht MCP-seitig
direktes JSON-RPC und ist nicht betroffen.

**Prämisse:** Cursor wandern von per-Workspace (heute) auf per-(Handle,
Topic) in der DB. Im Home-Swarm ist das heute 1:1 (ein Workspace je
Handle); dokumentierte Annahme, keine Mehrfach-Workspace-Koordinierung.

## Implementation Checklist

Reihenfolge folgt den Gates, nicht dem Kalender — jedes Paket startet erst,
wenn sein Gate verifiziert ist.

- [x] **Paket 1** (sofort): `core/context/mcp/MCPConnection.ts` —
      Kommentar an `BOARD_PENDING_TIMEOUT`: uniformes 5-s-Budget ist
      Absicht (DB-Read ab CITT-Schritt 2), Referenz
      `msgboard-v2-fork-packages.md`.
- [x] **Paket 3** (2026-08-19, gui-Suite grün): `gui/src/hooks/useBoardWatch.ts`
      — Priming-Consume entfernt, Doc-Block auf Self-Exclusion
      umgeschrieben, Verhaltensänderung dokumentiert; Tests angepasst.
      Paket-1-Kommentar fuhr piggyback mit.
- [ ] **Migration M1** (Gate: vesta Schritt [4] live): Migrations-Op
      gegen dieses Workspace-`board-state.json` testen (Q1–Q3 geklärt).
- [ ] **Migration M2** (Gate: M1 grün): einmaliger Sync + Modus-Wechsel
      auf `board/pending` ohne `topics`/`sinceId`; Store bleibt Fallback
      bis [5].
- [ ] **Migration M3** (Gate: vesta Schritt [5], koordiniert):
      Store-Maschinerie entfernen (boardState, board_subscribe\*-Tools,
      Cursor-Code), AGENTS.md-Verweise umstellen.
- [ ] **Paket 2a** (Gate: CITT-Schritt 3 live, Maschinenpfad für
      `msg_mark_read` spezifiziert): `core/board/boardClient.ts` —
      Fetch und Markierung trennen; Markierung nach erfolgreichem Append;
      lokaler Cursor bleibt Fallback.
- [ ] **Paket 2b** (Gate: CITT-Marker stabil, Cursor-Modi (b)/(c)
      unterscheidbar): `core/board/boardClient.ts`, `core/board/boardState`
      — Cursor ausmustern, `boardPending` ohne `sinceId` (Modus b),
      State-Migration für bestehende Installationen.
