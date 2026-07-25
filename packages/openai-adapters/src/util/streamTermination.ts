import {
  formatPrematureStreamEndMessage,
  PrematureStreamEndError,
  StreamForensics,
} from "@continuedev/fetch";

/**
 * Stream termination guard for SDK-level chat/completion streams.
 *
 * The OpenAI SDK silently treats a cleanly closed connection as a completed
 * stream — even when the server never sent a `finish_reason` chunk. Behind
 * corporate middleboxes (TLS-inspecting proxies, firewalls) that kill
 * long-lived SSE connections, this makes a truncated answer look like a
 * complete one. This module tracks chunk-level evidence and throws a
 * PrematureStreamEndError (with forensics) when the stream ends without
 * any completion signal.
 */

export interface ChatStreamTerminationStats {
  chunks: number;
  contentChars: number;
  reasoningChars: number;
  toolCallChunks: number;
  sawFinishReason: boolean;
  finishReasons: string[];
  sawUsage: boolean;
  firstChunkAtMs: number | null;
  lastChunkAtMs: number | null;
  requestId?: string;
  model?: string;
}

export function createChatStreamTerminationStats(): ChatStreamTerminationStats {
  return {
    chunks: 0,
    contentChars: 0,
    reasoningChars: 0,
    toolCallChunks: 0,
    sawFinishReason: false,
    finishReasons: [],
    sawUsage: false,
    firstChunkAtMs: null,
    lastChunkAtMs: null,
  };
}

/**
 * Tracks a single streamed chunk (OpenAI ChatCompletionChunk or legacy
 * Completion shape). Mutates `stats`.
 */
export function trackChatStreamChunk(
  stats: ChatStreamTerminationStats,
  chunk: unknown,
): void {
  if (!chunk || typeof chunk !== "object") {
    return;
  }
  const now = Date.now();
  stats.chunks++;
  if (stats.firstChunkAtMs === null) {
    stats.firstChunkAtMs = now;
  }
  stats.lastChunkAtMs = now;

  const c = chunk as any;
  if (!stats.requestId && typeof c.id === "string" && c.id.length > 0) {
    stats.requestId = c.id;
  }
  if (!stats.model && typeof c.model === "string" && c.model.length > 0) {
    stats.model = c.model;
  }
  if (c.usage) {
    stats.sawUsage = true;
  }
  const choices = c.choices;
  if (!Array.isArray(choices)) {
    return;
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      continue;
    }
    if (
      typeof choice.finish_reason === "string" &&
      choice.finish_reason.length > 0
    ) {
      stats.sawFinishReason = true;
      if (!stats.finishReasons.includes(choice.finish_reason)) {
        stats.finishReasons.push(choice.finish_reason);
      }
    }
    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      if (typeof delta.content === "string") {
        stats.contentChars += delta.content.length;
      }
      if (typeof delta.reasoning_content === "string") {
        stats.reasoningChars += delta.reasoning_content.length;
      } else if (typeof delta.reasoning === "string") {
        stats.reasoningChars += delta.reasoning.length;
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        stats.toolCallChunks++;
      }
    }
    // Legacy completions shape
    if (typeof choice.text === "string") {
      stats.contentChars += choice.text.length;
    }
  }
}

/**
 * Hosts whose SSE streams are known to always terminate with a
 * finish_reason chunk followed by `data: [DONE]`. For these, a stream
 * ending without finish_reason is definitively broken.
 */
export const STRICT_STREAM_TERMINATION_HOSTS: string[] = [
  "openrouter.ai",
  "api.openai.com",
  "openai.azure.com",
  "api.deepseek.com",
  "api.moonshot.cn",
  "api.moonshot.ai",
  "api.x.ai",
  "api.groq.com",
  "api.cerebras.ai",
  "api.together.xyz",
  "api.together.ai",
  "api.mistral.ai",
  "api.fireworks.ai",
];

function hostnameMatches(host: string, candidate: string): boolean {
  return host === candidate || host.endsWith(`.${candidate}`);
}

/**
 * Decides whether a stream ending without finish_reason should throw.
 * Env override: CONTINUE_STRICT_STREAM_TERMINATION=1/0 forces on/off.
 * Default: strict for well-known OpenAI-compatible hosts.
 */
export function shouldEnforceStreamTermination(
  apiBase: string | undefined,
): boolean {
  const override =
    process.env.CONTINUE_STRICT_STREAM_TERMINATION?.trim().toLowerCase();
  if (override) {
    if (["0", "false", "off", "no"].includes(override)) {
      return false;
    }
    if (["1", "true", "on", "yes", "always"].includes(override)) {
      return true;
    }
  }
  if (!apiBase) {
    return false;
  }
  let host: string;
  try {
    host = new URL(apiBase).hostname.toLowerCase();
  } catch {
    return false;
  }
  return STRICT_STREAM_TERMINATION_HOSTS.some((candidate) =>
    hostnameMatches(host, candidate),
  );
}

export function buildAdapterStreamForensics(
  stats: ChatStreamTerminationStats,
  startedAtMs: number,
  context?: string,
): StreamForensics {
  const now = Date.now();
  return {
    charsReceived: stats.contentChars + stats.reasoningChars,
    chunksReceived: stats.chunks,
    sseLinesParsed: stats.chunks, // SDK-level: one parsed event per chunk
    commentLines: 0,
    dataEventsYielded: stats.chunks,
    sawDoneSentinel: false,
    doneSentinelObservable: false,
    sawCompletionSignal: stats.sawFinishReason,
    completionSignal:
      stats.finishReasons.length > 0
        ? `finish_reason=${stats.finishReasons.join(",")}`
        : undefined,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: now - startedAtMs,
    lastChunkAgeMs:
      stats.lastChunkAtMs === null ? null : now - stats.lastChunkAtMs,
    context,
  };
}

export interface GuardChatStreamOptions {
  apiBase?: string;
  model?: string;
  signal?: AbortSignal;
  /**
   * Explicit override; defaults to shouldEnforceStreamTermination(apiBase).
   * A stream that produced zero chunks always throws (that is never a
   * valid completion), regardless of this setting.
   */
  enforce?: boolean;
  /** Free-form context for error messages/forensics. */
  context?: string;
}

/**
 * Wraps an SDK stream: passes chunks through unchanged while tracking
 * termination evidence. After the stream ends:
 * - user abort (signal)  -> silently accepted
 * - zero chunks          -> PrematureStreamEndError (always)
 * - no finish_reason     -> PrematureStreamEndError when enforced
 */
export async function* guardChatCompletionStream<T>(
  stream: AsyncIterable<T>,
  options?: GuardChatStreamOptions,
): AsyncGenerator<T> {
  const startedAtMs = Date.now();
  const stats = createChatStreamTerminationStats();

  for await (const chunk of stream) {
    trackChatStreamChunk(stats, chunk);
    yield chunk;
  }

  if (options?.signal?.aborted) {
    return;
  }

  const enforce =
    options?.enforce ?? shouldEnforceStreamTermination(options?.apiBase);

  if (stats.chunks === 0) {
    const forensics = buildAdapterStreamForensics(
      stats,
      startedAtMs,
      options?.context,
    );
    throw new PrematureStreamEndError(
      formatPrematureStreamEndMessage(forensics),
      forensics,
    );
  }

  if (enforce && !stats.sawFinishReason) {
    const forensics = buildAdapterStreamForensics(
      stats,
      startedAtMs,
      options?.context,
    );
    throw new PrematureStreamEndError(
      formatPrematureStreamEndMessage(forensics),
      forensics,
    );
  }
}
