/**
 * Auto-create CAPA records for high-impact CS-overlap BLOCK clusters.
 *
 * When the nightly CS-overlap scan finds a cluster whose verdict is BLOCK
 * (active Customer Success customer being mistakenly re-pitched) AND whose
 * aggregated ARR exposure exceeds a configurable threshold, we open a CAPA
 * automatically. This closes the loop from "we detected the leak" to "we
 * have a tracked corrective action" — Quality no longer has to manually
 * cross-reference dashboards.
 *
 * Idempotency: every CAPA gets `source_type='cs_overlap_block'` and
 * `source_id='cs_overlap_cluster:<cluster_id>'`. Before creating a new one
 * we check whether an open/in-progress CAPA already exists with the same
 * source_id; if it does, we skip. This means the cron is safe to run
 * repeatedly without duplicating tracked actions.
 *
 * All knobs are env-configurable so Quality can tune the threshold without
 * a redeploy:
 *
 *   AUTO_CAPA_GLOBAL_ENABLED          (default 'false' — MASTER switch; while
 *                                      false, NO auto-CAPA runs anywhere. Set
 *                                      'true' to resume once the platform is ready.)
 *   AUTO_CAPA_ON_BLOCK_ENABLED        (default 'true', only applies once global is on)
 *   AUTO_CAPA_ARR_THRESHOLD_SAR       (default '1000000' — 1M SAR)
 *   AUTO_CAPA_DEFAULT_ASSIGNEE        (optional; left blank by default)
 *   AUTO_CAPA_TARGET_DAYS             (default '7' — 1-week target close)
 */

import { pool, type DuplicateCluster } from "./duplicateRadarDatabase";
import { createCapaRecord } from "./qmsDatabase";
import { logger } from "./logger";

export interface AutoCapaResult {
  enabled: boolean;
  threshold_sar: number;
  candidates: number;
  created: number;
  skipped_existing: number;
  failed: number;
  capa_numbers: string[];
}

interface BlockCluster {
  id: number;
  domain: string;
  company_name: string | null;
  company_name_arabic: string | null;
  arr_exposure: number;
  pipeline_lifecycle_state: string | null;
  client_sector: string | null;
  total_records: number;
}

const SOURCE_TYPE = "cs_overlap_block";
const SOURCE_ID_PREFIX = "cs_overlap_cluster";

