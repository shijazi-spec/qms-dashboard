/**
 * KPI Checklists — for KPIs whose live value can't be auto-computed from process
 * data and instead need a human to confirm a set of completion items (calc_mode
 * = 'checklist'). The KPI's value = (# done ÷ # items) × 100, recorded into
 * kpi_values like any other KPI so it shows on /kpis with a RAG status.
 *
 * Examples: "BU Framework Completion" (build + pilot-audit checkpoints per BU),
 * "Certification Milestones On-Track", "QMS Adoption Rate".
 */
import { logger } from "./logger";
import { pool, getKPIById, getKPIByCode, recordKPIValue } from "./kpiDatabase";
import { redactSensitiveDeep } from "./eventLogsDatabase";

export interface KPIChecklistItem {
  id?: number;
  kpi_id: number;
  /** Optional group header (e.g. a Business Unit). Flat checklists leave it blank. */
  section?: string | null;
  /** Optional stage within a section (the action-plan stage the sub-step belongs to). */
  stage?: string | null;
  item_text: string;
  is_done: boolean;
  note?: string | null;
  updated_by?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export async function initKPIChecklistTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_checklist_items (
      id SERIAL PRIMARY KEY,
      kpi_id INTEGER NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      section VARCHAR(150),
      stage VARCHAR(200),
      item_text TEXT NOT NULL,
      is_done BOOLEAN DEFAULT false,
      note TEXT,
      updated_by VARCHAR(150),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE kpi_checklist_items ADD COLUMN IF NOT EXISTS section VARCHAR(150)`,
  );
  await pool.query(
    `ALTER TABLE kpi_checklist_items ADD COLUMN IF NOT EXISTS stage VARCHAR(200)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_kpi_checklist_kpi ON kpi_checklist_items(kpi_id)`,
  );
  // Per-BU schedule (start date + deadline) for the per-BU action-plan KPIs, so a
  // manager can set when each BU's rollout starts and when it's due, and see overdue
  // BUs. One row per (kpi_id, BU section). No dates until set → nulls are fine.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_bu_schedule (
      id SERIAL PRIMARY KEY,
      kpi_id INTEGER NOT NULL REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      bu_name VARCHAR(200) NOT NULL,
      start_date DATE,
      deadline DATE,
      updated_by VARCHAR(200),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (kpi_id, bu_name)
    )
  `);
  logger.info("✅ [KPIChecklist] kpi_checklist_items table ready");

  // Commercial-8 BU naming migration (Sales B2B/B2C, Contact Center).
  await migrateToCommercialBUs();
  // Seed the two per-BU action-plan checklists (New_GRQ Final KPIs, 2026-06-30):
  //   QM-KPI-015 BU Framework Readiness = 7-stage readiness plan
  //   QM-KPI-008 BU Pilot Validation    = 5-stage pilot plan
  await seedActionPlan("QM-KPI-015", READINESS_PLAN);
  await seedActionPlan("QM-KPI-008", PILOT_PLAN);
}

/** Stage → sub-steps. An action plan is a list of these; each BU gets the whole plan. */
export type ActionPlan = Array<[string, string[]]>;

/** BU Framework Readiness (QM-KPI-015) — 7 stages, 19 sub-steps. A BU is "Ready for
 *  Pilot" when every sub-step is done. */
export const READINESS_PLAN: ActionPlan = [
  ["Stakeholder alignment", ["Kickoff meeting completed", "1:1 meetings with BU leaders and relevant parties completed"]],
  ["Process discovery and mapping", ["Current process reviewed", "Flowchart / process map drafted", "Required sub-processes identified"]],
  ["Process profile drafting", ["Process profile drafted", "Roles, stages, interfaces and timelines defined"]],
  ["Cross-functional review and revision", ["Review with BU stakeholders completed", "Review with related functions completed", "Comments consolidated and updated"]],
  ["Forms / templates / system alignment", ["Related forms reviewed or updated", "System / platform alignment checked", "Needed supporting documents finalized"]],
  ["Approval and release", ["Final BU / business owner approval obtained", "Controlled version released", "Announcement issued to concerned parties"]],
  ["Training and pilot readiness", ["Training material prepared", "Pilot team trained", "Pilot scope and readiness confirmed"]],
];

