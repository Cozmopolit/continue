# Environment & Tooling Gotchas (Windows-Dev-Machine)

Gesammelte Fallstricke, die wiederholt Zeit gekostet haben. Referenziert von
`specifications/_IMPLEMENTATION.md`.

## PowerShell

- `&&` ist ungültig → `;` zur Verkettung verwenden.
- `>` / `Out-File` schreibt UTF-16 → Dateien, die Tools als UTF-8 erwarten,
  nie per Redirect schreiben.

## Git / Commits

- **Commit-Message-Policy: `-m`-One-Liner bevorzugen.** Wenn
  `git commit -m "…"` nicht reicht, ist die Message (oder der Commit) zu
  komplex. Mehrzeilige Messages bleiben möglich — dann Message-File korrekt
  verwenden (nächste beiden Punkte).
- **`git commit -F` ist encoding-neutral:** `-F` liest eine vorhandene Datei
  (mehrzeilig problemlos) und erzeugt sie weder noch wählt es ihr Encoding.
  Die historischen BOM/UTF-16-Probleme kamen vom Schreiben der Datei, nicht
  von `-F`.
- **UTF-8-Message-File ohne BOM:** nie per `>`/`Out-File`/`Set-Content`
  schreiben (UTF-16-/BOM-Gefahr), sondern nur via Here-String `@'…'@` +
  `[System.IO.File]::WriteAllText($path, $msg, [System.Text.UTF8Encoding]::new($false))`.
  (Ein BOM ist so schon einmal in der Subject-Zeile gelandet.)
- `node -e`-Quoting in PowerShell ist brüchig (eingebettete Anführungszeichen)
  → lieber .NET `WriteAllText`.
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
