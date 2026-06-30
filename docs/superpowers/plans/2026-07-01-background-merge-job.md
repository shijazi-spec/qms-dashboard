# Background Merge-Apply Job — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the agentic "Apply in Zoho" cluster merge off the synchronous request path into a background job with a pollable status row, so 200+-record merges never hit the 504 Gateway Timeout and the operator sees live progress + what remains.

**Architecture:** A new `merge_jobs` status table; `executeMergePlan` gains an `onProgress` callback; the `/execute` endpoint (real run) inserts a job row, launches an in-process worker without awaiting, and returns a `job_id` immediately; a `GET …/merge-job` endpoint reports progress; the UI polls and renders a progress panel. The merge LOGIC is unchanged — only where/how it runs.

**Tech Stack:** TypeScript (Hono routes, node-postgres), Zoho v2 helpers, vanilla browser JS (`dashboard/js/duplicates-app.js`). Co-located `*.test.ts` run via the `tsc --noCheck` → `/tmp` → `node` trick.

## Global Constraints

- **Merge logic unchanged:** same `buildMergePlan` (`src/utils/duplicateMergePlanner.ts:452`) + `executeMergePlan` (`src/utils/duplicateMergeExecutor.ts:125`); same `Duplicate-Delete` tagging, reparenting, audit, learning capture, "platform never deletes".
- **Dry-run stays synchronous** (default; no writes). Only `confirm === true` goes async.
- **Admin-gated** (`requireAdminOrKey`). **Idempotent/resumable:** `executeMergePlan` already skips already-tagged duplicates.
- **Single PRIMARY instance**, in-process worker (mirror the sync) — no distributed queue.
- **Schema-parity is STRICT:** the new table goes in the canonical schema init in `duplicateRadarDatabase.ts`; run `node scripts/check-schema-parity.mjs --strict`.
- **Verification gates (before each commit):** `node node_modules/typescript/bin/tsc --noEmit`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit`; for UI tasks `node scripts/check-dashboard-html-js.mjs`, `node --check dashboard/js/duplicates-app.js`, i18n JSON parse; co-located tests via the `/tmp` trick.
- **Frontend cache:** bump `duplicates-app.js?v=N` in `dashboard/duplicates.html` on JS change.

## File structure

- **Create `src/utils/mergeJobsDatabase.ts`** — `merge_jobs` CRUD helpers + the pure `mergeJobStatusFor` / `isMergeJobStale` logic.
- **Create `src/utils/mergeJobsDatabase.test.ts`** — co-located tests for the pure logic.
- **Create `src/utils/mergeJobRunner.ts`** — `runMergeJob(jobId)` in-process worker.
- **Modify `src/utils/duplicateRadarDatabase.ts`** — add the `merge_jobs` `CREATE TABLE` + indexes into the schema-init sequence (near the other `await pool.query(\`CREATE TABLE …\`)` blocks, ~line 1094 `duplicate_merge_actions`).
- **Modify `src/utils/duplicateMergeExecutor.ts`** — add `onProgress` to `executeMergePlan` + a small pure throttle helper.
- **Modify `src/mastra/routes/duplicateRadarRoutes.ts`** — `/clusters/:id/execute` async launch (real run) + new `GET /clusters/:id/merge-job`.
- **Modify `dashboard/duplicates.html`, `dashboard/js/duplicates-app.js`, `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`** — progress panel + polling + labels.

---

### Task 1: `merge_jobs` table + helpers + pure status/stale logic

**Files:**
- Create: `src/utils/mergeJobsDatabase.ts`
- Create: `src/utils/mergeJobsDatabase.test.ts`
- Modify: `src/utils/duplicateRadarDatabase.ts` (add `CREATE TABLE merge_jobs` + indexes to the schema-init sequence)

