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

- **Granularität**: EIN Commit pro Workstream — Code + Spec + Doku + Tests
  zusammen (AGENTS.md Regel 8); relativ komplette Features, die eine
  Verhaltensänderung vollständig abbilden. Kleinigkeiten und Spec-Updates
  reiten per Piggyback in beliebigen Commits mit — Spec-Pflege ist
  Dauerzustand, kein eigener Commit-Anlass.
- **Bündeln statt Micro-Commits**: verwandte Kleinigkeiten (z.B. mehrere
  Doku-Anpassungen) gesammelt in einem Commit, nicht jede Einzeländerung
  einzeln committen.
- **Kein Commit ohne explizites Go des Users** — das gilt verbindlich auch
  für Agents: Commit-Punkte gerne vorschlagen, aber niemals eigenständig
  committen. Die Commit-Freiheit (jederzeit, auch zwischen Phasen;
  Granularität nach Bauchgefühl und Feature-Größe) liegt beim User.
- **Messages sind Einzeiler**: Subject mit Conventional Prefix
  (`feat(…):`, `fix:`, `test:`, `docs:`, `chore:`), ≤ ~80 Zeichen,
  kein Body — wenn es nicht per `git commit -m "…"` geht, ist die
  Message zu komplex.
- **Push ist selten**: 1–3× pro Tag, typischerweise „am Ende der Schicht".
  **Nicht-Pushen ist der Default** — Agents schlagen keinen Push nach
  einzelnen Commits vor.
- **Vor dem Push gilt ein risikobasiertes Test-Gate, kein Voll-Lauf-Ritual.**
  Maßstab: Sind die Suites, die die Änderungen seit dem letzten Push
  betreffen, _seit diesen Änderungen_ grün gelaufen?
  - **Ja** (z.B. im selben Arbeitsfluss bereits gezielt grün getestet) →
    direkt pushen, kein neuer Lauf.
  - **Nein** → nur die betroffenen Suites über den Runner nachziehen
    (`node scripts/run-all-tests.mjs --only …`), nicht die volle Suite.
  - **Voller Runner-Lauf** (~13 min) = Meilenstein-Gate (s. Bullet unten),
    zusätzlich bei konkretem Integrationsverdacht: paketübergreifende/shared
    Änderungen (Junction-Pakete `packages/fetch` / `packages/openai-adapters`;
    Typ-/Protokoll-Änderungen in `core/index.d.ts`), lange Einheiten ohne
    pro-Commit-Gates, oder auf expliziten Wunsch. Referenz bleibt
    `how-tos/test-baseline.md`; vor dem Push gilt wie immer: nur bei Grün.
- **Voll-Läufe sind Tranchen-/Meilenstein-Gates, 1× pro Tranche und Agent** —
  nur wenn seit dem letzten Voll-Grün Production-Code geändert wurde; nie
  pro Prod-Code-Commit, nie wegen der Commit-Anzahl, nie als Ritual.
  Tranchen-Ende mit nur Test-/Doku-Delta ⇒ kein Voll-Lauf. Gate-Kosten sind
  der Maßstab, nicht das Label: schnelle gezielte Suiten sichern jeden
  Workstream-Commit ab. Exklusivität auf der Maschine entsteht durch dieses
  Seltenheitsprinzip (keine Board-Ansagen); optional maschinenlokale
  Lock-Datei in `%TEMP%` (Zeitstempel+Agent+TTL). Ein grüner Voll-Run auf
  HEAD X gilt für alle Agents auf HEAD X.
- **Ad-hoc-Testläufe schreiben Logdateien.** Der Runner legt Reports selbst
  ab (`%TEMP%\continue-test-report\<suite>.log` + `report.json`); manuelle
  Einzelläufe (`npx vitest run …`, `npm test -- …`) werden umgeleitet:
  `… 2>&1 | Out-File -Encoding utf8 %TEMP%\continue-test-report\manual\<yyyyMMdd-HHmmss>-<suite>.log`,
  Tail im Chat per `Get-Content -Tail`. Kein Tee-Object, kein nacktes `>`
  (UTF-16-Falle, environment-gotchas.md). Volltext auf Platte, nicht
  tail-truncated — ein Lauf ohne Logfile hat nicht stattgefunden.
- **Flake-Disziplin: Signatur loggen, dann weiter.** Bekannte Volllast-Flakes
  stehen in test-baseline.md („Bewusst nicht behoben"); neue Signaturen dort
  - im Memory festhalten. Keine Blind-Re-Runs; isolierte Gegenprobe nur bei
    begründetem Regressionsverdacht (Ablauf: running-tests.md „Bei Failures").
- **Commits brauchen kein Test-Gate**: lint-staged/prettier formatiert beim
  Commit (semantikerhaltend), Typprüfung (`tsc:check`) läuft während der
  Implementierung. Nachträgliche Läufe nur wegen eines Commit-Time-Formatters
  sind Verschwendung.
