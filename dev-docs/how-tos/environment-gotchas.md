# Environment & Tooling Gotchas (Windows-Dev-Machine)

Gesammelte Fallstricke, die wiederholt Zeit gekostet haben. Referenziert von
`specifications/_IMPLEMENTATION.md`.

## PowerShell

- `&&` ist ungültig → `;` zur Verkettung verwenden.
- `>` / `Out-File` / `Tee-Object` schreiben UTF-16 (PS 5.1) → Dateien, die
  Tools als UTF-8 erwarten, nie per Redirect schreiben. Kanonische Form für
  Logs: `… 2>&1 | Out-File -Encoding utf8 <datei>.log`, Tail per
  `Get-Content -Tail` (s. running-tests.md „Ad-hoc-Einzelläufe").

## Git / Commits

- **Commit-Messages sind Einzeiler** per `git commit -m "…"` — wenn das
  nicht reicht, ist die Message (oder der Commit) zu komplex. Keine
  mehrzeiligen Messages, keine Message-Files, keine Workarounds: genau die
  haben historisch die BOM/UTF-16-Probleme und die langen Anleitungen dazu
  erzeugt.
- **lint-staged/prettier läuft bei jedem Commit** und formatiert gestagte
  Dateien (`*.{js,jsx,ts,tsx,json,css,md}`) nach — Diff danach kurz prüfen.
- Selten landet Konsolen-Müll (z.B. `StruStr`-Bytes) während des
  lint-staged-Laufs in Working-Tree-Dateien → `git status` nach dem Commit
  prüfen; betroffene Datei mit `git restore <file>` zurücksetzen (der Commit
  selbst war bislang immer sauber).
- autocrlf: CRLF in Test-Fixtures beachten; Symlinks brauchen Entwicklerprivileg.

## Package-Junctions (wichtigster Repo-Fallstrick)

- `packages/*/node_modules/@continuedev/fetch` ist eine **Junction auf
  `packages/fetch`** (main: `dist/index.js`). Nach Änderungen an `packages/fetch`
  oder `packages/openai-adapters`: dort `npm run build` (tsc) ausführen, sonst
  laufen abhängige Tests gegen den alten dist-Stand.
- Ein `npm install` kann die Junction durch eine echte Kopie ersetzen — bei
  „meine Änderung greift nicht"-Symptomen die Junction prüfen.

## Tests ausführen

- Immer sequentiell: `node scripts/run-all-tests.mjs [--only id1,id2]`
  (Details: `running-tests.md`; erwartete Ergebnisse: `test-baseline.md`).
- Ambient ist `FORCE_COLOR=1` gesetzt — der Runner setzt selbst `FORCE_COLOR=0`;
  bei manuellen Suite-Aufrufen selbst setzen (Substring-Assertions auf styled
  Output brechen sonst).
- Foreground-Timeout des Terminals ≈ 5 min → lange Läufe in den Hintergrund +
  Polling; Ergebnis in `%TEMP%\continue-test-report\report.json`.
- TUI-Flakes in `extensions/cli`: bei rotem Voll-Lauf die betroffene Suite
  zuerst solo neu laufen lassen, bevor triagiert wird.

## Tooling

- Der `grep_search`-Index kann frisch geschriebene Inhalte noch nicht kennen →
  zur Not `file_pattern_search` direkt auf die Datei.
- `file_replace_pattern` auf Markdown-Tabellen: Padding aus der Read-Ansicht
  stimmt oft nicht mit dem Dateiinhalt überein → Anker klein wählen oder
  `file_insert` (insertAfterLine) verwenden.
- OpenSSL liegt nur im Git-Bundle-Pfad.
