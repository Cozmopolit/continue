# VSIX Deploy: Smoke Tests

Nach dem Bauen + Installieren einer neuen VSIX und dem VSC-Restart: schnelle
Checks, dass der Fork-Build gesund ist. Wiederverwendbar bei jedem Deploy.

**Identität des Builds:** Die Extension-Version bleibt `2.1.0` (wird nicht
gebumpt) — die Versionsanzeige kann Builds nicht unterscheiden. Identität =
installierte VSIX-Datei (Name/Zeitstempel) + Verhaltensmarker unten. Beim
Bauen Commit notieren (`git rev-parse HEAD`).

## 1. Baseline-Gesundheit (immer)

| Check                                                  | Grün sieht so aus                                           |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Model Picker                                           | Tunneled Models erscheinen (Endpoint-IDs), MCP-Tunnel steht |
| Normaler Chat via OpenRouter (strict-termination Host) | streamed bis zum Ende, kein Error-Dialog                    |
| `%USERPROFILE%\.continue\logs\stream-forensics.jsonl`  | keine neuen Einträge nach normalen Chats                    |
| Autocomplete (streamFim-Pfad, nicht instrumentiert)    | funktioniert wie gewohnt                                    |

## 2. Feature-Marker (pro Deploy auswählen, was neu im Build ist)

| Feature (Commit)                                               | Smoke-Test                                                     | Grün                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absolute Token-Counts in der GUI (`a4f671eef`)                 | Chat öffnen                                                    | Token-Anzeige zeigt absolute Werte                                                                                                                                                                                                              |
| Kimi K3 preserved thinking (`02fe2ce55`)                       | 3+ Turns mit Kimi K3 via OpenRouter                            | bleibt kohärent (früher: Loops/Halluzinationen ab Turn 2–3); Reasoning-Blöcke rendern                                                                                                                                                           |
| Opt-in Prompt-Logging (`fa40e2d6b`)                            | Config → User Settings → „Enable prompt logging" → Chat senden | Session-File in `%USERPROFILE%\.continue\sessions\` enthält `promptLogs` am Assistant-Item; Chat-Interaktion in devdata (`%USERPROFILE%\.continue\dev_data`). Danach ggf. wieder deaktivieren (wächst Session-Files quadratisch in Agent-Loops) |
| Stream-Forensics + Probe-Assessment (`d8a74f736`, `8831bfeb0`) | **nur passiv**: keine Fehlalarme im Normalbetrieb              | ein echter Abbruch zeigt Dialog mit `Possible causes:`…, `Provider request id: gen-…`, `Provider-reported model: …`, `Assessment: …`; JSONL-Record enthält `requestId`/`providerModel`                                                          |

**Keinen Abbruch forcieren** — nicht deterministisch auslösbar. Passiert einer
natürlich: Dialog-Text + JSONL-Zeile sichern (das ist der eigentliche Zweck
der Forensik).

## 3. Bei Problemen — sammeln

- Vollständigen Text des Error-Dialogs (kopierbar)
- Tail von `%USERPROFILE%\.continue\logs\stream-forensics.jsonl`
- Developer-Tools-Konsole (Help → Toggle Developer Tools)
- Bei Prompt-Logging-Fragen: betroffenes Session-File

## 4. Danach

Smoke-Ergebnisse sind ephemeral — nichts zu committen. Ein echter Incident
dagegen bekommt einen Eintrag in `technical-debts/` (Lifecycle siehe
`../README.md`).
