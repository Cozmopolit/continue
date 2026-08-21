# Test Baseline (lokale Entwicklung)

Status: **2026-07-25** — vollständige Baseline über alle lauffähigen Suites hergestellt. **Zahlen-Refresh 2026-08-12** (Suite-/File-Counts drifteten durch Commits seit der Baseline; core: Jest 52 Suites, Vitest 100 Files).
**Zahlen-Refresh 2026-08-21 (Run-Pfad-Abschaltung)** (Board-In-Turn-Injection abgeschaltet: gui 49→48 Files / 545→535 Tests. `streamResponse_boardInjection.test.ts` gelöscht (7 Tests — User-Anweisung: keine Tests für abgeschaltete Codepfade), `util/boardInjection.test.ts` −4 (TTL-Gate-Tests des toten Run-Pfads), `hooks/useBoardWatch.test.tsx` +1 (unmittelbarer Post-Run-Poll auf busy→idle; die übrigen Watcher-Tests auf Immediate-First-Tick-Semantik umgestellt). Siehe board-wake-mode.md Amendment 2026-08-21 "Run-Pfad-Abschaltung".)
**Voller Runner 2026-08-19 (Deploy-Gate v2.2.1)** (Tranchen-/Meilenstein-Gate auf HEAD `52f2f4abb`: 8/9 Suites grün — core-jest 976, core-vitest 1905, gui 545, config-yaml 287, fetch 137, openai-adapters 160, vscode 113, binary skipped (kein Build). `extensions/cli` 2× 30s-Timeout unter Volllast (`CtrlCProcessHandling` SIGINT + `serve` --org), **solo deterministisch grün** (~13s) → katalogisierte Volllast-Flakes, siehe „Bewusst nicht behoben". Kein Code-Fail.)
**Zahlen-Refresh 2026-08-18 (gui-baseline-drift-closeout)** (Abschluss von `gui-test-baseline-drift`: gui 536→545 Tests. Die letzten 4 roten Tests waren stale Assertions in `streamResponse*.test.ts` — die Erwartungsbilder stammten von vor dem Abort-/Inline-Error-Workstream. Runtime-State ist die gewollte Wahrheit: `abortStream` setzt `streamAborted: true` (auch auf Fehlerpfaden via `cancelStream`), `inlineErrorMessage` ist ein Session-Feld. Tests entsprechend nachgezogen (3 Assertions in 2 Dateien); Suite 49/49 Files, 545/545 Tests grün.)
**Zahlen-Refresh 2026-08-18 (board-watch-jitter)** (Rate-Limit-KISS-Interim, Fork-Seite: gui 536→545 Tests — davon +2 aus diesem Workstream (`hooks/useBoardWatch.test.tsx`: Jitter-Cadence-Verhalten + `nextWatchDelayMs`-Grenzen), +7 aus nicht refreshten Commits seit der letzten Zeile (u. a. Board-Wake-Amendment fork-summary). Befund: Die Suite war vor der Änderung **rot** — (1) der Compaction-Pause-Test in `useBoardWatch.test.tsx` erwartete noch Priming während Compaction und war seit dem Self-Compaction-Commit (`077ddb9e2`, „fully paused — priming included") stale; gegen die finale Semantik umgeschrieben. (2) 5 Tests in `streamResponse*.test.ts` failen auf `streamAborted: true` statt erwartet `false` — vorbestehend auf HEAD, nicht durch diesen Workstream verursacht, separate Baustelle.)
**Zahlen-Refresh 2026-08-17 (rate-limit-retry)** (Phase-4-Tests: core-Vitest 105→106 Files — neu `llm/rateLimitRetry.vitest.ts` (+3 Tests: Native-Pfad-429-Regression über den `customFetch`-Seam, persistenter 429 erschöpft 5 Versuche, 401 ohne Retry); core-Jest `llm/utils/retry.test.ts` +16 Tests (`isRateLimitError`-Matrix, `RATE_LIMIT_RETRY`-Shape, `retryStream`-Semantik inkl. Zero-Yield-Fenster und interruptible Sleeps), insgesamt 954 Tests; packages/fetch 131→137 Tests — `stream.test.ts` +4 (`createResponseError`, `streamResponse`-Anreicherung mit status/headers, 499 bleibt still), +2 durch andere Commits seit dem letzten Refresh.)
**Zahlen-Refresh 2026-08-16 (compaction-gate)** (Board-Wake-Amendment II: gui 530→536 Tests; `redux/selectors/selectToolCalls.test.ts` +4 (`selectIsCompactionRunning` — leer/ein Index/mehrere/cleared), `hooks/useBoardWatch.test.tsx` +2 (Tick-Skip während Compaction + Wake nach Abschluss; Compaction beginnt in flight → kein Wake). Dazu in `util/compactConversation.ts` beide `loadSession`-Dispatches awaited, damit das Loading-Flag den State-Swap überlebt.)
**Zahlen-Refresh 2026-08-16 (empty-conversation-guard)** (Board-Wake-Follow-up: gui 525→530 Tests; `redux/selectors/selectToolCalls.test.ts` +4 (`selectConversationHasUserMessage` — leer/User-only/User+Assistant/Assistant-only), `hooks/useBoardWatch.test.tsx` +1 (leere Conversation: kein Wake, aber Konsum; Setup seedet jetzt per Default eine User-Message)).
**Zahlen-Refresh 2026-08-16 (board-wake-mode)** (Phase-4-Tests: gui 46→49 Files / 496→525 Tests; Abdeckung in `redux/thunks/fetchBoardPending.test.ts` (Best-Effort-Vertrag des geteilten Konsum-Thunk), `redux/selectors/selectToolCalls.test.ts` (Idle-Begriff), `hooks/useBoardWatch.test.tsx` (Priming ohne Wake, Wake-Dispatch, Composer-/Editor-Guard, Mid-Flight-Guard, Toggle/Re-Priming, Unmount) — Zahlen aus den gezielten Läufen hochgerechnet, kein Volllauf).
**Zahlen-Refresh 2026-08-15 (conversation-fork-with-summary)** (Phase-4-Tests: core-Vitest 103→105 Files; Abdeckung in `util/conversationCompaction.vitest.ts` + `util/conversationFork.vitest.ts` — Summary-Generierung inkl. Re-Compaction/"Tool cancelled"/degenerate-input-Guard, Fork-Validierung/Titel-Regel/Metadaten-Übernahme/Read-only-Garantie).
**Zahlen-Refresh 2026-08-14** (Board-Auto-Topic-Injection-Tests: core-Vitest 100→103 Files, gui 41→43 Files / 446→461 Tests. Die exakten Action-Sequenzen in `streamResponse*.test.ts` setzen `boardInjectionConsumed: true` (Zweite-Turn-Sicht), da der erste Turn jetzt `setBoardInjectionConsumed` dispatched; First-Turn-Abdeckung liegt in `streamResponse_boardInjection.test.ts`).
**Zahlen-Refresh 2026-08-15 (fresh-boot tab reset)** (Follow-up zu workspace-fresh-boot: Boot resettet die Tab-Bar auf einen Tab, Tab-Persistenz entfernt — `createFilter("tabs", [])`; Regressionstest `hooks/freshBootSingleTab.test.tsx`: gui 45→46 Files / 489→490 Tests).
**Zahlen-Refresh 2026-08-15 (workspace-fresh-boot)** (Boot immer in frische Session + Workspace-Aware-Resume: gui 44→45 Files / 485→489 Tests; Abdeckung in `redux/thunks/session.test.ts`).
**Zahlen-Refresh 2026-08-14 (workspace-scoped-session-history)** (Workspace-Scoping der History-Liste: gui 43→44 Files / 481→485 Tests; Abdeckung in `pages/history/historyWorkspaceScoping.test.tsx`).
**Zahlen-Refresh 2026-08-14 (Revision 2)** (Board-Injection auf LLM-Call-Level: gui 461→476 Tests. `boardInjectionConsumed` ist ersatzlos entfernt; `getRootStateWithClaude()` setzt stattdessen frisches `board.lastFetchAt` (TTL-Gate zu, Zweite-Turn-Sicht), die Fetch-/TTL-/Akkumulations-Abdeckung liegt in `streamResponse_boardInjection.test.ts` und `util/boardInjection.test.ts`. CodeRabbit-Follow-ups selben Tages: `newSession`-Board-Reset (beide Branches), Fresh-State-Gate-Read im Thunk, Oversized-Drop mit `tooLargeIds` → 476→481 Tests).
**Zahlen-Refresh 2026-08-15 (workspace-filesystem-watcher)** (Unit-Tests für
den neuen External-Write-Event-Buffer: ext-vscode 6→7 Files / 86→112 Tests;
Abdeckung in `util/externalFileEventBuffer.vitest.ts` — Debounce/Forced-Flush,
TTL-Suppression, Whitelist-vor-Ignore-Filter, Watcher-Folder-Lifecycle).
**Zahlen-Refresh 2026-08-15 (coderabbit-runde)** (Review-Follow-ups über 5
Specs: gui 490→496 Tests — refreshSessionMetadata-Scoping-Matrix in
`redux/thunks/session.test.ts` (+5), redacted-Thinking-Cleanup in
`redux/slices/sessionSlice.test.ts` (+1); ext-vscode 112→113 Tests —
Workspace-Gate-Regressionstest in `util/externalFileEventBuffer.vitest.ts`).
Ziel: Nie wieder "überraschende" pre-existing Test-Failures bei Feature-Arbeit.
Vor jeder Implementierung kann ein neuer Lauf gegen diese Tabelle abgeglichen werden.

> **Zum Ausführen:** `npm run test:all` — siehe [running-tests.md](running-tests.md).

> Hinweis: Die GitHub-Workflows sind im Fork deaktiviert; es gibt keine CI-Referenz.
> Diese Baseline (Windows-Dev-Machine) ist die einzige Referenz.

## Erwartete Ergebnisse (alle grün)

| Suite                      | Runner     | Kommando                                      | Erwartetes Ergebnis                                                                                                                 |
| -------------------------- | ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `core` (Jest)              | jest (ESM) | `cd core; npm test`                           | 52 Suites passed, 7 skipped, 0 failed (954 Tests passed, 89 skipped)                                                                |
| `core` (Vitest)            | vitest     | `cd core; npm run vitest`                     | 106 Files (105 passed, 1 skipped), 0 failed (siehe Timing-Hinweis unten)                                                            |
| `gui`                      | vitest     | `cd gui; npm test`                            | 48 Files / 535 Tests, 0 failed                                                                                                      |
| `packages/config-yaml`     | jest (ESM) | `cd packages/config-yaml; npm test`           | 15 Suites / 287 passed, 1 skipped                                                                                                   |
| `packages/fetch`           | vitest     | `cd packages/fetch; npm test`                 | 8 Files / 137 passed (inkl. e2e, siehe OpenSSL)                                                                                     |
| `packages/openai-adapters` | vitest     | `cd packages/openai-adapters; npx vitest run` | 17 Files / 160 passed, 5 skipped                                                                                                    |
| `extensions/vscode`        | vitest     | `cd extensions/vscode; npm test`              | 7 Files / 113 passed                                                                                                                |
| `extensions/cli`           | vitest     | `cd extensions/cli; npm test`                 | ~160 Files / ~1720 Tests, 0 failed (siehe FORCE_COLOR)                                                                              |
| `binary`                   | jest       | —                                             | **nicht teil der Baseline**: einziger Test (`test/binary.test.ts`) ist ein Integrationstest, der das gebaute Binary (`out/`) spawnt |

## Umgebungs-Fallen auf dieser Machine (Windows)

1. **`FORCE_COLOR=1` ist im Prozess-Environment gesetzt** (nicht in User/Machine-Registry;
   kommt aus der Parent-Prozesskette). Erzwingt ANSI-Farben in Non-TTY-Testläufen und
   bricht Substring-Assertions auf gestylter Terminal-Ausgabe (chalk/gradient-string).
   → `extensions/cli/vitest.config.ts` setzt `env.FORCE_COLOR = "0"`. Bei ähnlichen
   Fehlern in anderen Suites zuerst daran denken.

2. **`core.autocrlf=true` + teils CRLF-committed Fixtures**: `.diff`-Testfixtures werden
   mit CRLF ausgecheckt (und zwei Dateien unter `core/edit/lazy/test-examples/` sind im
   Fork sogar mit CRLF **committet**; Upstream hat LF). Tests, die Fixture-Inhalte an
   `"\n---\n"` splitten, müssen CRLF normalisieren (in `deterministic.test.ts` und
   `streamDiff.vitest.ts` gefixt).

3. **Symlinks benötigen Developer Mode / Admin**: `core/indexing/walkDir.test.ts`
   ("should skip symlinks") skipt jetzt graceful bei EPERM/EACCES.

4. **OpenSSL nicht auf PATH**, aber bei `C:\Program Files\Git\usr\bin\openssl.exe`
   (Git for Windows) vorhanden. `packages/fetch/src/fetch.e2e.test.ts` löst OpenSSL
   über PATH → Git-Bundle auf und skipt die Enterprise-Cert-Tests, wenn nichts gefunden
   wird. Auf dieser Machine laufen sie echt durch.

5. **Live-API-Tests** (`core/llm/llm.test.ts`) rufen echte Provider-Endpunkte auf.
   Ohne Keys (Env oder `core/.env` via dotenv) werden sie per-Provider geskipt
   (`skip: !process.env.*_API_KEY`); ganz ohne Keys läuft ein Placeholder-Test.
   Globaler Abschalter bleibt `IGNORE_API_KEY_TESTS=true`.
   Achtung: Mit gesetzten Keys gehen die Requests **wirklich raus** (OpenAI 401 etc.).

6. **Timing-sensitiv**: `core/config/yaml/LocalPlatformClient.vitest.ts` re-importiert
   in seinen Hooks den Fixtures-Modulgraphen pro Test kalt (`vi.resetModules()`) —
   kann das 10s-`hookTimeout` überschreiten → Datei hat jetzt 30s-`test`/`hookTimeout`
   via `vi.setConfig`. Grundsätzlich: volle Suiten **nicht parallel** laufen lassen
   (der Runner in `scripts/run-all-tests.mjs` ist deshalb sequentiell).

7. **Jest-ESM-Overhead**: `core`-Jest-Files brauchen ~10-20s pro File
   (`--experimental-vm-modules`), `maxWorkers: 1` ist konfiguriert (in-band).

8. **PowerShell**: `;` statt `&&`; `>` schreibt UTF-16; `NUL` erzeugt echte Datei
   (in `.gitignore`); FORCE_COLOR-Warnung ("NO_COLOR ignored") in Logs ignorieren.

## Reparierte pre-existing Failures (2026-07-25)

Alle Fixes sind **test-only**; kein Produktionscode geändert.

### core (Jest) — 33 Failures in 5 Suites

- `llm/llm.test.ts` (19): Live-API-Tests ohne Keys → Skip-Guards (s.o.).
- `edit/lazy/deterministic.test.ts` (9): CRLF in `.diff`-Fixtures → Normalisierung.
- `indexing/CodebaseIndexer.test.ts` (3): Embed-Mocks ohne ILLM-Identitätsfelder
  (`title`/`underlyingProviderName`/`maxEmbeddingChunkSize`) → `embedModelsAreEqual()`
  sah "keine Änderung" → `handleConfigUpdate` triggerte nie Reindex. Mocks ergänzt.
- `indexing/chunk/chunk.test.ts` (1): `path.join`-Backslashes vs. URI-Basename-Logik
  → Forward-Slash-Pfade im Test.
- `indexing/walkDir.test.ts` (1): EPERM bei Symlink-Erzeugung → Skip.

### core (Vitest) — 66 Failures in 6 Files

- `config/mcpProxyModelDiscovery.vitest.ts` (2): Mock-SSE-Stream ohne `[DONE]`-Sentinel
  → Stream-Forensics (PrematureStreamEndError) schlug korrekt an. Mock streamt jetzt
  protokollkorrekt (`finish_reason`-Chunk + `[DONE]`). **Erwarteter Bruch durch unser
  Feature**, kein Bug.
- `diff/streamDiff.vitest.ts` (4): CRLF-Fixtures → Normalisierung.
- `autocomplete/.../RootPathContextService.vitest.ts` (43): `getWorkspaceDirs()`
  liefert `file://`-URIs; Test nutzte sie als Pfade → `fileURLToPath`-Konversion
  (`localPathOrUriToPath`) in `testUtils.ts`.
- `util/sanitization.vitest.ts` (13): Integrationstests brauchen `/bin/sh` (POSIX)
  → `describe.skipIf(win32)`.
- `tools/implementations/resolveWorkingDirectory.vitest.ts` (3) +
  `runTerminalCommand.vitest.ts` (1): Unix-`file://`-Semantik → `it.skipIf(win32)`.

### gui — 1 Failure

- `pages/history/history.test.tsx`: `ParallelListeners.initialLoadConfig` ruft
  `getIdeSettings` auf, das in `MockIdeMessenger`-Defaults fehlte → Request warf →
  `refreshSessionMetadata` wurde nie dispatched. Default ergänzt (komplette
  `IdeSettings`-Shape). Nebenwirkung: Suite 383/383 grün.

### packages/fetch — 6 e2e Failures

- `fetch.e2e.test.ts` "Enterprise scenarios": OpenSSL fehlte auf PATH; der
  Fallback-Code schrieb ungültige Toy-Zertifikate (PEM bad base64 beim Server-Start).
  Jetzt: OpenSSL-Auflösung (PATH/Git-Bundle), sauberer Fehler, Skip wenn unavailable.

### extensions/cli — 8 Failures in 5 Files

- Allesamt FORCE_COLOR-Effekt (s.o.): `vitest.config.ts` → `env.FORCE_COLOR = "0"`.

## Bewusst nicht behoben / Einschränkungen

- `binary`: erfordert vollständigen Binary-Build; kein Unit-Test-Bedarf.
- `extensions/cli`: TUI-Tests (ink/stdin-Simulation) können unter Volllast flaken
  (beobachtet: `TUIChat.editMessage` "edit selector should exit with Esc", 2× —
  solo deterministisch grün). Bei Failure zuerst Datei solo nachlaufen lassen.
  Ebenso last-sensitiv (Prozess-/Signal-/Service-Init-Timing, laufen knapp unter
  dem 30s-Timeout): `src/__tests__/CtrlCProcessHandling.test.ts` "Process SIGINT
  handling functions > exports the necessary functions for exit message handling"
  und `src/commands/serve.test.ts` "serve command > should pass the --org flag
  through to initializeServices" — beobachtet 2026-08-19 im Runner-Gesamtlauf
  (je 30s-Timeout, solo deterministisch grün in ~13s).
- `core` (Vitest): `autocomplete/generation/ListenableGenerator.vitest.ts`
  „should allow listeners to receive values" flakt (Timing-Race:
  Listener-Spy sieht 1, 2 statt des letzten Werts) — beobachtet
  2026-08-12 im Runner-Gesamtlauf und 2026-08-20 auch im Solo-Lauf
  (4 Solo-Durchläufe: 3× grün, 1× rot; unabhängig von aktuellem Worktree,
  gegen sauberen HEAD verifiziert). Bei Failure: Baseline-Referenz genügt —
  keine weiteren Isolations-Runs (Test-Disziplin, running-tests.md).
- `gui`: `MockIdeMessenger` hat weiterhin kein `history/load`-Default → kosmetischer
  `console.error` im History-Test (kein Testimpact).
- `core` Jest: "Jest did not exit one second after the test run" (open handles) —
  bekannte Upstream-Baustelle, kein Failure.
- `core/llm/llm.test.ts` mit gesetzten Keys: echte Netzwerkcalls (gewollt).
