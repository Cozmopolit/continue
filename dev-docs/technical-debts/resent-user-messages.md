# Resent / duplicated user messages without user action

**Status:** Open
**Date:** 2026-08-14

## Problem

User messages occasionally appear to be **resent or duplicated** in a chat
session without any user action: the user sends a message once, does NOT
resend it, yet the message turns up again (e.g. in the run/session state
behind the scenes), while the **GUI shows no visible indication** of the
duplicate — no second message bubble, no hint that a resend happened.

This is a recurring phenomenon ("das passiert uns auch häufig"), not a
one-off. It was observed again during the 2026-08-14 hung-chat incident
work, where runs were repeatedly aborted mid-flight: after an aborted run,
message state surfaced that did not correspond to anything the user had
actually sent.

## Analysis

None yet — deliberately deferred. The symptom is described here so it stops
being invisible. Open questions for a future investigation:

- Does the duplication live in session-history persistence, in the
  abort/retry flow of the stream thunks, or in the webview↔core messenger
  layer?
- Is it correlated with aborted/interrupted runs (cancel during streaming),
  window reloads, or session continuation after reload?
- Does the duplicated message actually reach the model (double context),
  or is it only a state/persistence artifact?

## Affected Areas

Unknown until analyzed. Suspect vicinity (not verified):
`gui/src/redux/thunks/streamNormalInput.ts` and the session-history
persistence path, webview↔core request/response matching.
