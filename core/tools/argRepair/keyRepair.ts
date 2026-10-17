// tool-call-repair.md: deterministic key repair. Values are never touched —
// a repair decision is a pure key mapping. The normalization set and the
// distance thresholds are normative and must match the CITT core
// (docs/specifications/tool-call-repair.md in the CITT repo).

import { levenshtein } from "../suggestToolName";

/** Normalize for comparison: lowercase; strip `_ - / .` and whitespace. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-/.\s]+/g, "");
}

/**
 * Edit-distance threshold over normalized keys (normative): distance <= 1
 * for normalized keys of length <= 4, <= 2 for length >= 5. The length of
 * the emitted (unknown) key decides.
 */
function distanceThreshold(normalizedEmittedLength: number): number {
  return normalizedEmittedLength <= 4 ? 1 : 2;
}

export type KeyRepairDecision =
  | { to: string }
  | { declineReason: "no-candidate" | "ambiguous" | "conflict" };

/**
 * Decide a rename for one unknown key against the called tool's schema keys.
 * Normalized exact match first, then Levenshtein within threshold. Renames
 * only on exactly ONE candidate (uniqueness rule) and never onto a key the
 * call already carries (conflict rule). Declines otherwise.
 */
export function decideKeyRepair(
  unknownKey: string,
  schemaKeys: readonly string[],
  presentKeys: ReadonlySet<string>,
): KeyRepairDecision {
  const normalized = normalizeKey(unknownKey);

  // Normalized exact match (covers case/style/slash differences, e.g.
  // content/ -> content, pageId -> page_id, suggestedName -> suggested_name).
  let candidates = schemaKeys.filter((key) => normalizeKey(key) === normalized);

  // Edit-distance fallback over normalized forms (e.g. patth -> path).
  if (candidates.length === 0) {
    const threshold = distanceThreshold(normalized.length);
    candidates = schemaKeys.filter(
      (key) => levenshtein(normalized, normalizeKey(key)) <= threshold,
    );
  }

  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    return { declineReason: "no-candidate" };
  }
  if (unique.length > 1) {
    return { declineReason: "ambiguous" };
  }
  const target = unique[0];
  if (presentKeys.has(target)) {
    return { declineReason: "conflict" };
  }
  return { to: target };
}