**Interfaces:**
- Produces:
```ts
export interface MergeJob { id: number; cluster_id: number; module: string; status: "queued"|"running"|"done"|"partial"|"failed"; total: number; processed: number; tagged: number; reparented: number; errors: number; error_message: string | null; master_zoho_id: string | null; created_by: string | null; started_at: string | null; last_progress_at: string | null; finished_at: string | null; created_at: string; }
export function mergeJobStatusFor(input: { errors: number; finished: boolean }): "running" | "done" | "partial";
export function isMergeJobStale(job: Pick<MergeJob,"status"|"last_progress_at">, nowMs: number, thresholdMs?: number): boolean;
export async function createMergeJob(input: { clusterId: number; module: string; total: number; masterZohoId: string | null; createdBy: string | null }): Promise<MergeJob>;
export async function updateMergeJobProgress(id: number, p: { processed: number; tagged: number; reparented: number; errors: number }): Promise<void>;
export async function finishMergeJob(id: number, input: { status: "done"|"partial"|"failed"; errorMessage?: string | null }): Promise<void>;
export async function getActiveOrLatestMergeJob(clusterId: number, module: string): Promise<MergeJob | null>;
export async function getMergeJobById(id: number): Promise<MergeJob | null>;
```

- [ ] **Step 1: Write the failing test** — `src/utils/mergeJobsDatabase.test.ts` (plain-assert harness header copied from `src/utils/preflightStructuredPush.test.ts` lines 1-14):

```ts
import assert from "node:assert";
let passed = 0, failed = 0;
function eq(c: boolean, label: string){ if(c){console.log("  ✓ "+label);passed++;} else {console.error("  ✗ "+label);failed++;} }
import { mergeJobStatusFor, isMergeJobStale } from "./mergeJobsDatabase";

eq(mergeJobStatusFor({ errors: 0, finished: false }) === "running", "in-flight → running");
eq(mergeJobStatusFor({ errors: 0, finished: true }) === "done", "finished clean → done");
eq(mergeJobStatusFor({ errors: 3, finished: true }) === "partial", "finished with errors → partial");

const now = 1_000_000;
eq(isMergeJobStale({ status: "running", last_progress_at: new Date(now - 200_000).toISOString() }, now) === true, "running + cold heartbeat → stale");
eq(isMergeJobStale({ status: "running", last_progress_at: new Date(now - 5_000).toISOString() }, now) === false, "running + fresh heartbeat → not stale");
eq(isMergeJobStale({ status: "done", last_progress_at: null }, now) === false, "terminal status never stale");

console.log("mergeJobsDatabase pure logic ok");
if (failed > 0) { console.error(`\n${failed} FAILED`); process.exit(1); }
```

- [ ] **Step 2: Run, expect FAIL** (module not found):
```
rm -rf /tmp/mj && node node_modules/typescript/bin/tsc src/utils/mergeJobsDatabase.ts src/utils/mergeJobsDatabase.test.ts --outDir /tmp/mj --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --noCheck && NODE_PATH='D:\2_QMS Platform\qms-dashboard\node_modules' node /tmp/mj/mergeJobsDatabase.test.js
```

- [ ] **Step 3: Create `src/utils/mergeJobsDatabase.ts`** with the pure logic + DB helpers. Import `pool` the same way other helpers do (check the top of `duplicateRadarDatabase.ts` — it exports `pool`; use `import { pool } from "./duplicateRadarDatabase";`). Pure logic:

