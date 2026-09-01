# Did-you-mean-Vorschläge für unbekannte Tool-Namen

**Status:** Implementiert
**Date:** 2026-09-01

## Problem / Motivation

LLMs emittieren gelegentlich Tool-Call-Namen, die nicht exakt mit den
angekündigten Tool-Namen übereinstimmen: Verkürzungen (`run_terminal_cmd`
statt `run_terminal_command`), Tippfehler, verwechselte Varianten. Das ist
erwartbares Modellverhalten, kein Infrastrukturfehler.

Heutige Behandlung:

- **IDE:** `handleToolCall` (`core/core.ts`) wirft `Tool <name> not found`;
  der Messenger liefert `status: "error"`, `callToolById` (GUI) wirft weiter
  → **Stream-Error, der Run stirbt**. Das Modell erhält kein Feedback und
  kann sich nicht selbst korrigieren.
- **CLI:** `preprocessStreamedToolCalls` wandelt denselbe Fehler in eine
  Tool-Result-Nachricht an das Modell um (gut) — aber die Nachricht enthält
  keinen Hinweis darauf, welches Tool gemeint gewesen sein könnte.

Beobachteter Fall: ein Agent rief `run_terminal_cmd` auf (Verkürzung von
`run_terminal_command`, Levenshtein-Distanz 4) — für einen simplen
Ähnlichkeitsabgleich trivial auflösbar.

Ziel: unbekanntes Tool-Name → selbstkorrigierender Feedback-Loop statt
Run-Abbruch. Die Fehlermeldung nennt den/die ähnlichsten bekannten
Tool-Namen, und in der IDE bekommt das Modell die Chance, den Call mit dem
korrigierten Namen im nächsten Turn zu wiederholen.

## Scope

- Neuer purer Helper `suggestToolNames` in `core/tools/suggestToolName.ts`.
- `core/core.ts` (`handleToolCall`): unbekannter Name wird zum
  Tool-Result-Fehler statt zum Throw (IDE-Verhalten ändert sich von
  Run-Abbruch auf Fortsetzung mit Fehler-Feedback).
- Anreicherung der bestehenden Not-found-Meldungen mit dem Hinweis an allen
  Dispatch-Stellen (Core + CLI).
- Neuer `ContinueErrorReason.ToolNotFound`.

**Out of Scope:**

- Stille Aliase/Umleitung falscher Namen (verworfen, siehe Analysis:
  Policy-Bypass-Risiko, Audit-Trail, Verschleierung von Modellverhalten).
- Änderungen an Policy-Evaluierung, Bestätigungsfluss oder GUI-Fehleranzeigen.
- Falsche/fehlende Argumente bei gültigem Tool-Namen.

## Analysis

Zwei Dispatch-Oberflächen mit heute inkonsistenter Semantik:

```
IDE:  Modell → ToolCall → GUI callToolById → core "tools/call"
        → handleToolCall: config.tools.find(name) → MISS → throw
        → Messenger {status:"error"} → callToolById wirft → Stream-Error (Run tot)

CLI:  Modell → ToolCall → preprocessStreamedToolCalls
        → availableTools.find(name) → MISS → Error → catch
        → errorChatEntry (Tool-Result) → zurück ans Modell
```

**Bestehender Fehlerkanal für Tool-Fehler (IDE):** eine `tools/call`-Antwort
mit `errorMessage`/`errorReason` wird in `callToolById` in einen
`ContinueError` gewickelt → `errorToolCall` + Fehler-Context-Item →
`streamResponseAfterToolCall` → der Run läuft weiter, das Modell sieht den
Fehler im nächsten Turn. Dieser Kanal wird bereits für Ausführungsfehler
genutzt und braucht keine GUI-Änderungen — unbekannte Namen können ihn
mitbenutzen.

**Gates bleiben erhalten:** Die Reklassifikation greift erst in
`handleToolCall`, hinter Policy-Evaluierung und Bestätigungsfluss —
unverändert zu heute, nur dass danach kein Throw mehr kommt. Es wird nichts
ausgeführt: die Fehlermeldung ersetzt die Ausführung.

**Warum keine stillen Aliase:** ein Alias-Mechanismus müsste vor der
namensbasierten Policy-Prüfung kanonisieren (Permission-Bypass-Risiko bei
einem bestätigungspflichtigen Tool), würde den persistierten Tool-Call-Verlauf
umschreiben (Audit-Trail) und würde ein Modellverhalten kaschieren, dessen
sichtbare Fehlermeldung genau das Korrektursignal ist. Außerdem wäre es eine
Einzelfall-Spezialbehandlung ohne natürliche Abbruchkriterien (welche
Halluzination bekommt als nächstes ein Alias?).

