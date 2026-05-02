/**
 * Tests evaluateKpiColor — pure function for traffic-light KPI coloring.
 * PRD-FRD-001 §5.5.
 *
 * Run:  npx tsx tests/fraudKpiThresholds.test.ts
 */

import {
  evaluateKpiColor,
  KPI_THRESHOLD_DEFINITIONS,
} from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudKpiThresholds");

console.log("\n=== KPI threshold seed + color logic — pure-function tests ===\n");

await suite.test("seed contains 11 thresholds (PRD §5.5)", async () => {
  suite.expectEqual(
    KPI_THRESHOLD_DEFINITIONS.length,
    11,
    "expected 11 KPI threshold rows",
  );
});

await suite.test("threshold metric_names are unique", async () => {
  const names = KPI_THRESHOLD_DEFINITIONS.map((t) => t.metric_name);
  suite.expectEqual(new Set(names).size, names.length, "duplicate metric_name");
});

await suite.test(
  "every threshold has a valid direction",
  async () => {
    const valid = new Set(["lower_is_better", "higher_is_better"]);
    for (const t of KPI_THRESHOLD_DEFINITIONS) {
      suite.expect(
        valid.has(t.direction),
        `bad direction on ${t.metric_name}: ${t.direction}`,
      );
    }
  },
);

await suite.test(
  "lower_is_better — green when value <= target, amber when between, red when over alert",
  async () => {
    const t = { target_value: 5, alert_value: 10, direction: "lower_is_better" as const };
    suite.expectEqual(evaluateKpiColor(0, t), "green");
    suite.expectEqual(evaluateKpiColor(5, t), "green");
    suite.expectEqual(evaluateKpiColor(7, t), "amber");
    suite.expectEqual(evaluateKpiColor(10, t), "amber");
    suite.expectEqual(evaluateKpiColor(11, t), "red");
    suite.expectEqual(evaluateKpiColor(100, t), "red");
  },
);

await suite.test(
  "higher_is_better — green when value >= target, amber when between, red when under alert",
  async () => {
    const t = { target_value: 95, alert_value: 80, direction: "higher_is_better" as const };
    suite.expectEqual(evaluateKpiColor(100, t), "green");
    suite.expectEqual(evaluateKpiColor(95, t), "green");
    suite.expectEqual(evaluateKpiColor(85, t), "amber");
    suite.expectEqual(evaluateKpiColor(80, t), "amber");
    suite.expectEqual(evaluateKpiColor(50, t), "red");
  },
);

await suite.test("null / undefined values produce gray", async () => {
  const t = { target_value: 5, alert_value: 10, direction: "lower_is_better" as const };
  suite.expectEqual(evaluateKpiColor(null, t), "gray");
  suite.expectEqual(evaluateKpiColor(undefined, t), "gray");
});

await suite.test(
  "fraud_rate_pct + chargeback_ratio_pct + fraud_loss_sar are lower_is_better",
  async () => {
    const map = new Map(
      KPI_THRESHOLD_DEFINITIONS.map((t) => [t.metric_name, t.direction]),
    );
    suite.expectEqual(map.get("fraud_rate_pct"), "lower_is_better");
    suite.expectEqual(map.get("chargeback_ratio_pct"), "lower_is_better");
    suite.expectEqual(map.get("fraud_loss_sar"), "lower_is_better");
  },
);

await suite.test(
  "resolved_within_30d_pct + sama_reports_filed are higher_is_better",
  async () => {
    const map = new Map(
      KPI_THRESHOLD_DEFINITIONS.map((t) => [t.metric_name, t.direction]),
    );
    suite.expectEqual(map.get("resolved_within_30d_pct"), "higher_is_better");
    suite.expectEqual(map.get("sama_reports_filed"), "higher_is_better");
  },
);

suite.finishOrExit();
