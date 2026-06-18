# Preflight Rejection Rules — Specification

> **⚠️ ARCHIVED — NOT the active ruleset (Ahmad 2026-06-18).** Preflight was
> simplified to **BASIC mode** — only two foundational rules run:
> **Rule 1** contact duplicate (email or phone already in CRM → `duplicate`);
> **Rule 2** (only if Rule 1 finds nothing) the company domain has a deal in
> Agreement Signed / Paid (customer stage) with **no churn date** → `block`;
> otherwise `pass`. The full ladder specified below is kept in code behind
> `PREFLIGHT_RULE_MODE=full` and may be re-enabled later. See
> `basicPreflightVerdict()` / `runPreflightBasic()` in
> `src/utils/duplicateRadarPreflight.ts`.

**Author:** Ahmad / Sarah (GRQ), drafted with Adam · 2026-06-17
**Status:** Superseded by BASIC mode 2026-06-18 (full ladder archived, re-enablable).
**Applies to:** Duplicate Radar → Preflight Check (pre-import screening of marketing/vendor lead lists before they enter Zoho CRM).

---

## 0. Scope gate (runs before everything)

- **Corporate / B2B only.** Marketplace and merchant records are OUT OF SCOPE.
  A record is corporate UNLESS it sits on a merchant layout
  (`Marketplace`, `Partner Accounts`). Contacts on the `Standard` layout and
  legacy marker-less records are corporate. *(Already live.)*
- If the incoming row matches only marketplace/merchant records → **PASS**
  (reason: `out_of_scope_non_corporate`).

---

## 1. Identity signals & how much we trust them

Matching uses these signals. **Strength decides whether a hit is a hard reject
or only a REVIEW** — this is what prevents both false rejects and false passes.

| Signal | Used in | Strength | Rule |
|---|---|---|---|
| **Website / domain** | Tier 1 (company) | **Strong** | Exact or normalized domain match → confident. Primary signal. |
| **Contact email (full address)** | Tier 2 (contact) | **Strong** | Exact full-address match → confident. Free-mail (gmail/hotmail/…) does NOT establish company identity. |
| **Corporate phone** | Tier 1 (company) | Medium | Normalized, ≥7 digits. Never match into a catch-all cluster (see §4). |
| **Mobile / 2nd phone** | Tier 2 (contact) | Medium | Normalized, ≥7 digits. Same catch-all guard. |
| **Company name** | Tier 1 (company) | **Weak** | High fuzzy threshold + generic-name blacklist (`Confidential`, `N/A`, single common words). Name-only hit → REVIEW, never a hard reject. |

**Single-weak-signal rule:** a match on company-name alone, or a phone-only
match with no corroboration, → **REVIEW** ("verify by hand"), not a hard reject.
Domain or exact-email → confident reject.

---

## 2. TIER 1 — Company-level screening

**Question:** *Is this company already ours, or already being worked?*

**Find the company** in CRM by: **website/domain → corporate phone → company name**
(in that priority order), against **all CRM records** — Deals, Accounts, Leads,
Contacts — **not just formed duplicate-clusters** (see §5).

Then classify by the company's strongest CRM state:

| # | Company state | Verdict | Severity | Action |
|---|---|---|---|---|
| 1a | Deal **Agreement Signed / Paid / Closed Won / Client Activated / Transferred to CS**, **no churn date** | **BLOCK** | critical | Current customer — do **not** pursue. Route to CS owner. |
| 1b | Same as 1a **but has a churn date** (churned customer) | **REVIEW** if within cool-off · **WARN** if past it | high / medium | Cool-off: **180 days Private / 365 days Government** from churn date. Within → CS sign-off required. Past → Sales may re-engage; notify CS. |
| 1c | **Open / active Deal** (Proposal, Negotiation, Meeting, Agreement Sent, Awaiting PO…; not closed-lost, not signed/paid) **or active Lead** | **DUPLICATE** | high | Already in the pipeline — do **not** re-import. Route to the existing owner (SDR double-touch). |

> **"Active lead" — COLD statuses (Ahmad 2026-06-18, narrowed):** a Lead counts as active only if its `Lead_Status` is NOT in the cold set: `Junk Lead`, `Bogus Lead`, `Lost Lead`, `Not Qualified`, `Disqualified`, `Converted`, **`New`**, **`Attempted to Contact`**. New / Attempted-to-Contact are cold (no real engagement yet), so a company whose only leads are New/Attempted is **pursuable** — it does not hard-reject a new contact. Only worked statuses (Contacted / Working / Qualified / …) make a lead "active".
| 1d | Only **Closed-Lost** deals on file (no active deal/lead, not a customer) | **DUPLICATE** | low | Prior lost opportunity — Sales **may re-engage**. **LINK** the new lead to the existing Account; don't fork a parallel record. |

