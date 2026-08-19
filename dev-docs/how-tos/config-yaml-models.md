# config.yaml — Modelle konfigurieren (Corporate Fork)

**Status:** Lebende Doku (how-to) — bei relevanten Code-Änderungen mitpflegen.
**Verifiziert gegen:** Fork v2.1.0, 2026-08-19 (citt-delta, codeverifiziert;
Erweiterungen §3.3–§3.5 am 2026-08-19, inkl. Korrektur des
`extraBodyProperties`-Eintrags).
**Warum dieses Dokument:** Die Upstream-Web-Doku (docs.continue.dev) existiert
noch teilweise, bildet aber weder Fork-Verhalten noch unser Corporate-Setup
ab. Dieses Dokument ist die verbindliche Referenz für alle, die
Continue-Modell-YAMLs schreiben (Menschen und Agents). Alle Beispiele
verwenden Platzhalter — echte Endpunkte/Keys gehören nicht in geteilte Docs.

---

## 0. TL;DR — zwei Welten

In diesem Setup bekommt Continue auf genau zwei Wegen Kontakt zu einem LLM:

|                          | Weg A: CITT-Tunnel (Auto-Discovery)               | Weg B: Direktes YAML-Modell                                           |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| YAML-Aufwand             | nur `mcpServers`-Eintrag für CITT.MCP             | voller Modell-Block                                                   |
| Erscheint in der GUI als | `[<Servername>] <endpoint-id>` (z. B. `[CITT] …`) | `name` aus dem YAML                                                   |
| Netzweg                  | stdio → CITT.MCP → Provider                       | direkter HTTPS-Call aus der IDE                                       |
| API-Key                  | keiner im YAML (Proxy-Key kommt automatisch)      | muss ins YAML (oder Secret)                                           |
| Neues Modell/neue Region | CITT-Endpoint-Config erweitern — fertig           | neuen YAML-Block schreiben                                            |
| Wann nutzen              | **Standardfall**                                  | Sonderfälle: eigene Keys, Provider ohne CITT-Endpoint, gezielte Tests |

**Faustregel:** Neue Modelle/Regionen zuerst als CITT-Endpoint (Weg A).
Direkte YAML-Modelle (Weg B) nur, wenn es einen konkreten Grund gibt.

---

## 1. Datei und Grundskelett

- Global: `~/.continue/config.yaml`
- Zusätzlich möglich: Workspace-Blöcke (`.continue/` im Repo), Assistant-Dateien.
- Pflicht-Kopf: `name`, `version`, `schema: v1`.

```yaml
name: <Profilname>
version: 0.0.1
schema: v1

models:
  - name: <Anzeigename>
    provider: <provider>
    model: <modell-id>
    # …

mcpServers:
  CITT:
    command: <Startkommando CITT.MCP>

context:
  - provider: codebase
```

Parsing-Kette: `config.yaml` → `loadContinueConfigFromYaml`
(`core/config/yaml/loadYaml.ts`) → `llmsFromModelConfig` /
`modelConfigToBaseLLM` (`core/config/yaml/models.ts`) → Provider-Klasse,
ausgewählt **allein** über das `provider`-Feld (`core/llm/llms/index.ts`).

> **Achtung:** Ein unbekannter `provider` führt dazu, dass das Modell
> **still verworfen** wird — kein Fehlerdialog. Tippfehler in `provider`
> ist der häufigste Grund für „das Modell erscheint einfach nicht".

---

## 2. Weg A — Modelle über den CITT.MCP-Tunnel (Auto-Discovery)

### 2.1 Voraussetzungen

CITT.MCP muss als MCP-Server in der config.yaml stehen (stdio-Variante):

```yaml
mcpServers:
  CITT:
    command: <Startkommando der CITT.MCP-Executable>
    args: [] # optional
    env: {} # optional
```

Erlaubte Felder (Schema: `packages/config-yaml/src/schemas/mcp/index.ts`):

- stdio: `name`, `command` (Pflicht), `args`, `env`, `cwd`, `type: stdio`,
  `connectionTimeout`, `faviconUrl`
