/**
 * North Star KPI source tables
 * ============================
 * Lightweight capture tables for the five North Star KPIs that had NO existing
 * data source in QMS, so they can auto-calculate and flow to the leadership
 * feed (see leadershipKpiFeed.ts) instead of being entered by hand:
 *
 *   Sara (Quality):
 *     - QM-KPI-004  QMS Adoption Rate          → qms_adoption
 *     - QM-KPI-007  Op. Excellence Value Real. → value_realization
 *   Maram (GRC):
 *     - GRC-KPI-002 Certification Milestone Delivery → certification_milestones
 *     - GRC-KPI-004  Evidence SLA Compliance         → evidence_requests
 *     - GRC-KPI-006 TPRA Vendor Risk Turnaround SLA → tpra_requests
 *
 * Each calculator returns { value, dataAvailable } and reports
 * dataAvailable:false when its table is EMPTY, so the feed omits the KPI and
 * the leadership platform keeps its manual value (never overwritten with 0).
 *
 * Data is captured via src/mastra/routes/northStarSourceRoutes.ts (REST
 * POST/GET, RBAC-gated). Definitions follow the "Quality North Star" deck;
 * tune the SQL if the managers refine a formula.
 */

import { pool } from "./kpiDatabase";
import { logger } from "./logger";
import { redactSensitiveDeep } from "./eventLogsDatabase";
import {
  CERTIFICATION_MILESTONE_PLAN,
  PLAN_VERSION,
  SOURCE_DOC,
  resolveMilestoneRegulationIds,
} from "./seeds/certificationMilestonePlan";