```ts
import { pool } from "./duplicateRadarDatabase";

export interface MergeJob { id: number; cluster_id: number; module: string; status: "queued"|"running"|"done"|"partial"|"failed"; total: number; processed: number; tagged: number; reparented: number; errors: number; error_message: string | null; master_zoho_id: string | null; created_by: string | null; started_at: string | null; last_progress_at: string | null; finished_at: string | null; created_at: string; }

const STALE_MS = 90_000;

export function mergeJobStatusFor(input: { errors: number; finished: boolean }): "running" | "done" | "partial" {
  if (!input.finished) return "running";
  return input.errors > 0 ? "partial" : "done";
}

export function isMergeJobStale(job: Pick<MergeJob,"status"|"last_progress_at">, nowMs: number, thresholdMs: number = STALE_MS): boolean {
  if (job.status !== "running") return false;
  if (!job.last_progress_at) return true;
  return nowMs - Date.parse(job.last_progress_at) > thresholdMs;
}

export async function createMergeJob(input: { clusterId: number; module: string; total: number; masterZohoId: string | null; createdBy: string | null }): Promise<MergeJob> {
  const r = await pool.query(
    `INSERT INTO merge_jobs (cluster_id, module, status, total, processed, tagged, reparented, errors, master_zoho_id, created_by, started_at, last_progress_at)
     VALUES ($1,$2,'running',$3,0,0,0,0,$4,$5, NOW(), NOW()) RETURNING *`,
    [input.clusterId, input.module, input.total, input.masterZohoId, input.createdBy],
  );
  return r.rows[0] as MergeJob;
}

export async function updateMergeJobProgress(id: number, p: { processed: number; tagged: number; reparented: number; errors: number }): Promise<void> {
  await pool.query(
    `UPDATE merge_jobs SET processed=$2, tagged=$3, reparented=$4, errors=$5, last_progress_at=NOW() WHERE id=$1`,
    [id, p.processed, p.tagged, p.reparented, p.errors],
  );
}

export async function finishMergeJob(id: number, input: { status: "done"|"partial"|"failed"; errorMessage?: string | null }): Promise<void> {
  await pool.query(
    `UPDATE merge_jobs SET status=$2, error_message=$3, finished_at=NOW(), last_progress_at=NOW() WHERE id=$1`,
    [id, input.status, input.errorMessage ?? null],
  );
}

export async function getActiveOrLatestMergeJob(clusterId: number, module: string): Promise<MergeJob | null> {
  const r = await pool.query(
    `SELECT * FROM merge_jobs WHERE cluster_id=$1 AND module=$2 ORDER BY (status IN ('queued','running')) DESC, created_at DESC LIMIT 1`,
    [clusterId, module],
  );
  return (r.rows[0] as MergeJob) ?? null;
}

export async function getMergeJobById(id: number): Promise<MergeJob | null> {
  const r = await pool.query(`SELECT * FROM merge_jobs WHERE id=$1`, [id]);
  return (r.rows[0] as MergeJob) ?? null;
}
```

- [ ] **Step 4: Add the table to the schema init** in `src/utils/duplicateRadarDatabase.ts`. Find the `await pool.query(\`CREATE TABLE IF NOT EXISTS duplicate_merge_actions (...)\`);` block (~line 1094) and add immediately after it:

```ts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merge_jobs (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      module VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      tagged INTEGER NOT NULL DEFAULT 0,
      reparented INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      master_zoho_id VARCHAR(64),
      created_by VARCHAR(255),
      started_at TIMESTAMPTZ,
      last_progress_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_merge_jobs_cluster ON merge_jobs(cluster_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_merge_jobs_cluster_module_status ON merge_jobs(cluster_id, module, status)`);
```

- [ ] **Step 5: Run, expect PASS** (Step 2 command). Then gates + commit:
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit && node scripts/check-schema-parity.mjs --strict
git add src/utils/mergeJobsDatabase.ts src/utils/mergeJobsDatabase.test.ts src/utils/duplicateRadarDatabase.ts
git commit -m "feat(merge-job): merge_jobs table + helpers + pure status/stale logic"
```

---

### Task 2: `executeMergePlan` progress hook

**Files:**
- Modify: `src/utils/duplicateMergeExecutor.ts` (add `onProgress` option + a pure throttle helper)
- Test: extend `src/utils/mergeJobsDatabase.test.ts`? No — add `src/utils/duplicateMergeExecutor.test.ts` for the pure throttle.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `executeMergePlan(plan, opts)` gains `opts.onProgress?: (p: { processed: number; tagged: number; reparented: number; errors: number }) => void`; and `export function makeProgressThrottle(everyN: number, emit: (n: number) => void): (n: number) => void`.

