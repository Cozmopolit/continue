// tool-call-repair.md: orchestrator. Single repair pass per tool call:
// classify (raw) -> key repair -> shape normalization. Well-formed calls
// are returned untouched (same reference, no events) — decline semantics
// make today's behavior the worst case by construction.

import { ToolCallRepairEvent } from "../..";
import { decideKeyRepair } from "./keyRepair";
import { deriveParameterDescriptors } from "./parameterDescriptors";

export interface ArgRepairResult {
  /** Same reference as the input when nothing changed. */
  args: Record<string, unknown>;
  events: ToolCallRepairEvent[];
}

const NO_REPAIR_EVENTS: ToolCallRepairEvent[] = [];

export function repairToolCallArgs(
  args: Record<string, unknown>,
  parameters: Record<string, any> | undefined,
): ArgRepairResult {
  const noRepair: ArgRepairResult = { args, events: NO_REPAIR_EVENTS };

  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return noRepair;
  }
  const descriptors = deriveParameterDescriptors(parameters);
  if (descriptors.length === 0) {
    return noRepair;
  }
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return noRepair;
  }
  // Canonicalization re-serializes via JSON.stringify, which drops
  // undefined-valued keys — repairing such args (partial-parse artifacts
  // from streaming) would silently lose values. Untouched, no events
  // (tool-call-repair.md).
  if (entries.some(([, value]) => value === undefined)) {
    return noRepair;
  }

  const byName = new Map(descriptors.map((d) => [d.name, d]));
  const schemaKeys = descriptors.map((d) => d.name);
  const presentKeys = new Set(Object.keys(args));

  // Key repair: each unknown key independently.
  const events: ToolCallRepairEvent[] = [];
  const renames = new Map<string, string>();
  for (const key of presentKeys) {
    if (byName.has(key)) {
      continue;
    }
    const decision = decideKeyRepair(key, schemaKeys, presentKeys);
    if ("to" in decision) {
      renames.set(key, decision.to);
      // Reserve the target: a later unknown key must not rename onto an
      // already-claimed target — Object.fromEntries would silently drop
      // one of the two values. The conflict rule declines it instead,
      // leaving the key (and its value) untouched.
      presentKeys.add(decision.to);
      events.push({ kind: "rename", key, repairedTo: decision.to });
    } else {
      events.push({
        kind: "unknown-key",
        key,
        reason: decision.declineReason,
      });
    }
  }

  // Shape normalization on the post-rename key set. Never split:
  // a scalar for an array-typed parameter is wrapped whole.
  let changed = renames.size > 0;
  const repairedEntries = entries.map(([key, value]): [string, unknown] => {
    const repairedKey = renames.get(key) ?? key;
    const descriptor = byName.get(repairedKey);
    if (!descriptor) {
      return [repairedKey, value];
    }
    if (
      descriptor.shape === "arrayOnly" &&
      !Array.isArray(value) &&
      value !== null // null is the absence of a value, not a shape mismatch
    ) {
      changed = true;
      events.push({ kind: "shape-wrap", key: repairedKey });
      return [repairedKey, [value]];
    }
    if (
      descriptor.shape === "scalarOnly" &&
      Array.isArray(value) &&
      value.length === 1
    ) {
      changed = true;
      events.push({ kind: "shape-unwrap", key: repairedKey });
      return [repairedKey, value[0]];
    }
    return [repairedKey, value];
  });

  return {
    args: changed ? Object.fromEntries(repairedEntries) : args,
    events,
  };
}