export async function initNorthStarSourceTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS certification_milestones (
      id SERIAL PRIMARY KEY,
      certification VARCHAR(100) NOT NULL,
      milestone_name VARCHAR(255) NOT NULL,
      planned_date DATE,
      delivered_date DATE,
      status VARCHAR(20) DEFAULT 'planned',
      milestone_type VARCHAR(20) DEFAULT 'plan',
      regulation_id INTEGER,
      milestone_key VARCHAR(100),
      plan_version VARCHAR(20),
      source_doc VARCHAR(50),
      owner VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Certification Milestone Plan (GRQ-PLAN-2026-01) support. milestone_type
  // partitions the plan's three sections; only 'plan' rows score GRC-KPI-002.
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS milestone_type VARCHAR(20) DEFAULT 'plan'`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS regulation_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS milestone_key VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS plan_version VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS source_doc VARCHAR(50)`,
  );
  // Idempotency key for the plan seed.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_certification_milestones_key
       ON certification_milestones(milestone_key) WHERE milestone_key IS NOT NULL`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evidence_requests (
      id SERIAL PRIMARY KEY,
      request_ref VARCHAR(100),
      business_unit VARCHAR(255),
      requested_date DATE,
      sla_due_date DATE,
      delivered_date DATE,
      status VARCHAR(20) DEFAULT 'open',
      owner VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tpra_requests (
      id SERIAL PRIMARY KEY,
      vendor_name VARCHAR(255) NOT NULL,
      requested_date DATE,
      sla_due_date DATE,
      completed_date DATE,
      status VARCHAR(20) DEFAULT 'open',
      owner VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qms_adoption (
      id SERIAL PRIMARY KEY,
      business_unit VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(20) DEFAULT 'not_started',
      adoption_date DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS value_realization (
      id SERIAL PRIMARY KEY,
      initiative_name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      target_value NUMERIC(14, 2),
      realized_value NUMERIC(14, 2),
      period VARCHAR(20),
      status VARCHAR(20) DEFAULT 'in_progress',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Generic capture for OKR KRs that are ratios / reductions / time-averages
  // with no other QMS source. One row per metric per period; latest row wins.
  // `metric_code` is the feed KPI code (e.g. QM-KPI-011).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS okr_metric_entries (
      id SERIAL PRIMARY KEY,
      metric_code VARCHAR(20) NOT NULL,
      period VARCHAR(20),
      numerator NUMERIC(14, 2),
      denominator NUMERIC(14, 2),
      baseline NUMERIC(14, 2),
      current_val NUMERIC(14, 2),
      avg_days NUMERIC(10, 2),
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  logger.info("✅ [NorthStarSources] source tables ready");
  await seedCertificationMilestonePlan();
}

/**
 * Seed the approved Certification Milestone Plan. Idempotent: ON CONFLICT on
 * milestone_key DO NOTHING, so redeploys never clobber operator edits
 * (delivered_date, status) made in the UI.
 *
 * The index on milestone_key is PARTIAL (WHERE milestone_key IS NOT NULL,
 * because pre-existing rows from the KPI Source Data form have no key), so the
 * ON CONFLICT clause MUST repeat that predicate — Postgres cannot infer a
 * partial unique index from a bare ON CONFLICT (milestone_key).
 */
export async function seedCertificationMilestonePlan(): Promise<{ inserted: number }> {
  // `regulations` is created lazily by complianceDatabase.initComplianceTables(),
  // which only runs inside compliance request handlers — never at boot. On a cold
  // database this seeder would otherwise throw and be swallowed by the caller's
  // generic catch, silently seeding nothing. Skip explicitly and retry next boot,
  // rather than seeding rows with null regulation_id that ON CONFLICT DO NOTHING
  // would never backfill.
  const regsReady = await pool.query(
    `SELECT to_regclass('public.regulations') AS t`,
  );
  if (!regsReady.rows[0]?.t) {
    logger.warn(
      "⏭️ [NorthStar] Certification Milestone Plan seed SKIPPED — `regulations` table does not exist yet (compliance module not initialised). Will retry on next boot.",
    );
    return { inserted: 0 };
  }

  const regs = await pool.query(
    `SELECT id, regulation_code FROM regulations`,
  );
  const idByCode: Record<string, number> = {};
  for (const r of regs.rows) idByCode[r.regulation_code] = Number(r.id);

  const rows = resolveMilestoneRegulationIds(CERTIFICATION_MILESTONE_PLAN, idByCode);
  let inserted = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO certification_milestones
         (milestone_key, milestone_type, certification, regulation_id,
          milestone_name, planned_date, status, owner, notes,
          plan_version, source_doc)
       VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10)
       ON CONFLICT (milestone_key) WHERE milestone_key IS NOT NULL DO NOTHING`,
      [
        r.milestone_key,
        r.milestone_type,
        r.certification,
        r.regulation_id,
        r.milestone_name,
        r.planned_date,
        r.owner,
        r.notes,
        PLAN_VERSION,
        SOURCE_DOC,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  logger.info(`✅ [NorthStar] Certification Milestone Plan seeded (${inserted} new rows)`);
  return { inserted };
}

/**
 * Generic calculator for capture-based OKR metrics. Reads the latest
 * okr_metric_entries row for `code` and computes per `kind`:
 *   ratio     → numerator / denominator × 100
 *   reduction → (baseline − current_val) / baseline × 100
 *   days      → avg_days (raw, lower-is-better)
 */
export function makeCaptureCalc(code: string, kind: "ratio" | "reduction" | "days") {
  return async () => {
    const r = await pool.query(
      `SELECT numerator, denominator, baseline, current_val, avg_days
       FROM okr_metric_entries WHERE metric_code = $1 ORDER BY id DESC LIMIT 1`,
      [code],
    );
    if (!r.rows.length) return { value: 0, dataAvailable: false };
    const row = r.rows[0];
    if (kind === "ratio") {
      const d = Number(row.denominator);
      if (!d) return { value: 0, dataAvailable: false };
      return { value: Math.round((Number(row.numerator) / d) * 1000) / 10, dataAvailable: true };
    }
    if (kind === "reduction") {
      const b = Number(row.baseline);
      if (!b) return { value: 0, dataAvailable: false };
      return { value: Math.round(((b - Number(row.current_val)) / b) * 1000) / 10, dataAvailable: true };
    }
    // days
    if (row.avg_days === null || row.avg_days === undefined) return { value: 0, dataAvailable: false };
    return { value: Math.round(Number(row.avg_days) * 10) / 10, dataAvailable: true };
  };
}

// ── Insert / list helpers (used by the routes) ──────────────────────────────

