/**
 * Attempts to pretty-print a string whose entire content is a JSON object
 * or array.
 *
 * Returns the formatted JSON (2-space indent), or `undefined` when the
 * content is not parseable JSON or not an object/array (plain text,
 * numbers, booleans, etc. are left untouched). Never throws.
 */
export function tryPrettyPrintJson(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * Ensures a virtual file name ends with `.json` so VS Code applies JSON
 * syntax highlighting and code folding. Names that already carry the
 * extension (any casing) are returned unchanged.
 */
export function withJsonExtension(name: string): string {
  return name.toLowerCase().endsWith(".json") ? name : `${name}.json`;
}
