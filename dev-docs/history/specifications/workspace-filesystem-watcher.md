# Workspace Filesystem Watcher (External Write Detection)

**Status:** Implementiert (Rev 5)
**Date:** 2026-08-13 (Rev 2: 2026-08-15; Rev 3: 2026-08-15 — DQ1/DQ2 und
Korrekturen aus dem zweiten Recon-Durchlauf eingearbeitet; Implementierung
abgeschlossen 2026-08-15; Rev 4: 2026-08-15 — Ignore-File-Parität in den
`files/created`-/`files/deleted`-Handlern + benannter `isIgnoreFile`-Export,
aus CodeRabbit-Review; Rev 5: 2026-08-15 — Workspace-Gate vor der Whitelist
im Flush-Filter + lazy TTL-Bereinigung in `isRecentlySaved`, aus
CodeRabbit-Review)

## Problem / Motivation

Continue sieht Workspace-Änderungen nur, wenn sie als VS-Code-Event
ankommen (`onDidSaveTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`).
Alles, was an VS Code vorbei auf die Platte schreibt — CITT-MCP-Tools
(`file_create`, `run_file_editor`, `file_replace_pattern`), Terminal,
`git switch`, andere Editoren — ist für Continue unsichtbar.

Drei dokumentierte Defekte haben dieselbe Ursache:

1. **Stale AGENTS.md-Injection** (`agents-md-stale-injection.md`):
   Extern editiertes AGENTS.md triggert kein `reloadConfig`; der
   `ProfileLifecycleManager`-Config-Cache bleibt für die gesamte
   Fenster-Lebensdauer veraltet. Neuer Chat ≠ Config-Reload.
2. **File-Picker zeigt neue Dateien nicht** (`composer-file-context-stale-list.md`):
   Die GUI refetcht Submenu-Items nur auf `refreshSubmenuItems`-Signal;
   ohne `files/created`-Event kein Signal.
3. **Codebase-Index veraltet** (in der Recon mitentdeckt):
   `handleFilesChanged` refresht den Index — externe Edits hinterlassen
   stale Embeddings/Chunks, davon merkt niemand etwas.

## Scope

- `extensions/vscode/src/extension/VsCodeExtension.ts` — Registrierung des
  Workspace-Watchers (im Konstruktor, beim bestehenden Event-Setup),
  Watcher-Reconciliation auf `onDidChangeWorkspaceFolders`, Wiring der
  Callbacks, Dispatch auf die bestehenden `files/*`-IPC-Einstiegspunkte.
- `extensions/vscode/src/util/externalFileEventBuffer.ts` (neu) — die reine
  Pipeline-Logik: Debounce-Buffer, TTL-Suppression, Whitelist-vor-Ignore-
  Filter. Bewusst als unit-testbares Modul ausgelagert (Repo-Präzedenz:
  `util/editLoggingUtils`): Der Konstruktor von `VsCodeExtension.ts` ist
  bereits ~460 Zeilen schwer und ohne Extension-Host-Mocks nicht unit-
  testbar (Rev 3, DQ2).
- `core/core.ts` — Companion-Bugfix der Truthiness-Checks in den
  `files/created`-/`files/deleted`-Handlern (`if (colocatedRulesUris)` auf
  ein `filter()`-Ergebnis → immer truthy → jeder Create/Delete-Batch löst
  heute schon einen vollen Config-Reload aus). Mit Watcher-Futter wird das
  spürbar teuer. Zusätzlich (Rev 4): Ignore-File-Parität — Create/Delete
  von `.gitignore`/`.continueignore` löst jetzt wie Edits
  `index/forceReIndex` (`shouldClearIndexes`) aus; zuvor blieb der Index
  bei extern erstellten und bei jeder gelöschten Ignore-Datei stale.
