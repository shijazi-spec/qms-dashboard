/**
 * Print the leadership KPI feed (all 15 North Star KPIs) computed by QMS
 * straight from the database — no server needed.
 *
 * Usage (DATABASE_URL must point at the QMS Postgres):
 *   DATABASE_URL=<REDACTED_DSN> npx tsx scripts/run-leadership-kpis.ts
 *   # PowerShell:  $env:DATABASE_URL="<REDACTED_DSN>"; npx tsx scripts/run-leadership-kpis.ts
 */
import { buildLeadershipKpiFeed } from "../src/utils/leadershipKpiFeed";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "✗ DATABASE_URL is not set. Point it at the QMS Postgres and re-run.",
    );
    process.exit(1);
  }
  const feed = await buildLeadershipKpiFeed();
  const live = new Map(feed.kpis.map((k) => [k.code, k]));

  console.log(`\nLeadership KPIs — computed by QMS at ${feed.generated_at}\n`);
  const table = feed.definitions.map((d) => {
    const k = live.get(d.code);
    return {
      Code: d.code,
      KPI: d.name,
      Current: k ? `${k.value}${d.unit}` : "— (awaiting data)",
      Target: `${d.target}${d.unit}`,
      Status: k ? (k.status ?? "").toUpperCase() : "no data",
    };
  });
  console.table(table);

  const liveCount = feed.kpis.length;
  console.log(
    `\n${liveCount}/${feed.definitions.length} KPIs have live data; ` +
      `${feed.unavailable.length} awaiting data (${feed.unavailable
        .map((u) => u.code)
        .join(", ")}).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ Failed:", err);
  process.exit(1);
});
