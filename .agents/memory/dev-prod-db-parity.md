---
name: Dev/prod DB parity
description: How dev workspace mirrors production DB tables — manual one-shot procedure via executeSql, and the nightly Inngest cron at workflows/prodToDevSyncCron.ts. Captures argv-limit, live-write, and partition gotchas that bit this sync.
---

## Why this exists
Dev workspace preview pane is meaningless if its DB is empty. We mirror a fixed set of business tables from production. There is **no** built-in Replit mechanism for dev↔prod data mirroring; Publish copies schema only.

## Two paths

1. **Manual one-shot** — `executeSql({environment:"production"})` to dump, `executeSql({})` (dev) to load. See gotchas below.
2. **Nightly cron** — `src/mastra/workflows/prodToDevSyncCron.ts`, registered in `src/mastra/inngest/index.ts`. Connects via `PROD_DATABASE_URL` secret (dev-side). Fail-closed guard refuses to run when `NODE_ENV==="production"`, when `PROD_DATABASE_URL` is unset, or when it equals `DATABASE_URL`.

**Why fail-closed in prod:** the job TRUNCATEs every table in its list before reloading. If it ever ran in production it would erase the production data it's supposed to be copying. The guard is the only thing standing between "nightly sync" and "nightly data loss." Do not weaken it.

## Gotchas the manual procedure hit (avoid in any future tooling)

- **executeSql output is CSV-escaped.** A jsonb dump comes back wrapped: `"..."` with embedded `""` for each `"`. Strip header line, then `s.slice(1,-1).replace(/""/g,'"')` before `JSON.parse`. Forgetting this gives silent JSON parse errors that look like "ROLLBACK".
- **executeSql spawn hits E2BIG at ~128 KB.** Both the SQL string argv AND the result output count against the limit. Rows with large jsonb columns (e.g. `quality_audit_results.raw_audit_data` at 216 KB) cannot be transferred even one-at-a-time. Mitigation: select with `NULL::jsonb AS raw_audit_data` and accept losing the blob (dashboard fields don't use it). The cron file does this declaratively via `nullColumns` in its `TABLES` spec.
- **Keep chunks small enough that `avg_row_bytes × chunk × 2` (CSV-escape overhead) < ~100 KB.** Rule of thumb: chunk = 100 for ~600B rows, 300 for ~200B rows, 1000 for ~70B rows. **Why:** the CSV escaping roughly doubles the JSON output size, and that doubled output is what gets spawned.
- **Keyset pagination must use the actual PK.** `rate_limit_buckets` PK is composite `(key, window_start)`; cursor on `key` alone loops because many rows share a key. Use OFFSET pagination or full composite cursor for composite-PK tables.
- **Live writes break keyset resume.** If a scanner writes new rows to the target table during sync, dev `MAX(id)` can leap past prod's `MAX(id)` and the loop never goes back to fill the gap. Snapshot `PROD_MAX_ID` up front and bound the loop with `WHERE id <= PROD_MAX_ID` (or just track cursor as a local variable, not derived from dev MAX).
- **TRUNCATE needs `SET LOCAL session_replication_role = replica`** when other tables reference the target via FK (e.g. `duplicate_records.cluster_id → duplicate_clusters.id`). Same for the matching DELETE if you ever try to clean up dev-only overflow rows.
- **`event_logs` is a partition parent with no direct storage.** `pg_total_relation_size('event_logs')` returns 0. Iterate children (`event_logs_yYYYYmMM`) explicitly, not the parent. The cron's `TABLES` list enumerates child partitions for the same reason.
- **Telemetry tables drift continuously.** `rate_limit_buckets` gets written on every request; `ai_alerts` and `event_logs` are append-only. A copy is stale within minutes. Acceptable for "morning snapshot" goal but don't chase exact counts — `devRows >= prodRows` is the success criterion in the cron, not equality.

## Adding/removing a table
Edit `TABLES` in `src/mastra/workflows/prodToDevSyncCron.ts`. For tables with large blob columns, set `nullColumns: [...]`. For composite-PK tables, set `useOffset: true`.
