/**
 * One-shot migration: seed the COPC-aligned scorecard v2 and archive the
 * legacy "WalaaPlus Sales Quality Scorecard v1.5".
 *
 * DMAIC Scorecard Consolidation — Improve phase Step 2. See:
 *   D:/2_QMS Platform/Call Evaluation Tab/DMAIC_Scorecard_Consolidation.md
 *
 * What this script does (in one transaction, idempotent):
 *   1. INSERTs the new COPC scorecard from src/data/scorecard_v2_copc.json
 *      into quality_scorecards if it doesn't exist; updates it if it does.
 *      The COPC sections + checkpoint structure goes into the JSONB
 *      `dimensions` column at a NEW top-level `sections` key, alongside a
 *      flattened `dimensions` view so the existing getActiveSDRScorecard()
 *      parser still works (it walks dimensions[*].attributes[]).
 *   2. UPDATEs the v1.5 scorecard (and any other previously-active
 *      scorecards) → is_active=false. Only ONE scorecard ends up active.
 *   3. Prints a before/after summary so the migration log shows what
 *      changed.
 *
 * Run:
 *   npx tsx scripts/seedScorecardV2Copc.ts
 *
 * Safe to re-run — IDs are stable and the UPSERT pattern means a second
 * run does nothing destructive.
 *
 * To preview without committing (dry-run), set DRY_RUN=1:
 *   DRY_RUN=1 npx tsx scripts/seedScorecardV2Copc.ts
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

// ESM equivalent of CommonJS __dirname — required because package.json is
// "type": "module" so the CJS-only __dirname global isn't defined here.
// (Matches the pattern already used by scripts/a11y-check.js.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DRY_RUN = process.env.DRY_RUN === "1";

const JSON_PATH = path.resolve(__dirname, "../src/data/scorecard_v2_copc.json");

interface Checkpoint {
  id: string;
  name: string;
  description: string;
  metric: string;
  target: string;
  data_source: string;
  data_dependency: string;
}
interface Section {
  id: string;
  order: number;
  name: string;
  weight_pct: number;
  checkpoints: Checkpoint[];
}
interface CanonicalScorecard {
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
    sections: Section[];
  };
}

/**
 * Map a COPC section id to the legacy "people / process / governance"
 * dimension so the existing getActiveSDRScorecard parser still produces
 * a flat attribute list when reading this row. The section_id is
 * preserved on each attribute so the new evaluator (Step 3) can group
 * back to sections; the legacy parser sees a 3-dimension cut.
 */
function sectionToLegacyDimension(
  sectionId: string,
): "people" | "process" | "governance" {
  // Quality + Coaching are "people"-development concerns; Activity is "process";
  // KPI/Correlation is "governance" (measurement + reporting).
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
      return "process"; // safe default
  }
}

/**
 * Build the JSONB payload that goes into quality_scorecards.dimensions.
 *
 * Schema:
 *   {
 *     sections: { <section_id>: { ...section, checkpoints: [...] } },
 *     dimensions: { people: { attributes: [...] }, process: {...}, governance: {...} },
 *     meta: { version, version_date, based_on, scoring_scale, overall_formula, rubric_targets }
 *   }
 */
function buildDimensionsPayload(canonical: CanonicalScorecard) {
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
      // Each checkpoint becomes one attribute in the legacy dimensions view.
      // The new evaluator should read .sections[*].checkpoints; the legacy
      // evaluator walks .dimensions[*].attributes.
      const evenWeight =
        Math.round((section.weight_pct / section.checkpoints.length) * 100) / 100;
      dimensions[legacyDim].attributes.push({
        id: cp.id,
        name: cp.name,
        description: cp.description,
        section_id: section.id, // NEW — lets the v2 evaluator group back
        weight: evenWeight / 100, // legacy weight is 0..1
        scoringType: "rubric_0_2", // NEW — 0/1/2 instead of pass_fail
        target: cp.target,
        metric: cp.metric,
        data_source: cp.data_source,
        data_dependency: cp.data_dependency,
        passingCriteria: cp.metric,
        severityIfFailed:
          cp.data_dependency.includes("ContactCenterProvider_real_ingest")
            ? "minor" // deferred until ContactCenterProvider ships
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
      schema: "ExampleOrg_copc_v2",
      version: s.version,
      version_date: s.version_date,
      based_on: s.based_on,
      scoring_scale: s.scoring_scale,
      overall_formula: s.overall_formula,
      rubric_targets: s.rubric_targets,
    },
  };
}

