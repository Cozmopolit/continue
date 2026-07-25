import * as fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TlsProbeResult } from "@continuedev/fetch";

// Use the real @continuedev/fetch (built from packages/fetch), but stub the
// network-touching TLS probe.
vi.mock("@continuedev/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@continuedev/fetch")>();
  return {
    ...actual,
    probeTlsIssuer: vi.fn(),
  };
});

import {
  isPrematureStreamEndError,
  PrematureStreamEndError,
  probeTlsIssuer,
  StreamForensics,
} from "@continuedev/fetch";

import {
  appendStreamForensicsRecord,
  buildEnrichedErrorMessage,
  buildStreamFailureForensicsRecord,
  buildTlsProbeSummary,
  captureStreamFailureForensics,
  getStreamForensicsLogPath,
} from "./streamForensics.js";

const mockedProbe = vi.mocked(probeTlsIssuer);

function makeForensics(overrides?: Partial<StreamForensics>): StreamForensics {
  return {
    charsReceived: 500,
    chunksReceived: 12,
    sseLinesParsed: 12,
    commentLines: 1,
    dataEventsYielded: 11,
    sawDoneSentinel: false,
    sawCompletionSignal: false,
    startedAt: "2026-07-25T10:00:00.000Z",
    durationMs: 3200,
    lastChunkAgeMs: 150,
    ...overrides,
  };
}

function makeError(): PrematureStreamEndError {
  const forensics = makeForensics();
  return new PrematureStreamEndError(
    "The response stream ended prematurely: test",
    forensics,
  );
}

const interceptedProbe: TlsProbeResult = {
  ok: true,
  host: "openrouter.ai",
  port: 443,
  durationMs: 120,
  tlsProtocol: "TLSv1.3",
  cipher: "TLS_AES_256_GCM_SHA384",
  authorized: true,
  chain: [
    {
      subject: "CN=openrouter.ai",
      issuer: "CN=Zscaler Intermediate Root CA (zscaler.net), O=Zscaler Inc.",
    },
    {
      subject: "CN=Zscaler Intermediate Root CA (zscaler.net)",
      issuer: "CN=Zscaler Root CA",
    },
  ],
  suspectedInterception: ["Zscaler"],
  proxyUsed: true,
  proxyOrigin: "http://proxy.corp:8080",
};

const cleanProbe: TlsProbeResult = {
  ok: true,
  host: "openrouter.ai",
  port: 443,
  durationMs: 90,
  tlsProtocol: "TLSv1.3",
  authorized: true,
  chain: [
    { subject: "CN=openrouter.ai", issuer: "CN=WE1, O=Google Trust Services" },
    { subject: "CN=WE1", issuer: "CN=GTS Root R4" },
  ],
  suspectedInterception: undefined,
};

describe("buildStreamFailureForensicsRecord", () => {
  it("maps error + probe into a structured record", () => {
    const error = makeError();
    const record = buildStreamFailureForensicsRecord({
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
      apiBase: "https://openrouter.ai/api/v1/",
      requestType: "streamChat",
      error,
      tlsProbe: interceptedProbe,
    });

    expect(record.provider).toBe("openrouter");
    expect(record.model).toBe("moonshotai/kimi-k3");
    expect(record.requestType).toBe("streamChat");
    expect(record.errorName).toBe("PrematureStreamEndError");
    expect(record.streamForensics?.dataEventsYielded).toBe(11);
    expect(record.tlsProbe?.suspectedInterception).toEqual(["Zscaler"]);
    expect(new Date(record.timestamp).getTime()).not.toBeNaN();
  });
});

