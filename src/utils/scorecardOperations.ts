/**
 * Pool-driven operations that mirror the scripts under scripts/
 * (seedScorecardV2Copc, scoreAllUnevaluatedCalls, scorecardEfficiencyReport)
 * so they can be invoked from admin HTTP endpoints inside the deployed
 * app — which is the only place that can reach the production DB.
 *
 * The scripts under scripts/ create their own pg.Pool from
 * process.env.DATABASE_URL; these functions take a pool from the
 * caller so they share the app's connection. No console.log here — the
 * caller (endpoint) decides how to surface results. No process.exit.
 */

import { logger as safeLogger } from "./logger";
import { CANONICAL_COPC_V2 } from "../data/scorecardV2CopcCanonical";

type Pool = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
  connect?: () => Promise<{
    query: (text: string, values?: any[]) => Promise<any>;
    release: () => void;
  }>;
};

// ============================================================
//   Schema bootstrap — idempotent, safe to call before any op
// ============================================================

export async function ensureV2Schema(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE sdr_call_evaluations
      ADD COLUMN IF NOT EXISTS legacy_score_v1 DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS legacy_dimension_scores_v1 JSONB,
      ADD COLUMN IF NOT EXISTS legacy_scorecard_name_v1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMP
  `);
}

// ============================================================
//   Op 1 — Seed the COPC scorecard + archive previously-active
// ============================================================

interface CopcCanonical {
  scorecard: {
    id: string;
    name: string;
    version: string;
    version_date: string;
    based_on: string;
    supersedes: string[];
    scoring_scale: Record<string, string>;
    overall_formula: string;
    rubric_targets: Record<string, string>;
    sections: Array<{
      id: string;
      order: number;
      name: string;
      weight_pct: number;
      checkpoints: Array<{
        id: string;
        name: string;
        description: string;
        metric: string;
        target: string;
        data_source: string;
        data_dependency: string;
      }>;
    }>;
  };
}

function sectionToLegacyDimension(
  sectionId: string,
): "people" | "process" | "governance" {
  switch (sectionId) {
    case "activity_and_process":
      return "process";
    case "quality_and_soft_skills":
      return "people";
    case "coaching_and_improvement":
      return "people";
    case "kpi_and_correlation":
      return "governance";
    default:
      return "process";
  }
}

function buildDimensionsPayload(canonical: CopcCanonical) {
  const s = canonical.scorecard;
  const sections: any = {};
  const dimensions: any = {
    people: { attributes: [] as any[] },
    process: { attributes: [] as any[] },
    governance: { attributes: [] as any[] },
  };
  for (const section of s.sections) {
    sections[section.id] = {
      id: section.id,
      order: section.order,
      name: section.name,
      weight_pct: section.weight_pct,
      checkpoints: section.checkpoints,
    };
    const legacyDim = sectionToLegacyDimension(section.id);
    for (const cp of section.checkpoints) {
      const evenWeight =
        Math.round((section.weight_pct / section.checkpoints.length) * 100) / 100;
      dimensions[legacyDim].attributes.push({
        id: cp.id,
        name: cp.name,
        description: cp.description,
        section_id: section.id,
        weight: evenWeight / 100,
        scoringType: "rubric_0_2",
        target: cp.target,
        metric: cp.metric,
        data_source: cp.data_source,
        data_dependency: cp.data_dependency,
        passingCriteria: cp.metric,
        severityIfFailed: cp.data_dependency.includes("five9_real_ingest")
          ? "minor"
          : section.id === "activity_and_process"
            ? "major"
            : "minor",
      });
    }
  }
  return {
    sections,
    dimensions,
    meta: {
      schema: "walaplus_copc_v2",
      version: s.version,
      version_date: s.version_date,
      based_on: s.based_on,
      scoring_scale: s.scoring_scale,
      overall_formula: s.overall_formula,
      rubric_targets: s.rubric_targets,
    },
  };
}

export interface SeedCopcResult {
  dry_run: boolean;
  scorecard_loaded: { name: string; version: string; sections: number; checkpoints: number };
  before: Array<{ id: number; name: string; version: string; is_active: boolean }>;
  archived: Array<{ id: number; name: string; version: string }>;
  inserted_or_updated: { id: number; name: string; version: string; action: "inserted" | "updated" } | null;
  after: Array<{ id: number; name: string; version: string; is_active: boolean }>;
  active_count_after: number;
  invariant_holds: boolean;
}

export async function seedCopcScorecard(
  pool: Pool,
  options: { dryRun?: boolean } = {},
): Promise<SeedCopcResult> {
  const dryRun = !!options.dryRun;

  // Read canonical scorecard from the bundled TS module. We can't use
  // fs.readFileSync on src/data/scorecard_v2_copc.json in production
  // because the bundler doesn't copy non-imported assets into
  // .mastra/output — the file isn't there at runtime. Inlining as a
  // TS module survives the build.
  const canonical = { scorecard: CANONICAL_COPC_V2.scorecard } as CopcCanonical;
  const s = canonical.scorecard;

  const before = (
    await pool.query(
      `SELECT id, name, version, is_active FROM quality_scorecards ORDER BY id`,
    )
  ).rows as any[];

  if (dryRun) {
    return {
      dry_run: true,
      scorecard_loaded: {
        name: s.name,
        version: s.version,
        sections: s.sections.length,
        checkpoints: s.sections.reduce((a, x) => a + x.checkpoints.length, 0),
      },
      before,
      archived: [],
      inserted_or_updated: null,
      after: before,
      active_count_after: before.filter((r) => r.is_active).length,
      invariant_holds: before.filter((r) => r.is_active).length === 1,
    };
  }

  const dimensionsPayload = buildDimensionsPayload(canonical);

  if (!pool.connect) {
    throw new Error("Pool does not support connect() — required for transactional seed");
  }
  const client = await pool.connect();
  let archived: any[] = [];
  let insertedOrUpdated: any = null;

  try {
    await client.query("BEGIN");
    const archiveRes = await client.query(
      `UPDATE quality_scorecards
         SET is_active = false, updated_at = NOW()
       WHERE is_active = true
       RETURNING id, name, version`,
    );
    archived = archiveRes.rows;

    const existing = await client.query(
      `SELECT id FROM quality_scorecards WHERE name = $1 AND version = $2 LIMIT 1`,
      [s.name, s.version],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0].id;
      await client.query(
        `UPDATE quality_scorecards
           SET dimensions = $1, is_active = true, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(dimensionsPayload), id],
      );
      insertedOrUpdated = { id, name: s.name, version: s.version, action: "updated" };
    } else {
      const ins = await client.query(
        `INSERT INTO quality_scorecards (name, version, team_name, dimensions, is_active, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, true, NOW(), NOW())
         RETURNING id`,
        [s.name, s.version, JSON.stringify(dimensionsPayload)],
      );
      insertedOrUpdated = {
        id: ins.rows[0].id,
        name: s.name,
        version: s.version,
        action: "inserted",
      };
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    client.release();
    throw err;
  }
  client.release();

  const after = (
    await pool.query(
      `SELECT id, name, version, is_active FROM quality_scorecards ORDER BY id`,
    )
  ).rows as any[];
  const activeCount = after.filter((r) => r.is_active).length;

  return {
    dry_run: false,
    scorecard_loaded: {
      name: s.name,
      version: s.version,
      sections: s.sections.length,
      checkpoints: s.sections.reduce((a, x) => a + x.checkpoints.length, 0),
    },
    before,
    archived,
    inserted_or_updated: insertedOrUpdated,
    after,
    active_count_after: activeCount,
    invariant_holds: activeCount === 1,
  };
}