If **no company match at all** → fall through to Tier 2.

> **Stage sets (Zoho), to be confirmed:**
> - *Customer / Won*: Paid · Agreement Signed · Closed Won · Client Activated · Transferred to CS
> - *Active pipeline*: anything not Won and not Lost/Closed/Dropped/Cancelled (Proposal, Negotiation, Meeting, Agreement Sent, Awaiting PO, …)
> - *Lost*: any stage containing "lost" / "closed lost" / "dropped" / "cancel"

---

## 3. TIER 2 — Contact-level screening (only if Tier 1 found nothing)

**Question:** *Is this exact person already in CRM?*

Match the incoming contact by: **email (exact full address) → mobile phone → second phone**.

| Contact state | Verdict | Severity | Action |
|---|---|---|---|
| **Email exact** match to an existing CRM contact/lead | **DUPLICATE** | medium | Same person already on file — update the existing record; don't create a new one. |
| **Mobile / 2nd-phone** match only (no email match) | **REVIEW** | medium | Likely the same person, but phone alone is weaker (recycled numbers) — verify before importing. |

> **Open question (your call):** you proposed Tier 2 = email **OR** mobile **OR**
> 2nd phone, any single one → reject. Our existing contact-merge rule needs **≥2**
> of {email, phone, name} to call two contacts the same person. Recommendation:
> **email-exact = hard dedupe; phone-only = REVIEW.** Confirm which you want.

If neither tier hits → **PASS** (safe to import).

---

## 4. Matching guardrails (mandatory — these caused the bugs we found)

- **Catch-all clusters:** a phone or company-name match into an oversized
  cluster (the 1,301-contact blob where unrelated companies collided) is a
  false match → **REVIEW**, and do **not** show that record's churn/CS data as
  if it were the incoming lead's. *(Already live.)*
- **Phones:** normalize, require ≥7 digits, drop generic/shared numbers.
- **Company names:** normalize + high fuzzy threshold; blacklist generic names.
- **Free-mail emails:** never used for company identity; only for exact
  contact-to-contact dedupe.

---

## 5. Implementation requirement (fixes the false-passes / Issue 1)

Tier 1 / Tier 2 must query the **full synced CRM record set** (`duplicate_records`
= Deals/Accounts/Leads/Contacts), **not only `duplicate_clusters`.** Today the
Preflight only matches formed duplicate-clusters, which is why 38 companies that
*are* in the CRM (saib, sdb, hikma, ndmc…) landed in the accepted file. A company
with CRM records but no formed cluster must still be found.

---

## 6. Outcome model (recommended: keep it GRADED, not a yes/no flag)

Graded outcomes tell Sales *what to do*, not just accept/reject:

| Verdict | Meaning | What Sales does |
|---|---|---|
| **BLOCK** | Current customer | Don't pursue; route to CS |
| **REVIEW** | Churned-in-cool-off · weak/ambiguous match | Verify / CS sign-off before acting |
| **WARN** | Churned past cool-off | May re-engage; notify CS |
| **DUPLICATE** | Active deal/lead, or contact already on file, or closed-lost | Route to owner / LINK to Account / update existing |
| **PASS** | Genuinely new | Safe to import |

---

## 7. Worked examples (from the Mawsool run)

- `saib.com.sa` (3 Leads, 3 Deals, 5 Contacts, 4 Accounts) → Tier 1 by domain →
  currently lands in PASS (bug). Under this spec: found via all-records match →
  DUPLICATE or BLOCK depending on deal stage. **No longer a false pass.**
- "King Abdullah Hospital" + "Suzuki/Najeeb" both matching one 1,301-contact
  cluster by phone → §4 catch-all guard → **REVIEW** (verify by hand), churn date
  withheld. **No more wrong churn date.**
- A `Closed-Lost`-only company → DUPLICATE (low) + LINK to Account, not PASS.

---

## 8. Open decisions for sign-off

1. **Tier 1 scope** — confirm it covers all four company states (1a–1d), not just signed/paid.
2. **Tier 2 strength** — email-exact = hard dedupe, phone-only = REVIEW? (recommended) or any single signal = hard reject (as originally proposed)?
3. **Outcome model** — graded (recommended) or a single REJECT/ACCEPT flag?
4. **Cool-off windows** — confirm 180d Private / 365d Government.
5. **Stage sets** — confirm the Zoho stage lists in §2.
6. **Generic-name blacklist** — confirm the list (`Confidential`, `N/A`, …) and the company-name fuzzy threshold.

---

*Once you've reviewed and answered §8, this becomes the canonical Preflight rule
set — encoded in `duplicateRadarPreflight.ts` and mirrored into Adam's system
prompt.*
