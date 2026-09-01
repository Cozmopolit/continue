// Did-you-mean suggestions for unknown tool call names
// (tool-name-did-you-mean.md).

/** Levenshtein edit distance; classic two-row DP. */
function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        previous[j] + 1, // deletion
        current[j - 1] + 1, // insertion
        substitution,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Suggest known tool names for a misspelled/abbreviated tool call name.
 *
 * Case-insensitive. A candidate qualifies when the (lowercased) input is a
 * true prefix of it or its Levenshtein distance is within
 * max(2, ceil(input.length / 4)). Deterministic: sorted by distance, then
 * name; capped at maxSuggestions. Returns canonical candidate names.
 */
export function suggestToolNames(
  input: string,
  candidates: readonly string[],
  maxSuggestions = 3,
): string[] {
  const loweredInput = input.toLowerCase();
  if (loweredInput.length === 0) {
    return [];
  }
  const maxDistance = Math.max(2, Math.ceil(loweredInput.length / 4));

  const scored: Array<{ name: string; distance: number }> = [];
  for (const candidate of candidates) {
    const loweredCandidate = candidate.toLowerCase();
    const distance = levenshtein(loweredInput, loweredCandidate);
    const isPrefix =
      loweredCandidate.length > loweredInput.length &&
      loweredCandidate.startsWith(loweredInput);
    if (isPrefix || distance <= maxDistance) {
      scored.push({ name: candidate, distance });
    }
  }

  scored.sort(
    (a, b) => a.distance - b.distance || a.name.localeCompare(b.name),
  );
  return scored.slice(0, maxSuggestions).map((s) => s.name);
}

/**
 * Append a did-you-mean hint to a "tool not found" base message.
 * Returns the base message unchanged when there are no suggestions.
 */
export function toolNotFoundMessage(
  baseMessage: string,
  suggestions: string[],
): string {
  if (suggestions.length === 0) {
    return baseMessage;
  }
  const quoted = suggestions.map((s) => `"${s}"`).join(", ");
  const hint =
    suggestions.length === 1
      ? `Did you mean ${quoted}?`
      : `Did you mean one of ${quoted}?`;
  return `${baseMessage}. ${hint}`;
}
