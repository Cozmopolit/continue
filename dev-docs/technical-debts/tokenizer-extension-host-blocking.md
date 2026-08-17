# Tokenizer blockiert Extension Host (Unresponsive-WARNs)

**Status:** Open
**Date:** 2026-08-17

## Problem

Rund um LLM-Calls mit großen Histories — besonders Compaction-Versuche —
warnt VS Code wiederholt:

```
WARN UNRESPONSIVE extension host: 'continue.continue' took 91–97% of 1.4–4.8s
```

Zwei V8-Profile aus einer zenith-Session (2026-08-17, `exthost-60ce36`,
`exthost-3c1c88` in `%TEMP%`, Zeitfenster passend zur Session) zeigen als
gemeinsame Ursache **synchrones Token-Zählen im Extension Host**:

| Profil | Samples | Anteil Continue-Tokenizer |
| ------ | ------- | ------------------------- |
| 60ce36 | ~4.4k   | ~87 %                     |
| 3c1c88 | ~8.4k   | ~96,6 %                   |

Hotspot-Kette (Self-Time-Dominanz):

```
compileChatMessages → countChatMessageTokens → countTokens
  → encode (BPE) → Merge-Queue: addToMergeQueue / pop / _siftDown / _greater
```

Unsere eigene JS-BPE-Implementierung (`encode` + Priority-Merge-Queue)
läuft ununterbrochen auf dem Extension-Host-Thread; mehrere Sekunden
Freeze pro großem Request sind die Folge. GC-Anteil nur ~3–6 %, kein
CITT-Code beteiligt.

## Impact

- UI-/Editor-Freezes während Runs auf langen Sessions; Compaction auf
  großen Histories fühlt sich „kaputt" an (Freeze genau dann, wenn der
  Summarize-Request die komplette History tokenisiert).
- Unabhängig vom Modell/Provider — rein lokale CPU-Arbeit.

## Mögliche Richtungen (ungeprüft)

- Token-Zählung für Summarizer-/Compaction-Requests skippen oder grob
  schätzen (dort zählt Kontext-Budgeting weniger als im Haupt-Chat).
- Cache pro (Content, Modell) — History-Präfixe wiederholen sich über
  Requests.
- Chunked/async statt eines synchronen Voll-Durchlaufs.

## Evidenz-Quelle

Board-Triage zenith-Session 2026-08-17 (to-delta #5318390706);
Profil-Analyse durch delta am 2026-08-17. Profiles liegen noch in
`%TEMP%` (`exthost-60ce36.cpuprofile`, `exthost-3c1c88.cpuprofile`).
