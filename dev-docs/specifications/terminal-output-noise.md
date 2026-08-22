# Terminal tool output: sanitize before persistence (ANSI strip, redraw collapse, size cap)

**Status:** Implementiert
**Date:** 2026-08-17 (spec 2026-08-22)

## Problem / Motivation

Das Terminal-Tool (`run_terminal_command`) liefert bei Befehlen mit
Progress-UI (z. B. Git-Hooks mit lint-staged/listr2) massiv aufgeblähten
Output, der ungefiltert als Tool-Message persistiert und mit jedem
Folge-Request mitgeschickt wird.

Beobachtung (2026-08-17, Session e62361bf): ein einzelner `git commit`
(mit lint-staged-Hook) produzierte einen Tool-Output von **48.222
Zeichen**, persistiert in der Session-History:

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

Impact:

- **Token-Kosten:** Jeder TUI-Befehl bläht alle Folge-Requests derselben
  Session auf (~12K Tokens pro Vorfall); mehrere solche Outputs fressen
  spürbar Kontextfenster.
- **Kontext-Verschmutzung:** Hunderte identische Spinner-Frames im
  Kontext sind reines Rauschen für das Modell.

Ursachenkette:

1. **Erzwungener TUI-Modus:** `getColorEnv()` in
   `runTerminalCommand.ts` setzt `FORCE_COLOR=1`, `CLICOLOR_FORCE=1`,
   `TERM=xterm-256color`, `COLORTERM=truecolor`, `CLICOLOR=1`.
   CLI-Tools mit Progress-UI rendern ihre komplette Spinner-/
   Fortschritts-Animation. Beabsichtigt: die GUI rendert ANSI-Farben
   bewusst (`AnsiRenderer` in `UnifiedTerminal.tsx`, inkl. Test
   „renders ANSI colors and formatting").
2. **Roher Capture ohne Sanitization:** Der Streaming-Pfad akkumuliert
   `terminalOutput += getDecodedOutput(data)` — kein ANSI-Strip, keine
   Emulation der Cursor-Kontrollen (`ESC[2K`, `ESC[1A`; im echten
   Terminal überschreiben sie, hier erzeugen sie neue Zeilen pro Frame),
   kein Größen-Limit.
3. **Ungekürzt in History und Request:** Der Tool-Output wird 1:1 als
   Tool-Message persistiert und auf jedem Ausgangspfad unverändert an
   den Provider geschickt.

Entdeckt beim Live-Test der Reasoning-Resend-Policy (Build 2.2.0) am
2026-08-17; Session-Analyse via JMESPath auf
`%USERPROFILE%\.continue\sessions\e62361bf-*.json`, history[370].

## Scope

- `core/tools/implementations/runTerminalCommand.ts`: neuer
  Sanitization-Helper + Anwendung auf den zurückgegebenen Tool-Content
  (Streaming-Pfad, Fallback-Pfad).

**Out of Scope:**

- `getColorEnv()` selbst — `FORCE_COLOR` & Co. bleiben; Live-Farben im
  GUI während des Laufs sind ein Feature. Der Bloat wird durch die
  Sanitization gebunden, nicht an der Quelle abgestellt.
- GUI-Änderungen — `AnsiRenderer` bleibt; live gestreamter Partial-Output
  bleibt roh (Farben während des Laufs).
- LLM-Grenz-Strip für Altlasten (bestehende Sessions mit altem Rauschen)
  — erst evaluieren, ob der Capture-Fix genügt.
- `extensions/cli`-Terminal-Tool (hat bereits Truncation) und
  Remote-/Detached-Pfade (kein Capture).
- Mini-Terminal-Emulator (Cursor-Kontrollen vollständig emulieren) —
  nur als Follow-up, falls Stufe-1-Kollaps nicht reicht.

## Analysis

Verifizierter Ist-Zustand (Recon 2026-08-22):

- **Ein Chokepoint:** Der Tool-`content` geht 1:1 in die Tool-Message →
  Session-Persistenz → jeden Folge-Request. Ausgangsseitig zwei Pfade:
  `toChatMessage`-Tool-Branch (~L145–151 in `openaiTypeConverters.ts`,
  via `toChatBody`) und `toResponsesInput` (~L1296–1308, Responses-API).
  Beide reichen Content unverändert durch. Sanitizing am Capture-Punkt
  deckt Persistenz **und** beide LLM-Pfade mit einer Änderung ab.
- **Sanitization bei `close`, nicht pro Chunk:** Escape-Sequenzen können
  über Chunk-Grenzen gesplittet ankommen (ESC am Chunk-Ende, Parameter im
  nächsten) — pro-Chunk-Strip wäre unzuverlässig. Close-Zeit-Strip ist
  ein Durchlauf über den fertigen Puffer. Nebeneffekt gewollt: die live
  gestreamten Partial-Updates bleiben roh → Farben laufen im GUI weiter.
- **`updateProcessOutput`/`currentOutput`** (`processTerminalStates.ts`)
  ist write-only — kein Consumer im Repo, kein zusätzlicher
  Anwendungspunkt.
- **Repo-Präzedenzfall:** `extensions/cli` trunciert Terminal-Output
  bereits (`truncateOutputFromStart`: Tail-Erhalt, Marker
  `(previous N lines truncated)` / `(previous N characters truncated)`,
  Defaults 50.000 Zeichen / 1.000 Zeilen). Konvention wird übernommen,
  mit engeren Limits (LLM-Kontext statt Terminal-Anzeige).
- **`strip-ansi`** hängt nur in `extensions/vscode` (^7, ESM-only) →
  Inline-Regex in core, keine neue Dependency (Maintenance-Policy:
  Footprint klein halten).
- **ANSI-Strip allein reicht nicht:** 48.222 → 31.935 Zeichen nach Strip
  (Redraw-Frames bleiben). Frame-Kollaps + Hard-Cap sind die
  eigentlichen Hebel; das Cap ist die Garantie-Obergrenze.

## Solution

Ein exportierter Pure-Function-Helper in `runTerminalCommand.ts`
(testbar neben dem Code, bestehende `runTerminalCommand.vitest.ts`):

```ts
sanitizeTerminalOutput(raw: string): string
```

Pipeline (in dieser Reihenfolge):

1. **ANSI-Strip** per Inline-Regex: CSI-Sequenzen (`ESC[…Buchstabe`),
   OSC-Sequenzen (`ESC]…` bis BEL/ST), übrige Zwei-Zeichen-Escapes.
2. **Overwrite-Normalisierung:** `\r\n` → `\n`; pro Zeile nur das
   letzte `\r`-Segment behalten (Carriage-Return-Emulation —
   Progress-Bar-Frames kollabieren zum letzten Frame).
3. **Redraw-Kollaps:** Runs identischer, nicht-leerer Zeilen auf eine
   Occurrence falten. Leer-/Whitespace-Zeilen werden nicht angefasst.
4. **Cap (Tail-Erhalt, CLI-Konvention):** zuerst Zeilenlimit
   `MAX_OUTPUT_LINES = 500` (die letzten 500 Zeilen bleiben, Marker
   `(previous <n> lines truncated)`), dann Zeichenlimit
   `MAX_OUTPUT_CHARS = 20_000` (Tail bleibt, Marker
   `(previous <n> characters truncated)`).

Anwendungspunkte (alle Stellen, an denen akkumulierter Output als
`content` abgegeben wird):

- Streaming-Pfad: beide `close`-Resolves (Exit 0 und Nicht-0); die
  Timeout-Anmerkung hängt am Puffer und läuft mit durch.
- Background (`waitForCompletion: false`): das finale Close-UI-Update
  (Konsistenz); der initiale Resolve liefert ohnehin `""`.
- Fallback-Pfad: `output.stdout` (Erfolg) und `error.stderr` (Fehler).

Live-`onPartialOutput`-Updates während des Laufs bleiben roh.

## Implementation Checklist

- [x] `runTerminalCommand.ts`: Konstanten (`MAX_OUTPUT_LINES`,
      `MAX_OUTPUT_CHARS`) und exportierter Helper
      `sanitizeTerminalOutput` (Pipeline 1–4); Kommentar referenziert
      diese Spec per Dateiname.
- [x] `runTerminalCommand.ts`: Anwendung im Streaming-Pfad (beide
      Close-Resolves + finales Background-UI-Update).
- [x] `runTerminalCommand.ts`: Anwendung im Fallback-Pfad (Erfolgs-`stdout`,
      Fehler-`stderr`).
