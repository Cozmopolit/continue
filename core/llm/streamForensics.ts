import {
  isPrematureStreamEndError,
  PrematureStreamEndError,
  probeTlsIssuer,
  StreamForensics,
  TlsProbeResult,
} from "@continuedev/fetch";
import * as fs from "fs";
import * as path from "path";

import { getContinueGlobalPath } from "../util/paths.js";

/**
 * Stream failure forensics.
 *
 * When a streaming LLM response ends prematurely (connection closed without
 * [DONE]/finish_reason — typically a corporate middlebox killing long-lived
 * SSE connections), we:
 *   1. probe the TLS certificate chain of the API host (definitive evidence
 *      for TLS interception, e.g. a Zscaler-issued certificate),
 *   2. append a structured JSONL record to
 *      <CONTINUE_GLOBAL_DIR>/logs/stream-forensics.jsonl,
 *   3. enrich the error message shown in the GUI with the findings.
 *
 * The JSONL log is the primary analysis channel for environments where the
 * extension cannot be developed/debugged locally: users can simply send the
 * file back to the development team.
 */

export interface StreamFailureForensicsRecord {
  timestamp: string;
  provider: string;
  model: string;
  apiBase?: string;
  requestType: string;
  errorName: string;
  errorMessage: string;
  streamForensics?: StreamForensics;
  tlsProbe?: TlsProbeResult;
}

export function getStreamForensicsLogPath(): string {
  return path.join(getContinueGlobalPath(), "logs", "stream-forensics.jsonl");
}

/** Pure record builder (unit-tested). */
export function buildStreamFailureForensicsRecord(options: {
  provider: string;
  model: string;
  apiBase?: string;
  requestType: string;
  error: PrematureStreamEndError;
  tlsProbe?: TlsProbeResult;
}): StreamFailureForensicsRecord {
  return {
    timestamp: new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    apiBase: options.apiBase,
    requestType: options.requestType,
    errorName: options.error.name,
    errorMessage: options.error.message,
    streamForensics: options.error.forensics,
    tlsProbe: options.tlsProbe,
  };
}

/** Appends a record to the JSONL forensics log. Best effort, never throws. */
export async function appendStreamForensicsRecord(
  record: StreamFailureForensicsRecord,
): Promise<void> {
  try {
    const logPath = getStreamForensicsLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Forensics must never break error handling
  }
}

const MAX_CHAIN_ENTRIES_IN_MESSAGE = 4;

/** Pure: human-readable summary of a TLS probe result. */
export function buildTlsProbeSummary(probe: TlsProbeResult): string {
  const lines: string[] = [];
  if (!probe.ok) {
    lines.push(
      `TLS probe to ${probe.host}:${probe.port} failed: ${probe.error ?? "unknown error"}`,
    );
    lines.push(
      "(A failing probe right after a failed stream is itself evidence of network interference.)",
    );
    return lines.join("\n");
  }

  const transport: string[] = [];
  if (probe.tlsProtocol) {
    transport.push(probe.tlsProtocol);
  }
  if (probe.cipher) {
    transport.push(probe.cipher);
  }
  lines.push(
    `TLS probe to ${probe.host}:${probe.port}: ${transport.join(" / ") || "connected"}, certificate authorized=${probe.authorized}`,
  );
  if (probe.proxyUsed && probe.proxyOrigin) {
    lines.push(`Probe went through proxy ${probe.proxyOrigin}.`);
  }

  if (probe.chain && probe.chain.length > 0) {
    lines.push("Certificate chain presented by the server (leaf first):");
    for (const entry of probe.chain.slice(0, MAX_CHAIN_ENTRIES_IN_MESSAGE)) {
      lines.push(`  - ${entry.subject}  (issued by: ${entry.issuer})`);
    }
    if (probe.chain.length > MAX_CHAIN_ENTRIES_IN_MESSAGE) {
      lines.push(
        `  … ${probe.chain.length - MAX_CHAIN_ENTRIES_IN_MESSAGE} more`,
      );
    }
  }

  if (probe.suspectedInterception && probe.suspectedInterception.length > 0) {
    lines.push(
      `⚠ TLS INTERCEPTION DETECTED: the certificate was issued by ${probe.suspectedInterception.join(", ")}.`,
    );
    lines.push(
      "Your corporate proxy/firewall is inspecting HTTPS traffic and is very likely terminating these streaming connections. " +
        "Contact your network/security team with this information and ask for an SSL-inspection exemption for the API host.",
    );
  } else {
    lines.push(
      "No known TLS-inspection vendor found in the certificate chain. If the chain shows your organization's CA instead of a public CA, traffic is still being intercepted.",
    );
  }
  return lines.join("\n");
}

/** Pure: enriches the original error message with probe results + log path. */
export function buildEnrichedErrorMessage(
  originalMessage: string,
  probe: TlsProbeResult | undefined,
  logPath: string,
): string {
  const parts = [originalMessage, "", "--- Network forensics ---"];
  if (probe) {
    parts.push(buildTlsProbeSummary(probe));
  } else {
    parts.push("(TLS probe not available — no apiBase configured.)");
  }
  parts.push("", `Full forensics record appended to: ${logPath}`);
  return parts.join("\n");
}

export interface CaptureStreamFailureOptions {
  provider: string;
  model: string;
  apiBase?: string;
  requestType: string;
  error: unknown;
  requestOptions?: import("@continuedev/config-types").RequestOptions;
}

/**
 * Runs the full forensics pipeline for a stream failure. Only acts on
 * PrematureStreamEndError; for all other errors this is a no-op.
 * Returns the enriched message to display (or undefined when not applicable).
 */
export async function captureStreamFailureForensics(
  options: CaptureStreamFailureOptions,
): Promise<{ enrichedMessage?: string }> {
  if (!isPrematureStreamEndError(options.error)) {
    return {};
  }

  let probe: TlsProbeResult | undefined;
  if (options.apiBase) {
    try {
      probe = await probeTlsIssuer(options.apiBase, options.requestOptions);
    } catch {
      probe = undefined;
    }
  }

  const record = buildStreamFailureForensicsRecord({
    provider: options.provider,
    model: options.model,
    apiBase: options.apiBase,
    requestType: options.requestType,
    error: options.error as PrematureStreamEndError,
    tlsProbe: probe,
  });
  await appendStreamForensicsRecord(record);

  return {
    enrichedMessage: buildEnrichedErrorMessage(
      (options.error as Error).message,
      probe,
      getStreamForensicsLogPath(),
    ),
  };
}