function clusterSourceId(clusterId: number): string {
  return `${SOURCE_ID_PREFIX}:${clusterId}`;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Returns true if an open or in-progress CAPA already exists for this cluster.
 * "Open" here means status not in {closed, cancelled} — we don't want to
 * suppress new CAPAs once an old one has been closed (the situation may have
 * recurred, which is a fresh corrective action).
 */
async function existingOpenCapa(clusterId: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1
       FROM capa_records
      WHERE source_type = $1
        AND source_id   = $2
        AND status NOT IN ('closed', 'cancelled')
      LIMIT 1`,
    [SOURCE_TYPE, clusterSourceId(clusterId)],
  );
  return r.rows.length > 0;
}

function severityForArr(arr: number, threshold: number): "critical" | "major" {
  return arr >= threshold * 2 ? "critical" : "major";
}

function buildCapaTitle(c: BlockCluster): string {
  const name = c.company_name || c.company_name_arabic || c.domain;
  return `CS Overlap BLOCK: ${name} pursued as new lead despite active Customer Success deal`;
}

function buildCapaDescription(c: BlockCluster): string {
  const phase = c.pipeline_lifecycle_state
    ? c.pipeline_lifecycle_state.replace(/_/g, " ")
    : "active";
  const arrFmt = c.arr_exposure
    ? `SAR ${Number(c.arr_exposure).toLocaleString()}`
    : "(no ARR captured)";
  return [
    `Domain: ${c.domain}`,
    `Account: ${c.company_name || c.company_name_arabic || "—"}`,
    `Sector: ${c.client_sector || "unknown"}`,
    `CS lifecycle state: ${phase}`,
    `ARR exposure: ${arrFmt}`,
    `Duplicate records in cluster: ${c.total_records}`,
    "",
    "The Duplicate Radar detected new lead/deal records on the same domain as an",
    "active Customer Success customer. Pushing this account through SDR / Sales",
    "while CS is engaged risks customer-facing conflict, internal price-war,",
    "and double-tracked pipeline. Treat this as a process failure on intake",
    "deduplication.",
    "",
    "Investigation: confirm batch source, whether preflight was run, and which",
    "team imported the duplicate records. Corrective action: remove the new",
    "lead/deal rows, document the source, and update the marketing intake",
    "checklist. Preventive action: run preflight on every batch before push;",
    "consider hardening the source-of-truth check upstream.",
  ].join("\n");
}

/**
 * Create CAPAs for clusters whose `cs_overlap_verdict='block'` AND whose
 * `arr_exposure` is at or above the configured threshold.
 *
 * Returns a summary including the CAPA numbers actually created.
 */
export async function autoOpenCapasForBlockClusters(opts: {
  /** Override the env-default threshold. */
  thresholdSar?: number;
  /** Override the env-default enabled flag. */
  enabled?: boolean;
  /** Override default created_by attribution. */
  createdBy?: string;
}): Promise<AutoCapaResult> {
  // GLOBAL kill-switch (shared with csLifecycleAutoCapa): all auto-CAPA stays
  // OFF until AUTO_CAPA_GLOBAL_ENABLED=true. Default false while the platform is
  // being prepared. Overrides opts.enabled so no caller can bypass the freeze.
  const enabled =
    envBool("AUTO_CAPA_GLOBAL_ENABLED", false) &&
    (opts.enabled ?? envBool("AUTO_CAPA_ON_BLOCK_ENABLED", true));
  const threshold =
    opts.thresholdSar ?? envNumber("AUTO_CAPA_ARR_THRESHOLD_SAR", 1_000_000);
  const assignee = process.env.AUTO_CAPA_DEFAULT_ASSIGNEE || undefined;
  const targetDays = Math.max(1, envNumber("AUTO_CAPA_TARGET_DAYS", 7));
  const createdBy = opts.createdBy || "duplicate-radar:cs-overlap-auto";

  const result: AutoCapaResult = {
    enabled,
    threshold_sar: threshold,
    candidates: 0,
    created: 0,
    skipped_existing: 0,
    failed: 0,
    capa_numbers: [],
  };

  if (!enabled) {
    logger.info("[AutoCapa] disabled via env; skipping");
    return result;
  }

  const r = await pool.query<BlockCluster>(
    `SELECT id, domain, company_name, company_name_arabic,
            COALESCE(arr_exposure, 0)::float AS arr_exposure,
            pipeline_lifecycle_state, client_sector, total_records
       FROM duplicate_clusters
      WHERE cs_overlap_verdict = 'block'
        AND status = 'active'
        AND COALESCE(arr_exposure, 0) >= $1`,
    [threshold],
  );
  result.candidates = r.rows.length;
  if (result.candidates === 0) return result;

  for (const cluster of r.rows) {
    try {
      if (await existingOpenCapa(cluster.id)) {
        result.skipped_existing++;
        continue;
      }
      const target = new Date(Date.now() + targetDays * 86400 * 1000);
      const capa = await createCapaRecord({
        title: buildCapaTitle(cluster),
        description: buildCapaDescription(cluster),
        capa_type: "corrective",
        source_type: SOURCE_TYPE,
        source_id: clusterSourceId(cluster.id),
        source_reference: cluster.domain,
        severity: severityForArr(cluster.arr_exposure, threshold),
        status: "open",
        priority:
          cluster.arr_exposure >= threshold * 2 ? "critical" : "high",
        assigned_to: assignee,
        target_date: target,
        metadata: {
          source: "cs_overlap_auto",
          cluster_id: cluster.id,
          arr_exposure: cluster.arr_exposure,
          arr_threshold: threshold,
          client_sector: cluster.client_sector,
          pipeline_lifecycle_state: cluster.pipeline_lifecycle_state,
        },
        created_by: createdBy,
      } as Omit<
        Parameters<typeof createCapaRecord>[0],
        "id" | "capa_number" | "created_at" | "updated_at"
      >);
      result.created++;
      if (capa.capa_number) result.capa_numbers.push(capa.capa_number);
      logger.info("[AutoCapa] created", {
        capa_number: capa.capa_number,
        cluster_id: cluster.id,
        domain: cluster.domain,
        arr: cluster.arr_exposure,
      });
    } catch (err) {
      result.failed++;
      logger.warn("[AutoCapa] failed for cluster", {
        cluster_id: cluster.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export const AUTO_CAPA_SOURCE_TYPE = SOURCE_TYPE;
export const AUTO_CAPA_SOURCE_ID_PREFIX = SOURCE_ID_PREFIX;
export { clusterSourceId };

// Silence unused-import lint when this file is consumed only for its named exports
export type _ClusterShape = DuplicateCluster;
