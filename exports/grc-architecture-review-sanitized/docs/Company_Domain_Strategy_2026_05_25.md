# Company_Domain as a First-Class CS Data Primitive — Strategy

**Audience:** ExampleOrg product + GRQ leadership
**Date:** 2026-05-25
**Status:** Strategy doc, no code shipped yet
**Decision needed:** which phases (P0–P3) to fund

---

## The premise

For a B2B SaaS like ExampleOrg, **a company's email domain is its canonical identity** — more stable and useful than name, phone, or CRM record ID.

Today, Company_Domain exists in your CRMProvider deals but is used only for one purpose: as a deduplication signal inside the Duplicate Radar. Everywhere else (Call Evaluation, Coaching, Topic Clustering, CS handoff visibility) it is invisible. This doc proposes treating Company_Domain as a **first-class primitive** across the platform.

---

## Why Company_Domain wins over alternatives

| Identifier | Stability | Uniqueness | Machine-readable | Notes |
|---|---|---|---|---|
| Company name | ❌ — "Aramco" vs "Example Organization" vs "ارامكو" | ❌ — many subsidiaries share a name | ⚠️ — fuzzy match needed | Translates, gets misspelled |
| Phone number | ⚠️ — changes when numbers are ported | ❌ — switchboards shared by thousands | ✅ | Many companies use cellular numbers |
| CRMProvider record ID | ✅ — never changes | ❌ — same company often has 3-5 records (duplicates) | ✅ | Internal-only, no business meaning |
| **Email domain** | ✅ — companies rarely change | ✅ — one company = one primary domain | ✅ — RFC-defined | The standard for B2B identity |

Mature platforms (Gong, Chorus, CRMProvider ABM, ZoomInfo) all use domain as the primary key for company-level aggregation. ExampleOrg should too.

---

## What "reflecting Company_Domain everywhere" looks like — the data lineage

```
SOURCES                       LOCAL SNAPSHOT              FEATURES THAT CONSUME
───────                       ──────────────              ─────────────────────

CRMProvider Lead.Company_Domain ──┐                              ┌── Duplicate Radar
CRMProvider Deal.Company_Domain ──┼──> CRMProvider_sync_records         ├── CS Lifecycle Compliance
CRMProvider Account.Website     ──┘    (Postgres cache)          │
                                       │                  │   [current: ✅ both wired]
                                       │
SDR call recording                     ├──> call_records  ├── Auto-link (P1)
└─ transcript: email                   │    .metadata.    ├── Call search / filter (P0)
   captured via                        │    company_      ├── Call Details domain chip (P0)
   3-point verification ──┐            │    domain        ├── Coaching by industry (P2)
                          │            │                  ├── Topic Clusters by domain (P2)
                          │            │
Email parsed from         │            │                  └── Account Activity Timeline (P3)
{contact.email} ──────────┴────────────┘                      "all touches to <REDACTED_HOST>
                                                              across SDR, CS, Marketing"
```

---

## Phase plan

Four phases. P0 is the foundation; P1–P3 each layer additional value on top.

---

### P0 — Surface Company_Domain in Call Evaluation

**Effort:** ~2 hours. **Risk:** low. **Dependency:** none — ships standalone.

**What it does:**
- Adds a `Domain` column to the Call Records table (visible alongside Phone)
- Shows `Domain: <REDACTED_HOST>` chip in the Call Details modal right column, below Phone
- Adds domain search to the filter bar (`Company Domain` next to phone search)

**Where the domain comes from:**
- Primary: `linkedLead.Email` → extract domain (the contact who the SDR spoke to)
- Fallback: `linkedAccount.Website` → strip protocol
- Fallback: `transcript.captured_email` (once the 3-point verification step rolls out)

**Schema change:** none (uses existing `call_records.metadata` JSONB).

**Why it's foundational:** every later phase needs domain on `call_records`. Once this exists, P1/P2/P3 become small additions instead of structural changes.

---

### P1 — Use Company_Domain to auto-link calls to CRM

**Effort:** ~4 hours. **Risk:** medium (touches the auto-link matcher). **Dependency:** P0 + the 3-point verification step rollout.

**What it does:** today's auto-link order is:
1. Phone match against CRMProvider Leads/Deals
2. Activity fallback (same agent + same day touched a CRM record)
3. Give up — call stays unlinked

**Proposed new order:**
1. Phone match
2. **NEW: Email domain match** — when the SDR captured the customer's work email during the 3-point verification, parse the domain and query CRMProvider for any Lead/Deal/Account with that domain
3. Activity fallback
4. Give up

**Recovery rate (estimate):** 10–20% of currently unlinkable calls.

