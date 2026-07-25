import { vi } from "vitest";

export const fetchwithRequestOptions = vi.fn(
  async (url, options, requestOptions) => {
    console.log("Mocked fetch called with:", url, options, requestOptions);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
    };
  },
);

export const streamSse = vi.fn(function* () {
  yield "";
});

export class PrematureStreamEndError extends Error {
  readonly name = "PrematureStreamEndError";
  forensics: any;
  constructor(message: string, forensics: any) {
    super(message);
    this.forensics = forensics;
  }
}

export const isPrematureStreamEndError = vi.fn(
  (e: unknown): boolean =>
    e instanceof Error &&
    e.name === "PrematureStreamEndError" &&
    typeof (e as any).forensics === "object" &&
    (e as any).forensics !== null,
);

export const probeTlsIssuer = vi.fn(async () => ({
  ok: false,
  host: "mock",
  port: 443,
  durationMs: 1,
  error: "mocked probe",
}));

export const getFetchDiagnostics = vi.fn(() => undefined);

export const registerFetchDiagnostics = vi.fn();

export const analyzeHeadersForMiddlebox = vi.fn(() => []);

export const maskProxyOrigin = vi.fn((proxy?: string) => proxy);

export const streamJSON = vi.fn(async function* () {});

export const streamResponse = vi.fn(async function* () {});

export const toAsyncIterable = vi.fn(async function* () {});