/** BU Pilot Validation (QM-KPI-008) — 5 stages, 13 sub-steps. A BU is "Pilot
 *  validated" when every sub-step is done. */
export const PILOT_PLAN: ActionPlan = [
  ["Pilot authorization", ["Pilot window agreed", "BU confirms readiness to start pilot"]],
  ["Audit planning", ["Audit schedule prepared", "Schedule shared with stakeholders", "Audit checklist prepared against the approved process"]],
  ["Pilot / audit execution", ["Internal pilot audit conducted", "Evidence collected", "Actual practice checked against released process"]],
  ["Reporting", ["Audit report prepared", "Gap summary prepared", "Nonconformities / observations communicated"]],
  ["Action planning", ["Action plan agreed with stakeholders", "CAPA / closure requests issued to owners"]],
];

/** Which action plan a per-BU KPI uses when a new BU is added. */
const PLAN_BY_CODE: Record<string, ActionPlan> = {
  "QM-KPI-015": READINESS_PLAN,
  "QM-KPI-008": PILOT_PLAN,
};

/** Add a Business Unit to a KPI's checklist, pre-filled with that KPI's action
 *  plan (Readiness / Pilot). No-op if the BU already exists. */
export async function addBuWithPlan(
  kpiId: number,
  buName: string,
  updatedBy?: string,
): Promise<{ items: number; existed: boolean }> {
  const bu = (buName || "").trim();
  if (!bu) return { items: 0, existed: false };
  const exists = await pool.query(
    `SELECT 1 FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2 LIMIT 1`,
    [kpiId, bu],
  );
  if (exists.rows.length) return { items: 0, existed: true };
  const kpi = await getKPIById(kpiId);
  const plan = (kpi?.kpi_code && PLAN_BY_CODE[kpi.kpi_code]) || READINESS_PLAN;
  let n = 0;
  for (const [stage, steps] of plan) {
    for (const step of steps) {
      await pool.query(
        `INSERT INTO kpi_checklist_items (kpi_id, section, stage, item_text, updated_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [kpiId, bu, stage, step, updatedBy || "system"],
      );
      n++;
    }
  }
  return { items: n, existed: false };
}

/** Rename a BU across the checklist AND its schedule. If the target name already
 *  exists its items are merged (kept) and the source is folded into it. */
export async function renameBu(
  kpiId: number,
  from: string,
  to: string,
): Promise<void> {
  const f = (from || "").trim();
  const t = (to || "").trim();
  if (!f || !t || f === t) return;
  await pool.query(
    `UPDATE kpi_checklist_items SET section = $3, updated_at = NOW()
      WHERE kpi_id = $1 AND section = $2`,
    [kpiId, f, t],
  );
  // Move the schedule row only if the target doesn't already have one; else drop
  // the stale source row (keep the target's dates).
  await pool.query(
    `UPDATE kpi_bu_schedule SET bu_name = $3, updated_at = NOW()
      WHERE kpi_id = $1 AND bu_name = $2
        AND NOT EXISTS (SELECT 1 FROM kpi_bu_schedule WHERE kpi_id = $1 AND bu_name = $3)`,
    [kpiId, f, t],
  );
  await pool.query(
    `DELETE FROM kpi_bu_schedule WHERE kpi_id = $1 AND bu_name = $2`,
    [kpiId, f],
  );
}

/** Remove a BU entirely (its checklist items + schedule). */
export async function removeBu(kpiId: number, bu: string): Promise<void> {
  const b = (bu || "").trim();
  if (!b) return;
  await pool.query(
    `DELETE FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`,
    [kpiId, b],
  );
  await pool.query(
    `DELETE FROM kpi_bu_schedule WHERE kpi_id = $1 AND bu_name = $2`,
    [kpiId, b],
  );
}

/**
 * Seed a KPI's per-BU action-plan checklist (stage + sub-steps per BU). Per-BU and
 * idempotent: rebuilds a BU only when its items don't match the current plan AND no
 * sub-step is ticked (never disturbs progress). Adds new BUs without touching others.
 */
export async function seedActionPlan(kpiCode: string, plan: ActionPlan): Promise<void> {
  const kpi = await getKPIByCode(kpiCode);
  if (!kpi?.id) return;
  const expected = plan.flatMap(([, steps]) => steps);
  let added = 0;
  for (const bu of FRAMEWORK_BUSINESS_UNITS) {
    const cur = await pool.query(
      `SELECT item_text, is_done FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`,
      [kpi.id, bu],
    );
    const have = new Set(cur.rows.map((r: any) => r.item_text));
    const matches = cur.rows.length === expected.length && expected.every((s) => have.has(s));
    if (matches) continue;
    // A BU whose items don't overlap the current plan at all is on a stale/legacy
    // plan (e.g. the old 9-phase list) — rebuild it even if ticked, because those
    // ticks belong to a different structure. Only preserve ticks that live on the
    // *current* plan (partial progress), so we never wipe real in-progress work.
    const expectedSet = new Set(expected);
    const onCurrentPlan = cur.rows.some((r: any) => expectedSet.has(r.item_text));
    if (cur.rows.length > 0 && cur.rows.some((r: any) => r.is_done) && onCurrentPlan) continue;
    await pool.query(`DELETE FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`, [kpi.id, bu]);
    for (const [stage, steps] of plan) {
      for (const step of steps) {
        await pool.query(
          `INSERT INTO kpi_checklist_items (kpi_id, section, stage, item_text, updated_by)
           VALUES ($1, $2, $3, $4, 'system')`,
          [kpi.id, bu, stage, step],
        );
      }
    }
    added++;
  }
  if (added > 0) logger.info(`🌱 [KPIChecklist] Seeded ${kpiCode} action plan for ${added} BU(s)`);
}

/**
 * Binary rate for a per-BU action-plan KPI = # BUs whose checklist is 100% done ÷
 * total planned BUs (the commercial 8). Matches the Excel formula. Returns null if
 * no BUs configured. Used by both QM-KPI-015 (Readiness) and QM-KPI-008 (Pilot).
 */
export async function actionPlanCompleteRate(
  kpiCode: string,
): Promise<{ value: number; complete: number; total: number } | null> {
  const kpi = await getKPIByCode(kpiCode);
  if (!kpi?.id) return null;
  // Denominator = the BUs ACTUALLY in this KPI's checklist (so adding/removing a
  // BU changes the rate), not a fixed list.
  const res = await pool.query(
    `SELECT section,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE is_done)::int AS done
       FROM kpi_checklist_items
      WHERE kpi_id = $1 AND COALESCE(TRIM(section), '') <> ''
      GROUP BY section`,
    [kpi.id],
  );
  const total = res.rows.length;
  if (total === 0) return null;
  let complete = 0;
  for (const r of res.rows) {
    if (Number(r.n) > 0 && Number(r.n) === Number(r.done)) complete++;
  }
  return { value: Math.round((complete / total) * 1000) / 10, complete, total };
}

/**
 * The same binary rate reconstructed "as of" a past date, from the platform's own
 * tick timestamps: a BU counts as complete only if EVERY item is done AND was last
 * updated on/before `asOf`. This lets us honestly backfill Q1/Q2 values from when
 * work was actually recorded in the platform (items ticked later don't count early).
 * Note: reflects when items were marked here — offline work done earlier but only
 * ticked recently will show in the later quarter (the admin can set a past value).
 */
export async function actionPlanCompleteRateAsOf(
  kpiCode: string,
  asOf: Date,
): Promise<{ value: number; complete: number; total: number } | null> {
  const kpi = await getKPIByCode(kpiCode);
  if (!kpi?.id) return null;
  const res = await pool.query(
    `SELECT section,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE is_done AND updated_at <= $2)::int AS done
       FROM kpi_checklist_items
      WHERE kpi_id = $1 AND COALESCE(TRIM(section), '') <> ''
      GROUP BY section`,
    [kpi.id, asOf],
  );
  const total = res.rows.length;
  if (total === 0) return null;
  let complete = 0;
  for (const r of res.rows) {
    if (Number(r.n) > 0 && Number(r.n) === Number(r.done)) complete++;
  }
  return { value: Math.round((complete / total) * 1000) / 10, complete, total };
}

/**
 * The Business Units the Quality governance framework is rolled out across
 * (Quality Plan 2026 → BU Coverage Plan). Editable in the UI afterwards.
 */
// Aligned to the Leadership Platform's framework list (2026-06-20): the 8
// required governance frameworks = 7 commercial departments + 1 overarching QMS.
export const FRAMEWORK_BUSINESS_UNITS = [
  "SDR",
  "Sales B2B",
  "Sales B2C",
  "Marketplace",
  "Customer Success",
  "Marketing",
  "Contact Center",
  "QMS",
];

/** The non-commercial BUs retired from these KPIs when we adopted the commercial 8.
 *  (WalaOne is NOT here — it IS the B2C product, renamed to Sales B2C in the migration.) */
const RETIRED_BUS = ["HR", "Finance", "IT", "Software", "GRC", "Quality"];

/** The two checklist phases that define the leadership milestones. */
export const PHASE_PUBLISHED = "Process Releasing";
export const PHASE_AUDITED = "Trial Audit Report";

/**
 * Standard framework-build action plan applied to every BU — Sarah's actual
 * methodology (generalized from the CS Action Plan, 2026-06-17). 9 phases ending
 * in the trial audit + report.
 */
export const BU_FRAMEWORK_ACTION_PLAN = [
  "One-to-One Meetings (BU Team)",
  "Process Drafting",
  "Process Revision",
  "One-to-One Meetings (Relevant Parties)",
  "Platform Review",
  "Process Releasing",
  "Training on Pilot Phase",
  "Trial Audit",
  "Trial Audit Report",
];

/**
 * Seed QM-KPI-015 (BU Framework Completion) with one section per Business Unit,
 * each carrying the standard action-plan checklist. Only seeds when the KPI has
 * NO checklist items yet (never overwrites edits). KPI value = % of all action
 * items done across all BUs (with equal templates this equals average BU
 * completion); per-BU progress is surfaced in the UI.
 */
export async function seedBuFrameworkChecklist(): Promise<void> {
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return;
  // Ensure EACH BU in the canonical list has its full 9-phase plan. Per-BU so
  // adding a new BU (e.g. QMS) seeds just that one without disturbing existing
  // ticks. Never deletes.
  let added = 0;
  for (const bu of FRAMEWORK_BUSINESS_UNITS) {
    const has = await pool.query(
      `SELECT COUNT(*)::int AS n FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`,
      [kpi.id, bu],
    );
    if (Number(has.rows[0]?.n || 0) > 0) continue;
    for (const step of BU_FRAMEWORK_ACTION_PLAN) {
      await pool.query(
        `INSERT INTO kpi_checklist_items (kpi_id, section, item_text, updated_by)
         VALUES ($1, $2, $3, 'system')`,
        [kpi.id, bu, step],
      );
    }
    added++;
  }
  if (added > 0) {
    logger.info(
      `🌱 [KPIChecklist] Seeded ${added} BU framework checklist(s) (${BU_FRAMEWORK_ACTION_PLAN.length} phases each)`,
    );
  }
}

/**
 * One-time migration to the Leadership-aligned commercial-8 BU list. Renames
 * Sales→Sales B2B, Customer Support→Contact Center, and WalaOne→Sales B2C (the
 * B2C product, keeping its real not-done progress) — all keeping their ticks —
 * and drops the remaining non-commercial BUs from BOTH the checklist and the BU
 * Coverage tracker. Idempotent (guarded on "Sales B2B" already existing).
 */
export async function migrateToCommercialBUs(): Promise<void> {
  const fw = await getKPIByCode("QM-KPI-015");
  if (!fw?.id) return;
  const guard = await pool.query(
    `SELECT COUNT(*)::int AS n FROM kpi_checklist_items WHERE kpi_id = $1 AND section = 'Sales B2B'`,
    [fw.id],
  );
  if (Number(guard.rows[0]?.n || 0) > 0) return; // already migrated

  await pool.query(`UPDATE kpi_checklist_items SET section='Contact Center' WHERE kpi_id=$1 AND section='Customer Support'`, [fw.id]);
  await pool.query(`UPDATE kpi_checklist_items SET section='Sales B2B' WHERE kpi_id=$1 AND section='Sales'`, [fw.id]);
  // WalaOne IS the B2C product → becomes Sales B2C, keeping its actual (not-done) progress.
  await pool.query(`UPDATE kpi_checklist_items SET section='Sales B2C' WHERE kpi_id=$1 AND section='WalaOne'`, [fw.id]);
  await pool.query(
    `DELETE FROM kpi_checklist_items WHERE kpi_id=$1 AND section = ANY($2::text[])`,
    [fw.id, RETIRED_BUS],
  );

  const bu = await getKPIByCode("QM-KPI-008");
  if (bu?.id) {
    await pool.query(`UPDATE kpi_bu_coverage SET bu_name='Contact Center' WHERE kpi_id=$1 AND bu_name='Customer Support'`, [bu.id]);
    await pool.query(`UPDATE kpi_bu_coverage SET bu_name='Sales B2B' WHERE kpi_id=$1 AND bu_name='Sales'`, [bu.id]);
    await pool.query(`UPDATE kpi_bu_coverage SET bu_name='Sales B2C' WHERE kpi_id=$1 AND bu_name='WalaOne'`, [bu.id]);
    await pool.query(
      `DELETE FROM kpi_bu_coverage WHERE kpi_id=$1 AND bu_name = ANY($2::text[])`,
      [bu.id, RETIRED_BUS],
    );
  }
  logger.info("🔀 [KPIChecklist] Migrated framework BUs to commercial 8 (Sales B2B/B2C, Contact Center, +QMS; dropped non-commercial).");
}

export interface BuMilestone {
  bu: string;
  published: boolean;
  audited: boolean;
}

/** Per-BU leadership milestones from the checklist: framework published ('Process
 *  Releasing' done) and audited ('Trial Audit Report' done). */
export async function buMilestones(): Promise<BuMilestone[]> {
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi?.id) return [];
  const res = await pool.query(
    `SELECT section AS bu,
       bool_or(is_done) FILTER (WHERE item_text = $2) AS published,
       bool_or(is_done) FILTER (WHERE item_text = $3) AS audited
     FROM kpi_checklist_items
     WHERE kpi_id = $1 AND COALESCE(section,'') <> ''
     GROUP BY section`,
    [kpi.id, PHASE_PUBLISHED, PHASE_AUDITED],
  );
  return res.rows.map((r: any) => ({
    bu: r.bu,
    published: !!r.published,
    audited: !!r.audited,
  }));
}

/**
 * Process & Quality Framework Completion (QM-KPI-015) = BUs whose framework is
 * PUBLISHED ÷ total required (the commercial 8). Binary per BU — matches the
 * Leadership Platform definition.
 */
export async function frameworkPublishedRate(): Promise<{
  value: number;
  published: number;
  total: number;
} | null> {
  const total = FRAMEWORK_BUSINESS_UNITS.length;
  if (total === 0) return null;
  const set = new Set(FRAMEWORK_BUSINESS_UNITS);
  const published = (await buMilestones()).filter((m) => set.has(m.bu) && m.published).length;
  return { value: Math.round((published / total) * 1000) / 10, published, total };
}

/**
 * BU Coverage Rate (QM-KPI-008) = BUs that are PUBLISHED *and* AUDITED ÷ total
 * required (stricter than Framework Completion). Binary per BU — matches the
 * Leadership Platform definition.
 */
export async function buGovernedRate(): Promise<{
  value: number;
  covered: number;
  total: number;
} | null> {
  const total = FRAMEWORK_BUSINESS_UNITS.length;
  if (total === 0) return null;
  const set = new Set(FRAMEWORK_BUSINESS_UNITS);
  const covered = (await buMilestones()).filter(
    (m) => set.has(m.bu) && m.published && m.audited,
  ).length;
  return { value: Math.round((covered / total) * 1000) / 10, covered, total };
}

export async function getChecklistItems(
  kpiId: number,
): Promise<KPIChecklistItem[]> {
  const res = await pool.query(
    `SELECT * FROM kpi_checklist_items WHERE kpi_id = $1
     ORDER BY section NULLS FIRST, id ASC`,
    [kpiId],
  );
  return res.rows;
}

export function checklistProgress(items: KPIChecklistItem[]): {
  total: number;
  done: number;
  pct: number;
} {
  const total = items.length;
  const done = items.filter((i) => i.is_done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct };
}

export interface ChecklistSection {
  section: string;
  total: number;
  done: number;
  pct: number;
  complete: boolean;
  items: KPIChecklistItem[];
  start_date?: string | null;
  deadline?: string | null;
}

/** Per-BU start date + deadline for a KPI, keyed by BU name. Missing = not set. */
export async function getBuSchedules(
  kpiId: number,
): Promise<Record<string, { start_date: string | null; deadline: string | null }>> {
  const res = await pool.query(
    `SELECT bu_name,
            to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(deadline,   'YYYY-MM-DD') AS deadline
       FROM kpi_bu_schedule WHERE kpi_id = $1`,
    [kpiId],
  );
  const out: Record<string, { start_date: string | null; deadline: string | null }> = {};
  for (const r of res.rows) out[r.bu_name] = { start_date: r.start_date, deadline: r.deadline };
  return out;
}

/** Set one BU's start date and/or deadline. Only the fields present in `patch` are
 *  changed (send an empty string / null to clear that field). */
export async function setBuSchedule(
  kpiId: number,
  buName: string,
  patch: { start_date?: string | null; deadline?: string | null },
  updatedBy?: string,
): Promise<void> {
  const bu = (buName || "").trim();
  if (!bu) return;
  // Make sure the row exists, then update only the field(s) actually sent — so
  // clearing an input stores NULL and touching one date doesn't wipe the other.
  await pool.query(
    `INSERT INTO kpi_bu_schedule (kpi_id, bu_name, updated_by)
     VALUES ($1, $2, $3) ON CONFLICT (kpi_id, bu_name) DO NOTHING`,
    [kpiId, bu, updatedBy || "system"],
  );
  const sets: string[] = [];
  const vals: any[] = [];
  let p = 1;
  if (patch.start_date !== undefined) { sets.push(`start_date = $${p++}`); vals.push(patch.start_date || null); }
  if (patch.deadline !== undefined) { sets.push(`deadline = $${p++}`); vals.push(patch.deadline || null); }
  if (!sets.length) return;
  sets.push(`updated_by = $${p++}`); vals.push(updatedBy || "system");
  sets.push(`updated_at = NOW()`);
  vals.push(kpiId, bu);
  await pool.query(
    `UPDATE kpi_bu_schedule SET ${sets.join(", ")} WHERE kpi_id = $${p++} AND bu_name = $${p}`,
    vals,
  );
}

/** Group items by section (BU) with per-section progress, in stable order. */
export function groupChecklistBySection(
  items: KPIChecklistItem[],
): ChecklistSection[] {
  const order: string[] = [];
  const map = new Map<string, KPIChecklistItem[]>();
  for (const it of items) {
    const key = (it.section || "").trim();
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(it);
  }
  return order.map((section) => {
    const secItems = map.get(section)!;
    const total = secItems.length;
    const done = secItems.filter((i) => i.is_done).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return { section, total, done, pct, complete: total > 0 && done === total, items: secItems };
  });
}

export async function addChecklistItem(
  kpiId: number,
  itemText: string,
  updatedBy?: string,
  section?: string,
): Promise<KPIChecklistItem> {
  const res = await pool.query(
    `INSERT INTO kpi_checklist_items (kpi_id, section, item_text, updated_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [
      kpiId,
      redactSensitiveDeep(section?.trim() || null, "section"),
      redactSensitiveDeep(itemText, "item_text"),
      redactSensitiveDeep(updatedBy || null, "updated_by"),
    ],
  );
  return res.rows[0];
}

export async function updateChecklistItem(
  itemId: number,
  patch: { item_text?: string; is_done?: boolean; note?: string },
  updatedBy?: string,
): Promise<KPIChecklistItem | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let p = 1;
  for (const key of ["item_text", "is_done", "note"] as const) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = $${p}`);
      values.push(redactSensitiveDeep(patch[key], key));
      p++;
    }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_by = $${p}`);
  values.push(redactSensitiveDeep(updatedBy || null, "updated_by"));
  p++;
  fields.push(`updated_at = NOW()`);
  values.push(itemId);
  const res = await pool.query(
    `UPDATE kpi_checklist_items SET ${fields.join(", ")} WHERE id = $${p} RETURNING *`,
    values,
  );
  return res.rows[0] || null;
}

