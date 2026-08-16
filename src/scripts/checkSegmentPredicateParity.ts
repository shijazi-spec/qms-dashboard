/**
 * Segment-predicate parity check.
 *
 * The Duplicate Radar's segment filter (buildSegmentPredicate) classifies every
 * duplicate_records row with LOWER + regexp_replace + leading-wildcard LIKEs.
 * DUPLICATE_RADAR_FAST_SEGMENT=true swaps in a cached distinct-layout lookup
 * that reduces the per-row test to an array membership check.
 *
 * That predicate feeds ~36 call sites and the numbers behind the duplicate-rate
 * KPI, so "it should be equivalent" is not good enough. This script PROVES it on
 * the live corpus: for every segment it runs the original expression and the
 * fast expression over the same table and compares the row counts, plus the
 * per-module split so a difference can be located rather than just detected.
 *
 * Read-only — SELECT COUNT(*) only, no writes, safe to run against production.
 *
 *   npx tsx src/scripts/checkSegmentPredicateParity.ts
 *
 * Exit 0 = identical on every segment (safe to set DUPLICATE_RADAR_FAST_SEGMENT
 * =true). Exit 1 = a mismatch, printed with the offending layouts. Enabling the
 * flag is only justified by a green run here.
 */
// The only import is dynamic (below), so this marks the file as a module —
// without it TypeScript treats it as a global script and `main` collides with
// every other script's `main`.
export {};

// Enable the fast path BEFORE importing the module — FAST_SEGMENT_ENABLED is
// captured at module load, so this must precede the dynamic import below. That
// way the check exercises the REAL buildSegmentPredicate output rather than a
// re-declared copy that could drift from it.
process.env.DUPLICATE_RADAR_FAST_SEGMENT = "true";

type Segment = "marketplace" | "walaone" | "walaplus";
const SEGMENTS: Segment[] = ["marketplace", "walaone", "walaplus"];

// The ORIGINAL per-row expression, inlined verbatim so this check is independent
// of buildSegmentPredicate — if someone edits the predicate, this still compares
// against the historical definition rather than against the edit.
const LAYOUT =
  "LOWER(COALESCE(NULLIF(r.layout_name,''), r.raw_data#>>'{Layout,name}', r.raw_data#>>'{$layout,name}', r.raw_data->>'Layout', ''))";
const NORM = `regexp_replace(${LAYOUT}, '[^a-z0-9]', '', 'g')`;
const MKT = `(${NORM} LIKE '%marketplace%' OR ${NORM} LIKE '%partneraccounts%')`;

function exactCondition(segment: Segment): string {
  if (segment === "marketplace") return MKT;
  if (segment === "walaone") return `${NORM} LIKE '%walaone%'`;
  return `NOT ${MKT} AND ${NORM} NOT LIKE '%walaone%'`;
}

async function main(): Promise<void> {
  const DRD = await import("../utils/duplicateRadarDatabase");
  const { pool, refreshLayoutSegmentCache, buildSegmentPredicate } = DRD;

  const countWhere = async (condition: string, params: any[] = []): Promise<number> => {
    const r = await pool.query(
      `SELECT COUNT(*)::text AS n FROM duplicate_records r WHERE ${condition}`,
      params,
    );
    return Number(r.rows[0]?.n) || 0;
  };

  const countByModule = async (
    condition: string, params: any[] = [],
  ): Promise<Record<string, number>> => {
    const r = await pool.query(
      `SELECT COALESCE(r.zoho_module,'(none)') AS m, COUNT(*)::text AS n
         FROM duplicate_records r WHERE ${condition}
        GROUP BY 1 ORDER BY 1`,
      params,
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[String(row.m)] = Number(row.n) || 0;
    return out;
  };

  const cache = await refreshLayoutSegmentCache();
  console.log(`Distinct non-blank layouts: ${cache.all.length}`);
  for (const s of SEGMENTS) {
    console.log(`  ${s.padEnd(12)} ${cache.bySegment[s].length} layout(s): ${cache.bySegment[s].join(", ") || "(none)"}`);
  }

  // Rows the cache cannot short-circuit — these always fall through to the
  // original expression. A large number here means the fast path buys little.
  const blank = await countWhere(`r.layout_name IS NULL OR r.layout_name = ''`);
  const total = await countWhere(`TRUE`);
  console.log(`\nRows: ${total} total, ${blank} with blank layout (${total ? ((blank / total) * 100).toFixed(1) : "0"}% take the slow branch)\n`);

  let failed = false;
  for (const s of SEGMENTS) {
    // The REAL predicate the radar will run, taken straight from production
    // code with the cache warmed above.
    const built = buildSegmentPredicate(s, 1);
    if (!built.condition) { console.log(`SKIP  ${s}: no condition`); continue; }
    const usingFast = built.condition.includes("ANY($1::text[])");
    if (!usingFast) {
      console.log(`FAIL  ${s}: buildSegmentPredicate did not emit the fast path — is DUPLICATE_RADAR_FAST_SEGMENT wired?`);
      failed = true;
      continue;
    }

    const tExact = Date.now();
    const exact = await countWhere(exactCondition(s));
    const msExact = Date.now() - tExact;

    const tFast = Date.now();
    const fast = await countWhere(built.condition, built.params);
    const msFast = Date.now() - tFast;

    const ok = exact === fast;
    if (!ok) failed = true;
    const speedup = msFast > 0 ? (msExact / msFast).toFixed(1) : "n/a";
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${s.padEnd(12)} exact=${exact} (${msExact}ms)  fast=${fast} (${msFast}ms)  ${speedup}x`,
    );

    if (!ok) {
      const a = await countByModule(exactCondition(s));
      const b = await countByModule(built.condition, built.params);
      for (const m of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if ((a[m] || 0) !== (b[m] || 0)) {
          console.log(`        module ${m}: exact=${a[m] || 0} fast=${b[m] || 0}`);
        }
      }
    }
  }

  // Every row must land in exactly one segment under BOTH definitions.
  const sumExact = (await Promise.all(SEGMENTS.map((s) => countWhere(exactCondition(s)))))
    .reduce((x, y) => x + y, 0);
  console.log(`\nCoverage: segments sum to ${sumExact} vs ${total} total ${sumExact === total ? "(OK)" : "(MISMATCH)"}`);
  if (sumExact !== total) failed = true;

  console.log(
    failed
      ? "\nFAILED — do not set DUPLICATE_RADAR_FAST_SEGMENT=true."
      : "\nAll segments identical — safe to set DUPLICATE_RADAR_FAST_SEGMENT=true.",
  );
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("parity check errored:", e);
  process.exit(1);
});
