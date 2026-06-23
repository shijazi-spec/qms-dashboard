/**
 * Decisive diagnostic: is the CS-client directory query erroring or timing out?
 * Runs the EXACT directory deals query RAW (no swallowing), timed, and prints
 * the real Postgres error if any. Then times a lightweight variant that uses
 * the dedicated `stage` COLUMN instead of parsing raw_data->>'Stage'.
 *
 *   npx tsx scripts/diagDirectoryQuery.ts
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

const CUSTOMER_STAGES = [
  "paid",
  "agreement signed",
  "closed won",
  "client activated",
  "transferred to cs",
];

async function timed(label: string, sql: string, params: any[]) {
  const t0 = Date.now();
  try {
    const r = await pool.query(sql, params);
    console.log(`  ${label}: ${r.rowCount} rows in ${Date.now() - t0}ms`);
    return r;
  } catch (e: any) {
    console.log(`  ${label}: ERROR after ${Date.now() - t0}ms -> ${e.message}`);
    return null;
  }
}

async function main() {
  console.log("\n=== is the `stage` column populated for deals? ===");
  const stageCol = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE stage IS NOT NULL AND stage <> '') AS with_stage,
            COUNT(*) FILTER (WHERE LOWER(stage) = ANY($1::text[])) AS customer_stage
       FROM duplicate_records WHERE record_type = 'deal'`,
    [CUSTOMER_STAGES],
  );
  console.log("  ", stageCol.rows[0]);

  console.log("\n=== how many deals have a Phase in raw_data? ===");
  const phaseCount = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE NULLIF(raw_data->>'Phase','') IS NOT NULL) AS with_phase,
            COUNT(*) FILTER (WHERE NULLIF(raw_data->>'Company_Domain','') IS NOT NULL) AS with_company_domain
       FROM duplicate_records WHERE record_type = 'deal'`,
    [],
  );
  console.log("  ", phaseCount.rows[0]);

  console.log("\n=== EXACT current directory query (raw_data->>'Stage') — timed ===");
  await timed(
    "current",
    `SELECT account_name, company_name, LOWER(domain) AS domain, gov_type, owner_name,
            COALESCE(NULLIF(raw_data->>'Phase',''), NULLIF(raw_data->>'CS_Phase',''), NULLIF(raw_data->>'Customer_Phase','')) AS phase,
            LOWER(COALESCE(NULLIF(raw_data->>'Company_Domain',''))) AS cs_domain,
            COALESCE(NULLIF(raw_data->>'Churn_Date',''), NULLIF(raw_data->>'ChurnDate','')) AS churn_date,
            raw_data->'Account_Name'->>'id' AS account_id,
            LOWER(COALESCE(raw_data->>'Stage','')) AS stage
       FROM duplicate_records
      WHERE record_type = 'deal'
        AND (
          COALESCE(NULLIF(raw_data->>'Phase',''), NULLIF(raw_data->>'CS_Phase',''), NULLIF(raw_data->>'Customer_Phase','')) IS NOT NULL
          OR LOWER(COALESCE(raw_data->>'Stage','')) = ANY($1::text[])
        )
      LIMIT 200000`,
    [CUSTOMER_STAGES],
  );

  console.log("\n=== LIGHT variant: use `stage` COLUMN for the stage filter — timed ===");
  await timed(
    "light(stage col)",
    `SELECT account_name, company_name, LOWER(domain) AS domain, gov_type, owner_name,
            COALESCE(NULLIF(raw_data->>'Phase',''), NULLIF(raw_data->>'CS_Phase',''), NULLIF(raw_data->>'Customer_Phase','')) AS phase,
            LOWER(COALESCE(NULLIF(raw_data->>'Company_Domain',''))) AS cs_domain,
            COALESCE(NULLIF(raw_data->>'Churn_Date',''), NULLIF(raw_data->>'ChurnDate','')) AS churn_date,
            raw_data->'Account_Name'->>'id' AS account_id,
            LOWER(COALESCE(stage, '')) AS stage
       FROM duplicate_records
      WHERE record_type = 'deal'
        AND (
          LOWER(COALESCE(stage,'')) = ANY($1::text[])
          OR NULLIF(raw_data->>'Phase','') IS NOT NULL
        )
      LIMIT 200000`,
    [CUSTOMER_STAGES],
  );

  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("diag failed:", e);
  process.exit(2);
});