const TABLES: Record<string, { table: string; cols: string[] }> = {
  certification_milestones: {
    table: "certification_milestones",
    cols: [
      "certification",
      "milestone_name",
      "planned_date",
      "delivered_date",
      "status",
      "owner",
      "notes",
      "milestone_type",
      "regulation_id",
      "milestone_key",
      "plan_version",
      "source_doc",
    ],
  },
  evidence_requests: {
    table: "evidence_requests",
    cols: [
      "request_ref",
      "business_unit",
      "requested_date",
      "sla_due_date",
      "delivered_date",
      "status",
      "owner",
    ],
  },
  tpra_requests: {
    table: "tpra_requests",
    cols: [
      "vendor_name",
      "requested_date",
      "sla_due_date",
      "completed_date",
      "status",
      "owner",
    ],
  },
  qms_adoption: {
    table: "qms_adoption",
    cols: ["business_unit", "status", "adoption_date", "notes"],
  },
  value_realization: {
    table: "value_realization",
    cols: [
      "initiative_name",
      "category",
      "target_value",
      "realized_value",
      "period",
      "status",
      "notes",
    ],
  },
  okr_metric_entries: {
    table: "okr_metric_entries",
    cols: [
      "metric_code",
      "period",
      "numerator",
      "denominator",
      "baseline",
      "current_val",
      "avg_days",
      "note",
    ],
  },
};

export function isValidSource(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLES, name);
}

export async function listSource(name: string): Promise<any[]> {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown source: ${name}`);
  const r = await pool.query(
    `SELECT * FROM ${def.table} ORDER BY id DESC LIMIT 500`,
  );
  return r.rows;
}

export async function insertSource(
  name: string,
  body: Record<string, unknown>,
): Promise<any> {
  const def = TABLES[name];
  if (!def) throw new Error(`Unknown source: ${name}`);
  const cols = def.cols.filter((c) => body[c] !== undefined);
  if (cols.length === 0) throw new Error("No valid fields provided");
  const params = cols.map((_, i) => `$${i + 1}`);
  const vals = cols.map((c) => redactSensitiveDeep(body[c], c));
  const conflict =
    name === "qms_adoption"
      ? ` ON CONFLICT (business_unit) DO UPDATE SET ${cols
          .filter((c) => c !== "business_unit")
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", ")}, updated_at = NOW()`
      : "";
  const r = await pool.query(
    `INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${params.join(", ")})${conflict} RETURNING *`,
    vals,
  );
  return r.rows[0];
}

// ── Calculators (each omits when its capture table is empty) ─────────────────

/**
 * Pure on-time-delivery math for GRC-KPI-002. Kept out of SQL so it can be
 * unit-tested. A milestone counts as on time only when it was delivered on or
 * before its planned date; still-undelivered past-due rows count against us.
 */
export function summarizeMilestoneDelivery(
  rows: Array<{ planned_date: string; delivered_date: string | null; status: string }>,
  quarterStart: Date,
  quarterEnd: Date,
): { due: number; onTime: number; value: number; dataAvailable: boolean } {
  const inQuarter = rows.filter((r) => {
    if (r.status === "cancelled" || !r.planned_date) return false;
    const p = new Date(r.planned_date);
    return p >= quarterStart && p < quarterEnd;
  });
  const due = inQuarter.length;
  if (due === 0) return { due: 0, onTime: 0, value: 0, dataAvailable: false };
  const onTime = inQuarter.filter(
    (r) => r.delivered_date !== null && new Date(r.delivered_date) <= new Date(r.planned_date),
  ).length;
  return { due, onTime, value: Math.round((onTime / due) * 1000) / 10, dataAvailable: true };
}

/** GRC-KPI-002 — (milestones delivered on time / planned) × 100. */
export async function calcCertMilestoneDelivery() {
  // Scored PER QUARTER, per the deadline model: only certifications whose target
  // (planned) date falls in the CURRENT quarter count. On-time = achieved on/
  // before the target date; a later-quarter certification doesn't affect this
  // quarter, and one due earlier that's still missing counts against. ONLY
  // milestone_type = 'plan' rows may enter the denominator — the 7
  // framework_target rows and 2 dependency rows must never be counted.
  // node-postgres parses a DATE column into a JS Date object; String(dateObject)
  // renders it via the server's locale/timezone (e.g. "Sat Oct 31 2026 00:00:00
  // GMT+0300 (Arabian Standard Time)"), so slicing the first 10 chars produced
  // garbage like "Sat Oct 31" instead of an ISO date. Format the dates in SQL
  // instead so they arrive as plain 'YYYY-MM-DD' strings (or null) and no JS
  // Date conversion ever happens.
  const r = await pool.query(
    `SELECT TO_CHAR(planned_date, 'YYYY-MM-DD')   AS planned_date,
            TO_CHAR(delivered_date, 'YYYY-MM-DD') AS delivered_date,
            status
       FROM certification_milestones
      WHERE milestone_type = 'plan'
        AND planned_date IS NOT NULL`,
  );
  const now = new Date();
  const qStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  const qEnd = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 3, 1));
  const s = summarizeMilestoneDelivery(
    r.rows.map((x: any) => ({
      planned_date: x.planned_date as string,
      delivered_date: (x.delivered_date ?? null) as string | null,
      status: String(x.status ?? "planned"),
    })),
    qStart, qEnd,
  );
  if (!s.dataAvailable) {
    return { value: 0, dataAvailable: false, reason: "no_certifications_due_this_quarter" };
  }
  return {
    value: s.value,
    dataAvailable: true,
    details: { certifications_due_this_quarter: s.due, achieved_on_time: s.onTime },
  };
}

/** GRC-KPI-004 — (evidence delivered within SLA / total requests) × 100. */
export async function calcEvidenceSlaCompliance() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total,
      COUNT(*) FILTER (
        WHERE delivered_date IS NOT NULL
          AND (sla_due_date IS NULL OR delivered_date <= sla_due_date)
      )::int AS within_sla
    FROM evidence_requests
  `);
  const total = r.rows[0]?.total ?? 0;
  const within = r.rows[0]?.within_sla ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((within / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_requests: total, delivered_within_sla: within },
  };
}

