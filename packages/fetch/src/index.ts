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
  createResponseError,
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
import type {
  ResponseError,
  StreamForensics,
  StreamSseOptions,
} from "./stream.js";

import { fetchwithRequestOptions } from "./fetch.js";
import patchedFetch from "./node-fetch-patch.js";

export {
  analyzeHeadersForMiddlebox,
  collectDiagnosticHeaders,
  createResponseError,
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
  ResponseError,
  StreamForensics,
  StreamSseOptions,
  TlsCertChainEntry,
  TlsProbeResult,
};
