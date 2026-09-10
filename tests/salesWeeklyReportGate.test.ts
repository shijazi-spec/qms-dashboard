/**
 * Guards the delivery contract on the daily Sales/SDR audit reports.
 *
 * These post to wp-sdr-sales-audits, a real team channel, so the two things
 * worth pinning are WHEN they may go out and in WHAT ORDER the guards run.
 *
 * NOTHING HERE INVOKES THE REPORTS.
 * The earlier version of this file called runDealComplianceWeeklyIfDue() and
 * asserted `ran === false`, which was safe only while delivery was off by
 * default. It is on now (Sarah 2026-09-10), so that same call would sail past
 * the gate, past the dedup lookup, and post to the channel from a test run.
 * A test that sends a message to a team is not a test. Everything below reads
 * the registry and the source instead.
 *
 * Run:  npx tsx tests/salesWeeklyReportGate.test.ts
 */

import { NOTIFICATION_SWITCHES } from "../src/utils/notificationSettings";
import { readFileSync } from "fs";
import { join } from "path";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("salesWeeklyReportGate");

const SRC = readFileSync(
  join(process.cwd(), "src/utils/scheduledJobs.ts"),
  "utf8",
);
/** Comments quote the patterns these assertions look for. Scan code only. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n=== Sales daily audit reports — delivery contract ===\n");

const sales = NOTIFICATION_SWITCHES.find(
  (s) => s.key === "sales_weekly_reports",
);

await suite.test("the switch exists and is ON by default", async () => {
  // Sarah reviewed the first reports and asked for them daily: the standing
  // state is "send". If this ever flips to false, the team silently stops
  // getting its worklist and nothing errors.
  suite.expectEqual(Boolean(sales), true, "sales_weekly_reports is registered");
  suite.expectEqual(sales?.defaultEnabled, true, "defaultEnabled is true");
});

await suite.test("it is still scoped to the Sales/SDR channel", async () => {
  // Standing rule: the SDR/Sales channel carries nothing from other sections,
  // and these carry nothing to other channels.
  suite.expectEqual(sales?.channel, "sales_sdr", "channel is sales_sdr");
});

await suite.test("it keeps its original key and env var", async () => {
  // The cadence changed from weekly to daily; the key did not. Renaming it
  // would orphan any override already stored against the old key and any
  // configured secret, and the switch would silently revert to its default.
  suite.expectEqual(sales?.envVar, "SALES_WEEKLY_SLACK_REPORTS", "env var kept");
});

// ── Ordering ───────────────────────────────────────────────────────────────
// Three guards, and the order is load-bearing.

await suite.test("the enabled check runs BEFORE the dedup lookup", async () => {
  // Gating at the send point would still write the dedup-ledger row, so the
  // first run after re-enabling would be suppressed as "already sent" —
  // turning delivery back on would appear to do nothing.
  for (const entity of ["deal_compliance", "active_deal_conflicts"]) {
    // Whitespace-tolerant: the formatter wraps one of these two calls across
    // lines, and a literal indexOf silently returned -1 for it — which then
    // slices from the end of the file and asserts against the wrong function.
    const dedupIdx = CODE.search(
      new RegExp(`salesReportPostedWithinHours\\(\\s*"${entity}"`),
    );
    suite.expectEqual(dedupIdx > -1, true, `${entity}: dedup call found`);
    const before = CODE.slice(Math.max(0, dedupIdx - 900), dedupIdx);
    suite.expectEqual(
      before.includes("salesWeeklyReportsEnabled()"),
      true,
      `${entity}: enabled check precedes the dedup lookup`,
    );
    suite.expectEqual(
      before.includes("isSalesReportHour()"),
      true,
      `${entity}: morning check precedes the dedup lookup`,
    );
  }
});

// ── Cadence ────────────────────────────────────────────────────────────────

await suite.test("the dedup window is under a day, not over", async () => {
  // The scheduler ticks on an interval, not at a fixed minute, so each day's
  // post can drift later. A 24h window would push the next one past the
  // morning and eventually skip a day outright.
  const m = /SALES_REPORT_DEDUP_HOURS\s*=\s*(\d+)/.exec(CODE);
  suite.expectEqual(m !== null, true, "SALES_REPORT_DEDUP_HOURS is declared");
  const hours = Number(m![1]);
  suite.expectEqual(
    hours > 12 && hours < 24,
    true,
    `dedup window is once-daily (${hours}h)`,
  );
});

await suite.test("no day-based dedup survives", async () => {
  // A leftover 6-day window would silently keep it weekly.
  suite.expectEqual(
    /MAKE_INTERVAL\(days\s*=>/.test(
      CODE.slice(CODE.indexOf("salesReportPostedWithinHours")),
    ),
    false,
    "the sales dedup is hours-based",
  );
});

await suite.test("the morning bound is a morning hour", async () => {
  const m = /SALES_REPORT_KSA_HOUR\s*=\s*(\d+)/.exec(CODE);
  suite.expectEqual(m !== null, true, "SALES_REPORT_KSA_HOUR is declared");
  const hour = Number(m![1]);
  suite.expectEqual(
    hour >= 5 && hour <= 10,
    true,
    `posts from ${hour}:00 KSA, which is the morning`,
  );
});

await suite.test("the hour bound is a floor, not a window", async () => {
  // A 07:00-11:00 window would skip a day entirely if the platform were busy
  // all morning — and a missing audit report looks exactly like a clean one.
  suite.expectEqual(
    /ksaHour\(\)\s*>=\s*SALES_REPORT_KSA_HOUR/.test(CODE),
    true,
    "isSalesReportHour is a >= floor",
  );
});

suite.finishOrExit();
