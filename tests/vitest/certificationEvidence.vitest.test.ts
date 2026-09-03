/**
 * Pure evidence resolver for the Certification Action Plan. The core claim
 * under test: "not done" and "we cannot tell" must never collapse into the
 * same signal. See docs/superpowers/specs/2026-09-03-certification-action-plan-design.md §3/§4.2.
 */
import { describe, it, expect } from "vitest";

import { resolveEvidence, milestoneProgress } from "../../src/utils/certificationEvidence";
import type { EvidenceReading, CertificationActionRef } from "../../src/utils/certificationEvidence";

describe("resolveEvidence", () => {
  it("reports unavailable when the source cannot be read, even if have >= need", () => {
    const r = resolveEvidence("policies.approved", {
      have: 10,
      total: 5,
      sourceEmpty: false,
      sourceReadable: false,
    });
    expect(r.state).toBe("unavailable");
    expect(r.state).not.toBe("not_satisfied");
  });

  it("unreadable outranks empty — sourceReadable:false wins even if sourceEmpty is also true", () => {
    const r = resolveEvidence("doc_tracker_documents.code_ok", {
      have: 0,
      total: 0,
      sourceEmpty: true,
      sourceReadable: false,
    });
    expect(r.state).toBe("unavailable");
  });

  it("reports awaiting_data when the source is empty, even if have >= need", () => {
    const r = resolveEvidence("training_records", {
      have: 10,
      total: 5,
      sourceEmpty: true,
      sourceReadable: true,
    });
    expect(r.state).toBe("awaiting_data");
    expect(r.state).not.toBe("satisfied");
  });

  it("awaiting_data never reads as 0% and never as satisfied when counts are genuinely zero", () => {
    const r = resolveEvidence("audit_runs", {
      have: 0,
      total: 0,
      sourceEmpty: true,
      sourceReadable: true,
    });
    expect(r.state).toBe("awaiting_data");
  });

  it("is satisfied when have >= need and need > 0", () => {
    const r = resolveEvidence("policies.approved", {
      have: 5,
      total: 5,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.state).toBe("satisfied");
    expect(r.have).toBe(5);
    expect(r.need).toBe(5);
  });

  it("is satisfied when have exceeds need", () => {
    const r = resolveEvidence("policies.approved", {
      have: 7,
      total: 5,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.state).toBe("satisfied");
  });

  it("is not_satisfied when have < need", () => {
    const r = resolveEvidence("policies.approved", {
      have: 2,
      total: 5,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.state).toBe("not_satisfied");
  });

  it("guards need === 0: never satisfied, and no NaN/Infinity anywhere in the result", () => {
    const r = resolveEvidence("enterprise_risks.treatment_strategy", {
      have: 0,
      total: 0,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.state).not.toBe("satisfied");
    expect(r.state).toBe("not_satisfied");
    for (const value of Object.values(r)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("guards need === 0 even when have is also 0 divided against it (no divide-by-zero artifact)", () => {
    const r = resolveEvidence("obligation_documents", {
      have: 3,
      total: 0,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.state).toBe("not_satisfied");
    expect(Number.isFinite(r.have)).toBe(true);
    expect(Number.isFinite(r.need)).toBe(true);
  });

  it("echoes the source identifier back on the reading", () => {
    const r = resolveEvidence("external_audits.surveillance", {
      have: 1,
      total: 1,
      sourceEmpty: false,
      sourceReadable: true,
    });
    expect(r.source).toBe("external_audits.surveillance");
  });
});

describe("milestoneProgress", () => {
  const auto = (key: string, mode: "auto" | "manual" = "auto", done_at: string | null = null): CertificationActionRef => ({
    action_key: key,
    verification_mode: mode,
    done_at,
  });

  it("counts a manual action done only when done_at is set", () => {
    const actions = [auto("ACT-2.2", "manual", null)];
    const r = milestoneProgress(actions, {});
    expect(r.done).toBe(0);
    expect(r.complete).toBe(false);
  });

  it("counts a manual action done once done_at is set", () => {
    const actions = [auto("ACT-2.2", "manual", "2026-09-15T10:00:00Z")];
    const r = milestoneProgress(actions, {});
    expect(r.done).toBe(1);
    expect(r.complete).toBe(true);
  });

  it("counts an auto action done only when its reading is satisfied", () => {
    const actions = [auto("ACT-1.1", "auto")];
    const satisfied: Record<string, EvidenceReading> = {
      "ACT-1.1": { source: "policies", state: "satisfied", have: 5, need: 5 },
    };
    const r = milestoneProgress(actions, satisfied);
    expect(r.done).toBe(1);
    expect(r.complete).toBe(true);
  });

  it("does NOT count an auto action as done when its reading is awaiting_data", () => {
    const actions = [auto("ACT-3.3", "auto")];
    const readings: Record<string, EvidenceReading> = {
      "ACT-3.3": { source: "training_records", state: "awaiting_data", have: 0, need: 0 },
    };
    const r = milestoneProgress(actions, readings);
    expect(r.done).toBe(0);
    expect(r.complete).toBe(false);
  });

  it("does NOT count an auto action as done when its reading is unavailable", () => {
    const actions = [auto("ACT-2.3", "auto")];
    const readings: Record<string, EvidenceReading> = {
      "ACT-2.3": { source: "doc_tracker_documents.code_ok", state: "unavailable", have: 0, need: 0 },
    };
    const r = milestoneProgress(actions, readings);
    expect(r.done).toBe(0);
    expect(r.complete).toBe(false);
  });

  it("does NOT count an auto action as done when its reading is not_satisfied", () => {
    const actions = [auto("ACT-1.1", "auto")];
    const readings: Record<string, EvidenceReading> = {
      "ACT-1.1": { source: "policies", state: "not_satisfied", have: 1, need: 5 },
    };
    const r = milestoneProgress(actions, readings);
    expect(r.done).toBe(0);
  });

  it("treats an auto action with no matching reading as not done, without crashing", () => {
    const actions = [auto("ACT-9.9", "auto")];
    const r = milestoneProgress(actions, {});
    expect(r.done).toBe(0);
    expect(r.complete).toBe(false);
  });

  it("complete is false when any single action, among several, is not done", () => {
    const actions = [
      auto("ACT-1.1", "auto"),
      auto("ACT-1.2", "manual", "2026-09-15T10:00:00Z"),
      auto("ACT-1.3", "auto"),
    ];
    const readings: Record<string, EvidenceReading> = {
      "ACT-1.1": { source: "policies", state: "satisfied", have: 5, need: 5 },
      "ACT-1.3": { source: "qms_uploaded_documents", state: "awaiting_data", have: 0, need: 0 },
    };
    const r = milestoneProgress(actions, readings);
    expect(r.done).toBe(2);
    expect(r.total).toBe(3);
    expect(r.complete).toBe(false);
  });

  it("complete is true only when every action in the milestone is done", () => {
    const actions = [
      auto("ACT-1.1", "auto"),
      auto("ACT-1.2", "manual", "2026-09-15T10:00:00Z"),
    ];
    const readings: Record<string, EvidenceReading> = {
      "ACT-1.1": { source: "policies", state: "satisfied", have: 5, need: 5 },
    };
    const r = milestoneProgress(actions, readings);
    expect(r.done).toBe(2);
    expect(r.total).toBe(2);
    expect(r.complete).toBe(true);
  });

  it("an empty action list is not reported complete", () => {
    const r = milestoneProgress([], {});
    expect(r.total).toBe(0);
    expect(r.done).toBe(0);
    expect(r.complete).toBe(false);
  });
});