- Filter-Infrastruktur: Der Watcher-Pre-Filter nutzt **nicht** das async
  `shouldIgnore(uri, ide)` (Vorfahren-Walk mit `ide.listDir` pro URI — im
  Burst zu teuer), sondern pfadbasiertes Matching gegen `DEFAULT_IGNORES`
  (`core/indexing/ignore.ts`) plus eine Config-Whitelist
  (`isContinueConfigRelatedUri`/`isColocatedRulesFile` aus
  `core/config/loadLocalAssistants.ts`, ergänzt um Suffix-Matches auf
  `.gitignore`/`.continueignore` — Rev 3, DQ1), beides direkt aus Core
  importiert bzw. als Prädikat nachgebildet.

**Out of Scope:**

- **Self-Notification aus den CITT-MCP-Tools** (verworfen, s. Analysis →
  Decisions): Kopplung CITT↔Continue in falscher Richtung; offene Menge
  künftiger Repo-Schreiber skaliert nicht.
- **Refetch der Picker-Liste beim Öffnen des '@'-Menüs** (deferred, s.
  Decisions): Reaktivierungskriterium = beobachtete stale Listen nach
  Rollout dieses Fixes.
- JetBrains-Extension (`extensions/intellij/`) — dort ist dieses Event-
  Modell anders; nicht Teil dieser Spec.
- Eine Heilung des 30s-`walkDirCache`-TTL-Verhaltens selbst (TTL bleibt;
  nach dem Fix kommen Invalidierungen zuverlässig aus Events an).
- Test-Planung (separate Phase laut `_IMPLEMENTATION.md`).

## Analysis

### Event-Quellen heute

| Schreibpfad                                   | Continue sieht es?                               |
| --------------------------------------------- | ------------------------------------------------ |
| VS-Code-Editor-Speichern                      | ✅ `onDidSaveTextDocument` → `files/changed`     |
| Explorer Create/Copy/Delete                   | ✅ `onDidCreateFiles`/`onDidDeleteFiles`         |
| Continue-Edit-Tools (`edit_existing_file`, …) | ✅ (Client-Tools, enden in Editor-Save)          |
| `create_new_file`                             | ✅ via `openFile`+`saveFile` (Editor-Save)       |
| CITT-MCP-Write-Tools                          | ❌ Out-of-process Disk-Write, kein VS-Code-Event |
| Terminal/Git/andere Editoren                  | ❌                                               |

### Relevante bestehende Mechanik

- `core/core.ts` — die drei Handler `files/changed` (`handleFilesChanged`),
  `files/created`, `files/deleted`. Sie erledigen alles Nötige:
  `walkDirCache.invalidate()`, `refreshIfNotIgnored` (→ GUI-`refreshSubmenuItems`
  - `refreshCodebaseIndexFiles`), `isContinueConfigRelatedUri` → `reloadConfig`,
    `.gitignore`/`.continueignore` → `index/forceReIndex`
    (`shouldClearIndexes`). Korrektur (Rev 4): Letzteres existierte bis Rev 3
    **nur** in `handleFilesChanged` — diese Analyse behauptete fälschlich die
    Abdeckung für alle drei Handler (CodeRabbit-Fund); die Parität für
    Create/Delete kam mit Rev 4 dazu. Wichtig fürs Watcher-Design: Die Config-/Ignore-
    File-bezogene Logik läuft dort **unabhängig von der Ignore-Filterung**
    (die filtert nur GUI- und Index-Refresh) — der Extension-Pre-Filter muss
    diese URIs daher ebenfalls durchlassen (s. Decisions).
- `core/indexing/ignore.ts` — `DEFAULT_IGNORES` (Security- + Indexing-Muster,
  u. a. `.continue/`, `config.yaml`, `config.json`) mit fertigen
  `ignore`-Instanzen (`defaultIgnoreFileAndDir`). Das async
  `shouldIgnore(uri, ide)` liegt in `core/indexing/shouldIgnore.ts` und macht
  einen Vorfahren-Walk mit `ide.listDir` pro URI — für den Watcher-Pre-Filter
  zu teuer, bleibt den Core-Handlern vorbehalten.
- `core/config/loadLocalAssistants.ts` — `isContinueConfigRelatedUri` und
  `isColocatedRulesFile` (Config-Matcher, von der Extension direkt
  importierbar).
