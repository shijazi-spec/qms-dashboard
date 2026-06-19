---
name: Zoho write read-back verification
description: Zoho CRM v2 write API returns code:SUCCESS even when a field is not persisted — confirm writes by re-reading before reporting success
---

# Zoho writes must be read-back verified

**Rule:** A Zoho CRM v2 record-update returning HTTP 200 + `code:SUCCESS` is NOT
proof the field actually changed. Zoho can report SUCCESS while silently failing to
persist a field when:
- the API connection's profile lacks field-level edit permission,
- a validation rule / workflow reverts the value, or
- the write is a no-op.

So any path that writes a Zoho field and then reports an outcome to a human (e.g. the
AI-approval queue marking a card "Executed/Done") must re-read the record from Zoho's
real-time single-record endpoint and confirm each updated field holds the requested
value before claiming success.

**Why:** A user approved an AI Approval to change a Contact's Email; the card showed
"Executed/Done" and the DB row was `status=executed, success=true`, yet the Zoho email
never changed. The write trusted Zoho's SUCCESS with no verification, producing a false
"done". In this app, the approval pipeline sets `status=executed` ONLY when the tool
returns `success:true`, so a tool that over-reports success directly creates the
"approved but nothing happened" disconnect.

**How to apply:**
- After the write, GET the record back and compare field-by-field. Mismatch →
  `success:false` (recorded as FAILED, not Executed) with the actual stored value and
  an actionable reason (usually field-level permission / validation rule).
- If the read-back itself fails (transient), do NOT claim Executed — return
  `success:false` with `error:"verification_unavailable"`; the write is idempotent so
  re-approving is safe.
- Comparison leniency must match Zoho normalization (trim, case-insensitive for
  email/URL) but digit-only phone equivalence must be gated to phone/mobile field names
  — applying it to arbitrary numeric fields lets a non-persisted value pass.
- Confine read-back to scalar-field tools (e.g. update-record-field). Do NOT bolt it
  onto the shared low-level `updateZohoRecord`, which is also used by merge/link paths
  that write lookups/objects needing different verification semantics.
