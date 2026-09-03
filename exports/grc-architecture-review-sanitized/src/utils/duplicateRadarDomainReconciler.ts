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
  | "<REDACTED_TOKEN>"
  | "<REDACTED_TOKEN>"
  | "<REDACTED_TOKEN>"
  | "<REDACTED_TOKEN>"
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
          AND CRMProvider_module = 'Deals'`,
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
        outcome: "<REDACTED_TOKEN>",
      });
      continue;
    }

    if (candidates.size > 1) {
      summary.conflicts++;
      summary.rows.push({
        cluster_id: cluster.id,
        previous_domain: cluster.domain,
        proposed_domain: null,
        outcome: "<REDACTED_TOKEN>",
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
        outcome: "<REDACTED_TOKEN>",
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

// ─── Collision triage ────────────────────────────────────────────────────────
//
// When reconcileSyntheticClusterDomains() finds a synthetic cluster whose
// proposed authoritative domain is already owned by another active cluster,
// it logs `<REDACTED_TOKEN>` and stops — auto-merging is
// too destructive without operator judgment. These helpers expose the
// collisions for review and let an operator resolve them by merging the
// synthetic cluster INTO the authoritative one.

export interface CollisionPair {
  synthetic: {
    cluster_id: number;
    domain: string;
    company_name: string | null;
    total_records: number;
  };
  authoritative: {
    cluster_id: number;
    domain: string;
    company_name: string | null;
    total_records: number;
  };
  proposed_domain: string;
}

/**
 * Re-runs reconcile in dry-run mode and returns just the collision rows,
 * enriched with both clusters' record counts and company names so an
 * operator can decide which to keep.
 */
export async function listDomainReconcileCollisions(
  opts: { limit?: number } = {},
): Promise<{ collisions: CollisionPair[]; scanned: number }> {
  const summary = await reconcileSyntheticClusterDomains({
    dryRun: true,
    limit: opts.limit,
  });
  const collisionRows = summary.rows.filter(
    (r) => r.outcome === "<REDACTED_TOKEN>",
  );
  if (collisionRows.length === 0) {
    return { collisions: [], scanned: summary.scanned };
  }

  // The detail string holds the authoritative id like:
  //   `Another active cluster already uses domain "x" (id=42). Merge manually.`
  // Extract it rather than re-querying by domain (a domain could match more
  // than one row if data is weird; the reconciler picked exactly one).
  const idDetailRe = /\(id=(\d+)\)/;
  const ids = new Set<number>();
  const parsed: Array<{
    syntheticId: number;
    authoritativeId: number;
    proposed: string;
  }> = [];
  for (const r of collisionRows) {
    const m = r.detail?.match(idDetailRe);
    if (!m || !r.proposed_domain) continue;
    const authoritativeId = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(authoritativeId)) continue;
    parsed.push({
      syntheticId: r.cluster_id,
      authoritativeId,
      proposed: r.proposed_domain,
    });
    ids.add(r.cluster_id);
    ids.add(authoritativeId);
  }
  if (parsed.length === 0) {
    return { collisions: [], scanned: summary.scanned };
  }

  const meta = await pool.query<{
    id: number;
    domain: string;
    company_name: string | null;
    total_records: number;
  }>(
    `SELECT id, domain, company_name, total_records
       FROM duplicate_clusters
      WHERE id = ANY($1::int[])`,
    [Array.from(ids)],
  );
  const metaById = new Map(meta.rows.map((r) => [r.id, r]));

  const collisions: CollisionPair[] = [];
  for (const p of parsed) {
    const s = metaById.get(p.syntheticId);
    const a = metaById.get(p.authoritativeId);
    if (!s || !a) continue;
    collisions.push({
      synthetic: {
        cluster_id: s.id,
        domain: s.domain,
        company_name: s.company_name,
        total_records: s.total_records,
      },
      authoritative: {
        cluster_id: a.id,
        domain: a.domain,
        company_name: a.company_name,
        total_records: a.total_records,
      },
      proposed_domain: p.proposed,
    });
  }
  return { collisions, scanned: summary.scanned };
}

export interface MergeCollisionResult {
  synthetic_cluster_id: number;
  authoritative_cluster_id: number;
  records_moved: number;
  authoritative_total_records: number;
}

/**
 * Merge a synthetic-domain cluster INTO an authoritative one. Used to resolve
 * domain-reconcile collisions where the synthetic cluster's proposed domain
 * is already owned. All records from the synthetic cluster are reparented;
 * the synthetic cluster is marked `merged` (preserving history) rather than
 * deleted.
 *
 * Validation:
 *   - Synthetic cluster must exist, be active, and currently have a
 *     synthetic-looking domain (operator can't accidentally collapse two
 *     real-domain clusters via this path).
 *   - Authoritative cluster must exist and be active.
 *   - The two cluster ids must differ.
 *
 * Records the action in `duplicate_merge_actions` with action_type
 * `domain_collision_merge` so the merge history view surfaces it.
 */
export async function mergeSyntheticIntoAuthoritative(opts: {
  syntheticClusterId: number;
  authoritativeClusterId: number;
  performedBy: string;
  notes?: string;
}): Promise<MergeCollisionResult> {
  const { syntheticClusterId, authoritativeClusterId, performedBy } = opts;
  if (syntheticClusterId === authoritativeClusterId) {
    throw new Error("syntheticClusterId and authoritativeClusterId must differ");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const both = await client.query<{
      id: number;
      domain: string;
      status: string;
    }>(
      `SELECT id, domain, status FROM duplicate_clusters
        WHERE id = ANY($1::int[]) FOR UPDATE`,
      [[syntheticClusterId, authoritativeClusterId]],
    );
    const byId = new Map(both.rows.map((r) => [r.id, r]));
    const synth = byId.get(syntheticClusterId);
    const auth = byId.get(authoritativeClusterId);
    if (!synth) throw new Error(`synthetic cluster ${syntheticClusterId} not found`);
    if (!auth) throw new Error(`authoritative cluster ${authoritativeClusterId} not found`);
    if (synth.status !== "active") {
      throw new Error(`synthetic cluster ${syntheticClusterId} is ${synth.status}, not active`);
    }
    if (auth.status !== "active") {
      throw new Error(`authoritative cluster ${authoritativeClusterId} is ${auth.status}, not active`);
    }
    if (!isSyntheticDomain(synth.domain)) {
      throw new Error(
        `cluster ${syntheticClusterId} has real domain "${synth.domain}" — use the regular merge workflow, not collision triage`,
      );
    }

    const movedR = await client.query<{ id: number }>(
      `UPDATE duplicate_records
          SET cluster_id = $1
        WHERE cluster_id = $2
        RETURNING id`,
      [authoritativeClusterId, syntheticClusterId],
    );
    const movedIds = movedR.rows.map((r) => r.id);

    const totalsR = await client.query<{ total_records: number }>(
      `UPDATE duplicate_clusters
          SET total_records = (
                SELECT COUNT(*) FROM duplicate_records WHERE cluster_id = $1
              ),
              updated_at = NOW()
        WHERE id = $1
        RETURNING total_records`,
      [authoritativeClusterId],
    );

    await client.query(
      `UPDATE duplicate_clusters
          SET status = 'merged',
              resolved_by = $1,
              resolved_at = NOW(),
              updated_at = NOW()
        WHERE id = $2`,
      [performedBy, syntheticClusterId],
    );

    await client.query(
      `INSERT INTO duplicate_merge_actions
         (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
       VALUES ($1, NULL, $2, 'domain_collision_merge', $3, $4)`,
      [
        authoritativeClusterId,
        JSON.stringify(movedIds),
        performedBy,
        opts.notes ??
          `Merged synthetic cluster ${syntheticClusterId} (domain "${synth.domain}") into authoritative cluster ${authoritativeClusterId} (domain "${auth.domain}").`,
      ],
    );

    await client.query("COMMIT");

    logger.info("[domainReconcile] collision merge complete", {
      synthetic_cluster_id: syntheticClusterId,
      authoritative_cluster_id: authoritativeClusterId,
      records_moved: movedIds.length,
      performed_by: performedBy,
    });

    return {
      synthetic_cluster_id: syntheticClusterId,
      authoritative_cluster_id: authoritativeClusterId,
      records_moved: movedIds.length,
      authoritative_total_records:
        totalsR.rows[0]?.total_records ?? movedIds.length,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