// ============================================================
//   Op 2 — Score every call without an evaluation
// ============================================================

export interface ScoreUnevaluatedResult {
  dry_run: boolean;
  corpus_snapshot: {
    call_records: number;
    call_transcripts: number;
    call_analysis: number;
    sdr_call_evaluations: number;
  };
  active_scorecard: { id: number; name: string; version: string } | null;
  candidates_found: number;
  candidates_preview: Array<{ id: number; call_id: string; agent_email: string | null; created_at: string }>;
  estimated_cost_usd?: number;
  estimated_time_minutes?: number;
  scored?: number;
  skipped?: number;
  failed?: number;
  cost_capped?: boolean;
  per_call_results?: Array<{ id: number; status: "scored" | "skipped" | "failed"; overall_score?: number; reason?: string }>;
}

export async function scoreUnevaluatedCalls(
  pool: Pool,
  options: { dryRun?: boolean; max?: number } = {},
): Promise<ScoreUnevaluatedResult> {
  const dryRun = !!options.dryRun;
  const max = Math.max(1, Math.min(50000, Math.floor(options.max || 5000)));

  await ensureV2Schema(pool);

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM call_records) AS calls,
      (SELECT COUNT(*) FROM call_transcripts) AS transcripts,
      (SELECT COUNT(*) FROM call_analysis) AS analyses,
      (SELECT COUNT(*) FROM sdr_call_evaluations) AS evaluations
  `);
  const d = counts.rows[0];
  const snapshot = {
    call_records: Number(d.calls) || 0,
    call_transcripts: Number(d.transcripts) || 0,
    call_analysis: Number(d.analyses) || 0,
    sdr_call_evaluations: Number(d.evaluations) || 0,
  };

  const scRes = await pool.query(
    `SELECT id, name, version FROM quality_scorecards WHERE is_active = true LIMIT 1`,
  );
  const activeScorecard = scRes.rows[0]
    ? {
        id: scRes.rows[0].id,
        name: scRes.rows[0].name,
        version: scRes.rows[0].version,
      }
    : null;

  const candidatesRes = await pool.query(
    `SELECT cr.id, cr.call_id, cr.agent_email, cr.created_at
       FROM call_records cr
       JOIN call_transcripts t ON t.call_record_id = cr.id
       LEFT JOIN sdr_call_evaluations e ON e.call_record_id = cr.id
      WHERE e.id IS NULL
      ORDER BY cr.created_at ASC
      LIMIT $1`,
    [max],
  );
  const candidates = candidatesRes.rows as any[];
  const preview = candidates.slice(0, 20).map((c) => ({
    id: c.id,
    call_id: c.call_id,
    agent_email: c.agent_email,
    created_at: c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
  }));

  if (dryRun) {
    return {
      dry_run: true,
      corpus_snapshot: snapshot,
      active_scorecard: activeScorecard,
      candidates_found: candidates.length,
      candidates_preview: preview,
      estimated_cost_usd: Math.round(candidates.length * 0.0005 * 100) / 100,
      estimated_time_minutes: Math.ceil((candidates.length * 3) / 60),
    };
  }

  if (!activeScorecard) {
    return {
      dry_run: false,
      corpus_snapshot: snapshot,
      active_scorecard: null,
      candidates_found: candidates.length,
      candidates_preview: preview,
      scored: 0,
      skipped: 0,
      failed: 0,
      per_call_results: [],
    };
  }

  const { triggerSDREvaluationForCall } = await import("./sdrAutoEvaluator");
  const { isCostCapped, recordSpend, COST } = await import("./aiCostGuard");

  let scored = 0;
  let skipped = 0;
  let failed = 0;
  let costCapped = false;
  const results: any[] = [];

  for (const c of candidates) {
    if (isCostCapped()) {
      costCapped = true;
      break;
    }
    try {
      const outcome = await triggerSDREvaluationForCall(c.id, "SDR");
      if (outcome.ran) {
        scored += 1;
        recordSpend(COST.GPT4O_MINI_SDR_EVAL, "fresh_score");
        results.push({
          id: c.id,
          status: "scored",
          overall_score: outcome.overallScore,
        });
      } else {
        skipped += 1;
        results.push({ id: c.id, status: "skipped", reason: outcome.skipReason });
      }
    } catch (err: any) {
      failed += 1;
      safeLogger.warn("[scoreUnevaluatedCalls] one call failed", {
        callId: c.id,
        error: err?.message || String(err),
      });
      results.push({ id: c.id, status: "failed", reason: err?.message || String(err) });
    }
  }

  return {
    dry_run: false,
    corpus_snapshot: snapshot,
    active_scorecard: activeScorecard,
    candidates_found: candidates.length,
    candidates_preview: preview,
    scored,
    skipped,
    failed,
    cost_capped: costCapped,
    per_call_results: results,
  };
}

// ============================================================
//   Op 2b — Backfill historical evaluations under COPC
// ============================================================

export interface BackfillResult {
  dry_run: boolean;
  active_scorecard: { id: number; name: string; version: string } | null;
  candidates_found: number;
  candidates_preview: Array<{ id: number; call_record_id: number; current_overall_score: number | null }>;
  estimated_cost_usd?: number;
  estimated_time_minutes?: number;
  backfilled?: number;
  failed?: number;
  cost_capped?: boolean;
}

export async function backfillToCopc(
  pool: Pool,
  options: { dryRun?: boolean; max?: number; onlyNonCopc?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = !!options.dryRun;
  const max = Math.max(1, Math.min(50000, Math.floor(options.max || 5000)));
  const onlyNonCopc = options.onlyNonCopc !== false; // default true

  await ensureV2Schema(pool);

  // Confirm active scorecard
  const scRes = await pool.query(
    `SELECT id, name, version, dimensions FROM quality_scorecards WHERE is_active = true LIMIT 1`,
  );
  const activeScorecard = scRes.rows[0]
    ? { id: scRes.rows[0].id, name: scRes.rows[0].name, version: scRes.rows[0].version }
    : null;
  if (!activeScorecard) {
    return {
      dry_run: dryRun,
      active_scorecard: null,
      candidates_found: 0,
      candidates_preview: [],
    };
  }

  // Find candidates: rows without backfilled_at, optionally only those
  // whose scorecard_name doesn't match the active scorecard (so we don't
  // backfill rows that are already current — pure waste).
  const filters = ["e.backfilled_at IS NULL"];
  if (onlyNonCopc) {
    filters.push("(e.scorecard_name IS NULL OR e.scorecard_name != $1)");
  }
  const candidatesQ = onlyNonCopc
    ? await pool.query(
        `SELECT e.id, e.call_record_id, e.overall_score AS current_overall_score, t.transcript_text
           FROM sdr_call_evaluations e
           JOIN call_records cr ON cr.id = e.call_record_id
           JOIN LATERAL (
             SELECT transcript_text FROM call_transcripts WHERE call_record_id = cr.id
             ORDER BY created_at DESC NULLS LAST LIMIT 1
           ) t ON true
          WHERE ${filters.join(" AND ")}
          ORDER BY e.created_at ASC
          LIMIT $2`,
        [activeScorecard.name, max],
      )
    : await pool.query(
        `SELECT e.id, e.call_record_id, e.overall_score AS current_overall_score, t.transcript_text
           FROM sdr_call_evaluations e
           JOIN call_records cr ON cr.id = e.call_record_id
           JOIN LATERAL (
             SELECT transcript_text FROM call_transcripts WHERE call_record_id = cr.id
             ORDER BY created_at DESC NULLS LAST LIMIT 1
           ) t ON true
          WHERE ${filters.join(" AND ")}
          ORDER BY e.created_at ASC
          LIMIT $1`,
        [max],
      );

  const candidates = candidatesQ.rows;
  const preview = candidates.slice(0, 20).map((c) => ({
    id: c.id,
    call_record_id: c.call_record_id,
    current_overall_score: c.current_overall_score == null ? null : Number(c.current_overall_score),
  }));

  if (dryRun) {
    return {
      dry_run: true,
      active_scorecard: activeScorecard,
      candidates_found: candidates.length,
      candidates_preview: preview,
      estimated_cost_usd: Math.round(candidates.length * 0.0006 * 100) / 100,
      estimated_time_minutes: Math.ceil((candidates.length * 3) / 60),
    };
  }

  // Real backfill — re-score against COPC, preserve v1 score in legacy_*
  const { getActiveSDRScorecard, buildSDREvaluationPrompt } = await import("./callIntelligenceDb");
  const { generateChatText } = await import("./openaiChatHelper");
  const { isCostCapped, recordSpend, COST } = await import("./aiCostGuard");
  const scorecard = await getActiveSDRScorecard();
  if (!scorecard) {
    return {
      dry_run: false,
      active_scorecard: activeScorecard,
      candidates_found: candidates.length,
      candidates_preview: preview,
      backfilled: 0,
      failed: 0,
    };
  }

  let backfilled = 0;
  let failed = 0;
  let costCapped = false;
  for (const c of candidates) {
    if (isCostCapped()) {
      costCapped = true;
      break;
    }
    try {
      const prompt = buildSDREvaluationPrompt(c.transcript_text || "", scorecard);
      const aiResult = await generateChatText({
        model: "gpt-4o-mini",
        prompt,
        maxTokens: 8000,
        responseFormat: "json_object",
      });
      recordSpend(COST.GPT4O_MINI_SDR_EVAL, "backfill_to_copc");
      const parsed = JSON.parse((aiResult.text || "").replace(/```json\n?|\n?```/g, "").trim());
      const newOverall = Number(parsed?.overall_summary?.overall_score);
      if (!Number.isFinite(newOverall)) throw new Error("ai_returned_invalid_overall_score");
      const newDim = parsed?.overall_summary?.dimension_scores || { people: 0, process: 0, governance: 0 };
      const newAttrs = parsed?.attribute_evaluations || [];
      const newStrengths = parsed?.overall_summary?.top_strengths || [];
      const newGaps = parsed?.overall_summary?.top_gaps || [];
      const newCoaching = parsed?.overall_summary?.coaching_actions || [];

      if (!pool.connect) throw new Error("pool lacks connect()");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE sdr_call_evaluations
             SET legacy_score_v1 = COALESCE(legacy_score_v1, overall_score),
                 legacy_dimension_scores_v1 = COALESCE(legacy_dimension_scores_v1, dimension_scores),
                 legacy_scorecard_name_v1 = COALESCE(legacy_scorecard_name_v1, scorecard_name),
                 overall_score = $1,
                 dimension_scores = $2,
                 attribute_evaluations = $3,
                 top_strengths = $4,
                 top_gaps = $5,
                 coaching_actions = $6,
                 scorecard_name = $7,
                 backfilled_at = NOW()
           WHERE id = $8`,
          [
            newOverall, JSON.stringify(newDim), JSON.stringify(newAttrs),
            JSON.stringify(newStrengths), JSON.stringify(newGaps),
            JSON.stringify(newCoaching), activeScorecard.name, c.id,
          ],
        );
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }
      backfilled += 1;
    } catch (err: any) {
      failed += 1;
      safeLogger.warn("[backfillToCopc] one row failed", { evalId: c.id, error: err?.message });
    }
  }

  return {
    dry_run: false,
    active_scorecard: activeScorecard,
    candidates_found: candidates.length,
    candidates_preview: preview,
    backfilled,
    failed,
    cost_capped: costCapped,
  };
}

