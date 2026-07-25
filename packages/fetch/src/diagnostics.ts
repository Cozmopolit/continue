import { RequestOptions } from "@continuedev/config-types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import * as https from "node:https";
import type { TLSSocket } from "node:tls";
import { getAgentOptions } from "./getAgentOptions.js";
import { getProxy, shouldBypassProxy } from "./util.js";

/**
 * Network diagnostics captured at fetch time, attached to the Response via
 * a WeakMap so stream-level code (streamSse) can include proxy information
 * in premature-end forensics without changing function signatures
 * everywhere.
 */
export interface FetchRequestDiagnostics {
  /** origin + pathname (no query string — may contain secrets) */
  url: string;
  proxyUsed: boolean;
  /** credentials-masked proxy origin, e.g. "http://proxy.corp:8080" */
  proxyOrigin?: string;
  bypassedProxy: boolean;
  at: string;
}

const diagnosticsMap = new WeakMap<object, FetchRequestDiagnostics>();

export function registerFetchDiagnostics(
  response: unknown,
  diagnostics: FetchRequestDiagnostics,
): void {
  if (typeof response === "object" && response !== null) {
    diagnosticsMap.set(response as object, diagnostics);
  }
}

export function getFetchDiagnostics(
  response: unknown,
): FetchRequestDiagnostics | undefined {
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  return diagnosticsMap.get(response as object);
}

/**
 * Masks credentials in a proxy URL. Returns origin only
 * (e.g. "http://proxy.corp:8080") or the raw string if unparseable
 * (truncated, credentials stripped best-effort).
 */
export function maskProxyOrigin(proxy: string | undefined): string | undefined {
  if (!proxy) {
    return undefined;
  }
  try {
    const url = new URL(proxy);
    // "null" origin happens for scheme-less strings like "proxy.corp:8080"
    // (parsed as an opaque custom scheme) — fall through to manual masking.
    if (url.origin !== "null") {
      return url.origin;
    }
  } catch {
    // fall through to manual masking
  }
  // Strip userinfo best-effort: scheme://user:pass@host:port
  return proxy.replace(/(\/\/)([^/@]*@)/, "$1***@").slice(0, 120);
}

/**
 * Well-known TLS-inspecting middlebox vendors/products. Matched (case
 * insensitive) against response header values and TLS certificate
 * subject/issuer names.
 */
export const MIDDLEBOX_VENDOR_PATTERNS: Array<{
  vendor: string;
  pattern: RegExp;
}> = [
  { vendor: "Zscaler", pattern: /zscaler|zscalergov|zdx/i },
  { vendor: "Netskope", pattern: /netskope/i },
  { vendor: "Palo Alto Networks", pattern: /palo\s?alto|panw|globalprotect/i },
  {
    vendor: "Blue Coat / Symantec / Broadcom",
    pattern: /blue\s?coat|proxysg|symantec|broadcom/i,
  },
  { vendor: "Forcepoint", pattern: /forcepoint|websense/i },
  { vendor: "Check Point", pattern: /check\s?point|checkpoint/i },
  { vendor: "Fortinet", pattern: /fortinet|fortigate|fortica/i },
  { vendor: "Sophos", pattern: /sophos/i },
  { vendor: "McAfee / Trellix", pattern: /mcafee|trellix|skyhigh/i },
  { vendor: "Barracuda", pattern: /barracuda/i },
  { vendor: "WatchGuard", pattern: /watchguard/i },
  { vendor: "Cisco", pattern: /cisco|umbrella|ironport/i },
  { vendor: "SonicWall", pattern: /sonicwall/i },
  { vendor: "Menlo Security", pattern: /menlo/i },
  { vendor: "iboss", pattern: /iboss/i },
  { vendor: "Squid (proxy)", pattern: /squid/i },
];

function matchVendors(value: string): string[] {
  const matches: string[] = [];
  for (const { vendor, pattern } of MIDDLEBOX_VENDOR_PATTERNS) {
    if (pattern.test(value)) {
      matches.push(vendor);
    }
  }
  return matches;
}

/** Header keys that by themselves indicate a proxy in the path. */
const PROXY_INDICATOR_HEADER_KEYS = [
  "via",
  "x-cache",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-proxy",
  "x-bluecoat-via",
  "x-zscaler",
  "x-netskope",
  "x-barracuda-",
  "x-squid-",
  "proxy-authenticate",
];

/**
 * Heuristically analyzes response headers for signs of a middlebox
 * (explicit proxy headers, vendor strings). Returns human-readable
 * findings, empty when nothing suspicious was found.
 */
export function analyzeHeadersForMiddlebox(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) {
    return [];
  }
  const findings: string[] = [];
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }

  for (const [key, value] of Object.entries(lower)) {
    const isIndicatorKey =
      PROXY_INDICATOR_HEADER_KEYS.some((p) => key.startsWith(p)) ||
      key.startsWith("x-z");
    if (isIndicatorKey) {
      findings.push(`proxy-indicating header "${key}: ${value}"`);
    }
    if (key === "server" || key === "via" || key.startsWith("x-")) {
      for (const vendor of matchVendors(value)) {
        findings.push(
          `middlebox vendor "${vendor}" in header "${key}: ${value}"`,
        );
      }
    }
  }
  return [...new Set(findings)];
}

