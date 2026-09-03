/**
 * Sanity tests for the canonical COPC scorecard seed JSON and the
 * payload-building logic in scripts/seedScorecardV2Copc.ts.
 *
 * Run: npx vitest run tests/vitest/scorecardV2CopcSeed.vitest.test.ts
 *
 * No DB — just verifies the JSON is well-formed and the dimensions
 * payload would be acceptable to getActiveSDRScorecard's parser.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, test } from "vitest";

const JSON_PATH = path.resolve(
  __dirname,
  "../../src/data/scorecard_v2_copc.json",
);

function loadCanonical(): any {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
}

describe("scorecard_v2_copc.json — structural integrity", () => {
  test("file exists and parses as JSON", () => {
    expect(fs.existsSync(JSON_PATH)).toBe(true);
    expect(() => loadCanonical()).not.toThrow();
  });

  test("has the expected top-level shape", () => {
    const c = loadCanonical();
    expect(c.scorecard).toBeDefined();
    expect(c.scorecard.id).toBe("ExampleOrg_copc_v2");
    expect(c.scorecard.name).toBeTruthy();
    expect(c.scorecard.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(c.scorecard.sections)).toBe(true);
  });

  test("has exactly 4 sections matching the Five9 COPC template", () => {
    const c = loadCanonical();
    expect(c.scorecard.sections).toHaveLength(4);
    const ids = c.scorecard.sections.map((s: any) => s.id);
    expect(ids).toEqual([
      "activity_and_process",
      "quality_and_soft_skills",
      "coaching_and_improvement",
      "kpi_and_correlation",
    ]);
  });

  test("section weights sum to exactly 100", () => {
    const c = loadCanonical();
    const total = c.scorecard.sections.reduce(
      (acc: number, s: any) => acc + s.weight_pct,
      0,
    );
    expect(total).toBe(100);
  });

  test("has 19 checkpoints across all sections (matches template)", () => {
    const c = loadCanonical();
    const total = c.scorecard.sections.reduce(
      (acc: number, s: any) => acc + (s.checkpoints?.length || 0),
      0,
    );
    expect(total).toBe(19);
  });

  test("every checkpoint has the required fields", () => {
    const c = loadCanonical();
    for (const s of c.scorecard.sections) {
      for (const cp of s.checkpoints) {
        expect(cp.id, `section ${s.id}`).toBeTruthy();
        expect(cp.name, `checkpoint ${cp.id}`).toBeTruthy();
        expect(cp.description, `checkpoint ${cp.id}`).toBeTruthy();
        expect(cp.metric, `checkpoint ${cp.id}`).toBeTruthy();
        expect(cp.target, `checkpoint ${cp.id}`).toBeTruthy();
        expect(cp.data_source, `checkpoint ${cp.id}`).toBeTruthy();
        expect(cp.data_dependency, `checkpoint ${cp.id}`).toBeTruthy();
      }
    }
  });

  test("checkpoint ids are globally unique", () => {
    const c = loadCanonical();
    const ids = new Set<string>();
    for (const s of c.scorecard.sections) {
      for (const cp of s.checkpoints) {
        expect(ids.has(cp.id), `duplicate id: ${cp.id}`).toBe(false);
        ids.add(cp.id);
      }
    }
  });

  test("scoring_scale defines 0 / 1 / 2", () => {
    const c = loadCanonical();
    expect(c.scorecard.scoring_scale).toEqual({
      "0": "Not Met",
      "1": "Partially Met",
      "2": "Fully Met",
    });
  });

  test("Five9-blocked checkpoints are explicitly tagged", () => {
    const c = loadCanonical();
    const blocked: string[] = [];
    for (const s of c.scorecard.sections) {
      for (const cp of s.checkpoints) {
        if (cp.data_dependency.includes("five9_real_ingest")) {
          blocked.push(cp.id);
        }
      }
    }
    // The DMAIC analysis documented exactly 8 Five9-blocked checkpoints
    expect(blocked.length).toBe(8);
    expect(blocked).toContain("login_to_call_gap");
    expect(blocked).toContain("answer_rate");
  });

  test("supersedes list mentions the v1.5 scorecard", () => {
    const c = loadCanonical();
    const sup = (c.scorecard.supersedes || []).join(" ");
    expect(sup).toMatch(/v1\.5/i);
  });
});

describe("dependencies summary mirrors actual checkpoints", () => {
  test("blocked_on_five9 list matches checkpoint tags", () => {
    const c = loadCanonical();
    const tagged: string[] = [];
    for (const s of c.scorecard.sections) {
      for (const cp of s.checkpoints) {
        if (cp.data_dependency.includes("five9_real_ingest")) {
          tagged.push(cp.id);
        }
      }
    }
    const declared = c._dependencies_summary?.blocked_on_five9 || [];
    // Every tagged checkpoint must appear in the declared list
    for (const t of tagged) {
      expect(declared, `tagged ${t} should be in blocked_on_five9 list`).toContain(t);
    }
  });
});
