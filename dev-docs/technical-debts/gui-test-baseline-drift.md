# GUI-Suite rot gegen test-baseline.md (pre-existing auf HEAD 3812d33c2)

**Status:** Open
**Date:** 2026-08-17

## Problem

dev-docs/how-tos/test-baseline.md beschreibt die GUI-Suite als grün. Auf
HEAD 3812d33c2 (und darauf 8c0d5f822) schlagen 5–6 GUI-Tests fehl —
unabhängig von den Änderungen des Reasoning-Fixes vom 2026-08-17
(verifiziert per git-stash-Attribution: identische Failures auf cleanem
Tree ohne diese Änderungen).

Fehlende Tests (Lauf auf 8c0d5f822, 2026-08-17):

| Test-Datei                                                | Test                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| gui/src/redux/thunks/streamResponse.test.ts               | `streamResponseThunk should handle streaming abort`                             |
| gui/src/redux/thunks/streamResponse_errorHandling.test.ts | `streamResponseThunk should handle streaming abort`                             |
| gui/src/redux/thunks/streamResponse_errorHandling.test.ts | `streamResponseThunk should throw error when no chat model is selected`         |
| gui/src/redux/thunks/streamResponse_errorHandling.test.ts | `streamResponseThunk should throw error for other compilation errors`           |
| gui/src/hooks/useBoardWatch.test.tsx                      | `useBoardWatch skips ticks while a compaction runs and wakes once it completes` |

Der useBoardWatch-Test ist timing-sensitiv und flappte in einzelnen Läufen
grün — daher schwankt die Zahl je nach Lauf zwischen 5 und 6.

## Analyse

Die Assertion-Diffs zeigen veraltete erwartete State-Shapes: Die Tests
erwarten `streamAborted: false`, wo der tatsächliche State nach
Abort-/Fehlerpfaden `streamAborted: true` trägt, und das inzwischen
existierende Session-Feld `inlineErrorMessage` taucht in den Diffs auf.
Die Tests wurden offenbar nach den Abort-/Inline-Error- und
Board-Wake-Workstreams nicht nachgezogen; test-baseline.md wurde nicht
aktualisiert. Offen ist, ob der Runtime-State oder die Tests die
gewollte Wahrheit sind.

## Affected Areas

- gui/src/redux/thunks/streamResponse.test.ts
- gui/src/redux/thunks/streamResponse_errorHandling.test.ts
- gui/src/hooks/useBoardWatch.test.tsx
- dev-docs/how-tos/test-baseline.md
