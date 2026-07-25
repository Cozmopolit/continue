import { describe, expect, test } from "vitest";
import {
  analyzeHeadersForMiddlebox,
  getFetchDiagnostics,
  maskProxyOrigin,
  registerFetchDiagnostics,
} from "./diagnostics.js";

describe("maskProxyOrigin", () => {
  test("strips credentials and path from a proxy URL", () => {
    expect(maskProxyOrigin("http://user:secret@proxy.corp:8080/pac")).toBe(
      "http://proxy.corp:8080",
    );
  });

  test("keeps default port handling of URL.origin", () => {
    expect(maskProxyOrigin("http://proxy.corp")).toBe("http://proxy.corp");
  });

  test("masks userinfo best-effort for unparseable strings", () => {
    const masked = maskProxyOrigin("proxy.corp:8080");
    expect(masked).toBe("proxy.corp:8080");
    const withCreds = maskProxyOrigin("http://u:p@host:1");
    expect(withCreds).not.toContain("u:p");
    expect(withCreds).toBe("http://host:1");
  });

  test("returns undefined for undefined input", () => {
    expect(maskProxyOrigin(undefined)).toBeUndefined();
  });
});

describe("analyzeHeadersForMiddlebox", () => {
  test("detects via header", () => {
    const findings = analyzeHeadersForMiddlebox({
      via: "1.1 proxy.corp.local",
      server: "cloudflare",
    });
    expect(
      findings.some((f) => f.includes('"via: 1.1 proxy.corp.local"')),
    ).toBe(true);
  });

  test("detects middlebox vendor in server header", () => {
    const findings = analyzeHeadersForMiddlebox({ server: "Zscaler/6.2" });
    expect(findings.some((f) => f.includes("Zscaler"))).toBe(true);
  });

  test("detects vendor in via header", () => {
    const findings = analyzeHeadersForMiddlebox({
      via: "1.1 BlueCoat-ProxySG",
    });
    expect(findings.some((f) => f.includes("Blue Coat"))).toBe(true);
  });

  test("detects squid via header", () => {
    const findings = analyzeHeadersForMiddlebox({
      via: "1.1 squid-proxy (squid/5.7)",
    });
    expect(findings.some((f) => f.toLowerCase().includes("squid"))).toBe(true);
  });

  test("returns empty for clean CDN headers", () => {
    const findings = analyzeHeadersForMiddlebox({
      server: "cloudflare",
      "cf-ray": "9abc-FRA",
      "content-type": "text/event-stream",
    });
    expect(findings).toEqual([]);
  });

  test("returns empty for undefined headers", () => {
    expect(analyzeHeadersForMiddlebox(undefined)).toEqual([]);
  });

  test("deduplicates findings", () => {
    const findings = analyzeHeadersForMiddlebox({
      server: "Zscaler",
      "x-custom": "zscaler zdx",
    });
    expect(new Set(findings).size).toBe(findings.length);
  });
});

describe("fetch diagnostics registry", () => {
  test("registers and retrieves diagnostics for a response object", () => {
    const response = { status: 200 };
    registerFetchDiagnostics(response, {
      url: "https://openrouter.ai/api/v1/chat/completions",
      proxyUsed: true,
      proxyOrigin: "http://proxy.corp:8080",
      bypassedProxy: false,
      at: "2026-07-25T10:00:00.000Z",
    });

    const diag = getFetchDiagnostics(response);
    expect(diag?.proxyUsed).toBe(true);
    expect(diag?.proxyOrigin).toBe("http://proxy.corp:8080");
    expect(diag?.url).toContain("openrouter.ai");
  });

  test("returns undefined for unknown or invalid responses", () => {
    expect(getFetchDiagnostics({})).toBeUndefined();
    expect(getFetchDiagnostics(null)).toBeUndefined();
    expect(getFetchDiagnostics("nope")).toBeUndefined();
  });
});