- [ ] **Step 1: Write the failing test** — `src/utils/duplicateMergeExecutor.test.ts` (harness header as Task 1):

```ts
import assert from "node:assert";
let passed=0, failed=0;
function eq(c:boolean,l:string){ if(c){console.log("  ✓ "+l);passed++;} else {console.error("  ✗ "+l);failed++;} }
import { makeProgressThrottle } from "./duplicateMergeExecutor";

const seen: number[] = [];
const t = makeProgressThrottle(10, (n) => seen.push(n));
for (let i = 1; i <= 25; i++) t(i);
t(25); // final flush is the caller's job; throttle emits on multiples of 10
eq(seen.includes(10) && seen.includes(20), "emits on each 10th");
eq(!seen.includes(5), "does not emit between thresholds");
console.log("executor throttle ok");
if (failed > 0) { console.error(`\n${failed} FAILED`); process.exit(1); }
```

- [ ] **Step 2: Run, expect FAIL** (function not exported):
```
rm -rf /tmp/me && node node_modules/typescript/bin/tsc src/utils/duplicateMergeExecutor.ts src/utils/duplicateMergeExecutor.test.ts --outDir /tmp/me --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --noCheck && NODE_PATH='D:\2_QMS Platform\qms-dashboard\node_modules' node /tmp/me/duplicateMergeExecutor.test.js
```
(If the executor imports many deps, `--noCheck` still emits runnable JS; the test only touches `makeProgressThrottle`.)

- [ ] **Step 3: Add the throttle + wire `onProgress`.** In `src/utils/duplicateMergeExecutor.ts`:
  1. Add the pure helper near the top (after imports):
```ts
export function makeProgressThrottle(everyN: number, emit: (n: number) => void): (n: number) => void {
  let last = 0;
  return (n: number) => { if (n - last >= everyN) { last = n; emit(n); } };
}
```
  2. Read `executeMergePlan`'s signature (line 125) and its options object. Add `onProgress?: (p: { processed: number; tagged: number; reparented: number; errors: number }) => void` to the options type.
  3. Inside the function, maintain running counters (`processed`, `tagged`, `reparented`, `errors`) that already exist as `report.*` accumulators — reuse them. Create `const fire = makeProgressThrottle(10, () => opts.onProgress?.({ processed, tagged: report.taggedRecordIds.length, reparented: report.reparented.deals + report.reparented.contacts + report.reparented.notes, errors: report.errors.length }))`. Call `fire(++processed)` at the end of each per-duplicate iteration in the loops at lines ~242 and ~266. After the loops, call `opts.onProgress?.({...})` once with the final numbers (unconditional final flush). When `opts.onProgress` is undefined (dry-run, tests), nothing changes.
  4. Do **not** alter any Zoho call, tag, or report shape — only add the counter + callback.