describe("buildTlsProbeSummary", () => {
  it("calls out TLS interception explicitly", () => {
    const summary = buildTlsProbeSummary(interceptedProbe);
    expect(summary).toContain("TLS INTERCEPTION DETECTED");
    expect(summary).toContain("Zscaler");
    expect(summary).toContain("authorized=true");
    expect(summary).toContain("proxy.corp");
    expect(summary).toContain("openrouter.ai");
  });

  it("notes absence of known vendors", () => {
    const summary = buildTlsProbeSummary(cleanProbe);
    expect(summary).not.toContain("TLS INTERCEPTION DETECTED");
    expect(summary).toContain("No known TLS-inspection vendor");
    expect(summary).toContain("Google Trust Services");
  });

  it("handles probe failures", () => {
    const summary = buildTlsProbeSummary({
      ok: false,
      host: "openrouter.ai",
      port: 443,
      durationMs: 8000,
      error: "TLS probe timed out after 8000ms",
    });
    expect(summary).toContain("failed");
    expect(summary).toContain("timed out");
    expect(summary).toContain("network interference");
  });
});

describe("buildEnrichedErrorMessage", () => {
  it("combines original message, probe summary and log path", () => {
    const msg = buildEnrichedErrorMessage(
      "original error",
      interceptedProbe,
      "/tmp/stream-forensics.jsonl",
    );
    expect(msg).toContain("original error");
    expect(msg).toContain("--- Network forensics ---");
    expect(msg).toContain("TLS INTERCEPTION DETECTED");
    expect(msg).toContain("/tmp/stream-forensics.jsonl");
  });

  it("handles missing probe", () => {
    const msg = buildEnrichedErrorMessage(
      "original error",
      undefined,
      "/tmp/log.jsonl",
    );
    expect(msg).toContain("no apiBase");
  });
});

describe("captureStreamFailureForensics", () => {
  beforeEach(() => {
    mockedProbe.mockResolvedValue(interceptedProbe);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op for non-premature errors", async () => {
    const result = await captureStreamFailureForensics({
      provider: "openrouter",
      model: "m",
      apiBase: "https://openrouter.ai/api/v1/",
      requestType: "streamChat",
      error: new Error("regular failure"),
    });
    expect(result.enrichedMessage).toBeUndefined();
    expect(mockedProbe).not.toHaveBeenCalled();
  });

  it("probes, logs and enriches for premature stream ends", async () => {
    const error = makeError();
    const result = await captureStreamFailureForensics({
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
      apiBase: "https://openrouter.ai/api/v1/",
      requestType: "streamChat",
      error,
    });

    expect(mockedProbe).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/",
      undefined,
    );
    expect(result.enrichedMessage).toContain("TLS INTERCEPTION DETECTED");
    expect(result.enrichedMessage).toContain("stream-forensics.jsonl");

    // Verify the JSONL record was appended to the test CONTINUE_GLOBAL_DIR
    const logPath = getStreamForensicsLogPath();
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record.provider).toBe("openrouter");
    expect(record.model).toBe("moonshotai/kimi-k3");
    expect(record.tlsProbe.suspectedInterception).toEqual(["Zscaler"]);
    expect(record.streamForensics.dataEventsYielded).toBe(11);
  });

  it("survives probe failures", async () => {
    mockedProbe.mockRejectedValue(new Error("probe exploded"));
    const result = await captureStreamFailureForensics({
      provider: "openrouter",
      model: "m",
      apiBase: "https://openrouter.ai/api/v1/",
      requestType: "streamChat",
      error: makeError(),
    });
    expect(result.enrichedMessage).toContain("stream-forensics.jsonl");
  });
});

describe("appendStreamForensicsRecord", () => {
  it("appends JSONL records", async () => {
    const record = buildStreamFailureForensicsRecord({
      provider: "p",
      model: "m",
      requestType: "streamChat",
      error: makeError(),
    });
    await appendStreamForensicsRecord(record);
    await appendStreamForensicsRecord(record);

    const logPath = getStreamForensicsLogPath();
    const lines = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("real isPrematureStreamEndError", () => {
  it("matches duck-typed errors", () => {
    expect(isPrematureStreamEndError(makeError())).toBe(true);
    expect(isPrematureStreamEndError(new Error("x"))).toBe(false);
    expect(isPrematureStreamEndError(undefined)).toBe(false);
  });
});