/** GRC-KPI-006 — (TPRA completed within SLA / total requests) × 100. */
export async function calcTpraTurnaround() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total,
      COUNT(*) FILTER (
        WHERE completed_date IS NOT NULL
          AND (sla_due_date IS NULL OR completed_date <= sla_due_date)
      )::int AS within_sla
    FROM tpra_requests
  `);
  const total = r.rows[0]?.total ?? 0;
  const within = r.rows[0]?.within_sla ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((within / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_requests: total, completed_within_sla: within },
  };
}

/** QM-KPI-004 — (BUs adopted / total business units) × 100. */
export async function calcQmsAdoptionRate() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM qms_adoption) AS captured,
      (SELECT COUNT(*)::int FROM business_units WHERE is_active) AS total_bus,
      (SELECT COUNT(*)::int FROM qms_adoption WHERE status = 'adopted') AS adopted
  `);
  const captured = r.rows[0]?.captured ?? 0;
  const totalBus = r.rows[0]?.total_bus ?? 0;
  const adopted = r.rows[0]?.adopted ?? 0;
  // Need both a BU registry and at least one adoption record to be meaningful.
  if (captured <= 0 || totalBus <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((adopted / totalBus) * 1000) / 10,
    dataAvailable: true,
    details: { total_business_units: totalBus, adopted },
  };
}

/** QM-KPI-007 — (realized value / target value) × 100, capped at 100. */
export async function calcValueRealization() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS rows,
      COALESCE(SUM(target_value), 0) AS target,
      COALESCE(SUM(realized_value), 0) AS realized
    FROM value_realization
    WHERE status <> 'cancelled'
  `);
  const rows = r.rows[0]?.rows ?? 0;
  const target = Number(r.rows[0]?.target ?? 0);
  const realized = Number(r.rows[0]?.realized ?? 0);
  if (rows <= 0 || target <= 0) return { value: 0, dataAvailable: false };
  const pct = Math.min(100, (realized / target) * 100);
  return {
    value: Math.round(pct * 10) / 10,
    dataAvailable: true,
    details: { target_value: target, realized_value: realized },
  };
}