- [ ] **Step 4: Run, expect PASS** (Step 2 command). Gates + commit:
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit
git add src/utils/duplicateMergeExecutor.ts src/utils/duplicateMergeExecutor.test.ts
git commit -m "feat(merge-job): executeMergePlan onProgress hook + pure throttle"
```

---

### Task 3: Worker + async endpoint + status endpoint

**Files:**
- Create: `src/utils/mergeJobRunner.ts` (`runMergeJob`)
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (`/clusters/:id/execute` async launch; new `GET /clusters/:id/merge-job`)

**Interfaces:**
- Consumes: Task 1 helpers (`createMergeJob`, `updateMergeJobProgress`, `finishMergeJob`, `getActiveOrLatestMergeJob`, `getMergeJobById`, `mergeJobStatusFor`, `isMergeJobStale`); Task 2 `executeMergePlan(plan, { …, onProgress })`; existing `buildMergePlan` (`duplicateMergePlanner.ts:452`), `getClusterById`/`getRecordsByClusterId` (`duplicateRadarDatabase.ts:3738/3748`), `parseAgenticModule`, `MODULE_RECORD_TYPE`.
- Produces: `export async function runMergeJob(jobId: number): Promise<void>`.

- [ ] **Step 1: Create `src/utils/mergeJobRunner.ts`.** In-memory single-flight set + the worker. Mirror the executor-call block currently in `/execute` (`duplicateRadarRoutes.ts:3690-3754`) — rebuild the plan from live records, run `executeMergePlan` with `onProgress`, then learning capture. No HTTP.

```ts
import { getClusterById, getRecordsByClusterId, getTaggedRecordDbIdsByCluster } from "./duplicateRadarDatabase";
import { buildMergePlan, MODULE_RECORD_TYPE } from "./duplicateMergePlanner";
import { executeMergePlan } from "./duplicateMergeExecutor";
import { getMergeJobById, updateMergeJobProgress, finishMergeJob, mergeJobStatusFor } from "./mergeJobsDatabase";
import { recordResolutionEvent } from "./duplicateResolutionLearning"; // confirm the real module that exports recordResolutionEvent (grep)

const running = new Set<string>();
export function mergeJobKey(clusterId: number, module: string): string { return `${clusterId}::${module}`; }
export function isMergeJobKeyRunning(clusterId: number, module: string): boolean { return running.has(mergeJobKey(clusterId, module)); }

export async function runMergeJob(jobId: number): Promise<void> {
  const job = await getMergeJobById(jobId);
  if (!job) return;
  const key = mergeJobKey(job.cluster_id, job.module);
  if (running.has(key)) return;
  running.add(key);
  try {
    const records = await getRecordsByClusterId(job.cluster_id);
    const recordType = MODULE_RECORD_TYPE[job.module as keyof typeof MODULE_RECORD_TYPE];
    let taggedDbIds: number[] = [];
    try { taggedDbIds = await getTaggedRecordDbIdsByCluster(job.cluster_id); } catch { /* non-fatal */ }
    const plan = buildMergePlan(job.module as any, job.cluster_id, records, {
      tagName: "Duplicate-Delete",
      generatedBy: job.created_by || "duplicate-radar",
      generatedAt: new Date().toISOString(),
      masterZohoId: job.master_zoho_id,
      taggedAccountDbIds: taggedDbIds,
    });
    const isCrossModule = records.some((r) => r.record_type && r.record_type !== recordType);
    const report = await executeMergePlan(plan, {
      performedBy: job.created_by || "admin",
      dryRun: false,
      closeCluster: !isCrossModule,
      onProgress: (p) => { void updateMergeJobProgress(jobId, p); },
    });
    await updateMergeJobProgress(jobId, {
      processed: report.taggedRecordIds.length,
      tagged: report.taggedRecordIds.length,
      reparented: report.reparented.deals + report.reparented.contacts + report.reparented.notes,
      errors: report.errors.length,
    });
    await finishMergeJob(jobId, { status: mergeJobStatusFor({ errors: report.errors.length, finished: true }) });
    try {
      await recordResolutionEvent({ clusterId: job.cluster_id, eventType: "applied", proposedMasterZohoId: plan.masterZohoId, chosenMasterZohoId: plan.masterZohoId, fieldsMigrated: report.fieldsMigrated.length, duplicatesTagged: report.taggedRecordIds.length, reparented: report.reparented.deals + report.reparented.contacts + report.reparented.notes, errors: report.errors.length, plan, report, performedBy: job.created_by || "admin" });
    } catch { /* learning non-fatal */ }
  } catch (e: any) {
    await finishMergeJob(jobId, { status: "failed", errorMessage: e?.message || "merge job failed" });
  } finally {
    running.delete(key);
  }
}
```
Before writing: `grep` for the exact import paths/signatures of `buildMergePlan` options, `MODULE_RECORD_TYPE`, `getTaggedRecordDbIdsByCluster`, `parseAgenticModule`, and `recordResolutionEvent` (the current `/execute` handler imports them — copy those exact import sources). Match the real `buildMergePlan` option names (the `/execute` block at `duplicateRadarRoutes.ts:3692` is the reference — replicate its option keys).

- [ ] **Step 2: Rewire `/clusters/:id/execute`** (`duplicateRadarRoutes.ts:3626`). Keep everything up to and including plan validation. Then:
  - If `dryRun` → unchanged (synchronous preview; do NOT create a job).
  - If real run (`confirm===true`): single-flight — `const existing = await getActiveOrLatestMergeJob(id, module); if (existing && (existing.status==='queued'||existing.status==='running')) return c.json({ job_id: existing.id, status: existing.status, total: existing.total, resumed: true });`. Else `const total = plan.duplicateZohoIds?.length ?? moduleCount - 1;` (use the plan's duplicate count — confirm the field name on the plan object), `const job = await createMergeJob({ clusterId: id, module, total, masterZohoId: plan.masterZohoId, createdBy: (sessionUser as any)?.email || "admin" });` then **launch without awaiting**: `void import("../../utils/mergeJobRunner").then(m => m.runMergeJob(job.id)).catch(() => {});` and `return c.json({ job_id: job.id, status: "running", total }, 202);`. Remove the old inline `await executeMergePlan(...)` + learning block for the real-run path (it now lives in the worker); keep them for nothing else.

- [ ] **Step 3: Add `GET /clusters/:id/merge-job`** (new route object, mirror the file's route-object style). Admin-gated. `?module=` optional (default via `parseAgenticModule` of an empty body, or 'Accounts'). Return:
```ts
const job = await getActiveOrLatestMergeJob(id, module);
if (!job) return c.json({ job: null });
const stale = isMergeJobStale(job, Date.now());
return c.json({ job: { ...job, stale } });
```

- [ ] **Step 4: Gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit
git add src/utils/mergeJobRunner.ts src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(merge-job): async /execute launch + runMergeJob worker + status endpoint"
```

