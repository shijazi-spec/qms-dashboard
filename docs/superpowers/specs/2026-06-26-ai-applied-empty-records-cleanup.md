# AI-Applied Empty-Records Cleanup + Deletion Lifecycle — Design

**Date:** 2026-06-26
**Owner:** Ahmad Amashah (with Adam — GRQ Assistant)
**Status:** Approved design, pending implementation plan

## Goal

Let the operator clean up genuinely-empty CRM records (Contacts / Accounts / Deals)
in the **Empty / Orphaned** tab with **one click per module** instead of working
through ~500 rows by hand, and then **track whether the Zoho admin has actually
deleted** the tagged records. The platform still never deletes anything itself —
it only tags `Empty-Delete`; the admin is the final gate.

This builds on existing machinery: the `empty_delete_ledger`, the per-record Zoho
write-status check, the `classifyContact/Account/Deal` classifiers, and the
"AI-Applied · pending Zoho admin delete → reconcile" lifecycle already used by the
merge flow.

## Non-goals (YAGNI)

- **No fully-autonomous/scheduled tagging.** The operator chose one-click-per-module
  (option A). A human triggers each run; the agent then applies. We are NOT wiring
  this into the autonomous-resolution cron.
- No deletion FROM the platform. We tag only; the Zoho admin deletes.
- No change to the duplicate-merge flow.

## 1. "Empty" criteria (per module)

A record is eligible to be tagged `Empty-Delete` only when **all** conditions hold:

