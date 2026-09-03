/**
 * Smoke test for /api/dashboard/quality-trend
 *
 * Verifies:
 *  - endpoint returns 200 with admin key
 *  - payload exposes audits[] and duplicates[]
 *  - audits are returned newest-last (ascending) so the dashboard chart
 *    plots time correctly (regression guard for the ASC/DESC LIMIT bug)
 *  - duplicates include a live snapshot with `clusters` and `pipeline_inflation_sar`
 *
 * Run:   npx tsx tests/testQualityTrendEndpoint.ts
 * Env:   ADMIN_KEY=...   (required)
 *        BASE_URL=<REDACTED_URL>  (default)
 */

const BASE_URL = process.env.BASE_URL || "<REDACTED_URL>";
const ADMIN_KEY = process.env.ADMIN_KEY;

async function main() {
  if (!ADMIN_KEY) {
    console.error("❌ ADMIN_KEY env var is required");
    process.exit(2);
  }

  const url = `${BASE_URL}/api/dashboard/quality-trend?limit=30`;
  console.log(`→ GET ${url}`);
  const res = await fetch(url, { headers: { "X-Admin-Key": ADMIN_KEY } });

  if (res.status !== 200) {
    console.error(`❌ expected 200, got ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }

  const data: any = await res.json();
  if (!Array.isArray(data.audits) || !Array.isArray(data.duplicates)) {
    console.error("❌ payload missing audits[] or duplicates[]");
    console.error(data);
    process.exit(1);
  }
  console.log(`✓ audits=${data.audits.length}, duplicates=${data.duplicates.length}`);

  // Regression guard: audits must be newest-last (ASC by date)
  const dates = data.audits
    .map((a: any) => (a.date ? new Date(a.date).getTime() : null))
    .filter((t: number | null) => t != null) as number[];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] < dates[i - 1]) {
      console.error(
        `❌ audits not in ascending order: index ${i - 1}=${new Date(dates[i - 1]).toISOString()} > ${i}=${new Date(dates[i]).toISOString()}`,
      );
      process.exit(1);
    }
  }
  console.log("✓ audits sorted ascending (newest-last)");

  // Same regression guard on duplicates (excluding the live-snapshot tail row)
  const dupDates = data.duplicates
    .map((d: any) => (d.date ? new Date(d.date).getTime() : null))
    .filter((t: number | null) => t != null) as number[];
  for (let i = 1; i < dupDates.length; i++) {
    if (dupDates[i] < dupDates[i - 1]) {
      console.error(
        `❌ duplicates not in ascending order: index ${i - 1} > ${i}`,
      );
      process.exit(1);
    }
  }
  console.log("✓ duplicates sorted ascending (newest-last)");

  // Live snapshot shape — last duplicate row should have the expected keys
  const tail = data.duplicates[data.duplicates.length - 1];
  if (tail) {
    const hasKeys =
      "clusters" in tail &&
      "pipeline_inflation_sar" in tail &&
      "date" in tail;
    if (!hasKeys) {
      console.error("❌ duplicate row missing expected keys", tail);
      process.exit(1);
    }
    console.log(
      `✓ duplicate snapshot shape ok (clusters=${tail.clusters}, inflation=${tail.pipeline_inflation_sar})`,
    );
  }

  console.log("\n✅ /api/dashboard/quality-trend smoke test passed");
}

main().catch((err) => {
  console.error("❌ unexpected error:", err);
  process.exit(1);
});
