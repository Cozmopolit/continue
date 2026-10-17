# Spec: Node-24-Toolchain-Bump + Lockfile-/Audit-Baseline

**Status:** Abgeschlossen (Gates grün, 2026-10-17)
**Stand:** 2026-10-17
**Autor:** citt-delta
**Kontext:** `technical-debts/continue-fork-long-term-maintenance.md` (Autumn-2026-Fenster:
Toolchain-Bump „solange alles grün ist"). Die Richtungsentscheidungen vom 2026-10-17
(JetBrains frozen, Indexing-Insel ungenutzt, MCP v2 beidseitig geplant) sind dort
dokumentiert, nicht hier.

## Ziel

Build- und Test-Toolchain des Monorepos von Node 20 (EOL 2026-04-30) auf Node 24 LTS
heben und die Lockfiles samt `npm audit`-Baseline aktualisieren — prophylaktisch,
solange der Build grün ist.

## Normative Entscheidungen

- **Zielversion Node 24 LTS** (active LTS, Maintenance bis ~2028). Nicht 22 (bereits
  maintenance, EOL 2027-04), nicht 26 (zu frisch für das native Prebuild-Ökosystem).
- **Runtime ≠ Toolchain:** Die Extension läuft zur Laufzeit im VS Code Extension Host
  (Electron-Node, von Microsoft geliefert). Der Bump betrifft ausschließlich
  Build/Tests/Install — nicht die produktive Installation.
- **Bruch-Policy:** `binary/` (JetBrains, pkg mit node18-Target) darf bei Bruch
  sterben — dokumentieren, nicht reparieren. Die Indexing-Natives (`vectordb`,
  `onnxruntime-node`, `@xenova/transformers`, `sqlite3`) sind in unseren Deployments
  funktional ungenutzt: sie müssen unter Node 24 nur noch installieren/bauen, nicht
  funktionieren; bei hartem Bruch werden sie entfernt statt repariert (sauberer
  Ausbau ist ein separates Folgeprojekt).

## Out of Scope

- MCP SDK v2 Port (`@modelcontextprotocol/client`) — beidseitig mit der
  CITT-Server-Seite zu planen, eigenes Projekt (Beobachtungs-Deadline: v1-Support
  läuft ~Anfang 2027 aus).
- Ausbau der Indexing-Insel (separates Mini-Projekt).
- Provider-SDK-Majors (`openai`, `@anthropic-ai/sdk` — gebuffert durch
  `packages/openai-adapters`).
- JetBrains-Kompatibilität (frozen).

## Vorgehen (Checkliste)

1. Node 24 auf der Maschine bereitstellen (nvm o.ä.); `node --version` zeigt 24.x.
2. `.nvmrc` auf die installierte 24.x setzen.
3. `engines.node` in allen Workspaces mit `engine-strict` auf die 24er-Linie heben
   (bekannt: `core/`, `extensions/vscode/`; Bestand vor dem Edit inventarisieren).
4. Clean rebuild aller Workspaces (frische `node_modules` unter Node 24).
5. **Gate:** voller Test-Runner grün (Meilenstein-Gate — paketübergreifende
   Toolchain-Änderung ohne passende gezielte Suite).
6. **Gate:** VSIX bauen + Smoke: Extension aktiviert, CITT.MCP-Tunnel antwortet,
   Board-Pfad funktioniert.
7. Lockfiles pro Workspace refreshen (es gibt kein Root-Lockfile);
   `npm audit`-Baseline je Workspace ziehen und dokumentieren. Quick Wins nur im
   bestehenden SemVer-Rahmen; Übeltäter werden zurückgepinnt statt eskaliert.
8. Doku-Nachzug: `technical-debts/continue-fork-long-term-maintenance.md`
   (Ist-Stand), `how-tos/environment-gotchas.md` (Node-24-Notiz).

## Verifikation

Gates 5 und 6 sind die Verifikation. Keine neuen Tests.

## Revision 2026-10-17 — tatsächlicher Verlauf

Vier Befunde erforderten Anpassungen gegenüber dem ursprünglichen Vorgehen
(alle im Workstream mit User-Go entschieden):

1. **`packages/*` referenzierten `@continuedev/*` per Semver aus dem Registry**
   statt per `file:` — die Arbeitsfähigkeit beruhte auf manuell gepflegten
   Junctions (alte Gotcha), die jeder Clean-Rebuild zerstörte. Fix: alle 6
   internen Referenzen in `openai-adapters`, `continue-sdk`, `config-yaml`,
   `fetch` auf `file:../<pkg>` umgestellt (symmetrisch zu `core`). npm legt
   die Junctions seither selbst an; die Gotcha ist an der Wurzel beseitigt.
2. **`vectordb` als Direkt-Dep von `extensions/vscode` entfernt** — zog
   transitiv sqlite3 herein, dessen Install-Skript unter Node 24 node-gyp
   anwarf (kein Prebuild, node-gyp 8.4.1 ohne Windows-SDK). Bruch-Policy:
   entfernt statt repariert (kein Import im vscode-src; Bundle-Resolution
   läuft über `core/node_modules`).
3. **`node-abi`-Staleness war die eigentliche sqlite3-Ursache** (`core`
   3.92 grün vs. `vscode` 3.71 → „N-API version undefined"). Overrides in
   `extensions/vscode/package.json`: `node-abi ^3.92.0`,
   `prebuild-install ^7.1.2`.
4. **Install-Skript-Strategie für `extensions/vscode`**: `npm install
--ignore-scripts` + gezieltes `npm rebuild esbuild`; `rg.exe` wird aus
   `@vscode/ripgrep-win32-x64/bin` nach `@vscode/ripgrep/bin` kopiert (das
   Paket hat kein postinstall mehr). sqlite3 bleibt in diesem Workspace
   binary-los (dbinfoz/@database ungenutzt); die VSIX-sqlite3 kopiert
   `prepackage.js` ohnehin aus `core/node_modules`.

Gates: voller Runner 7/8 grün + 2 katalogisierte Volllast-Flakes (solo grün,
siehe test-baseline.md); VSIX `continue-2.2.4.vsix` gebaut. Audit-Baseline:
siehe technical-debts/continue-fork-long-term-maintenance.md.
