/**
 * Run the KPI auto-calc and print every KPI's computed value, grouped by owner —
 * straight from the database. The fastest way to CHECK the KPIs without the UI.
 *
 * Usage (DATABASE_URL must point at the QMS Postgres):
 *   DATABASE_URL=postgres://... npx tsx scripts/run-kpi-autocalc.ts
 *   # PowerShell: $env:DATABASE_URL="postgres://..."; npx tsx scripts/run-kpi-autocalc.ts
 *
 * Add --cycle-times to also run the Sales Proposal/Agreement cycle-time step
 * (needs Zoho API env vars; otherwise leave it off for a DB-only check):
 *   DATABASE_URL=... npx tsx scripts/run-kpi-autocalc.ts --cycle-times
 */
import {
  initKPITables,
  getKPIDashboardSummary,
} from "../src/utils/kpiDatabase";
import { initKPIChecklistTables } from "../src/utils/kpiChecklistDatabase";
import { runKPIAutoCalc } from "../src/utils/kpiAutoCalc";
import { pool as radarPool } from "../src/utils/duplicateRadarDatabase";

/** Quick data-source diagnostic so empty KPIs are explainable. */
async function printDiagnostics() {
  console.log("\n— Data source diagnostic —");
  const out: any[] = [];
  const safe = async (label: string, sql: string) => {
    try {
      const r = await radarPool.query(sql);
      out.push({ Source: label, Count: Number(r.rows[0]?.n ?? 0) });
    } catch (e) {
      out.push({ Source: label, Count: `error: ${(e as Error).message}` });
    }
  };
  await safe("call_records (total)", "SELECT COUNT(*)::int n FROM call_records");
  await safe(
    "call_records outbound+lead-linked, 30d",
    "SELECT COUNT(*)::int n FROM call_records WHERE lower(coalesce(direction,'outbound'))='outbound' AND lead_id IS NOT NULL AND call_date >= NOW() - INTERVAL '30 days'",
  );
  await safe(
    "call_records with lead_id (any)",
    "SELECT COUNT(*)::int n FROM call_records WHERE lead_id IS NOT NULL",
  );
  await safe("deal_doc_compliance rows", "SELECT COUNT(*)::int n FROM deal_doc_compliance");
  await safe("local Leads", "SELECT COUNT(*)::int n FROM duplicate_records WHERE zoho_module='Leads'");
  await safe("local Deals", "SELECT COUNT(*)::int n FROM duplicate_records WHERE zoho_module='Deals'");
  console.table(out);
}

const OWNER_LABEL: Record<string, string> = {
  quality_manager: "Sarah (Quality)",
  grc_manager: "Maram (GRC)",
  grq_specialist: "AlHanouf (GRQ Specialist)",
  sdr_team: "SDR Team",
  sales_team: "Sales Team",
  shared: "Shared",
  governance_officer: "AlHanouf (GRQ Specialist)",
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "✗ DATABASE_URL is not set. Point it at the QMS Postgres and re-run.",
    );
    process.exit(1);
  }
  const includeCycleTimes = process.argv.includes("--cycle-times");

  await initKPITables();
  await initKPIChecklistTables();

  console.log(
    `\nRunning KPI auto-calc${includeCycleTimes ? " (incl. Sales cycle times via Zoho)" : " (DB-only; --cycle-times to include Zoho)"}…\n`,
  );
  const result = await runKPIAutoCalc(includeCycleTimes);
  console.log(
    `Recorded ${result.recorded} live value(s); skipped ${result.skipped}.\n`,
  );

  // Per-KPI recorded/skipped detail.
  console.log("— Auto-calc detail —");
  console.table(
    result.details.map((d) => ({
      Code: d.code,
      Value: d.value !== undefined ? d.value : "—",
      Skip_reason: d.reason ?? "",
    })),
  );

  // Current snapshot per owner.
  const summary = await getKPIDashboardSummary();
  const byOwner: Record<string, any[]> = {};
  for (const k of summary.kpiDetails) {
    const owner = OWNER_LABEL[k.owner_type] || k.owner_type;
    (byOwner[owner] ??= []).push(k);
  }

  for (const owner of Object.keys(byOwner)) {
    console.log(`\n=== ${owner} ===`);
    console.table(
      byOwner[owner].map((k) => ({
        Code: k.kpi_code,
        KPI: k.kpi_name,
        Mode: k.calc_mode || "manual",
        Current:
          k.latestValue !== null && k.latestValue !== undefined
            ? `${k.latestValue}${k.unit || ""}`
            : "—",
        Target: k.target_value != null ? `${k.target_value}${k.unit || ""}` : "—",
        Status: (k.status || "no_data").toUpperCase(),
        NorthStar: k.is_north_star ? "⭐" : "",
      })),
    );
  }

  const live = summary.kpiDetails.filter(
    (k: any) => k.latestValue !== null && k.latestValue !== undefined,
  ).length;
  console.log(
    `\n${live}/${summary.kpiDetails.length} active KPIs have a live value.\n`,
  );

  await printDiagnostics();
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ Failed:", err);
  process.exit(1);
});
