---
name: Zoho field-update DUPLICATE_DATA = duplicate-record problem
description: Why an approved Zoho Email/Phone field edit can show "Executed" yet never change the record
---

# Zoho field update silently rejected → it's a duplicate-record collision

When an AI-approval Zoho field edit (Email/Phone/Mobile) shows "Executed/accepted"
but the record is unchanged ("Last Update" stays old), the cause is almost always
that Zoho enforces **uniqueness** on that field: the value already exists on a
DIFFERENT record, so the write is rejected with `DUPLICATE_DATA`.

**Why:** Zoho's v2 write API returns HTTP 200 even when the per-record op failed —
the real outcome is in `data[0].code`. Old code trusted the 200 and reported
success. The two records are usually duplicates of the same entity (e.g. an
English-name contact and its Arabic-script twin), one already holding the correct
email. Copying the value across is the wrong fix — they must be MERGED.

**How to apply:**
- The honest-status guardrails already exist: `updateZohoRecord` throws on
  per-record non-SUCCESS, and `updateRecordFieldTool` does read-back verification
  (`computeReadBackMismatches` / `fieldValuesMatch`). Never weaken these — "Done"
  must mean a verified change.
- On `DUPLICATE_DATA`, the tool does a best-effort `searchZohoRecords` to name the
  conflicting record and tells the user to merge duplicates rather than retry.
- To diagnose live (read-only, safe): `fetchZohoRecordById(module,id)` for current
  value + `searchZohoRecords(module, "(Email:equals:<value>)")` to find the twin.
  Live writes are gated by `zohoWritesAllowedInEnv()` (prod only) so you cannot
  reproduce the write from dev — diagnose with reads + prod `ai_pending_actions`.