Concretely: a customer calls from a non-CRMProvider-registered cell phone but identifies as `<REDACTED_EMAIL>` during the verification step. Phone match: fails (cell isn't on file). Email domain match: hits Account = Example Organization. Call links automatically.

**Why this matters:**
- Increases compliance coverage (more linked calls = more compliance checks fire)
- Reduces "Match by phone" manual work
- Closes the loop with the new 3-point verification — without using the captured email for linking, the email was "just for follow-up", which leaves value on the table

---

### P2 — Domain as a coaching + topic-clustering dimension

**Effort:** ~1 day. **Risk:** medium. **Dependency:** P0.

**What it does:** today's coaching plans are per-agent + per-attribute. Today's topic clusters are per-topic. Neither slices by company or industry.

**Proposed additions:**

**Coaching by industry pattern**
- New view: *"this agent fails Objection Handling on 4 calls — 3 of them are to banking domains (`@<REDACTED_HOST>`, `@<REDACTED_HOST>`, `@<REDACTED_HOST>`)"*
- Action: surface this as a sector-specific coaching plan rather than a generic one
- Drives more targeted training ("banking-specific objection patterns" vs "objection handling in general")

**Topic Clusters by industry**
- Add an "Industry" filter to the Topic Clusters panel (Analytics tab)
- Industries inferred from domain via a lookup table — `@<REDACTED_HOST>`/`@<REDACTED_HOST>` → Banking, `@<REDACTED_HOST>` → Telecom, etc.
- Quality lead can ask *"What objections come up most in Banking calls?"*

**Per-company drill-down**
- Click any domain anywhere in the dashboard → opens "Company View" showing every call, every coaching plan, every compliance status tied to that domain
- Becomes a natural input to QBR/MBR reports

**Effort breakdown:**
- 2h: domain extraction utility (URL/email parsing, fallbacks)
- 3h: industry-lookup table seed (~50 Saudi domains → industry mapping)
- 3h: UI for filtering coaching/clusters by domain or industry

---

### P3 — Cross-team "Account Activity Timeline"

**Effort:** ~2 days. **Risk:** higher (cross-cutting). **Dependency:** P0 + P1 + organisation alignment.

**What it does:** today, an SDR call, a CS lifecycle event, a marketing email, and a Duplicate Radar violation for the same company are scattered across 4 different tabs. No single view ties them together.

**Proposed:**
- New tab or page: **Account View** (URL: `/account/<domain>`)
- Sections:
  - **Identity card** — company name, primary domain, industry, primary CRMProvider Account record, deal stage
  - **Activity timeline** — chronological list of every touch: SDR calls, CS lifecycle phase transitions, marketing emails (if Mailchimp/EmailProvider integrated), notes, compliance checks
  - **Coaching context** — every coaching plan whose evidence calls were to this domain
  - **Compliance health** — Duplicate Radar status, CS Lifecycle violations, calls awaiting compliance check

**Why this matters:**
- The CS team's day-1 question on a new account is *"what's the history with these guys?"* — currently answered by clicking through 4 tools
- Compresses the SDR → Sales → CS handoff: each team can see what the previous team did, with citations
- Becomes the front-page view for QBR meetings

**Why P3 is harder:**
- Requires the marketing/email integration which doesn't exist yet
- Cross-module joins are more expensive (every page load queries 5+ tables)
- UX is genuinely new — not just adding a column to an existing view

---

## Out of scope

These COULD use Company_Domain but I'm not recommending them in this phase plan:

- **Industry-specific scorecards** — different attributes weighted differently per industry. Possible but probably over-engineering before you have the data to prove different industries warrant different scoring.
- **Domain-based access control** — restrict which agents see which accounts. Org-political; not solved by code.
- **Domain blacklist/competitive intelligence** — flag calls to competitor domains (`@<REDACTED_HOST>`). Niche use-case.

---

## Cost/benefit summary

| Phase | Effort | Visibility win | Strategic value | Recommendation |
|---|---|---|---|---|
| **P0** — Surface domain in Call Evaluation | 2h | Immediate (column appears) | Foundation for everything else | ✅ **Build now** |
| **P1** — Use domain for auto-link | 4h | Quiet but measurable (more linked calls) | Closes the loop with 3-point verification | ✅ Build right after the verification rollout |
| **P2** — Coaching + clusters by domain | 1 day | Large — enables industry-level analysis | Differentiates ExampleOrg from generic CI tools | Build when call volume justifies (≥ 500/month per agent) |
| **P3** — Account Activity Timeline | 2 days | Largest single feature | Becomes the QBR/MBR front-page tool | Build after Marketing-channel integration exists |

---

## Decision points for product

1. **Fund P0 now (~2h)?** — yes/no
2. **Industry-lookup table for P2** — who maintains the mapping (~50 domains → industry)? CS Ops team or built into the platform?
3. **P3 prerequisite** — do you actually want marketing-channel data in the timeline, or is SDR+CS sufficient? If just SDR+CS, P3 effort drops to ~1 day.
4. **Domain canonicalisation** — `<REDACTED_HOST>` vs `<REDACTED_HOST>` vs `<REDACTED_HOST>` — same company, different domains. Need a "primary domain" concept maintained somewhere. Cheapest: a small column on the Account record in CRMProvider marked `is_primary_domain`. More complete: a separate `company_domains` table mapping all variants to a canonical entity.

---

## My one-line summary

> Company_Domain is to your CS data what `user_id` is to a SaaS app — the primary key that makes everything else aggregable. Today it's used for one feature; it could anchor everything from auto-link to coaching to QBR reporting. Build P0 first because the rest cascades cheaply from there.
