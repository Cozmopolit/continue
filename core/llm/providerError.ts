/**
 * Provider error body surfacing (zenith-compaction forensics 2026-08-17).
 *
 * OpenAI-SDK-style `APIError` instances (BadRequestError etc.) carry the
 * parsed provider error body on `.error` and hoist `code`/`type`/`param`
 * onto the instance itself — but the error MESSAGE is only
 * `${status} ${body.message}`, so everything else (moderation codes like
 * `data_inspection_failed`, rate-limit types, param names) is invisible
 * in logs and user-facing alerts unless surfaced explicitly.
 */

const MAX_DETAIL_LENGTH = 400;

function truncate(detail: string): string {
  return detail.length > MAX_DETAIL_LENGTH
    ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…`
    : detail;
}

/**
 * Extracts a compact description of the provider's structured error body
 * from an LLM error. Returns `undefined` when there is nothing to surface:
 * plain errors, errors without a body, and bodies that carry nothing
 * beyond their `message` (the message is already part of the error text —
 * e.g. OpenRouter masking an upstream rejection as generic
 * "Provider returned error" with no code). Never throws.
 */
export function describeProviderErrorBody(e: unknown): string | undefined {
  try {
    if (!e || typeof e !== "object") {
      return undefined;
    }
    const err = e as {
      error?: unknown;
      code?: unknown;
      type?: unknown;
      param?: unknown;
    };

    // String body (some providers return raw text)
    if (typeof err.error === "string") {
      const trimmed = err.error.trim();
      return trimmed ? truncate(trimmed) : undefined;
    }

    // Object body: everything except `message` is additive information
    if (err.error && typeof err.error === "object") {
      const body = err.error as Record<string, unknown>;
      const fields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (key === "message" || value === undefined || value === null) {
          continue;
        }
        fields[key] = value;
      }
      if (Object.keys(fields).length === 0) {
        return undefined;
      }
      return truncate(JSON.stringify(fields));
    }

    // No `.error`, but the SDK hoists structured fields onto the instance
    const hoisted: Record<string, unknown> = {};
    for (const key of ["code", "type", "param"] as const) {
      if (err[key] !== undefined && err[key] !== null) {
        hoisted[key] = err[key];
      }
    }
    if (Object.keys(hoisted).length === 0) {
      return undefined;
    }
    return truncate(JSON.stringify(hoisted));
  } catch {
    return undefined;
  }
}

/**
 * Appends the provider error body detail to the error message when one
 * exists and is not already contained. Mutates in place (the same error
 * object travels to logs and user-facing alerts); no-op otherwise.
 * Never throws.
 */
export function enrichErrorWithProviderBody(e: unknown): void {
  try {
    if (!e || typeof e !== "object") {
      return;
    }
    const err = e as Error;
    if (typeof err.message !== "string") {
      return;
    }
    const detail = describeProviderErrorBody(e);
    if (!detail || err.message.includes(detail)) {
      return;
    }
    err.message = `${err.message} [provider body: ${detail}]`;
  } catch {
    // Enrichment must never break error handling
  }
}
