// tool-call-repair.md: one pure derivation from a tool's JSON Schema
// (tool.function.parameters). MCP schemas arrive verbatim via
// doLoadConfig, built-ins carry their own — one abstraction serves both.

export interface ParameterDescriptor {
  name: string;
  required: boolean;
  shape: ShapeExpectation;
}

/**
 * Shape actions require an unambiguous schema (tool-call-repair.md):
 * "arrayOnly" only when arrays are the exclusive expected shape
 * (`type: "array"`, or a union of "array" with only "null" — null is the
 * absence of a value, not a scalar shape); "scalarOnly" only on an
 * explicit non-array type; everything else (no `type`, unions permitting
 * both array and scalar shapes) is ambiguous and gets no shape action.
 */
export type ShapeExpectation = "arrayOnly" | "scalarOnly" | "ambiguous";

function schemaShapeExpectation(propSchema: unknown): ShapeExpectation {
  const type = (propSchema as { type?: unknown } | null)?.type;
  if (typeof type === "string") {
    return type === "array" ? "arrayOnly" : "scalarOnly";
  }
  if (Array.isArray(type) && type.length > 0) {
    const hasArray = type.includes("array");
    const hasScalar = type.some((t) => t !== "array" && t !== "null");
    if (hasArray) {
      return hasScalar ? "ambiguous" : "arrayOnly";
    }
    return "scalarOnly";
  }
  return "ambiguous";
}

export function deriveParameterDescriptors(
  parameters: Record<string, any> | undefined,
): ParameterDescriptor[] {
  const properties = parameters?.properties;
  if (!properties || typeof properties !== "object") {
    return [];
  }
  const rawRequired: unknown = parameters?.required;
  const requiredSet = new Set<string>(
    Array.isArray(rawRequired)
      ? rawRequired.filter((r): r is string => typeof r === "string")
      : [],
  );
  return Object.keys(properties).map((name) => ({
    name,
    required: requiredSet.has(name),
    shape: schemaShapeExpectation(properties[name]),
  }));
}
