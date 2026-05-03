/**
 * Tests applyFatfBlackListInvariant — the runtime guard that forces
 * FATF black-list rows to risk_rating='critical' / bin_status='permanently_blocked'.
 * Pure function — no DB.
 *
 * PRD-FRD-001 §5.3 hard invariant.
 *
 * Run:  npx tsx tests/fraudCountryFatfLock.test.ts
 */

import { applyFatfBlackListInvariant } from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudCountryFatfLock");

console.log("\n=== Country Risk FATF lock — pure-function tests ===\n");

await suite.test("non-blacklist input passes through unchanged", async () => {
  const r = applyFatfBlackListInvariant({
    fatf_status: "no_action",
    risk_rating: "low",
    bin_status: "approved",
  });
  suite.expectEqual(r.risk_rating, "low");
  suite.expectEqual(r.bin_status, "approved");
});

await suite.test("increased_monitoring input passes through unchanged", async () => {
  const r = applyFatfBlackListInvariant({
    fatf_status: "increased_monitoring",
    risk_rating: "high",
    bin_status: "approved_with_edd",
  });
  suite.expectEqual(r.risk_rating, "high");
  suite.expectEqual(r.bin_status, "approved_with_edd");
});

await suite.test("black_list FORCES critical / permanently_blocked", async () => {
  const r = applyFatfBlackListInvariant({
    fatf_status: "black_list",
    risk_rating: "low",
    bin_status: "approved",
  });
  suite.expectEqual(r.risk_rating, "critical", "must force critical");
  suite.expectEqual(r.bin_status, "permanently_blocked", "must force permanently_blocked");
});

await suite.test(
  "black_list overrides ANY caller-supplied rating / BIN value",
  async () => {
    for (const rating of ["low", "medium", "high", "critical"] as const) {
      for (const bin of [
        "approved",
        "approved_with_edd",
        "not_approved",
        "permanently_blocked",
      ] as const) {
        const r = applyFatfBlackListInvariant({
          fatf_status: "black_list",
          risk_rating: rating,
          bin_status: bin,
        });
        suite.expectEqual(
          r.risk_rating,
          "critical",
          `caller said rating=${rating} bin=${bin}; got rating=${r.risk_rating} (expected critical)`,
        );
        suite.expectEqual(
          r.bin_status,
          "permanently_blocked",
          `caller said rating=${rating} bin=${bin}; got bin=${r.bin_status} (expected permanently_blocked)`,
        );
      }
    }
  },
);

suite.finishOrExit();
