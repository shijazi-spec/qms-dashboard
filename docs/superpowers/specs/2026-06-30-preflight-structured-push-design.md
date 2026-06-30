# Preflight Structured Push to Zoho — Design

**Date:** 2026-06-30
**Owner:** Ahmad Amashah (with Adam — GRQ Assistant)
**Status:** Approved design, pending implementation plan

## Goal

Today the Preflight Check tab has ONE push action: create a Zoho **Lead** per PASS
row. Ahmad wants four *structured* push actions so the cleared rows land in the CRM
as the right record shape — re-engagement deals for churned clients, deals + contacts
for multi-contact companies, the full Account→Deal→Contact structure for new
companies, and plain Leads — each with its own button, a live count of what it will
push, dry-run-first preview, and dedup safety so nothing duplicates in Zoho.

## Deal target (all deal-creating actions)

Every Deal created by actions 1–3 is written into:

- **Layout:** `WalaPlus` (`layout_id = 5146753000000019023`)
- **Pipeline:** `Standard (Corporates)`
- **Stage:** `New Deal`
- **Closing Date:** intentionally **left blank** — the sales agent sets it when they
  pick up the deal. **Dependency:** the WalaPlus Deals layout must allow Closing_Date
  to be empty on create. If Zoho rejects a create for a mandatory Closing_Date, that
  record is reported as a per-record failure (not silently dropped) and we either make
  the field optional in Zoho or revisit. This is the one external dependency.
- **Amount:** blank (0/unset) — sales fills later.
- **Deal Name:** `<Company> — <action tag>` (e.g. "… — Re-engagement", "… — Preflight import").

These four (layout id, pipeline name, stage, deal-name pattern) are **env-overridable**
constants (`PREFLIGHT_DEAL_LAYOUT_ID`, `PREFLIGHT_DEAL_PIPELINE`, `PREFLIGHT_DEAL_STAGE`)
defaulting to the values above. Pipeline is resolved/sent by name unless a pipeline id
is configured.

## Lead target (action 4)

Leads created by action 4 are written into:

- **Layout:** `WalaPlus` (`layout_id = 5146753000000091055`)
- **Lead Status:** `New Lead`

Env-overridable (`PREFLIGHT_LEAD_LAYOUT_ID`, `PREFLIGHT_LEAD_STATUS`) defaulting to the
above. The Lead carries Company + contact name (`Last_Name`/`First_Name`) + email +
phone + website + the source label + owner, same as today's push but on the WalaPlus
layout with status `New Lead`.

## Clean structure (shared by all deal actions)

To avoid duplicate accounts/deals, every deal-creating action builds the same shape,
**grouped by company** (one Account + one Deal per company, all contacts attached):

1. **Account** — reuse the matched existing Account where one exists (actions 1 & 2);
   otherwise create one (actions 2 & 3). One Account per distinct company.
2. **Deal** — one per company, under that Account, in WalaPlus/Standard(Corporates)/New Deal.
3. **Contacts** — a real Contact record per contact row, linked to the Account; the
   first contact is set as the Deal's `Contact_Name` (primary), the rest stay as the
   Account's related contacts.

Creates are batched per type with id mapping: bulk-create Accounts → map company→id;
bulk-create Contacts (with `Account_Name`) → map; bulk-create Deals (with `Account_Name`
+ `Contact_Name`). 3 bulk calls regardless of N.

## The four actions

| # | Button label | Eligible rows | Creates |
|---|---|---|---|
| **1** | Re-engage churned (N) | Rows matched to a **churned** client **past** the sector cool-off (180d private / 365d gov). Resolve the existing Account's Zoho id from the matched `cluster_id`. | Deal under the **existing** Account + Contact. **If the matched cluster has no Account record**, the row is skipped and reported (we don't fabricate an account for action 1). |
| **2** | Deal + contacts: multi-contact cos (N) | Companies appearing with **2+ contacts** in the pasted batch (grouped by normalized company). | One Deal per company + all its contacts. Account = matched existing if any, else create. |
| **3** | New Account+Deal+Contact (first N) | The **first N** PASS rows (N from a number cell), grouped by company. | Full clean structure: Account → Deal → Contact(s). Company-deduped so two PASS rows for one company make ONE account+deal. |
| **4** | Push as Leads (next M) | The **next M** PASS rows after action 3's slice (M from a number cell), top-down, no overlap. | A Lead per row on the **WalaPlus** leads layout, **Lead Status = New Lead**, with company + contact name/email/phone (today's lead push, capped). |

