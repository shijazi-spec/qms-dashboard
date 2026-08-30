# check-companies-batch — Bulk Company-NAME Lookup Tool — Design Spec

**Date:** 2026-08-30
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review

## 1. Goal

Give Adam a **bulk company-NAME** lookup so a pasted list of companies is answered in ONE call, the way `check-domains-batch` already answers a pasted list of domains.

**Why:** the platform has bulk tools for DOMAINS only (`check-domains-batch`, `domain-deal-stages`). Every NAME-based tool (`lookup-entity`, `preflight-check`) is one company per call. So a 56-company list cost 56 calls, blew Adam's tool-step budget after ~10, and he rationalised the gap as "limitations in terms of data access" (it was never permissions — his role is identical in Slack and web). This tool closes that gap.

## 2. Matching rules (approved)

Reuses the platform's exported `normalizeCompanyName` (`duplicateRadarDatabase.ts:6786`) so matching behaves like Preflight/Radar and cannot drift:
- **strict** — normalized names are EQUAL. Confident match.
- **fuzzy** — one normalized name CONTAINS the other. Returned but flagged `match_type: "fuzzy"` and must be presented as "possible match — verify", never asserted as a client. Mirrors Preflight, where a fuzzy name hit is REVIEW, never BLOCK.
- Fuzzy requires the shorter normalized name to be >= 4 chars, so a stub like "co" or "st" cannot swallow unrelated companies.
- Strict wins over fuzzy when both exist for the same input.

## 3. Data source + query shape

Reads the SYNCED mirror (`duplicate_records`) — no live Zoho calls, so the whole list is one DB round trip.

ONE grouped query selecting only what is needed (names, counts, stages — never `raw_data`, per the Quality-Reports 504 lesson):

```sql
SELECT COALESCE(NULLIF(r.company_name,''), NULLIF(r.account_name,''), r.record_name) AS crm_name,
       r.record_type,
       COUNT(*)::int AS n,
       ARRAY_AGG(DISTINCT r.stage) FILTER (WHERE r.record_type = 'deal' AND COALESCE(r.stage,'') <> '') AS stages
  FROM duplicate_records r
 WHERE COALESCE(NULLIF(r.company_name,''), NULLIF(r.account_name,''), r.record_name) IS NOT NULL
   {segment predicate when a segment is given}
 GROUP BY 1, 2
```

Rows come back as (crm_name, record_type, count, stages). The tool normalizes each `crm_name` once in JS, indexes them, then resolves every input name against that index. Matching is pure and unit-testable.

**Bounded:** input capped at 300 names (same ceiling Preflight uses). Names-only projection keeps the payload small.

## 4. Tool contract

- **id:** `check-companies-batch`
- **input:** `{ companies: string[] (1..300), segment?: "all"|"marketplace"|"walaplus"|"walaone" }`
- **output:** `{ success, checked, matchedCount, results: [...], error? }` where each result is:
  `{ input, matched, match_type: "strict"|"fuzzy"|null, matched_name: string|null, counts: { leads, deals, contacts, accounts }, deal_stages: string[] }`
- Read-only. No writes, no approval gate.

`deal_stages` is what lets Adam answer "In CRM, stage: Closed Lost" per company instead of a bare "not in CRM".

## 5. Pure core (testable without a DB)

`matchCompanyNames(inputs: string[], crmRows: CrmNameRow[]): CompanyMatch[]` in a new `src/utils/companyNameBatch.ts`:
- `CrmNameRow = { crm_name: string; record_type: string; n: number; stages: string[] | null }`
- Aggregates rows per normalized CRM name into per-module counts + stage set, then resolves each input (strict, else fuzzy, else unmatched).
- Deduplicates repeated inputs while preserving the caller's original order and original spelling in `input`.
- The DB function is a thin wrapper: run the query, hand rows to this function.

## 6. Wiring
- `getCompanyBatchRows(segment)` in `duplicateRadarDatabase.ts` runs the query (reusing `buildSegmentPredicate`, normalizing legacy `corporate` to `walaplus` like its siblings).
- New tool file `src/mastra/tools/checkCompaniesBatchTool.ts`, registered on `qmsConsultantAgent` with the same `wt(...)` wrapper the other read-only radar tools use.
- **Prompt update (Adam's brain):** the name-list rule added on 2026-08-30 currently says no batch tool exists for names. Change it to: for a pasted list of company NAMES use `check-companies-batch` (one call for the whole list); present `fuzzy` hits as "possible match — verify", never as a confirmed client. Keep the "say which object you checked" rule. NO backticks may be added to that template literal.

## 7. Non-goals
- No live Zoho verification per name (that is `preflight-check` / `lookup-entity` for a single company).
- No merging, no writes, no CS-phase logic — presence, counts, and deal stages only.
- Does not replace `check-domains-batch`; domains stay the faster, more precise path and Adam should still prefer domains when the user has them.

## 8. Testing
- Pure `matchCompanyNames` (executed via tsc-CJS-emit + node, since vitest cannot run locally): strict equality wins over fuzzy; fuzzy flagged not asserted; short-stub guard (>= 4 chars) prevents "co" swallowing everything; legal-suffix insensitivity ("KPMG Saudi Arabia Ltd" matches "KPMG Saudi Arabia"); Arabic names preserved; unmatched returns `matched:false` with zero counts; duplicate inputs deduped but order/spelling preserved.
- Mocked-pool test that `getCompanyBatchRows` selects no `raw_data` and applies the segment predicate.
- `tsc --noEmit`, `tsc -p tsconfig.tests.json` clean. Backtick count in `qmsConsultantAgent.ts` unchanged.

## 9. Deployment
Commit only touched files; push `origin/QMS`; user Pulls -> Republishes. No schema change, no new table, no migration.