async function run(): Promise<void> {
  console.log(`[seedCopc] starting (DRY_RUN=${DRY_RUN ? "true" : "false"})`);

  // 1. Load canonical JSON
  const raw = fs.readFileSync(JSON_PATH, "utf8");
  const canonical = JSON.parse(raw) as CanonicalScorecard;
  const s = canonical.scorecard;
  console.log(
    `[seedCopc] loaded canonical scorecard: ${s.name} v${s.version} ` +
      `(${s.sections.length} sections, ${s.sections.reduce((a, x) => a + x.checkpoints.length, 0)} checkpoints)`,
  );

  // 2. Build JSONB payload
  const dimensionsPayload = buildDimensionsPayload(canonical);

  // 3. Connect to DB
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    // 4. Before snapshot
    const before = await pool.query(
      `SELECT id, name, version, is_active FROM quality_scorecards ORDER BY id`,
    );
    console.log("[seedCopc] BEFORE:");
    for (const r of before.rows) {
      console.log(
        `  #${r.id}: ${r.name} (v${r.version}) is_active=${r.is_active}`,
      );
    }
    if (before.rows.length === 0) {
      console.log("  (no scorecards in table)");
    }

    if (DRY_RUN) {
      console.log("[seedCopc] DRY_RUN — no writes. Exiting.");
      return;
    }

    // 5. UPSERT + archive in one transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Archive every previously-active scorecard.
      const archiveRes = await client.query(
        `UPDATE quality_scorecards
           SET is_active = false, updated_at = NOW()
         WHERE is_active = true
         RETURNING id, name, version`,
      );
      if (archiveRes.rows.length > 0) {
        console.log(
          `[seedCopc] archived ${archiveRes.rows.length} previously-active scorecard(s):`,
        );
        for (const r of archiveRes.rows) {
          console.log(`  → #${r.id}: ${r.name} (v${r.version}) → is_active=false`);
        }
      } else {
        console.log("[seedCopc] no previously-active scorecards to archive.");
      }

      // UPSERT the new scorecard. We use name+version as the natural key
      // (since there's no canonical text id column in the schema).
      const existing = await client.query(
        `SELECT id FROM quality_scorecards WHERE name = $1 AND version = $2 LIMIT 1`,
        [s.name, s.version],
      );

      let newId: number;
      if (existing.rows.length > 0) {
        newId = existing.rows[0].id;
        await client.query(
          `UPDATE quality_scorecards
             SET dimensions = $1, is_active = true, updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(dimensionsPayload), newId],
        );
        console.log(
          `[seedCopc] UPDATED existing row #${newId} (${s.name} v${s.version}) → is_active=true`,
        );
      } else {
        const insertRes = await client.query(
          `INSERT INTO quality_scorecards (name, version, team_name, dimensions, is_active, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, true, NOW(), NOW())
           RETURNING id`,
          [s.name, s.version, JSON.stringify(dimensionsPayload)],
        );
        newId = insertRes.rows[0].id;
        console.log(
          `[seedCopc] INSERTED new row #${newId}: ${s.name} v${s.version} → is_active=true`,
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // 6. After snapshot
    const after = await pool.query(
      `SELECT id, name, version, is_active FROM quality_scorecards ORDER BY id`,
    );
    console.log("[seedCopc] AFTER:");
    let activeCount = 0;
    for (const r of after.rows) {
      console.log(
        `  #${r.id}: ${r.name} (v${r.version}) is_active=${r.is_active}`,
      );
      if (r.is_active) activeCount++;
    }
    if (activeCount === 1) {
      console.log("[seedCopc] ✓ exactly ONE scorecard is active — invariant holds");
    } else {
      console.error(
        `[seedCopc] ✗ INVARIANT VIOLATED — ${activeCount} scorecards are active (expected 1)`,
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error("[seedCopc] FAILED:", err?.message || err);
  process.exit(1);
});
