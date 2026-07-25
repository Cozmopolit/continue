# Coding Guidelines (Continue-Fork)

Dauerhafte Konventionen für Arbeit an diesem Repo. Ergänzt den Workflow in
`specifications/_IMPLEMENTATION.md` — dort steht das Phasenmodell, hier die
Spielregeln. Zielgruppe: Entwickler und Coding Agents.

## 1. Fork-Strategie: Upstream-Hygiene

Dieses Repo ist ein **Fork von continuedev/continue**; upstream Merges finden
statt und sind Handarbeit. Alles Folgende dient dazu, sie billig zu halten:

- **Chirurgische Diffs**: so wenig upstream Code anfassen wie möglich. Keine
  Reorgs, keine Umbenennungen, kein Reformatieren upstream Dateien.
  (lint-staged/prettier formatiert nur gestagte Dateien — niemals repo-weit
  formatieren.)
- **Fork-Features additiv und opt-in**: neue Fähigkeiten als Erweiterung,
  idealerweise hinter Flag/Env-Var — gelebte Muster:
  `CONTINUE_STRICT_STREAM_TERMINATION` (stream termination guard),
  `experimental.promptLogs` (opt-in prompt logging).
- **Abweichungs-Kommentare erklären das Warum** und referenzieren das
  zugehörige Doc in `dev-docs/` **per Dateiname** (`stream-forensics.md`),
  nie per Pfad.
- **`docs/` ist upstream** (Mintlify-Produktdoku) — interne Doku ausschließlich
  in `dev-docs/`.
- **GitHub CI ist im Fork deaktiviert** — nicht reaktivieren. Der Gate ist die
  lokale Test-Baseline (`how-tos/test-baseline.md`) via Runner.
- **Neue Dependencies nur nach Absprache** — sie erschweren Upstream-Merges
  und die Corporate-Freigabe.

## 2. Code-Stil

- **Match the surrounding code**: Stil der Datei/des Packages gilt (upstream
  Konventionen); Prettier übernimmt die Formatierung beim Commit.
- **Funktional wo praktikabel**: pure Funktionen bevorzugen; neue pure
  Funktionen bekommen Unit-Tests (Normal-, Edge-, Grenzfälle) — in Phase 4,
  nicht während der Implementierung.
- **Englisch** für Code, Kommentare, Logs (upstream ist englisch; interne
  Doku in `dev-docs/` darf deutsch sein).
- **KISS / kein Over-Engineering**: das Problem lösen, das ansteht —
  Verbesserungsideen als Vorschlag (ggf. in `design-proposals/`), nicht
  mitbauen.
- **No silent fallbacks**: Fehler sichtbar machen statt verstecken. Leitbild:
  `PrematureStreamEndError` — ein stiller Stream-Abbruch wurde bewusst in
  einen lauten, diagnostizierbaren Fehler verwandelt.
- **Token-Effizienz**: Code und Kommentare knapp halten — diese Codebase wird
  regelmäßig von LLMs gelesen; Kommentare erklären das Warum, nicht das Was.

## 3. Commit- & Push-Policy

Damit das nicht in jedem Chat neu verhandelt wird:

- **Granularität**: relativ komplette Features, die eine Verhaltensänderung
  vollständig abbilden. **Tests als getrennter Commit** (nach dem
  Feature-Commit). Kleinigkeiten und Spec-Updates reiten in beliebigen
  Commits mit — Spec-Pflege ist Dauerzustand, kein eigener Commit-Anlass.
- **Commit-Freiheit**: jederzeit committen, wenn es sich richtig anfühlt —
  auch zwischen Implementierungsphasen. Granularität nach Bauchgefühl und
  Feature-Größe.
- **Messages kompakt**: kurzer Subject (Prefixe wie bisher: `feat(…):`,
  `fix:`, `test:`, `docs:`, `chore:`), Body nur wenn er echten Kontext
  liefert. BOM-frei (siehe `how-tos/environment-gotchas.md`).
- **Push ist selten**: 1–3× pro Tag, typischerweise „am Ende der Schicht".
  **Nicht-Pushen ist der Default** — Agents schlagen keinen Push nach
  einzelnen Commits vor.
- **Vor dem Push**: idealerweise voller Runner-Lauf
  (`node scripts/run-all-tests.mjs`, ~13 min) — gepusht wird nur bei Grün
  (Abgleich gegen `how-tos/test-baseline.md`).
