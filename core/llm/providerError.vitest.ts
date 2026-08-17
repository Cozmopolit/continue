import { describe, expect, it } from "vitest";

import {
  describeProviderErrorBody,
  enrichErrorWithProviderBody,
} from "./providerError.js";

describe("describeProviderErrorBody", () => {
  describe("inputs without anything to surface", () => {
    it("returns undefined for undefined, null and primitives", () => {
      expect(describeProviderErrorBody(undefined)).toBeUndefined();
      expect(describeProviderErrorBody(null)).toBeUndefined();
      expect(describeProviderErrorBody("boom")).toBeUndefined();
      expect(describeProviderErrorBody(42)).toBeUndefined();
      expect(describeProviderErrorBody(true)).toBeUndefined();
    });

    it("returns undefined for a plain Error", () => {
      expect(
        describeProviderErrorBody(new Error("400 Bad Request")),
      ).toBeUndefined();
    });

    it("returns undefined for an Error whose message is the raw SSE data line (variant 2)", () => {
      // Mid-stream moderation rejections surface as plain errors whose
      // message already IS the provider body — no `.error` property.
      const e = new Error(
        'data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}',
      );
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("returns undefined when the body carries nothing beyond its message (OpenRouter masking case)", () => {
      const e = Object.assign(new Error("400 Provider returned error"), {
        status: 400,
        error: { message: "Provider returned error" },
      });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("returns undefined for an empty body object", () => {
      const e = Object.assign(new Error("400"), { error: {} });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("returns undefined when body fields are only undefined/null", () => {
      const e = Object.assign(new Error("400"), {
        error: { message: "x", code: null, type: undefined, param: null },
      });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("returns undefined for a whitespace-only string body", () => {
      const e = Object.assign(new Error("400"), { error: "   " });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("returns undefined when only null/undefined fields are hoisted", () => {
      const e = Object.assign(new Error("400"), {
        code: null,
        type: undefined,
        param: null,
      });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });
  });

  describe("structured bodies", () => {
    it("extracts code/type/param from a body object, excluding message", () => {
      const e = Object.assign(
        new Error("400 Input data may contain inappropriate content"),
        {
          status: 400,
          error: {
            code: "data_inspection_failed",
            type: "data_inspection_failed",
            param: null,
            message: "Input text data may contain inappropriate content.",
          },
        },
      );
      const detail = describeProviderErrorBody(e);
      expect(detail).toBe(
        JSON.stringify({
          code: "data_inspection_failed",
          type: "data_inspection_failed",
        }),
      );
      expect(detail).not.toContain("message");
    });

    it("keeps additional unknown body fields", () => {
      const e = Object.assign(new Error("400"), {
        error: { code: "rate_limited", retry_after: 30 },
      });
      expect(describeProviderErrorBody(e)).toBe(
        JSON.stringify({ code: "rate_limited", retry_after: 30 }),
      );
    });

    it("serializes nested body values", () => {
      const e = Object.assign(new Error("400"), {
        error: { code: "x", details: { nested: true } },
      });
      expect(describeProviderErrorBody(e)).toBe(
        JSON.stringify({ code: "x", details: { nested: true } }),
      );
    });

    it("returns a trimmed string body as-is", () => {
      const e = Object.assign(new Error("400"), {
        error: "  upstream exploded  ",
      });
      expect(describeProviderErrorBody(e)).toBe("upstream exploded");
    });

    it("falls back to hoisted code/type/param when there is no body", () => {
      const e = Object.assign(new Error("429 Too Many Requests"), {
        code: "rate_limit_exceeded",
        type: "requests",
        param: undefined,
      });
      expect(describeProviderErrorBody(e)).toBe(
        JSON.stringify({ code: "rate_limit_exceeded", type: "requests" }),
      );
    });

    it("prefers the body over hoisted fields", () => {
      const e = Object.assign(new Error("400"), {
        error: { code: "from_body" },
        code: "hoisted",
        type: "hoisted",
      });
      expect(describeProviderErrorBody(e)).toBe(
        JSON.stringify({ code: "from_body" }),
      );
    });
  });

  describe("truncation", () => {
    it("does not truncate at exactly 400 characters", () => {
      const long = "x".repeat(400);
      const e = Object.assign(new Error("400"), { error: long });
      expect(describeProviderErrorBody(e)).toBe(long);
    });

    it("truncates above 400 characters with an ellipsis", () => {
      const long = "y".repeat(401);
      const e = Object.assign(new Error("400"), { error: long });
      const detail = describeProviderErrorBody(e);
      expect(detail).toHaveLength(401); // 400 chars + ellipsis
      expect(detail!.endsWith("…")).toBe(true);
    });
  });

  describe("robustness", () => {
    it("never throws on circular body structures", () => {
      const circular: Record<string, unknown> = { code: "loop" };
      circular.self = circular;
      const e = Object.assign(new Error("400"), { error: circular });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });

    it("never throws when a property access throws", () => {
      const e = Object.assign(new Error("400"), {});
      Object.defineProperty(e, "error", {
        enumerable: true,
        get() {
          throw new Error("trap");
        },
      });
      expect(describeProviderErrorBody(e)).toBeUndefined();
    });
  });
});

describe("enrichErrorWithProviderBody", () => {
  it("appends the provider body detail to the message", () => {
    const e = Object.assign(new Error("400 Input data rejected"), {
      status: 400,
      error: { code: "data_inspection_failed", type: "data_inspection_failed" },
    });
    enrichErrorWithProviderBody(e);
    expect(e.message).toBe(
      '400 Input data rejected [provider body: {"code":"data_inspection_failed","type":"data_inspection_failed"}]',
    );
  });

  it("leaves the OpenRouter masking case untouched (body adds no information)", () => {
    const e = Object.assign(new Error("400 Provider returned error"), {
      status: 400,
      error: { message: "Provider returned error" },
    });
    enrichErrorWithProviderBody(e);
    expect(e.message).toBe("400 Provider returned error");
  });

  it("leaves plain errors untouched", () => {
    const e = new Error("something broke");
    enrichErrorWithProviderBody(e);
    expect(e.message).toBe("something broke");
  });

  it("is idempotent — a second call does not duplicate the detail", () => {
    const e = Object.assign(new Error("400 nope"), {
      error: { code: "overloaded" },
    });
    enrichErrorWithProviderBody(e);
    const once = e.message;
    enrichErrorWithProviderBody(e);
    expect(e.message).toBe(once);
  });

  it("enriches from hoisted fields without a body", () => {
    const e = Object.assign(new Error("429 slow down"), {
      code: "rate_limited",
    });
    enrichErrorWithProviderBody(e);
    expect(e.message).toBe(
      '429 slow down [provider body: {"code":"rate_limited"}]',
    );
  });

  it("is a no-op for non-objects and objects without a message (never throws)", () => {
    expect(() => enrichErrorWithProviderBody(undefined)).not.toThrow();
    expect(() => enrichErrorWithProviderBody(null)).not.toThrow();
    expect(() => enrichErrorWithProviderBody("plain string")).not.toThrow();
    expect(() =>
      enrichErrorWithProviderBody({ error: { code: "x" } }),
    ).not.toThrow();
    const noMessage = { message: 5, error: { code: "x" } };
    expect(() => enrichErrorWithProviderBody(noMessage)).not.toThrow();
  });
});
