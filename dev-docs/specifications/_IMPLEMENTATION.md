<!-- META-DOC (Underscore-Konvention wie _TEMPLATE.md).
     Zweck: Wird jedem Implementierungs-Chat zusammen mit der jeweiligen Spec
     als Kontext gegeben. Enthält (1) den Dokument-Lifecycle und (2) Spielregeln
     für die Implementierung. Keine Feature-Inhalte hier.
     Adaptiert von CITT-Solution/CITT/docs/specifications/_IMPLEMENTATION.md
     auf dieses Repo (Stand 2026-07-25). -->

# Spec-Workflow & Implementation Playbook (Continue-Fork)

## 1. Dokument-Lifecycle

```
dev-docs/design-proposals/ ──┐
 (Idee ohne Lösung)          ├──→ dev-docs/specifications/ ──→ Implementierung
dev-docs/technical-debts/ ───┘    (Spec per _TEMPLATE.md)          ──→ (optional: CodeRabbit)
 (Problem ohne Lösung)            ──→ Tests ──→ dev-docs/history/specifications/

Incidents:  offen/Analyse ──→ dev-docs/technical-debts/
            abgeschlossen ──→ dev-docs/history/incidents/
```

1. **Idee oder Problem**: Idee/Feature-Request ohne Lösungsreife → `dev-docs/design-proposals/`. Problembeschreibung ohne Lösung → `dev-docs/technical-debts/`. Offene Incidents liegen ebenfalls in `technical-debts/` — bis Analyse + Maßnahmen abgeschlossen sind, dann → `history/incidents/`.
2. **Spec-Ausbau**: Das Dokument wird nach `dev-docs/specifications/` **verschoben** (nicht kopiert) und dort per `_TEMPLATE.md` zur Spec ausgebaut (additiv — Analyse, Entscheidungen und Implementation Checklist kommen zur Problembeschreibung dazu). Eine fertige Spec enthält keine offenen Entscheidungen mehr — und **keine Test-Planung** (siehe `_TEMPLATE.md`).
3. **Implementierung → (optional) CodeRabbit → Tests → Commit**: Phasenmodell unten.
4. **Archivierung**: Wenn Implementierung + Tests abgeschlossen sind, Spec nach `dev-docs/history/specifications/` verschieben. Beim Verschieben Intra-Doc-Links mitziehen.

**Referenz-Konvention**: Code-Kommentare zitieren Dokumente **nur per Dateiname** (`stream-forensics.md`), nie per Verzeichnispfad. Der Dateiname überlebt Lifecycle-Moves, der Pfad fault — Moves bleiben dadurch gratis. Relative Links nur zwischen Docs.

## 2. Phasenmodell

**Verbindlich ist die Reihenfolge der Phasen, nicht die Chat-Mechanik.** Ob eine Spec-Umsetzung in einem Chat (ggf. mit Conversation-Summary/Compaction zwischendurch), in mehreren Chats oder als getrennte Workstreams abläuft, ist frei. Verbindlich ist: **keine Test-Planung in der Spec, keine Tests vor Abschluss der Implementierung.**

### Phase 1: Recon & Readiness-Check (immer zuerst, read-only)

Ziel: Verifizieren, dass die Spec wie geschrieben gegen den echten Code umsetzbar ist — und Design-Fragen **vor** der Implementierung klären, nicht mittendrin.

1. Spec vollständig lesen. Die Implementation Checklist ist die Landkarte.
2. Von der Checklist genannte Dateien **direkt** lesen (gezielt, gern mit Zeilenbereichen).
3. Breitere Fragen per `ask_files` / `ask_file` delegieren — hält den Kontext klein. Breite Glob-Scans auf Repo-Roots vermeiden.
4. Annahmen der Spec gezielt prüfen: Existieren die genannten Dateien, Klassen, Signaturen? Stimmen Caller-/Consumer-Aussagen — oder gibt es weitere Aufrufer, die die Spec nicht kennt? Passen geforderte Defaults und neue Parameter in die bestehenden Aufrufketten?

