/**
 * Unit tests for the Remediation Playbook helpers — the pure, deterministic
 * functions that produce the five stakeholder-facing columns we append to
 * every Duplicate Radar export (Recommended Action, Survivorship Rule,
 * Owner to Consult, Why This Verdict, Due Date).
 *
 * Run: npx vitest run tests/vitest/duplicateRadarPlaybook.vitest.test.ts
 */
import { describe, expect, test } from "vitest";
import {
  getConfidenceTier,
  recommendedAction,
  survivorshipRule,
  ownerToConsult,
  whyVerdict,
  dueDate,
  emptyPlaybookState,
  startCluster,
  rowPlaybook,
} from "../../src/utils/duplicateRadarPlaybook";

describe("getConfidenceTier", () => {
  test("90+ → high", () => {
    expect(getConfidenceTier(90)).toBe("high");
    expect(getConfidenceTier(95)).toBe("high");
    expect(getConfidenceTier(100)).toBe("high");
  });
  test("60-89 → medium", () => {
    expect(getConfidenceTier(60)).toBe("medium");
    expect(getConfidenceTier(75)).toBe("medium");
    expect(getConfidenceTier(89)).toBe("medium");
  });
  test("<60 → low", () => {
    expect(getConfidenceTier(0)).toBe("low");
    expect(getConfidenceTier(59)).toBe("low");
  });
  test("null/undefined → low (defensive)", () => {
    expect(getConfidenceTier(null)).toBe("low");
    expect(getConfidenceTier(undefined)).toBe("low");
  });
});

describe("recommendedAction", () => {
  test("primary record → keep", () => {
    expect(
      recommendedAction({ is_primary: true, primary_name: "ACME Co" }),
    ).toBe("Keep — primary record");
  });
  test("non-primary with primary set → merge into named", () => {
    expect(
      recommendedAction({ is_primary: false, primary_name: "ACME Co" }),
    ).toBe('Merge into "ACME Co"');
  });
  test("non-primary with no primary set → manual review", () => {
    expect(
      recommendedAction({ is_primary: false, primary_name: null }),
    ).toBe("Review manually — no primary selected yet");
  });
});

