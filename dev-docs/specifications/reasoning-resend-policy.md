# Reasoning-Resend-Policy pro Modellfamilie (OpenRouter)

**Status:** Stufe 3 implementiert 2026-08-17 (Familien-Flags in
`OpenRouter.ts`, Gating unverändert in `openaiTypeConverters.ts`; Tests:
`OpenRouter.vitest.ts` „reasoning resend policy",
`openaiTypeConverters.test.ts` „toChatBody reasoning resend gating";
core Jest + Vitest grün, `tsc --noEmit` sauber). Commit steht aus.
**Stand:** 2026-08-17 · **Autor:** citt-delta
**Vorarbeit:** Stufen 1, 2, 2.5 abgeschlossen. Alle Belege im Testbed
`C:\Users\Zuser\Documents\Rolf\VSC_Projekte\CITT-Solution\openrouter-reasoning-probe`
(Report: `report.md`, Rohdaten: `results/`, Runner: `src/`). Memory-Fragment:
`openrouter-reasoning-resend-verhaltensmatrix_2026_08_17`
(`assistant:coding-agent`). Verwandt: Tech Debt `resent-user-messages.md`
(offener Follow-up „Resend-Policy" → wird hiermit umgesetzt),
Incident-Handoff `%TEMP%\incident-doppelte-user-message-recherche-status.md`.

## Ausgangslage

Die Incident-Familie „doppelte User-Message-Zustellung" ist beim Capture
gefixt (Commit `8c0d5f822`, Strip + Copy-on-write-Merge in
`sessionSlice.ts`/`openaiTypeConverters.ts`). Die offene Folgefrage ist die
Resend-Policy: Der Fork sendet Thinking-Felder (`reasoning`,
`reasoning_details`, Kimi-Sonderpfad `reasoning_content`) auf
assistant-Messages an OpenRouter zurück — ohne Familien-Differenzierung.

## Empirische Befunde (Kurzfassung, Details in report.md)

Zustell-Matrix (Non-Stream, OpenRouter, 2026-08-17):

| Familie                 | `reasoning` plain      | `reasoning_details` plain | `reasoning_content`    | signiert               |
| ----------------------- | ---------------------- | ------------------------- | ---------------------- | ---------------------- |
| qwen/qwen3.8-max        | ✅ zugestellt+sichtbar | ❌ lautlos verworfen      | n/a                    | liefert OR nicht       |
| moonshotai/kimi-k3      | ❌ verworfen           | ❌ verworfen              | ✅ zugestellt+sichtbar | liefert OR nicht       |
| anthropic/claude-opus-5 | ❌ verworfen           | ❌ verworfen              | n/a                    | ✅ akzeptiert+sichtbar |
| google/gemini-2.5-pro   | ❌ verworfen           | ❌ verworfen              | n/a                    | liefert OR nicht       |

Zusatzbefunde:

- **Attribution ist payload-abhängig (Stufe 2.5):** Echtes, intaktes
  eigenes Reasoning wird von qwen sauber als eigenes Thinking attribuiert
  und ist vollständig abrufbar (Probe B2: Code `KRVXDM` exakt reproduziert,
  „In my previous thinking, I recorded: KRVXDM"). Synthetische
  Fremd-Notiz-Payloads („Internal note: …") erkennt qwen korrekterweise
  als fremd — die Fehl-Attribution aus Stufe 1 war ein Payload-Artefakt.
- **Incident-Lesart präzisiert:** Die reale Verwirrung stammte plausibel
  aus korrumpiertem Replay (TheThe-Stutter, Capture-Bug), nicht aus dem
  Resend-Prinzip. Der Capture-Fix beseitigt diese Ursache.
- **Capture-Integrität (Stufe 2):** Replay von echtem SSE-Rohstream durch
  die reale Fork-Pipeline — alle 4 Familien grün, kein Stutter,
  Anthropic-Signatur auf beiden Pfaden erhalten.
- **Probe-Design-Lehren:** Secrecy-Instruktionen im Gen-Prompt erzeugen
  Refusals im Replay; suggestives Framing („reply ONLY code") löst bei
  qwen Verweigerungsverhalten aus — Token-Forensik (Prompt-Delta vs.
  Kontrolle) ist der zuverlässige Zustell-Nachweis, nicht die Antwort.

## Zielverhalten (Policy — revidiert nach Stufe 2.5)

1. **qwen:** Plain-`reasoning`-Resend **behalten** (belegt nützlich);
   Plain-`reasoning_details` **entfernen** (wird von OpenRouter lautlos
   verworfen — tote Bytes).
2. **kimi:** nur `reasoning_content` (heutiger Sonderpfad, belegt);
   plain `reasoning`/`reasoning_details` nicht senden.
3. **anthropic:** nur signierte Blöcke (heutiger Claude-Guard, belegt);
   plain Felder nicht senden (werden ohnehin verworfen).
4. **gemini:** Resend **komplett stoppen** (alle Kanäle werden verworfen).

Bewusster Zielkonflikt: Reasoning-Resend kostet Tokens/Kontext pro Turn.
Für qwen ist Plain-Text der einzige funktionierende Pfad (kein
Signatur-Kanal) — User-Abwägung: Kontinuität ist es wert.

## Umsetzung (Stufe 3)

- **Orte:** Familien-Flags in `core/llm/llms/OpenRouter.ts` (heute u. a.
  `supportsReasoningField`/`supportsReasoningDetailsField` pro
  Modellfamilie; Kimi/DeepSeek-Sonderpfad; Claude-Signatur-Guard) und
  Gating in `appendReasoningFieldsIfSupported` bzw. `toChatBody` in
  `core/llm/openaiTypeConverters.ts`. Vor Implementierung den Ist-Zustand
  dieser Stellen lesen (nicht aus dieser Spec raten).
- **Änderung:** Pro Familie nur den empirisch funktionierenden Kanal auf
  die Leitung lassen (Matrix oben). Verhaltensänderung betrifft nur den
  Ausgangs-Kanal — Capture/Ingest bleibt unangetastet (Stufe 2 grün).
- **Tests:** erst NACH abgeschlossener Implementierung (Hard Rule 1):
  Unit Tests für das Gating (Zustandsmatrix oben als Testfälle), core-Jest
  über `npm test` (NODE_OPTIONS, nicht nacktes npx jest), gezielte Suiten
  sequentiell über `scripts/run-all-tests.mjs`; Typcheck via
  `npx tsc --noEmit` (vitest typisiert nicht). Baseline-Vergleich:
  `dev-docs/how-tos/test-baseline.md` (Achtung: 5–6 vorbestehende
  GUI-Failures sind dokumentiert in `gui-test-baseline-drift.md`).

## Danach

- Tech Debt `resent-user-messages.md`: Follow-up „Resend-Policy" →
  umgesetzt/geschlossen aktualisieren.
- Board-Vorschlag mit den Belegen (`report.md` + `results/`-Verweis):
  eigenes Topic, Pointer-Announcement in `Allgemein` (Board-Etikette).
- Bestehende korrumpierte Sessions (vesta `ec01edb2`, zenith `9d6a6c41`)
  bleiben unabhängig davon auf „frische Session" empfohlen.

## Prozess-Notizen

- Kein Commit ohne explizites User-Go; wenn Go: alles Dirty mitnehmen
  (Piggyback). Im Repo warten bereits pending Dateien anderer Workstreams
  auf den nächsten Commit: `dev-docs/technical-debts/board-watch-followups.md`,
  `dev-docs/technical-debts/gui-test-baseline-drift.md`,
  `AGENTS.md` (Conversation-compaction-Abschnitt).
- Trust Boundary: Testbed ist synthetisch und trust-boundary-konform;
  API-Keys nur zur Laufzeit aus `~/.continue/config.yaml`/Env, nie ins
  Repo/Board/Memory.
- Testbed-Runner bei Bedarf wiederverwendbar: `npm run probe` (Matrix),
  `phase3.ts` (Feldtyp-Isolation), `phase4.ts`/`phase4b.ts`
  (echtes Reasoning), `capture.ts`/`replay.ts` (Stufe-2-Harness mit
  Quelltext-Ankern — scheitert laut bei Fork-Drift).
