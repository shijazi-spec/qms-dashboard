---
name: Public-path justifications are the control of record
description: A PUBLIC_PATHS allowlist justification must describe the handler's REAL authentication, not its intended behavior — verify the claimed control actually exists in code.
---

# Public-path justifications must match the real handler auth

When adding a route to `PUBLIC_PATHS` / `PUBLIC_PATH_ALLOWLIST` (middleware
bypasses session auth for these), the written justification is treated as the
security control of record. The `publicPathsGuard` test only checks that a
justification *exists* — it cannot tell whether the claimed control is real.

**Rule:** Before writing "authenticated via X" (e.g. "Slack signing-secret
signature verification", "fail-closed X-Feed-Key"), open the handler and confirm
X is actually implemented. If it is not, implement it before claiming it.

**Why:** A code review caught a `/webhooks/slack/action` entry justified as
"Slack-signature-verified" while the handler parsed the JSON body and acted on
it with no signature check at all — a spoofable, unauthenticated
workflow-trigger. The justification described intended, not actual, behavior.

**How to apply:**
- Public webhooks that take no session must authenticate the *caller* (HMAC
  signature, shared secret, etc.) and fail closed when the secret is unset.
- For Slack webhooks there is a reusable, replay-protected `verifySlackSignature`
  helper; the consultant-rating handler is the canonical fail-closed precedent
  (503 when `SLACK_SIGNING_SECRET` unset, 401 on bad/absent/stale signature).
- Verify over the RAW request body BEFORE parsing — re-serialized JSON will not
  match Slack's HMAC.
