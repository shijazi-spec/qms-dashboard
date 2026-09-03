/**
 * Agentic Duplicate Resolution — LEARNING LOOP.
 *
 * Captures what the agent proposed vs. what the operator actually did (and the
 * outcome), so the agent can learn the org's real preferences over time:
 *   • how often operators override the recommended survivor (and to what),
 *   • how often plans are applied vs. dry-run vs. abandoned,
 *   • recent corrections — fed back to the LLM agent as guidance.
 *
 * Mirrors the platform's existing `ai_training_feedback` pattern. Storage is
 * best-effort: a logging failure must never block a resolution.
 */

import { pool } from "./duplicateRadarDatabase";
import { redactSensitiveDeep } from "./eventLogsDatabase";
import { logger } from "./logger";

let _tableReady = false;

async function ensureTable(): Promise<void> {
  if (_tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_feedback (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER,
      event_type VARCHAR(32) NOT NULL,            -- 'preview' | 'dry_run' | 'applied'
      proposed_master_zoho_id VARCHAR(100),
      chosen_master_zoho_id VARCHAR(100),
      master_overridden BOOLEAN DEFAULT FALSE,
      fields_migrated INTEGER DEFAULT 0,
      duplicates_tagged INTEGER DEFAULT 0,
      reparented INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      plan_json JSONB,
      report_json JSONB,
      performed_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_feedback_cluster ON duplicate_resolution_feedback(cluster_id);`,
    )
    .catch(() => {});
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_feedback_created ON duplicate_resolution_feedback(created_at DESC);`,
    )
    .catch(() => {});
  _tableReady = true;
}

export interface ResolutionEvent {
  clusterId: number;
  eventType: "preview" | "dry_run" | "applied";
  proposedMasterZohoId?: string | null;
  chosenMasterZohoId?: string | null;
  fieldsMigrated?: number;
  duplicatesTagged?: number;
  reparented?: number;
  errors?: number;
  plan?: unknown;
  report?: unknown;
  performedBy?: string;
}

/** Record one resolution event. Best-effort — never throws to the caller. */
export async function recordResolutionEvent(ev: ResolutionEvent): Promise<void> {
  try {
    await ensureTable();
    const overridden =
      !!ev.proposedMasterZohoId &&
      !!ev.chosenMasterZohoId &&
      ev.proposedMasterZohoId !== ev.chosenMasterZohoId;
    // The agent-supplied plan/report are arbitrary objects that can embed
    // credential-shaped values (e.g. a Zoho field snapshot containing an
    // api_key/access_token). Scrub every value before it reaches the INSERT
    // params, matching the platform's changeHistoryDatabase write-path
    // convention. performed_by and the zoho-id strings are scrubbed defensively
    // in case a caller ever routes a secret-shaped value through them.
    const safePlan = redactSensitiveDeep(ev.plan ?? null);
    const safeReport = redactSensitiveDeep(ev.report ?? null);
    const safeProposed =
      ev.proposedMasterZohoId != null
        ? (redactSensitiveDeep(ev.proposedMasterZohoId, "proposed_master_zoho_id") as string)
        : null;
    const safeChosen =
      ev.chosenMasterZohoId != null
        ? (redactSensitiveDeep(ev.chosenMasterZohoId, "chosen_master_zoho_id") as string)
        : null;
    const safePerformedBy =
      ev.performedBy != null
        ? (redactSensitiveDeep(ev.performedBy, "performed_by") as string)
        : null;
    await pool.query(
      `INSERT INTO duplicate_resolution_feedback
         (cluster_id, event_type, proposed_master_zoho_id, chosen_master_zoho_id,
          master_overridden, fields_migrated, duplicates_tagged, reparented, errors,
          plan_json, report_json, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [
        ev.clusterId,
        ev.eventType,
        safeProposed,
        safeChosen,
        overridden,
        ev.fieldsMigrated ?? 0,
        ev.duplicatesTagged ?? 0,
        ev.reparented ?? 0,
        ev.errors ?? 0,
        JSON.stringify(safePlan ?? null),
        JSON.stringify(safeReport ?? null),
        safePerformedBy,
      ],
    );
  } catch (e) {
    logger.warn("[dup-resolution-learning] failed to record event (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface ResolutionLearnings {
  totalEvents: number;
  applied: number;
  dryRuns: number;
  previews: number;
  masterOverrides: number;
  /** 0..1 — share of applied/dry-run plans where the operator changed the survivor. */
  masterOverrideRate: number;
  avgFieldsMigrated: number;
  totalReparented: number;
  /** Recent operator corrections — used as few-shot guidance for the agent. */
  recentCorrections: Array<{
    clusterId: number;
    proposed: string | null;
    chosen: string | null;
    when: string | null;
  }>;
  /** Plain-English lines the LLM agent (and the UI) can consume directly. */
  guidance: string[];
}

/**
 * Aggregate the feedback into learned signals. Safe to call even before any
 * events exist (returns zeros). Read by the agent briefing + the stats route.
 */
export async function getResolutionLearnings(): Promise<ResolutionLearnings> {
  const empty: ResolutionLearnings = {
    totalEvents: 0,
    applied: 0,
    dryRuns: 0,
    previews: 0,
    masterOverrides: 0,
    masterOverrideRate: 0,
    avgFieldsMigrated: 0,
    totalReparented: 0,
    recentCorrections: [],
    guidance: ["No resolution history yet — the agent will learn as operators act."],
  };
  try {
    await ensureTable();
    const agg = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE event_type = 'applied')::int AS applied,
        COUNT(*) FILTER (WHERE event_type = 'dry_run')::int AS dry_runs,
        COUNT(*) FILTER (WHERE event_type = 'preview')::int AS previews,
        COUNT(*) FILTER (WHERE master_overridden)::int AS overrides,
        COUNT(*) FILTER (WHERE event_type IN ('applied','dry_run'))::int AS decisions,
        COALESCE(AVG(fields_migrated) FILTER (WHERE event_type = 'applied'), 0)::float AS avg_fields,
        COALESCE(SUM(reparented) FILTER (WHERE event_type = 'applied'), 0)::int AS total_reparented
      FROM duplicate_resolution_feedback
    `);
    const r = agg.rows[0] || {};
    const total = Number(r.total || 0);
    if (total === 0) return empty;

    const decisions = Number(r.decisions || 0);
    const overrides = Number(r.overrides || 0);
    const overrideRate = decisions > 0 ? overrides / decisions : 0;

    const recent = await pool.query(`
      SELECT cluster_id, proposed_master_zoho_id, chosen_master_zoho_id, created_at
      FROM duplicate_resolution_feedback
      WHERE master_overridden = TRUE
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const guidance: string[] = [];
    if (overrideRate >= 0.3) {
      guidance.push(
        `Operators override the recommended survivor ${Math.round(overrideRate * 100)}% of the time — scrutinise the master choice and surface alternatives prominently.`,
      );
    } else if (decisions >= 5) {
      guidance.push(
        `The recommended survivor is accepted ${Math.round((1 - overrideRate) * 100)}% of the time — master selection is well-calibrated.`,
      );
    }
    if (Number(r.applied || 0) === 0 && decisions > 0) {
      guidance.push(
        "Plans are being previewed/dry-run but not applied — flag blockers (conflicts, custom-field assumptions) more clearly so operators can act.",
      );
    }
    if (guidance.length === 0) guidance.push("Resolution behaviour is within normal ranges.");

    return {
      totalEvents: total,
      applied: Number(r.applied || 0),
      dryRuns: Number(r.dry_runs || 0),
      previews: Number(r.previews || 0),
      masterOverrides: overrides,
      masterOverrideRate: Math.round(overrideRate * 100) / 100,
      avgFieldsMigrated: Math.round(Number(r.avg_fields || 0) * 10) / 10,
      totalReparented: Number(r.total_reparented || 0),
      recentCorrections: recent.rows.map((row: any) => ({
        clusterId: row.cluster_id,
        proposed: row.proposed_master_zoho_id,
        chosen: row.chosen_master_zoho_id,
        when: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
      guidance,
    };
  } catch (e) {
    logger.warn("[dup-resolution-learning] failed to aggregate (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

export interface ResolutionActivityRow {
  id: number;
  clusterId: number;
  eventType: string;
  proposedMaster: string | null;
  chosenMaster: string | null;
  masterOverridden: boolean;
  fieldsMigrated: number;
  duplicatesTagged: number;
  reparented: number;
  errors: number;
  performedBy: string | null;
  at: string | null;
}

/**
 * Chronological log of every agent resolution action (preview / dry-run /
 * apply) — powers the "Agent Activity" section in the Logs tab. Returns [] on
 * any error so the Logs tab never breaks.
 */
export async function getResolutionActivity(
  limit = 100,
): Promise<ResolutionActivityRow[]> {
  try {
    await ensureTable();
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const r = await pool.query(
      `SELECT id, cluster_id, event_type, proposed_master_zoho_id,
              chosen_master_zoho_id, master_overridden, fields_migrated,
              duplicates_tagged, reparented, errors, performed_by, created_at
         FROM duplicate_resolution_feedback
        ORDER BY created_at DESC
        LIMIT $1`,
      [lim],
    );
    return r.rows.map((row: any) => ({
      id: row.id,
      clusterId: row.cluster_id,
      eventType: row.event_type,
      proposedMaster: row.proposed_master_zoho_id,
      chosenMaster: row.chosen_master_zoho_id,
      masterOverridden: !!row.master_overridden,
      fieldsMigrated: row.fields_migrated ?? 0,
      duplicatesTagged: row.duplicates_tagged ?? 0,
      reparented: row.reparented ?? 0,
      errors: row.errors ?? 0,
      performedBy: row.performed_by,
      at: row.created_at ? new Date(row.created_at).toISOString() : null,
    }));
  } catch (e) {
    logger.warn("[dup-resolution-learning] getResolutionActivity failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}
