import { createRedactedPool } from "./redactedPool";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
import { logger } from "./logger";

// Module-scope pool — matches the canonical pattern in duplicateRadarDatabase.ts
// (redactedPool.ts exports the `createRedactedPool` factory, not a bare `pool`).
const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});

export type Channel = "B2B" | "B2C" | "MP";
export type Segment = "walaplus" | "walaone" | "marketplace";

export function channelToSegment(ch: Channel): Segment {
  if (ch === "B2C") return "walaone";
  if (ch === "MP") return "marketplace";
  return "walaplus"; // B2B
}

export interface QualityReportBUSeed {
  bu_key: string;
  bu_name: string;
  channel: Channel;
  fn: string;
  sort_order: number;
  /** Default mapping to a KPI checklist BU (FRAMEWORK_BUSINESS_UNITS in
   *  kpiChecklistDatabase.ts). Backfilled onto existing rows ONLY where the
   *  admin hasn't set kpi_bu_name, so it never overrides a manual mapping. */
  kpi_bu_name: string;
  /**
   * Mapping to a KPI CATALOG owner (`kpi_definitions.owner_name`, e.g.
   * "SDR Team" / "Sales Team") — the performance KPIs shown on /kpis, most of
   * which are auto-calculated from CRM by kpiProcessCalc.ts.
   *
   * Deliberately NOT derived from `fn`. KPI owners are team-level
   * ("SDR Team") while BUs are team x segment (SDR B2B, SDR B2C), and per
   * Sarah 2026-08-16 the SDR KPIs belong to **SDR B2B only** — B2C must not
   * inherit them just because it shares fn="sdr". Null = no catalog KPIs
   * mapped, and the section renders "not mapped" rather than a misleading 0.
   */
  kpi_owner_name?: string | null;
}

export const SEED_BUS: QualityReportBUSeed[] = [
  // Catalog-KPI owners are seeded on the B2B rows ONLY (Sarah 2026-08-16):
  // SDR-KPI-* measures SDR B2B and SALES-KPI-* measures Sales B2B — the B2C
  // BUs must NOT inherit them just because they share the same `fn`. The
  // remaining BUs stay null on purpose so they read "not mapped" rather than
  // a misleading 0; map them from Admin: BU mappings once ownership is agreed.
  { bu_key: "sdr_b2b", bu_name: "SDR (B2B)", channel: "B2B", fn: "sdr", sort_order: 1, kpi_bu_name: "SDR", kpi_owner_name: "SDR Team" },
  { bu_key: "sales_b2b", bu_name: "Sales (B2B)", channel: "B2B", fn: "sales", sort_order: 2, kpi_bu_name: "Sales B2B", kpi_owner_name: "Sales Team" },
  { bu_key: "cs_b2b", bu_name: "Customer Success (B2B)", channel: "B2B", fn: "cs", sort_order: 3, kpi_bu_name: "Customer Success" },
  { bu_key: "sdr_b2c", bu_name: "SDR (B2C)", channel: "B2C", fn: "sdr", sort_order: 4, kpi_bu_name: "SDR" },
  { bu_key: "sales_b2c", bu_name: "Sales (B2C)", channel: "B2C", fn: "sales", sort_order: 5, kpi_bu_name: "Sales B2C" },
  { bu_key: "cs_b2c", bu_name: "Customer Success (B2C)", channel: "B2C", fn: "cs", sort_order: 6, kpi_bu_name: "Customer Success" },
  { bu_key: "partnership_mp", bu_name: "Partnership (MP)", channel: "MP", fn: "partnership", sort_order: 7, kpi_bu_name: "Marketplace" },
  { bu_key: "onboarding_mp", bu_name: "Onboarding (MP)", channel: "MP", fn: "onboarding", sort_order: 8, kpi_bu_name: "Marketplace" },
  { bu_key: "partnersuccess_mp", bu_name: "PartnerSuccess (MP)", channel: "MP", fn: "partnersuccess", sort_order: 9, kpi_bu_name: "Marketplace" },
];

let tablesReady = false;