---

### Task 4: UI — progress panel + polling

**Files:**
- Modify: `dashboard/js/duplicates-app.js` (apply handler → launch + poll; resume on cluster open)
- Modify: `dashboard/duplicates.html` (progress panel container in the cluster modal; bump `?v=`)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json` (labels)

**Interfaces:**
- Consumes: `POST /api/duplicates/clusters/:id/execute` → `{ job_id, status, total }`; `GET /api/duplicates/clusters/:id/merge-job?module=<M>` → `{ job: { status, total, processed, tagged, reparented, errors, stale } | null }`.

- [ ] **Step 1: Find the current Apply handler** in `duplicates-app.js` (search the function that POSTs to `/clusters/` + `/execute` with `confirm:true`). Note the cluster id + module it already has in scope.

- [ ] **Step 2: Replace the apply's await-result with launch + poll.** After a successful POST (now returns `{ job_id }` instead of a final report), start polling:
```js
async function _pollMergeJob(clusterId, module, panelEl) {
  for (;;) {
    const r = await fetch('/api/duplicates/clusters/' + clusterId + '/merge-job?module=' + encodeURIComponent(module));
    const j = (await r.json().catch(() => ({}))).job;
    if (!j) { panelEl.textContent = 'No job.'; return; }
    const remaining = Math.max(0, (j.total || 0) - (j.tagged || 0));
    panelEl.innerHTML = '<div class="font-semibold">' +
      (j.status === 'running' ? (j.stale ? '⚠ Stalled — re-apply to continue' : '⏳ Tagging ' + (j.tagged||0) + ' / ' + (j.total||0) + ' · reparented ' + (j.reparented||0) + ' · ' + remaining + ' remaining…')
       : j.status === 'done' ? '✓ Done — tagged ' + (j.tagged||0) + ' / ' + (j.total||0)
       : j.status === 'partial' ? '⚠ Partial — ' + (j.errors||0) + ' error(s); re-apply to finish'
       : '✗ Failed') + '</div>';
    if (j.status !== 'running' || j.stale) return;
    await new Promise((res) => setTimeout(res, 3000));
  }
}
```
Call `_pollMergeJob(clusterId, module, document.getElementById('mergeJobPanel'))` after the launch POST. On **cluster modal open**, also call it once so a job started earlier resumes its panel (guard: only if `GET merge-job` returns a `running` job).

- [ ] **Step 3: Add the panel container** in `dashboard/duplicates.html` inside the cluster modal, near the Apply button: `<div id="mergeJobPanel" class="hidden text-xs bg-gray-50 border rounded p-2 mt-2"></div>` (unhide it when a job starts). Add i18n keys `mj_running`, `mj_done`, `mj_partial`, `mj_failed`, `mj_stalled` to en + ar (or inline English as above and add only a panel title key — keep consistent with the file's i18n usage). Bump `duplicates-app.js?v=`.

- [ ] **Step 4: Gates + commit:**
```
node --check dashboard/js/duplicates-app.js && node scripts/check-dashboard-html-js.mjs && node -e "JSON.parse(require('fs').readFileSync('dashboard/i18n/en.json','utf8'));JSON.parse(require('fs').readFileSync('dashboard/i18n/ar.json','utf8'));console.log('i18n ok')"
git add dashboard/duplicates.html dashboard/js/duplicates-app.js dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(merge-job): progress panel + polling (resumes on cluster open)"
```

---

### Task 5: Final verification + push

- [ ] **Step 1: Full gate run:**
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit && node scripts/check-schema-parity.mjs --strict && node scripts/check-dashboard-html-js.mjs && node --check dashboard/js/duplicates-app.js
```
- [ ] **Step 2: Re-run both co-located tests** (Task 1 & 2 `/tmp` commands) — expect all green.
- [ ] **Step 3: Commit any fixups + push:** `git push`.
- [ ] **Step 4: Manual smoke (post-republish):** open a large cluster (200+), click **Apply in Zoho** (uncheck dry-run) → confirm the request returns instantly, the panel counts up, closing/reopening the modal resumes the panel, and the job reaches Done. Re-clicking Apply on a finished cluster tags nothing new (idempotent).

