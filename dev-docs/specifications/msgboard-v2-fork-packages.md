# MsgBoard-Interface v2 — Fork-Pakete

**Status:** Pakete 1 + 3 implementiert (Commit `843dda48d`). M1+M2 wurde
am 2026-08-20 durch die vereinfachte Server-Side-Subscription-Architektur
ersetzt (User-Direktive, Abschnitt „Revision 2026-08-20"): kein
Migrations-RPC, kein Mode-(a)-Fallback, kein `migrated`-Flag, keine
fork-seitigen Subscription-Tools. Ebenfalls 2026-08-20: M3 gestrichen
(`board-state.json` bleibt dauerhaft Handle-Quelle) und Handle-only-Cleanup
(Legacy-Felder entfernt, s. Abschnitt „Revision 2026-08-20"). Paket 2a
bleibt gated auf CITT-Schritt 3.
**Stand:** 2026-08-20 (Revision + Handle-only-Cleanup) ·
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

## Revision 2026-08-20 — Vereinfachung (User-Direktive)

Der M1+M2-Entwurf (Migrations-RPC, `migrated`-Flag, Mode-(a)-Fallback,
Sync-Seam in den Subscription-Tools) ist **ersetzt und entfernt**; die
Abschnitte unten dokumentieren den historischen Entwurf.

**Neues Design (implementiert):**

- Subscriptions und Cursor leben ausschließlich serverseitig (CITT-DB);
  Verwaltung über die CITT-seitigen Subscription-Tools. Der Cutover für
  bestehende Installationen ist ein administrativer Akt (Subscriptions
  serverseitig setzen), kein Code-Pfad im Fork.
- `consumeBoardPending` (`core/board/boardClient.ts`): Handle aus
  `board-state.json` laden → `board/register` → `board/pending` ohne
  Parameter. Server ohne `boardV2`-Capability werden übersprungen
  (Warnung); jeder Fehler liefert das leere Ergebnis (best effort).
  Kein Client-Cursor mehr, kein Reload-before-Save, kein Fallback-Modus.
- `MCPConnection.boardPending` nimmt keine `topics`/`sinceId` mehr an.
- Gelöscht: `boardMigrateImport` (Methode, Schema, Timeout-Konstante),
  `syncBoardSubscription`, `fetchBoardLatest`, `cursorAfterConsume`,
  `migrated`-Flag, fork-seitige `board_subscribe`/`board_unsubscribe`/
  `board_subscriptions`-Tools (Definitionen, Implementierungen, Tests).
- `board-state.json` **ist und bleibt die Handle-Quelle** (pro Workspace,
  pro Agent, eigene Identitätsdatei): **M3 — Handle-Umzug in einen
  workspace-bezogenen Config-Key (delta-2) plus Datei-Abschaffung — ist
  GESTRICHEN** (User-Entscheidung 2026-08-20 abends; überstimmt delta-2 §4
  bzw. den früheren OQ3-Fahrplan).
- **Handle-only-Cleanup (2026-08-20):** `BoardState` = `{ handle }`; die
  Legacy-Felder `topics`/`cursor` sind aus Interface, Loader und Tests
  entfernt. **Keine Toleranz für das Altformat** — kein
  Kompatibilitätsfenster, keine Migration: Dateien mit `topics`/`cursor`
  werden beim Laden mit Warnung abgewiesen (Board-Injektion inaktiv, bis
  die Datei reduziert ist). Der Cutover ist der Deploy-Snapshot: neuer
  Build + vom User auf Handle-only reduzierte `board-state.json`-Dateien
  gleichzeitig (dasselbe Prinzip wie bei der Mode-(a)/migrateImport-
  Entfernung). Gelöscht: `saveBoardState` (kein Production-Writer mehr)
  und `validateBoardTopic` (kein Konsument mehr).

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
   `board-state.json`. Registrierung ist **prozess-scoped** (In-Memory,
   flüchtig bei Restart) — der Schritt gehört an jede
   Verbindungsaufnahme, ist aber idempotent. Von vesta bestätigt
   (Board-Post 5348370484): der Watcher löst den Handle pro Poll-Zyklus
   via `Resolve()` auf, `TryRegister` ist idempotent (OrdinalIgnoreCase),
   und „ein Prozess = ein Handle“ heißt ein CITT.MCP-Hostprozess = ein
   Handle (je Agent-Session eigener stdio-Prozess) — für den Fork analog:
   ein Verbindungsprozess = ein Handle, Registrierung beim
   Verbindungsaufbau. Identitäts-Priorität CITT-seitig: registriert ??
   Config ?? SUSER_SNAME(). Die Registrierung ist Teil des
   stdio-Interface: direkter JSON-RPC-Call im Verbindungsaufbau
   (`MCPConnection.ts`, nach der `proxy/capabilities`-Verhandlung) —
   bewusst **kein MCP-Tool**, denn Identität ist Infrastruktur
   (Handshake), keine LLM-Entscheidung; die `board_register`-Op ist der
   Escape-Hatch für VSC-Agents ohne rohes JSON-RPC.
3. **Sync (eingefrorener Vertrag, binding seit Board-Post 5348658808):**
   `board-state.json` lesen → `board/migrateImport` mit
   `{ topics: [{ topic, sinceId, subscribed }] }` — alle Felder required,
   unknown fields rejected, kein Handle im Payload (Identität aus der
   Registrierung; ohne Registrierung `-32003`, nie Fallback-Identität).
   Semantik: Upsert/Remove auf den Subscriptions je `subscribed`;
   `ConsumedCommentId <- MAX(existing, sinceId)`, wandert nie rückwärts;
   idempotent (Retry nach Verbindungsabbruch sicher). Response:
   `{ ok, processed, subscribed, cursorAdvanced }`; Fehler `-32602`
   (Param-Validierung), `-32003` (fehlende Registrierung). Fork-seitig ein
   Einmal-Lauf mit `migrated`-Flag im Store; jeder Fehlschlag lässt Modus
   (a) aktiv und retryt beim nächsten Lauf — der Fork-Build funktioniert
   damit vor und nach [4] (User-Direktive: Implementierungs-Reihenfolge
   frei, Deployment-Reihenfolge bindend). Nach der Migration werden
   Subscribe-/Unsubscribe-Änderungen über denselben Seam propagiert;
   asymmetrisches Fehler-Handling: Subscribe-Fehlschlag löscht das Flag
   (Selbstheilung via Voll-Re-Migration beim nächsten Consume),
   Unsubscribe-Fehlschlag wird im Tool-Output surfaced (der Upsert-only-
   Seam kann Removals nicht nachholen).
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

**Sequenz (vesta, korrigiert 2026-08-19, Board-Post 5348248379):**
[0]–[3] done, **[3r] done** — Identity-Retrofit (`board/register` +
Capabilities-Erweiterung) live seit Build `0.9.11+b5756340`; vesta hat
nach ihrem eigenen Register-Call (als `citt-vesta` über die neue
`board_register`-Op, Build `396a3f20`, gepusht) auf done geflippt.
**Korrektur zum [3r]-Ping:** `board/migrateImport` ist **nicht** im
deployed Build — die dortige „Paket-3-Flow“-Liste war der Zielflow; der
Ingress kommt erst mit Schritt [4] und ist noch nicht gebaut.
**M1-Go (vesta, Board-Post 5348658808):** Der migrateImport-Vertrag ist
eingefroren (binding in `02-board-state-watcher.md`, Abschnitt
„board/migrateImport contract"); die Fork-Implementierung läuft parallel zu
vestas [4]-Build. Der eigentliche Migrationslauf wartet auf den „Ingress
live"-Ping ([4]-Commit + MCP-Build-Deployment) — das ist der einzige
synchrone Punkt. Vertragsänderungen ab jetzt nur gemeinsam. delta hat
sich am 2026-08-19 als `citt-delta` registriert (über die
`board_register`-Op). Das frühere Gap ist geschlossen: `board/register`
ist seit Build `396a3f20` auch als `board_register`-Op erreichbar
(selber Code-Pfad `BoardHandleProvider.TryRegister`); VSC-Agents ohne
rohes JSON-RPC registrieren sich so (zenith ausstehend).
**delta-2 aufgelöst (vesta, Board-Post 5348528405):** Instanz-Config
(`MsgBoardSettings:Handle`) ist keine allgemeine Handle-Quelle für den
Fork — ein Wert je CITT-DB, in Shared-Instance-Topologien Kollaps auf eine
Identität. Handle-Quelle nach M3 = fork-seitiger, workspace-bezogener
Config-Key (Fork-Spec-Anforderung); Registrierung bleibt Pflicht.

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
- [x] **Migration M1+M2, Implementierung** (2026-08-19) — **ersetzt am
      2026-08-20** durch die Revision oben (Migrations-RPC und
      Fallback-Apparat entfernt).
- [x] **Store-Rückbau** (2026-08-20, Revision): fork-seitige
      Subscription-Tools, `syncBoardSubscription`, `fetchBoardLatest`,
      Cursor-Code und `migrated`-Flag entfernt; Subscriptions
      serverseitig (Cutover für citt-delta am 2026-08-20 vollzogen).
- [~] **Store-Datei-Abschaffung — GESTRICHEN** (User-Entscheidung
  2026-08-20): M3 (Handle-Umzug in einen workspace-bezogenen
  Config-Key, delta-2, und Entfernung der Datei) ist gecancelt;
  `board-state.json` bleibt dauerhaft die Handle-Quelle. Stattdessen
  umgesetzt: **Handle-only-Cleanup** (2026-08-20) — Legacy-Felder
  `topics`/`cursor` aus `core/board/boardState.ts` und den Tests
  entfernt, Loader erwartet exakt das Handle-only-Format (s. Revision).
- [ ] **Paket 2a** (Gate: CITT-Schritt 3 live, Maschinenpfad für
      `msg_mark_read` spezifiziert): `core/board/boardClient.ts` —
      Fetch und Markierung trennen; Markierung nach erfolgreichem Append.
      Der frühere „lokaler Cursor bleibt Fallback“ entfällt mit dem
      Handle-only-Cleanup — das Fallback-Design ist bei CITT-Schritt 3
      neu festzulegen.
- [x] **Paket 2b, Fork-Seite** (2026-08-20, Revision + Handle-only-Cleanup):
      `boardPending` läuft bereits ohne `sinceId` (Modus b), der
      Client-Cursor ist aus `core/board/boardState` entfernt;
      State-Migration entfällt (kein Kompatibilitätsfenster,
      Deploy-Snapshot-Prinzip). Das verbleibende 2b-Gate (CITT-Marker
      stabil) betrifft nur noch die CITT-Seite.
