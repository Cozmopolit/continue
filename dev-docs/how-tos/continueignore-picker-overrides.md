# Continueignore: Dateien für den @-Datei-Picker freischalten

Der @-Datei-Picker (`@Files`) und der Codebase-Index durchlaufen den Workspace
mit `walkDirs` (`core/indexing/walkDir.ts`). Dabei greifen kumulativ mehrere
Filter — was sie ausschließen, erscheint weder im Picker noch im Index:

1. `.gitignore` pro Verzeichnis (rein pattern-basiert, kein `git ls-files`;
   untracked-aber-nicht-ignoriert erscheint also, gitignoriert nie)
2. eingebaute Defaults (`core/indexing/ignore.ts`): Security (`*.env`,
   `config.json`, `*.key/pem/pfx/crt`, `*.db/sqlite/mdb`, `*.bak`, …) und
   Indexing (`*.log`, `*.csv`, `*.pdf`, `*-lock.json`, `*.jsonl`, Binaries,
   Verzeichnisse `.git/`, `node_modules/`, `dist/`, `build/`, `bin/`,
   `.vscode/`, `.idea/`, `.venv/`, …)
3. `.continueignore` — global (`~/.continue/.continueignore`) und pro
   Verzeichnis; wird **nach** `.gitignore` und den Defaults angewendet und ist
   der dafür vorgesehene Override (`walkDir.ts`: „so that .continueignore can
   override .gitignore")

Dazu kommen: Symlinks werden nie gewalkt; nur Workspace-Roots werden gewalkt;
der Picker ist auf 10.000 Einträge gedeckelt.

## Rezept: Whitelist-`.gitignore` im Workspace-Root überstimmen

Fall: Die Root-`.gitignore` ist eine Whitelist (`*` + `!repo/`-Ausnahmen),
weil der Workspace-Container mehrere eigenständige Sub-Repos enthält und Git
nur ausgewählte davon verwalten soll. Ein nicht freigeschaltetes Sub-Repo
(z. B. `CITT/`) fehlt damit komplett im Picker — obwohl Continue es indexieren
soll und sein Git-Status den Parent-Repo-Filter nicht braucht.

Lösung: Root-`.continueignore` (Datei im Workspace-Root, nicht im
`.continue/`-Ordner) mit **zwei** Zeilen:

```gitignore
!CITT/
!CITT/**
```

`!CITT/` allein re-inkludiert nur das Verzeichnis selbst — der Walker steigt
ab, aber die Root-`*`-Regel matcht jeden Eintrag darunter weiter. Erst
`!CITT/**` macht die Inhalte sichtbar.

Dabei bleibt der Rest der Filterwelt intakt (empirisch verifiziert gegen das
gebündelte `ignore`-Package in der exakten Komposition aus
`getIgnoreContext`):

- Die verschachtelte `.gitignore` des Sub-Repos greift weiterhin voll
  (`CITT/bin/`, `CITT/obj/` bleiben unsichtbar) — jede Verzeichnisebene baut
  ihren eigenen Ignore-Kontext; die Negation wirkt nur im Root-Kontext.
- Die Continue-Defaults greifen weiterhin in Tiefe (`*.log`, `*.dll` unter
  `CITT/` bleiben unsichtbar) — derselbe Mechanismus.
- Alle anderen Root-Verzeichnisse bleiben ignoriert.

Git selbst wird nicht angefasst: Das Sub-Repo bleibt im Parent-Repo untracked.

## Aktivierung und Nebenwirkungen

- Der Ignore-File-Watcher (`isIgnoreFile` in `core/core.ts`) feuert beim
  Anlegen/Ändern einer `.continueignore` `index/forceReIndex` plus
  `walkDirCache.invalidate()` — wirkt ohne Editor-Neustart.
- Nebenwirkung beachten: Das freigeschaltete Verzeichnis landet auch im
  Codebase-Index (gleicher Walk-Pfad) — meist erwünscht, erhöht aber das
  Index-Volumen. Bei sehr großen Workspaces zusätzlich das Picker-Cap von
  10.000 Einträgen im Blick behalten.
- Security-Reads (`isSecurityConcern`) sind eine separate Schicht: `*.env`,
  Keys, Zertifikate lassen sich auch per Negation nicht anhängen — absichtlich.

## Verifikation nach dem Anlegen

1. Datei speichern, wenige Sekunden warten (Watcher → Force-Reindex).
2. `@Files` öffnen und nach einer bekannten Datei aus dem freigeschalteten
   Verzeichnis suchen.
3. Negativprobe: eine Datei aus einem weiterhin ignorierten Verzeichnis
   (`bin/`, `node_modules/`) darf nicht erscheinen.