---

## Self-Review

**Spec coverage:** `merge_jobs` table (Task 1) ✓ · helpers + pure status/stale (Task 1) ✓ · executor `onProgress` (Task 2) ✓ · async `/execute` launch + single-flight (Task 3) ✓ · status endpoint + stale flag (Task 3) ✓ · worker rebuild-from-live + idempotent + audit/learning (Task 3) ✓ · dry-run unchanged (Task 3) ✓ · UI launch/poll/resume (Task 4) ✓ · schema-parity strict (Task 1/5) ✓ · merge logic unchanged (Tasks 2-3 only add a callback + move the call site) ✓.

**Type consistency:** `MergeJob`, `mergeJobStatusFor`, `isMergeJobStale`, `createMergeJob/updateMergeJobProgress/finishMergeJob/getActiveOrLatestMergeJob/getMergeJobById` defined in Task 1 and consumed in Task 3. `executeMergePlan(..., { onProgress })` defined Task 2, used Task 3. `runMergeJob(jobId)` defined Task 3, launched by the endpoint. UI reads the `merge-job` JSON shape produced in Task 3.

**Open items the implementer must resolve by reading code (not guessing):** the exact `buildMergePlan` option keys + the plan's duplicate-count field name (`duplicateZohoIds`?), the real import source of `recordResolutionEvent` and `getTaggedRecordDbIdsByCluster`/`parseAgenticModule`/`MODULE_RECORD_TYPE`, and the current Apply handler name in `duplicates-app.js`. All are present in the existing `/execute` handler (`duplicateRadarRoutes.ts:3617-3756`) — copy from there.
