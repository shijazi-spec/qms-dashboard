/**
 * The monthly missing-documents report.
 *
 * Sarah asked for this on 2026-08-25 alongside the quarter filter; the
 * on-demand Excel shipped and the monthly send did not, which went unnoticed
 * for a week.
 *
 * What is pinned here is the safety, not the prose. This job emails the Head
 * of Sales a report naming individual reps, on a schedule, with nobody
 * watching — so the failure modes that matter are: sending when it should not,
 * sending twice, sending to the wrong people, and quoting a compliance
 * percentage without its denominator.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildMonthlyMissingDocsEmail,
  monthlyMissingDocsRecipients,
  isMonthlyMissingDocsEnabled,
  periodKey,
  periodLabel,
} from "../../src/utils/missingDocsMonthlyReport";
import type { DealComplianceReportRow } from "../../src/utils/duplicateRadarDatabase";

let n = 0;
const deal = (o: Partial<DealComplianceReportRow> = {}): DealComplianceReportRow => ({
  id: `d${++n}`,
  name: "Deal",
  stage: "Paid",
  owner: "Owner A",
  account: "Acme",
  amount: 1000,
  created: "2026-08-01T00:00:00.000Z",
  compliant: true,
  missing_docs: [],
  attachment_count: 3,
  checked_at: "2026-08-31T00:00:00.000Z",
  // Layout / pipeline / product became required on the row when the
  // report gained those columns (2026-09-03).
  layout: "WalaPlus",
  pipeline: "Standard (Corporate)",
  product: "WalaPlus",
  ...o,
});
const bad = (o: Partial<DealComplianceReportRow> = {}) =>
  deal({ compliant: false, missing_docs: ["VAT Certificate"], attachment_count: 0, ...o });

const ENV = [
  "MISSING_DOCS_REPORT_ENABLED",
  "MISSING_DOCS_REPORT_RECIPIENTS",
] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("it does not send unless someone turns it on", () => {
  it("is off when the flag is unset", () => {
    delete process.env.MISSING_DOCS_REPORT_ENABLED;
    expect(isMonthlyMissingDocsEnabled()).toBe(false);
  });

  it("is off for anything that is not an explicit true", () => {
    // "1" and "yes" are included deliberately: they read as enabled to a human
    // setting the variable, and must not be, so a typo cannot start emailing
    // the Head of Sales.
    for (const v of ["", "false", "0", "yes", "TRUE-ish", "1", "enabled"]) {
      process.env.MISSING_DOCS_REPORT_ENABLED = v;
      expect(isMonthlyMissingDocsEnabled()).toBe(false);
    }
  });

  it("is on for true, case-insensitively", () => {
    for (const v of ["true", "TRUE", "True"]) {
      process.env.MISSING_DOCS_REPORT_ENABLED = v;
      expect(isMonthlyMissingDocsEnabled()).toBe(true);
    }
  });
});

describe("recipients come from the server, never a request", () => {
  it("falls back to the shared quality-report list", () => {
    delete process.env.MISSING_DOCS_REPORT_RECIPIENTS;
    expect(monthlyMissingDocsRecipients().length).toBeGreaterThan(0);
  });

  it("reads a comma-separated env list, trimming space", () => {
    process.env.MISSING_DOCS_REPORT_RECIPIENTS = " a@x.com , b@y.com ";
    expect(monthlyMissingDocsRecipients()).toEqual(["a@x.com", "b@y.com"]);
  });

  it("drops entries that are not addresses rather than mailing them", () => {
    process.env.MISSING_DOCS_REPORT_RECIPIENTS = "good@x.com,not-an-email,@nope,c@d.com";
    expect(monthlyMissingDocsRecipients()).toEqual(["good@x.com", "c@d.com"]);
  });

  it("returns nothing when the whole list is junk, so the caller can refuse", () => {
    process.env.MISSING_DOCS_REPORT_RECIPIENTS = "nonsense,also nonsense";
    expect(monthlyMissingDocsRecipients()).toEqual([]);
  });
});

describe("the period key is the send-once guard", () => {
  it("is stable for every day of the same month", () => {
    expect(periodKey(new Date(Date.UTC(2026, 7, 1)))).toBe("2026-08");
    expect(periodKey(new Date(Date.UTC(2026, 7, 31)))).toBe("2026-08");
  });

  it("zero-pads so months sort correctly as text", () => {
    expect(periodKey(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01");
  });

  it("differs across months and years", () => {
    expect(periodKey(new Date(Date.UTC(2026, 8, 1)))).not.toBe("2026-08");
    expect(periodKey(new Date(Date.UTC(2025, 7, 1)))).toBe("2025-08");
  });

  it("labels the month in words for the subject line", () => {
    expect(periodLabel(new Date(Date.UTC(2026, 7, 1)))).toBe("August 2026");
  });
});

describe("the email content", () => {
  // Paid is now OUT OF SCOPE (Customer Success owns those deals, not Sales —
  // see REPORT_STAGES in dealComplianceReportExport.ts), so both "bad Paid"
  // rows below are excluded from every figure. Only the Proposal (compliant)
  // and Agreement Signed (missing) rows remain in scope.
  const rows = [
    deal({ stage: "Proposal", owner: "Clean Rep" }),
    bad({ stage: "Paid", owner: "Busy Rep", amount: 500000 }),
    bad({ stage: "Paid", owner: "Busy Rep", amount: 250000 }),
    bad({ stage: "Agreement Signed", owner: "Other Rep", amount: 1000 }),
  ];
  const mail = buildMonthlyMissingDocsEmail(rows, {
    periodLabel: "August 2026",
    inScope: 10,
    dashboardUrl: "https://example.test/duplicates",
  });

  it("puts the count and the rate in the subject", () => {
    // In scope: 1 compliant Proposal + 1 missing Agreement Signed = 2 checked,
    // 1 missing => 50%.
    expect(mail.subject).toContain("August 2026");
    expect(mail.subject).toContain("1 deals missing documents");
    expect(mail.subject).toContain("50%");
  });

  it("states the coverage, so the percentage cannot be read as the whole pipeline", () => {
    expect(mail.text).toContain("2 of 10 in-scope deals had been checked");
    expect(mail.html).toContain("2 of 10 in-scope deals had been checked");
  });

  it("names the owners and their incomplete counts", () => {
    expect(mail.text).toContain("Other Rep: 1 missing");
  });

  it("does not name a rep with nothing outstanding", () => {
    expect(mail.text).not.toContain("Clean Rep");
  });

  it("does not name an owner whose only deals are out of scope (Paid)", () => {
    expect(mail.text).not.toContain("Busy Rep");
    expect(mail.html).not.toContain("Busy Rep");
  });

  it("breaks the figures down by stage, excluding Paid entirely", () => {
    expect(mail.text).toContain("Agreement Signed: 1/1 missing");
    expect(mail.text).not.toContain("Paid:");
    expect(mail.html).not.toContain(">Paid<");
  });

  it("carries the value at risk, excluding the out-of-scope Paid amounts", () => {
    // Only the Agreement Signed deal (SAR 1,000) is in scope; the two Paid
    // deals (SAR 500,000 + SAR 250,000) must not be counted.
    expect(mail.text).toContain("1,000");
    expect(mail.text).not.toContain("751,000");
  });

  it("keeps the total and the per-stage breakdown in agreement — the bug this fix closes", () => {
    // Before this fix, the totals were computed from ALL rows (including
    // out-of-scope Paid deals) while the stage table was filtered to
    // REPORT_STAGES, so the value at risk in the headline could not be
    // reconstructed from the stage rows underneath it. Assert the invariant
    // directly from the numbers embedded in the email text rather than
    // hardcoding both sides, so this catches a regression from either end.
    const totalMatch = mail.text.match(
      /missing required documents \(\d+%\), covering SAR ([\d,]+)\./,
    );
    expect(totalMatch).not.toBeNull();
    const total = Number(totalMatch![1].replace(/,/g, ""));

    // Isolate the "By stage" block only — "By owner" lines use the same
    // "— SAR N" suffix and would double-count if included.
    const stageBlockMatch = mail.text.match(/By stage:\n([\s\S]*?)\n\nBy owner:/);
    expect(stageBlockMatch).not.toBeNull();
    const stageLines = [...stageBlockMatch![1].matchAll(/— SAR ([\d,]+)$/gm)];
    expect(stageLines.length).toBeGreaterThan(0);
    const stageSum = stageLines.reduce(
      (n, m) => n + Number(m[1].replace(/,/g, "")),
      0,
    );

    expect(total).toBe(stageSum);
    expect(total).toBe(1000);
  });

  it("links to the dashboard instead of attaching per-deal detail", () => {
    expect(mail.html).toContain("https://example.test/duplicates");
  });

  it("repeats the two rules that stop the numbers being misread", () => {
    expect(mail.text).toContain("Percentages are of deals that have been checked");
    expect(mail.text).toContain("Nothing has been changed in the CRM");
  });

  it("escapes owner names into the HTML", () => {
    // stage must be in scope (Paid, the deal()/bad() default, is now filtered
    // out) or this deal never reaches the owner table at all.
    const m = buildMonthlyMissingDocsEmail(
      [bad({ owner: "<script>x</script>", stage: "Proposal" })],
      { periodLabel: "August 2026", inScope: 1 },
    );
    expect(m.html).not.toContain("<script>x</script>");
    expect(m.html).toContain("&lt;script&gt;");
  });

  it("says nothing was checked rather than reporting 0% compliance", () => {
    // The sweep failing must not be reported to Sales as perfect compliance.
    const m = buildMonthlyMissingDocsEmail([], { periodLabel: "August 2026", inScope: 900 });
    expect(m.subject).toContain("no deals checked yet");
    expect(m.text).toContain("no compliance figure to report");
    expect(m.text).not.toContain("0%");
  });

  it("omits the link section entirely when no dashboard URL is configured", () => {
    const m = buildMonthlyMissingDocsEmail(rows, { periodLabel: "August 2026", inScope: 2 });
    expect(m.html).not.toContain("Open Deal Compliance");
  });

  it("says all deals were checked once coverage is complete", () => {
    // Only 2 of the 4 fixture rows are in scope (Paid is excluded), so
    // inScope must match that in-scope count, not the raw row count, for
    // the "fully checked" branch to be the one under test.
    const m = buildMonthlyMissingDocsEmail(rows, { periodLabel: "August 2026", inScope: 2 });
    expect(m.text).toContain("All 2 in-scope deals had been checked");
  });
});
