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
// that was wrongly landing in the PASS file. Each probe carries a THROWAWAY
// email (a non-client domain not in CRM) so the row is actually EXAMINED and
// Rule 1 clears — exactly like a real Mawsool contact whose personal/free email
// doesn't reveal the company. That forces the Rule-2 directory NAME match
// (exact -> containment -> fuzzy), which is the path we must verify. A known
// client must come back block (active) or review (churned-in-cool-off); a
// `pass` OR a skip ("no result") is a LEAK/failure. Add real names as they come.
// POLICY (Sample User 2026-06-24): "CS clients + churned only". A company BLOCKS only
// if it has a CS phase (Onboarding/Adoption/Renewal/New Deal); churned in
// cool-off = review. Companies with only lost / sales / account-only records are
// re-engageable and must PASS. So each probe carries its EXPECTED verdict and we
// verify BOTH directions (clients block, non-clients pass) — a run is green only
// when behaviour matches the policy, not when everything blocks.
const PROBES: Array<{
  company_name?: string;
  domain?: string;
  expect: "block" | "pass";
  note?: string;
}> = [
  // Active CS clients in the live data -> must BLOCK (or review if churned).
  { company_name: "Example Organization", expect: "block", note: "Onboarding (Arabic name + <REDACTED_HOST> account)" },
  { company_name: "Example Organization", expect: "block", note: "Riyad Bank Arabic — Onboarding" },
  { domain: "<REDACTED_HOST>", expect: "block", note: "Riyad Bank by domain" },
  { company_name: "Example Organization", expect: "block", note: "Adoption" },
  { company_name: "Example Organization", expect: "block", note: "Adoption" },
  { company_name: "Example Organization", expect: "block", note: "Renewal" },
  { company_name: "Example Organization", expect: "block" },
  // No CS phase in the CRM (only lost / sales / account-only) -> correctly PASS
  // per the chosen policy (Sales may re-engage). If you consider any of these a
  // real client, CS must set its phase in Zoho — it's a data gap, not preflight.
  { company_name: "Example Organization", expect: "pass", note: "only Meeting/Closed-Lost deals" },
  { company_name: "Example Organization", expect: "block", note: "Renewal client (<REDACTED_HOST>)" },
  { company_name: "Example Organization", expect: "pass", note: "only Closed Lost" },
  { company_name: "Example Organization", expect: "pass", note: "only Contacted/Closed Lost" },
  { company_name: "Example Organization", expect: "block", note: "Adoption client" },
  { company_name: "Example Organization", expect: "pass", note: "account-only" },
  { company_name: "Example Organization", expect: "block", note: "active Adoption client (deal beyond the 12-row inspector sample)" },
  { company_name: "Example Organization", expect: "block", note: "ExampleOrg Adoption deal, <REDACTED_HOST> — leaked into PASS__905" },
  { company_name: "Example Organization", expect: "pass", note: "CMA CGM shipping (lost); 3-char name" },
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
      // Throwaway non-client email so the row is EXAMINED (not skipped) and
      // Rule 1 clears — mirrors a real contact with a personal email, forcing
      // the Rule-2 directory name match we need to verify.
      email: p.domain ? null : `pf-probe-${i}@<REDACTED_HOST>`,
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
  let wrong = 0;
  for (let i = 0; i < PROBES.length; i++) {
    const p = PROBES[i]!;
    const r = resp.rows.find((x) => x.ref === String(i));
    const verdict = r ? r.verdict : "(no result)";
    const via = r?.matched_via ?? "-";
    const phase = r?.cs_phase ?? r?.lifecycle_state ?? "-";
    const label = p.company_name ?? p.domain ?? "?";
    // Correct iff behaviour matches the expected verdict for the policy:
    //   expect "block" -> block (active) or review (churned-in-cool-off)
    //   expect "pass"  -> pass or warn (churned past cool-off = re-engageable)
    const ok =
      p.expect === "block"
        ? verdict === "block" || verdict === "review"
        : verdict === "pass" || verdict === "warn";
    if (!ok) wrong++;
    console.log(
      "  " +
        (ok ? "✓ " : "✗ ") +
        pad(label, 44) +
        pad(`${verdict}`, 10) +
        pad(`exp:${p.expect}`, 11) +
        pad(String(via), 14) +
        pad(String(phase), 14) +
        (p.note ?? ""),
    );
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    `  directory: ${collapsed ? "COLLAPSED" : "ok"} (${stats.names} names) · ` +
      `probes wrong vs policy: ${wrong}/${PROBES.length}`,
  );
  const ok = !collapsed && wrong === 0;
  console.log(ok ? "  ✓ PASS — safe to trust the existing-client guard.\n" : "  ✗ FAIL — do not send a PASS file to Sales yet.\n");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("verifyPreflightDirectory failed:", e);
  process.exit(2);
});