export async function deleteChecklistItem(itemId: number): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM kpi_checklist_items WHERE id = $1`,
    [itemId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Recompute a checklist-mode KPI's value (= % of items done) and record it into
 * kpi_values for the current period. No-op if the KPI has no checklist items
 * yet (so it stays "--" rather than showing a fake 0%). Returns the % or null.
 */
/**
 * Framework completion for the BUs IN SCOPE THIS QUARTER only — i.e. BUs marked
 * 'in_progress' or 'postponed' in the BU Coverage tracker (e.g. Q2 = Marketplace
 * + Customer Success). value = phases done ÷ total phases across just those BUs,
 * NOT all 13 (which would be dragged to ~22% by the not-started BUs). Returns null
 * if no BU is in scope, so the KPI reads unavailable rather than a misleading 0.
 * Scope is controlled by editing BU statuses in the Manage BU Coverage modal.
 */
export async function frameworkInScopeProgress(): Promise<{
  done: number;
  total: number;
  pct: number;
} | null> {
  const fw = await getKPIByCode("QM-KPI-015");
  const bu = await getKPIByCode("QM-KPI-008");
  if (!fw?.id || !bu?.id) return null;
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_done)::int AS done
       FROM kpi_checklist_items
      WHERE kpi_id = $1
        AND section IN (
          SELECT bu_name FROM kpi_bu_coverage
           WHERE kpi_id = $2
             AND (
               status IN ('in_progress','postponed')
               -- a BU COMPLETED this quarter still counts (don't let finishing it
               -- drop the BU out of the denominator); BUs done in a prior period
               -- (no current-quarter due date, e.g. Sales/SDR 2025) stay excluded.
               OR (status = 'done'
                   AND due_date >= date_trunc('quarter', NOW())::date
                   AND due_date <  (date_trunc('quarter', NOW()) + interval '3 months')::date)
             )
        )`,
    [fw.id, bu.id],
  );
  const total = Number(res.rows[0]?.total || 0);
  const done = Number(res.rows[0]?.done || 0);
  if (total <= 0) return null;
  return { done, total, pct: Math.round((done / total) * 1000) / 10 };
}

