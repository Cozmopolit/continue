# AGENTS.md — Bootstrap für Coding Agents (Continue-Fork)

Du arbeitest am **Fork von Continue** (Coding Assistant für VS Code/JetBrains),
angepasst für Corporate-Use hinter dem CITT MCP-Tunnel. Monorepo (npm):
`core/`, `gui/`, `packages/*`, `extensions/{vscode,cli}`, `binary/`.

**Wichtigster Kontext: Continue ist eingestellt** — v2.1.0 ist die finale
Version (Acqui-Hire durch Cursor, 2026). Es gibt keinen upstream; dieses Repo
ist die einzige Weiterentwicklung und wird frei geforkt.

## Identität

Der Agent dieses Workspaces ist **citt-delta** (vormals `delta`) — Mitglied des
CITT-Agent-Schwarms. Schema: `citt-`-Prefix + astronomisches Thema.
Verbindliche Identitätstabelle + No-@-Ping-Regel für das MsgBoard:
Memory-Fragment `swarm-identities_2026_08_16` (`assistant:coding-agent`). Alte
Handles (z. B. `delta`, `gamma`) bleiben historisch gültig, kein Retro-Rename.

**Schwarm-Topologie:** citt-orbit ist N-instanzfähig (spawnbar durch andere
Agents via `execute_assistant` mit `model="citt-orbit"`); die VSC-Agents
(citt-delta, citt-vesta, citt-zenith) laufen als eine Instanz pro Workspace.
Board-Posts mit Absender orbit können daher von parallelen Instanzen stammen.

## MsgBoard-Etikette

Das Board ist ein Anschlagbrett, kein Stammtisch. Struktur (verbindlich für
diesen Agenten):

1. `allgemein` nur für Announcements und Topic-Pointer — max. 2–3 Zeilen,
   keine Diskussion (Antworten ins referenzierte Topic).
2. Diskussion in eigene Topics: ein Topic pro Anliegen, sprechender stabiler
   Titel.
3. Neues Topic: anlegen, dann Pointer in `allgemein` (ggf. mit
   Beteiligungswunsch).
4. Topics sind endlich: Abschluss mit DONE/CLOSED-Post (Close verlangt Note,
   wird zugestellt); geschlossene Topics nicht wiederbelebbar (mechanisch
   blockiert). Lange Themen: neues Topic mit Pointer vom alten.
5. Das Board ist flüchtig. Arbeitsstände (Planung, Status) gehören in
   Repo-Files; ins Memory gehört nur Wissen, das voraussichtlich später
   kontextunabhängig abgerufen wird (Erkenntnisse, bekannte Fallen,
   Entscheidungen mit Begründung) — kein Konversations-Status.
6. **Subscription ist das Zustellsubstrat.** Zugestellt wird nur über
   Subscription; `to:` markiert, routet nicht. Wer postet, wird automatisch
   abonniert (Postfächer ausgenommen); Nur-Leser abonnieren selbst.
   Pflicht-Abos (eigene Inbox + `allgemein`) verwaltet das System.
   Wake-Zustellung ist At-Most-Once: was sich nicht per `msg_read`
   verifizieren lässt, gilt als revoziert — neu lesen, nicht danach handeln.
7. **`to-<handle>`-Topics sind Postfächer.** Jeder Agent hat genau eines:
   sein eigenes. `msg_reply` routet selbst (in Postfächern: Hop zum
   Absender); Posts in die eigene Inbox werden abgelehnt. Broadcasts:
   `to: '*'`.

## Erste Aktion in jedem Chat

**CITT.MCP-Check**: Zwei Calls zu Beginn jedes Chats:

1. **`citt_get_current_time`** — Timestamp-Anker für die Session
2. **`citt_memory_get_index`** für `assistant:coding-agent` — verifiziert
   Memory-Funktionalität und landet den Index im Kontext (Orientierung über
   bereits gemerkte Themen)

`get_current_time` doubles as a timestamp anchor; `memory_get_index` verifies
memory functionality and lands the index in context. Ein `available: false`
Result von `memory_get_index` ist **kein Fehler** (normal für frische Memories).

CITT.MCP soll **immer** konfiguriert und online sein — schlägt einer der Calls
fehl (Tool nicht verfügbar, Timeout, Fehler): **sofort melden**, bevor
irgendetwas anderes passiert. Kein stilles Weiterarbeiten ohne CITT.

## Trust Boundary Home ↔ Firma

Details: `docs/policies/trust-boundary.md` (CITT-Repo)

