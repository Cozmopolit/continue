# Fehlende Integrationstests: files/\*-Handler-Wiring (Watcher-SMB-Mitigation)

**Status:** offen
**Date:** 2026-08-19
**Bezug:** watcher-smb-hammering-mitigation.md (Status: Implementiert)

## Problem

Die Umsetzung von watcher-smb-hammering-mitigation.md ist nur über die
Unit-Tests der neuen Util abgedeckt (`core/util/submenuRefreshCoalescer.vitest.ts`,
13 Tests). Das Wiring in `core/core.ts` ist **ungetestet**:

1. `handleFilesChanged` ruft `walkDirCache.invalidate()` nicht mehr auf — kein
   Test verifiziert, dass ein `files/changed`-Batch den Cache intakt lässt,
   während der Ignore-File-Zweig weiterhin über `index/forceReIndex` invalidiert.
2. `refreshIfNotIgnored` sendet `refreshSubmenuItems` durch den Coalescer —
   kein Integrationstest verifiziert, dass N created/deleted-Batches innerhalb
   eines Fensters genau einen Send erzeugen.

## Impact

Regressions im Wiring (Blanket-Invalidation wiedereingeführt, Coalescer
umgangen) bleiben unbemerkt, bis sie als Feld-Symptom wiederauftauchen
(leeres/stales Files-@-Menü, Share-Last auf Firmen-Fileservern).

## Lösungsskizze

Core hat bislang kein Harness für Messenger/Handler-Integrationstests.
Optionen: (a) Handler-Logik in testbare Funktionen extrahieren, (b) leichtes
Core-Harness mit Mock-Messenger (vorher prüfen, wie bestehende core-Tests
Messenger/IDE mocken). Bewusst als Debt akzeptiert, weil das Wiring als
trivial galt und der Workstream abbrechen musste; gezielte Suites
(core-jest/core-vitest) waren gegen die finale Implementierung grün.
