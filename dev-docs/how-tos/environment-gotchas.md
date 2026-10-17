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

## Package-Verlinkung (file:-Manifeste seit 2026-10-17)

- Interne `@continuedev/*`-Referenzen in `packages/*` und `core` stehen als
  **`file:../<pkg>`** im Manifest — npm legt die Junctions auf die lokalen
  Packages bei `npm install` selbst an. (Vorher: Semver-Refs aufs Registry +
  manuell gepflegte Junctions, die jeder Clean-Rebuild zerstörte — das ist
  seit der file:-Umstellung Geschichte.)
- Weiterhin gültig: abhängige Pakete konsumieren `dist/` des verlinkten
  Packages (main: `dist/index.js`). Nach Änderungen an `packages/fetch` oder
  `packages/openai-adapters`: dort `npm run build` (tsc) ausführen, sonst
  laufen abhängige Tests gegen den alten dist-Stand.

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

## Node 24 / npm 11 (Stand 2026-10-17)

- **Portable Node** (kein Admin nötig): ZIP von nodejs.org nach
  `C:\Users\Zuser\tools\` entpacken, pro Terminal-Aufruf
  `$env:PATH = 'C:\Users\Zuser\tools\node-v24.22.0-win-x64;' + $env:PATH`
  voranstellen (die IDE-Shell ist nicht stateful).
- **PS 5.1 + `$ErrorActionPreference='Stop'` + `2>&1`**: native stderr
  (z.B. jede npm-Warnung) wird zur _terminating error_ und bricht die
  Pipeline beim ersten Warnwort ab. In Wrapper-Funktionen EAP lokal auf
  `'Continue'` stellen; Exitcode-Check (`$LASTEXITCODE`) fängt echte Fehler.
- **npm 11.19: Install-Skripte brauchen Freigabe** (`allowScripts`) —
  Warnung `npm warn install-scripts ... approve to allow` ernst nehmen:
  Skripte werden sonst übersprungen (`@vscode/ripgrep`-Binary,
  `sqlite3`-Build liefen dann nicht bzw. in undefiniertem Zustand).
- **sqlite3 unter Node 24**: „prebuild-install: This package does not
  support N-API version **undefined**" = stale **`node-abi`** im Lockfile
  (<3.92 kennt Node 24 nicht → Fallback node-gyp 8 → bricht ohne VS-C++-
  Workload). Fix: Override `node-abi ^3.92.0` (siehe
  `extensions/vscode/package.json`).
- **`extensions/vscode` installiert bewusst mit `--ignore-scripts`**
  (+ `npm rebuild esbuild`): sqlite3 (via dbinfoz transitiv) würde sonst
  node-gyp anwerfen; sein Binary wird hier nicht gebraucht — die
  VSIX-sqlite3 kopiert `scripts/prepackage.js` aus `core/node_modules`,
  und dbinfoz/@database ist ungenutzt.
- **`@vscode/ripgrep` hat kein postinstall mehr** — `rg.exe` aus
  `@vscode/ripgrep-win32-x64/bin` nach `@vscode/ripgrep/bin` kopieren,
  sonst scheitert `prepackage.js` an `validateFilesPresent`.
- **VS Code (tsserver/Watcher) hält Locks auf Repo-`node_modules`**
  (Repo ist als Workspace geöffnet): npm-Cleanup scheitert mit
  EPERM/EBUSY → Reify-Rollbacks, halbe Bäume, „Geister"-Pakete. Bei
  mysteriösen Install-Fails zuerst an diese Locks denken.
