# dev-docs — interne Dokumentation (Continue-Fork)

Interne Prozess- und Entwicklungs-Dokumentation des Forks. Nicht zu verwechseln
mit `docs/` — das ist die upstream Mintlify-Produktdokumentation und bleibt
unangetastet.

## Wo liegt was

| Verzeichnis               | Inhalt                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `design-proposals/`       | Ideen / Feature-Requests, noch nicht reif oder priorisiert für eine Spec                                  |
| `technical-debts/`        | Problembeschreibungen ohne Lösung; offene Incidents bis Abschluss der Analyse                             |
| `specifications/`         | Implementierungs-Specs (Template additiv zum Tech-Debt-Format) + `_IMPLEMENTATION.md` (Workflow-Playbook) |
| `how-tos/`                | Lebende Dev-Doku: Tests ausführen (`running-tests.md`), Test-Baseline, Environment-Gotchas                |
| `history/specifications/` | Archiv: implementierte Specs                                                                              |
| `history/incidents/`      | Archiv: abgeschlossene Incident-Reports                                                                   |

Dateien im Root: `AGENTS.md` (Bootstrap für Coding Agents — hier starten) und
`coding-guidelines.md` (dauerhafte Konventionen inkl. Commit-/Push-Policy).

Namenskonvention: durchgehend kebab-case (Ausnahmen: etablierte Uppercase-Namen
wie README.md/AGENTS.md). `_PREFIX`-Dateien sind Meta-Dokumente (Templates,
Playbook) — kein Feature-Inhalt.

## Lifecycle

```
design-proposals/ ──┐
                    ├──→ specifications/ ──→ Implementierung ──→ (optional: CodeRabbit)
technical-debts/ ───┘         ──→ Tests ──→ history/specifications/

Incidents:  offen ──→ technical-debts/   |   abgeschlossen ──→ history/incidents/
```

## Regeln

1. **Move, don't copy** — Dokumente wandern zwischen den Stadien, es gibt nie zwei Versionen.
2. **Specs enthalten keine Test-Planung**; Tests werden erst nach Abschluss der Implementierung geschrieben (gegen die finale Implementierung).
3. **Code-Kommentare zitieren Dokumente nur per Dateiname** (`stream-forensics.md`), nie per Pfad — Lifecycle-Moves bleiben gratis.
4. Beim Verschieben Intra-Doc-Links mitziehen.

Verbindlicher Workflow: [specifications/\_IMPLEMENTATION.md](specifications/_IMPLEMENTATION.md).