- HTTP: `url` (Pflicht), `type: sse | streamable-http`, `apiKey`,
  `requestOptions`

Das exakte Startkommando von CITT.MCP ist installationsabhängig (CITT-Doku
bzw. Team fragen).

Der Server muss beim Verbindungsaufbau `proxy/capabilities`
(`{ "proxy": true }`), `proxy/endpoints` und `proxy/key` liefern. Continue
prüft das **synchron während des Connects** (`MCPConnection.connectClient`) —
ein Server ohne Proxy-Fähigkeit liefert schlicht keine zusätzlichen Modelle.

### 2.2 Was Continue daraus macht

Pro advertised Endpoint entsteht automatisch ein Modell
(`core/config/mcpProxyModelDiscovery.ts`):

| CITT-Feld         | Continue-Feld                        | Bemerkung                                                                                                    |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `id`              | `model` **und** Titel-Suffix         | `model: <endpoint.id>` ist der Selektor, den der Proxy ausliest — nicht veränderbar                          |
| `name`            | —                                    | Titel = `[<MCP-Servername>] <endpoint.id>`, mit unsichtbarem U+FFFF davor (sortiert hinter manuelle Modelle) |
| `apiType`         | `provider`                           | Mapping siehe unten                                                                                          |
| `apiBase`         | `apiBase`                            | wird auf trailing `/` normalisiert; Anthropic bekommt `/v1/`, Gemini `/v1beta/` ergänzt, falls fehlend       |
| `timeout`         | `requestOptions.timeout` (Sekunden)  |                                                                                                              |
| `contextLimit`    | `contextLength`                      | nur wenn > 0                                                                                                 |
| `maxOutputTokens` | `defaultCompletionOptions.maxTokens` | nur wenn > 0                                                                                                 |
| `proxy/key`       | `apiKey`                             | automatisch — nie selbst ins YAML schreiben                                                                  |

apiType-Mapping:

| CITT apiType        | Continue                                                        |
| ------------------- | --------------------------------------------------------------- |
| `OpenAI-compatible` | chat-Modell, `openai` (Hostname `openrouter.ai` → `openrouter`) |
| `Anthropic`         | chat-Modell, `anthropic`                                        |
| `Gemini`            | chat-Modell, `gemini`                                           |
| `CohereEmbed`       | embed-Rolle, `cohere`                                           |
| `CohereRerank`      | rerank-Rolle, `cohere`                                          |

Transport: Der Client baut den HTTP-Request exakt wie für einen Direkt-Call;
der Host wird verworfen, nur `path + query + headers + body` gehen durch den
stdio-Tunnel (`proxy/http`, `core/context/mcp/mcpProxyFetch.ts`). Der Proxy
wählt den Ziel-Endpoint per Body-`model`-Feld → `x-citt-endpoint`-Header →
Gemini-URL-Pfad. HTTP-Fehler (4xx/5xx) kommen als normale Error-Responses
zurück, nicht als Protokollfehler.

### 2.3 Der Fall „GPT-5.6-sol in einer neuen Azure-Region"

**Kein Continue-YAML nötig.** Neuen Endpoint in der CITT-Endpoint-Konfiguration
anlegen (apiType `OpenAI-compatible`, apiBase des neuen Deployments,
`timeout`/`contextLimit`/`maxOutputTokens` setzen), dann MCP neu verbinden.
Das Modell erscheint automatisch als `[CITT] <endpoint-id>`.

Wenn es nicht erscheint, in dieser Reihenfolge prüfen:

1. MCP-Server wirklich `connected`? (Status in der GUI)
2. Liefert der Server den Endpoint in `proxy/endpoints`?
3. Passt der `apiType` ins Mapping oben? (Unbekannte apiTypes werden
   übersprungen.)
4. War die Verbindung beim Config-Reload bereits aufgebaut? (Discovery läuft
   nur gegen aktive Connections — im Zweifel Fenster neu laden.)

### 2.4 Grenzen von Weg A

