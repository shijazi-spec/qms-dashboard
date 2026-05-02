/**
 * Structural tests for the Fraud Rules seed data
 * (PRD-FRD-001 Feature 1).
 *
 * Validates invariants of FRAUD_RULE_DEFINITIONS without hitting the
 * database, so they run in any environment and catch drift immediately if
 * someone edits the seed.
 *
 * Run:  npx tsx tests/fraudRulesSeed.test.ts
 */

import {
  FRAUD_RULE_DEFINITIONS,
  type FraudRuleDef,
} from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudRulesSeed");

console.log("\n=== Fraud Rules seed — structural tests ===\n");

await suite.test(
  "seed contains exactly 17 rules (Excel Tab 1 baseline)",
  async () => {
    suite.expectEqual(
      FRAUD_RULE_DEFINITIONS.length,
      17,
      "FRAUD_RULE_DEFINITIONS length",
    );
  },
);

await suite.test(
  "every rule_id is unique and matches FR-### format",
  async () => {
    const ids = FRAUD_RULE_DEFINITIONS.map((r) => r.rule_id);
    const uniq = new Set(ids);
    suite.expectEqual(uniq.size, ids.length, "duplicate rule_id detected");
    for (const id of ids) {
      suite.expect(/^FR-\d{3}$/.test(id), `bad rule_id format: ${id}`);
    }
  },
);

await suite.test(
  "every rule has a non-empty rule_name, transaction_type, and owner",
  async () => {
    for (const r of FRAUD_RULE_DEFINITIONS) {
      suite.expect(
        typeof r.rule_name === "string" && r.rule_name.trim().length >= 5,
        `rule_name too short on ${r.rule_id}`,
      );
      suite.expect(
        typeof r.transaction_type === "string" &&
          r.transaction_type.trim().length > 0,
        `transaction_type missing on ${r.rule_id}`,
      );
      suite.expect(
        typeof r.owner === "string" && r.owner.trim().length > 0,
        `owner missing on ${r.rule_id}`,
      );
    }
  },
);

await suite.test("test_status uses only allowed enum values", async () => {
  const allowed = new Set([
    "passed",
    "pending_testing",
    "not_tested",
    "not_defined",
    "active_being_modified",
    "misconfiguration",
  ]);
  for (const r of FRAUD_RULE_DEFINITIONS) {
    suite.expect(
      allowed.has(r.test_status),
      `bad test_status on ${r.rule_id}: ${r.test_status}`,
    );
  }
});

await suite.test(
  "next_review is a valid YYYY-MM-DD date string",
  async () => {
    for (const r of FRAUD_RULE_DEFINITIONS) {
      suite.expect(
        /^\d{4}-\d{2}-\d{2}$/.test(r.next_review),
        `bad next_review format on ${r.rule_id}: ${r.next_review}`,
      );
      const d = new Date(r.next_review);
      suite.expect(
        !Number.isNaN(d.getTime()),
        `unparseable next_review on ${r.rule_id}: ${r.next_review}`,
      );
    }
  },
);

await suite.test(
  "last_tested, when set, is a valid YYYY-MM-DD date string",
  async () => {
    for (const r of FRAUD_RULE_DEFINITIONS) {
      if (r.last_tested == null) continue;
      suite.expect(
        /^\d{4}-\d{2}-\d{2}$/.test(r.last_tested),
        `bad last_tested format on ${r.rule_id}: ${r.last_tested}`,
      );
    }
  },
);

await suite.test(
  "rules with status active_being_modified have last_tested set",
  async () => {
    for (const r of FRAUD_RULE_DEFINITIONS) {
      if (r.test_status !== "active_being_modified") continue;
      suite.expect(
        !!r.last_tested,
        `${r.rule_id} is active_being_modified but has no last_tested date`,
      );
    }
  },
);

await suite.test(
  "FR-017 is the only misconfiguration in the seed (Excel snapshot)",
  async () => {
    const misc = FRAUD_RULE_DEFINITIONS.filter(
      (r) => r.test_status === "misconfiguration",
    );
    suite.expectEqual(
      misc.length,
      1,
      "expected exactly 1 misconfiguration in seed",
    );
    suite.expectEqual(
      misc[0]?.rule_id,
      "FR-017",
      "the misconfiguration must be FR-017 (per Excel)",
    );
  },
);

await suite.test(
  "rules covering the 5 transaction-type groups from Excel are present",
  async () => {
    const types = new Set(FRAUD_RULE_DEFINITIONS.map((r) => r.transaction_type));
    const expected = [
      "Wallet Top-Up",
      "Voucher Purchase",
      "Wallet",
      "Partner Redemption",
      "Gift Sending",
      "Registration",
      "Registration / Login",
      "All Top-Ups",
      "All Transactions",
    ];
    for (const t of expected) {
      suite.expect(types.has(t), `transaction type missing from seed: ${t}`);
    }
  },
);

await suite.test(
  "FraudRuleDef shape — every entry has the required keys",
  async () => {
    const requiredKeys: (keyof FraudRuleDef)[] = [
      "rule_id",
      "rule_name",
      "transaction_type",
      "owner",
      "test_status",
      "next_review",
    ];
    for (const r of FRAUD_RULE_DEFINITIONS) {
      for (const k of requiredKeys) {
        suite.expect(
          (r as any)[k] !== undefined && (r as any)[k] !== null && (r as any)[k] !== "",
          `${r.rule_id} missing required key ${String(k)}`,
        );
      }
    }
  },
);

suite.finishOrExit();
