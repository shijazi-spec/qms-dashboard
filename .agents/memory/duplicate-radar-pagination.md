---
name: Duplicate Radar record-tab pagination
description: The record-tab duplicate views must paginate by cluster, not by record, or the tail of clusters becomes unreachable.
---

# Duplicate Radar record-tab pagination

The `/api/duplicates/{leads,deals,contacts,accounts}` record tabs group records
into duplicate clusters and display one card per cluster. The shared
`getDuplicateRecordsByType` query MUST paginate on the **cluster** as the unit,
and the `pages`/`total` count MUST be computed on the same cluster predicate
used to select the page.

**Why:** a past bug paginated `LIMIT/OFFSET` over individual `duplicate_records`
rows while computing `pages` from the DISTINCT cluster count. Because every
duplicate cluster holds >=2 records, record-pages always outnumber the reported
cluster-page count, so the low-confidence tail of clusters was unreachable
(~half hidden in practice) and clusters straddling a page boundary fragmented
into partial groups. Users reported "there are more duplicates than this".

**How to apply:** whenever a paginated view counts/displays a coarser unit
(clusters/groups) than the rows it pages over, the LIMIT/OFFSET and the total
count must both operate on that coarser unit. Select the page of cluster ids
first, then fetch ALL in-scope member rows for exactly those ids
(`cluster_id = ANY($ids::int[])`). Keep the page-selection predicate and the
count predicate identical so `ceil(total/limit)` matches what is rendered.
