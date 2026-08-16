# Continue-Fork: Conversations und Logs auf Windows bereinigen

Operations-How-to für Windows-Maschinen, auf denen der Continue-Fork läuft
(VS Code). Alle Angaben gegen Fork v2.1.0 verifiziert (`core/util/paths.ts`,
`core/util/history.ts`, `core/data/log.ts`, `binary/src/index.ts`).

**Regel 0: Vor jedem Eingriff VS Code komplett schließen.** `sessions.json`,
`index.sqlite` und die Logs werden laufend geschrieben; paralleles Aufräumen
erzeugt Race-Zustände.

## 1. Storage-Root

Alles liegt unter `%USERPROFILE%\.continue\`. Überschreibbar per
Umgebungsvariable `CONTINUE_GLOBAL_DIR` (wird in `core/util/paths.ts` beim
Modulload aufgelöst) — auf Sondermaschinen zuerst prüfen, ob sie gesetzt ist.

## 2. Was liegt wo

| Pfad                                                                                                                                          | Inhalt                                         | Größe (Beobachtung) | Löschen?                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------- | ------------------------------------------ |
| `sessions\`                                                                                                                                   | Conversations (JSON pro Session) + Indexdatei  | ~300 MB (177 Files) | selektiv, s. §4                            |
| `logs\`                                                                                                                                       | core.log, prompt.log, fork-Diag-JSONLs         | klein–mittel        | komplett safe                              |
| `dev_data\`                                                                                                                                   | lokale Telemetrie-JSONLs + Token-Zähler-SQLite | **>2 GB möglich**   | JSONLs safe, sqlite = Statistik-Reset      |
| `index\`                                                                                                                                      | Embeddings-/Codebase-Index                     | **~1.7 GB möglich** | nur mit Re-Index-Bereitschaft              |
| `.utils\`                                                                                                                                     | repo_map, esbuild, Chromium-Snapshots (Docs)   | variabel            | regeneriert sich, Download-Kosten          |
| `.migrations\`                                                                                                                                | 0-Byte-Marker abgelaufener Migrationen         | ~0                  | **behalten**, sonst Re-Run der Migrationen |
| `config.yaml`/`config.json`/`config.ts`, `.env`, `.continuerc.json`, `rules\`, `prompts\`, `.continueignore`, `package.json`, `tsconfig.json` | Konfiguration                                  | klein               | **niemals**                                |

## 3. Sessions: Aufbau und alt/neue-Unterscheidung

Zwei Ebenen, die konsistent bleiben müssen:

1. **`sessions\sessions.json`** — Metadaten-Index und _einzige_ Quelle der
   GUI-History (`HistoryManager.list` liest nur diese Datei, kein
   Verzeichnis-Scan). Eintrag: `sessionId`, `title`, `dateCreated`
   (Epoch-Millis als String, **nur Erzeugungsdatum**), `workspaceDirectory`,
   `messageCount`.
2. **`sessions\<sessionId>.json`** — komplette Conversation (Keys:
   `sessionId`, `title`, `workspaceDirectory`, `history[]`, optional
   `mode`/`chatModelTitle`/`usage`). **Keinerlei Zeitstempel im Inhalt.**

Daraus folgt:

- **Letzte Aktivität** einer Session = **LastWriteTime der Datei** (die Datei
  wird bei jedem Save vollständig neu geschrieben). Das ist das einzige
  zuverlässige „wann zuletzt genutzt"-Signal.
- **Erzeugungsdatum** = `dateCreated` aus `sessions.json`.
- Datei ohne Index-Eintrag = verwaist und in der GUI unsichtbar.
- Index-Eintrag ohne Datei = „Geist": bleibt in der History gelistet, öffnet
  als leere Session, und GUI-Löschen scheitert danach
  („Session file … does not exist"). **Deshalb beim Datei-Löschen immer auch
  den `sessions.json`-Eintrag entfernen** (oder stattdessen die GUI nutzen,
  die beides synchron erledigt).
- Die gerade offene(n) Session(s) werden laufend umgeschrieben — Dateien mit
  frischer LastWriteTime nicht anfassen.

## 4. Bereinigungs-Rezepte (PowerShell)

### 4.1 Inventur

```powershell
$root = "$env:USERPROFILE\.continue"
Get-ChildItem $root -Recurse -File -Force |
  Group-Object { $_.Directory.FullName } |
  ForEach-Object {
    [PSCustomObject]@{
      Folder = $_.Name.Replace($root, '.')
      Files  = $_.Count
      MB     = [math]::Round(($_.Group | Measure-Object Length -Sum).Sum / 1MB, 1)
    }
  } | Sort-Object MB -Descending | Format-Table -AutoSize