**Verbindlicher Output** (vor jeder Code-Änderung): Entweder **Ready** (kompakt: was wo geändert wird, welche Schlüsselannahmen verifiziert wurden, verbleibende Risiken) oder **Design-Fragen** (nummeriert: Fund im Code, Konflikt/Lücke in der Spec, Optionen mit Empfehlung). Keine Code-Änderungen in Phase 1.

### Phase 2: Implementierung (nur nach explizitem „Go")

- **Die Spec ist die Single Source of Truth.** Nicht neu verhandeln, nicht still „verbessern". Neue Lücke mitten in der Implementierung entdeckt → stoppen und zurückmelden, nicht improvisieren.
- **Konventionen folgen**: bestehende Muster des jeweiligen Packages übernehmen.
- **Mechanische Edits an `run_file_editor` delegieren** (vollständige Pfade + klare Änderungsbeschreibung) — oft massiv token-effizienter als Serien von Einzel-Ersetzungen.
- **Keine Tests.** Keine Test-Dateien anlegen, keine Test-Strategie diskutieren — Tests sind Phase 4.
- **Verifikation**: Build des betroffenen Packages muss grün sein (`npm run build` / `tsc`). **Junction-Regel**: nach Änderungen an `packages/fetch` oder `packages/openai-adapters` diese erst bauen, bevor abhängige Pakete getestet werden (Details: `how-tos/environment-gotchas.md`).
- **Spec nachziehen** (vor dem Abschluss-Report): erledigte Checklist-Items auf `[x]`, Status → **Implementiert**.
- **Abschluss-Report**: pro Checklist-Item kurz (was geändert, wo). Jede Abweichung von der Spec explizit nennen.

### Phase 3 (optional): CodeRabbit-Review

- Der User lässt **manuell** CodeRabbit (VS-Code-Extension) über die Änderungen laufen.
- Jedes Finding wird **einzeln** evaluiert — alles von „won't do" bis „klar, machen wir". Findings werden **verifiziert, nicht blind übernommen**; die Spec bleibt die Referenz (widersprechende Findings werden mit kurzer Begründung zurückgewiesen).
- Fixes für verifizierte Probleme implementieren; Build danach wieder grün.
- Wird Phase 3 übersprungen: Self-Review des Diffs (`git diff`) vor dem Test-Start.

### Phase 4: Tests (erst nach Abschluss der Implementierung)

- Tests werden **gegen die finale Implementierung** geschrieben, nicht gegen die Spec.
- Neue pure Funktionen: Unit-Tests für Normalfälle, Edge-Cases und Grenzfälle. Suite-Konventionen des jeweiligen Packages folgen (jest/vitest, Tests liegen neben dem Code).
- **Verifikation**: gezielte Suites laufen lassen; bei Änderungen an Kern-Paketen (`packages/fetch`, `packages/openai-adapters`, `core`) Regression über den Runner: `node scripts/run-all-tests.mjs --only …` (Details: `how-tos/running-tests.md`; lange Läufe im Hintergrund + Polling).
- **Baseline-Abgleich** gegen `how-tos/test-baseline.md`: dokumentierte pre-existing Failures sind ok, neue sind es nicht.

### Commits

- **Feature-Commit** nach Abschluss von Phase 2/3 (vollständige Verhaltensänderung), **Tests als getrennter Commit** nach Phase 4.
- Kleinigkeiten und Spec-Updates reiten in beliebigen Commits mit — Spec-Pflege ist Dauerzustand.
- **Kein Commit ohne explizites Go des Users** — der Agent schlägt Commit-Punkte vor (typisch: Feature-Commit nach Phase 2/3, Test-Commit nach Phase 4), committet aber niemals eigenständig. Messages kompakt halten.
- Commit-Message **BOM-frei** schreiben (Verfahren: `how-tos/environment-gotchas.md`); lint-staged/prettier formatiert gestagte Dateien beim Commit nach — kurz gegenprüfen.
- **Push ist selten** (1–3×/Tag, typischerweise „am Ende der Schicht") — Details: `../coding-guidelines.md` §3. Nicht nach einzelnen Commits zum Push raten; vor dem Push idealerweise voller Runner-Lauf, nur bei Grün.
