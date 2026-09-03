/**
 * DMAIC Scorecard Consolidation — Improve phase Step 5.
 *
 * Re-score historical SDR evaluations against the COPC v2 scorecard.
 * For each call_records row with an existing v1.5 sdr_call_evaluations
 * row in the chosen date window:
 *
 *   1. SKIP if backfilled_at IS NOT NULL (idempotent — safe to re-run)
 *   2. Copy current overall_score → legacy_score_v1
 *      Copy current dimension_scores → legacy_dimension_scores_v1
 *      Copy current scorecard_name → legacy_scorecard_name_v1
 *      Stamp backfilled_at = NOW()
 *   3. Re-run the COPC AI judge prompt against call_transcripts.transcript_text
 *   4. UPDATE the row with the new score / dimensions / attributes
 *
 * No Whisper re-transcription. The transcript already exists.
 * Each call costs ~$0.0005-$0.001 in gpt-4o-mini usage. Default window
 * is 30 days, configurable with --days N. DRY_RUN=1 prints what would
 * happen without writing anything.
 *
 * Uses the existing aiCostGuard (Solution #9) — if COST_CIRCUIT_BREAKER
 * is on and the daily cap is reached, the script pauses gracefully and
 * tells you to resume tomorrow.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/backfillScorecardV2.ts            # preview last 30 days
 *   DRY_RUN=1 npx tsx scripts/backfillScorecardV2.ts --days 7   # preview last 7 days
 *   npx tsx scripts/backfillScorecardV2.ts                      # apply, last 30 days
 *   npx tsx scripts/backfillScorecardV2.ts --days 90            # apply, last 90 days
 *   npx tsx scripts/backfillScorecardV2.ts --max 50             # apply, cap at 50 rows
 *
 * Exit codes:
 *   0 = success (whether 0 or N rows backfilled)
 *   1 = exception during run
 *   2 = cost cap reached mid-run (partial backfill — re-run tomorrow to finish)
 *   3 = no active COPC scorecard (run scripts/seedScorecardV2Copc.ts first)
 */

import pg from "pg";

const DRY_RUN = process.env.DRY_RUN === "1";

function parseArgs(): { days: number | "all"; max: number } {
  const args = process.argv.slice(2);
  let days: number | "all" = 30;
  let max = 5000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--all") {
      days = "all";
    } else if (args[i] === "--days" && args[i + 1]) {
      const v = args[i + 1].toLowerCase();
      if (v === "all" || v === "0") {
        days = "all";
      } else {
        // Bumped cap from 365 → 3650 (10y) so a tenant with old historical
        // data can still re-score everything in one pass. Use --all when
        // you want no time filter at all.
        days = Math.max(1, Math.min(3650, parseInt(args[i + 1], 10) || 30));
      }
      i++;
    } else if (args[i] === "--max" && args[i + 1]) {
      max = Math.max(1, Math.min(50000, parseInt(args[i + 1], 10) || 5000));
      i++;
    }
  }
  return { days, max };
}

interface BackfillCandidate {
  evaluation_id: number;
  call_record_id: number;
  current_overall_score: number | null;
  current_dimension_scores: any;
  current_scorecard_name: string | null;
  transcript_text: string;
}

/**
 * Self-bootstrap the v2 schema additions so the backfill works even
 * if the deployed app hasn't called initCallIntelligenceTables() yet
 * (e.g. just-pushed code where no /calls request has hit yet). All
 * IF NOT EXISTS — idempotent, no-op on a deployment that already has
 * the columns.
 */