export async function ensureQualityReportTables(): Promise<void> {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_report_bus (
      id                SERIAL PRIMARY KEY,
      bu_key            VARCHAR(40) NOT NULL UNIQUE,
      bu_name           VARCHAR(80) NOT NULL,
      channel           VARCHAR(8)  NOT NULL,
      segment           VARCHAR(16) NOT NULL,
      fn                VARCHAR(24) NOT NULL,
      head_email        VARCHAR(200),
      policy_department VARCHAR(100),
      kpi_bu_name       VARCHAR(80),
      kpi_owner_name    VARCHAR(100),
      sort_order        INTEGER NOT NULL DEFAULT 0,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  // Existing deployments already have the table, so CREATE TABLE IF NOT
  // EXISTS above is a no-op for them — the column has to be added
  // separately. Kept in lockstep with the canonical CREATE TABLE per the
  // strict schema-parity rule (check:schema-parity fails on drift, and a
  // column missing from the canonical source is what makes Replit's
  // deploy-time schema diff propose DROPping it).
  await pool.query(
    `ALTER TABLE quality_report_bus ADD COLUMN IF NOT EXISTS kpi_owner_name VARCHAR(100)`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_report_bu_owners (
      id          SERIAL PRIMARY KEY,
      bu_id       INTEGER NOT NULL REFERENCES quality_report_bus(id) ON DELETE CASCADE,
      owner_email VARCHAR(200) NOT NULL,
      UNIQUE (bu_id, owner_email)
    )
  `);
  // Idempotent seed: insert the 9 canonical BUs; never overwrite admin edits.
  for (const b of SEED_BUS) {
    await pool.query(
      `INSERT INTO quality_report_bus (bu_key, bu_name, channel, segment, fn, sort_order, kpi_bu_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (bu_key) DO NOTHING`,
      [b.bu_key, b.bu_name, b.channel, channelToSegment(b.channel), b.fn, b.sort_order, b.kpi_bu_name],
    );
    // Backfill the default KPI mapping onto rows already seeded before this
    // column had a default — ONLY when the admin hasn't set one, so a manual
    // kpi_bu_name is never clobbered (Sarah 2026-08-09).
    await pool.query(
      `UPDATE quality_report_bus SET kpi_bu_name = $2, updated_at = NOW()
        WHERE bu_key = $1 AND kpi_bu_name IS NULL`,
      [b.bu_key, b.kpi_bu_name],
    );
    // Same never-clobber rule for the catalog-KPI owner. Only BUs that carry
    // a seed value are touched (today: sdr_b2b -> "SDR Team"), so an admin
    // who clears or re-points a mapping keeps their choice across restarts.
    if (b.kpi_owner_name) {
      await pool.query(
        `UPDATE quality_report_bus SET kpi_owner_name = $2, updated_at = NOW()
          WHERE bu_key = $1 AND kpi_owner_name IS NULL`,
        [b.bu_key, b.kpi_owner_name],
      );
    }
  }
  tablesReady = true;
  logger.info("[QualityReports] tables ensured + seeded");
}

export interface QualityReportBU {
  id: number; bu_key: string; bu_name: string; channel: Channel; segment: Segment;
  fn: string; head_email: string | null; policy_department: string | null;
  kpi_bu_name: string | null; kpi_owner_name: string | null;
  sort_order: number; is_active: boolean; owners: string[];
}

async function ownersFor(buIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (!buIds.length) return map;
  const r = await pool.query(
    `SELECT bu_id, owner_email FROM quality_report_bu_owners WHERE bu_id = ANY($1::int[])`,
    [buIds],
  );
  for (const row of r.rows) {
    const list = map.get(row.bu_id) || [];
    list.push(row.owner_email);
    map.set(row.bu_id, list);
  }
  return map;
}

function rowToBU(row: any, owners: string[]): QualityReportBU {
  return {
    id: row.id, bu_key: row.bu_key, bu_name: row.bu_name, channel: row.channel,
    segment: row.segment, fn: row.fn, head_email: row.head_email ?? null,
    policy_department: row.policy_department ?? null, kpi_bu_name: row.kpi_bu_name ?? null,
    kpi_owner_name: row.kpi_owner_name ?? null,
    sort_order: Number(row.sort_order) || 0, is_active: row.is_active !== false, owners,
  };
}

export async function listBUs(): Promise<QualityReportBU[]> {
  await ensureQualityReportTables();
  const r = await pool.query(`SELECT * FROM quality_report_bus ORDER BY sort_order ASC, id ASC`);
  const owners = await ownersFor(r.rows.map((x) => x.id));
  return r.rows.map((row) => rowToBU(row, owners.get(row.id) || []));
}

export async function getBUByKey(buKey: string): Promise<QualityReportBU | null> {
  await ensureQualityReportTables();
  const r = await pool.query(`SELECT * FROM quality_report_bus WHERE bu_key = $1 LIMIT 1`, [buKey]);
  if (!r.rows[0]) return null;
  const owners = await ownersFor([r.rows[0].id]);
  return rowToBU(r.rows[0], owners.get(r.rows[0].id) || []);
}

// ---------------------------------------------------------------------------
// Department KPI classification
// ---------------------------------------------------------------------------
/**
 * The KPI-catalog owners that belong to a business unit we report on — today
 * "SDR Team" and "Sales Team". A KPI whose `owner_name` is in this set is a
 * DEPARTMENT KPI: it is hidden from the GRQ KPI Engine at /kpis and managed on
 * its Quality Reports BU page instead.
 *
 * Derived from the BU registry rather than stored on the KPI, so mapping a new
 * BU is the only action needed to separate its KPIs. Deliberately NOT keyed off
 * `kpi_definitions.owner_type` (which does carry 'sdr_team'/'sales_team'):
 * that would need a CHECK migration + backfill per new department, and could
 * drift from the registry, leaving two sources disagreeing about one row.
 *
 * ORPHANS ARE IMPOSSIBLE BY CONSTRUCTION: if no ACTIVE BU claims an owner, its
 * KPIs are not departmental and stay visible in /kpis. Deactivating a BU
 * returns its KPIs to the engine rather than hiding them everywhere. Do not
 * invert this.
 */
const DEPT_OWNER_TTL_MS = 60_000;
let deptOwnerCache: { at: number; names: string[] } | null = null;

/** Called by upsertBU/deleteBU so an admin mapping change lands without a restart. */
export function invalidateDepartmentKpiOwnerCache(): void {
  deptOwnerCache = null;
}

export async function getDepartmentKpiOwnerNames(): Promise<string[]> {
  if (deptOwnerCache && Date.now() - deptOwnerCache.at < DEPT_OWNER_TTL_MS) {
    return deptOwnerCache.names;
  }
  // NEVER THROWS. This is consulted by the KPI Engine list, its dashboard
  // summary, both exports, both export estimates and the KPI catalog — all
  // read paths whose job is to render KPIs, not to depend on the BU registry
  // being reachable. If this table is unavailable, degrading to "exclude
  // nothing" shows every KPI (the pre-separation view), which is strictly
  // better than 500-ing the whole KPI Engine.
  //
  // Regression that motivated this: adding the filter to GET /api/kpis made
  // that endpoint 500 wherever the registry could not be queried, because a
  // rejected lookup propagated straight out of the handler.
  //
  // The failure is NOT cached — a transient outage must not suppress the
  // filter for the whole TTL, so the next call retries.
  try {
    await ensureQualityReportTables();
    const r = await pool.query(
      `SELECT DISTINCT kpi_owner_name
         FROM quality_report_bus
        WHERE is_active = true
          AND kpi_owner_name IS NOT NULL
          AND kpi_owner_name <> ''`,
    );
    const names = r.rows.map((x: any) => String(x.kpi_owner_name));
    deptOwnerCache = { at: Date.now(), names };
    return names;
  } catch (e) {
    logger.warn(
      "[QualityReports] could not read the department KPI owners — showing ALL KPIs this call",
      { error: e instanceof Error ? e.message : String(e) },
    );
    return [];
  }
}

export async function upsertBU(input: {
  bu_key: string; bu_name: string; channel: Channel; fn: string;
  head_email?: string | null; policy_department?: string | null;
  kpi_bu_name?: string | null; kpi_owner_name?: string | null;
  sort_order?: number; is_active?: boolean;
}): Promise<QualityReportBU> {
  await ensureQualityReportTables();
  const segment = channelToSegment(input.channel); // ALWAYS derived
  const r = await pool.query(
    `INSERT INTO quality_report_bus
       (bu_key, bu_name, channel, segment, fn, head_email, policy_department, kpi_bu_name, kpi_owner_name, sort_order, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,true),NOW())
     ON CONFLICT (bu_key) DO UPDATE SET
       bu_name=EXCLUDED.bu_name, channel=EXCLUDED.channel, segment=EXCLUDED.segment,
       fn=EXCLUDED.fn, head_email=EXCLUDED.head_email, policy_department=EXCLUDED.policy_department,
       kpi_bu_name=EXCLUDED.kpi_bu_name, kpi_owner_name=EXCLUDED.kpi_owner_name,
       sort_order=EXCLUDED.sort_order,
       is_active=EXCLUDED.is_active, updated_at=NOW()
     RETURNING *`,
    [input.bu_key, input.bu_name, input.channel, segment, input.fn,
     input.head_email ?? null, input.policy_department ?? null, input.kpi_bu_name ?? null,
     input.kpi_owner_name ?? null,
     input.sort_order ?? 0, input.is_active ?? true],
  );
  const owners = await ownersFor([r.rows[0].id]);
  invalidateDepartmentKpiOwnerCache();
  return rowToBU(r.rows[0], owners.get(r.rows[0].id) || []);
}

export async function deleteBU(id: number): Promise<void> {
  await ensureQualityReportTables();
  await pool.query(`DELETE FROM quality_report_bus WHERE id = $1`, [id]);
  invalidateDepartmentKpiOwnerCache();
}

export async function setBUOwners(buId: number, emails: string[]): Promise<void> {
  await ensureQualityReportTables();
  const clean = Array.from(new Set(
    (emails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean),
  ));
  await pool.query(`DELETE FROM quality_report_bu_owners WHERE bu_id = $1`, [buId]);
  for (const email of clean) {
    await pool.query(
      `INSERT INTO quality_report_bu_owners (bu_id, owner_email) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [buId, email],
    );
  }
}
