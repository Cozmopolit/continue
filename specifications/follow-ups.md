# Follow-Up Issues for Proxy HTTP Tunneling

This document tracks issues discovered during testing that need to be addressed.

---

## Issue #1: Model Picker Sort Order

**Status:** ✅ Fixed  
**Fix:** `\uFFFF` prefix before `[serverName]` — a noncharacter that `localeCompare()` sorts after all real letters. NBSP (`\u00A0`) was tried first but `localeCompare` ignores it.

## Issue #1b: Model Picker Shows Display Name Instead of Endpoint ID

**Status:** ✅ Fixed  
**Fix:** `mcpProxyModelDiscovery.ts` — use `endpoint.id` in title (not `endpoint.name`) so users can distinguish providers (e.g., `azure-claude-opus` vs `anthropic-claude-opus`).

---

## Issue #2: Endpoint ID vs Model Name Mismatch

**Status:** ✅ Fixed  
**Fix:** `mcpProxyModelDiscovery.ts` — use `endpoint.id` (not `endpoint.model`) so CITT proxy can resolve the target.

---

## Issue #3: Gemini Endpoints Fail (No model in request body)

**Status:** ✅ Fixed  
**Fix:** Add `X-Citt-Endpoint` header to all tunnel requests via `endpointId` option in `createMcpProxyFetch()`. Gemini puts the model in the URL path, not body — the header provides reliable routing for all provider types.

---

## Issue #4: Gemini Streaming via CITT Fails (JSON Array not detected as streaming)

**Status:** 🔴 OPEN — Fix required in CITT, not Continue  
**Details:** See `specifications/citt-gemini-streaming-issue.md`

---

## Issue #5: (Reserved for next finding)

---

## Testing Checklist

After fixes, verify:

- [ ] Manually configured models appear first in picker
- [ ] [CITT] models appear after manual models
- [ ] Alphabetical order within each group
- [ ] No duplicate entries
