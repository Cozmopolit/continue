# Observability for discarded tool-call argument deltas

**Status:** Implementiert
**Date:** 2026-08-22

## Problem / Motivation

Forensik-Befund 2026-08-22 (Session `d03bcede`, Modell `OpenRouter:
Qwen3.8 max`): vier deterministische Truncationen von Tool-Call-
Argumenten, alle exakt beim Erreichen eines Regex-Literal-Anfangs im
Content. Die Session-Persistenz zeigte wohlgeformtes JSON mit vorzeitig
geschlossenem Content-Wert — das Modell hat das Tool-Call-JSON vorzeitig
beendet (`"}` mitten im Wert), der Stream endete regulär.

Der Merge-Guard in `gui/src/util/toolCallState.ts`
(`addToolCallDeltaToState`) behandelt den ersten parsebaren JSON-Zustand
als „fertig" und verwirft alle weiteren Argument-Deltas **stillschweigend**
— ohne Log, ohne Warnung. Dadurch:

1. Ist nicht unterscheidbar, ob ein Modell nach vorzeitigem JSON-Schluss
   weiter emittierte (Self-Repair, das der Fork wegwirft) oder ob der
   Stream dort wirklich endete.
2. Kostet Attribution volle Forensik (Session-Datei, Logs, Ausschluss-
   verfahren) statt eines Blicks in die Devtools.

## Scope

- `gui/src/util/toolCallState.ts`: einmalige Warnung pro Tool-Call, wenn
  nach erreichtem parsebaren JSON-Zustand weitere (nicht-leere)
  Argument-Deltas eintreffen und verworfen werden.

**Out of Scope:**

- Änderung des Merge-Verhaltens selbst (der Guard bleibt: JSON-parsebar
  = fertig). Ob nach vorzeitigem Schluss weiteremittierter Content je
  nutzbar gemacht werden kann, ist eine eigene Design-Frage.
- Provider-Bug-Reports (bewusst nicht verfolgt).

## Solution

Modulweites `Set<string>` der bereits gewarnten Tool-Call-Ids (ein Warn
pro Call, nicht pro Delta — Deltas wiederholen sich). Im Erfolgszweig des
`JSON.parse(currentArgs)`-Guards: wenn `argsDelta` nicht leer ist und die
`callId` noch nicht im Set, `console.warn` mit Call-Id und Tool-Name und
Aufnahme ins Set.

Leer-Deltas nach Komplettierung sind häufig (Stream-Auslaufen) und warnen
nicht.

## Implementation Checklist

- [x] `toolCallState.ts`: Warn-Set + `console.warn` im parsebaren Zweig
      des Argument-Guards; Kommentar referenziert diese Spec per
      Dateiname.
