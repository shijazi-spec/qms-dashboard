/**
 * Structural tests for the Fraud Escalation Matrix seed
 * (PRD-FRD-001 Feature 4).
 *
 * No DB required — all tests run on ESCALATION_MATRIX_DEFINITIONS in-memory.
 *
 * Run:  npx tsx tests/fraudEscalationSeed.test.ts
 */

import { ESCALATION_MATRIX_DEFINITIONS } from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudEscalationSeed");

console.log("\n=== Fraud Escalation Matrix seed — structural tests ===\n");

await suite.test("seed contains exactly 6 rows (Excel Tab 4 baseline)", async () => {
  suite.expectEqual(
    ESCALATION_MATRIX_DEFINITIONS.length,
    6,
    "expected 6 escalation matrix rows",
  );
});

await suite.test("trigger_id values are unique and well-formed", async () => {
  const ids = ESCALATION_MATRIX_DEFINITIONS.map((r) => r.trigger_id);
  suite.expectEqual(new Set(ids).size, ids.length, "duplicate trigger_id");
  for (const id of ids) {
    suite.expect(/^ESC-[A-Z0-9]+$/.test(id), `bad trigger_id: ${id}`);
  }
});

await suite.test(
  "PRD-mandated triggers (ESC-P1..P4 + ESC-CB + ESC-AML) are present",
  async () => {
    const ids = new Set(ESCALATION_MATRIX_DEFINITIONS.map((r) => r.trigger_id));
    for (const id of ["ESC-P1", "ESC-P2", "ESC-P3", "ESC-P4", "ESC-CB", "ESC-AML"]) {
      suite.expect(ids.has(id), `missing trigger ${id}`);
    }
  },
);

await suite.test("response_sla_hours is a positive integer", async () => {
  for (const r of ESCALATION_MATRIX_DEFINITIONS) {
    suite.expect(
      Number.isInteger(r.response_sla_hours) && r.response_sla_hours > 0,
      `${r.trigger_id} has non-positive integer SLA hours: ${r.response_sla_hours}`,
    );
  }
});

await suite.test(
  "ESC-P1 SLA is 4h, ESC-P2 is 24h, ESC-CB is 72h (matches Excel)",
  async () => {
    const map = new Map(
      ESCALATION_MATRIX_DEFINITIONS.map((r) => [r.trigger_id, r.response_sla_hours]),
    );
    suite.expectEqual(map.get("ESC-P1"), 4, "ESC-P1 SLA hours");
    suite.expectEqual(map.get("ESC-P2"), 24, "ESC-P2 SLA hours");
    suite.expectEqual(map.get("ESC-P3"), 72, "ESC-P3 SLA hours");
    suite.expectEqual(map.get("ESC-CB"), 72, "ESC-CB SLA hours");
  },
);

await suite.test(
  "ESC-AML uses external_party = SAFIU (no tipping off in contact text)",
  async () => {
    const aml = ESCALATION_MATRIX_DEFINITIONS.find((r) => r.trigger_id === "ESC-AML");
    suite.expect(!!aml, "ESC-AML row missing");
    suite.expectEqual(aml!.external_party, "SAFIU", "AML external_party");
    const contact = (aml!.external_contact || "").toLowerCase();
    suite.expect(
      contact.includes("never notify the customer") ||
        contact.includes("no tipping off"),
      "ESC-AML external_contact should mention the no-tipping-off constraint",
    );
  },
);

await suite.test(
  "ESC-AML has zero customer-facing recipients (no tipping off invariant)",
  async () => {
    const aml = ESCALATION_MATRIX_DEFINITIONS.find((r) => r.trigger_id === "ESC-AML");
    suite.expect(!!aml, "ESC-AML row missing");
    const all = [
      ...(aml!.notify_immediately || []),
      ...(aml!.notify_within_4h || []),
    ];
    for (const r of all) {
      suite.expect(
        !/customer/i.test(r) && !/client/i.test(r),
        `ESC-AML must not include customer-facing recipient: ${r}`,
      );
    }
  },
);

await suite.test("notify_immediately is always an array (never null)", async () => {
  for (const r of ESCALATION_MATRIX_DEFINITIONS) {
    suite.expect(
      Array.isArray(r.notify_immediately),
      `${r.trigger_id} notify_immediately must be an array`,
    );
  }
});

suite.finishOrExit();
