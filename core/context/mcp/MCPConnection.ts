import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import fs from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  decodeSecretLocation,
  getTemplateVariables,
} from "@continuedev/config-yaml";
import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { Agent as HttpsAgent } from "https";
import { z } from "zod";
import {
  BoardPendingResult,
  IDE,
  InternalMcpOptions,
  InternalSseMcpOptions,
  InternalStdioMcpOptions,
  InternalStreamableHttpMcpOptions,
  InternalWebsocketMcpOptions,
  MCPConnectionStatus,
  MCPPrompt,
  MCPResource,
  MCPResourceTemplate,
  MCPServerStatus,
  MCPTool,
  ProxyCapabilities,
  ProxyEndpoint,
  TranscriptDumpPayload,
  TranscriptDumpResult,
} from "../..";
import { resolveRelativePathInDir } from "../../util/ideUtils";
import { getEnvPathFromUserShell } from "../../util/shellPath";
import { getOauthToken } from "./MCPOauth";

// Timeout for initial connection to MCP server (connectivity check)
const DEFAULT_MCP_CONNECTION_TIMEOUT = 30_000; // 30 seconds

// Timeout for MCP tool execution - much higher as tools can run complex workflows
// This is exported for use in callTool.ts
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT = 900_000; // 15 minutes

// Timeout for each individual proxy discovery RPC
// (proxy/capabilities, proxy/endpoints, proxy/key)
const PROXY_METHOD_TIMEOUT = 5_000; // 5 seconds

const ProxyCapabilitiesSchema = z.object({
  proxy: z.boolean(),
  // Board auto-topic-injection (board-auto-topic-injection.md): CITT signals
  // `board/pending` support here. Optional so older CITT builds (and other
  // servers) stay compatible; Zod strips the key on older fork schemas.
  board: z.boolean().optional(),
  // MsgBoard v2 (msgboard-v2-fork-packages.md): CITT signals the v2 board
  // surface here — `board/register`, `board/migrateImport` and
  // subscription-resolved `board/pending`. Present from CITT step [3r]
  // onward; optional like `board` so pre-v2 builds stay compatible.
  boardV2: z.boolean().optional(),
  // continue-transcript-dump.md: CITT signals `transcript/dump` support here.
  transcript: z.boolean().optional(),
});

// Timeout for `board/pending`; mirrors PROXY_METHOD_TIMEOUT. The uniform
// 5 s budget for BOTH modes (run-start injection and watcher ticks) is
// intentional: from CITT step 2 onward `board/pending` is a DB-read, so the
// budget is trivially satisfiable — no budget split (msgboard-v2-fork-packages.md).
// Best-effort by contract: on timeout the injection is skipped, the run starts.
// Exported for test assertions.
export const BOARD_PENDING_TIMEOUT = 5_000; // 5 seconds

// MsgBoard v2 (msgboard-v2-fork-packages.md): `board/register` and
// `board/migrateImport` are one-shot DB writes like proxy discovery — same
// 5 s budget. Both are best-effort from the fork's perspective: failures keep
// the proven mode-(a) consumption alive. Exported for test assertions.
export const BOARD_REGISTER_TIMEOUT = 5_000; // 5 seconds
export const BOARD_MIGRATE_IMPORT_TIMEOUT = 5_000; // 5 seconds

// Frozen contract (02-board-state-watcher.md, „board/migrateImport contract",
// binding since board post 5348658808): registration response.
const BoardRegisterResultSchema = z.object({
  ok: z.boolean(),
  handle: z.string(),
});

// Frozen contract (same section): migration response. `processed` counts the
// received topic entries, `subscribed` the ones kept active, `cursorAdvanced`
// whether any ConsumedCommentId moved.
const BoardMigrateImportResultSchema = z.object({
  ok: z.boolean(),
  processed: z.number(),
  subscribed: z.number(),
  cursorAdvanced: z.boolean(),
});

/** One topic entry of the `board/migrateImport` payload (frozen contract). */
export interface BoardMigrateImportTopic {
  topic: string;
  /** Highest consumed comment id on this topic (0 = nothing consumed). */
  sinceId: number;
  /** true = upsert the subscription, false = remove it. */
  subscribed: boolean;
}

// continue-transcript-dump.md: transcript payloads are larger than
// board/pending responses — dedicated, slightly higher timeout.
const TRANSCRIPT_DUMP_TIMEOUT = 10_000; // 10 seconds

const TranscriptDumpResultSchema = z.object({
  ok: z.boolean(),
  fragmentName: z.string(),
  chunks: z.number(),
  bytes: z.number(),
});

// Contract v1.2 (stateless CITT board gateway). sinceId omitted = init mode.
const BoardPendingSchema = z.object({
  messages: z.array(
    z.object({
      topic: z.string(),
      id: z.number(),
      from: z.string(),
      to: z.string(),
      // Wire format: JSON `null` when the message is not a reply (unpopulated
      // DB column on the CITT side); normalize to undefined so downstream
      // keeps the `re?: number` domain shape (same nullish class as
      // contextLimit below).
      re: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
      createdAt: z.string(),
      body: z.string(),
    }),
  ),
  latestByTopic: z.record(z.string(), z.number()),
  // Additive contract annex (5291256996): existing topics without comments.
  emptyTopics: z.array(z.string()).optional(),
  omitted: z
    .object({ count: z.number(), oldestOmittedId: z.number() })
    .optional(),
  warning: z.string().optional(),
});

const ProxyEndpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  apiType: z.string(),
  model: z.string(),
  apiBase: z.string(),
  timeout: z.number().optional(),
  // nullish: absent on older CITT builds, JSON null for unpopulated DB rows
  contextLimit: z.number().nullish(),
  maxOutputTokens: z.number().nullish(),
});

const ProxyEndpointsSchema = z.object({
  endpoints: z.array(ProxyEndpointSchema),
});

const ProxyKeySchema = z.object({
  key: z.string(),
});

// ---------- CITT proxy HTTP tunnel (proxy/http) ----------
// See proxy-http-tunneling.md (Phase 2).

// Grace period for buffering notifications that arrive before the JSON-RPC
// result of `proxy/http` has been processed by the caller. Response
// resolution and notification dispatch both go through microtasks, so a
// chunk in the same stdio batch as the result can be dispatched first.
const PROXY_EARLY_EVENT_TTL_MS = 5_000;
// Max buffered early events per stream (safety bound, never hit in practice).
const PROXY_EARLY_EVENT_LIMIT = 1_000;
// How long a cancelled stream keeps its registry entry so that late chunks
// are recognized and discarded instead of being buffered as "early" events.
const PROXY_CANCELLED_ENTRY_TTL_MS = 60_000;

// ---------- Tunnel stream diagnostics ----------
// Toggle WITHOUT restart: create ~/.continue/tunnel-diag.enabled (checked
// every 2s at runtime); alternatively set CONTINUE_TUNNEL_DIAG=1 before
// launch. Appends a JSONL trace of proxy/http streams (request size, chunk
// arrival vs. consumer pickup, queue depth, event-loop lag watchdog) to
// ~/.continue/logs/tunnel-diag.jsonl. Built to localize streaming stalls
// (extension-host freezes during tunneled streams); near-zero overhead when
// disabled (one cached existsSync per 2s).
const TUNNEL_DIAG_ENV_ENABLED = process.env.CONTINUE_TUNNEL_DIAG !== undefined;
const TUNNEL_DIAG_FILE = path.join(
  homedir(),
  ".continue",
  "logs",
  "tunnel-diag.jsonl",
);
const TUNNEL_DIAG_TOGGLE_FILE = path.join(
  homedir(),
  ".continue",
  "tunnel-diag.enabled",
);
let tunnelDiagDirEnsured = false;
let tunnelDiagFileEnabled = false;
let tunnelDiagFileCheckedAt = 0;

function tunnelDiagEnabled(): boolean {
  if (TUNNEL_DIAG_ENV_ENABLED) {
    return true;
  }
  const now = Date.now();
  if (now - tunnelDiagFileCheckedAt >= 2000) {
    tunnelDiagFileCheckedAt = now;
    try {
      tunnelDiagFileEnabled = fs.existsSync(TUNNEL_DIAG_TOGGLE_FILE);
    } catch {
      tunnelDiagFileEnabled = false;
    }
  }
  return tunnelDiagFileEnabled;
}

function tunnelDiagLog(entry: Record<string, unknown>): void {
  if (!tunnelDiagEnabled()) {
    return;
  }
  try {
    if (!tunnelDiagDirEnsured) {
      fs.mkdirSync(path.dirname(TUNNEL_DIAG_FILE), { recursive: true });
      tunnelDiagDirEnsured = true;
    }
    fs.appendFile(
      TUNNEL_DIAG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      () => {
        // fire-and-forget
      },
    );
  } catch {
    // Diagnostics must never break the tunnel.
  }
}

