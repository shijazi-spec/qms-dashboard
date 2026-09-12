/**
 * The two decisions the milestone editor makes before anything reaches the
 * database: what a submitted field MEANS, and what key a new milestone gets.
 *
 * Both have a failure mode that is silent rather than loud.
 *
 *   • "absent" and "empty" are different intentions. A form that posts only a
 *     target date must not blank the owner. If those collapse into each other
 *     the edit still returns 200 and the data is quietly wrong.
 *
 *   • milestone_key is mandatory, not cosmetic: the roadmap query filters
 *     `WHERE cm.milestone_key IS NOT NULL`, so a milestone created without one
 *     saves successfully and is then INVISIBLE on the page. Maram would add it,
 *     see nothing, and add it again.
 */
import { describe, it, expect } from "vitest";
import {
  parseMilestoneInput,
  milestoneKeyFor,
} from "../../src/mastra/routes/certificationMilestoneRoutes";

/** Narrow the union so a parse failure fails the test instead of the types. */
function ok(r: ReturnType<typeof parseMilestoneInput>) {
  if ("error" in r) throw new Error(`expected a parse, got error: ${r.error}`);
  return r.value;
}

describe("parseMilestoneInput — omission vs clearing", () => {
  it("treats an ABSENT field as 'leave unchanged'", () => {
    const v = ok(parseMilestoneInput({ planned_date: "2026-12-01" }, { requireName: false }));
    expect(v.owner).toBeNull();
    expect(v.clear_owner).toBe(false); // null + no clear flag ⇒ COALESCE keeps it
  });

  it("treats an EMPTY field as 'clear this'", () => {
    const v = ok(parseMilestoneInput({ owner: "" }, { requireName: false }));
    expect(v.owner).toBeNull();
    expect(v.clear_owner).toBe(true); // same null, opposite meaning
  });

  it("distinguishes the two for every clearable field", () => {
    const absent = ok(parseMilestoneInput({}, { requireName: false }));
    const cleared = ok(
      parseMilestoneInput(
        { planned_date: "", owner: "", notes: "" },
        { requireName: false },
      ),
    );
    expect([absent.clear_planned_date, absent.clear_owner, absent.clear_notes])
      .toEqual([false, false, false]);
    expect([cleared.clear_planned_date, cleared.clear_owner, cleared.clear_notes])
      .toEqual([true, true, true]);
  });

  it("does not treat whitespace as a value", () => {
    const v = ok(parseMilestoneInput({ owner: "   " }, { requireName: false }));
    expect(v.owner).toBeNull();
    expect(v.clear_owner).toBe(true);
  });
});

describe("parseMilestoneInput — validation", () => {
  it("requires name and certificate on create, neither on edit", () => {
    expect(parseMilestoneInput({}, { requireName: true })).toHaveProperty("error");
    expect(
      parseMilestoneInput({ milestone_name: "x" }, { requireName: true }),
    ).toHaveProperty("error"); // certification still missing
    expect(parseMilestoneInput({}, { requireName: false })).not.toHaveProperty("error");
  });

  it("rejects a target date that is not YYYY-MM-DD", () => {
    // "2026-13-01x" and "2026-02-31" are the interesting ones: the first was
    // truncated to a valid SHAPE by a slice(0,10) before this was fixed, and
    // the second is correctly shaped but is not a day that exists.
    for (const bad of [
      "01/12/2026", "2026-13-01x", "tomorrow", "2026-1-1",
      "2026-13-01", "2026-02-31", "2026-00-10",
    ]) {
      expect(
        parseMilestoneInput({ planned_date: bad }, { requireName: false }),
      ).toHaveProperty("error");
    }
    expect(
      parseMilestoneInput({ planned_date: "2026-12-01" }, { requireName: false }),
    ).not.toHaveProperty("error");
  });

  it("rejects an unknown milestone_type rather than storing it", () => {
    expect(
      parseMilestoneInput({ milestone_type: "whatever" }, { requireName: false }),
    ).toHaveProperty("error");
  });

  it("defaults a CREATED milestone to 'plan' — the type that scores GRC-KPI-002", () => {
    const created = ok(
      parseMilestoneInput(
        { milestone_name: "n", certification: "SOC 2" },
        { requireName: true },
      ),
    );
    expect(created.milestone_type).toBe("plan");
  });

  it("sends null on an EDIT so the stored type survives", () => {
    // The opposite of the case above: defaulting here would silently re-type
    // every dependency row to 'plan' on any edit, pulling rows into the KPI.
    const edited = ok(parseMilestoneInput({ owner: "m" }, { requireName: false }));
    expect(edited.milestone_type).toBeNull();
  });
});

describe("milestoneKeyFor", () => {
  it("always produces a non-empty key, even from unusable input", () => {
    for (const name of ["", "   ", "!!!", "???---", null as any, undefined as any]) {
      expect(milestoneKeyFor(name, 0)).toMatch(/^USR-.+/);
    }
  });

  it("marks authored rows so they stay distinguishable from seeded ones", () => {
    expect(milestoneKeyFor("SOC 2 target date", 0)).toBe("USR-SOC-2-TARGET-DATE");
  });

  it("produces a DIFFERENT key on each retry, or the insert loop cannot escape", () => {
    const name = "NCA-DCC gap assessment";
    const keys = [0, 1, 2, 3, 4, 5].map((i) => milestoneKeyFor(name, i));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("stays inside the column's 100 chars for a very long name", () => {
    const key = milestoneKeyFor("x".repeat(500), 5);
    expect(key.length).toBeLessThanOrEqual(100);
  });
});
