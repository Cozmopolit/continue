<!-- TEMPLATE FOR SPECIFICATIONS

     When creating a new spec, follow these rules:
     - Language: English preferred, German is fine.
     - Keep it concise. No filler, no verbose explanations.
     - Pseudocode/code only where it clarifies interfaces or non-obvious logic.
     - ASCII diagrams are welcome where they help understanding.
     - A spec starts with a problem/motivation, then adds analysis and solution.
       If you're writing a pure problem description without a solution,
       use dev-docs/technical-debts/ or dev-docs/design-proposals/ instead.
     - Use the sections below as needed. Skip what doesn't fit.
       Small specs don't need every section.
     - Do NOT include this instruction block in new documents.
     - Handing a finished spec to an implementation chat? Attach
       dev-docs/specifications/_IMPLEMENTATION.md as context alongside the spec.

     TESTS ARE A SEPARATE PHASE. Do NOT include test items in specs:
     - No "tests to write" section.
     - No test items in the Implementation Checklist (not even as the last bullet,
       not as "tests am Ende der Implementierung", not in any form).
     - No discussion of test strategy, test scope, or test design in Analysis/Solution.
     Tests are written after the implementation is complete, against the final
     implementation (see _IMPLEMENTATION.md, phase 4). Mentioning tests here
     only distracts from the spec.
-->

# Title

**Status:**
**Date:**

## Problem / Motivation

<!-- What's wrong, or what capability is missing. Concrete examples. -->

## Scope

<!-- What this spec covers. Bullet list of components/changes. -->

**Out of Scope:** <!-- What this spec explicitly does NOT cover. -->

## Analysis

<!-- Current state, constraints, why naive approaches don't work.
     Optional for simple specs — merge into Solution if trivial. -->

## Solution

<!-- Architecture, concept, interface signatures where needed.
     Code blocks only for API contracts, not for implementation details. -->

## Implementation Checklist

<!-- Ordered list of concrete changes: file/component + what to do.
     Can use checkboxes: - [ ] Component: change description -->
