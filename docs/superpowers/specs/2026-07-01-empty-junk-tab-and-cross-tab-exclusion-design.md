# Empty / Junk tab + cross-tab cleanup exclusion — Design

**Date:** 2026-07-01
**Owner:** Ahmad Amashah (with Adam — GRQ Assistant)
**Status:** Approved decisions, pending spec review

## Goal

Recognize two more kinds of garbage record in the Duplicate Radar — records literally
named **walaplus** (the company's own brand used as a test value) and **junk/gibberish**
names (e.g. `JYupWMLW JYupWMLW`, `jJQaBOcg`, `tsSLAueP tsSLAueP`) — surface them in the
existing cleanup tab, **rename that tab "Empty / Junk"**, and **remove every cleanup
record (empty, test, junk, orphaned) from all the other tabs** so the merge/monitoring
views show only real, actionable data. Cleanup records live in one place: the Empty /
Junk tab (orphaned records additionally stay in Account Hints, where they get linked).

## Confirmed decisions (Ahmad, 2026-07-01)

1. **Safety rule kept.** A record that has any real data (a deal / contact / email /
   attachment) is NEVER a cleanup candidate, even with a test/junk/walaplus name. The new
   names only matter when the record is **otherwise empty** — same gate as today's test
   keywords. This preserves the 2026-06-26 safety principle in `emptyRecordsDetection.ts`.
2. **"walaplus" = exact name.** Flag only when the normalized name (lowercase, spaces
   collapsed) **equals** `walaplus`. Names that merely contain the word (partners, brand
   references) are untouched.
3. **Junk = conservative + Arabic-safe** (see Detection rules).
4. **Hide from every tab.** All four cleanup classes — `empty`, `test`, `junk`,
   `orphaned` — are removed from every tab **except** Empty / Junk.
5. **Orphaned stays in Account Hints.** Orphaned records (real data, no Account link) are
   hidden from the duplicate/merge/monitoring tabs but remain visible in **Account Hints**
   (their linking home) and in Empty / Junk. Once linked + re-synced they stop being
   orphaned and flow back into the normal tabs automatically.
6. **Monitoring tabs included.** CS Pipeline Overlap, CS Lifecycle, Deals Lifecycle, and
   Deal Compliance also hide cleanup records.

## Detection rules (extends `src/utils/emptyRecordsDetection.ts`)

A new `isJunkOrTestName(name)` (superset of today's `isTestOrPlaceholderName`) adds:

- **walaplus-test** → classifies as reason `test`: `normalize(name) === "walaplus"`, where
  `normalize` = lowercase, trim, collapse internal whitespace. (So `WalaPlus`, `walaplus `,
  `Wala Plus` → match; `WalaPlus Partners`, `walaplus.com deal` → no match.)
- **junk** → new reason `junk`:
  - **J1 — repeated token:** the whole name is a single token repeated, case-insensitively
    (`JYupWMLW JYupWMLW`, `tsSLAueP tsSLAueP`). Exactly 2 identical tokens.
  - **J2 — machine string:** a single Latin token, length ≥ 6, that looks generated:
    contains letters **and** digits, OR is mixed upper/lowercase with a vowel ratio below a
    threshold (no pronounceable structure) — e.g. `jJQaBOcg`, `IxbfYeaa`, `x7Kp9Qz`.
  - **Hard guards — never flag as junk:**
    - name contains any Arabic-script character (`؀-ۿ`);
    - name has ≥ 2 distinct real-word tokens (a genuine multi-word name);
    - name length < 5;
    - name is purely numeric.
- **Gating (unchanged):** `test` and `junk` are only assigned to a record the existing
  classifiers already judge **structurally empty** (no deal / contact / email / attachment).
  A walaplus- or junk-named record that carries real data is left alone (decision 1).

The `reason` union across `classifyDeal/classifyAccount/classifyContact` becomes
`"orphaned" | "empty" | "test" | "junk" | null`. `junk` and `test` are both
delete-eligible (same as today's `test`); `empty` delete-eligible; `orphaned` link-eligible.

## Persisted classification — `cleanup_class`

To let other tabs filter cheaply, persist the per-record class:

- **Schema:** add `cleanup_class TEXT` (nullable) to `duplicate_records`, in BOTH the
  canonical `CREATE TABLE` and an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  (strict schema-parity rule — a drift would drop the column on deploy). Values:
  `'empty' | 'test' | 'junk' | 'orphaned' | NULL`. Index `idx_duplicate_records_cleanup_class`.
- **Population:** a post-scan pass `classifyCleanupRecords()` recomputes `cleanup_class`
  for every record from the **already-synced snapshot** (record name + the related-data
  signals the empty-records queries already derive) — **no extra live Zoho calls**. Runs in
  the same place as the other post-scan passes (`restoreLedgerResolvedClusterStatus`,
  `reconcileEmptyDeleteDeletions`, `updateClusterStats`). Idempotent; refreshes each sync so
  a fixed/renamed/linked record clears its class and reappears in the normal tabs.
- The **tag-time live re-check is unchanged** — before any Empty-Delete tag, the platform
  still verifies emptiness live against Zoho (`liveDataReason`). `cleanup_class` drives
  *display filtering* only, never a deletion by itself.

## Cross-tab exclusion — read-time filter (chosen approach)

**Approach: read-time filter** (recommended over build-time cluster detachment). Each
in-scope tab's query excludes cleanup records and drops clusters that no longer have enough
real records. This keeps clustering, the merge/separation ledgers, and sync **untouched**
(we do not null out `cluster_id`), and it is fully reversible — clearing `cleanup_class`
(or a re-sync) restores a mis-flagged record everywhere with no re-clustering.

Rejected alternative — *build-time detach* (set `cluster_id = NULL` on cleanup records):
fewer query edits, but disturbs clustering/ledger semantics and makes a mis-classification
destructive. Not worth the risk given the recently-stabilized sync/ledger machinery.

**Mechanics:**
- "Real record" = `cleanup_class IS NULL`.
- Cluster-based tabs list a cluster only when its **real-record count ≥ the tab's existing
  threshold** (≥2 for dup tabs), and exclude cleanup records from the members/counts shown.
- The implementation plan MUST enumerate every in-scope query function and add the filter,
  with a per-tab test asserting a seeded junk record is absent. In scope:
  - **Domain Clusters** (`getAllClusters`)
  - **Cross-Module overlaps** (`getCrossModuleOverlaps`)
  - **Cluster Merge** (`findSameDomainClusterDuplicates`)
  - **Per-module Duplicates** — Lead / Deal / Contact / Account
  - **CS Pipeline Overlap**, **CS Lifecycle**, **Deals Lifecycle**, **Deal Compliance**
- **Exceptions (NOT filtered):**
  - **Empty / Junk tab** — the home; reads records by `cleanup_class IS NOT NULL`.
  - **Account Hints** — keeps `orphaned` records visible for linking (decision 5).
  - **Logs / Agent Activity / progress** — audit history is not filtered.

## Tab rename + description

- Label `duplicates.er_tab`: **"Empty / Orphaned" → "Empty / Junk"** (en + ar).
- Tab `title`/description updated to: *"Records to clean up — empty, junk/gibberish,
  testing (incl. 'walaplus'), and orphaned. Tagged 'Empty-Delete' for the Zoho admin to
  delete; the platform never deletes."* (en + ar).
- The tab keeps its existing sub-sections; junk-named records appear under the test/junk
  grouping (a `junk` badge distinct from `test`/`empty`).

## Edge cases & safety

- WalaPlus's own legitimate records (real deals/contacts) are NOT flagged — exact-name +
  empty-only gate (decisions 1–2).
- Arabic and multi-word real names are never junk-flagged (hard guards).
- A cluster that is a mix of real + cleanup records still shows in the dup tabs **on its
  real records**; only the cleanup members are hidden, and the cluster drops out only if
  fewer than 2 real records remain.
- Reversibility: mis-flag → clear `cleanup_class` (or fix the record + re-sync) → reappears.

## Testing

- Unit (`emptyRecordsDetection.test.ts`): walaplus exact-match (+ negative: "WalaPlus
  Partners", "walaplus.com"); J1 repeated-token; J2 machine-string; guards (Arabic name,
  multi-word name, short name, numeric) → not junk; gating (walaplus/junk + real data →
  not flagged).
- Per-tab exclusion test: seed a junk record into a cluster, assert it is absent from each
  in-scope tab's result and present in Empty / Junk; assert an orphaned record is absent
  from dup tabs but present in Account Hints.
- Gates: `tsc` ×2, dashboard html/js check, i18n JSON parse, **schema-parity strict**.

## Non-goals

- No new live-Zoho calls for classification (snapshot-only).
- No auto-deletion — tagging + admin-deletes flow unchanged.
- No change to clustering, sync, or the merge/separation/resolution ledgers.

## Rollout

Code + additive schema (`cleanup_class` column in CREATE TABLE + ALTER). No destructive
migration. Deploy via the Replit publish pipeline; republish to pick up.