async function ensureBackfillSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE sdr_call_evaluations
      ADD COLUMN IF NOT EXISTS legacy_score_v1 DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS legacy_dimension_scores_v1 JSONB,
      ADD COLUMN IF NOT EXISTS legacy_scorecard_name_v1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMP
  `);
}

async function run(): Promise<void> {
  const { days, max } = parseArgs();
  console.log(
    `[backfill] starting (DRY_RUN=${DRY_RUN}, window=${days === "all" ? "ALL historical" : days + "d"}, max=${max} rows)`,
  );

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // Self-bootstrap: ensure the v2 columns exist regardless of whether
    // the deployed app has invoked initCallIntelligenceTables() yet.
    await ensureBackfillSchema(pool);
    console.log("[backfill] schema ready (v2 columns confirmed present)");


    // 1. Confirm the active scorecard is v2 (has section_id on attributes)
    const activeRes = await pool.query(
      `SELECT id, name, version, dimensions
         FROM quality_scorecards
        WHERE is_active = true
        LIMIT 1`,
    );
    if (activeRes.rows.length === 0) {
      console.error("[backfill] no active scorecard. Run scripts/seedScorecardV2Copc.ts first.");
      process.exit(3);
    }
    const active = activeRes.rows[0];
    const isCopc =
      !!active.dimensions?.sections ||
      !!active.dimensions?.meta?.schema?.startsWith?.("ExampleOrg_copc");
    if (!isCopc) {
      console.error(
        `[backfill] active scorecard "${active.name}" is not COPC v2. Aborting.`,
      );
      process.exit(3);
    }
    console.log(`[backfill] active scorecard: ${active.name} v${active.version}`);

    // 2. Build the candidate list — evaluations in window that haven't been
    //    backfilled yet. Order by oldest-first so a partial run still makes
    //    forward progress. --all (or --days 0) drops the time filter
    //    entirely so the full historical corpus is in scope.
    const baseSelect = `
       SELECT
         e.id AS evaluation_id,
         e.call_record_id,
         e.overall_score AS current_overall_score,
         e.dimension_scores AS current_dimension_scores,
         e.scorecard_name AS current_scorecard_name,
         t.transcript_text
       FROM sdr_call_evaluations e
       JOIN call_records cr ON cr.id = e.call_record_id
       JOIN LATERAL (
         SELECT transcript_text
         FROM call_transcripts
         WHERE call_record_id = cr.id
         ORDER BY created_at DESC NULLS LAST
         LIMIT 1
       ) t ON true
       WHERE e.backfilled_at IS NULL`;
    const candidatesRes =
      days === "all"
        ? await pool.query(
            `${baseSelect}
             ORDER BY e.created_at ASC
             LIMIT $1`,
            [max],
          )
        : await pool.query(
            `${baseSelect}
               AND e.created_at >= NOW() - ($1 || ' days')::interval
             ORDER BY e.created_at ASC
             LIMIT $2`,
            [String(days), max],
          );
    const candidates = candidatesRes.rows as BackfillCandidate[];
    console.log(`[backfill] found ${candidates.length} candidate row(s)`);

    if (candidates.length === 0) {
      console.log("[backfill] nothing to do. Exiting.");
      return;
    }

    if (DRY_RUN) {
      console.log("[backfill] DRY_RUN — would process:");
      for (const c of candidates.slice(0, 20)) {
        console.log(
          `  eval #${c.evaluation_id}: call_record #${c.call_record_id} ` +
            `(current overall_score=${c.current_overall_score}, ` +
            `scorecard="${c.current_scorecard_name}")`,
        );
      }
      if (candidates.length > 20) {
        console.log(`  …and ${candidates.length - 20} more`);
      }
      console.log("[backfill] DRY_RUN — no writes. Exiting.");
      return;
    }

    // 3. Pull deps for re-scoring
    const { getActiveSDRScorecard, buildSDREvaluationPrompt } = await import(
      "../src/utils/callIntelligenceDb"
    );
    const { generateChatText } = await import(
      "../src/utils/LLMProviderChatHelper"
    );
    const { isCostCapped, recordSpend, COST } = await import(
      "../src/utils/aiCostGuard"
    );

    const scorecard = await getActiveSDRScorecard();
    if (!scorecard) {
      console.error("[backfill] could not load active scorecard via API. Aborting.");
      process.exit(3);
    }

    let processed = 0;
    let failed = 0;
    let costCapped = false;
    const startedAt = Date.now();

    for (const c of candidates) {
      // Cost guard — bail gracefully if today's spend hit the cap
      if (isCostCapped()) {
        console.warn(
          "[backfill] AI daily cost cap reached — pausing. " +
            "Re-run tomorrow to continue from where we left off.",
        );
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
        recordSpend(COST.GPT4O_MINI_SDR_EVAL, "scorecard_backfill");

        let parsed: any;
        try {
          parsed = JSON.parse(
            (aiResult.text || "").replace(/```json\n?|\n?```/g, "").trim(),
          );
        } catch {
          throw new Error("ai_parse_failed");
        }

        const newOverall = Number(parsed?.overall_summary?.overall_score);
        if (!Number.isFinite(newOverall)) {
          throw new Error("ai_returned_invalid_overall_score");
        }

        const newDim = parsed?.overall_summary?.dimension_scores || {
          people: 0, process: 0, governance: 0,
        };
        const newAttrs = parsed?.attribute_evaluations || [];
        const newSections = parsed?.overall_summary?.section_scores || null;
        const newStrengths = parsed?.overall_summary?.top_strengths || [];
        const newGaps = parsed?.overall_summary?.top_gaps || [];
        const newCoaching = parsed?.overall_summary?.coaching_actions || [];

        // One transaction per row — preserve old values to legacy_*, then
        // update with new. Rollback per row keeps a single bad call from
        // corrupting the rest of the batch.
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
              newOverall,
              JSON.stringify(newDim),
              JSON.stringify(newAttrs),
              JSON.stringify(newStrengths),
              JSON.stringify(newGaps),
              JSON.stringify(newCoaching),
              active.name,
              c.evaluation_id,
            ],
          );
          await client.query("COMMIT");
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        } finally {
          client.release();
        }

        processed += 1;
        // Keep the numeric delta around for sign formatting — the displayed
        // value is the rounded string, but `.toFixed()` returns a string so
        // `delta >= 0` would compare a string to a number (TS2365).
        const deltaNum =
          c.current_overall_score != null
            ? newOverall - Number(c.current_overall_score)
            : null;
        const delta = deltaNum != null ? deltaNum.toFixed(1) : "—";
        const sign = deltaNum != null && deltaNum >= 0 ? "+" : "";
        console.log(
          `  ✓ eval #${c.evaluation_id} (call #${c.call_record_id}): ${c.current_overall_score} → ${newOverall.toFixed(1)} (Δ${sign}${delta}). Sections: ${newSections ? Object.keys(newSections).length : 0}`,
        );
      } catch (err: any) {
        failed += 1;
        console.warn(
          `  ✗ eval #${c.evaluation_id} (call #${c.call_record_id}): ${err?.message || String(err)}`,
        );
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[backfill] done — processed ${processed}, failed ${failed}, skipped (cost cap) ${costCapped ? candidates.length - processed - failed : 0}, elapsed ${elapsed}s`,
    );

    // Optional summary: avg delta if we have enough data points
    if (processed >= 5) {
      const deltaRes = await pool.query(
        `SELECT
           ROUND(AVG(overall_score - legacy_score_v1)::numeric, 2)::float AS avg_delta,
           COUNT(*) AS n
         FROM sdr_call_evaluations
         WHERE backfilled_at >= NOW() - INTERVAL '1 hour'
           AND legacy_score_v1 IS NOT NULL`,
      );
      const d = deltaRes.rows[0];
      console.log(
        `[backfill] this run avg score delta: ${d.avg_delta ?? "—"} pts over ${d.n} row(s)`,
      );
    }

    if (costCapped) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[backfill] FAILED:", err?.message || err);
  process.exit(1);
});
