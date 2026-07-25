# Coding Guidelines (Continue-Fork)

Dauerhafte Konventionen für Arbeit an diesem Repo. Ergänzt den Workflow in
`specifications/_IMPLEMENTATION.md` — dort steht das Phasenmodell, hier die
Spielregeln. Zielgruppe: Entwickler und Coding Agents.

## 1. Fork-Strategie: kein Upstream

**Continue ist eingestellt** — v2.1.0 ist die finale Version (2026 per
Acqui-Hire von Cursor übernommen, Repo wird nicht mehr gepflegt). Dieses Repo
forkt eine **finale Version — es gibt keinen upstream**, wir forken frei
nach Belieben.

Konsequenzen:

- **Alles darf geändert werden** — keine Rücksicht auf künftige Merges nötig.
  Trotzdem keine gratuiten repo-weiten Umformatierungen/Reorgs: sie vergiften
  History und Blame (lint-staged/prettier formatiert ohnehin nur gestagte
  Dateien).
- **Wartungslast gehört jetzt uns**: Dependencies, Toolchain- und
  VS-Code-API-Änderungen landen bei niemand anderem. Neue Dependencies nur
  nach Absprache — jede ist zukünftige Solo-Wartungslast (siehe
  `technical-debts/continue-fork-long-term-maintenance.md`).
- **Opt-in-Flags bleiben gutes Muster** — nicht mehr aus Merge-Rücksicht,
  sondern als Kill-Switch im Corporate-Betrieb. Gelebte Muster:
  `CONTINUE_STRICT_STREAM_TERMINATION` (stream termination guard),
  `experimental.promptLogs` (opt-in prompt logging).
- **`docs/` ist die Produktdoku** (Mintlify-Site, gehört jetzt uns) —
  produktwirksame Änderungen (neue Env-Vars, Features) dürfen dort
  dokumentiert werden. Interne Prozess-Doku bleibt in `dev-docs/`.
- **GitHub CI ist deaktiviert** — der Qualitäts-Gate ist die lokale
  Test-Baseline (`how-tos/test-baseline.md`) via Runner.
- **Abweichungs-Kommentare erklären das Warum** und referenzieren das
  zugehörige Doc in `dev-docs/` **per Dateiname** (`stream-forensics.md`),
  nie per Pfad.

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
- **Bündeln statt Micro-Commits**: verwandte Kleinigkeiten (z.B. mehrere
  Doku-Anpassungen) gesammelt in einem Commit, nicht jede Einzeländerung
  einzeln committen.
- **Kein Commit ohne explizites Go des Users** — das gilt verbindlich auch
  für Agents: Commit-Punkte gerne vorschlagen, aber niemals eigenständig
  committen. Die Commit-Freiheit (jederzeit, auch zwischen Phasen;
  Granularität nach Bauchgefühl und Feature-Größe) liegt beim User.
- **Messages kompakt**: kurzer Subject (Prefixe wie bisher: `feat(…):`,
  `fix:`, `test:`, `docs:`, `chore:`), Body nur wenn er echten Kontext
  liefert. BOM-frei (siehe `how-tos/environment-gotchas.md`).
- **Push ist selten**: 1–3× pro Tag, typischerweise „am Ende der Schicht".
  **Nicht-Pushen ist der Default** — Agents schlagen keinen Push nach
  einzelnen Commits vor.
- **Vor dem Push**: idealerweise voller Runner-Lauf
  (`node scripts/run-all-tests.mjs`, ~13 min) — gepusht wird nur bei Grün
  (Abgleich gegen `how-tos/test-baseline.md`).
