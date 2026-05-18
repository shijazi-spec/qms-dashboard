/**
 * Promote synthetic cluster domains to authoritative ones using the
 * CS team's `Company_Domain` field on Deal records.
 *
 * Background: the Duplicate Radar builds a cluster from whatever signal is
 * available — domain (best), phone, or company-name match. When neither
 * a real email/website was present on any record nor a domain could be
 * inferred, the cluster is anchored on a synthetic placeholder like
 * `<slug>.cluster` or `<slug>` derived from the company name. These are
 * still legitimate duplicate clusters but their `domain` field is not
 * comparable to incoming marketing batches.
 *
 * Now that CS curates `Company_Domain` at Onboarding handoff, we can walk
 * each synthetic cluster, look at the Deal records inside, and — when at
 * least one Deal exposes a real `Company_Domain` — promote the cluster's
 * domain to that authoritative value. Marketing preflight checks and the
 * CS overlap detector then match correctly on a real domain.
 *
 * Safety:
 *   - Only rewrites when the existing cluster.domain ends with `.cluster`
 *     OR (optionally) when it doesn't look like a real domain at all.
 *   - If multiple Deals in the same cluster expose CONFLICTING
 *     Company_Domain values, the cluster is left alone and flagged as
 *     `conflict` in the result (human triage needed).
 *   - If the proposed authoritative domain already belongs to another
 *     cluster, this helper does NOT auto-merge. It reports the collision
 *     so an operator can resolve via the existing merge workflow.
 *
 * Idempotent: safe to re-run. Clusters already on a real domain are
 * skipped; clusters with no Deal-side Company_Domain are skipped.
 */

import { pool } from "./duplicateRadarDatabase";
import { extractCsFieldsFromRawData } from "./duplicateRadarCsOverlap";
import { logger } from "./logger";

export type DomainReconcileOutcome =
  | "skipped_already_real"
  | "skipped_no_company_domain"
  | "skipped_conflict"
  | "skipped_collision_existing_cluster"
  | "renamed";

export interface DomainReconcileRow {
  cluster_id: number;
  previous_domain: string;
  proposed_domain: string | null;
  outcome: DomainReconcileOutcome;
  detail?: string;
}

export interface DomainReconcileSummary {
  scanned: number;
  renamed: number;
  conflicts: number;
  collisions: number;
  no_company_domain: number;
  already_real: number;
  rows: DomainReconcileRow[];
  duration_ms: number;
}

/** A domain that looks like a Radar-synthesized placeholder. */
function isSyntheticDomain(d: string | null | undefined): boolean {
  if (!d) return true;
  const s = String(d).trim().toLowerCase();
  if (!s) return true;
  if (s.endsWith(".cluster")) return true;
  // Treat anything without a dot as synthetic too (raw company-name slug).
  if (!s.includes(".")) return true;
  return false;
}

function normalizeProposed(d: string | null): string | null {
  if (!d) return null;
  const s = d.trim().toLowerCase();
  if (!s) return null;
  // Strip leading protocol / www.
  return s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!
    .trim() || null;
}

export async function reconcileSyntheticClusterDomains(opts: {
  dryRun?: boolean;
  /** Limit how many clusters to examine — defaults to all synthetic ones. */
  limit?: number;
} = {}): Promise<DomainReconcileSummary> {
  const t0 = Date.now();
  const dryRun = !!opts.dryRun;
  const limit = Math.max(1, Math.min(opts.limit ?? 5000, 20000));

  // Pull every cluster whose stored domain looks synthetic. We intentionally
  // do the filter in JS so the heuristic stays centralized (isSyntheticDomain)
  // rather than baked into SQL.
  const clusterRows = await pool.query<{
    id: number;
    domain: string;
  }>(
    `SELECT id, domain
       FROM duplicate_clusters
      WHERE status = 'active'
      ORDER BY id ASC
      LIMIT $1`,
    [limit],
  );
  const synthetic = clusterRows.rows.filter((r) => isSyntheticDomain(r.domain));

  const summary: DomainReconcileSummary = {
    scanned: synthetic.length,
    renamed: 0,
    conflicts: 0,
    collisions: 0,
    no_company_domain: 0,
    already_real: clusterRows.rows.length - synthetic.length,
    rows: [],
    duration_ms: 0,
  };

  for (const cluster of synthetic) {
    const dealsR = await pool.query<{
      id: number;
      raw_data: unknown;
    }>(
      `SELECT id, raw_data
         FROM duplicate_records
        WHERE cluster_id = $1
          AND zoho_module = 'Deals'`,
      [cluster.id],
    );

    const candidates = new Set<string>();
    for (const d of dealsR.rows) {
      const fields = extractCsFieldsFromRawData(d.raw_data, null as any);
      const cd = normalizeProposed(fields.company_domain ?? null);
      if (cd) candidates.add(cd);
    }

    if (candidates.size === 0) {
      summary.no_company_domain++;
      summary.rows.push({
        cluster_id: cluster.id,
        previous_domain: cluster.domain,
        proposed_domain: null,
        outcome: "skipped_no_company_domain",
      });
      continue;
    }

    if (candidates.size > 1) {
      summary.conflicts++;
      summary.rows.push({
        cluster_id: cluster.id,
        previous_domain: cluster.domain,
        proposed_domain: null,
        outcome: "skipped_conflict",
        detail: `Deals disagree: ${Array.from(candidates).join(", ")}`,
      });
      continue;
    }

    const proposed = Array.from(candidates)[0]!;

    // Check collision with an existing cluster on the authoritative domain.
    const collisionR = await pool.query<{ id: number }>(
      `SELECT id FROM duplicate_clusters
        WHERE domain = $1 AND id <> $2 AND status = 'active'
        LIMIT 1`,
      [proposed, cluster.id],
    );
    if (collisionR.rows.length > 0) {
      summary.collisions++;
      summary.rows.push({
        cluster_id: cluster.id,
        previous_domain: cluster.domain,
        proposed_domain: proposed,
        outcome: "skipped_collision_existing_cluster",
        detail: `Another active cluster already uses domain "${proposed}" (id=${collisionR.rows[0]!.id}). Merge manually.`,
      });
      continue;
    }

    if (!dryRun) {
      await pool.query(
        `UPDATE duplicate_clusters
            SET domain = $1, updated_at = NOW()
          WHERE id = $2`,
        [proposed, cluster.id],
      );
      // Also update the per-record domain column where it's currently empty
      // or synthetic-looking, so cluster lookups by domain join cleanly.
      await pool.query(
        `UPDATE duplicate_records
            SET domain = $1
          WHERE cluster_id = $2
            AND (domain IS NULL OR domain = '' OR domain LIKE '%.cluster' OR domain NOT LIKE '%.%')`,
        [proposed, cluster.id],
      );
    }
    summary.renamed++;
    summary.rows.push({
      cluster_id: cluster.id,
      previous_domain: cluster.domain,
      proposed_domain: proposed,
      outcome: "renamed",
    });
  }

  summary.duration_ms = Date.now() - t0;
  logger.info("[domainReconcile] complete", {
    scanned: summary.scanned,
    renamed: summary.renamed,
    conflicts: summary.conflicts,
    collisions: summary.collisions,
    duration_ms: summary.duration_ms,
    dry_run: dryRun,
  });
  return summary;
}

// Exported for tests
export { isSyntheticDomain, normalizeProposed };
