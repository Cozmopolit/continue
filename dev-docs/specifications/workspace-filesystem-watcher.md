# Workspace Filesystem Watcher (External Write Detection)

**Status:** Draft
**Date:** 2026-08-13

## Problem / Motivation

Continue sieht Workspace-Änderungen nur, wenn sie als VS-Code-Event
ankommen (`onDidSaveTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`).
Alles, was an VS Code vorbei auf die Platte schreibt — CITT-MCP-Tools
(`file_create`, `run_file_editor`, `file_replace_pattern`), Terminal,
`git switch`, andere Editoren — ist für Continue unsichtbar.

Drei dokumentierte Defekte haben dieselbe Ursache:

1. **Stale AGENTS.md-Injection** (`technical-debts/agents-md-stale-injection.md`):
   Extern editiertes AGENTS.md triggert kein `reloadConfig`; der
   `ProfileLifecycleManager`-Config-Cache bleibt für die gesamte
   Fenster-Lebensdauer veraltet. Neuer Chat ≠ Config-Reload.
2. **File-Picker zeigt neue Dateien nicht** (`technical-debts/composer-file-context-stale-list.md`):
   Die GUI refetcht Submenu-Items nur auf `refreshSubmenuItems`-Signal;
   ohne `files/created`-Event kein Signal.
3. **Codebase-Index veraltet** (in der Recon mitentdeckt):
   `handleFilesChanged` refresht den Index — externe Edits hinterlassen
   stale Embeddings/Chunks, davon merkt niemand etwas.

## Scope

- `extensions/vscode/src/extension/VsCodeExtension.ts` — Registrierung des
  Workspace-Watchers, Mapping auf bestehende `files/*`-IPC-Einstiegspunkte,
  Debouncing.
- `core/core.ts` — Companion-Bugfix der Truthiness-Checks (`core.ts:856`,
  `:888`: `if (colocatedRulesUris)` auf leeres Array → immer true → jeder
  Create/Delete-Event löst vollen Config-Reload aus). Mit Watcher-Futter
  wird das spürbar teuer.
- Ggf. `shouldIgnore`-Aufruf-Shared-Logik, falls die Filterung im
  Watcher-Handler wiederverwendet werden soll.

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

- `core/core.ts:823-905` — die drei Handler `files/changed` (`handleFilesChanged`),
  `files/created`, `files/deleted`. Sie erledigen bereits alles Nötige:
  `walkDirCache.invalidate()`, `refreshIfNotIgnored` (→ GUI-`refreshSubmenuItems`
  - `refreshCodebaseIndexFiles`), `isContinueConfigRelatedUri` → `reloadConfig`.
- `core/indexing/ignore.ts` — `DEFAULT_IGNORES` (~60 Muster) + `shouldIgnore(uri, ide)`
  als Filter-Infrastruktur.
- `VsCodeExtension.ts:450-460` — Präzedenzfall: `fs.watch` auf das _globale_
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
  `shouldIgnore` pro URI (Dateipfad-Check, OK) +
  **`reloadConfig` bei config-related URIs** (teuer, vollständiger Config-
  Reload mit LLM-Reinstantiierung) → im Burst pathologisch.
- `files/created`/`files/deleted` pro Event → GUI `refreshSubmenuItems`
  → kompletter `walkDirs`-Sweep + MiniSearch-Reindex **pro Event** →
  bei 500 Events fatal.

Zusätzlich verstärkt der gefundene Truthiness-Bug (`core.ts:856`, `:888`)
das: leere `colocatedRulesUris`-Arrays sind truthy → jeder Create/Delete-
Event triggert heute schon einen Config-Reload.

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
Debounce-Buffer (aggregiert URIs über ~300–500ms Fenster)
        │
        ▼
Ignore-Filter (DEFAULT_IGNORES via shouldIgnore o.ä.)
        │
        ├── URIs config-related? ──► core.invoke("files/changed", uris)
        ├── URIs created?          ──► core.invoke("files/created", uris)
        └── URIs deleted?          ──► core.invoke("files/deleted", uris)
