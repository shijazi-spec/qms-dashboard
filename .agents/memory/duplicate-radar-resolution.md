---
name: Duplicate-radar resolution — solved persistence & live-write gating
description: Two durable rules for the Zoho duplicate-radar autonomous resolver — how per-module "solved" must be counted, and why every live Zoho write must be env-gated.
---

# Per-module "solved" counting

A cluster/module counts as "solved" from THREE sources, OR'd together:
1. `duplicate_clusters.status = 'resolved'`
2. a merge action — but **module-scoped**, never cluster-scoped
3. a row in the durable `duplicate_resolution_ledger` (keyed by stable Zoho
   identity, NOT cluster_id)

**Rule: merge-action attribution must be module-scoped.**
- `action_type = 'resolve'` = whole cluster resolved → credits ALL modules
  present in the cluster.
- `action_type = 'module_resolved'` = ONE module merged → credits ONLY the
  module derived from the action's `primary_record_id → duplicate_records.record_type`
  (lead/deal/contact/account → Leads/Deals/Contacts/Accounts).

**Why:** a single cluster-scoped `COUNT(*)` over merge actions over-credited
untouched modules in mixed cross-module clusters (e.g. one Accounts merge made
Deals/Contacts/Leads all show as solved). The backfill and the live breakdown
must use the SAME record_type→module CASE mapping or they drift.

**Why the ledger exists:** `duplicate_clusters.status` and
`duplicate_merge_actions` are both reset / cascade-deleted by "Rebuild
Clusters", so before the ledger every rebuild collapsed solved → 0. The ledger
is NOT truncated; because a survivor's Zoho id reappears in whatever cluster it
lands in after a rescan, a per-module ledger match re-credits it.

# Live Zoho writes are env-gated (dev shares prod credentials)

Dev and prod run on SEPARATE Postgres databases but SHARE the same Zoho
credentials. Any non-prod write therefore mutates the REAL CRM org.

**Rule:** every duplicate-radar live-Zoho-write path must funnel through the
single canonical `zohoWritesAllowedInEnv()` in `src/utils/zohoCRM.ts` (leaf
module, no dup-radar imports — keep it there to avoid an executor↔database
import cycle). Gate = `NODE_ENV==='production' OR
RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD==='true'` (the escape hatch is only for a
dedicated non-prod Zoho org).

Known write paths that must stay gated: `executeMergePlan` (apply),
`undoClusterResolution` (removeZohoTags), `bulkCloseLeadsInClusters`
(updateZohoRecord), `tagRecordsForRemovalTool` (addZohoTags). When adding any
new dup-radar Zoho mutation, gate it too — grep for the zoho write helpers
(`updateZohoRecord`, `addZohoTags`, `removeZohoTags`, `addZohoNote`, …) to find
ungated call sites.
