/**
 * Structural tests for the Fraud Incidents route module
 * (PRD-FRD-001 Feature 2).
 *
 * No DB required — verifies that the routes array exposes the right
 * shape, paths, and methods. The full integration tests live in the
 * UAT phase.
 *
 * Run:  npx tsx tests/fraudIncidentsRoutes.test.ts
 */

import { fraudRoutes } from "../src/mastra/routes/fraudRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudIncidentsRoutes");

console.log("\n=== Fraud Incidents routes — structural tests ===\n");

const incidentRoutes = fraudRoutes.filter((r) =>
  r.path.startsWith("/api/fraud/incidents"),
);

await suite.test(
  "exposes 8 incident endpoints (PRD §5.2)",
  async () => {
    suite.expectEqual(
      incidentRoutes.length,
      8,
      `expected 8 incident routes, got ${incidentRoutes.length}: ${incidentRoutes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
    );
  },
);

await suite.test(
  "every incident route has path, method, createHandler",
  async () => {
    for (const r of incidentRoutes) {
      suite.expect(typeof r.path === "string", "path is string");
      suite.expect(typeof r.method === "string", "method is string");
      suite.expect(
        typeof r.createHandler === "function",
        "createHandler is function",
      );
    }
  },
);

await suite.test("PRD-mandated paths/methods are registered", async () => {
  const expected: { path: string; method: string }[] = [
    { path: "/api/fraud/incidents", method: "GET" },
    { path: "/api/fraud/incidents", method: "POST" },
    { path: "/api/fraud/incidents/open", method: "GET" },
    { path: "/api/fraud/incidents/sama-overdue", method: "GET" },
    { path: "/api/fraud/incidents/:id", method: "GET" },
    { path: "/api/fraud/incidents/:id", method: "PUT" },
    { path: "/api/fraud/incidents/:id/close", method: "PUT" },
    { path: "/api/fraud/incidents/export/pdf", method: "GET" },
  ];
  for (const e of expected) {
    const found = incidentRoutes.find(
      (r) => r.path === e.path && r.method === e.method,
    );
    suite.expect(
      !!found,
      `expected ${e.method} ${e.path} to be registered`,
    );
  }
});

await suite.test("handlers can be instantiated with mock mastra", async () => {
  const fakeMastra = { getLogger: () => ({ info: () => {}, error: () => {} }) };
  for (const r of incidentRoutes) {
    const handler = await r.createHandler({ mastra: fakeMastra });
    suite.expect(typeof handler === "function", `${r.path} ${r.method} handler is function`);
  }
});

suite.finishOrExit();
