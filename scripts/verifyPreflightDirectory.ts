/**
 * Preflight CS-client directory verifier.
 *
 *   npx tsx scripts/verifyPreflightDirectory.ts
 *
 * Run this in the REPLIT SHELL (where DATABASE_URL is set) to confirm the
 * Preflight existing-client guard is healthy WITHOUT republishing or re-running
 * an Excel export. It does two things:
 *
 *   1. DIRECTORY HEALTH — how many client names/domains the directory holds
 *      right now. A near-empty directory = the leak (clients land in PASS).
 *   2. KNOWN-CLIENT PROBE — feeds the real runPreflight() the names of clients
 *      that previously leaked into PASS. Each MUST come back block (active) or
 *      review (churned-in-cool-off) — never pass.
 *
 * Exit code is non-zero if the directory looks collapsed or any probe leaks,
 * so it can also gate a re-publish.
 */
import { runPreflight, getCsClientDirectoryStats } from "../src/utils/duplicateRadarPreflight";

// Clients confirmed to be in the CRM as live/recent customers — the exact set
// that was wrongly landing in the PASS file. company_name only (no email/phone)
// so Rule 1 can't fire and we test the directory (Rule 2) in isolation. Add the
// real red/orange names from the latest export here as they come up.
const PROBES: Array<{ company_name?: string; domain?: string; note?: string }> = [
  { company_name: "Riyad Bank", note: "New Deal phase — must BLOCK" },
  { company_name: "بنك الرياض", note: "Riyad Bank (Arabic) — must BLOCK via account-id link" },
  { domain: "riyadbank.com", note: "Riyad Bank by domain — must BLOCK" },
  { company_name: "SATORP" },
  { company_name: "Saudi Aramco" },
  { company_name: "Mozn" },
  { company_name: "SAMREF Saudi Aramco Mobil Refinery Company Ltd." },
  { company_name: "Diriyah" },
  { company_name: "SIDF" },
  { company_name: "Awqaf" },
  { company_name: "YASREF" },
  { company_name: "The Chefz" },
  { company_name: "JHAH" },
  { company_name: "CMA" },
  { company_name: "HungerStation" },
];

function pad(s: string, n: number): string {
  s = s ?? "";
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main() {
  console.log("\n=== 1. CS-CLIENT DIRECTORY HEALTH ===");
  const stats = await getCsClientDirectoryStats();
  console.log(
    `  names=${stats.names}  domains=${stats.domains}  tokens=${stats.tokens}\n` +
      `  active=${stats.active}  churned=${stats.churned}  built=${stats.built_at_iso}`,
  );
  const collapsed = stats.names < 50; // a real CRM has hundreds of client deals
  if (collapsed) {
    console.log(
      "  ⚠ DIRECTORY LOOKS COLLAPSED (<50 names). The Deals sync is likely\n" +
        "    stale/empty, or the phase/stage fields aren't mapped. Fix the sync\n" +
        "    before trusting any PASS file.",
    );
  } else {
    console.log("  ✓ directory populated.");
  }

  console.log("\n=== 2. KNOWN-CLIENT PROBE (must NOT be 'pass') ===");
  const resp = await runPreflight({
    rows: PROBES.map((p, i) => ({
      company_name: p.company_name ?? null,
      domain: p.domain ?? null,
      ref: String(i),
    })),
  });

  console.log(
    "  " +
      pad("INPUT", 46) +
      pad("VERDICT", 10) +
      pad("VIA", 14) +
      pad("PHASE", 16) +
      "NOTE",
  );
  let leaks = 0;
  for (let i = 0; i < PROBES.length; i++) {
    const p = PROBES[i]!;
    const r = resp.rows.find((x) => x.ref === String(i));
    const verdict = r?.verdict ?? "(no result)";
    const via = r?.matched_via ?? "-";
    const phase = r?.cs_phase ?? r?.lifecycle_state ?? "-";
    const label = p.company_name ?? p.domain ?? "?";
    const leaked = verdict === "pass";
    if (leaked) leaks++;
    console.log(
      "  " +
        (leaked ? "✗ " : "✓ ") +
        pad(label, 44) +
        pad(verdict, 10) +
        pad(String(via), 14) +
        pad(String(phase), 16) +
        (p.note ?? ""),
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    `  directory: ${collapsed ? "COLLAPSED" : "ok"} (${stats.names} names) · ` +
      `probe leaks: ${leaks}/${PROBES.length}`,
  );
  const ok = !collapsed && leaks === 0;
  console.log(ok ? "  ✓ PASS — safe to trust the existing-client guard.\n" : "  ✗ FAIL — do not send a PASS file to Sales yet.\n");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("verifyPreflightDirectory failed:", e);
  process.exit(2);
});