describe("survivorshipRule", () => {
  test("no primary → must mark before merge", () => {
    expect(
      survivorshipRule({ cluster_confidence: 95, has_primary: false }),
    ).toMatch(/must mark one before merging/);
  });
  test("high confidence + primary → auto-merge eligible", () => {
    expect(
      survivorshipRule({ cluster_confidence: 95, has_primary: true }),
    ).toMatch(/auto-selected by signal score/);
  });
  test("medium confidence + primary → review primary first", () => {
    expect(
      survivorshipRule({ cluster_confidence: 75, has_primary: true }),
    ).toMatch(/review primary's field completeness/);
  });
  test("low confidence + primary → escalate", () => {
    expect(
      survivorshipRule({ cluster_confidence: 40, has_primary: true }),
    ).toMatch(/escalate to CS \/ record owner/);
  });
});

describe("ownerToConsult", () => {
  test("name + email → 'name <email>'", () => {
    expect(
      ownerToConsult({ owner_name: "Sample User", owner_email: "user@example.invalid" }),
    ).toBe("Ali <user@example.invalid>");
  });
  test("name only → name", () => {
    expect(
      ownerToConsult({ owner_name: "Sample User", owner_email: "" }),
    ).toBe("Ali");
  });
  test("email only → email", () => {
    expect(
      ownerToConsult({ owner_name: null, owner_email: "user@example.invalid" }),
    ).toBe("user@example.invalid");
  });
  test("nothing → em-dash", () => {
    expect(ownerToConsult({ owner_name: null, owner_email: null })).toBe("—");
  });
});

describe("whyVerdict", () => {
  test("includes tier label + record count + AI recommendation", () => {
    expect(
      whyVerdict({
        cluster_confidence: 95,
        ai_recommendation: "Merge after CS review",
        total_records: 4,
      }),
    ).toContain("High-confidence match");
    expect(
      whyVerdict({
        cluster_confidence: 95,
        ai_recommendation: "Merge after CS review",
        total_records: 4,
      }),
    ).toContain("4 records");
    expect(
      whyVerdict({
        cluster_confidence: 95,
        ai_recommendation: "Merge after CS review",
        total_records: 4,
      }),
    ).toContain("Merge after CS review");
  });

  test("strips generic 'Review manually' so it isn't appended redundantly", () => {
    expect(
      whyVerdict({
        cluster_confidence: 75,
        ai_recommendation: "Review manually",
        total_records: 2,
      }),
    ).not.toContain("Review manually");
  });

  test("handles singleton cluster gracefully", () => {
    expect(
      whyVerdict({
        cluster_confidence: 80,
        ai_recommendation: null,
        total_records: 1,
      }),
    ).toContain("Single record cluster");
  });
});

describe("dueDate", () => {
  const ref = new Date("2026-05-22T00:00:00Z");

  test("high confidence → 7-day SLA", () => {
    expect(dueDate({ cluster_confidence: 95, now: ref })).toBe("2026-05-29");
  });
  test("medium confidence → 14-day SLA", () => {
    expect(dueDate({ cluster_confidence: 75, now: ref })).toBe("2026-06-05");
  });
  test("low confidence → 30-day SLA", () => {
    expect(dueDate({ cluster_confidence: 40, now: ref })).toBe("2026-06-21");
  });
});

describe("startCluster + rowPlaybook (integration)", () => {
  test("first row of cluster captures primary; subsequent row uses 'Merge into <primary>'", () => {
    const state = emptyPlaybookState();
    const primaryRow = {
      cluster_id: 42,
      is_primary: true,
      record_name: "ACME Co — Riyadh Branch",
      owner_name: "Sample User",
      owner_email: "user@example.invalid",
      cluster_confidence_score: 95,
      cluster_total_records: 3,
      ai_recommendation: "Merge after Zoho confirmation",
    };
    startCluster(state, primaryRow, new Date("2026-05-22T00:00:00Z"));

    const primaryPb = rowPlaybook(primaryRow, state);
    expect(primaryPb.recommended_action).toBe("Keep — primary record");
    expect(primaryPb.due_date).toBe("2026-05-29");
    expect(primaryPb.survivorship_rule).toMatch(/auto-selected by signal score/);

    const dupRow = {
      cluster_id: 42,
      is_primary: false,
      record_name: "Acme co. (Riyadh)",
      owner_name: "Sample User",
      owner_email: "user@example.invalid",
      cluster_confidence_score: 95,
      cluster_total_records: 3,
      ai_recommendation: "Merge after Zoho confirmation",
    };
    const dupPb = rowPlaybook(dupRow, state);
    expect(dupPb.recommended_action).toBe(
      'Merge into "ACME Co — Riyadh Branch"',
    );
    // The duplicate row's own owner is the one to consult — not the primary's.
    expect(dupPb.owner_to_consult).toBe("Sara <user@example.invalid>");
    expect(dupPb.due_date).toBe(primaryPb.due_date);
    expect(dupPb.survivorship_rule).toBe(primaryPb.survivorship_rule);
  });

  test("cluster with no primary record → all rows recommend manual review", () => {
    const state = emptyPlaybookState();
    const firstRow = {
      cluster_id: 99,
      is_primary: false,
      record_name: "Some Co",
      cluster_confidence_score: 65,
      cluster_total_records: 2,
    };
    startCluster(state, firstRow, new Date("2026-05-22T00:00:00Z"));
    expect(state.has_primary).toBe(false);

    const pb = rowPlaybook(firstRow, state);
    expect(pb.recommended_action).toBe(
      "Review manually — no primary selected yet",
    );
    expect(pb.survivorship_rule).toMatch(/must mark one before merging/);
  });
});