**Top-down split (actions 3 & 4):** the PASS pool is ordered; action 3 consumes the
first N, action 4 the next M. A PASS row is pushed by at most one action. The UI shows
the remaining PASS count so N + M can't exceed it.

## Dedup / no-duplicate guarantees

- Actions 1 & 2 **reuse the matched existing Account** — no duplicate company/account.
- Action 3 runs only on **PASS** rows (already cleared the duplicate + existing-client
  + protected checks) **and** dedupes within the batch by normalized company so the
  same company never yields two accounts/deals.
- Top-down split → no PASS row pushed twice.
- **Dry-run first** for every action: preview the exact counts (accounts/deals/contacts
  or leads it WOULD create) + a sample payload before any write. Per-record write status
  is checked on the real run (Zoho v2 returns HTTP 200 even on REJECTED — truth is in
  `data[i].code/status`).
- Admin-gated (`requireAdminOrKey`); every push writes one `event_logs` audit row.
- The platform only **creates** records here — it never edits or deletes existing ones.

## Backend

- New `buildStructuredPushPlan(action, rows, opts)` in a focused module
  (`src/utils/preflightStructuredPush.ts`) — pure: takes the rows + counts, returns the
  grouped plan (accounts to create/reuse, deals, contacts, leads) + a dropped/skipped
  list with reasons. Unit-testable without Zoho.
- `resolveMatchedAccountId(clusterId)` — find the Account record in the matched cluster
  (`duplicate_records` where `cluster_id=? AND record_type='account'`) → its `zoho_record_id`.
- Endpoint `POST /api/duplicates/preflight/structured-push`
  `{ action: 1|2|3|4, rows, count?, dry_run, owner_mode, owner_id?, round_robin_user_ids?, source }`
  → on dry-run returns the plan + counts + sample; on real run executes the batched
  creates (Accounts → Contacts → Deals, or Leads) via `createZohoRecordsBulk`, returns
  created/failed per type + the per-record outcomes.
- Reuses the existing owner-assignment + source + max-batch (5000) logic from the
  current `/preflight/push-to-zoho`.

## Frontend

- A **"Structured push to Zoho"** panel under the existing push controls in the Preflight
  tab, four rows. Each row: label, **live eligible-count badge**, (rows 3 & 4) a **number
  input** for N/M, a **dry-run checkbox (on by default)**, a **push button**, and a result
  line. Rows 3 & 4 show the shared "PASS remaining" so the split is clear.
- i18n (en + ar) for the new labels. Bump `duplicates-app.js?v=`.

## Error handling

- Mandatory Closing_Date rejection → per-record failure surfaced in the result (with the
  Zoho code), not swallowed.
- Action 1 row with no resolvable Account → skipped + counted in `dropped` with reason.
- Any per-record create failure → counted as `failed`, sample shown; successful ones still
  land (partial success is reported honestly).

## Testing

- Unit tests (plain-assert harness) for `buildStructuredPushPlan`: row eligibility per
  action (churned-past-cool-off for 1; 2+-contact grouping for 2; PASS-only for 3/4),
  intra-batch company dedup (one account/deal per company), top-down split (3 then 4, no
  overlap, respects remaining), and the dropped/skipped accounting.
- `resolveMatchedAccountId` logic test (cluster with/without an account record).
- Gates: `tsc`, tests-tsc, `check-dashboard-html-js`, `node --check` on the JS, JSON i18n parse.

## Non-goals (YAGNI)

- No editing/deleting existing Zoho records.
- No scheduling/automation — every push is a human click, dry-run-first.
- No custom field mapping beyond company/contact/email/phone/website/owner/source (can
  be added later if needed).

## Rollout

Code-only; deploy via the Replit publish pipeline. No destructive migration. The deal
layout/pipeline/stage are env-overridable so other tenants/pipelines are supported later.