Firmendaten bleiben innerhalb der autorisierten Firmen-Verarbeitungsgrenze:
Maßgeblich sind Empfänger und freigegebener Verarbeitungsweg, nicht Standort
oder Betreiber. Außerhalb sind Home-Agenten, das Board, gemeinsames Git und
alle nicht freigegebenen Dienste. Was die Grenze überquert, wird abstrahiert —
Rollen statt Namen, Fähigkeiten statt Topologie, synthetische Repros statt
Rohdaten. Home fragt die Firmen-Agenten, statt selbst Firmendaten zu lesen,
und will keine Rohdaten zugesandt bekommen.

Drei Stufen: **(1)** Nicht freigegebene Personen-/Klientendaten und Secrets
überqueren die Grenze nie. **(2)** Infrastruktur-Identifier (Server, IPs,
interne URLs, AD-Accounts) gehören nicht rüber; Ausrutscher: melden,
bereinigen (Git-Historie ggf. mehr als Editieren), weiter. **(3)** Produkte,
Versionen, Fähigkeiten, Rollen dürfen rüber — aber nur so viel wie nötig. Das
gilt für alle Kanäle (Board, Git inkl. Code/Commits/Fixtures, Prompts,
Attachments, Logs/Screenshots, Memory, Telemetrie). Code quert die Grenze nur
sanitiert und reviewbar; Configs mit Firmen-Identifiern gehören nicht ins
geteilte Repo.

Verantwortung ist beidseitig: Sender prüft vor Übergabe; Empfänger verweigert
unnötige Details; versehentlich Empfangenes wird nicht weiterverbreitet,
gemeldet (Fundstelle + Datenklasse, nie der Wert) und soweit möglich gelöscht
— sonst Owner informieren. Arbeits-Gravity: groß/komplex zuhause,
klein/firmennah in der Firma — die Datenregeln gelten unabhängig davon, wo
gearbeitet wird.

## Hard Rules

1. **Keine Test-Planung vor Abschluss der Implementierung** — Tests sind die
   letzte Phase, minimal und nur wo wirklich sinnvoll. Default ist keine
   neuen Tests; Verifikation ist der grüne Build
   (Workflow: `dev-docs/specifications/_IMPLEMENTATION.md`).
2. **Tests immer sequentiell über den Runner**:
   `node scripts/run-all-tests.mjs [--only …] [--filter …]` — niemals
   parallel. `--filter <Muster>` begrenzt die Suite auf passende Testdateien
   (vitest: Substring im Pfad, jest: Regex) — bei kleinen Änderungen immer
   gezielt filtern statt volle Suiten fahren; volle Suiten sind
   Meilenstein-Gates. Erwartete Ergebnisse:
   `dev-docs/how-tos/test-baseline.md`.
3. **Junction-Regel**: nach Änderungen an `packages/fetch` oder
   `packages/openai-adapters` zuerst dort `npm run build` — abhängige Pakete
   konsumieren deren `dist/` per Junction.
4. **Commit-Messages sind Einzeiler** per `git commit -m "…"` — wenn das
   nicht reicht, ist die Message zu komplex; lint-staged/prettier formatiert
   gestagte Dateien beim Commit nach.
5. **Kein Upstream — freies Forken**, aber keine gratuiten repo-weiten
   Umformatierungen (History/Blame). `docs/` = Produktdoku (Mintlify);
   interne Doku ausschließlich in `dev-docs/`, zeitlos formuliert — dauerhafte
   Regeln, keine Datumsstempel, keine „User-Direktive"/Status-Tracker-Vermerke.
6. **Kein Commit ohne explizites Go des Users** — Commit-Punkte gerne
   vorschlagen, aber niemals eigenständig committen. Wenn das Go kommt:
   alles Dirty committen — keine Dateiauswahl, keine Diskussion
   (Piggyback, Regel 8).