| Module | Empty when |
|---|---|
| **Contacts** | no phone/mobile · no email · no Account · no linked Deal *(= today's "name-only")* |
| **Accounts** | no Deals reference it · no Contacts reference it · no email · **no attachments (documents)** |
| **Deals** | no Account · no Contact · no attachments · stage **NOT** in {Agreement Signed, Paid} |

Notes:
- For Deals, **Agreement Signed** and **Paid** are the tenant's only existing-client
  stages, so they are the only protected stages — a deal in either is never tagged,
  even if missing other data.
- "no attachments" requires a **live Zoho fetch** (Accounts + Deals). Contacts need
  no attachment fetch.
- Account "no email" = the account record carries no email-field value (the tenant's
  Accounts layout may have a custom email field); when the layout has no email field
  at all, this condition is trivially satisfied and "no Contacts" is the operative
  identity check. The classifier reads `raw_data.Email` (and common variants) if present.

## 2. One-click AI-Apply (bulk, per module)

A **"🤖 AI-Apply empty → Empty-Delete (Adam)"** button on each section header.

Flow on click (admin-gated, confirmation showing the candidate count):

For each candidate in the module's empty list (capped/paced — see below):
1. **Verify-live** — confirm the record still exists in Zoho (fetch by id; for
   Accounts/Deals the attachment fetch doubles as this check).
2. **Ghost prune** — if Zoho returns *record-not-found* or `INVALID_DATA — "the
   related id given seems to be invalid"`, the record is **already deleted**:
   remove it from `duplicate_records` (the local mirror) and skip. No error shown.
3. **Attachment check** (Accounts/Deals) — if any attachment exists, the record has
   real documents → **not empty** → skip (leave it on the list, not tagged).
4. **Tag** — the genuinely-empty, still-live records get `Empty-Delete` via
   `addZohoTags` (batched ≤100), each result's per-record write status checked.
   Recorded in `empty_delete_ledger` with `status='pending_delete'`, `tagged_by`
   = the Adam attribution string (`AGENT_PERFORMED_BY`).

**Result line:** e.g. *"Tagged 312 · pruned 41 ghosts · skipped 7 (had documents)."*
**Undo:** the existing untag path removes the tag + ledger row.

**Pacing / cap:** Accounts and Deals require one Zoho attachment call per candidate,
so a single AI-Apply run processes **up to a bounded N** (env `EMPTY_AI_APPLY_BATCH`,
default 150) with a progress indicator; the operator clicks again for the next
batch. Contacts need no per-record Zoho call and can process the full capped set fast.

## 3. Ghost auto-prune (everywhere)

The same "record deleted in Zoho → prune from the Radar" behavior applies to the
**per-row "Check attachments"** button too: instead of surfacing the red
`INVALID_DATA` error, a deleted account is pruned on the spot and the row disappears.
Trigger = Zoho not-found / `INVALID_DATA "related id ... invalid"` on a by-id or
attachments fetch.

## 4. Deletion lifecycle — "Tagged · pending delete" sub-section

A new sub-section inside the Empty / Orphaned tab listing records the agent (or
operator) tagged `Empty-Delete`, each with:
- **Status:** `Pending` (still present in Zoho) or `Deleted ✓` (admin removed it).
- **Progress count:** e.g. *"312 tagged · 250 deleted · 62 pending."*

**Reconcile (option C):**
- **Automatic** on every CRM sync — a pass checks each `pending_delete` record's
  existence in Zoho; gone → set `status='deleted'`, `deleted_at`.
- **Manual "Re-check CRM"** button for on-demand verification.

Reuses the existing pending→reconcile machinery (analogous to
`reconcileAutoMergedContactDeletions`).

## 5. Data model

Extend `empty_delete_ledger` (added to the canonical CREATE TABLE — schema-parity
safe; every ALTER also reflected in CREATE):
- `status VARCHAR(16) NOT NULL DEFAULT 'pending_delete'`  — `pending_delete` | `deleted`
- `deleted_at TIMESTAMP NULL`
- `last_checked_at TIMESTAMP NULL`

(Existing columns: `zoho_record_id`, `module`, `tagged_by`, `created_at`.)

## 6. Build surface

**Backend**
- Refine `classifyContact/Account/Deal` (`emptyRecordsDetection.ts`) to the exact
  rules above + unit tests (incl. Deal stage protection).
- `aiApplyEmptyDelete(module, { limit })` in `emptyRecordsDatabase.ts` —
  verify-live → ghost-prune → attachment-check → tag → ledger. Returns
  `{ tagged, prunedGhosts, skippedWithDocs }`.
- `reconcileEmptyDeleteDeletions()` — check `pending_delete` records' existence,
  mark `deleted`. Hooked into the sync flow + the manual button.
- Helper to remove a ghost from the mirror (`removeRecordsByZohoIds` exists).
- Endpoints (admin-gated):
  - `POST /api/duplicates/empty-records/ai-apply` `{ module, limit? }`
  - `GET  /api/duplicates/empty-records/tagged-status` `?module=` → list + counts
  - `POST /api/duplicates/empty-records/recheck-deletions` `{ module? }`

**Frontend** (`dashboard/js/duplicates-app.js`, `dashboard/duplicates.html`)
- Per-section **"🤖 AI-Apply empty"** button with confirm + progress + result line.
- Per-row "Check attachments" prunes ghosts on `INVALID_DATA`/not-found.
- New **"Tagged · pending delete"** sub-section: rows with Pending/Deleted ✓,
  progress count, **Re-check CRM** button.
- i18n (en + ar) for new labels. Bump `duplicates-app.js?v=`.

## 7. Safety

- Verify-live + attachment check before any tag → no ghosts, no real-data accounts.
- Deal customer-stage protection (Agreement Signed / Paid never tagged).
- **Platform never deletes** — tags only; Zoho admin is the final gate.
- Undo + Dismiss remain as safety nets.
- Bounded/paced runs; per-record write-status checked; admin-gated endpoints.

## 8. Testing

- Unit tests (tsx harness / vitest) for the three refined classifiers, incl. the
  Deal stage-protection and the Account "documents" rule.
- Unit/logic test for the ghost-prune signal mapping (not-found / INVALID_DATA →
  prune) and the `aiApplyEmptyDelete` result accounting (tagged/pruned/skipped).
- Gates: `tsc`, tests-tsc, `check-schema-parity --strict` (new columns),
  `check-dashboard-html-js`, `node --check` on the JS.

## 9. Rollout

Code-only; deploy via the now-working publish pipeline. No destructive migration
(IF NOT EXISTS table already present; ALTERs are additive).
