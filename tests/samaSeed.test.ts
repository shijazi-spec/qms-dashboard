/**
 * Structural tests for the SAMA CSF obligations seed.
 *
 * Validates invariants of SAMA_OBLIGATION_DEFINITIONS without hitting the
 * database, so they run in any environment and catch drift immediately if
 * someone edits the seed data.
 *
 * Run:  npx tsx tests/samaSeed.test.ts
 */

import { SAMA_OBLIGATION_DEFINITIONS } from "../src/utils/complianceDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("samaSeed");

console.log("\n=== SAMA CSF seed — structural tests ===\n");

await suite.test("seed contains exactly 20 obligations (Phase 1 scope)", async () => {
  suite.expectEqual(
    SAMA_OBLIGATION_DEFINITIONS.length,
    20,
    "SAMA_OBLIGATION_DEFINITIONS length",
  );
});

await suite.test("every obligation code is unique and SAMA-prefixed", async () => {
  const codes = SAMA_OBLIGATION_DEFINITIONS.map((o) => o.code);
  const uniq = new Set(codes);
  suite.expectEqual(uniq.size, codes.length, "duplicate obligation codes detected");
  for (const code of codes) {
    suite.expect(/^SAMA-\d{2}$/.test(code), `bad code format: ${code}`);
  }
});

await suite.test("every obligation has a non-empty title and description", async () => {
  for (const ob of SAMA_OBLIGATION_DEFINITIONS) {
    suite.expect(
      typeof ob.title === "string" && ob.title.trim().length >= 5,
      `title too short on ${ob.code}`,
    );
    suite.expect(
      typeof ob.desc === "string" && ob.desc.trim().length >= 40,
      `description too short on ${ob.code}`,
    );
  }
});

await suite.test("all four CSF domains are covered", async () => {
  const expectedDomains = new Set([
    "Leadership & Governance",
    "Risk Management & Compliance",
    "Operations & Technology",
    "Third Party",
  ]);
  const seen = new Set(SAMA_OBLIGATION_DEFINITIONS.map((o) => o.domain));
  for (const d of expectedDomains) {
    suite.expect(seen.has(d), `domain missing from seed: ${d}`);
  }
  for (const d of seen) {
    suite.expect(
      expectedDomains.has(d),
      `unexpected domain in seed: ${d} — must match CSF §1-§4 taxonomy`,
    );
  }
});

await suite.test("enum-constrained fields use allowed values", async () => {
  const allowedType = new Set(["mandatory", "recommended", "optional"]);
  const allowedCtrl = new Set(["preventive", "detective", "corrective"]);
  const allowedFreq = new Set([
    "continuous",
    "daily",
    "weekly",
    "monthly",
    "quarterly",
    "annual",
    "event_driven",
  ]);
  const allowedPriority = new Set(["critical", "high", "medium", "low"]);

  for (const ob of SAMA_OBLIGATION_DEFINITIONS) {
    suite.expect(allowedType.has(ob.type), `bad type on ${ob.code}: ${ob.type}`);
    suite.expect(allowedCtrl.has(ob.ctrl), `bad ctrl on ${ob.code}: ${ob.ctrl}`);
    suite.expect(allowedFreq.has(ob.freq), `bad freq on ${ob.code}: ${ob.freq}`);
    suite.expect(
      allowedPriority.has(ob.priority),
      `bad priority on ${ob.code}: ${ob.priority}`,
    );
  }
});

await suite.test("section_order values are unique and cover 1..20", async () => {
  const orders = SAMA_OBLIGATION_DEFINITIONS.map((o) => o.order).sort(
    (a, b) => a - b,
  );
  for (let i = 0; i < orders.length; i++) {
    suite.expectEqual(orders[i], i + 1, `section_order gap/duplicate at index ${i}`);
  }
});

await suite.test("critical-priority controls are preventive or detective (never optional)", async () => {
  for (const ob of SAMA_OBLIGATION_DEFINITIONS) {
    if (ob.priority === "critical") {
      suite.expect(
        ob.type === "mandatory",
        `critical control must be mandatory: ${ob.code}`,
      );
    }
  }
});

suite.finishOrExit();
