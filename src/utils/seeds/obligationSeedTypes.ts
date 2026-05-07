/**
 * Shared types and seed helper for the per-framework obligation
 * catalogues that live alongside complianceDatabase.ts.
 *
 * Every framework seed file under src/utils/seeds/ exports an array of
 * ObligationDef entries plus a seedXxxObligations() function that uses
 * runFrameworkSeed() to apply them idempotently.
 *
 * The seed text is "curated paraphrased summaries" — NOT verbatim
 * regulator language. Compliance officers can edit any seeded row via
 * the standard /api/compliance/obligations UI without breaking the
 * seed (ON CONFLICT (obligation_code) DO NOTHING keeps the seed
 * idempotent on every boot, but does NOT overwrite local edits).
 */

import { Pool } from "pg";
import { logger } from "../logger";

/** Canonical obligation definition shared by every framework seed file. */
export interface ObligationDef {
  /** Globally unique code, e.g. "ISO27001-A.5.15", "NCA-ECC-1-1-1". */
  code: string;
  /** Source clause / article reference printed in the UI, e.g. "A.5.15". */
  clause: string;
  /** Domain / theme for grouping in the UI. */
  domain: string;
  /** Sort order within the framework — usually matches clause order. */
  order: number;
  /** Short title (≤ 100 chars). */
  title: string;
  /** Paraphrased description / control statement. */
  desc: string;
  /** mandatory / recommended / optional. */
  type: "mandatory" | "recommended" | "optional";
  /** Control flavour. */
  ctrl: "preventive" | "detective" | "corrective";
  /** How often compliance with this clause is checked. */
  freq:
    | "continuous"
    | "daily"
    | "weekly"
    | "monthly"
    | "quarterly"
    | "annual"
    | "event_driven";
  /** Risk priority. */
  priority: "critical" | "high" | "medium" | "low";
  /** Default responsible department label. */
  dept: string;
  /** Optional, free-text description of the auditor evidence required. */
  evidence?: string;
}

/**
 * Idempotent seed helper used by every framework seed function.
 *
 * - Does nothing if the regulation row does not exist (logs a warn).
 * - Does nothing if any obligation rows for this regulation already exist
 *   (the seed is one-shot per code; later edits stay).
 * - INSERTs every definition with ON CONFLICT (obligation_code) DO NOTHING.
 */
export async function runFrameworkSeed(
  pool: Pool,
  regulationCode: string,
  defs: ObligationDef[],
  label: string,
): Promise<void> {
  if (defs.length === 0) return;

  const reg = await pool.query(
    "SELECT id FROM regulations WHERE regulation_code = $1",
    [regulationCode],
  );
  if (reg.rows.length === 0) {
    logger.warn(
      `⚠️ [ComplianceSeed] ${regulationCode} regulation row missing — skipping ${label} obligations seed`,
    );
    return;
  }

  const regId = reg.rows[0].id;

  // Skip if every defined obligation already exists for this regulation
  // (the seed is one-shot per code; re-runs are no-ops thanks to the
  // ON CONFLICT below). Counting by regulation_id is reliable across
  // any obligation_code naming scheme.
  const existing = await pool.query(
    "SELECT COUNT(*) FROM obligations WHERE regulation_id = $1",
    [regId],
  );
  if (parseInt(existing.rows[0].count, 10) >= defs.length) {
    return;
  }

  logger.info(`🌱 [ComplianceSeed] Seeding ${label} obligations...`);

  for (const ob of defs) {
    await pool.query(
      `
      INSERT INTO obligations (
        obligation_code, regulation_id, article_reference, title, description,
        section_domain, section_order, clause_number,
        requirement_type, control_type, compliance_frequency, priority,
        responsible_department, evidence_requirements, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'applicable')
      ON CONFLICT (obligation_code) DO NOTHING
      `,
      [
        ob.code,
        regId,
        ob.clause,
        ob.title,
        ob.desc,
        ob.domain,
        ob.order,
        ob.clause,
        ob.type,
        ob.ctrl,
        ob.freq,
        ob.priority,
        ob.dept,
        ob.evidence ?? null,
      ],
    );
  }

  logger.info(
    `✅ [ComplianceSeed] ${label} obligations seeded (${defs.length} items)`,
  );
}
