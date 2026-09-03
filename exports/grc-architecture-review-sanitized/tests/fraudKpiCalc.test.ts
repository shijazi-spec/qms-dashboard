/**
 * Structural tests for the KPI auto-calculation surface
 * (PRD-FRD-001 Feature 5).
 *
 * Note: the heavy SQL of autoCalculateKpisForMonth requires a live DB and
 * runs as part of the integration suite. This file asserts the route
 * surface and the export shape so that drift to the JS contract is caught
 * without needing a database.
 *
 * Run:  npx tsx tests/fraudKpiCalc.test.ts
 */

import { fraudRoutes } from "../src/mastra/routes/fraudRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudKpiCalc");

console.log("\n=== Fraud KPI routes — structural tests ===\n");

const kpiRoutes = fraudRoutes.filter((r) => r.path.startsWith("/api/fraud/kpis"));

await suite.test(
  "exposes 9 KPI endpoints (PRD §5.5)",
  async () => {
    suite.expectEqual(
      kpiRoutes.length,
      9,
      `expected 9 KPI routes, got ${kpiRoutes.length}: ${kpiRoutes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
    );
  },
);

await suite.test("PRD-mandated KPI paths/methods are registered", async () => {
  const expected: { path: string; method: string }[] = [
    { path: "/api/fraud/kpis", method: "GET" },
    { path: "/api/fraud/kpis/thresholds", method: "GET" },
    { path: "/api/fraud/kpis/thresholds/:metric", method: "PUT" },
    { path: "/api/fraud/kpis/:month", method: "GET" },
    { path: "/api/fraud/kpis/:month", method: "PUT" },
    { path: "/api/fraud/kpis/:month/auto-calculate", method: "POST" },
    { path: "/api/fraud/kpis/current/summary", method: "GET" },
    { path: "/api/fraud/kpis/trend/:metric", method: "GET" },
    { path: "/api/fraud/kpis/export/pdf", method: "GET" },
  ];
  for (const e of expected) {
    const found = kpiRoutes.find(
      (r) => r.path === e.path && r.method === e.method,
    );
    suite.expect(
      !!found,
      `expected ${e.method} ${e.path} to be registered`,
    );
  }
});

await suite.test("KPI handlers can be instantiated", async () => {
  const fakeMastra = { getLogger: () => ({ info: () => {}, error: () => {} }) };
  for (const r of kpiRoutes) {
    const handler = await r.createHandler({ mastra: fakeMastra });
    suite.expect(typeof handler === "function", `${r.path} ${r.method} handler is function`);
  }
});

suite.finishOrExit();