```

Die Core-Handler machen von dort alles Weitere wie bisher (Config-Reload,
Cache-Invalidate, GUI-Signal, Index-Refresh).

### Punkte im Detail

**Watcher-Setup (`VsCodeExtension.ts`):**

- Ein Watcher pro `vscode.workspace.workspaceFolders`-Eintrag mit
  `new vscode.RelativePattern(folder, "**/*")` (fängt Änderungen in allen
  Sub-Verzeichnissen ohne manuellen Rekursion-Aufwand).
- Registrierung in `activateExtension` beim bestehenden Event-Setup
  (~L488-511, wo die `onDidSaveTextDocument`-Handler registriert werden).
- Disposal über `context.subscriptions.push(...)`.
- **Dynamische Workspace-Folder-Änderungen:** Die Watcher liegen in einer
  Map keyed by Folder-URI. Zusätzlich Subscription auf
  `vscode.workspace.onDidChangeWorkspaceFolders`: für `event.added` einen
  Watcher anlegen, für `event.removed` den zugehörigen Watcher disposen.
  Begründung: Die Extension behandelt dieses Event bereits (IdeUtils-
  Directory-Update + `index/forceReIndex`) — „Add/Remove Folder to
  Workspace" ist ein etabliertes Szenario. Ohne Reconciliation wären neu
  hinzugefügte Folders still unbeobachtet und der hier zu behebende Defekt
  käme für sie lautlos zurück.

**Debouncing:**

- Pfad-basierter Buffer (`Map<string, "created"|"changed"|"deleted">`)
  mit Fenster ~400 ms: Event landet im Buffer, Timer resettet sich pro
  Event; beim Ablaufen Buffer leeren und aggregiert dispatch.
- Pro URI gewinnt der letzte Event-Typ (create→change→delete in einer
  Burst = ein `deleted`-Aufruf).
- Der Core dispatcht pro Event-Typ **einen** Aggregat-Aufruf mit allen
  URIs des Buffers, nicht pro URI einzeln.

**Ignore-Filterung:**

- Vor dem Dispatch: URIs gegen `shouldIgnore` (bzw. einem Äquivalent, das
  ohne IDE-Instanz auskommt — Pfad-basierter Pattern-Match auf
  `DEFAULT_IGNORES` reicht, wie ihn die bestehenden Handler nutzen)
  filtern.
- Ziel: `node_modules`-Installs, Build-Output (`dist/`, `out/`, `bin/`),
  `.git`-Interna feuern kein Event Richtung Core.

**Bugfix (Truthiness):**

- `core.ts:856`: `if (colocatedRulesUris)` → `if (colocatedRulesUris.length)`
- `core.ts:888`: analog.
- Selbständiger Mini-Fix, wird hier mitgeliefert, weil er im Watcher-
  Burst-Szenario sonst Kosten verursacht.

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

- [ ] `extensions/vscode/src/extension/VsCodeExtension.ts`: Watcher-
      Registrierung (pro Workspace-Folder, `RelativePattern`, drei Callbacks),
      Debounce-Buffer-Implementierung, Ignore-Filter, Dispatch auf
      `this.core.invoke("files/changed"|"files/created"|"files/deleted")`.
- [ ] `extensions/vscode/src/extension/VsCodeExtension.ts`: Watcher-
      Reconciliation auf `onDidChangeWorkspaceFolders` (Watcher-Map keyed by
      Folder-URI; anlegen für `event.added`, disposen für `event.removed`;
      Disposables in `context.subscriptions`).
- [ ] `core/core.ts:856`: Truthiness-Bugfix `colocatedRulesUris` →
      `.length`-Check.
- [ ] `core/core.ts:888`: analog.
- [ ] `dev-docs/technical-debts/agents-md-stale-injection.md` und
      `composer-file-context-stale-list.md`: auf diesen Spec verweisen,
      Status aktualisieren (wird beim Implementierungs-Abschluss final
      gemacht → Move nach history per Workflow).