export async function recordChecklistKPIValue(
  kpiId: number,
): Promise<number | null> {
  const kpi = await getKPIById(kpiId);
  if (!kpi) return null;
  let pct: number | null;
  if (kpi.kpi_code === "QM-KPI-015" || kpi.kpi_code === "QM-KPI-008") {
    // Binary action-plan KPIs: # BUs whose full checklist is done ÷ the commercial 8
    // (QM-KPI-015 = Readiness plan, QM-KPI-008 = Pilot Validation plan).
    const r = await actionPlanCompleteRate(kpi.kpi_code);
    pct = r ? r.value : null;
  } else {
    const items = await getChecklistItems(kpiId);
    if (items.length === 0) return null;
    pct = checklistProgress(items).pct;
  }
  if (pct === null) return null;
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  await recordKPIValue({
    kpi_id: kpiId,
    period_start: periodStart,
    period_end: periodEnd,
    actual_value: pct,
    calculated_by: "system_auto",
  });
  return pct;
}

/**
 * Per-BU framework progress from the QM-KPI-015 checklist: BU name → {done,total,pct}.
 * This is the single source of truth that BU Coverage (QM-KPI-008) is derived from.
 */
export async function getFrameworkProgressByBU(): Promise<
  Record<string, { done: number; total: number; pct: number }>
