# Empty / Orphaned Records — CRM Cleanup tab

**Date:** 2026-06-25
**Owner:** Sarah (GRQ)
**Status:** Design approved (pending spec review)

## Goal

A new **Duplicate Radar** tab that surfaces empty / orphaned CRM records so the
team can clean them out of Zoho. Detection runs off the local synced data;
remediation is **HITL** — the platform only adds an **`Empty-Delete`** tag, and
the Zoho admin performs the actual deletion. Nothing is ever auto-deleted.

## Tab

- Name: **"Empty / Orphaned Records"** (Duplicate Radar tab, same chrome as the others).
- Three sections: **Deals · Accounts · Contacts**, each with a count chip.

## Detection criteria (off local `duplicate_records`)

### Deals — orphaned (missing an Account)
A `record_type='deal'` with **no linked Account** (`raw_data->'Account_Name'->>'id'` empty).
Sub-classified for the action split:
- **Linkable** — has a Contact (`raw_data->'Contact_Name'->>'id'`) OR an Amount > 0. → Link action; Delete **disabled**.
- **Empty** — no Account AND no Contact AND no Amount (≤ 0 / blank). → Delete-eligible (and Link still available).

### Accounts — empty
An `record_type='account'` with **no Deal and no Contact referencing its Zoho id**
(computed locally: account id absent from every deal's and contact's
`Account_Name.id`). The **no-attachments** condition is verified **lazily per row**
(live Zoho fetch on demand) — Delete stays **disabled until attachments are
confirmed 0**, so an account holding a signed contract is never tagged.

### Contacts — name-only
An `record_type='contact'` with **no email, no phone** (`phone_normalized` /
`mobile_normalized` empty), **no Account** link, and **no Deal** referencing the
contact id. → Delete-eligible.

## Actions

| Section | Action(s) |
|---|---|
| Deals | **🔗 Link to Account** (account picker pre-filled with the Smart Account Inference suggestion when confident → writes `Account_Name` to the deal in Zoho). **🏷 Tag `Empty-Delete`** (only when the deal is truly empty). |
| Accounts | **📎 Check attachments** (lazy fetch). **🏷 Tag `Empty-Delete`** (enabled only after 0 attachments confirmed). |
| Contacts | **🏷 Tag `Empty-Delete`**. |

Each section has a bulk **"Tag all empty"** for its Delete-eligible rows.

## Safety model

- All Zoho writes (tag + deal-link) are **dry-run preview → admin password →
  batched**, reusing the existing tag-add path used by Duplicate-Delete (the
  platform never deletes).
- Tag name **`Empty-Delete`** (env `EMPTY_DELETE_TAG`, default `Empty-Delete`).
- A pre-write **snapshot** is captured so a tag can be **undone** (remove tag +
  reopen), mirroring the agentic apply undo.
- Scope is **all layouts** (empty junk is cleaned regardless of corporate /
  marketplace).

## Proposed endpoints (`/api/duplicates/empty-records/*`)

- `GET …/deals` · `GET …/accounts` · `GET …/contacts` — detection lists.
- `GET …/accounts/:id/attachments` — lazy per-row attachment count.
- `POST …/tag` `{ module, zohoIds }` — batched `Empty-Delete` tag write (admin-gated, snapshot first).
- `POST …/link-deal` `{ dealId, accountId }` — write `Account_Name` onto a deal (admin-gated).

## Reuse / boundaries

- **Smart Account Inference** (Account Hints engine) supplies the deal→account
  suggestion. This tab owns the cleanup *decision* (link vs delete); it does
  **not** replace the Account Hints tab.
- Tag-add + snapshot/undo reuse existing Duplicate Radar helpers — no new Zoho
  write primitives.

## Out of scope (non-goals)

- Actual record deletion (admin does it in Zoho after the tag).
- Merging / de-duplication (that's the existing Duplicate Radar).
- Auto-tagging without review.

## Follow-on (not this build)

- Add a read-only Adam tool for this tab (per the standing "rules into Adam's
  brain" rule).