- `VsCodeExtension.ts` — Präzedenzfall: `fs.watch` auf das _globale_
  Rules-Verzeichnis, mapped auf `configHandler.reloadConfig`. Der neue Watcher
  löst diesen für den Workspace ab / ergänzt ihn strukturell.

### Warum ein `createFileSystemWatcher` und kein rohes `fs.watch`?

- VS-Code-API ist cross-platform stabil (`@parcel/watcher`-Backend), respektiert
  `files.watcherExclude` (Default: `.git/objects`, `node_modules`) ohne
  Eigenkonfiguration, und liefert Events für Remote-Workspaces korrekt
  durchgereicht.
- Der globale `fs.watch`-Präzedenzfall wurde gewählt, weil er **außerhalb**
  eines Workspaces liegt, wo die VS-Code-API nicht greift. Innerhalb des
  Workspaces ist die VS-Code-API die richtige Wahl.

### Burst-Problem (treibt das Design)

Ein `git switch` oder `npm install` inhaltlich großer Branches produziert
hunderte bis tausende File-Events in <1s. Ohne Behandlung:

- `files/changed` pro Event → `walkDirCache.invalidate()` (billig) +
  `shouldIgnore` pro nicht-Config-URI (async, OK in Maßen) +
  **`reloadConfig` bei config-related URIs** (teuer, vollständiger Config-
  Reload mit LLM-Reinstantiierung) → im Burst pathologisch.
- `files/created`/`files/deleted` pro Event → GUI `refreshSubmenuItems`
  → kompletter `walkDirs`-Sweep + MiniSearch-Reindex **pro Event** →
  bei 500 Events fatal.

Zusätzlich verstärkt der gefundene Truthiness-Bug (die beiden
`if (colocatedRulesUris)`-Checks in den `files/created`-/`files/deleted`-
Handlern in `core/core.ts`) das: `filter()`-Ergebnisse sind immer truthy
→ jeder Create/Delete-Batch triggert heute schon einen Config-Reload.

### Decisions (getroffen)

