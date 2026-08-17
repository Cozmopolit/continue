# Board-Watch-Follow-ups: ~~boardWatchMode-Persistenz~~ + veralteter Injection-Block

**Status:** Open (Problem 2); Problem 1 gefixt 2026-08-17
**Date:** 2026-08-17

Zwei offene Probleme aus dem Board-Wake-Mode-Workstream
(Spezifikation: dev-docs/history/specifications/board-wake-mode.md).
Beide waren analysiert und ungefixt geparkt; Problem 1 wurde am
2026-08-17 behoben (Registrations- + Read-Pfad), Problem 2 bleibt offen.

## Problem 1 (GEFIXT): Toggle „Board Watch" überlebt keinen Fenster-Neustart

Der Toggle `boardWatchMode` folgt dem Yolo-Pfad (`setIdeSettings`-Persistenz

- Boot-Load via `getIdeSettings`), ist aber auf beiden Seiten gebrochen:

* **Schreiben:** Der `setIdeSettings`-Handler schreibt per
  `settings.update(key, value, Global)` den Schlüssel
  `continue.boardWatchMode`, der in `contributes.configuration` von
  extensions/vscode/package.json **nicht registriert** ist
  (grep `boardWatch|wake` = 0 Treffer). Beim Toggeln erscheint eine
  setIdeSettings-Fehlermeldung im renderer.log.
* **Lesen:** `VsCodeIde.getIdeSettingsSync()` liest `boardWatchMode` gar
  nicht aus (alle anderen Keys inkl. `autoApproveAllTools` schon). Der
  Boot-Load in ParallelListeners.tsx bekommt daher immer `undefined` →
  `?? false`.

Nettoeffekt: Der Modus funktioniert nur innerhalb einer Fenster-Lebensdauer
und wird bei jedem Neustart still auf „aus" zurückgesetzt; zusätzlich
Log-Rauschen bei jedem Toggle.

**Fix (2026-08-17):** `continue.boardWatchMode` ist jetzt in
`contributes.configuration` von extensions/vscode/package.json registriert
(behebt die CodeExpectedError beim Schreiben), und
`VsCodeIde.getIdeSettingsSync()` liest den Schlüssel mit Default `false`
aus (Boot-Load bekommt jetzt den persistierten Wert). Verbatim-Evidenz
für den Fehler kam aus der zenith-Session-Triage (to-delta #5318390706).

## Problem 2: Board-Injection-Block zeigt verarbeitete Nachrichten erneut

Der Injection-Block für pending Board-Nachrichten akkumuliert pro Session
(`appendBoardMessages` in sessionSlice) und wird nur durch
`loadSession`/newSession zurückgesetzt. In Run N gelesene/beantwortete
Nachrichten stehen in Run N+1 unverändert als „neue Nachrichten" oben im
Kontext — keine Markierung verarbeitet/unverarbeitet, keine Verdichtung.

Beobachteter Impact: Ghost-Bootstrap-Incident (2026-08-17, vesta) — das
Ghost-Thinking referenzierte den erneut gezeigten Block explizit
(„already read"). Als beitragender Faktor dokumentiert im Memory
`assistant:coding-agent`, Fragment
`incident-conversation-history-drop_2026_08_17`.

## Affected Areas

- extensions/vscode/package.json (`contributes.configuration`)
- extensions/vscode/src/VsCodeIde.ts (`getIdeSettingsSync`)
- extensions/vscode/src/extension/VsCodeMessenger.ts (`setIdeSettings`)
- gui/src/hooks/ParallelListeners.tsx (Boot-Load)
- gui/src/redux/slices/sessionSlice.ts (`appendBoardMessages`,
  Board-Puffer-Reset nur in newSession)
- gui/src/redux/thunks/fetchBoardPending.ts
- Injection-Stelle in gui/src/util/streamNormalInput.ts
