# Background merge-apply job — Design

**Date:** 2026-07-01
**Owner:** Ahmad Amashah (with Adam — GRQ Assistant)
**Status:** Approved, pending implementation plan

## Problem

`POST /api/duplicates/clusters/:id/execute` ("Apply in Zoho") runs the whole agentic
merge **synchronously in one HTTP request**. `executeMergePlan`
(`src/utils/duplicateMergeExecutor.ts`) loops over every duplicate one at a time — update
the record, fetch + reparent each child Deal/Contact, copy notes, then tag — so a
241-duplicate cluster fires hundreds of sequential Zoho calls and runs past the proxy's
~60s limit → **504 Gateway Timeout**. The app keeps running after the proxy gives up, so
records get partially tagged but no response returns, leaving the operator unable to tell
what was done or what remains.

## Goal

Move the real apply to a **background job** (mirrors the existing sync: in-process worker +
a status row polled by the UI). The request returns instantly; the operator watches live
progress ("tagged X / N · Y remaining") and the merge **never times out** regardless of
cluster size. Idempotent and resumable — re-applying continues from what is not yet tagged.

## The merge logic does NOT change

Same plan, same survivor selection, same field migration, same reparenting, same
`Duplicate-Delete` tagging, same audit + learning capture, same "never deletes". Only
**where/how** it runs changes (async + progress). Dry-run is unchanged.

## Components

### 1. `merge_jobs` table (new)
One row per real apply. Columns: `id` (PK), `cluster_id`, `module`, `status`
(`queued|running|done|partial|failed`), `total`, `processed`, `tagged`, `reparented`,
`errors`, `error_message`, `master_zoho_id`, `created_by`, `started_at`,
`last_progress_at`, `finished_at`, `created_at`. Indexes on `cluster_id` and
`(cluster_id, module, status)`. Added to the canonical schema init (strict schema-parity).
Helpers (in `duplicateRadarDatabase.ts` or a focused `mergeJobsDatabase.ts`):
`createMergeJob`, `updateMergeJobProgress` (throttled), `finishMergeJob`
(done/partial/failed), `getActiveOrLatestMergeJob(clusterId, module)`, `getMergeJobById`.

### 2. Executor progress hook
Add an optional `onProgress?: (p: { processed; tagged; reparented; errors }) => void` to
`executeMergePlan`. The existing per-duplicate loops call it periodically (every record or
small batch). No behavior change when the callback is absent (dry-run, tests). Keep the
batched `addZohoTags` (100/call); where the per-duplicate field-blank update is bulk-able,
batch it too so each job finishes faster.

### 3. Endpoint changes — `/clusters/:id/execute`
- **Real run (`confirm === true`):** build + validate the plan (server-side, as today),
  insert a `merge_jobs` row (`queued`), **launch the worker without awaiting**, return
  `{ job_id, status: 'queued', total }` immediately (HTTP 202). No inline Zoho writes.
- **Single-flight:** if an active (`queued|running`, non-stale) job already exists for this
  `cluster + module`, return that `job_id` instead of starting a second.
- **Dry-run (default):** unchanged — synchronous, no writes, returns the plan preview.
- Still `requireAdminOrKey`.

### 4. Worker — `runMergeJob(jobId)`
In-process async (same pattern as the sync worker). Marks `running`, **rebuilds the plan
from live records** (never trusts a stale plan), runs `executeMergePlan` with
`onProgress → updateMergeJobProgress` (throttled, ~every 10 records, stamps
`last_progress_at`). On completion: `done` (no errors) or `partial` (some per-record
errors); on throw: `failed` + `error_message`. Carries the existing learning-capture +
audit, moved inside the worker. Idempotent: `executeMergePlan` already skips
already-tagged duplicates, so a re-run continues from what remains.

### 5. Status endpoint — `GET /clusters/:id/merge-job` (optional `?module=`)
Returns the active-or-latest job row plus a derived `stale` flag (`status === 'running'`
but `last_progress_at` older than ~90s → worker likely died on a restart). Lets the UI show
"stalled — re-apply to continue" instead of a forever-spinner.

### 6. UI
"Apply in Zoho" → POST execute → receive `job_id` → show a progress panel that polls the
status endpoint every ~3s: **"Tagging 120 / 241 · reparented 38 · 121 remaining…"** →
"Done" / "Partial — N errors, re-apply to finish" / "Stalled — re-apply". **Survives
navigation:** the job is server-side, so on reopening the cluster the UI fetches the
latest job and resumes the panel if it is still running. Reuses the empty-records AI-Apply
progress pattern. Bump `duplicates-app.js?v=`.

## Edge cases & safety

- **Multi-module cluster:** one module resolved per apply (`closeCluster=false`),
  unchanged. The job is keyed by `cluster + module`.
- **Restart mid-job:** `running` + cold `last_progress_at` → `stale` in the status; the
  operator re-applies, which skips already-tagged and continues (idempotent).
- **Concurrency:** applies are admin-triggered and low-volume; one running job per
  cluster+module is enough (no distributed queue — single PRIMARY instance, like sync).
- **Never deletes**; create/tag/reparent only; full audit preserved.

## Testing

- `merge_jobs` helpers: create → update progress → finish (done/partial/failed) →
  get-active-or-latest returns the right row; stale derivation.
- `executeMergePlan` `onProgress`: with the Zoho writers stubbed, assert the callback fires
  with non-decreasing `processed`/`tagged`.
- Endpoint: `confirm:true` returns a `job_id` without performing inline writes (worker
  stubbed); `dry_run` stays synchronous and returns the preview.
- Gates: `tsc` ×2, **schema-parity strict**, dashboard html/js, i18n JSON, JS `--check`.

## Non-goals

- No change to the merge/plan logic, tagging, or deletion policy.
- No distributed/multi-instance queue (in-process worker on the PRIMARY instance).
- No change to dry-run.

## Rollout

Additive `merge_jobs` table (in CREATE-TABLE init) + endpoint/worker + UI. No destructive
migration. Deploy via the Replit publish pipeline; republish to pick up. Optional: a Slack
ping to `#grq-platform-assistant` on job completion (reuses the existing notifier).
