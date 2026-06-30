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
