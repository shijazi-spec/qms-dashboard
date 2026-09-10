/**
 * QM-KPI-008 must have exactly ONE computation.
 *
 * It had two. `PROCESS_CALCULATORS["QM-KPI-008"]` -> calcBuCoverageTracked ->
 * buGovernedRate() computed AVERAGE governance coverage across the BUs with
 * partial credit (a BU 35% through its checklist counted 0.35). The leadership
 * feed's calcBuCoverageRate independently called
 * actionPlanCompleteRate("QM-KPI-008") — BINARY completion of the 5-stage pilot
 * plan over 8 planned BUs — under a comment asserting it was the "same value
 * /kpis records". It was not. runKPIAutoCalc records the calculator's figure,
 * so the dashboard and the leadership push sent two different numbers for one
 * north-star KPI code, and nothing compared them (found 2026-09-10).
 *
 * Resolved by making QM-KPI-008 "BU Coverage Rate" everywhere, with both paths
 * ending at buGovernedRate(). These tests keep it that way: a second
 * computation is exactly the kind of change that looks harmless in review.
 *
 * Structural, because calling either path needs a live database — and the bug
 * was never in the arithmetic, it was in which function got called.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Comments removed. Every assertion below scans this, not the raw text.
 *
 * The files involved now carry comments that QUOTE the banned call — that is
 * how the fix stays explained — so a guardrail reading raw source would fail
 * on the explanation and push someone to delete it. Same trap as
 * check-i18n.cjs reading t('key') inside a comment.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FEED = strip(read("src/utils/leadershipKpiFeed.ts"));
const CALC = strip(read("src/utils/kpiProcessCalc.ts"));
const COVERAGE_DB = strip(read("src/utils/kpiBuCoverageDatabase.ts"));
const SEED = strip(read("src/utils/finalGrqKpiSeed.ts"));

/** Body of a named function, brace-agnostic: up to the next top-level decl. */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`function ${name}(`);
  expect(i, `${name} not found — did it move or get renamed?`).toBeGreaterThan(-1);
  const rest = src.slice(i);
  // Next top-level `function`/`export`/`const` at column 0 ends it. Not `\n}`:
  // a multi-line return type closes with `}> {` in column 0 and would cut the
  // body off at the signature.
  const end = rest.slice(1).search(/\n(?:export |async function |function |const )/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe("both surfaces resolve to one computation", () => {
  it("the leadership feed reads buGovernedRate", () => {
    expect(fnBody(FEED, "calcBuCoverageRate")).toContain("buGovernedRate");
  });

  it("the process calculator reaches the same function", () => {
    // calcBuCoverageTracked -> buCoverageRateForFeed -> buGovernedRate.
    expect(fnBody(CALC, "calcBuCoverageTracked")).toContain(
      "buCoverageRateForFeed",
    );
    expect(fnBody(COVERAGE_DB, "buCoverageRateForFeed")).toContain(
      "buGovernedRate",
    );
  });

  it("the feed does NOT compute QM-KPI-008 from the pilot checklist", () => {
    // The specific regression. actionPlanCompleteRate is a legitimate helper
    // for genuinely checklist-driven KPIs; what must not come back is it being
    // called for THIS code, in parallel with the coverage calculator.
    expect(FEED).not.toContain('actionPlanCompleteRate("QM-KPI-008")');
  });
});

describe("the name matches the number", () => {
  const NAME = "BU Coverage Rate";
  const OLD = "BU Pilot Validation Completion Rate";

  it("the seed row and the leadership payload agree", () => {
    // The payload `name` is what leadership actually reads. A green figure
    // under a name describing a different metric is the SPEC-KPI-02 failure,
    // and QM-KPI-008 is pushed outward.
    const row = /code: "QM-KPI-008"[^\n]*/.exec(SEED);
    expect(row, "QM-KPI-008 seed row not found").toBeTruthy();
    expect(row![0]).toContain(`name: "${NAME}"`);
    expect(row![0]).not.toContain(OLD);

    const entry = FEED.slice(
      FEED.indexOf('code: "QM-KPI-008"'),
      FEED.indexOf('code: "QM-KPI-008"') + 300,
    );
    expect(entry).toContain(`name: "${NAME}"`);
    expect(entry).not.toContain(OLD);
  });

  it("keeps calc_mode pointing at the editor that feeds it", () => {
    // kpis.html gates the "Manage BU Coverage" modal on
    // calc_mode === 'bu_coverage'. "auto" would compute correctly and leave the
    // per-BU tracker unreachable; "checklist" offers the 5-stage pilot plan,
    // which is not where this number comes from.
    const row = /code: "QM-KPI-008"[^\n]*/.exec(SEED)![0];
    expect(row).toContain('calc_mode: "bu_coverage"');
  });
});
