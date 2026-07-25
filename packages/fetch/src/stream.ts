import { getFetchDiagnostics } from "./diagnostics.js";

/**
 * Structured forensics describing how a (SSE) stream terminated.
 * Attached to {@link PrematureStreamEndError} and written to the
 * stream-forensics log by the core so that failures observed on machines
 * without a development setup can be analyzed offline.
 */
export interface StreamForensics {
  /** string characters received over the wire (utf-8 decoded) */
  charsReceived: number;
  /** transport-level chunks received */
  chunksReceived: number;
  /** SSE lines parsed (data + comments + sentinels) */
  sseLinesParsed: number;
  /** SSE comment lines, e.g. ": OPENROUTER PROCESSING" keepalives */
  commentLines: number;
  /** successfully parsed `data:` events yielded to the consumer */
  dataEventsYielded: number;
  /** the `data: [DONE]` sentinel was seen */
  sawDoneSentinel: boolean;
  /**
   * Whether the consumer can observe the raw [DONE] sentinel at all.
   * False for SDK-level streams (openai-adapters), where only parsed
   * chunks are visible — error messages should then not claim that no
   * [DONE] was received.
   */
  doneSentinelObservable?: boolean;
  /**
   * A provider-level completion signal was seen
   * (OpenAI `finish_reason`, Anthropic `message_stop`, ...)
   */
  sawCompletionSignal: boolean;
  /** e.g. "finish_reason=stop" or "message_stop" */
  completionSignal?: string;
  /** ISO timestamp of stream start */
  startedAt: string;
  durationMs: number;
  /** ms between the last received chunk and the connection close */
  lastChunkAgeMs: number | null;
  /**
   * Unparsed tail of the internal buffer when the connection closed.
   * A non-empty, unterminated value is strong evidence that the
   * connection was cut mid-frame by a middlebox.
   */
  leftoverBuffer?: string;
  /** last fully parsed raw `data:` line (truncated) */
  lastDataLineSnippet?: string;
  /** response status + selected response headers */
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  /** proxy diagnostics captured by fetchwithRequestOptions */
  proxyUsed?: boolean;
  proxyOrigin?: string;
  /** free-form context, e.g. "openai-adapter chat.completions" */
  context?: string;
}

export class PrematureStreamEndError extends Error {
  readonly name = "PrematureStreamEndError";
  constructor(
    message: string,
    public readonly forensics: StreamForensics,
  ) {
    super(message);
  }
}

/**
 * Duck-typing guard (safe across package boundaries where instanceof fails
 * due to duplicated module instances).
 */
export function isPrematureStreamEndError(
  e: unknown,
): e is PrematureStreamEndError {
  return (
    e instanceof Error &&
    e.name === "PrematureStreamEndError" &&
    typeof (e as any).forensics === "object" &&
    (e as any).forensics !== null
  );
}

const TRUNCATE = 240;

function truncate(s: string, max: number = TRUNCATE): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Headers worth keeping for middlebox forensics (lowercased keys). */
const DIAGNOSTIC_HEADER_KEYS = new Set([
  "via",
  "server",
  "cf-ray",
  "x-request-id",
  "x-cache",
  "x-amz-cf-id",
  "x-amzn-requestid",
  "x-envoy-upstream-service-time",
  "x-ms-invokeapp",
  "strict-transport-security",
  "content-type",
  "date",
]);

export function collectDiagnosticHeaders(
  headers: unknown,
): Record<string, string> | undefined {
  if (!headers || typeof (headers as any).forEach !== "function") {
    return undefined;
  }
  const out: Record<string, string> = {};
  try {
    (
      headers as { forEach: (cb: (v: string, k: string) => void) => void }
    ).forEach((value, key) => {
      const k = key.toLowerCase();
      if (DIAGNOSTIC_HEADER_KEYS.has(k) || k.startsWith("x-")) {
        out[k] = truncate(String(value), 200);
      }
    });
  } catch {
    return undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Detects a provider-level "completion finished" signal inside a parsed
 * SSE data event. Covers the OpenAI dialect (`choices[*].finish_reason`)
 * and the Anthropic dialect (`{"type":"message_stop"}`).
 */
export function detectCompletionSignal(data: unknown): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const choices = (data as any).choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (
        choice &&
        typeof choice.finish_reason === "string" &&
        choice.finish_reason.length > 0
      ) {
        return `finish_reason=${choice.finish_reason}`;
      }
    }
  }
  if (
    typeof (data as any).finish_reason === "string" &&
    (data as any).finish_reason.length > 0
  ) {
    return `finish_reason=${(data as any).finish_reason}`;
  }
  if ((data as any).type === "message_stop") {
    return "message_stop";
  }
  return undefined;
}