- **Always tunnel:** entdeckte Modelle gehen niemals direkt. MCP-Verbindung
  weg ⇒ Modell weg (kein Fallback, by design).
- Der Tunnel-Fetch (`customFetch`) ist programmintern — **YAML-Modelle können
  nicht durch den Tunnel geschickt werden.** Wer Tunnel will, nimmt Weg A.
- `requestOptions.headers` aus YAML wirkt bei Tunnel-Modellen nicht (der
  Tunnel umgeht `fetchwithRequestOptions`); Discovery vergibt dort nur
  `timeout`.

---

## 3. Weg B — Feldreferenz für direkte YAML-Modelle

Zod-Schema: `packages/config-yaml/src/schemas/models.ts`; Verarbeitung:
`core/config/yaml/models.ts` (reicht fast alle Felder 1:1 an die
Provider-Klasse durch).

| Feld                                                                                     | Typ / Werte                                                                                | Bedeutung                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                                   | string, Pflicht                                                                            | Anzeigename in der GUI                                                                                                                                                                                                                                   |
| `provider`                                                                               | string, Pflicht                                                                            | wählt die LLM-Klasse (`openai`, `azure`, `anthropic`, `gemini`, `openrouter`, `ollama`, `transformers`, …); unbekannt ⇒ Modell wird still verworfen                                                                                                      |
| `model`                                                                                  | string, Pflicht                                                                            | Modell-ID bzw. Deploymentname; geht in Body oder URL                                                                                                                                                                                                     |
| `apiBase`                                                                                | string                                                                                     | Basis-URL — **Trailing-Slash beachten** (§3.1)                                                                                                                                                                                                           |
| `apiKey`                                                                                 | string                                                                                     | wird je nach Provider als `Authorization: Bearer` und/oder `api-key`/`x-goog-api-key` gesendet                                                                                                                                                           |
| `roles`                                                                                  | Liste: `chat`, `edit`, `apply`, `autocomplete`, `embed`, `rerank`, `summarize`, `subagent` | Rollenzuweisung; ohne `roles` = `[chat, summarize, apply, edit]` (§3.4)                                                                                                                                                                                  |
| `capabilities`                                                                           | Liste: `tool_use`, `image_input`, `next_edit`                                              | **`tool_use` ist Pflicht für Agent-Modi** — fehlt es, bekommt das Modell keine Tools                                                                                                                                                                     |
| `contextLength`                                                                          | number                                                                                     | überschreibt `defaultCompletionOptions.contextLength`                                                                                                                                                                                                    |
| `defaultCompletionOptions`                                                               | object                                                                                     | `temperature`, `maxTokens`, `contextLength`, `topP`, …                                                                                                                                                                                                   |
| `requestOptions`                                                                         | object                                                                                     | `timeout` (Sekunden), `headers`, `proxy`, `caBundlePath`, `extraBodyProperties`, … (§3.5) — **nur diese Keys kennt das Schema; `extraBody` ist tot**                                                                                                     |
| `env`                                                                                    | map                                                                                        | es werden nur bestimmte Keys gelesen: `apiType`, `apiVersion`, `deployment`, `deploymentId`, `projectId`, `region`, `profile`, `accessKeyId`, `secretAccessKey`, `modelArn`, `aiGatewaySlug`, `accountId` (+ `useLegacyCompletionsEndpoint` als boolean) |
| `useResponsesApi`                                                                        | boolean                                                                                    | `false` erzwingt `/chat/completions` statt `/responses` (§3.2)                                                                                                                                                                                           |
| `useLegacyCompletionsEndpoint`                                                           | boolean                                                                                    | `/completions` statt `/chat/completions` (Legacy)                                                                                                                                                                                                        |
| `promptTemplates`, `chatOptions`, `autocompleteOptions`, `embedOptions`, `cacheBehavior` | object                                                                                     | Feintuning, selten nötig                                                                                                                                                                                                                                 |

