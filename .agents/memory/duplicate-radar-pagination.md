---
name: Duplicate Radar pagination invariants
description: Duplicate Radar must paginate by CLUSTER on both server and client; row-based paging and exact-key client re-bucketing both cause unreachable/empty pages
---

# Duplicate Radar pagination invariants

Two related, easy-to-regress pagination bugs live in this feature
(`dashboard/duplicates.html` + `src/utils/duplicateRadarDatabase.ts`).

## 1. Paginate by cluster, not by row (server)

The record tabs group records into duplicate **clusters**, so the unit of
pagination must be the cluster. An earlier implementation applied LIMIT/OFFSET
to individual `duplicate_records` rows while computing page count from the
DISTINCT cluster total. Because every cluster holds ≥2 records, there were
always more record-pages than the reported cluster-page count, so the
low-confidence tail of clusters was unreachable and clusters straddling a page
boundary were split. Fix: select the page of cluster ids first, then fetch ALL
in-scope records for exactly those clusters (count query and cluster-page SELECT
must use identical filters so server count/rows stay consistent).

## 2. Client display unit must not be narrower than the cluster (client)

The client render functions (`renderAccountRows`, etc.) re-group the page's
records with `_dupBuckets()`, a union-find that only keeps buckets where 2+
records share an **exactly-equal** normalized field (name/email/phone/website/
CRM-ID) — `filter(idxs => idxs.length >= 2)`.

**The trap:** account clusters are often **fuzzy-name** matches with no
exactly-equal field. Those clusters are counted/paginated by the server but
dropped client-side, so whole pages render empty ("No duplicate accounts
detected on this page") even though the pager reports thousands of groups.
Worst on the large "Untouched" pool; small already-actioned pools
(AI-Applied/Resolved/Dismissed) look fine because they're mostly exact matches —
which masks the bug.

**Fix pattern:** pass `_dupBuckets` a bucket-extractor that also unions by the
server's `cluster_id` (`_cluster: r => r.cluster_id != null ? 'cid:'+r.cluster_id : ''`),
so every server-counted cluster forms a bucket. Keep `_dupCounts` /
`_dupGroupSummary` on the clean extractors so signal chips/counts stay correct.
Currently applied to accounts only; the same fix may be needed on other tabs if
they show empty pages.

**Why (both):** the display/pagination unit must be the cluster end-to-end. If
either layer uses a finer unit (rows server-side, or exact-key groups
client-side) than the cluster count, count > reachable/rendered groups and pages
go blank or become unreachable.
