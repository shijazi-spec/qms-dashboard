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
}

export const SEED_BUS: QualityReportBUSeed[] = [
  { bu_key: "sdr_b2b", bu_name: "SDR (B2B)", channel: "B2B", fn: "sdr", sort_order: 1 },
  { bu_key: "sales_b2b", bu_name: "Sales (B2B)", channel: "B2B", fn: "sales", sort_order: 2 },
  { bu_key: "cs_b2b", bu_name: "Customer Success (B2B)", channel: "B2B", fn: "cs", sort_order: 3 },
  { bu_key: "sdr_b2c", bu_name: "SDR (B2C)", channel: "B2C", fn: "sdr", sort_order: 4 },
  { bu_key: "sales_b2c", bu_name: "Sales (B2C)", channel: "B2C", fn: "sales", sort_order: 5 },
  { bu_key: "cs_b2c", bu_name: "Customer Success (B2C)", channel: "B2C", fn: "cs", sort_order: 6 },
  { bu_key: "partnership_mp", bu_name: "Partnership (MP)", channel: "MP", fn: "partnership", sort_order: 7 },
  { bu_key: "onboarding_mp", bu_name: "Onboarding (MP)", channel: "MP", fn: "onboarding", sort_order: 8 },
  { bu_key: "partnersuccess_mp", bu_name: "PartnerSuccess (MP)", channel: "MP", fn: "partnersuccess", sort_order: 9 },
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
      sort_order        INTEGER NOT NULL DEFAULT 0,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
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
      `INSERT INTO quality_report_bus (bu_key, bu_name, channel, segment, fn, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bu_key) DO NOTHING`,
      [b.bu_key, b.bu_name, b.channel, channelToSegment(b.channel), b.fn, b.sort_order],
    );
  }
  tablesReady = true;
  logger.info("[QualityReports] tables ensured + seeded");
}