Secrets: `apiKey: ${{ secrets.NAME }}` wird beim Entrollen der Config aufgelöst
(Secret-Store der IDE). Wo kein Secret-Store existiert (z. B. Agent-Maschinen):
Klartext-Keys vermeiden und Weg A bevorzugen.

### 3.1 apiBase und der Trailing-Slash

Alle Endpunkt-URLs werden mit `new URL(<relativer Pfad>, apiBase)` gebaut
(`OpenAI.ts::_getEndpoint`). Ohne abschließenden `/` **ersetzt** der relative
Pfad das letzte Pfadsegment der Basis:

- `new URL("chat/completions", "https://x.example/openai/v1")` →
  `https://x.example/openai/chat/completions` ✗ (`v1` verloren)
- `new URL("chat/completions", "https://x.example/openai/v1/")` →
  `https://x.example/openai/v1/chat/completions` ✓

**Regel: `apiBase` immer mit `/` enden lassen.** Der Code ergänzt nichts.

### 3.2 useResponsesApi und die GPT-5-Falle

`core/llm/index.ts::canUseOpenAIResponses`: Bei `provider: openai` und einem
Modellnamen, der `/^o[0-9]+/` oder `/gpt-[5-9]/` matcht, und
`useResponsesApi !== false` → der Request geht an `{apiBase}/responses`.
Zwei Tücken:

1. Der Regex ist nicht verankert — auch Custom-Namen wie `gpt-5.6-sol`
   matchen.
2. Azure- und AI-Foundry-Endpoints ohne Responses-API antworten mit 404/400.

**Pflicht für GPT-5-Klasse auf Nicht-OpenAI-Servern: `useResponsesApi: false`.**

### 3.3 maxTokens — was gilt, wenn nichts gesetzt ist?

Jeder Request sendet `max_tokens`; der Wert kommt aus einer festen
Fallback-Kette (YAML-Modelle):

1. `defaultCompletionOptions.maxTokens` aus dem YAML
   (`core/config/yaml/models.ts`).
2. Provider-Klassen-Default `defaultOptions.completionOptions.maxTokens` —
   gesetzt u. a. bei `anthropic` (**8192**); `openai`/`openrouter` haben
   **keinen**.
3. Statische Modell-DB `@continuedev/llm-info` (wird per Modellname gematcht):
   `min(maxCompletionTokens, contextLength / 4)` — bewusst gedeckelt, damit
   das Ausgabe-Budget nicht das Kontextfenster auffrisst.
4. Letzter Fallback: **`DEFAULT_MAX_TOKENS = 4096`**
   (`core/llm/constants.ts`).

Konsequenzen:

- Ein OpenRouter-Modell ohne `maxTokens`, das die DB nicht kennt, läuft mit
  **4096** — sichtbar als mitten im Satz abgeschnittene Antworten und halbe
  Tool-Call-JSONs (der Stream endet regulär mit `finish_reason: length`,
  ist also kein Netzfehler).
- `maxTokens` reserviert außerdem das Ausgabe-Budget beim Kontext-Zuschnitt
  (`compileChatMessages`) — ein zu kleiner Wert verkleinert den effektiven
  Eingaberaum.
- Der Wert gilt für **alle** Calls des Modells, inkl. Compaction-Summaries
  und Titel-Generierung (§3.4).

**Regel: `defaultCompletionOptions.maxTokens` immer explizit setzen**
(zusammen mit `contextLength`), statt auf Fallbacks zu vertrauen.

### 3.4 Rollen, Summarize-Auswahl und Compaction

- Wird `roles` weggelassen, bekommt das Modell
  **`[chat, summarize, apply, edit]`** (`core/config/yaml/loadYaml.ts`,
  `defaultModelRoles`) — jedes Modell ist also automatisch Summarize-Kandidat.
