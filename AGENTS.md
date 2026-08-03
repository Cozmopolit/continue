# AGENTS.md — Bootstrap für Coding Agents (Continue-Fork)

Du arbeitest am **Fork von Continue** (Coding Assistant für VS Code/JetBrains),
angepasst für Corporate-Use hinter dem CITT MCP-Tunnel. Monorepo (npm):
`core/`, `gui/`, `packages/*`, `extensions/{vscode,cli}`, `binary/`.

**Wichtigster Kontext: Continue ist eingestellt** — v2.1.0 ist die finale
Version (Acqui-Hire durch Cursor, 2026). Es gibt keinen upstream; dieses Repo
ist die einzige Weiterentwicklung und wird frei geforkt.

## Erste Aktion in jedem Chat

**CITT.MCP-Check**: Ein triviales `citt_`-Tool aufrufen (z.B. `citt_get_current_time`)
und das Ergebnis kurz bestätigen. CITT.MCP soll **immer** konfiguriert und
online sein — schlägt der Call fehl (Tool nicht verfügbar, Timeout, Fehler):
**sofort melden**, bevor irgendetwas anderes passiert. Kein stilles
Weiterarbeiten ohne CITT.

## Hard Rules

1. **Keine Test-Planung vor Abschluss der Implementierung** — Tests sind die
   letzte Phase, geschrieben gegen die finale Implementierung
   (Workflow: `dev-docs/specifications/_IMPLEMENTATION.md`).
2. **Tests immer sequentiell über den Runner**:
   `node scripts/run-all-tests.mjs [--only …]` — niemals parallel. Erwartete
   Ergebnisse: `dev-docs/how-tos/test-baseline.md`.
3. **Junction-Regel**: nach Änderungen an `packages/fetch` oder
   `packages/openai-adapters` zuerst dort `npm run build` — abhängige Pakete
   konsumieren deren `dist/` per Junction.
4. **Commit-Messages BOM-frei** (Verfahren:
   `dev-docs/how-tos/environment-gotchas.md`); lint-staged/prettier formatiert
   gestagte Dateien beim Commit nach.
5. **Kein Upstream — freies Forken**, aber keine gratuiten repo-weiten
   Umformatierungen (History/Blame). `docs/` = Produktdoku (Mintlify);
   interne Doku ausschließlich in `dev-docs/`.
6. **Kein Commit ohne explizites Go des Users** — Commit-Punkte gerne
   vorschlagen, aber niemals eigenständig committen.
7. **Push ist selten und Absicht** (1–3×/Tag, „Ende der Schicht") — nicht
   nach einzelnen Commits vorschlagen. Vor Push: voller Runner-Lauf, nur bei
   Grün (`dev-docs/coding-guidelines.md` §3).

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
