/**
 * The monthly missing-documents report.
 *
 * Sample User this on 2026-08-25 alongside the quarter filter; the
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
  account: "Example Organization",
  amount: 1000,
  created: "2026-08-01T00:00:00.000Z",
  compliant: true,
  missing_docs: [],
  attachment_count: 3,
  checked_at: "2026-08-31T00:00:00.000Z",
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
    process.env.MISSING_DOCS_REPORT_RECIPIENTS = " user@example.invalid , user@example.invalid ";
    expect(monthlyMissingDocsRecipients()).toEqual(["user@example.invalid", "user@example.invalid"]);
  });

  it("drops entries that are not addresses rather than mailing them", () => {
    process.env.MISSING_DOCS_REPORT_RECIPIENTS = "user@example.invalid,not-an-email,@nope,user@example.invalid";
    expect(monthlyMissingDocsRecipients()).toEqual(["user@example.invalid", "user@example.invalid"]);
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
  const rows = [
    deal({ stage: "Proposal", owner: "Clean Rep" }),
    bad({ stage: "Paid", owner: "Busy Rep", amount: 500000 }),
    bad({ stage: "Paid", owner: "Busy Rep", amount: 250000 }),
    bad({ stage: "Agreement Signed", owner: "Other Rep", amount: 1000 }),
  ];
  const mail = buildMonthlyMissingDocsEmail(rows, {
    periodLabel: "August 2026",
    inScope: 10,
    dashboardUrl: "<REDACTED_URL>",
  });

  it("puts the count and the rate in the subject", () => {
    expect(mail.subject).toContain("August 2026");
    expect(mail.subject).toContain("3 deals missing documents");
    expect(mail.subject).toContain("75%");
  });

  it("states the coverage, so the percentage cannot be read as the whole pipeline", () => {
    expect(mail.text).toContain("4 of 10 in-scope deals had been checked");
    expect(mail.html).toContain("4 of 10 in-scope deals had been checked");
  });

  it("names the owners and their incomplete counts", () => {
    expect(mail.text).toContain("Busy Rep: 2 missing");
    expect(mail.text).toContain("Other Rep: 1 missing");
  });

  it("does not name a rep with nothing outstanding", () => {
    expect(mail.text).not.toContain("Clean Rep");
  });

  it("breaks the figures down by stage", () => {
    expect(mail.text).toContain("Paid: 2/2 missing");
    expect(mail.text).toContain("Agreement Signed: 1/1 missing");
  });

  it("carries the value at risk", () => {
    expect(mail.text).toContain("751,000");
  });

  it("links to the dashboard instead of attaching per-deal detail", () => {
    expect(mail.html).toContain("<REDACTED_URL>");
  });

  it("repeats the two rules that stop the numbers being misread", () => {
    expect(mail.text).toContain("Percentages are of deals that have been checked");
    expect(mail.text).toContain("Nothing has been changed in the CRM");
  });

  it("escapes owner names into the HTML", () => {
    const m = buildMonthlyMissingDocsEmail([bad({ owner: '<script>x</script>' })], {
      periodLabel: "August 2026",
      inScope: 1,
    });
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
    const m = buildMonthlyMissingDocsEmail(rows, { periodLabel: "August 2026", inScope: 4 });
    expect(m.html).not.toContain("Open Deal Compliance");
  });

  it("says all deals were checked once coverage is complete", () => {
    const m = buildMonthlyMissingDocsEmail(rows, { periodLabel: "August 2026", inScope: 4 });
    expect(m.text).toContain("All 4 in-scope deals had been checked");
  });
});