```

### 4.2 Alte Sessions löschen (inkl. Index-Sync)

Beispiel: alles, was länger als 30 Tage nicht mehr angefasst wurde.

```powershell
$sess = "$env:USERPROFILE\.continue\sessions"
$old = Get-ChildItem $sess -Filter *.json |
  Where-Object { $_.Name -ne 'sessions.json' -and
                 $_.LastWriteTime -lt (Get-Date).AddDays(-30) }

# Erst anzeigen, dann löschen:
$old | Select-Object Name, LastWriteTime, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}
$old | Remove-Item

# sessions.json synchronisieren (Geister vermeiden):
$listPath = Join-Path $sess 'sessions.json'
$keep = (Get-ChildItem $sess -Filter *.json |
         Where-Object { $_.Name -ne 'sessions.json' }).BaseName
$kept = @((Get-Content $listPath -Raw | ConvertFrom-Json) |
          Where-Object { $keep -contains $_.sessionId })
$json = if ($kept.Count -eq 0) { '[]' } else { $kept | ConvertTo-Json -Depth 10 }
# ACHTUNG: WriteAllText schreibt UTF-8 OHNE BOM. Nicht Set-Content -Encoding UTF8
# verwenden (Windows PowerShell 5.1 schreibt BOM, daran scheitert JSON.parse
# in Continue und die History ist tot).
[System.IO.File]::WriteAllText($listPath, $json)
```

Alternative ohne Skript: einzelne Sessions im GUI-Verlauf (History-View)
löschen — `HistoryManager.delete` hält Datei und Index automatisch konsistent.
Für Massenbereinigung ist das aber zu mühsam.

### 4.3 Logs

```powershell
Remove-Item "$env:USERPROFILE\.continue\logs\*" -Force
```

Alles im Ordner ist append-only ohne Rotation und wird bei Bedarf neu
angelegt. Im Einzelnen: `core.log`/`prompt.log` (existieren nur, wenn der
Core als Binary läuft, also JetBrains; VS Code loggt in-process),
`stream-forensics.jsonl` (Fork: Stream-/TLS-Fehlerforensik, vor dem Löschen
ggf. auswerten!), `tunnel-diag.jsonl` (nur aktiv, solange
`tunnel-diag.enabled` existiert; kann schnell groß werden).

### 4.4 dev_data (größter Hebel)

Lokale Dev-Data-JSONLs werden **immer** geschrieben („local logs always on"),
ohne Abschalt-Option und ohne Rotation — `chatInteraction.jsonl` wurde hier
beobachtet mit >2 GB. Die JSONLs sind gefahrlos löschbar (werden beim nächsten
Event neu angelegt):

```powershell
Remove-Item "$env:USERPROFILE\.continue\dev_data\*\*.jsonl" -Force
```

`dev_data\devdata.sqlite` nur löschen, wenn die Token-Statistik im GUI
(Tokens pro Tag/Modell) zurückgesetzt werden darf — die Tabelle wird beim
nächsten Zugriff neu angelegt.

### 4.5 index\ (nur bei Re-Index-Bereitschaft)

```powershell
Remove-Item "$env:USERPROFILE\.continue\index\index.sqlite*" -Force
```

`index.sqlite` (+`-wal`/`-shm`, immer zusammen) hält den Embedding-Index
(beobachtet: 1.7 GB). Löschen nur bei geschlossener IDE; danach läuft der
vollständige Re-Index. **`index\globalContext.json` behalten** (Index-Status,
Modellauswahlen); `autocompleteCache.sqlite` ist ein entbehrlicher Cache.

## 5. Prävention / Grenzen

- Es gibt keine eingebaute Retention — weder für Sessions noch für
  `dev_data`. Regelmäßiges Aufräumen (z. B. monatlich §4.1–4.4) ist aktuell
  der einzige Weg.
- `dev_data` lässt sich nicht per Config abschalten (nur Remote-Ziele sind
  konfigurierbar, lokale Logs laufen immer).
- Agent-Sessions mit vielen Tool-Calls werden groß (mehrere MB pro Session
  ist normal) — das erklärt den Löwenanteil in `sessions\`.