// ============================================================
//   Op 3 — Efficiency report (read-only aggregation)
// ============================================================

export interface EfficiencyReportResult {
  generated_at: string;
  active_scorecard: string;
  coverage: { total: number; backfilled: number; still_v1: number };
  drift: any;
  section_scores: any[];
  per_agent_top10: any[];
  outliers: { top_positive: any[]; top_negative: any[] };
}

export async function buildEfficiencyReport(pool: Pool): Promise<EfficiencyReportResult> {
  await ensureV2Schema(pool);

  const activeRes = await pool.query(
    `SELECT name, version FROM quality_scorecards WHERE is_active=true LIMIT 1`,
  );
  const active_scorecard = activeRes.rows[0]
    ? `${activeRes.rows[0].name} (v${activeRes.rows[0].version})`
    : "(none active)";

  const cov = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE backfilled_at IS NOT NULL)::int AS backfilled,
      COUNT(*) FILTER (WHERE backfilled_at IS NULL)::int AS still_v1
    FROM sdr_call_evaluations
  `);

  const drift = await pool.query(`
    SELECT
      AVG(legacy_score_v1)::float AS avg_v1,
      AVG(overall_score)::float   AS avg_v2,
      AVG(overall_score - legacy_score_v1)::float AS avg_delta,
      MIN(overall_score - legacy_score_v1)::float AS min_delta,
      MAX(overall_score - legacy_score_v1)::float AS max_delta,
      COUNT(*)::int AS n
    FROM sdr_call_evaluations
    WHERE backfilled_at IS NOT NULL AND legacy_score_v1 IS NOT NULL
  `);

  const sectionStats = await pool.query(`
    WITH attrs AS (
      SELECT
        (a->>'section_id') AS section_id,
        CASE WHEN a->>'score' = 'null' OR a->'score' IS NULL THEN NULL
             ELSE (a->>'score')::float END AS score
      FROM sdr_call_evaluations e
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.attribute_evaluations, '[]'::jsonb)) AS a
    )
    SELECT
      section_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE score IS NOT NULL)::int AS scored,
      COUNT(*) FILTER (WHERE score IS NULL)::int AS deferred,
      ROUND((AVG(score) FILTER (WHERE score IS NOT NULL) / 2.0 * 100)::numeric, 1)::float AS avg_score_0_100
    FROM attrs
    WHERE section_id IS NOT NULL
    GROUP BY section_id
    ORDER BY section_id
  `);

  const perAgent = await pool.query(`
    SELECT
      cr.agent_email,
      COUNT(e.*)::int AS evals,
      ROUND(AVG(e.overall_score)::numeric, 1)::float AS avg_v2,
      ROUND(AVG(e.legacy_score_v1)::numeric, 1)::float AS avg_v1
    FROM sdr_call_evaluations e
    JOIN call_records cr ON cr.id = e.call_record_id
    WHERE cr.agent_email IS NOT NULL
    GROUP BY cr.agent_email
    ORDER BY evals DESC
    LIMIT 10
  `);

  const topPos = await pool.query(`
    SELECT e.id AS eval_id, e.call_record_id, e.legacy_score_v1, e.overall_score,
           (e.overall_score - e.legacy_score_v1)::float AS delta, cr.agent_email
    FROM sdr_call_evaluations e
    JOIN call_records cr ON cr.id = e.call_record_id
    WHERE e.backfilled_at IS NOT NULL AND e.legacy_score_v1 IS NOT NULL
    ORDER BY (e.overall_score - e.legacy_score_v1) DESC LIMIT 5
  `);
  const topNeg = await pool.query(`
    SELECT e.id AS eval_id, e.call_record_id, e.legacy_score_v1, e.overall_score,
           (e.overall_score - e.legacy_score_v1)::float AS delta, cr.agent_email
    FROM sdr_call_evaluations e
    JOIN call_records cr ON cr.id = e.call_record_id
    WHERE e.backfilled_at IS NOT NULL AND e.legacy_score_v1 IS NOT NULL
    ORDER BY (e.overall_score - e.legacy_score_v1) ASC LIMIT 5
  `);

  return {
    generated_at: new Date().toISOString(),
    active_scorecard,
    coverage: cov.rows[0],
    drift: drift.rows[0],
    section_scores: sectionStats.rows,
    per_agent_top10: perAgent.rows,
    outliers: { top_positive: topPos.rows, top_negative: topNeg.rows },
  };
}