> {
  const out: Record<string, { done: number; total: number; pct: number }> = {};
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return out;
  const items = await getChecklistItems(kpi.id);
  for (const sec of groupChecklistBySection(items)) {
    const name = (sec.section || "").trim();
    if (!name) continue;
    out[name] = { done: sec.done, total: sec.total, pct: sec.pct };
  }
  return out;
}

/**
 * One-time pre-fill of the agreed FY2026 baseline on the Framework checklist:
 * Sales & SDR were completed in 2025 (all 9 phases done); Marketplace is postponed
 * at ~35% (first 3 of 9 phases). Customer Success and every other BU are driven by
 * live ticks. Only touches UNTOUCHED system-seeded phases (never overrides a human
 * tick), and skips any BU that already has a phase done — so it's idempotent and
 * safe to run on every boot.
 */
export async function backfillInitialFrameworkProgress(): Promise<void> {
  const kpi = await getKPIByCode("QM-KPI-015");
  if (!kpi || !kpi.id) return;
  const markAll = ["Sales", "SDR"];
  const markFirst: Record<string, number> = { Marketplace: 3 };

  const alreadyStarted = async (bu: string): Promise<boolean> => {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE is_done)::int AS done
         FROM kpi_checklist_items WHERE kpi_id = $1 AND section = $2`,
      [kpi.id, bu],
    );
    return Number(r.rows[0]?.done || 0) > 0;
  };

  let changed = false;
  for (const bu of markAll) {
    if (await alreadyStarted(bu)) continue;
    const r = await pool.query(
      `UPDATE kpi_checklist_items SET is_done = true, updated_at = NOW()
        WHERE kpi_id = $1 AND section = $2
          AND (updated_by IS NULL OR updated_by = 'system')`,
      [kpi.id, bu],
    );
    if ((r.rowCount ?? 0) > 0) changed = true;
  }
  for (const [bu, n] of Object.entries(markFirst)) {
    if (await alreadyStarted(bu)) continue;
    const r = await pool.query(
      `UPDATE kpi_checklist_items SET is_done = true, updated_at = NOW()
        WHERE id IN (
          SELECT id FROM kpi_checklist_items
           WHERE kpi_id = $1 AND section = $2
             AND (updated_by IS NULL OR updated_by = 'system')
           ORDER BY id ASC LIMIT $3
        )`,
      [kpi.id, bu, n],
    );
    if ((r.rowCount ?? 0) > 0) changed = true;
  }
  if (changed) {
    try {
      await recordChecklistKPIValue(kpi.id);
    } catch {
      /* recorded on the next recalc otherwise */
    }
    logger.info(
      "🌱 [KPIChecklist] Backfilled FY2026 framework baseline (Sales/SDR=100%, Marketplace~33%)",
    );
  }
}
