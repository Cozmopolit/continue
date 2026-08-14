# How-To: Tests laufen lassen

Kurzfassung für Mensch und Assistent. Erwartete Ergebnisse, Umgebungs-Fallen
und das Repair-Log stehen in [test-baseline.md](test-baseline.md).

## Schnellstart

```powershell
# Alles (sequentiell, ~13 Minuten) — der Standard-Gate vor Commits/Push
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

## Bei Failures

1. **Zuerst die betroffene Datei solo nachlaufen lassen** — unter Volllast
   flaken bekannte Kandidaten (test-baseline.md, "Bewusst nicht behoben"):
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