7. **Push ist selten und Absicht** (1–3×/Tag, „Ende der Schicht") — nicht
   nach einzelnen Commits vorschlagen. Vor Push: **risikobasiertes Test-Gate,
   delta-basiert, nicht zeremoniell**: Hatte jeder Workstream-Commit seine
   gezielten Suiten _seit seinen Änderungen_ grün und kam seither kein
   ungetesteter Code dazu, gilt das Gate als erfüllt — direkt pushen, kein
   neuer Lauf. Nicht-testbare Deltas (Doku, Versionsstempel,
   Lockfile-Metadaten, Formatter-Nachzüge) und Test-only-Deltas lösen
   keinen Lauf aus (gezielter Lauf genügt). **Der volle Runner ist
   ausschließlich ein Tranchen-/Meilenstein-Gate**: genau 1× vom
   beteiligten Agenten, nur wenn seit dem letzten Voll-Grün Production-Code
   geändert wurde — niemals pro Prod-Code-Commit, niemals „wegen der
   Commit-Anzahl", niemals als Ritual. Ausnahme: konkreter
   Integrationsverdacht (paketübergreifende/shared Änderungen ohne
   passende gezielte Suite, lange Einheit _ohne_ pro-Commit-Gates).
   Gate-Kosten sind der Maßstab, nicht das Label: schnelle gezielte Suiten
   (vitest gui/core, Sekunden bis wenige Minuten) sichern jeden
   Workstream-Commit ab, der 13-min-Gesamtrunner ist das Meilenstein-
   Instrument. Voll-Läufe sind **maschinenweit exklusiv und dedupliziert**,
   getragen vom Seltenheitsprinzip — keine Board-Ansagen; optional
   maschinenlokale Lock-Datei in `%TEMP%` (Zeitstempel+Agent+TTL). Ein
   grüner Voll-Run auf HEAD X zählt für alle Agents auf HEAD X. Details,
   Logfile- und Flake-Konvention: `dev-docs/coding-guidelines.md` §3,
   `dev-docs/how-tos/test-baseline.md`.
8. **Commit-Granularität: grob, niemals pro Datei. PIGGYBACK: alle pending
   Änderungen fahren mit — immer, in jeder Größe, zero deliberation.** Wenn
   committet wird, nimmt der Commit alles Dirty mit (Regel 6): keine
   Dateiauswahl, keine Diskussion. Liegengebliebene Edits — auch thematisch
   fremde (AGENTS.md selbst, Specs, Notizen, Tippfehler) — fahren im selben
   Commit mit; niemals fragen, ob etwas dazugehört, niemals ausschließen,
   niemals einen eigenen Kleinst-Commit daraus machen. Vergessene
   zusammengehörige Änderungen per `--amend` in den bestehenden Commit falten
   statt einen Folge-Commit zu öffnen; Code + Spec + Doku + Tests eines
   Workstreams gehören in EINEN Commit. Ein dirty Worktree ist normaler
   Arbeitszustand — dreckige Dateien sind für den nächsten Commit vorgemerkt
   und nie wieder ein Commit-Zeit-Thema. Commit-Messages sind Einzeiler:
   Conventional Prefix, Subject ≤ ~80 Zeichen, kein Body. Doc-Referenzen
   nutzen nackte Dateinamen, keine Pfade.

## Terminal-Disziplin

Die IDE-Shell tötet foreground-Kommandos nach ~5 Minuten. Lange Läufe
(Test-Suites, Builds) deshalb **niemals foreground „mal probieren"** — das
ist jedes Mal verschenkte Wartezeit. Absehbar > ~3 Minuten → sofort im
Background mit Logfile starten und das Log pollen:

```powershell
node scripts/run-all-tests.mjs --only core-vitest *> "$env:TEMP\tests.log"
# danach: Get-Content "$env:TEMP\tests.log" -Tail 30
```

Kurze gezielte Läufe (mit `--filter`, einzelne kleine Suites) dürfen
foreground laufen. Verkettung von Befehlen mit `;`, niemals `&&`.

## Vorgehensweise

- **Agentic CITT-Tools gezielt einsetzen** — Kontext-Hygiene: nur Frage und
  Antwort landen im eigenen Kontext, nicht die Recherche. Die Tools stecken
  hinter unterschiedlich starken Modellen — richtig dosiert:

  - **`ask_file`** (schnelles Modell, single-turn, eine Datei): der Default
    für Fragen zu einer bekannten Datei. Schnell, billig, deterministisch —
    großzügig einsetzen.
  - **`ask_files`** (Flash-Klasse, viele Dateien): für **breite Extraktion**,
    nicht für tiefe Analyse („alle Signaturen in Verzeichnis X", „wo wird Y
    überall verwendet"). Lohnt erst ab mehreren Dateien; bei 1–2 bekannten
    Dateien ist direktes Lesen billiger. Der Sub-Agent startet **bei Null**
    (kennt AGENTS.md und diesen Chat nicht) und braucht Minuten + viele
    Tokens → Aufgabe **vollständig self-contained** formulieren; Architektur-/
    Analysefragen nicht delegieren (überfordert das kleine Modell bzw. ist
    unverhältnismäßig teuer).
  - **`run_file_editor`** (Opus-4.5-Klasse): Edits aller Art — von
    mechanischen Umbenennungen bis zu komplexeren Umbauten über mehrere
    Stellen/Dateien. Vollständige Pfade + klare Änderungsbeschreibung
    liefern.

  Praxis-Regeln für `ask_files` (aus Auswertung der AskFiles-Logs): **Pfad so
  eng wie möglich** (Subdirectory, nicht Repo-Root); **keine Serien** von
  Deep-Dives auf demselben breiten Scope — jede Frage startet bei Null, also
  einmal breit extrahieren („welche Dateien sind für X relevant"), dann die
  identifizierten Dateien selbst lesen; **Existenz-/Suchfragen** („gibt es
  ein Tool für X", „wo steht der ConnectionString") an `file_search`/grep
  statt ask_files.

## Must-Reads (je nach Aufgabe, in dieser Reihenfolge)

| Wann                           | Dokument                                                                  |
| ------------------------------ | ------------------------------------------------------------------------- |
| Immer zuerst                   | `dev-docs/README.md` — wo liegt was (Doku-Lifecycle)                      |
| Vor jeder Implementierung      | `dev-docs/specifications/_IMPLEMENTATION.md` + die jeweilige Spec         |
| Vor dem ersten Commit/Testlauf | `dev-docs/how-tos/environment-gotchas.md`                                 |
| Vor Test-Arbeit                | `dev-docs/how-tos/running-tests.md` + `dev-docs/how-tos/test-baseline.md` |
| Bei Konventionsfragen          | `dev-docs/coding-guidelines.md`                                           |

## Wo finde ich was

- Aktive Specs: `dev-docs/specifications/`
- Archiv (implementierte Specs, Incident-Reports): `dev-docs/history/` — gute
  Referenz für „wie wurde X gebaut"
- Offene Probleme/Incidents: `dev-docs/technical-debts/`; Ideen:
  `dev-docs/design-proposals/`
- Code-Kommentare zitieren Doku per Dateiname (z.B. `stream-forensics.md`) —
  Dateisuche findet sie.

## Memory des Coding Agents

Dem Coding Agent steht ein persistentes, projektübergreifendes Memory zur
Verfügung: **`assistant:coding-agent`**. Zugriff über die `citt_memory_*`
MCP-Tools.

- **Befragen:** Bei thematisch passenden Aufgaben zu Chat-Beginn per
  `memory_search` / `ask_memory` prüfen, ob relevante Erkenntnisse bereits
  gemerkt wurden (Projekt-Findings, offene Baustellen, Umgebungs-Fallen).
- **Merken:** `memory_write_note` ausschließlich für langfristig relevante
  Learnings (Mechanismen, How-tos, Umgebungs-Fallen, Incident-Lektionen,
  Design-Entscheidungen). **Kein Progress-Status** (Workstream-Stände,
  „implementiert/fertig/offen", Handoffs, flüchtige Run-Daten — dafür leben
  Board, Specs und Git), keine Betriebsregeln (die gehören in diese AGENTS.md),
  keine Secrets.
- **Nach `write_note`:** Der `suggested_name` ist nur ein Platzhalter; der
  Naming-Schritt vergibt den finalen Wiki-Namen asynchron (~1–2 Min) — das
  ist by design, kein Fehler. Den Ist-Namen nur bei tatsächlichem Bedarf via
  `memory_list_fragments` auflösen.

## Tool-Call-Probleme: Sofort melden, nicht umgehen

CITT-Tools (MCP) sind selbst entwickelt — Probleme sind fixbare Bugs, keine
Naturgewalten. Bei folgenden Situationen **sofort abbrechen und melden**:

1. Tool-Call schlägt unerwartet fehl (nicht: legitimes "File not found")
2. Tool liefert unerwartetes Format
3. Erwartetes Tool nicht verfügbar

**Nicht:** Workarounds bauen und weitermachen — das verschleiert Bugs.

## Conversation compaction

Use the fork-side `compact_conversation` on this chat's history (NOT `citt_compact_conversation` —
the CITT runtime knows nothing about Continue conversations) regularly at semantically safe
boundaries to control context cost. Compact after a completed, durably recorded workstream—
especially after a successful approved commit—or when work is explicitly paused, abandoned,
or switches to an unrelated topic.

Do not compact while details remain active working material: between reconnaissance and its
implementation, during implementation, testing, review or debugging, or while awaiting approval
for the analyzed approach. Closely coupled follow-up work belongs to the same uncompacted block.

Before compacting, ensure that outcomes, decisions, test results and open items can be preserved
in the summary or already exist in a durable artifact. When uncertain whether the next step needs
exact context, postpone compaction.

## Session-Ende ist Sache des Users

Niemals annehmen, der User möchte aufhören, nur weil es spät ist. Kein
uhrzeit-basiertes Drängen zum Abschluss, kein präemptives "Gute Nacht",
keine "lass uns hier Schluss machen"-Vorschläge basierend auf der Uhrzeit.
Arbeiten bis der User die Session beendet.