const ProxyHttpResultSchema = z.object({
  status: z.number(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(), // non-streaming
  streaming: z.boolean().optional(), // streaming
  streamId: z.string().optional(),
});

const ProxyCancelResultSchema = z.object({
  cancelled: z.boolean(),
  reason: z.string().optional(),
});

const ProxyHttpChunkNotificationSchema = z.object({
  method: z.literal("proxy/http/chunk"),
  params: z.object({
    streamId: z.string(),
    data: z.string(),
  }),
});

const ProxyHttpDoneNotificationSchema = z.object({
  method: z.literal("proxy/http/done"),
  params: z.object({
    streamId: z.string(),
  }),
});

const ProxyHttpErrorNotificationSchema = z.object({
  method: z.literal("proxy/http/error"),
  params: z.object({
    streamId: z.string(),
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
});

export interface ProxyHttpParams {
  method: string;
  path: string; // incl. query string, e.g. "/v1/chat/completions"
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyHttpNonStreamingResponse {
  streaming: false;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ProxyHttpStreamingResponse {
  streaming: true;
  status: number;
  headers: Record<string, string>;
  streamId: string;
  /** Raw SSE chunks as sent by the server. Single consumer only. */
  chunks: AsyncIterable<string>;
}

export type ProxyHttpResponse =
  | ProxyHttpNonStreamingResponse
  | ProxyHttpStreamingResponse;

export enum ProxyStreamState {
  Active = "active",
  Cancelled = "cancelled",
}

type ProxyStreamEvent =
  | { kind: "chunk"; data: string }
  | { kind: "done" }
  | { kind: "error"; error: Error };

interface ProxyStreamEntry {
  state: ProxyStreamState;
  cancelledAt?: number;
  onChunk: (data: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

// Commands that are batch scripts on Windows and need cmd.exe to execute
const WINDOWS_BATCH_COMMANDS = [
  "npx",
  "uv",
  "uvx",
  "pnpx",
  "dlx",
  "nx",
  "bunx",
];

const COMMONS_ENV_VARS = ["HOME", "USER", "USERPROFILE", "LOGNAME", "USERNAME"];

function is401Error(error: unknown) {
  return (
    (error instanceof SseError && error.code === 401) ||
    (error instanceof Error && error.message.includes("401")) ||
    (error instanceof Error && error.message.includes("Unauthorized"))
  );
}

export type MCPExtras = {
  ide: IDE;
};

class MCPConnection {
  public client: Client;
  public abortController: AbortController;
  public status: MCPConnectionStatus = "not-connected";
  public isProtectedResource = false;
  public errors: string[] = [];
  public infos: string[] = [];
  public prompts: MCPPrompt[] = [];
  public tools: MCPTool[] = [];
  public resources: MCPResource[] = [];
  public resourceTemplates: MCPResourceTemplate[] = [];
  public proxyCapabilities?: ProxyCapabilities;
  public proxyEndpoints?: ProxyEndpoint[];
  public proxyKey?: string;
  private transport: Transport;
  private connectionPromise: Promise<unknown> | null = null;
  private stdioOutput: { stdout: string; stderr: string } = {
    stdout: "",
    stderr: "",
  };
  private activeProxyStreams = new Map<string, ProxyStreamEntry>();
  private earlyProxyEvents = new Map<
    string,
    { at: number; events: ProxyStreamEvent[] }
  >();

  constructor(
    public options: InternalMcpOptions,
    public extras?: MCPExtras,
  ) {
    // Don't construct transport in constructor to avoid blocking
    this.transport = {} as Transport; // Will be set in connectClient

    this.client = new Client(
      {
        name: "continue-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    this.abortController = new AbortController();

    // The Client instance lives across reconnects, so handlers registered
    // here stay valid for the lifetime of this connection object.
    this.registerProxyNotificationHandlers();
  }

  async disconnect(disable = false) {
    this.abortController.abort();
    this.failActiveProxyStreams("MCP connection closed");
    await this.client.close();
    await this.transport.close();
    this.proxyCapabilities = undefined;
    this.proxyEndpoints = undefined;
    this.proxyKey = undefined;
    this.status = disable ? "disabled" : "not-connected";
  }

  getStatus(): MCPServerStatus {
    return {
      ...this.options,
      errors: this.errors,
      infos: this.infos,
      prompts: this.prompts,
      resources: this.resources,
      resourceTemplates: this.resourceTemplates,
      tools: this.tools,
      status: this.status,
      isProtectedResource: this.isProtectedResource,
      proxyCapabilities: this.proxyCapabilities,
      proxyEndpoints: this.proxyEndpoints,
      proxyKey: this.proxyKey,
    };
  }

  /**
   * Generic JSON-RPC call to the MCP server for methods not covered by the
   * SDK's typed helpers (e.g. CITT proxy discovery methods).
   */
  async callMethod<TSchema extends z.ZodTypeAny>(
    method: string,
    params: Record<string, unknown>,
    resultSchema: TSchema,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<z.infer<TSchema>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Type assertion via `any` to avoid "Type instantiation is excessively
    // deep" error with MCP SDK 1.29+ complex generic inference. The Zod
    // schema validates the result at runtime; the cast is safe.
    return await this.client.request({ method, params }, resultSchema as any, {
      signal: options?.signal,
      timeout: options?.timeout,
    });
  }

  /**
   * Fetches pending MsgBoard messages for subscribed topics through the CITT
   * board gateway (`board/pending`, contract v1.2 in
   * board-auto-topic-injection.md). Omit `sinceId` for init mode (no
   * messages, only `latestByTopic`). Omit BOTH `topics` and `sinceId` for
   * mode (b) on v2 gateways (msgboard-v2-fork-packages.md): CITT resolves the
   * caller's subscriptions server-side via the registered handle.
   * Best-effort: callers must handle errors and never block a run on this.
   */
  async boardPending(
    topics?: string[],
    sinceId?: number,
    options?: { signal?: AbortSignal },
  ): Promise<BoardPendingResult> {
    const params: Record<string, unknown> = {};
    if (topics !== undefined) {
      params.topics = topics;
    }
    if (sinceId !== undefined) {
      params.sinceId = sinceId;
    }
    return await this.callMethod("board/pending", params, BoardPendingSchema, {
      signal: options?.signal,
      timeout: BOARD_PENDING_TIMEOUT,
    });
  }

  /**
   * Registers this connection's board identity at the CITT gateway
   * (`board/register`, frozen contract in 02-board-state-watcher.md).
   * CITT's registry is PROCESS-SCOPED, so the call belongs to every
   * connection establishment and is idempotent per handle. Errors: `-32002`
   * handle conflict, `-32602` invalid handle. Best-effort: an unregistered
   * fork stays fully functional on mode-(a) `board/pending`.
   */
  async boardRegister(
    handle: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean; handle: string }> {
    return await this.callMethod(
      "board/register",
      { handle },
      BoardRegisterResultSchema,
      { signal: options?.signal, timeout: BOARD_REGISTER_TIMEOUT },
    );
  }

  /**
   * One-shot board-state migration (`board/migrateImport`, frozen contract in
   * 02-board-state-watcher.md): upserts/removes server-side subscriptions and
   * seeds the consumed-cursor markers (`ConsumedCommentId <- MAX`, never
   * backwards). REQUIRES a prior `boardRegister` on this connection
   * (`-32003` otherwise, never a fallback identity); idempotent and
   * retry-safe after connection loss. All payload fields are required and
   * unknown fields are rejected.
   */
  async boardMigrateImport(
    topics: BoardMigrateImportTopic[],
    options?: { signal?: AbortSignal },
  ): Promise<{
    ok: boolean;
    processed: number;
    subscribed: number;
    cursorAdvanced: boolean;
  }> {
    return await this.callMethod(
      "board/migrateImport",
      { topics },
      BoardMigrateImportResultSchema,
      { signal: options?.signal, timeout: BOARD_MIGRATE_IMPORT_TIMEOUT },
    );
  }

  /**
   * Dumps a rendered conversation transcript to CITT memory
   * (`transcript/dump`, contract in continue-transcript-dump.md). CITT owns
   * replace-by-name, chunking and storage. Best-effort: callers must handle
   * errors and never block session saving on this.
   */
  async transcriptDump(
    payload: TranscriptDumpPayload,
    options?: { signal?: AbortSignal },
  ): Promise<TranscriptDumpResult> {
    const params: Record<string, unknown> = {
      memory: payload.memory,
      name: payload.name,
      text: payload.text,
    };
    if (payload.meta) {
      params.meta = payload.meta;
    }
    return await this.callMethod(
      "transcript/dump",
      params,
      TranscriptDumpResultSchema,
      {
        signal: options?.signal,
        timeout: TRANSCRIPT_DUMP_TIMEOUT,
      },
    );
  }

  /**
   * Sends an HTTP request through the CITT proxy tunnel (`proxy/http`).
   *
   * Non-streaming responses are returned whole. Streaming responses expose
   * the raw SSE chunks as an async iterable fed by `proxy/http/chunk`
   * notifications; it terminates on `proxy/http/done` and throws on
   * `proxy/http/error`.
   *
   * HTTP errors (4xx/5xx) come back as results with that status - they are
   * returned, not thrown. Only protocol-level JSON-RPC errors throw.
   */
  async proxyHttp(
    params: ProxyHttpParams,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<ProxyHttpResponse> {
    tunnelDiagLog({
      ev: "req",
      path: params.path,
      bodyLen: params.body?.length ?? 0,
    });
    const requestedAt = Date.now();
    const result = await this.callMethod(
      "proxy/http",
      { ...params },
      ProxyHttpResultSchema,
      {
        signal: options?.signal,
        // Non-streaming chat completions can take minutes; the SDK default
        // (60s) is far too low. Streaming requests resolve quickly with the
        // stream-start result, so a generous timeout is harmless there.
        timeout: options?.timeout ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT,
      },
    );

    if (result.streaming) {
      if (!result.streamId) {
        throw new Error("proxy/http returned streaming=true without streamId");
      }
      tunnelDiagLog({
        ev: "reqResult",
        streamId: result.streamId,
        status: result.status,
        ms: Date.now() - requestedAt,
      });
      return {
        streaming: true,
        status: result.status,
        headers: result.headers ?? {},
        streamId: result.streamId,
        chunks: this.createProxyStreamIterable(result.streamId),
      };
    }

    tunnelDiagLog({
      ev: "reqResult",
      streaming: false,
      status: result.status,
      ms: Date.now() - requestedAt,
    });
    return {
      streaming: false,
      status: result.status,
      headers: result.headers ?? {},
      body: result.body ?? "",
    };
  }

  /**
   * Best-effort cancellation of an active proxy stream (decision #3 of the
   * tunneling spec): the local iterable is terminated immediately with an
   * AbortError, `proxy/cancel` is sent fire-and-forget, and late chunks for
   * this streamId are silently discarded.
   */
  cancelProxyStream(streamId: string): void {
    const entry = this.activeProxyStreams.get(streamId);
    if (!entry || entry.state === ProxyStreamState.Cancelled) {
      return;
    }
    tunnelDiagLog({ ev: "cancel", streamId });
    entry.state = ProxyStreamState.Cancelled;
    entry.cancelledAt = Date.now();

    const abortError = new Error(`Proxy stream ${streamId} cancelled`);
    abortError.name = "AbortError";
    entry.onError(abortError);

    this.callMethod("proxy/cancel", { streamId }, ProxyCancelResultSchema, {
      timeout: PROXY_METHOD_TIMEOUT,
    }).catch((e) => {
      console.warn(
        `proxy/cancel for stream ${streamId} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }

  private registerProxyNotificationHandlers(): void {
    // Type casts to avoid "Type instantiation is excessively deep" error
    // with MCP SDK 1.29+ complex generic inference. The schemas are correct;
    // we're just helping TypeScript avoid deep inference chains.
    type ChunkNotification = z.infer<typeof ProxyHttpChunkNotificationSchema>;
    type DoneNotification = z.infer<typeof ProxyHttpDoneNotificationSchema>;
    type ErrorNotification = z.infer<typeof ProxyHttpErrorNotificationSchema>;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.setNotificationHandler(
      ProxyHttpChunkNotificationSchema as any,
      (notification: ChunkNotification) => {
        this.handleProxyStreamEvent(notification.params.streamId, {
          kind: "chunk",
          data: notification.params.data,
        });
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.setNotificationHandler(
      ProxyHttpDoneNotificationSchema as any,
      (notification: DoneNotification) => {
        this.handleProxyStreamEvent(notification.params.streamId, {
          kind: "done",
        });
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.setNotificationHandler(
      ProxyHttpErrorNotificationSchema as any,
      (notification: ErrorNotification) => {
        const code = notification.params.error?.code;
        const message =
          notification.params.error?.message ?? "unknown proxy stream error";
        this.handleProxyStreamEvent(notification.params.streamId, {
          kind: "error",
          error: new Error(
            code !== undefined
              ? `Proxy stream error ${code}: ${message}`
              : `Proxy stream error: ${message}`,
          ),
        });
      },
    );
  }

  private handleProxyStreamEvent(
    streamId: string,
    event: ProxyStreamEvent,
  ): void {
    this.sweepProxyState();

    const entry = this.activeProxyStreams.get(streamId);
    if (!entry) {
      // Unknown streamId: either a notification that raced ahead of the
      // proxy/http result (buffered and flushed by registerProxyStream) or
      // a stray late notification (discarded by the TTL sweep).
      this.bufferEarlyProxyEvent(streamId, event);
      return;
    }

    if (entry.state === ProxyStreamState.Cancelled) {
      // Decision #3: late chunks after cancel are silently discarded. The
      // terminal notification releases the registry entry.
      if (event.kind !== "chunk") {
        this.activeProxyStreams.delete(streamId);
      }
      return;
    }

    switch (event.kind) {
      case "chunk":
        entry.onChunk(event.data);
        break;
      case "done":
        this.activeProxyStreams.delete(streamId);
        entry.onDone();
        break;
      case "error":
        this.activeProxyStreams.delete(streamId);
        entry.onError(event.error);
        break;
    }
  }

  private registerProxyStream(
    streamId: string,
    callbacks: Pick<ProxyStreamEntry, "onChunk" | "onDone" | "onError">,
  ): void {
    this.activeProxyStreams.set(streamId, {
      state: ProxyStreamState.Active,
      ...callbacks,
    });

    // Flush notifications that arrived before the proxy/http result was
    // processed (response resolution and notification dispatch both go
    // through microtasks, so ordering is not guaranteed).
    const buffered = this.earlyProxyEvents.get(streamId);
    if (buffered) {
      this.earlyProxyEvents.delete(streamId);
      for (const event of buffered.events) {
        this.handleProxyStreamEvent(streamId, event);
        if (event.kind !== "chunk") {
          break; // terminal event - nothing may follow
        }
      }
    }
  }

  private createProxyStreamIterable(streamId: string): AsyncIterable<string> {
    const queue: { event: ProxyStreamEvent; at: number }[] = [];
    let wake: (() => void) | undefined;

    // Diagnostics: event-loop lag watchdog. A 500ms interval whose actual
    // tick distance exposes synchronous blocks of the extension host.
    let lastTickAt = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTickAt;
      lastTickAt = now;
      if (elapsed > 1200) {
        tunnelDiagLog({ ev: "lag", streamId, blockedMs: elapsed - 500 });
      }
    }, 500);

    const push = (event: ProxyStreamEvent) => {
      queue.push({ event, at: Date.now() });
      if (event.kind !== "chunk") {
        clearInterval(watchdog);
      }
      wake?.();
      wake = undefined;
    };

    // Register synchronously so chunks arriving before the consumer starts
    // iterating are queued rather than treated as early/unknown events.
    this.registerProxyStream(streamId, {
      onChunk: (data) => push({ kind: "chunk", data }),
      onDone: () => push({ kind: "done" }),
      onError: (error) => push({ kind: "error", error }),
    });

    return {
      [Symbol.asyncIterator]: async function* () {
        try {
          while (true) {
            while (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            const item = queue.shift();
            if (!item) {
              continue;
            }
            const qWaitMs = Date.now() - item.at;
            switch (item.event.kind) {
              case "chunk":
                tunnelDiagLog({
                  ev: "chunk",
                  streamId,
                  len: item.event.data.length,
                  qWaitMs,
                  depth: queue.length,
                });
                yield item.event.data;
                break;
              case "done":
                tunnelDiagLog({ ev: "done", streamId, qWaitMs });
                return;
              case "error":
                tunnelDiagLog({
                  ev: "streamError",
                  streamId,
                  qWaitMs,
                  message: item.event.error.message,
                });
                throw item.event.error;
            }
          }
        } finally {
          clearInterval(watchdog);
        }
      },
    };
  }

  private bufferEarlyProxyEvent(
    streamId: string,
    event: ProxyStreamEvent,
  ): void {
    tunnelDiagLog({ ev: "earlyEvent", streamId, kind: event.kind });
    let buffered = this.earlyProxyEvents.get(streamId);
    if (!buffered) {
      buffered = { at: Date.now(), events: [] };
      this.earlyProxyEvents.set(streamId, buffered);
    }
    if (buffered.events.length < PROXY_EARLY_EVENT_LIMIT) {
      buffered.events.push(event);
    }
  }

  private sweepProxyState(): void {
    const now = Date.now();
    for (const [streamId, buffered] of this.earlyProxyEvents) {
      if (now - buffered.at > PROXY_EARLY_EVENT_TTL_MS) {
        this.earlyProxyEvents.delete(streamId);
      }
    }
    for (const [streamId, entry] of this.activeProxyStreams) {
      if (
        entry.state === ProxyStreamState.Cancelled &&
        entry.cancelledAt !== undefined &&
        now - entry.cancelledAt > PROXY_CANCELLED_ENTRY_TTL_MS
      ) {
        this.activeProxyStreams.delete(streamId);
      }
    }
  }

  /**
   * Lifecycle cleanup (decision #2): errors out every active stream and
   * clears the registry. Called on disconnect and on reconnect reset.
   */
  private failActiveProxyStreams(reason: string): void {
    const entries = [...this.activeProxyStreams.values()];
    this.activeProxyStreams.clear();
    this.earlyProxyEvents.clear();
    for (const entry of entries) {
      if (entry.state === ProxyStreamState.Active) {
        entry.onError(new Error(reason));
      }
    }
  }

  /**
   * Checks whether the server supports proxy-based endpoint discovery and,
   * if so, fetches available endpoints and the user's proxy key.
   *
   * Runs synchronously during connect (before status = "connected") so that
   * the data is available in status snapshots when the config reload is
   * triggered. Errors are logged but never fail the connection - a failing
   * proxy check just means no discovered models.
   */
  private async fetchProxyData(signal: AbortSignal): Promise<void> {
    try {
      const capabilities = await this.callMethod(
        "proxy/capabilities",
        {},
        ProxyCapabilitiesSchema,
        { signal, timeout: PROXY_METHOD_TIMEOUT },
      );
      this.proxyCapabilities = capabilities;

      if (!capabilities.proxy) {
        return;
      }

      const [{ endpoints }, { key }] = await Promise.all([
        this.callMethod("proxy/endpoints", {}, ProxyEndpointsSchema, {
          signal,
          timeout: PROXY_METHOD_TIMEOUT,
        }),
        this.callMethod("proxy/key", {}, ProxyKeySchema, {
          signal,
          timeout: PROXY_METHOD_TIMEOUT,
        }),
      ]);
      this.proxyEndpoints = endpoints;
      this.proxyKey = key;
    } catch (e) {
      // Proxy support is optional - most servers won't implement these
      // methods. Log and continue without discovered models.
      console.warn(
        `Proxy endpoint discovery not available for MCP server "${this.options.name}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async connectClient(forceRefresh: boolean, externalSignal: AbortSignal) {
    if (this.status === "disabled") {
      return;
    }
    if (!forceRefresh) {
      // Already connected
      if (this.status === "connected") {
        return;
      }

      // Connection is already in progress; wait for it to complete
      if (this.connectionPromise) {
        await this.connectionPromise;
        return;
      }
    }

    this.status = "connecting";
    this.tools = [];
    this.prompts = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.errors = [];
    this.infos = [];
    this.proxyCapabilities = undefined;
    this.proxyEndpoints = undefined;
    this.proxyKey = undefined;
    this.stdioOutput = { stdout: "", stderr: "" };
    this.failActiveProxyStreams("MCP connection closed");

    this.abortController.abort();
    this.abortController = new AbortController();

    // currently support oauth for sse transports only
    if (this.options.type === "sse") {
      if (!this.options.requestOptions) {
        this.options.requestOptions = {
          headers: {},
        };
      }
      const accessToken = await getOauthToken(
        this.options.url,
        this.extras?.ide!,
      );
      if (accessToken) {
        this.isProtectedResource = true;
        this.options.requestOptions.headers = {
          ...this.options.requestOptions.headers,
          Authorization: `Bearer ${accessToken}`,
        };
      }
    }

    const vars = getTemplateVariables(JSON.stringify(this.options));
    const unrendered = vars.map((v) => {
      const stripped = v.replace("secrets.", "");
      try {
        return decodeSecretLocation(stripped).secretName;
      } catch {
        return stripped;
      }
    });

    if (unrendered.length > 0) {
      this.errors.push(
        `${this.options.name} MCP Server has unresolved secrets: ${unrendered.join(", ")}.
For personal use you can set the secret in the hub at https://continue.dev/settings/secrets.
Org-level secrets can only be used for MCP by Background Agents (https://docs.continue.dev/hub/agents/overview) when \"Include in Env\" is enabled.`,
      );
    }

    this.connectionPromise = Promise.race([
      // If aborted by a refresh or other, cancel and don't do anything
      new Promise((resolve) => {
        externalSignal.addEventListener("abort", () => {
          resolve(undefined);
        });
      }),
      new Promise((resolve) => {
        this.abortController.signal.addEventListener("abort", () => {
          resolve(undefined);
        });
      }),
      (async () => {
        const timeoutController = new AbortController();
        const connectionTimeout = setTimeout(
          () => timeoutController.abort(),
          this.options.timeout ?? DEFAULT_MCP_CONNECTION_TIMEOUT,
        );

        try {
          await Promise.race([
            new Promise((_, reject) => {
              timeoutController.signal.addEventListener("abort", () => {
                reject(new Error("Connection timed out"));
              });
            }),
            (async () => {
              if ("command" in this.options) {
                // STDIO: no need to check type, just if command is present
                const transport = await this.constructStdioTransport(
                  this.options,
                );
                try {
                  await this.client.connect(transport, {});
                  this.transport = transport;
                } catch (error) {
                  // Allow the case where for whatever reason is already connected
                  if (
                    error instanceof Error &&
                    error.message.startsWith(
                      "StdioClientTransport already started",
                    )
                  ) {
                    await this.client.close();
                    await this.client.connect(transport);
                    this.transport = transport;
                  } else {
                    throw error;
                  }
                }
              } else {
                // SSE/HTTP: if type isn't explicit: try http and fall back to sse
                if (this.options.type === "sse") {
                  const transport = this.constructSseTransport(this.options);
                  await this.client.connect(transport, {});
                  this.transport = transport;
                } else if (this.options.type === "streamable-http") {
                  const transport = this.constructHttpTransport(this.options);
                  await this.client.connect(transport, {});
                  this.transport = transport;
                } else if (this.options.type === "websocket") {
                  const transport = this.constructWebsocketTransport(
                    this.options,
                  );
                  await this.client.connect(transport, {});
                  this.transport = transport;
                } else if (this.options.type) {
                  throw new Error(
                    `Unsupported transport type: ${this.options.type}`,
                  );
                } else {
                  try {
                    const transport = this.constructHttpTransport({
                      ...this.options,
                      type: "streamable-http",
                    });
                    await this.client.connect(transport, {});
                    this.transport = transport;
                  } catch (e) {
                    try {
                      const transport = this.constructSseTransport({
                        ...this.options,
                        type: "sse",
                      });
                      await this.client.connect(transport, {});
                      this.transport = transport;
                    } catch (e) {
                      throw new Error(
                        `MCP config with URL and no type specified failed both SSE and HTTP connection: ${e instanceof Error ? e.message : String(e)}`,
                      );
                    }
                  }
                }
              }

              // TODO register server notification handlers
              // this.client.transport?.onmessage(msg => console.log())
              // this.client.setNotificationHandler(, notification => {
              //   console.log(notification)
              // })
              const capabilities = this.client.getServerCapabilities();

              // Resources <—> Context Provider
              if (capabilities?.resources) {
                try {
                  const { resources } = await this.client.listResources(
                    {},
                    { signal: timeoutController.signal },
                  );
                  this.resources = resources;
                } catch (e) {
                  let errorMessage = `Error loading resources for MCP Server ${this.options.name}`;
                  if (e instanceof Error) {
                    errorMessage += `: ${e.message}`;
                  }
                  this.errors.push(errorMessage);
                }

                // Resource templates
                try {
                  const { resourceTemplates } =
                    await this.client.listResourceTemplates(
                      {},
                      { signal: timeoutController.signal },
                    );

                  this.resourceTemplates = resourceTemplates;
                } catch (e) {
                  let errorMessage = `Error loading resource templates for MCP Server ${this.options.name}`;
                  if (e instanceof Error) {
                    errorMessage += `: ${e.message}`;
                  }
                  this.errors.push(errorMessage);
                }
              }

              // Tools <—> Tools
              if (capabilities?.tools) {
                try {
                  const { tools } = await this.client.listTools(
                    {},
                    { signal: timeoutController.signal },
                  );
                  this.tools = tools;
                } catch (e) {
                  let errorMessage = `Error loading tools for MCP Server ${this.options.name}`;
                  if (e instanceof Error) {
                    errorMessage += `: ${e.message}`;
                  }
                  this.errors.push(errorMessage);
                }
              }

              // Prompts <—> Slash commands
              if (capabilities?.prompts) {
                try {
                  const { prompts } = await this.client.listPrompts(
                    {},
                    { signal: timeoutController.signal },
                  );
                  this.prompts = prompts;
                } catch (e) {
                  let errorMessage = `Error loading prompts for MCP Server ${this.options.name}`;
                  if (e instanceof Error) {
                    errorMessage += `: ${e.message}`;
                  }
                  this.errors.push(errorMessage);
                }
              }

              // Proxy endpoint discovery - must complete before the
              // connection is reported as connected so that proxy data is
              // available when the config reload is triggered (see
              // fetchProxyData docs)
              await this.fetchProxyData(timeoutController.signal);

              this.status = "connected";
            })(),
          ]);
        } catch (error) {
          // Otherwise it's a connection error
          let errorMessage = `Failed to connect to "${this.options.name}"\n`;
          if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes("spawn") && msg.includes("enoent")) {
              const command = msg.split(" ")[1];
              errorMessage += `Error: command "${command}" not found. To use this MCP server, install the ${command} CLI.`;
              if (["uv", "uvx"].includes(command)) {
                this.infos.push(
                  'Please install uv by following the installation guide: <a href="https://docs.astral.sh/uv/getting-started/installation/">https://docs.astral.sh/uv/getting-started/installation/</a>',
                );
              }
              if (["node", "npx"].includes(command)) {
                this.infos.push(
                  'Please install npx by following the installation guide: <a href="https://docs.npmjs.com/downloading-and-installing-node-js-and-npm">https://docs.npmjs.com/downloading-and-installing-node-js-and-npm</a>',
                );
              }
            } else {
              errorMessage += "Error: " + error.message;
            }
          }

          if (is401Error(error)) {
            this.isProtectedResource = true;
          }

          // Include stdio output if available for stdio transport
          if (
            this.options.type === "stdio" &&
            (this.stdioOutput.stdout || this.stdioOutput.stderr)
          ) {
            errorMessage += "\n\nProcess output:";
            if (this.stdioOutput.stdout) {
              errorMessage += `\nSTDOUT:\n${this.stdioOutput.stdout}`;
            }
            if (this.stdioOutput.stderr) {
              errorMessage += `\nSTDERR:\n${this.stdioOutput.stderr}`;
            }
          }

          this.status = "error";
          this.errors.push(errorMessage);
        } finally {
          this.connectionPromise = null;
          clearTimeout(connectionTimeout);
        }
      })(),
    ]);

    await this.connectionPromise;
  }

  /**
   * Resolves the command and arguments for the current platform
   * On Windows, batch script commands need to be executed via cmd.exe
   * UNLESS we're connected to a WSL remote (where Linux commands should run)
   * @param originalCommand The original command
   * @param originalArgs The original command arguments
   * @returns An object with the resolved command and arguments
   */
  private async resolveCommandForPlatform(
    originalCommand: string,
    originalArgs: string[],
  ): Promise<{ command: string; args: string[] }> {
    // Check if we're on Windows host connected to WSL remote
    const ideInfo = await this.extras?.ide?.getIdeInfo();
    const isWindowsHostWithWslRemote =
      process.platform === "win32" && ideInfo?.remoteName === "wsl";

    // If not on Windows, or connected to WSL, or not a batch command, return as-is
    if (
      process.platform !== "win32" ||
      isWindowsHostWithWslRemote ||
      !WINDOWS_BATCH_COMMANDS.includes(originalCommand)
    ) {
      return { command: originalCommand, args: originalArgs };
    }

    // On Windows (local), we need to execute batch commands via cmd.exe
    // Format: cmd.exe /c command [args]
    return {
      command: "cmd.exe",
      args: ["/c", originalCommand, ...originalArgs],
    };
  }

  /**
   * Resolves the current working directory of the current workspace.
   * @param cwd The cwd parameter provided by user.
   * @returns Current working directory (user-provided cwd or workspace root).
   */
  private async resolveCwd(cwd?: string) {
    if (!cwd) {
      return this.resolveWorkspaceCwd(undefined);
    }

    if (cwd.startsWith("file://")) {
      return fileURLToPath(cwd);
    }

    // Return cwd if cwd is an absolute path.
    if (cwd.charAt(0) === "/") {
      return cwd;
    }

    return this.resolveWorkspaceCwd(cwd);
  }

  private async resolveWorkspaceCwd(cwd: string | undefined) {
    const IDE = this.extras?.ide;
    if (IDE) {
      const target = cwd ?? ".";
      const resolved = await resolveRelativePathInDir(target, IDE);
      if (resolved) {
        if (resolved.startsWith("file://")) {
          return fileURLToPath(resolved);
        }
        // Remote URIs (e.g. vscode-remote://ssh-remote+host/path) cannot be
        // used as a local cwd for child_process.spawn(). When the extension
        // runs in the Local Extension Host on Windows while connected to a
        // remote workspace, fall back to the user's home directory.
        if (resolved.includes("://")) {
          return homedir();
        }
        return resolved;
      }
      return resolved;
    }
    return cwd;
  }

  private constructWebsocketTransport(
    options: InternalWebsocketMcpOptions,
  ): WebSocketClientTransport {
    return new WebSocketClientTransport(new URL(options.url));
  }

  private constructSseTransport(
    options: InternalSseMcpOptions,
  ): SSEClientTransport {
    const sseAgent =
      options.requestOptions?.verifySsl === false
        ? new HttpsAgent({ rejectUnauthorized: false })
        : undefined;

    // Merge apiKey into headers if provided
    const headers = {
      ...options.requestOptions?.headers,
      ...(options.apiKey && { Authorization: `Bearer ${options.apiKey}` }),
    };

    return new SSEClientTransport(new URL(options.url), {
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: {
              ...init?.headers,
              ...headers,
            },
            ...(sseAgent && { agent: sseAgent }),
          }),
      },
      requestInit: {
        headers,
        ...(sseAgent && { agent: sseAgent }),
      },
    });
  }

  private constructHttpTransport(
    options: InternalStreamableHttpMcpOptions,
  ): StreamableHTTPClientTransport {
    const { url, requestOptions } = options;
    const streamableAgent =
      requestOptions?.verifySsl === false
        ? new HttpsAgent({ rejectUnauthorized: false })
        : undefined;

    // Merge apiKey into headers if provided
    const headers = {
      ...requestOptions?.headers,
      ...(options.apiKey && { Authorization: `Bearer ${options.apiKey}` }),
    };

    return new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers,
        ...(streamableAgent && { agent: streamableAgent }),
      },
    });
  }

  private async constructStdioTransport(
    options: InternalStdioMcpOptions,
  ): Promise<StdioClientTransport> {
    const commonEnvVars: Record<string, string> = Object.fromEntries(
      COMMONS_ENV_VARS.filter((key) => process.env[key] !== undefined).map(
        (key) => [key, process.env[key] as string],
      ),
    );

    const env = {
      ...commonEnvVars,
      ...(options.env ?? {}),
    };

    if (process.env.PATH !== undefined) {
      // Set the initial PATH from process.env
      env.PATH = process.env.PATH;

      // For non-Windows platforms or WSL remotes, try to get the PATH from user shell
      const ideInfo = await this.extras?.ide?.getIdeInfo();
      const isWindowsHostWithWslRemote =
        process.platform === "win32" && ideInfo?.remoteName === "wsl";
      if (process.platform !== "win32" || isWindowsHostWithWslRemote) {
        try {
          const shellEnvPath = await getEnvPathFromUserShell(
            ideInfo?.remoteName,
          );
          if (shellEnvPath && shellEnvPath !== process.env.PATH) {
            env.PATH = shellEnvPath;
          }
        } catch (err) {
          console.error("Error getting PATH:", err);
        }
      }
    }

    const { command, args } = await this.resolveCommandForPlatform(
      options.command,
      options.args || [],
    );

    const cwd = await this.resolveCwd(options.cwd);

    const transport = new StdioClientTransport({
      command,
      args,
      env,
      cwd,
      stderr: "pipe",
    });

    // Capture stdio output for better error reporting
    transport.stderr?.on("data", (data: Buffer) => {
      this.stdioOutput.stderr += data.toString();
    });

    return transport;
  }

  async getResource(uri: string) {
    return await this.client.readResource(
      { uri },
      {
        timeout: this.options.timeout,
      },
    );
  }
}

export default MCPConnection;