1. **Kein AGENTS.md-Spezialpfad.** Der Watcher beobachtet den gesamten
   Workspace; die Semantik („config-relevant? ignoriert?") bleibt in den
   bestehenden Handlern. Kein Sonderfall, keine Pflegestelle.
2. **Alle drei Event-Typen** (create/change/delete) — nicht nur
   create/delete. Change-Events sind nötig für AGENTS.md-Reload und
   Index-Refresh (Table oben).
3. **Kein CITT-Side Hook.** Continue-Problem wird in Continue gelöst.
4. **Kein GUI-Polling / Menü-Open-Refetch** — deferred (s. Scope).
5. **Kein JetBrains** in dieser Spec.
6. **Config-Whitelist vor dem Ignore-Filter.** `DEFAULT_IGNORES` enthält
   u. a. `.continue/`, `config.yaml`/`config.json` sowie `*.gitignore`/
   `*.continueignore` — ein naiver Pre-Filter würde ausgerechnet die Config-/
   Rules-Dateien schlucken, deren Reload dieser Fix herstellt. Dispatch-Regel
   daher: `dispatch wenn whitelist(uri) || !isIgnored(uri)` mit Whitelist =
   `isContinueConfigRelatedUri(uri) || isColocatedRulesFile(uri) ||
isIgnoreFile(uri)`; das
   spiegelt die Core-Semantik, wo die Config-/Ignore-Logik vor der
   Ignore-Filterung läuft (Rev 2, Phase-1-Recon; Rev 3 um die `.gitignore`/
   `.continueignore`-Suffixe erweitert). Die Suffixe sind nötig, weil
   `handleFilesChanged` dafür einen eigenen Zweig hat
   (`index/forceReIndex` mit `shouldClearIndexes`) — ohne Whitelist-Eintrag
   bliebe der für externe Edits tot; seit Rev 4 existiert dafür der
   benannte Export `isIgnoreFile` (`core/indexing/ignore.ts`), den der
   Buffer direkt importiert (zuvor Suffix-Match-Replik des inline-Checks
   in `core/core.ts`, DQ1, Rev 3). Rev 5: Die Dispatch-Regel lautet
   vollständig `dispatch wenn inWorkspace(uri) && (whitelist(uri) ||
!isIgnored(uri))` — die Workspace-Mitgliedschaft (`isInWorkspaceDirs`)
   ist ein eigenes Gate **vor** der Whitelist, weil die Whitelist sonst
   Events durchließ, deren Folder zwischen Buffering und Flush entfernt
   worden war (spurious `reloadConfig`/`forceReIndex` für einen nicht mehr
   existierenden Workspace; CodeRabbit-Fund).
7. **TTL-Suppression gegen Doppel-Fire.** Ein In-Editor-Save feuert sowohl
   `onDidSaveTextDocument` als auch den Watcher; `reloadConfig` hat kein
   internes Throttling (`ConfigHandler.ts`). Die Extension merkt sich selbst
   gemeldete Saves (URI + Timestamp, TTL ~2 s) und der Watcher verwirft
   Change-Events für diese URIs — Invariante: der Watcher ergänzt nur
   externe Events (Rev 2).
8. **Debounce mit Hard-Cap.** Trailing-Edge-Fenster ~400 ms nach dem letzten
   Event, aber Forced Flush spätestens ~2 s nach dem ersten gepufferten
   Event — verhindert Starvation bei lang anhaltenden Bursts (z. B. lange
   Git-Operationen; `.git`-Interna sind nicht Teil von `files.watcherExclude`
   und feuern sehr wohl Watcher-Events) (Rev 2).
9. **Pipeline-Logik in ein testbares Modul auslagern.** Debounce-Buffer,
   TTL-Suppression und Whitelist-vor-Ignore-Filter werden **nicht** inline
   im `VsCodeExtension`-Konstruktor implementiert, sondern als pure, unit-
   testbare Logik in `extensions/vscode/src/util/externalFileEventBuffer.ts`
   (Repo-Präzedenz: `util/editLoggingUtils`). `VsCodeExtension.ts` macht nur
   Registrierung, Wiring und Dispatch. Grund: Der Konstruktor ist bereits
   ~460 Zeilen schwer und ohne Extension-Host-Mocks nicht unit-testbar; die
   Test-Phase (laut `_IMPLEMENTATION.md`) schreibt umfassende Unit-Tests für
   neue pure Funktionen vor (DQ2, Rev 3).
10. **Keine Core-seitige Batch-Aggregation in `handleFilesChanged`.** Der
    Handler verarbeitet URIs sequentiell pro URI (`loadConfig` +
    `shouldIgnore` + `refreshCodebaseIndexFiles([uri])`). Das ist bestehendes
    Verhalten und bleibt unverändert — Debounce + Hard-Cap begrenzen die
    Batch-Größe, und `shouldIgnore` profitiert im Burst vom 30s-
    `walkDirCache`. Beobachten: Sollte sich das bei sehr großen
    `files/changed`-Batches (z. B. großer `git switch`) in der Praxis als
    pathologisch zeigen, ist Core-seitige Aggregation ein Follow-up
    (Rev 3, Recon).

## Solution

**Kernidee:** Ein Workspace-`createFileSystemWatcher` in der Extension,
dessen Events debounced-and-gefiltered werden und dann 1:1 auf die
existierenden `files/changed`/`files/created`/`files/deleted`-Aufrufe des
Core gemappt werden. Keine neue Invalidierungslogik — nur eine neue,
vollständige Event-Quelle für das bestehende Rohr.

```
Externe Änderung auf Disk
        │
        ▼
FileSystemWatcher (**/* pro Workspace-Folder)
        │
        ▼
TTL-Suppression: Change-Events für URIs verwerfen, die in den
letzten ~2s bereits per Editor-Save an den Core gemeldet wurden
        │
        ▼
Debounce-Buffer (Map URI → letzter Event-Typ; Flush ~400ms nach
letztem Event, Forced Flush ~2s nach erstem Event)
        │
        ▼
Filter: dispatch wenn inWorkspace(uri) UND (Whitelist(uri) ODER !isIgnored(uri))
  inWorkspace = findUriInDirs(uri, workspaceDirUris).foundInDir
  Whitelist = isContinueConfigRelatedUri || isColocatedRulesFile
              || isIgnoreFile
  isIgnored = DEFAULT_IGNORES (pfadbasiert, defaultIgnoreFileAndDir)
        │
        ├── URIs changed ──► core.invoke("files/changed", uris)
        ├── URIs created ──► core.invoke("files/created", uris)
        └── URIs deleted ──► core.invoke("files/deleted", uris)
```

Die Core-Handler machen von dort alles Weitere wie bisher (Config-Reload,
Cache-Invalidate, GUI-Signal, Index-Refresh).

### Punkte im Detail

**Watcher-Setup (`VsCodeExtension.ts`):**

- Ein Watcher pro `vscode.workspace.workspaceFolders`-Eintrag mit
  `new vscode.RelativePattern(folder, "**/*")` (fängt Änderungen in allen
  Sub-Verzeichnissen ohne manuellen Rekursion-Aufwand).
- Registrierung im **Konstruktor** von `VsCodeExtension` beim bestehenden
  Event-Setup (dort, wo der `onDidSaveTextDocument`-Handler registriert
  wird). Rev-3-Korrektur: Eine Methode `activateExtension` existiert in
  dieser Klasse nicht — das gesamte Event-Setup (inkl. der `fs.watch`-
  Präzedenzfälle) läuft direkt im Konstruktor.
- Disposal über `context.subscriptions.push(...)`. Hinweis: strenger als
  der Bestand — die heutigen Workspace-Event-Handler und `fs.watch`-
  Registrierungen werden dort nicht in `context.subscriptions` aufgenommen.
- **Dynamische Workspace-Folder-Änderungen:** Die Watcher liegen in einer
  Map keyed by Folder-URI. Zusätzlich Subscription auf
  `vscode.workspace.onDidChangeWorkspaceFolders`: für `event.added` einen
  Watcher anlegen, für `event.removed` den zugehörigen Watcher disposen.
  Begründung: Die Extension behandelt dieses Event bereits (IdeUtils-
  Directory-Update + `index/forceReIndex`) — „Add/Remove Folder to
  Workspace" ist ein etabliertes Szenario. Ohne Reconciliation wären neu
  hinzugefügte Folders still unbeobachtet und der hier zu behebende Defekt
  käme für sie lautlos zurück.

**Debouncing** (lebt in `externalFileEventBuffer.ts`, Decision 9):

- Pfad-basierter Buffer (`Map<string, "created"|"changed"|"deleted">`),
  Trailing-Edge: Flush ~400 ms nach dem letzten Event (Timer resettet sich
  pro Event), aber Forced Flush spätestens ~2 s nach dem ersten gepufferten
  Event (Decision 8); beim Flush Buffer leeren und aggregiert dispatch.
- Pro URI gewinnt der letzte Event-Typ (create→change→delete in einer
  Burst = ein `deleted`-Aufruf).
- Die Extension dispatcht pro Event-Typ **einen** Aggregat-Aufruf mit allen
  URIs des Buffers an den Core, nicht pro URI einzeln.

**Filterung (Whitelist vor Ignore, Decision 6; lebt in
`externalFileEventBuffer.ts`, Decision 9):**

- Dispatch-Regel: `dispatch wenn inWorkspace(uri) && (whitelist(uri) ||
!isIgnored(uri))` — das Workspace-Gate (`isInWorkspaceDirs`) läuft vor
  der Whitelist, damit Events eines zwischen Buffering und Flush entfernten
  Folders nicht über die Whitelist doch noch dispatched werden (Rev 5,
  CodeRabbit-Fund).
- Whitelist: `isContinueConfigRelatedUri(uri) || isColocatedRulesFile(uri)
|| isIgnoreFile(uri)`
  (erstere beide aus `core/config/loadLocalAssistants.ts`; `isIgnoreFile`
  seit Rev 4 aus `core/indexing/ignore.ts` — zuvor Suffix-Match-Replik des
  damals inline in `handleFilesChanged` stehenden Checks, DQ1, Rev 3).
  Läuft **vor** dem
  Ignore-Check — `DEFAULT_IGNORES` enthält u. a. `.continue/`,
  `config.yaml` sowie `*.gitignore`/`*.continueignore`, würde also ohne
  Whitelist genau die lokalen Config-/Rules-/Ignore-Dateien schlucken,
  deren Reload/Reindex dieser Fix herstellt.
- Ignore-Check: pfadbasiert gegen `DEFAULT_IGNORES` (fertige `ignore`-Instanz
  `defaultIgnoreFileAndDir` aus `core/indexing/ignore.ts`, angewandt auf den
  Workspace-relativen Pfad). Das async `shouldIgnore(uri, ide)` bleibt den
  Core-Handlern vorbehalten. Für den Workspace-Relativpfad wird
  `findUriInDirs` aus `core/util/uri` verwendet — eine pure, synchrone
  String-Funktion ohne `ide`-Aufruf (im Burst unkritisch);
  `defaultIgnoreFileAndDir.ignores(...)` erwartet Slash-separierte
  Relativpfade (walkDir-Präzedenz).
- Ziel: Build-Output (`dist/`, `out/`, `bin/`) und `.git`-Interna
  (HEAD/index/refs — **nicht** Teil von `files.watcherExclude`) feuern kein
  Event Richtung Core. `node_modules` ist bereits per VS-Code-Default in
  `files.watcherExclude` und feuert gar nicht erst Watcher-Events.

**TTL-Suppression gegen Doppel-Fire (Decision 7):**

- Ein In-Editor-Save feuert sowohl `onDidSaveTextDocument` als auch den
  Watcher → derselbe URI landete doppelt in `files/changed`; für Config-
  Dateien wären das 2× `reloadConfig` pro Save.
- Die TTL-Map (URI + Timestamp, TTL ~2 s, lazy bereinigt — beim Lesen
  werden abgelaufene Einträge verworfen, Rev 5) lebt im
  `externalFileEventBuffer` (Decision 9); der bestehende
  `onDidSaveTextDocument`-Handler in `VsCodeExtension.ts` ruft zusätzlich
  zum heutigen `files/changed`-Dispatch eine Notier-Funktion des Buffers
  auf.
- Der Watcher-Callback verwirft **Change-Events** für URIs innerhalb dieses
  Fensters; Create-/Delete-Events bleiben unberührt.
- Bewusst akzeptierte Kante: Kommt das Watcher-Event erst nach Ablauf der
  TTL an (selten, FS-Latenz), gibt es einen idempotenten Doppel-Dispatch —
  harmlos und keinen zusätzlichen Mechanismus wert.

**Bugfix (Truthiness):**

- `core/core.ts`, Handler `files/created` und `files/deleted` (zwei
  Stellen): `if (colocatedRulesUris)` → `if (colocatedRulesUris.length)`.
  Das `filter()`-Ergebnis ist immer ein (ggf. leeres) Array, also truthy →
  heute löst jeder Create-/Delete-Batch unabhängig vom Inhalt einen vollen
  Config-Reload aus.
- Selbständiger Mini-Fix, wird hier mitgeliefert, weil er im Watcher-
  Burst-Szenario sonst Kosten verursacht.

**Bugfix (Ignore-File-Parität, Rev 4):**

- `core/core.ts`, Handler `files/created` und `files/deleted`: Create/Delete
  einer `.gitignore`/`.continueignore` löste keinerlei Reindex aus (kein
  eigener Zweig; `refreshIfNotIgnored` filtert die Ignore-Dateien selbst
  über `DEFAULT_IGNORES` ohnehin heraus). Neu: `data.uris.some(isIgnoreFile)`
  → `index/forceReIndex` (`shouldClearIndexes: true`), einmal pro Batch —
  dieselbe Semantik wie der Edit-Zweig in `handleFilesChanged`. Betroffene
  Pfade: extern erstellte Ignore-Dateien (Terminal, `git checkout`,
  CITT-Tools), Explorer-Copy und jede Löschung; In-Editor-Anlage+Save lief
  bereits über `files/changed`.
- `isIgnoreFile` als benannter Export in `core/indexing/ignore.ts` angelegt
  und an allen drei Handler-Stellen (zwei neue Zweige + `handleFilesChanged`)
  sowie im `externalFileEventBuffer` verwendet — löst die Rev-3-Suffix-
  Replikation ab.

### Was sich bei den drei Defekten ändert

| Defekt                        | Nach dem Fix                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| AGENTS.md stale               | Externer Edit → `files/changed` → `isContinueConfigRelatedUri` matches → Reload. Beim nächsten Chat frisches AGENTS.md. |
| Picker zeigt neue Datei nicht | Externe Create → `files/created` → `walkDirCache.invalidate()` + GUI-`refreshSubmenuItems`. Liste aktuell.              |
| Codebase-Index stale          | Externe Edit → `files/changed` → Index-Refresh für URI.                                                                 |

Akzeptanz: Nach Implementierung sichtbar durch `touch newfile.md` im
Terminal → Datei soll im @-Picker auftauchen (nach Debounce-Fenster);
externes AGENTS.md-Edit → neuer Chat injiziert neue Version.

## Implementation Checklist

- [x] `extensions/vscode/src/util/externalFileEventBuffer.ts` (neu): pure
      Pipeline-Logik als unit-testbares Modul (Decision 9) — Debounce-Buffer
      (Trailing-Edge ~400 ms, Forced Flush ~2 s), TTL-Suppression,
      Whitelist-vor-Ignore-Filter (Whitelist inkl. `.gitignore`/
      `.continueignore`-Suffixen, Decision 6/DQ1; Ignore-Check pfadbasiert
      über `findUriInDirs` + `defaultIgnoreFileAndDir`).
- [x] `extensions/vscode/src/extension/VsCodeExtension.ts`: Watcher-
      Registrierung im Konstruktor (pro Workspace-Folder, `RelativePattern`,
      drei Callbacks), Wiring an den Event-Buffer, Notierung der
      Editor-Saves für die TTL-Suppression, Dispatch auf
      `this.core.invoke("files/changed"|"files/created"|"files/deleted")`.
- [x] `extensions/vscode/src/extension/VsCodeExtension.ts`: Watcher-
      Reconciliation auf `onDidChangeWorkspaceFolders` (Watcher-Map keyed by
      Folder-URI; anlegen für `event.added`, disposen für `event.removed`;
      Disposables in `context.subscriptions`).
- [x] `core/core.ts`: Truthiness-Bugfix `colocatedRulesUris` →
      `.length`-Check im `files/created`-Handler.
- [x] `core/core.ts`: analog im `files/deleted`-Handler.
- [x] `core/indexing/ignore.ts`: `isIgnoreFile`-Export (Rev 4).
- [x] `core/core.ts`: Ignore-File-Zweig (`index/forceReIndex` mit
      `shouldClearIndexes`) in `files/created` und `files/deleted`;
      `handleFilesChanged` auf `isIgnoreFile` umgestellt (Rev 4).
- [x] `extensions/vscode/src/util/externalFileEventBuffer.ts`: Whitelist
      nutzt `isIgnoreFile` statt Suffix-Replikation (Rev 4).
- [x] `core/indexing/ignore.vitest.ts`: Unit-Tests für `isIgnoreFile`
      inkl. DEFAULT_IGNORES-Invariante (Rev 4).
- [x] `extensions/vscode/src/util/externalFileEventBuffer.ts` (Rev 5):
      `isInWorkspaceDirs`-Gate vor der Whitelist im Flush-Filter (kein
      Dispatch für URIs eines zwischen Buffering und Flush entfernten
      Folders, auch nicht per Whitelist) + `isRecentlySaved` löscht
      abgelaufene TTL-Einträge lazily; Regressionstest (whitelisted
      `rules.md`/`.continue/config.yaml` eines entfernten Folders) in
      `externalFileEventBuffer.vitest.ts`.
- [x] `agents-md-stale-injection.md` und
      `composer-file-context-stale-list.md`: auf diesen Spec verweisen,
      Status aktualisieren (beim Implementierungs-Abschluss gemacht →
      Move nach history per Workflow nach Test-Abschluss).