- **Aber:** Die Rolle `summarize` ist im Fork derzeit ohne Funktion.
  Compaction (`conversation/compact`, `core/core.ts`) und Session-Fork mit
  Summary nehmen immer **`selectedModelByRole.chat` — das gerade aktive
  Chat-Modell** (`core/util/conversationCompaction.ts`), mit leeren
  Completion-Options, d. h. mit dessen konfiguriertem `maxTokens` (§3.3).
  Die GUI-Rollenauswahl kennt `summarize` ebenfalls nicht
  („summarize not implemented yet", `core/config/selectedModels.ts`).
- Beobachtung „Compaction-Summary endet mitten im Satz" ⇒ das aktive
  Chat-Modell läuft in sein `maxTokens`-Limit (oft der 4096-Fallback aus
  §3.3). Fix: `maxTokens` des Chat-Modells hochsetzen — ein separates
  Summarize-Modell einzutragen bringt nichts.

### 3.5 requestOptions: erlaubte Keys, `extraBodyProperties`, tote Keys

Das Schema kennt genau diese Keys (`requestOptionsSchema`,
`packages/config-yaml/src/schemas/models.ts`; identisch in
`core/config/types.ts`): `timeout`, `verifySsl`, `caBundlePath`, `proxy`,
`headers`, `extraBodyProperties`, `noProxy`, `clientCertificate`.

- **Tote Keys:** Alles andere — z. B. `extraBody`, `thinking_budget` —
  wird beim Zod-Parsen **still entfernt**. Es gibt im gesamten Fork kein
  Feld namens `extraBody`; der korrekte Name ist `extraBodyProperties`.
- **Merge auf Config-Ebene:** `requestOptions` des Modells überschreibt die
  top-level `requestOptions` des Assistant-YAMLs für `extraBodyProperties`
  **komplett** (kein Deep-Merge); nur `headers` wird keyweise gemerged
  (`mergeConfigYamlRequestOptions`).
- **Merge in den Request:** `extraBodyProperties` wird auf der
  **HTTP-Ebene** in jeden Request mit JSON-String-Body gemerged
  (`fetchwithRequestOptions`, `packages/fetch/src/fetch.ts`): flacher
  Top-Level-Spread, `extraBodyProperties` gewinnt bei Kollisionen. Das gilt
  provider-unabhängig für alle Wege, die über den Fork-Fetch laufen
  (native Provider-Pfade wie `OpenAI.ts`/`OpenRouter.ts` ebenso wie alle
  `openai-adapters`-APIs). — Die frühere Aussage dieser Doku, es wirke im
  OpenAI-Chat-Pfad nicht, war falsch (der Merge sitzt eine Ebene tiefer als
  der `extraBodyProperties()`-Hook der Provider-Klassen).
- **Ausnahme Weg A:** Tunnel-Modelle umgehen `fetchwithRequestOptions`
  (§2.4) — dort ist `extraBodyProperties` wirkungslos.

**Reasoning-Budgets:** `reasoningBudgetTokens` (CompletionOptions) wird nur
von den nativen Pfaden `anthropic` (`thinking.budget_tokens`, Default 2048),
`bedrock`, `cohere` und `replicate` gelesen. Der OpenRouter-Pfad sendet von
sich aus **kein** Reasoning-Enable-Feld; dort läuft Reasoning modellnativ.
Wer ein Budget über OpenRouter durchreichen will, nutzt den Pass-Through:

```yaml
requestOptions:
  extraBodyProperties:
    reasoning:
      max_tokens: 8192 # OpenRouter reicht `reasoning` an unterstützte Modelle durch
```

(Für Resends bereits erzeugten Reasonings gelten die Fork-Regeln aus
`reasoning-resend-policy.md` — unabhängig davon, wie Reasoning aktiviert
wurde.)

---

## 4. Rezepte (Cookbook)

### 4.1 Azure OpenAI Service (klassisches Deployment)

```yaml
models:
  - name: Azure <Modell> (<Region>)
    provider: azure
    model: <deployment-name>
    apiBase: https://<resource>.openai.azure.com/
    apiKey: <azure-key>
    env:
      apiType: azure-openai # Default der Azure-Klasse, kann weg
      apiVersion: 2024-10-21 # Default wäre 2024-02-15-preview
    requestOptions:
      timeout: 120
    capabilities: [tool_use, image_input]
```

Gebauter Pfad: `{apiBase}openai/deployments/<deployment>/chat/completions?api-version=<apiVersion>`
(`deployment` fällt auf `model` zurück, wenn nicht gesetzt). Auth: `Bearer`
**und** `api-key` werden beide gesendet. GPT-5-Körperformat
(`max_completion_tokens`, `developer`-Rolle) setzt der native Azure-Pfad
korrekt selbst.

### 4.2 Azure AI Foundry, OpenAI-kompatibel (der GPT-5.6-sol-Fall)

AI-Foundry-Ressourcen exponieren einen flachen OpenAI-kompatiblen Endpunkt
(`…/openai/v1`). Das ist das live-verifizierte Rezept:

```yaml
models:
  - name: Azure GPT-5.6 (<Region>)
    provider: openai
    model: gpt-5.6-sol
    apiBase: https://<resource>.cognitiveservices.azure.com/openai/v1/
    apiKey: <key>
    useResponsesApi: false # Pflicht, siehe §3.2
    requestOptions:
      timeout: 300
    defaultCompletionOptions:
      contextLength: 1000000
      maxTokens: 128000
    capabilities: [tool_use, image_input]
```

Auth: AI-Foundry-Ressourcen akzeptieren `Authorization: Bearer <key>`
(setzt der Fork automatisch). Klassische Cognitive-Services-Ressourcen
verlangen zusätzlich `api-key` — bei 401 ergänzen:

```yaml
requestOptions:
  headers:
    api-key: <key>
```

(wird über `fetchwithRequestOptions` in jeden Request gemerged, mit Vorrang
vor SDK-Defaults).

Bekannte Eigenheiten dieses Setups:

- **Temperatur-Lock:** Manche Deployments dulden nur exakt eine Temperatur
  (z. B. 1.0) und werfen 400 auf alles andere. **Keine**
  `defaultCompletionOptions.temperature` setzen — ohne das Feld wird der
  Key im Body weggelassen und der Server-Default gilt.
- **`max_tokens` vs. `max_completion_tokens`:** Der OpenAI-Adapter konvertiert
  nur für `https://api.openai.com/v1/`. Wirft das Deployment 400 auf
  `max_tokens` → Variante 4.2b.
- **Jede Azure-Ressource/Region hat eigene Keys.** 401 „invalid subscription
  key or wrong API endpoint" heißt fast immer: Key und apiBase gehören nicht
  zusammen.

#### 4.2b Experten-Variante: flaches Azure-Routing mit GPT-5-Body

`provider: azure` + ein `apiType`, der „azure" **enthält**, aber weder exakt
`azure` noch `azure-openai` ist, + leeres `apiVersion` ⇒ der Azure-Zweig baut
den flachen Pfad `{apiBase}<endpoint>?api-version=` statt des
Deployment-Pfads, und der native Chat-Pfad erzeugt den korrekten GPT-5-Body
(`max_completion_tokens`, `developer`-Rolle). `canUseOpenAIResponses` greift
nicht (providerName ≠ `openai`).

```yaml
- name: Azure GPT-5.6 (Flat-Routing-Fallback)
  provider: azure
  model: gpt-5.6-sol
  apiBase: https://<resource>.cognitiveservices.azure.com/openai/v1/
  apiKey: <key>
  env:
    apiType: azure-flat # enthält "azure", ≠ azure/azure-openai
    apiVersion: "" # kein Versionssegment
  capabilities: [tool_use, image_input]
```

Nutzt Fork-Interna aus — bei Updates neu verifizieren. Die Upstream-Doku
kennt als dokumentierte Variante zusätzlich `apiType: azure-foundry`
(flacher Pfad **mit** `api-version=<…>`-Query) für AI-Foundry-Target-URIs.

### 4.3 Anthropic-Modelle über Azure AI Foundry

```yaml
- name: Azure Claude <Version> (<Region>)
  provider: anthropic
  model: claude-<version>
  apiBase: https://<resource>.openai.azure.com/anthropic/v1/
  apiKey: <key>
  requestOptions:
    timeout: 120
  capabilities: [tool_use, image_input]
```

Die Anthropic-Klasse spricht natives `/messages`; `apiBase` muss auf `/v1/`
enden.

### 4.4 Google Gemini (nativ)

```yaml
- name: Gemini <Version>
  provider: gemini
  model: gemini-<version>
  apiKey: <google-key>
  capabilities: [tool_use, image_input]
```

Der Fork sendet den Key als `x-goog-api-key`-Header (nicht als
`?key=`-Query-Param) und streamt `:streamGenerateContent` mit `alt=sse` —
echte Streaming-UX dadurch auch durch den CITT-Tunnel.

### 4.5 OpenAI-kompatible Drittanbieter (OpenRouter, Nebius, …)

```yaml
  - name: <Anbieter>: <Modell>
    provider: openai # bei OpenRouter auch "openrouter" möglich
    model: <vendor>/<modell>
    apiBase: https://<host>/v1/
    apiKey: <key>
    useResponsesApi: false # sobald der Name o*/gpt-5* matcht
    defaultCompletionOptions:
      contextLength: 1000000 # explizit setzen, siehe unten
      maxTokens: 128000 # explizit setzen, siehe unten
    capabilities: [tool_use, image_input]
```

**Metadaten:** Der Fork holt `context_length`/`max_tokens` **nicht** live von
OpenRouter-`/models` — dieser Abruf speist ausschließlich den
„Modell hinzufügen"-Picker der GUI (`core/llm/fetchModels.ts`). YAML-Modelle
bekommen ihre Werte nur aus dem YAML selbst bzw. der statischen
`llm-info`-DB (§3.3) — beide Felder daher immer explizit setzen.

**Reasoning** (Budget/Pass-Through) und `extraBodyProperties`: §3.5.

### 4.6 Embeddings (lokal, ohne Provider)

```yaml
- name: default-transformers
  provider: transformers
  model: all-MiniLM-L6-v2
  roles: [embed]
```

---

## 5. Fehlerbild → Ursache → Fix

| Symptom                                                  | wahrscheinliche Ursache                                                 | Fix                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Modell erscheint gar nicht                               | `provider`-Tippfehler (still verworfen); bei Weg A: MCP nicht verbunden | provider exakt schreiben; MCP-Status prüfen                              |
| 401 „invalid subscription key or wrong API endpoint"     | Key gehört zu einer anderen Azure-Ressource als `apiBase`               | Key/Ressource paaren (jede Region hat eigene Keys)                       |
| 404 auf `/responses`                                     | GPT-5-artiger Name + `provider: openai` ohne `useResponsesApi: false`   | `useResponsesApi: false` setzen                                          |
| 404 auf `chat/completions`                               | `apiBase` ohne trailing `/` (Segment verschluckt)                       | `/` anhängen                                                             |
| 400 mit Bezug auf `api-version`                          | `apiVersion` fehlt/falsch (klassisches Azure)                           | `env.apiVersion` setzen                                                  |
| 400 bei `temperature`                                    | Deployment lockt die Temperatur                                         | `temperature` weglassen                                                  |
| 400 bei `max_tokens`                                     | GPT-5-Klasse erwartet `max_completion_tokens`                           | Variante 4.2b                                                            |
| Stream bricht nach ~90 s / kein Stream                   | Gateway-/Provider-Timeout, `requestOptions.timeout` zu klein            | `timeout` hochsetzen (z. B. 300); Weg A mit passendem Endpoint-`timeout` |
| Agent-Modus ohne Tools                                   | `capabilities` ohne `tool_use`                                          | `tool_use` ergänzen                                                      |
| Antworten/Tool-Call-JSONs enden abrupt (kein Netzfehler) | `maxTokens` zu klein bzw. auf Fallback (4096, §3.3)                     | `defaultCompletionOptions.maxTokens` explizit setzen                     |
| Compaction-Summary endet mitten im Satz                  | aktives Chat-Modell läuft in sein `maxTokens`-Limit (§3.4)              | `maxTokens` des Chat-Modells hochsetzen                                  |
| `extraBody` / `thinking_budget` zeigt keine Wirkung      | Key existiert nicht im Schema — still entfernt (§3.5)                   | `extraBodyProperties` verwenden                                          |
| `extraBodyProperties` zeigt keine Wirkung                | Modell läuft über Weg A (Tunnel), oder Body ist kein JSON-String (§3.5) | Weg B nutzen; Key-/Wert-Schreibweise gegen Ziel-API prüfen               |

---

## 6. Diagnose

- **Logs:** `~/.continue/logs/` (u. a. `core.log`).
- **Tunnel-Streams:** Datei `~/.continue/tunnel-diag.enabled` anlegen
  (ohne Restart wirksam, wird alle 2 s geprüft) oder `CONTINUE_TUNNEL_DIAG=1`
  vor dem Start setzen → JSONL-Trace in `~/.continue/logs/tunnel-diag.jsonl`
  (Chunk-Ankunft vs. Abholung, Queue-Tiefe, Event-Loop-Lag).
- **Request-Bodies:** Prompt-Logging (siehe `prompt-logging-opt-in.md` im
  Spec-Archiv) mitschreiben lassen.
- **GUI-Fehler:** Continue zeigt Provider-Fehlermeldungen meist wörtlich —
  die erste Zeile ist oft schon die Diagnose.

---

## 7. Inbetriebnahme-Checkliste (neues Modell / neue Region)

1. Entscheidung Weg A vs. Weg B (§0). Im Zweifel Weg A.
2. **Weg A:** Endpoint in der CITT-Endpoint-Konfiguration anlegen →
   MCP neu verbinden → `[CITT] <id>` sichtbar? Sonst §2.3.
3. **Weg B:** YAML-Block nach passendem Rezept (§4); `apiBase` endet mit
   `/`; `capabilities` vollständig; `useResponsesApi` beachtet (§3.2).
4. Ein Chat-Testprompt; bei Fehler Tabelle §5.
5. Agent-Fähigkeit prüfen (Tool-Call auslösen).
6. Bei Streaming-Problemen: `tunnel-diag` bzw. `timeout` (§6).

---

## 8. Referenzen

- **Upstream-Web-Doku** (Stand v2.1.0, ohne Fork-/Corporate-Realität — nur
  als Zweitmeinung): `docs.continue.dev/reference`,
  `docs.continue.dev/customize/model-providers/top-level/azure` (kennt weder
  Tunnel noch GPT-5-Falle noch das apiType-Verhalten des Forks).
- **Code:** `core/config/yaml/models.ts`, `core/config/yaml/loadYaml.ts`
  (Default-Rollen), `core/llm/constants.ts` (Fallback-Konstanten),
  `core/llm/index.ts` (`canUseOpenAIResponses`, `fetch`),
  `core/llm/llms/OpenAI.ts` (`_getEndpoint`, `_getHeaders`),
  `core/llm/llms/Azure.ts`, `core/llm/fetchModels.ts` (GUI-Picker),
  `core/util/conversationCompaction.ts` + `core/core.ts`
  (Compaction/Summarize-Auswahl), `core/config/selectedModels.ts`,
  `core/config/mcpProxyModelDiscovery.ts`,
  `core/context/mcp/mcpProxyFetch.ts`,
  `packages/fetch/src/fetch.ts` (`extraBodyProperties`-Merge),
  `packages/config-yaml/src/schemas/models.ts`,
  `packages/config-yaml/src/schemas/mcp/index.ts`.
- **Specs:** `endpoint-discovery.md`, `proxy-http-tunneling.md` (Archiv
  `dev-docs/history/specifications/mcp-proxy/`).
- **Agents:** Memory-Fragment `azure-gpt-5-6-sol-continue-config_2026_08_16`
  (`assistant:coding-agent`) enthält die codeverifizierten Details zum
  GPT-5.6-sol-Setup inklusive der Workaround-Herleitung.