export interface TlsCertChainEntry {
  subject: string;
  issuer: string;
  validFrom?: string;
  validTo?: string;
}

export interface TlsProbeResult {
  ok: boolean;
  host: string;
  port: number;
  durationMs: number;
  tlsProtocol?: string;
  cipher?: string;
  /** certificate chain presented by the peer (leaf first) */
  chain?: TlsCertChainEntry[];
  authorized?: boolean;
  authorizationError?: string;
  /** vendors detected in the certificate chain (TLS interception hint) */
  suspectedInterception?: string[];
  proxyUsed?: boolean;
  proxyOrigin?: string;
  error?: string;
}

function formatCertName(name: Record<string, unknown> | undefined): string {
  if (!name) {
    return "<unknown>";
  }
  const parts: string[] = [];
  for (const key of ["CN", "O", "OU", "C"]) {
    const v = (name as any)[key];
    if (v) {
      parts.push(`${key}=${Array.isArray(v) ? v.join("+") : v}`);
    }
  }
  if (parts.length === 0) {
    try {
      return String(name);
    } catch {
      return "<unparseable>";
    }
  }
  return parts.join(", ");
}

/**
 * Performs a one-off TLS handshake against the given URL's host (through
 * the configured proxy, if any) and reports the presented certificate
 * chain. This is the definitive test for TLS interception: if the issuer
 * chain belongs to a corporate CA / middlebox vendor instead of a public
 * CA, HTTPS traffic is being inspected (and potentially tampered with).
 *
 * Never throws — all failures are reported via `error`.
 */
export async function probeTlsIssuer(
  url_: string | URL,
  requestOptions?: RequestOptions,
  timeoutMs: number = 8000,
): Promise<TlsProbeResult> {
  const startedAt = Date.now();
  let url: URL;
  try {
    url = typeof url_ === "string" ? new URL(url_) : url_;
  } catch {
    return {
      ok: false,
      host: "",
      port: 0,
      durationMs: Date.now() - startedAt,
      error: `Invalid URL: ${String(url_)}`,
    };
  }
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : 443;

  if (url.protocol !== "https:") {
    return {
      ok: false,
      host,
      port,
      durationMs: Date.now() - startedAt,
      error: `TLS probe only supports https URLs (got ${url.protocol})`,
    };
  }

  const proxy = getProxy(url.protocol, requestOptions);
  const bypass = shouldBypassProxy(host, requestOptions);
  const proxyUsed = !!proxy && !bypass;

  try {
    const agentOptions = await getAgentOptions(requestOptions);
    const agent = proxyUsed
      ? new HttpsProxyAgent(proxy!, agentOptions)
      : new https.Agent(agentOptions);

    return await new Promise<TlsProbeResult>((resolve) => {
      const finish = (
        result: Omit<
          TlsProbeResult,
          "host" | "port" | "durationMs" | "proxyUsed" | "proxyOrigin"
        >,
      ) => {
        resolve({
          host,
          port,
          durationMs: Date.now() - startedAt,
          proxyUsed,
          proxyOrigin: proxyUsed ? maskProxyOrigin(proxy) : undefined,
          ...result,
        });
      };

      const req = https.request(
        {
          host,
          port,
          path: "/",
          method: "HEAD",
          agent,
          servername: host,
        },
        (res) => {
          try {
            const socket = res.socket as TLSSocket;
            const cert = socket.getPeerCertificate(true) as any;
            const chain: TlsCertChainEntry[] = [];
            let current = cert;
            const seen = new Set<string>();
            while (current && current.subject) {
              const fingerprint = current.fingerprint256 ?? current.fingerprint;
              if (fingerprint && seen.has(fingerprint)) {
                break;
              }
              if (fingerprint) {
                seen.add(fingerprint);
              }
              chain.push({
                subject: formatCertName(current.subject),
                issuer: formatCertName(current.issuer),
                validFrom: current.valid_from,
                validTo: current.valid_to,
              });
              if (
                !current.issuerCertificate ||
                current.issuerCertificate === current
              ) {
                break;
              }
              current = current.issuerCertificate;
            }

            const suspected = new Set<string>();
            for (const entry of chain) {
              for (const vendor of matchVendors(
                `${entry.subject} ${entry.issuer}`,
              )) {
                suspected.add(vendor);
              }
            }

            finish({
              ok: true,
              tlsProtocol: socket.getProtocol?.() ?? undefined,
              cipher: socket.getCipher?.()?.name ?? undefined,
              chain,
              authorized: socket.authorized,
              authorizationError: socket.authorizationError
                ? String(socket.authorizationError)
                : undefined,
              suspectedInterception:
                suspected.size > 0 ? [...suspected] : undefined,
            });
          } catch (e) {
            finish({
              ok: false,
              error: `Failed to read peer certificate: ${(e as Error)?.message ?? String(e)}`,
            });
          } finally {
            res.resume();
            req.destroy();
          }
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`TLS probe timed out after ${timeoutMs}ms`));
      });
      req.on("error", (e) => {
        finish({ ok: false, error: e.message });
      });
      req.end();
    });
  } catch (e) {
    return {
      ok: false,
      host,
      port,
      durationMs: Date.now() - startedAt,
      proxyUsed,
      proxyOrigin: proxyUsed ? maskProxyOrigin(proxy) : undefined,
      error: (e as Error)?.message ?? String(e),
    };
  }
}
