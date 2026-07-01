# Contact Domain-Consistency Routing — Design

**Goal:** Before the Preflight Structured Push files any contact under a Zoho
Account, verify the contact actually belongs to that company using its email
domain. Contacts whose corporate email contradicts the company are dropped;
unverifiable contacts (free-mail / phone-only at an unverified company) go to
Leads instead of fabricating an Account relationship.

**Why:** The Mawsool export's "Company" label is an unreliable enrichment. Raw
rows show groups like "A.P. Moller – Maersk" whose two contacts actually use
`@atkinsrealis.com` and `@slb.com` — filing them under one "Maersk" Account
would write false relationships into the CRM.

## The rule (per company group, keyed by `normalizeCompanyKey(company, domain)`)

1. **Anchor domain** = the company's real domain: the most common real domain
   among the rows' `domain` field, else the most common real corporate-email
   domain among its contacts, else `null`. ("Real" = dotted, non-free-mail,
   non-placeholder — same test as `websiteFromDomain`.)
2. **verified** = anchor is non-null AND at least one contact's email domain
   equals the anchor.
3. Route each contact:

   | Company | Contact signal | Route |
   |---|---|---|
   | verified | email domain == anchor | **account** |
   | verified | corporate email domain != anchor | **reject** |
   | verified | no email (phone-only colleague) | **account** |
   | verified | free-mail email | **lead** |
   | unverified | any corporate email | **reject** |
   | unverified | free-mail or no email | **lead** |

## Layer 1 — existing-account resolution (added 2026-07-02)

BEFORE the domain-consistency routing runs, every row is checked against the
existing-account directory so a person who belongs to an account we already
have is LINKED, never rejected or duplicated. The endpoint resolves per row
(deduped): (1) real EMAIL domain → existing Account, (2) row domain → Account,
(3) company name → Account. The first hit sets `matched_account_zoho_id`. The
email-domain lookup is the new signal — the import gate only ever checked the
row's (often wrong) company label.

Matched/unmatched is a ROW-level split: a matched contact links to its account
(A1) even if a colleague on the same label is genuinely new (→ A2/A3). A1
groups by the RESOLVED ACCOUNT id, so two people under one wrong label matched
to different accounts link separately.

Endpoint: read-only `POST /preflight/resolve-existing-accounts` returns per-row
matches + summary for the UI to enrich rows and refresh badges; the push
endpoint also runs the same enrichment defensively before planning.

## Action model after routing

- **account**-routed rows → grouped into companies → **A1** (churned/existing
  account), **A2** (≥2 account rows, new company), **A3** (1 account row, new).
- **lead**-routed rows → **A4**, each pushed as an individual Lead. A4 is NO
  LONGER the "next M single-contact companies" pool; A3 and A4 no longer share
  a pool. A4 gets its own count/offset slice over the lead-routed rows.
- **reject**-routed rows → excluded from the push, reported in `skipped` with
  reason `email_contradicts_company` (verified) / `unverifiable_company`
  (unverified corporate email).

## Impact on the current file (934 PASS rows, non-churned)

- A2 multi-contact Accounts: ~99 → **~41**
- A3 single-contact Accounts: ~496 → **~216**
- Contacts kept for Accounts: **~300**
- Contacts rejected (dropped): **~168**
- Contacts routed to Leads: **~416**

## Non-goals

- No auto-derivation of a new company NAME from an unknown domain (user chose
  reject over re-grouping). Anchor is only used to VERIFY, never to rename.
- Churned/A1 behavior otherwise unchanged (still re-engages under the existing
  matched Account); routing only removes contradicting contacts from it.
