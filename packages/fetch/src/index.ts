import {
  analyzeHeadersForMiddlebox,
  getFetchDiagnostics,
  maskProxyOrigin,
  MIDDLEBOX_VENDOR_PATTERNS,
  probeTlsIssuer,
  registerFetchDiagnostics,
} from "./diagnostics.js";
import type {
  FetchRequestDiagnostics,
  TlsCertChainEntry,
  TlsProbeResult,
} from "./diagnostics.js";

import {
  collectDiagnosticHeaders,
  detectCompletionSignal,
  formatPrematureStreamEndMessage,
  isPrematureStreamEndError,
  parseDataLine,
  PrematureStreamEndError,
  streamJSON,
  streamResponse,
  streamSse,
  toAsyncIterable,
} from "./stream.js";
import type { StreamForensics, StreamSseOptions } from "./stream.js";

import { fetchwithRequestOptions } from "./fetch.js";
import patchedFetch from "./node-fetch-patch.js";

export {
  analyzeHeadersForMiddlebox,
  collectDiagnosticHeaders,
  detectCompletionSignal,
  fetchwithRequestOptions,
  formatPrematureStreamEndMessage,
  getFetchDiagnostics,
  isPrematureStreamEndError,
  maskProxyOrigin,
  MIDDLEBOX_VENDOR_PATTERNS,
  parseDataLine,
  patchedFetch,
  PrematureStreamEndError,
  probeTlsIssuer,
  registerFetchDiagnostics,
  streamJSON,
  streamResponse,
  streamSse,
  toAsyncIterable,
};

export type {
  FetchRequestDiagnostics,
  StreamForensics,
  StreamSseOptions,
  TlsCertChainEntry,
  TlsProbeResult,
};
