# AGENTS.md — Bootstrap für Coding Agents (Continue-Fork)

Du arbeitest am **Fork von Continue** (Coding Assistant für VS Code/JetBrains),
angepasst für Corporate-Use hinter dem CITT MCP-Tunnel. Monorepo (npm):
`core/`, `gui/`, `packages/*`, `extensions/{vscode,cli}`, `binary/`.

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
5. **Upstream-Hygiene**: chirurgische Diffs, kein Reformatieren upstream Codes,
   Fork-Features additiv/opt-in. `docs/` ist upstream (Mintlify) — interne
   Doku ausschließlich in `dev-docs/`.
6. **Push ist selten und Absicht** (1–3×/Tag, „Ende der Schicht") — nicht
   nach einzelnen Commits vorschlagen. Vor Push: voller Runner-Lauf, nur bei
   Grün (`dev-docs/coding-guidelines.md` §3).

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
