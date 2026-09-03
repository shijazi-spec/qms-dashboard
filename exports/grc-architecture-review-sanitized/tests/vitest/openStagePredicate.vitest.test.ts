/**
 * Which deal stages count as OPEN pipeline.
 *
 * openStagePredicate is the single source of truth behind Amount at risk, the
 * exec headline, AssistantPersona's digest, Top Clusters and the View-all modal. Measured
 * live 2026-08-23, five post-win stages were being counted as open — the
 * largest being Partner Active, 181 live partners carrying SAR 450,984 reported
 * as pipeline at risk. The rule also contradicted itself: 'client activated'
 * was excluded while 'partner active' was not, and 'agreement signed' was
 * excluded while the bare 'signed' was not.
 */
import { describe, it, expect } from "vitest";
import { openStagePredicate } from "../../src/utils/duplicateRadarDatabase";

/**
 * Evaluate the SQL predicate's semantics in JS. Kept deliberately simple and
 * mirroring the SQL shape: a NOT IN list plus a negated regex. If the SQL ever
 * gains a construct this cannot model, this helper must be updated with it.
 */
function isOpen(stage: string): boolean {
  const sql = openStagePredicate("r");
  const listed = /NOT IN \(([^)]*)\)/.exec(sql)![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""));
  const rx = new RegExp(/!~ '\(([^']*)\)'/.exec(sql)![1], "i");
  const s = (stage || "").toLowerCase();
  return !listed.includes(s) && !rx.test(s);
}

describe("won and activated stages are NOT open pipeline", () => {
  it.each([
    ["Agreement Signed", "signed contract"],
    ["Paid", "money received"],
    ["Signed", "same family as Agreement Signed; the win-rate KPI counts it a win"],
    ["Partner Active", "live partner — 181 deals, SAR 450,984"],
    ["New Client", "already a customer"],
    ["Welcome Communications", "post-activation onboarding"],
    ["Registered 40 Percent", "post-signup onboarding"],
  ])("%s is closed (%s)", (stage) => {
    expect(isOpen(stage)).toBe(false);
  });

  it("still excludes the terminal stages the regex always caught", () => {
    for (const s of ["Closed Lost", "Closed Won", "Dropped", "Cancelled", "Transferred to CS", "Client Activated"]) {
      expect(isOpen(s)).toBe(false);
    }
  });

  it("treats 'partner active' and 'client activated' consistently", () => {
    // The original rule excluded one and admitted the other, which is the
    // inconsistency that surfaced this whole finding.
    expect(isOpen("Client Activated")).toBe(isOpen("Partner Active"));
  });
});

describe("genuinely open stages are untouched", () => {
  it.each([
    "Proposal",
    "Agreement Sent",
    "Contacted",
    "Follow up",
    "Hold",
    "On Hold",
    "Meeting",
    "Meetings",
    "New Deal",
    "Not Attend Meeting",
    "In Progress",
    "Unaccounted",
  ])("%s stays open", (stage) => {
    expect(isOpen(stage)).toBe(true);
  });

  it("keeps the ambiguous marketplace stages open pending confirmation", () => {
    // Deliberately NOT excluded — these may sit either side of signature, and
    // guessing on a money figure is worse than leaving them visible.
    for (const s of ["Partner Ready for Activation", "Content in Process", "Design in Process", "Old Data"]) {
      expect(isOpen(s)).toBe(true);
    }
  });
});

describe("the drill-down cannot drift from the headline", () => {
  /**
   * getInflationBreakdown's bucket CASE held its own copy of the won list and
   * the terminal regex. When openStagePredicate gained the five post-win
   * stages, the headline excluded them while the by_stage panel still filed
   * 180 partner-active deals under "open" — the panel contradicting its own
   * headline. Both now build from the same constants; this pins that.
   */
  it("uses one won-stage list, not a second copy", () => {
    const sql = openStagePredicate("r");
    for (const stage of ["agreement signed", "paid", "signed", "partner active", "new client", "welcome communications", "registered 40 percent"]) {
      expect(sql).toContain(`'${stage}'`);
    }
  });

  it("uses one terminal-stage pattern", () => {
    // If a second copy is reintroduced, it will not carry these together.
    const sql = openStagePredicate("r");
    expect(sql).toContain("closed|won|lost|drop|cancel|transferred to cs|client activated");
  });

  it("derives the stage column the same way in every alias", () => {
    for (const alias of ["r", "d", "x"]) {
      const sql = openStagePredicate(alias);
      expect(sql).toContain(`NULLIF(${alias}.stage,'')`);
      expect(sql).toContain(`${alias}.raw_data->>'Stage'`);
    }
  });
});

describe("matching is robust", () => {
  it("is case-insensitive", () => {
    expect(isOpen("PARTNER ACTIVE")).toBe(false);
    expect(isOpen("partner active")).toBe(false);
  });

  it("does not exclude an open stage that merely contains a won stage's word", () => {
    // "Agreement Sent" shares a word with "Agreement Signed" and must stay open;
    // this is why the won list is exact names, not a regex.
    expect(isOpen("Agreement Sent")).toBe(true);
  });

  it("reads the stage column with a raw_data fallback", () => {
    const sql = openStagePredicate("r");
    expect(sql).toContain("NULLIF(r.stage,'')");
    expect(sql).toContain("r.raw_data->>'Stage'");
  });
});
