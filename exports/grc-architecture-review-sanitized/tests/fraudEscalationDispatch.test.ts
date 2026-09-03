/**
 * Tests the resolveEscalationTriggerForIncident dispatcher mapping.
 * Pure function — no DB or notification side effects.
 *
 * Validates PRD §5.4 selection rule:
 *   chargeback type → ESC-CB
 *   aml_sar type → ESC-AML
 *   else → ESC-{severity}
 *
 * Run:  npx tsx tests/fraudEscalationDispatch.test.ts
 */

import { resolveEscalationTriggerForIncident } from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudEscalationDispatch");

console.log("\n=== Fraud Escalation dispatch — pure-function tests ===\n");

await suite.test("P1 account_takeover → ESC-P1", async () => {
  suite.expectEqual(
    resolveEscalationTriggerForIncident({
      incident_type: "account_takeover",
      severity: "P1",
    }),
    "ESC-P1",
  );
});

await suite.test("P2 internal_fraud → ESC-P2", async () => {
  suite.expectEqual(
    resolveEscalationTriggerForIncident({
      incident_type: "internal_fraud",
      severity: "P2",
    }),
    "ESC-P2",
  );
});

await suite.test("P3 card_testing → ESC-P3", async () => {
  suite.expectEqual(
    resolveEscalationTriggerForIncident({
      incident_type: "card_testing",
      severity: "P3",
    }),
    "ESC-P3",
  );
});

await suite.test("P4 other → ESC-P4", async () => {
  suite.expectEqual(
    resolveEscalationTriggerForIncident({
      incident_type: "other",
      severity: "P4",
    }),
    "ESC-P4",
  );
});

await suite.test("chargeback always routes to ESC-CB regardless of severity", async () => {
  for (const sev of ["P1", "P2", "P3", "P4"] as const) {
    suite.expectEqual(
      resolveEscalationTriggerForIncident({
        incident_type: "chargeback",
        severity: sev,
      }),
      "ESC-CB",
      `chargeback ${sev} must route to ESC-CB`,
    );
  }
});

await suite.test("aml_sar always routes to ESC-AML regardless of severity", async () => {
  for (const sev of ["P1", "P2", "P3", "P4"] as const) {
    suite.expectEqual(
      resolveEscalationTriggerForIncident({
        incident_type: "aml_sar",
        severity: sev,
      }),
      "ESC-AML",
      `aml_sar ${sev} must route to ESC-AML (no tipping off applies)`,
    );
  }
});

suite.finishOrExit();
