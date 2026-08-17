# Terminal-Tool-Output: ANSI-Rauschen und Redraw-Frames landen ungekürzt in der History

**Status:** Open (geparkt, nicht zeitnah geplant)
**Date:** 2026-08-17

Das Terminal-Tool (`run_terminal_command`) liefert bei Befehlen mit
Progress-UI (z. B. Git-Hooks mit lint-staged/listr2) massiv aufgeblähten
Output, der ungefiltert als Tool-Message persistiert und mit jedem
Folge-Request mitgeschickt wird.

## Beobachtung (2026-08-17, Session e62361bf)

Ein einzelner `git commit` (mit lint-staged-Hook) produzierte einen
Tool-Output von **48.222 Zeichen**, persistiert in der Session-History:

| Messung                     | Wert                 |
| --------------------------- | -------------------- |
| Roh-Capture                 | 48.222 Zeichen       |
| reine ANSI-Escape-Sequenzen | 16.287 (3.730 Stück) |
| nach ANSI-Strip             | immer noch 31.935    |
| einzigartiger Inhalt        | 60 Zeilen, ~2 KB     |
| davon semantisch relevant   | ~15 Zeilen           |

Relevanter Inhalt: 7 git CRLF-Warnungen, lint-staged-Finalstatus
(Backup/Run/Apply/Clean ✔), Commit-Zusammenfassung. Der Rest (~96 %):
Redraw-Frames der listr2-Spinner-UI.

## Ursachenkette

1. **Erzwungener TUI-Modus:** `getColorEnv()` in
   `core/tools/implementations/runTerminalCommand.ts` setzt
   `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`, `TERM=xterm-256color`,
   `COLORTERM=truecolor`, `CLICOLOR=1`. CLI-Tools mit Progress-UI
   (listr2, ora, …) halten sich für ein reiches Terminal und rendern
   ihre komplette Spinner-/Fortschritts-Animation. Vermutlich
   beabsichtigt (farbige Darstellung in der GUI), aber der Capture-Pfad
   ist darauf nicht vorbereitet.
2. **Roher Capture ohne Sanitization:** Streaming-Pfad akkumuliert
   `terminalOutput += getDecodedOutput(data)` — kein ANSI-Strip, keine
   Emulation der Cursor-Kontrollen (`ESC[2K`, `ESC[1A` = Zeile
   löschen/hoch; im echten Terminal überschreiben sie, hier erzeugen
   sie neue Zeilen pro Frame), kein Größen-Limit/Truncation. Das
   `terminalEmulator.ts`, das `stripAnsi` nutzte, ist totkommentiert
   („node-pty is causing problems").
3. **Ungekürzt in History und Request:** Der Tool-Output wird 1:1 als
   Tool-Message persistiert; `toChatMessage` (openaiTypeConverters.ts)
   gibt Tool-Content ungekürzt weiter. Bis Compaction den Lauf wirft,
   hängen die ~48K Zeichen (~12K Tokens) an jedem Request.

## Impact

- **Token-Kosten:** Jeder TUI-Befehl bläht alle Folge-Requests derselben
  Session auf; mehrere solche Outputs fressen spürbar Kontextfenster.
- **Kontext-Verschmutzung:** Hunderte identische Spinner-Frames im
  Kontext sind reines Rauschen für das Modell.

## Affected Areas

- core/tools/implementations/runTerminalCommand.ts (`getColorEnv`,
  Streaming-Pfad `terminalOutput`, Fallback-Pfad `stdout`/`stderr`)
- core/llm/openaiTypeConverters.ts (`toChatMessage`, Rolle `tool`)
- (tot) extensions/vscode/src/terminal/terminalEmulator.ts (hatte
  `stripAnsi`)

## Mögliche Abhilfen (unpriorisiert)

- ANSI-Escape-Sequenzen beim Capture strippen (`strip-ansi` ist bereits
  Repo-Dependency).
- Redraw-Kollaps: aufeinanderfolgende duplizierte/überschriebene Frames
  deduplizieren (einfach: konsekutive Duplikat-Zeilen; gründlich:
  Cursor-Kontrollen emulieren).
- Größen-Cap mit Head/Tail-Erhalt (z. B. erste N + letzte M Zeichen mit
  `[…X chars truncated…]`-Marker), wie in anderen Agent-CLIs üblich.
- Ggf. `FORCE_COLOR` nur setzen, wenn der Capture-Pfad auch sanitized.

## Bezug

- Entdeckt beim Live-Test der Reasoning-Resend-Policy (Build 2.2.0) am
  2026-08-17; Session-Analyse via JMESPath auf
  `%USERPROFILE%\.continue\sessions\e62361bf-*.json`, history[370].
- Kein Bezug zum Reasoning-Resend-Workstream selbst — eigenständiges
  Hygiene-Problem.
