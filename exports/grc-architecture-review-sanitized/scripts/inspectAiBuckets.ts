/**
 * Why does the AI-Applied tab show so many clusters? Breaks every duplicate
 * cluster down by status x has-auto_merge_pending x has-resolve/module_resolved,
 * and shows what the CURRENT vs PROPOSED AI-Applied filter would return.
 *
 *   npx tsx scripts/inspectAiBuckets.ts
 */
import { pool } from "../src/utils/duplicateRadarDatabase";

async function main() {
  const q = await pool.query(`
    WITH c AS (
      SELECT dc.id, dc.status,
        EXISTS(SELECT 1 FROM duplicate_merge_actions ma WHERE ma.cluster_id=dc.id AND ma.action_type='auto_merge_pending') AS pending,
        EXISTS(SELECT 1 FROM duplicate_merge_actions ma WHERE ma.cluster_id=dc.id AND ma.action_type IN ('resolve','module_resolved')) AS resolved_act,
        EXISTS(SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id=dc.id AND dr.record_type='account') AS has_account
      FROM duplicate_clusters dc
    )
    SELECT status, pending, resolved_act, COUNT(*) AS n,
           COUNT(*) FILTER (WHERE has_account) AS n_account
      FROM c GROUP BY 1,2,3 ORDER BY n DESC`);

  console.log("\n=== clusters by status x pending x resolved-action ===");
  console.log("  status     pending  resolvedAct   total   (account-clusters)");
  let curPending = 0, propPending = 0, propResolved = 0, curPendingAcct = 0, propPendingAcct = 0;
  for (const r of q.rows) {
    const n = Number(r.n), na = Number(r.n_account);
    console.log(
      `  ${String(r.status).padEnd(10)} ${String(r.pending).padEnd(8)} ${String(r.resolved_act).padEnd(12)} ${String(n).padStart(6)}   (${na})`,
    );
    const notResolvedStatus = r.status !== "resolved";
    // CURRENT AI-Applied: status<>'resolved' AND (pending OR resolved_act)
    if (notResolvedStatus && (r.pending || r.resolved_act)) { curPending += n; curPendingAcct += na; }
    // PROPOSED AI-Applied: status<>'resolved' AND NOT resolved_act AND pending
    if (notResolvedStatus && !r.resolved_act && r.pending) { propPending += n; propPendingAcct += na; }
    // PROPOSED Resolved: status='resolved' OR resolved_act
    if (r.status === "resolved" || r.resolved_act) propResolved += n;
  }

  console.log("\n=== AI-Applied tab counts ===");
  console.log(`  CURRENT  filter -> ${curPending}  (account-clusters: ${curPendingAcct})   <- what you see now`);
  console.log(`  PROPOSED filter -> ${propPending}  (account-clusters: ${propPendingAcct})   <- only genuinely pending`);
  console.log(`  PROPOSED Resolved tab would gain the rest (status=resolved OR resolve/module_resolved): ${propResolved} total`);
  console.log("");
  process.exit(0);
}
main().catch((e) => { console.error("inspect failed:", e); process.exit(2); });
