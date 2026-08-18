/**
 * RBAC guard tests for the route lockdown introduced in task #35:
 *   - /api/kpis*           (incl. /api/kpis/:id, /summary, /history, /values, /seed-*)
 *   - /api/executive/*     (reports, mbr-data)
 *   - /api/analytics/*     (cycle-times, agent-compliance, capa-recurrence, trends, executive-digest)
 *   - /api/scorecard/*     (mohammed, kpi/:n, history, snapshot)
 *   - /api/health/pulse*   (admin only)
 *   - /api/infographic/*   (sections, render, share/slack, share/email)
 *
 * Uses the pure `canAccessRoute` helper (no DB calls, no live server) to assert
 * that ROUTE_PERMISSION_MAP is correctly configured.
 *
 *   Negative path → department_viewer (and other low-privilege roles) → false
 *   Positive path → governance role / executive (per route)            → true
 *
 * Run:  npx tsx tests/rbacRouteLockdown.test.ts
 */

import { canAccessRoute } from "../src/utils/rbacMiddleware";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const GOVERNANCE_READ = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
];

const GOVERNANCE_WRITE = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];

const LOW_PRIV = [
  "department_viewer",
  "quality_specialist",
  "team_lead",
  "auditor",
  "bu_owner",
  "ai_specialist",
];

interface Case {
  label: string;
  path: string;
  method: string;
  allow: string[];
  block: string[];
}

const CASES: Case[] = [
  // ─── KPI reads ───
  {
    label: "GET /api/kpis (list)",
    path: "/api/kpis",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/kpis/summary",
    path: "/api/kpis/summary",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    // ROUTE_PERMISSION_MAP intentionally widens single-KPI reads to the full
    // Quality Reports read audience (LOW_PRIV roles) so the BU page can link
    // to an individual KPI's detail page. This does NOT grant list/summary access.
    label: "GET /api/kpis/42 (single)",
    path: "/api/kpis/42",
    method: "GET",
    allow: [...GOVERNANCE_READ, ...LOW_PRIV],
    block: [],
  },
  {
    label: "GET /api/kpis/42/history",
    path: "/api/kpis/42/history",
    method: "GET",
    allow: [...GOVERNANCE_READ, ...LOW_PRIV],
    block: [],
  },

  // ─── KPI writes ───
  {
    label: "POST /api/kpis (create) — executive blocked, governance write allowed",
    path: "/api/kpis",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
  {
    label: "PUT /api/kpis/42",
    path: "/api/kpis/42",
    method: "PUT",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
  {
    label: "POST /api/kpis/42/values",
    path: "/api/kpis/42/values",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },

  // ─── KPI seeders (admin only) ───
  {
    label: "POST /api/kpis/seed-mohammed (admin only)",
    path: "/api/kpis/seed-mohammed",
    method: "POST",
    allow: ["admin"],
    block: [...GOVERNANCE_READ.filter((r) => r !== "admin"), ...LOW_PRIV],
  },
  {
    label: "POST /api/kpis/seed-sdr (admin only)",
    path: "/api/kpis/seed-sdr",
    method: "POST",
    allow: ["admin"],
    block: [...GOVERNANCE_READ.filter((r) => r !== "admin"), ...LOW_PRIV],
  },

  // ─── Executive reports ───
  {
    label: "GET /api/executive/reports",
    path: "/api/executive/reports",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/executive/reports/7",
    path: "/api/executive/reports/7",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "POST /api/executive/reports",
    path: "/api/executive/reports",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
  {
    label: "PUT /api/executive/reports/7",
    path: "/api/executive/reports/7",
    method: "PUT",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
  {
    label: "GET /api/executive/mbr-data",
    path: "/api/executive/mbr-data",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },

  // ─── Analytics ───
  {
    label: "GET /api/analytics/cycle-times",
    path: "/api/analytics/cycle-times",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/analytics/agent-compliance",
    path: "/api/analytics/agent-compliance",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/analytics/capa-recurrence",
    path: "/api/analytics/capa-recurrence",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/analytics/trends",
    path: "/api/analytics/trends",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/analytics/executive-digest",
    path: "/api/analytics/executive-digest",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "POST /api/analytics/executive-digest/send (admin + head_of_operations_quality)",
    path: "/api/analytics/executive-digest/send",
    method: "POST",
    allow: ["admin", "head_of_operations_quality"],
    block: [
      ...LOW_PRIV,
      "executive",
      "quality_manager",
      "grc_manager",
    ],
  },

  // ─── Scorecard ───
  {
    label: "GET /api/scorecard/mohammed",
    path: "/api/scorecard/mohammed",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/scorecard/kpi/3",
    path: "/api/scorecard/kpi/3",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/scorecard/history",
    path: "/api/scorecard/history",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "POST /api/scorecard/snapshot",
    path: "/api/scorecard/snapshot",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },

  // ─── Health Pulse (admin-only) ───
  {
    label: "GET /api/health/pulse (admin only)",
    path: "/api/health/pulse",
    method: "GET",
    allow: ["admin"],
    block: [
      ...GOVERNANCE_READ.filter((r) => r !== "admin"),
      ...LOW_PRIV,
    ],
  },
  {
    label: "GET /api/health/pulse/latest (admin only)",
    path: "/api/health/pulse/latest",
    method: "GET",
    allow: ["admin"],
    block: [
      ...GOVERNANCE_READ.filter((r) => r !== "admin"),
      ...LOW_PRIV,
    ],
  },
  {
    label: "POST /api/health/pulse/run (admin only)",
    path: "/api/health/pulse/run",
    method: "POST",
    allow: ["admin"],
    block: [
      ...GOVERNANCE_READ.filter((r) => r !== "admin"),
      ...LOW_PRIV,
    ],
  },

  // ─── Infographics ───
  {
    label: "GET /api/infographic/sections",
    path: "/api/infographic/sections",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/infographic/quality-snapshot",
    path: "/api/infographic/quality-snapshot",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "GET /api/infographic/quality-snapshot.png",
    path: "/api/infographic/quality-snapshot.png",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: LOW_PRIV,
  },
  {
    label: "POST /api/infographic/quality-snapshot/share/slack",
    path: "/api/infographic/quality-snapshot/share/slack",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
  {
    label: "POST /api/infographic/quality-snapshot/share/email",
    path: "/api/infographic/quality-snapshot/share/email",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: [...LOW_PRIV, "executive"],
  },
];

console.log("\n=== Route Lockdown RBAC — ROUTE_PERMISSION_MAP unit tests ===\n");

for (const c of CASES) {
  console.log(`Case: ${c.label}`);
  console.log("  [allowed]");
  for (const role of c.allow) {
    assert(
      canAccessRoute(role, c.path, c.method) === true,
      `role '${role}' is allowed`
    );
  }
  console.log("  [blocked]");
  for (const role of c.block) {
    assert(
      canAccessRoute(role, c.path, c.method) === false,
      `role '${role}' is blocked (returns 403)`
    );
  }
  console.log();
}

console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ Route lockdown RBAC tests FAILED");
  process.exit(1);
}

console.log("\n✅ All route lockdown RBAC tests passed");
