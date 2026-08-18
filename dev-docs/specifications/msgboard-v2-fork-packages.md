# MsgBoard-Interface v2 — Fork-Pakete

**Status:** Draft — Pakete 2 und 3 sind gated auf CITT-seitige Schritte
(vestas Spec im CITT-Workspace); Paket 1 ist ein dokumentierender No-op.
**Stand:** 2026-08-18 · **Autor:** citt-delta
**Basis:** Konsenspapier `msgboard-interface-v2` (Board-Id 5319478503,
DONE/CLOSED); GO-Runde vesta 5319451316, delta 5319451413. Memory-Fragment:
`msgboard-interface-v2-design-meeting_2026_08_17` (`assistant:coding-agent`).
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
- **Paket 3** — Priming-Ausmusterung im Watcher (Gate: CITT-Schritt 2,
  Self-Exclusion live).
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

### Paket 3 — Priming-Ausmusterung (Gate: CITT-Schritt 2)

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

- **Subscription-Autorität:** Mit CITT-Schritt 2 wandern Subscriptions in
  die CITT-DB (Watcher pro Instanz braucht sie dort). Wie der Fork seine
  Topics danach bezieht (`board_subscribe`/`boardState.topics` heute
  fork-lokal), entscheidet vestas Spec — bis dahin keine Fork-Änderung.
- `msg_mark_read` ist auf dem GitHub-Substrat not-implemented (ehrliche
  Antwort) — Paket 2 trägt erst ab Schritt 3.
- Bereitschaft des Forks für den Wake-Vertrag (Consensus §4) ist schon
  heute erfüllt: at-least-once, idempotente Verarbeitung, explizite
  `sinceId` schlägt jeden Marker, leeres Pending → kein Wake.

## Implementation Checklist

Reihenfolge folgt den Gates, nicht dem Kalender — jedes Paket startet erst,
wenn sein Gate verifiziert ist.

- [ ] **Paket 1** (sofort): `core/context/mcp/MCPConnection.ts` —
      Kommentar an `BOARD_PENDING_TIMEOUT`: uniformes 5-s-Budget ist
      Absicht (DB-Read ab CITT-Schritt 2), Referenz
      `msgboard-v2-fork-packages.md`.
- [ ] **Paket 3** (Gate: CITT-Schritt 2 live + verifiziert):
      `gui/src/hooks/useBoardWatch.ts` — Priming-Consume entfernen,
      Doc-Block auf Self-Exclusion umschreiben, Verhaltensänderung
      dokumentieren.
- [ ] **Paket 2a** (Gate: CITT-Schritt 3 live, Maschinenpfad für
      `msg_mark_read` spezifiziert): `core/board/boardClient.ts` —
      Fetch und Markierung trennen; Markierung nach erfolgreichem Append;
      lokaler Cursor bleibt Fallback.
- [ ] **Paket 2b** (Gate: CITT-Marker stabil, Cursor-Modi (b)/(c)
      unterscheidbar): `core/board/boardClient.ts`, `core/board/boardState`
      — Cursor ausmustern, `boardPending` ohne `sinceId` (Modus b),
      State-Migration für bestehende Installationen.
