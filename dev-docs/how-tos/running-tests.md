# How-To: Tests laufen lassen

Kurzfassung für Mensch und Assistent. Erwartete Ergebnisse, Umgebungs-Fallen
und das Repair-Log stehen in [test-baseline.md](test-baseline.md).

## Schnellstart

```powershell
# Alles (sequentiell, ~13 Minuten) — Meilenstein-Gate, kein Routine-Lauf
npm run test:all

# Nur bestimmte Suites
node scripts/run-all-tests.mjs --only gui,core-jest

# Inventar anzeigen
node scripts/run-all-tests.mjs --list
```

Exit-Code `0` = alle ausgeführten Suiten grün (Skips zählen nicht als Fehler).
Am Ende steht eine Summary-Tabelle; Details pro Suite im Report-Dir
(`%TEMP%\continue-test-report\`: `<suite>.log` + maschinenlesbares `report.json`).

## Verhalten des Runners (by design)

- **Sequentiell, nie parallel.** Mehrere Suiten gleichzeitig verursachen
  Timing-Flakes (siehe test-baseline.md, Gotcha #6). Kein `--parallel`-Flag
  hinzufügen, ohne die Flake-Liste zu kennen.
- Kindprozesse laufen mit `CI=true`, `NO_COLOR=1`, **`FORCE_COLOR=0`**
  (Gotcha #1). Nicht "zurückdrehen".
- Suites ohne `node_modules` werden mit Hinweis geskipt (erst `npm install`
  im Suite-Verzeichnis). `binary` wird immer geskipt (Integrationstest
  braucht das gebaute Binary).
- Pro Suite 20 min Timeout (`--timeout <min>` änderbar).
- **Junction-Regel**: Nach Änderungen an `packages/fetch` /
  `packages/openai-adapters` zuerst dort `npm run build` — sonst laufen
  auch gefilterte Suites gegen stale `dist/` und beweisen nichts.

## Ad-hoc-Einzelläufe (Logs)

Manuelle Läufe außerhalb des Runners schreiben ihre Ausgabe in eine
zeitgestempelte Datei (UTF-16-Falle beachten, environment-gotchas.md):

```powershell
cd <suite-dir>; npx vitest run <datei> 2>&1 | Out-File -Encoding utf8 "$env:TEMP\continue-test-report\manual\<yyyyMMdd-HHmmss>-<suite>.log"
Get-Content "$env:TEMP\continue-test-report\manual\<...>.log" -Tail 40
```

Kein Tee-Object, kein nacktes `>`; Volltext auf Platte, Tail im Chat.
Flake-Disziplin und Gate-Modell: coding-guidelines.md §3.

## Test-Disziplin (Swarm-Beschluss 2026-08-20, verbindlich)

- **Verifikations-Scope = Änderungs-Scope.** Betroffene Suiten einmal +
  Typecheck; keine Test-Entwicklung für Abraum (weggeworfener Code).
- **Verifikations-Budget:** Re-Runs nur bei Failure, gedeckelt auf max. 2;
  danach melden statt weiterlaufen lassen.
- **Bekannte Flakes werden nicht gejagt.** In test-baseline.md dokumentiert
  = keine Isolations-Runs (Baseline-Referenz genügt). Neuer Flake: max.
  zwei Solo-Runs, klassifizieren, dokumentieren — der Fix ist ein eigener
  Workstream.
- **„Fertig" definiert der Task, nicht perfektes Grün.** Dokumentiertes
  Baseline-Rot blockiert nicht.
- **Typecheck läuft mit** (`cd gui; npx tsc --noEmit`) — Vitest allein
  fängt Typfehler nicht (Beispiel: `boardV2`-Typfehler am 2026-08-20).

## Bei Failures

1. **Zuerst die betroffene Datei solo nachlaufen lassen** (max. zwei
   Solo-Runs, s. Test-Disziplin; bekannte Flakes: nur Baseline-Referenz) —
   unter Volllast flaken bekannte Kandidaten (test-baseline.md, "Bewusst
   nicht behoben"):
   ```powershell
   cd <suite-dir>; npx vitest run <pfad/zur/datei.test.ts>   # vitest
   cd core; npm test -- <pfad>                               # jest (core)
   ```
2. Solo ebenfalls rot → gegen die Erwartungs-Tabelle und Gotchas in
   test-baseline.md abgleichen. Neuer Failure = echte Regression der
   aktuellen Arbeit oder neuer Upstream-Drift.
3. Solo grün → Last-Flake; in test-baseline.md bei den bekannten Flakes
   ergänzen.

## Neue Suite aufnehmen

Einen Eintrag in `SUITES` in `scripts/run-all-tests.mjs` ergänzen
(`id`, `label`, `dir`, `cmd`/`args`, `runner: "jest" | "vitest"`) und die
Erwartungs-Tabelle in test-baseline.md aktualisieren. Fertig — mehr Pflege
gibt es nicht.

## Baseline pflegen

- Nach jeder bereinigten Failure-Welle: Erwartungs-Zahlen + Repair-Log in
  test-baseline.md aktualisieren.
- Repair-Log-Einträge knapp halten: Suite, Ursache, Fix-Ansatz (Details
  gehören hierhin, nicht in die Commit-Message — die ist ein Einzeiler).