/**
 * Builds the human-readable message for a {@link PrematureStreamEndError}.
 * Pure function (unit-tested).
 */
export function formatPrematureStreamEndMessage(f: StreamForensics): string {
  const lines: string[] = [];
  const missingEvidence =
    f.doneSentinelObservable === false
      ? "no finish_reason was received"
      : "no [DONE] sentinel, no finish_reason";
  if (f.dataEventsYielded === 0) {
    lines.push(
      `The response stream ended prematurely: the connection was closed before any data was received (${missingEvidence}).`,
    );
  } else {
    lines.push(
      `The response stream ended prematurely: the connection was closed mid-stream before the completion finished (${missingEvidence}).`,
    );
  }
  if (f.context) {
    lines.push(`Stream context: ${f.context}.`);
  }

  const stats: string[] = [];
  stats.push(`${f.dataEventsYielded} data events`);
  stats.push(`${f.charsReceived} chars received`);
  stats.push(`${(f.durationMs / 1000).toFixed(1)}s duration`);
  if (f.lastChunkAgeMs !== null) {
    stats.push(
      `last chunk ${(f.lastChunkAgeMs / 1000).toFixed(1)}s before close`,
    );
  }
  if (f.commentLines > 0) {
    stats.push(`${f.commentLines} keepalive/comment lines`);
  }
  lines.push(`Stream forensics: ${stats.join(", ")}.`);

  if (f.leftoverBuffer) {
    lines.push(
      `Unterminated tail (connection cut mid-frame): "${f.leftoverBuffer}"`,
    );
  }
  if (f.lastDataLineSnippet) {
    lines.push(`Last complete data line: "${f.lastDataLineSnippet}"`);
  }
  if (f.responseHeaders) {
    const rendered = Object.entries(f.responseHeaders)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Response headers: ${rendered}`);
  }
  if (f.proxyUsed && f.proxyOrigin) {
    lines.push(`Proxy used for this request: ${f.proxyOrigin}`);
  }
  lines.push(
    "This is typically caused by a network middlebox (corporate proxy, firewall, VPN, TLS inspection, antivirus web filter) terminating long-lived streaming connections.",
  );
  return lines.join("\n");
}

export async function* toAsyncIterable(
  nodeReadable: NodeJS.ReadableStream,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of nodeReadable) {
    // @ts-ignore
    yield chunk as Uint8Array;
  }
}

/**
 * Responses whose body iteration ended due to a client-side abort.
 * Lets streamSse distinguish "user cancelled" from "connection dropped"
 * without requiring every caller to thread an AbortSignal through.
 */
const abortedResponses = new WeakSet<object>();

export function wasAborted(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    abortedResponses.has(response as object)
  );
}

export async function* streamResponse(
  response: Response,
): AsyncGenerator<string> {
  if (response.status === 499) {
    return; // In case of client-side cancellation, just return
  }

  if (response.status !== 200) {
    throw new Error(await response.text());
  }

  if (!response.body) {
    throw new Error("No response body returned.");
  }

  // Get the major version of Node.js
  const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);
  let chunks = 0;

  try {
    if (nodeMajorVersion >= 20) {
      // Use the new API for Node 20 and above
      const stream = (ReadableStream as any).from(response.body);
      for await (const chunk of stream.pipeThrough(
        new TextDecoderStream("utf-8"),
      )) {
        yield chunk;
        chunks++;
      }
    } else {
      // Fallback for Node versions below 20
      // Streaming with this method doesn't work as version 20+ does
      const decoder = new TextDecoder("utf-8");
      const nodeStream = response.body as unknown as NodeJS.ReadableStream;
      for await (const chunk of toAsyncIterable(nodeStream)) {
        yield decoder.decode(chunk, { stream: true });
        chunks++;
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      if (e.name.startsWith("AbortError")) {
        // Mark the response so streamSse can skip premature-end forensics
        // for user-initiated cancellations.
        abortedResponses.add(response as unknown as object);
        return; // In case of client-side cancellation, just return
      }
      if (e.message.toLowerCase().includes("premature close")) {
        // Premature close can happen for various reasons, including:
        // - Malformed chunks of data received from the server
        // - The server closed the connection before sending the complete response
        // - Long delays from the server during streaming
        // - 'Keep alive' header being used in combination with an http agent and a set, low number of maxSockets
        if (chunks === 0) {
          throw new Error(
            "Stream was closed before any data was received. Try again. (Premature Close)",
          );
        } else {
          throw new Error(
            "The response was cancelled mid-stream. Try again. (Premature Close).",
          );
        }
      }
    }
    throw e;
  }
}

// Export for testing purposes
export function parseDataLine(line: string): any {
  const json = line.startsWith("data: ")
    ? line.slice("data: ".length)
    : line.slice("data:".length);

  try {
    const data = JSON.parse(json);
    if (data.error) {
      if (
        data.error &&
        typeof data.error === "object" &&
        "message" in data.error
      ) {
        console.error("Error in streamed response:", data.error);
        throw new Error(`Error streaming response: ${data.error.message}`);
      }
      throw new Error(
        `Error streaming response: ${JSON.stringify(data.error)}`,
      );
    }

    return data;
  } catch (e) {
    // If the error was thrown by our error check, rethrow it
    if (
      e instanceof Error &&
      e.message.startsWith("Error streaming response:")
    ) {
      throw e;
    }
    // Otherwise it's a JSON parsing error
    throw new Error(`Malformed JSON sent from server: ${json}`);
  }
}

export interface ParsedSseLine {
  done: boolean;
  data: any;
  /** SSE comment line (starts with ":"), e.g. keepalives */
  comment: boolean;
}

function parseSseLine(line: string): ParsedSseLine {
  if (line.startsWith("data:[DONE]") || line.startsWith("data: [DONE]")) {
    return { done: true, data: undefined, comment: false };
  }
  if (line.startsWith("data:")) {
    return { done: false, data: parseDataLine(line), comment: false };
  }
  // SSE comment lines (e.g. ": ping", ": OPENROUTER PROCESSING") are
  // keepalives. They must not terminate parsing — previously ": ping" was
  // treated as `done`, silently discarding the remainder of the buffer.
  if (line.startsWith(":")) {
    return { done: false, data: undefined, comment: true };
  }
  return { done: false, data: undefined, comment: false };
}

export interface StreamSseOptions {
  /**
   * When the signal aborts (user cancellation), premature-end detection is
   * skipped. Optional: aborts are also detected via the response object.
   */
  signal?: AbortSignal;
  /**
   * When true, ending the stream without a `[DONE]` sentinel and without a
   * provider completion signal throws PrematureStreamEndError (also for
   * completely empty streams).
   *
   * Default is false (lenient): streamSse is shared by many provider
   * dialects, some of which terminate SSE streams silently. In lenient mode
   * only an unparseable buffer tail (connection cut mid-frame — previously
   * surfaced as "Malformed JSON sent from server") throws. Callers that
   * know their provider always terminates with [DONE]/finish_reason should
   * opt into strict checking here.
   */
  expectTerminationSignal?: boolean;
  /** Free-form context included in error messages/forensics. */
  context?: string;
}

export async function* streamSse(
  response: Response,
  options?: StreamSseOptions,
): AsyncGenerator<any> {
  // Client-side cancellation short-circuit (also handled inside
  // streamResponse, but we must skip premature-end forensics here).
  if (response.status === 499) {
    return;
  }

  const startedAtMs = Date.now();
  const stats = {
    charsReceived: 0,
    chunksReceived: 0,
    sseLinesParsed: 0,
    commentLines: 0,
    dataEventsYielded: 0,
    sawDoneSentinel: false,
    sawCompletionSignal: false,
    completionSignal: undefined as string | undefined,
    lastChunkAtMs: null as number | null,
    lastDataLineSnippet: undefined as string | undefined,
  };

  const buildForensics = (leftoverBuffer?: string): StreamForensics => {
    const diag = getFetchDiagnostics(response);
    return {
      charsReceived: stats.charsReceived,
      chunksReceived: stats.chunksReceived,
      sseLinesParsed: stats.sseLinesParsed,
      commentLines: stats.commentLines,
      dataEventsYielded: stats.dataEventsYielded,
      sawDoneSentinel: stats.sawDoneSentinel,
      sawCompletionSignal: stats.sawCompletionSignal,
      completionSignal: stats.completionSignal,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: Date.now() - startedAtMs,
      lastChunkAgeMs:
        stats.lastChunkAtMs === null ? null : Date.now() - stats.lastChunkAtMs,
      leftoverBuffer: leftoverBuffer ? truncate(leftoverBuffer) : undefined,
      lastDataLineSnippet: stats.lastDataLineSnippet,
      responseStatus: response.status,
      responseHeaders: collectDiagnosticHeaders((response as any).headers),
      proxyUsed: diag?.proxyUsed,
      proxyOrigin: diag?.proxyOrigin,
      context: options?.context,
    };
  };

  let buffer = "";
  for await (const value of streamResponse(response)) {
    buffer += value;
    stats.charsReceived += value.length;
    stats.chunksReceived++;
    stats.lastChunkAtMs = Date.now();

    let position: number;
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position);
      buffer = buffer.slice(position + 1);
      stats.sseLinesParsed++;

      const { done, data, comment } = parseSseLine(line);
      if (comment) {
        stats.commentLines++;
        continue;
      }
      if (done) {
        stats.sawDoneSentinel = true;
        continue;
      }
      if (data) {
        const signal = detectCompletionSignal(data);
        if (signal) {
          stats.sawCompletionSignal = true;
          stats.completionSignal = signal;
        }
        stats.lastDataLineSnippet = truncate(line);
        stats.dataEventsYielded++;
        yield data;
      }
    }
  }

  // Flush the remaining buffer. A non-empty tail that does not parse is
  // evidence of a mid-frame cut, not a "malformed JSON" server bug.
  let leftoverForForensics: string | undefined;
  if (buffer.length > 0) {
    const tail = buffer.trim();
    if (tail.length > 0) {
      try {
        const { done, data, comment } = parseSseLine(tail);
        if (done) {
          stats.sawDoneSentinel = true;
        } else if (comment) {
          stats.commentLines++;
        } else if (data) {
          const signal = detectCompletionSignal(data);
          if (signal) {
            stats.sawCompletionSignal = true;
            stats.completionSignal = signal;
          }
          stats.dataEventsYielded++;
          yield data;
        }
      } catch {
        // Unparseable tail -> connection was cut mid-frame
        leftoverForForensics = tail;
      }
    }
  }

  const aborted = options?.signal?.aborted === true || wasAborted(response);
  if (aborted) {
    return;
  }

  // An unparseable buffer tail means the connection died in the middle of
  // an SSE frame — always an error (this used to surface as the misleading
  // "Malformed JSON sent from server").
  const cutMidFrame = leftoverForForensics !== undefined;

  const expectTermination = options?.expectTerminationSignal === true;
  const missingTermination =
    !stats.sawDoneSentinel && !stats.sawCompletionSignal;

  if (cutMidFrame || (expectTermination && missingTermination)) {
    const forensics = buildForensics(leftoverForForensics ?? undefined);
    throw new PrematureStreamEndError(
      formatPrematureStreamEndMessage(forensics),
      forensics,
    );
  }
}

export async function* streamJSON(response: Response): AsyncGenerator<any> {
  let buffer = "";
  for await (const value of streamResponse(response)) {
    buffer += value;

    let position;
    while ((position = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, position);
      try {
        const data = JSON.parse(line);
        yield data;
      } catch (e) {
        throw new Error(`Malformed JSON sent from server: ${line}`);
      }
      buffer = buffer.slice(position + 1);
    }
  }
}