**Kompatibilitäts-Constraint:** Die CLI-Testsuite assertet die Nachricht
`Tool nonexistent_tool not found` per `toContain` — die Anreicherung darf
den bestehenden Nachrichten-Kopf nicht verändern, nur anhängen.

## Solution

### 1. Matching-Helper (pure Funktion)

```ts
// core/tools/suggestToolName.ts
export function suggestToolNames(
  input: string,
  candidates: readonly string[],
  maxSuggestions?: number, // Default 3
): string[];
```

Regeln:

- Vergleich case-insensitiv (beide Seiten lowercased); Vorschläge liefern
  den kanonischen Kandidatennamen zurück.
- Ein Kandidat qualifiziert sich, wenn:
  - **Präfix-Regel:** das lowercasede `input` ist echtes Präfix des
    Kandidaten, oder
  - **Distanz-Regel:** Levenshtein-Distanz ≤ `max(2, ceil(input.length / 4))`.
- Sortierung deterministisch: Distanz aufsteigend, bei Gleichstand Name
  aufsteigend; gekappt auf `maxSuggestions`.
- Keine Treffer → leeres Array → Meldung ohne Hinweis-Teil.
- Keine I/O, keine Config-Abhängigkeit, deterministisch.

Validierung am Motivationsfall: `run_terminal_cmd` (16 Zeichen) vs
`run_terminal_command` → Distanz 4 ≤ max(2, 4) = 4 ✓.

**Kandidatenmenge ist immer die zur Dispatch-Zeit angekündigte** (z. B.
`config.tools`): Vorschläge können nur Namen enthalten, die das Modell ohnehin
kennt — nichts Verborgenes gelangt in die Meldung.

### 2. Nachrichtenformat

Der bestehende Kopf bleibt unverändert, der Hinweis wird angehängt:

```
Tool "run_terminal_cmd" not found. Did you mean "run_terminal_command"?
Tool "foo" not found. Did you mean one of "a", "b", "c"?
```

Ohne Vorschläge bleibt die Meldung exakt wie heute.

### 3. IDE: Reklassifikation zum Tool-Result

In `handleToolCall` (`core/core.ts`) ersetzt bei unbekanntem Namen ein
reguläres Ergebnis den Throw:

```ts
return {
  contextItems: [],
  errorMessage: /* Kopf + Did-you-mean-Hinweis */,
  errorReason: ContinueErrorReason.ToolNotFound,
};
```

`ContinueErrorReason` erhält `ToolNotFound = "tool_not_found"`. Der
bestehende GUI-Pfad transportiert den Fehler ans Modell; der Run läuft
weiter, das Modell kann mit korrigiertem Namen neu aufrufen.

### 4. Übrige Stellen (nur Nachrichten-Anreicherung, Semantik unverändert)

- `tools/preprocessArgs`-Handler (`core/core.ts`): Throw bleibt, Meldung
  wird angereichert (Kandidaten: `config.tools`).
- `callBuiltInTool`-Default (`core/tools/callTool.ts`): Throw bleibt,
  Meldung wird angereichert (Kandidaten: `BuiltInToolNames`-Werte).
- `preprocessStreamedToolCalls` (CLI): Tool-Result-Fluss bleibt, Meldung
  wird angereichert (Kandidaten: `availableTools`). Der Helper wird aus
  `core/tools/suggestToolName.js` importiert (tiefe Core-Imports sind in
  der CLI etabliert).
- `oncalltool` in `gui/src/pages/gui/ToolCallDiv/MCPAppRenderer.tsx`: als
  Folge der Reklassifikation kommt statt eines Fehlers nun ein Ergebnis mit
  `errorMessage`; die Bridge meldet dann `isError: true` mit dem
  Meldungstext statt leerem Erfolg.

## Implementation Checklist

- [x] `core/util/errors.ts`: `ContinueErrorReason` um
      `ToolNotFound = "tool_not_found"` ergänzen.
- [x] Neu `core/tools/suggestToolName.ts`: pure Funktion gemäß Solution §1;
      Kommentar referenziert diese Spec per Dateiname.
- [x] `core/core.ts`: `handleToolCall` liefert bei unbekanntem Namen den
      Tool-Result-Fehler (Solution §3) statt zu werfen; Throw im
      `tools/preprocessArgs`-Handler mit Hinweis anreichern.
- [x] `core/tools/callTool.ts`: Default-Zweig von `callBuiltInTool` mit
      Hinweis anreichern (Kandidaten: `BuiltInToolNames`).
- [x] `extensions/cli/src/stream/streamChatResponse.helpers.ts`:
      Not-found-Meldung mit Hinweis anreichern (Helper-Import aus Core).
- [x] `gui/src/pages/gui/ToolCallDiv/MCPAppRenderer.tsx`: `oncalltool`
      gibt `errorMessage` als `isError`-Ergebnis weiter.
