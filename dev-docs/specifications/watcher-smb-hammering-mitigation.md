# Filesystem-Watcher: SMB-Hammering & Submenu-Refresh-Throttling

**Status:** Implementiert
**Date:** 2026-08-19

## Problem / Motivation

Seit dem Workspace-Filesystem-Watcher (workspace-filesystem-watcher.md, Build vom 15.08.2026) feuern `files/created|changed|deleted` nicht mehr nur aus Editor-Aktionen, sondern aus **allen externen Schreibvorgängen**. Auf Workspaces auf Netzwerk-Shares erzeugt das zwei beobachtete Effekte:

1. **File-Server-Last:** Die upstream-Handler reagieren auf jeden Batch mit `walkDirCache.invalidate()` (Full Clear) und bei created/deleted zusätzlich mit `refreshSubmenuItems` → GUI → voller rekursiver `walkDirs`-Walk mit kaltem Cache (ein SMB-`readDirectory`-Roundtrip pro Verzeichnis). Auf Shares mit Fremd-Churn (Build-Server, andere Nutzer, Tools) wird daraus ein dauerhafter Strom voller Walks — **auch von idle Clients**.
2. **GUI-Symptom:** Das Files-@-Menü bleibt lange leer/stale, weil kalte Walks über SMB langsam sind und sich Walks ohne echte Cancelierung stapeln — der user-sichtbare Auslöser dieser Analyse.

Zuhause (lokale SSD, kein Fremd-Churn) ist derselbe Code-Pfad unsichtbar.

## Scope

- Entfernung der unnötigen Blanket-Invalidation bei `files/changed`
- Core-seitiges Coalescing der event-getriebenen `refreshSubmenuItems`
- Minimale Diagnose-Logs für Event-Rate und Walk-Dauer

**Out of Scope:** Pull-on-Open für das @-Menü; gezielte (Parent-Dir-)Cache-Invalidation; Watcher-Sonderbehandlung für UNC-Roots; das 10k-Cap in `loadSubmenuItems`; VS-Code-Watcher-Zuverlässigkeit auf SMB.

## Analysis

Heutige Call-Chain pro Watcher-Batch (Buffer-Fenster 400 ms–2 s):

- `files/changed` → `handleFilesChanged` → `walkDirCache.invalidate()` + `GitDiffCache.invalidate()` + Per-URI-Zweige
- `files/created|deleted` → `walkDirCache.invalidate()` + `refreshIfNotIgnored` → `refreshSubmenuItems` → GUI `loadSubmenuItems(["file"])` → `walkDirs` (kalt, da gerade invalidiert)

Befunde:

1. **Blanket-Invalidation auf `changed` ist unnötig:** Content-Changes ändern die Dateiliste nicht. Ignore-File-Changes haben in `handleFilesChanged` bereits einen eigenen Zweig (`isIgnoreFile` → `index/forceReIndex`), der selbst invalidiert. Das upstream-TODO am Code anerkennt das („safe approach for now").
2. **`refreshSubmenuItems` ist unkoalesciert:** Jeder created/deleted-Batch löst im GUI einen Full-Walk aus. Der GUI-AbortController verwaltet nur den Loading-State, Requests laufen durch → Walks stapeln sich (SubmenuContextProviders.tsx).
3. **Push-Freshness ist wertlos:** Das Menü wird nur beim Öffnen betrachtet; Permanenz-Refresh pro Batch braucht niemand.
4. **Der Cache wird nie warm:** `walkDirCache` hat 30 s TTL; bei permanenter Invalidation laufen auch alle anderen Walk-Konsumenten (FileSearch-QuickPick, Indexer-Enumeration, `selectFilesAsContext`) immer kalt.

## Solution

**S1 — Blanket-Invalidation auf `files/changed` entfernen.** In `handleFilesChanged` fällt `walkDirCache.invalidate()` weg; `GitDiffCache.invalidate()` und alle Per-URI-Zweige bleiben (der forceReIndex-Zweig deckt Ignore-Changes weiterhin ab).

**S2 — Event-getriebene Submenu-Refreshes koalieren.** Neue kleine Utilität (Trailing-Edge-Throttle, Default-Fenster 30 s — passend zur `LIST_DIR_CACHE_TIME` in walkDir.ts): erste Anforderung sendet sofort, wenn der letzte Send länger als das Fenster her ist; sonst wird genau ein Send zum Fensterende scheduled. Hook-Punkt: `refreshIfNotIgnored` in `core.ts` (einzige event-getriebene Sendestelle). Config-getriebene GUI-Reloads (Initial-Load, Profil-/Config-Changes) bleiben unangetastet. Clock/Timer injizierbar (Muster wie ExternalFileEventBuffer).

Effekt: max. 1 event-getriebener Full-Walk pro Fenster und Client; zwischen created/deleted-Events bleibt der Cache für alle Konsumenten warm.

**S3 — Diagnostik.** Grep-freundliche Info-Logs mit Präfix `[fs-watch]`: (a) pro `files/*`-Batch die Counts created/changed/deleted; (b) in `FileContextProvider.loadSubmenuItems` Dauer + Item-Count. Ermöglicht Vorher/Nachher-Vergleich in der Firma ohne Debugger.

**Rollout:** Derselbe Build läuft auf Firmen-Shares (citt-fides, citt-lumen). Nach Commit + Tests: Pointer in `Allgemein`, damit die Firmen-Agenten updaten.

## Implementation Checklist

- [x] `core/core.ts` `handleFilesChanged`: `walkDirCache.invalidate()` entfernen, Rest behalten; Code-Kommentar mit Verweis auf watcher-smb-hammering-mitigation.md
- [x] Neu `core/util/submenuRefreshCoalescer.ts`: Trailing-Edge-Throttle (30 s), injizierbare Clock/Timer
- [x] `core/core.ts` `refreshIfNotIgnored`: Send durch den Coalescer schicken
- [x] `core/core.ts` `files/*`-Handler: `[fs-watch]`-Info-Log mit Batch-Counts
- [x] `core/context/providers/FileContextProvider.ts`: `[fs-watch]`-Info-Log in `loadSubmenuItems` (Dauer, Item-Count)
- [x] Spec-Status → Implementiert, Checklist abhaken
