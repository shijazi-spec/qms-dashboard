/**
 * Guards the delivery gate on the weekly Sales/SDR Slack reports.
 *
 * These post to wp-sdr-sales-audits, a real team channel. Their only other
 * guard is a 6-day dedup on `related_entity_type`, which cannot hold anything
 * back on a first run: both entity types are new, so the lookup finds nothing,
 * and it fails OPEN by design. So the env gate is the only thing standing
 * between a republish and an unannounced post to the Sales team.
 *
 * The gate must also short-circuit BEFORE the dedup lookup. Gating at the send
 * point instead would still write the dedup-ledger row, and the first run after
 * someone enables delivery would then be suppressed as "already sent" — the
 * failure mode being that turning the feature on appears to do nothing.
 *
 * Run:  npx tsx tests/salesWeeklyReportGate.test.ts
 */

import {
  runDealComplianceWeeklyIfDue,
  runActiveDealConflictsWeeklyIfDue,
} from "../src/utils/scheduledJobs";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("salesWeeklyReportGate");

console.log("\n=== weekly Sales report delivery gate ===\n");

const GATE = "SALES_WEEKLY_SLACK_REPORTS";

/** Run `fn` with the gate env var set to `value` (undefined = unset). */
async function withGate<T>(
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = process.env[GATE];
  if (value === undefined) delete process.env[GATE];
  else process.env[GATE] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
  }
}

// Unset is the state a fresh deploy is in — the one that matters most.
await suite.test("both reports are OFF when the gate is unset", async () => {
  await withGate(undefined, async () => {
    suite.expectEqual(
      (await runDealComplianceWeeklyIfDue()).ran,
      false,
      "deal compliance does not run",
    );
    suite.expectEqual(
      (await runActiveDealConflictsWeeklyIfDue()).ran,
      false,
      "active deal conflicts does not run",
    );
  });
});

await suite.test("only the exact string \"true\" opens the gate", async () => {
  // A gate that accepts "1"/"yes"/"TRUE " is a gate someone opens by accident.
  // "true" itself is deliberately NOT asserted here: that path posts to Slack.
  for (const v of ["", "false", "0", "1", "yes", "on", "TRUE ", " true"]) {
    await withGate(v, async () => {
      suite.expectEqual(
        (await runDealComplianceWeeklyIfDue()).ran,
        false,
        `gate stays shut for ${JSON.stringify(v)}`,
      );
    });
  }
});

await suite.test("case-insensitive \"TRUE\" is accepted", async () => {
  // Mirrors pulseAlertsEnabled(): lowercased before comparison, so an env var
  // typed in caps behaves the same. Asserted via the source, not by running
  // the report — invoking it with the gate open would post to the channel.
  const { readFileSync } = await import("fs");
  const src = readFileSync("src/utils/scheduledJobs.ts", "utf8");
  suite.expectEqual(
    /SALES_WEEKLY_SLACK_REPORTS[^)]*\)\s*\.toLowerCase\(\)\s*===\s*"true"/.test(
      src,
    ),
    true,
    "gate lowercases before comparing",
  );
});

await suite.test("the gate runs BEFORE the dedup ledger lookup", async () => {
  // Guards the ordering described in the file header: no ledger row may be
  // written while delivery is off. Checked structurally because the dedup
  // lookup needs a database and the gate deliberately never reaches it.
  const { readFileSync } = await import("fs");
  const src = readFileSync("src/utils/scheduledJobs.ts", "utf8");
  for (const entity of ["deal_compliance", "active_deal_conflicts"]) {
    const fn = src.slice(
      src.indexOf(`salesReportPostedWithinDays("${entity}"`) - 800,
      src.indexOf(`salesReportPostedWithinDays("${entity}"`),
    );
    suite.expectEqual(
      fn.includes("salesWeeklyReportsEnabled()"),
      true,
      `${entity}: gate precedes the dedup lookup`,
    );
  }
});

suite.finishOrExit();
