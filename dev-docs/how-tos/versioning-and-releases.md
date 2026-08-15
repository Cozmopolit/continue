# Versioning & Releases (Continue-Fork)

Festgelegt 2026-08-15. Verbindlich für alle künftigen Builds.

## Grundsatz: SemVer-Kontinuation

Der Fork führt die Versionslinie des finalen Upstream-Standes (2.1.0) fort:

- **Minor** (2.2.0, 2.3.0, …): Builds mit User-Features.
- **Patch** (2.2.1, …): reine Fix-Builds.
- **Major**: nur bei echten Breaking Changes (aktuell nicht absehbar).

Upstream ist eingestellt; eine Versionskollision mit dem toten Upstream ist
ausgeschlossen, und selbst ein wiederbelebtes Upstream-Release würde sich
nie auflösend berühren — die Installation erfolgt per VSIX, nicht per
Marketplace.

Verworfene Alternativen (nicht ohne neuen Grund wieder auflegen):

- **Upstream-Suffix** (`2.1.0-fork.N`): SemVer-Prerelease-Semantik sortiert
  den Suffix-Build **vor** die Basisversion; vsce/Marketplace-Tooling
  behandelt solche Versionen als Preview.
- **Epoch-Sprung** (`3.0.0`): impliziert Breaking Changes, die es nicht gibt.
- **CalVer** (`2026.8.x`): verliert das Feature-vs-Fix-Signal und die
  2.x-Linie als erkennbare Upstream-Herkunft.

## Single Source of Truth

Einzige user-sichtbare Version: das `version`-Feld in
`extensions/vscode/package.json` (steuert VSIX-Dateiname und Anzeige in
VS Code). Die internen Paketversionen (`@continuedev/core`, `binary`,
`@continuedev/cli`) werden nicht gepublished und bleiben unangetastet —
kein Lockstep, kein Sync-Script.

## Release-Ritual

1. **Test-Gate** nach AGENTS.md Regel 7: die von der Änderung betroffenen
   Suites müssen seit der Änderung grün sein (ein gezielter Lauf genügt);
   voller Runner-Lauf nur bei paketübergreifenden Änderungen oder längeren
   Einheiten.
2. **Version bump** in `extensions/vscode/package.json`.
3. **Eigener Commit** `chore: release vX.Y.Z` — enthält nur den Bump.
4. **Annotated Tag** auf diesen Commit: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
   Der Tag beantwortet ab jetzt „welcher Commit steckt in diesem Build?" —
   SHA256-Vergleiche von `out/extension.js` sind dafür obsolet.
5. **Agent-Changelog**: Eintrag im Board-Topic `continue-updates` +
   Pointer in `Allgemein` (MsgBoard-Etikette in AGENTS.md).
6. **Push** ist ein separater, seltener Schritt (AGENTS.md Regel 7) — Tags
   fahren beim nächsten Push mit (`git push origin vX.Y.Z` oder
   `--follow-tags`).

## Sonderfälle

- **Pre-Release-Builds**: `npm run package:pre-release` existiert in
  `extensions/vscode`, wird aktuell nicht genutzt (interne VSIX-Verteilung
  kennt keinen Marketplace-Kanal).
- **Nachträgliches Stempeln**: Bump + Tag auf HEAD ist zulässig, wenn der
  Code-Stand zum bereits gebauten VSIX identisch ist (so geschehen bei
  v2.2.0 am 2026-08-15).
