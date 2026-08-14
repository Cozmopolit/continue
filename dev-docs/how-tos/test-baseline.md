# Test Baseline (lokale Entwicklung)

Status: **2026-07-25** — vollständige Baseline über alle lauffähigen Suites hergestellt. **Zahlen-Refresh 2026-08-12** (Suite-/File-Counts drifteten durch Commits seit der Baseline; core: Jest 52 Suites, Vitest 100 Files).
**Zahlen-Refresh 2026-08-14** (Board-Auto-Topic-Injection-Tests: core-Vitest 100→103 Files, gui 41→43 Files / 446→461 Tests. Die exakten Action-Sequenzen in `streamResponse*.test.ts` setzen `boardInjectionConsumed: true` (Zweite-Turn-Sicht), da der erste Turn jetzt `setBoardInjectionConsumed` dispatched; First-Turn-Abdeckung liegt in `streamResponse_boardInjection.test.ts`).
**Zahlen-Refresh 2026-08-14 (Revision 2)** (Board-Injection auf LLM-Call-Level: gui 461→476 Tests. `boardInjectionConsumed` ist ersatzlos entfernt; `getRootStateWithClaude()` setzt stattdessen frisches `board.lastFetchAt` (TTL-Gate zu, Zweite-Turn-Sicht), die Fetch-/TTL-/Akkumulations-Abdeckung liegt in `streamResponse_boardInjection.test.ts` und `util/boardInjection.test.ts`).
Ziel: Nie wieder "überraschende" pre-existing Test-Failures bei Feature-Arbeit.
Vor jeder Implementierung kann ein neuer Lauf gegen diese Tabelle abgeglichen werden.

> **Zum Ausführen:** `npm run test:all` — siehe [running-tests.md](running-tests.md).

> Hinweis: Die GitHub-Workflows sind im Fork deaktiviert; es gibt keine CI-Referenz.
> Diese Baseline (Windows-Dev-Machine) ist die einzige Referenz.

## Erwartete Ergebnisse (alle grün)

| Suite                      | Runner     | Kommando                                      | Erwartetes Ergebnis                                                                                                                 |
| -------------------------- | ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `core` (Jest)              | jest (ESM) | `cd core; npm test`                           | 52 Suites passed, 7 skipped, 0 failed                                                                                               |
| `core` (Vitest)            | vitest     | `cd core; npm run vitest`                     | 103 Files (102 passed, 1 skipped), 0 failed (siehe Timing-Hinweis unten)                                                            |
| `gui`                      | vitest     | `cd gui; npm test`                            | 43 Files / 476 Tests, 0 failed                                                                                                      |
| `packages/config-yaml`     | jest (ESM) | `cd packages/config-yaml; npm test`           | 15 Suites / 287 passed, 1 skipped                                                                                                   |
| `packages/fetch`           | vitest     | `cd packages/fetch; npm test`                 | 8 Files / 131 passed (inkl. e2e, siehe OpenSSL)                                                                                     |
| `packages/openai-adapters` | vitest     | `cd packages/openai-adapters; npx vitest run` | 17 Files / 160 passed, 5 skipped                                                                                                    |
| `extensions/vscode`        | vitest     | `cd extensions/vscode; npm test`              | 6 Files / 86 passed                                                                                                                 |
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
- `core` (Vitest): `autocomplete/generation/ListenableGenerator.vitest.ts`
  „should allow listeners to receive values" kann unter Volllast flaken
  (Timing-Race: Listener-Spy sieht 1, 2 statt des letzten Werts —
  beobachtet 2026-08-12 im Runner-Gesamtlauf, solo deterministisch grün).
  Bei Failure zuerst solo nachlaufen lassen.
- `gui`: `MockIdeMessenger` hat weiterhin kein `history/load`-Default → kosmetischer
  `console.error` im History-Test (kein Testimpact).
- `core` Jest: "Jest did not exit one second after the test run" (open handles) —
  bekannte Upstream-Baustelle, kein Failure.
- `core/llm/llm.test.ts` mit gesetzten Keys: echte Netzwerkcalls (gewollt).
