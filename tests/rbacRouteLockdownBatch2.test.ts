/**
 * RBAC guard tests for the route lockdown introduced in task #60:
 *   - /api/pmp/*            (PMP projects, risks, milestones, stakeholders,
 *                            procurement, change-requests, portfolio, charter)
 *   - /api/tablef/*         (Department COPC KPI scorecard)
 *   - /api/ai/approvals*    (HITL governance queue)
 *   - /api/evidence*        (evidence records, pack, summary)
 *   - /api/qms/nc/*         (NC exports + closure approvals)
 *   - /api/qms/capa/*       (CAPA exports, effectiveness, closure approvals,
 *                            quick-update PATCH)
 *   - /api/kpis/export*     (KPI CSV + XLSX exports)
 *   - /api/pdpl/export*     (PDPL PII inventory — admin-only)
 *
 * Uses the pure `canAccessRoute` helper (no DB calls, no live server) to assert
 * that ROUTE_PERMISSION_MAP is correctly configured.
 *
 *   Negative path → department_viewer (and other low-privilege roles) → false
 *   Positive path → governance role / executive (per route)            → true
 *
 * Run:  npx tsx tests/rbacRouteLockdownBatch2.test.ts
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

const PMP_READ = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
  "bu_owner",
];

const PMP_WRITE = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "bu_owner",
];

const TABLEF_READ = [
  "admin",
  "head_of_operations_quality",
  "quality_manager",
  "grc_manager",
  "executive",
  "bu_owner",
];

const TABLEF_WRITE = [
  "admin",
  "head_of_operations_quality",
  "quality_manager",
  "grc_manager",
];

const AI_APPROVAL_READ = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "ai_specialist",
  "bu_owner",
  "executive",
  "quality_specialist",
  "auditor",
  "team_lead",
];

const AI_APPROVAL_APPROVE = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];

const EVIDENCE_READ = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "auditor",
  "quality_specialist",
  "team_lead",
  "bu_owner",
  "ai_specialist",
  "executive",
];

interface Case {
  label: string;
  path: string;
  method: string;
  allow: string[];
  block: string[];
}

const CASES: Case[] = [
  // ─── PMP reads ───
  {
    label: "GET /api/pmp/projects",
    path: "/api/pmp/projects",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/projects/proj-1",
    path: "/api/pmp/projects/proj-1",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/projects/proj-1/gantt",
    path: "/api/pmp/projects/proj-1/gantt",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/portfolio/analytics",
    path: "/api/pmp/portfolio/analytics",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/risks",
    path: "/api/pmp/risks",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/milestones",
    path: "/api/pmp/milestones",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/stakeholders",
    path: "/api/pmp/stakeholders",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/procurement",
    path: "/api/pmp/procurement",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/pmp/change-requests",
    path: "/api/pmp/change-requests",
    method: "GET",
    allow: PMP_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },

  // ─── PMP writes ───
  {
    label: "POST /api/pmp/projects",
    path: "/api/pmp/projects",
    method: "POST",
    allow: PMP_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive"],
  },
  {
    label: "PUT /api/pmp/projects/proj-1",
    path: "/api/pmp/projects/proj-1",
    method: "PUT",
    allow: PMP_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive"],
  },
  {
    label: "DELETE /api/pmp/projects/proj-1",
    path: "/api/pmp/projects/proj-1",
    method: "DELETE",
    allow: PMP_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive"],
  },
  {
    label: "POST /api/pmp/risks",
    path: "/api/pmp/risks",
    method: "POST",
    allow: PMP_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive"],
  },

  // ─── PMP AI charter (ai_specialist allowed to generate) ───
  {
    label: "POST /api/pmp/generate-charter — ai_specialist allowed",
    path: "/api/pmp/generate-charter",
    method: "POST",
    allow: [...PMP_WRITE, "ai_specialist"],
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "executive"],
  },

  // ─── TableF reads ───
  {
    label: "GET /api/tablef/departments",
    path: "/api/tablef/departments",
    method: "GET",
    allow: TABLEF_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/tablef/kpis",
    path: "/api/tablef/kpis",
    method: "GET",
    allow: TABLEF_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/tablef/performance",
    path: "/api/tablef/performance",
    method: "GET",
    allow: TABLEF_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },
  {
    label: "GET /api/tablef/users",
    path: "/api/tablef/users",
    method: "GET",
    allow: TABLEF_READ,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist"],
  },

  // ─── TableF writes ───
  {
    label: "POST /api/tablef/kpis",
    path: "/api/tablef/kpis",
    method: "POST",
    allow: TABLEF_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive", "bu_owner"],
  },
  {
    label: "POST /api/tablef/performance",
    path: "/api/tablef/performance",
    method: "POST",
    allow: TABLEF_WRITE,
    block: ["department_viewer", "quality_specialist", "auditor", "team_lead", "ai_specialist", "executive", "bu_owner"],
  },

  // ─── AI Approvals reads ───
  {
    label: "GET /api/ai/approvals",
    path: "/api/ai/approvals",
    method: "GET",
    allow: AI_APPROVAL_READ,
    block: ["department_viewer"],
  },
  {
    label: "GET /api/ai/approvals/pending-count",
    path: "/api/ai/approvals/pending-count",
    method: "GET",
    allow: AI_APPROVAL_READ,
    block: ["department_viewer"],
  },
  {
    label: "GET /api/ai/approvals/ACTION-001",
    path: "/api/ai/approvals/ACTION-001",
    method: "GET",
    allow: AI_APPROVAL_READ,
    block: ["department_viewer"],
  },

  // ─── AI Approvals approve ───
  {
    label: "POST /api/ai/approvals/ACTION-001/approve — governance only",
    path: "/api/ai/approvals/ACTION-001/approve",
    method: "POST",
    allow: AI_APPROVAL_APPROVE,
    block: ["department_viewer", "ai_specialist", "bu_owner", "executive", "quality_specialist", "auditor", "team_lead"],
  },

  // ─── AI Approvals reject ───
  {
    label: "POST /api/ai/approvals/ACTION-001/reject — broad role set",
    path: "/api/ai/approvals/ACTION-001/reject",
    method: "POST",
    allow: AI_APPROVAL_READ,
    block: ["department_viewer"],
  },

  // ─── Evidence reads / writes ───
  {
    label: "GET /api/evidence/nc/42",
    path: "/api/evidence/nc/42",
    method: "GET",
    allow: EVIDENCE_READ,
    block: ["department_viewer"],
  },
  {
    label: "POST /api/evidence",
    path: "/api/evidence",
    method: "POST",
    allow: EVIDENCE_READ,
    block: ["department_viewer"],
  },
  {
    label: "GET /api/evidence-pack",
    path: "/api/evidence-pack",
    method: "GET",
    allow: ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "auditor", "quality_specialist"],
    block: ["department_viewer", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },
  {
    label: "GET /api/evidence-summary",
    path: "/api/evidence-summary",
    method: "GET",
    allow: ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "auditor", "quality_specialist"],
    block: ["department_viewer", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },

  // ─── Evidence delete (governance only) ───
  {
    label: "DELETE /api/evidence/99",
    path: "/api/evidence/99",
    method: "DELETE",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },

  // ─── Compliance exports (governance write — no executive) ───
  {
    label: "GET /api/compliance/export — executive blocked",
    path: "/api/compliance/export",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/compliance/export/estimate — executive blocked",
    path: "/api/compliance/export/estimate",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/compliance/capa — executive allowed (broad compliance read)",
    path: "/api/compliance/capa",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── QMS NC/CAPA bulk-update (governance write) ───
  {
    label: "POST /api/qms/nc/bulk-update — governance write",
    path: "/api/qms/nc/bulk-update",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "POST /api/qms/capa/bulk-update — governance write",
    path: "/api/qms/capa/bulk-update",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── QMS NC/CAPA history (governance write — same roles as qmsGate else-branch) ───
  {
    label: "GET /api/qms/nc/5/history — governance write roles",
    path: "/api/qms/nc/5/history",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/qms/capa/5/history — governance write roles",
    path: "/api/qms/capa/5/history",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── QMS NC/CAPA closure approvals (quality governance) ───
  {
    label: "POST /api/qms/nc/5/approve-closure",
    path: "/api/qms/nc/5/approve-closure",
    method: "POST",
    allow: ["admin", "quality_manager", "head_of_operations_quality"],
    block: ["department_viewer", "grc_manager", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },
  {
    label: "POST /api/qms/capa/5/approve-closure",
    path: "/api/qms/capa/5/approve-closure",
    method: "POST",
    allow: ["admin", "quality_manager", "head_of_operations_quality"],
    block: ["department_viewer", "grc_manager", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },
  {
    label: "POST /api/qms/capa/5/effectiveness",
    path: "/api/qms/capa/5/effectiveness",
    method: "POST",
    allow: ["admin", "quality_manager", "head_of_operations_quality"],
    block: ["department_viewer", "grc_manager", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },

  // ─── QMS CAPA quick-update PATCH (include auditor for triage) ───
  {
    label: "PATCH /api/qms/capa/5 — auditor allowed",
    path: "/api/qms/capa/5",
    method: "PATCH",
    allow: ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "auditor"],
    block: ["department_viewer", "quality_specialist", "team_lead", "bu_owner", "ai_specialist", "executive"],
  },

  // ─── QMS NC / CAPA CSV exports ───
  {
    label: "GET /api/qms/nc/export",
    path: "/api/qms/nc/export",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/qms/nc/export/estimate",
    path: "/api/qms/nc/export/estimate",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/qms/capa/export",
    path: "/api/qms/capa/export",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/qms/nc/export-xlsx/estimate (admin only via inner guard)",
    path: "/api/qms/nc/export-xlsx/estimate",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/qms/capa-export-xlsx/estimate",
    path: "/api/qms/capa-export-xlsx/estimate",
    method: "GET",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── KPI exports (governance + executive allowed for CSV) ───
  {
    label: "GET /api/kpis/export",
    path: "/api/kpis/export",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/kpis/export/estimate",
    path: "/api/kpis/export/estimate",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/kpis/export-xlsx",
    path: "/api/kpis/export-xlsx",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/kpis/export-xlsx/estimate",
    path: "/api/kpis/export-xlsx/estimate",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── PDPL export (admin-only) ───
  {
    label: "GET /api/pdpl/export — admin only",
    path: "/api/pdpl/export",
    method: "GET",
    allow: ["admin"],
    block: [
      "department_viewer",
      ...GOVERNANCE_READ.filter((r) => r !== "admin"),
      "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist",
    ],
  },
  {
    label: "GET /api/pdpl/export/estimate — admin only",
    path: "/api/pdpl/export/estimate",
    method: "GET",
    allow: ["admin"],
    block: [
      "department_viewer",
      ...GOVERNANCE_READ.filter((r) => r !== "admin"),
      "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist",
    ],
  },

  // ─── Dashboard reads (governance read) ───
  {
    label: "GET /api/dashboard",
    path: "/api/dashboard",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/dashboard/layouts-breakdown",
    path: "/api/dashboard/layouts-breakdown",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/dashboard/quality-trend",
    path: "/api/dashboard/quality-trend",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/dashboard/issues-category-trend",
    path: "/api/dashboard/issues-category-trend",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/audit/latest",
    path: "/api/audit/latest",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/audit/history",
    path: "/api/audit/history",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/audit/recommendations",
    path: "/api/audit/recommendations",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/scorecards",
    path: "/api/scorecards",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/scorecard",
    path: "/api/scorecard",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/governance",
    path: "/api/governance",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/crm/data",
    path: "/api/crm/data",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/agents/performance",
    path: "/api/agents/performance",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
  {
    label: "GET /api/integrations/status",
    path: "/api/integrations/status",
    method: "GET",
    allow: GOVERNANCE_READ,
    block: ["department_viewer", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },

  // ─── Dashboard writes ───
  {
    label: "POST /api/audit/trigger — broad roles, department_viewer blocked",
    path: "/api/audit/trigger",
    method: "POST",
    allow: ["admin", "quality_manager", "grc_manager", "head_of_operations_quality", "team_lead", "auditor", "quality_specialist", "ai_specialist", "bu_owner", "executive"],
    block: ["department_viewer"],
  },
  {
    label: "POST /api/crm/enrich — governance write",
    path: "/api/crm/enrich",
    method: "POST",
    allow: GOVERNANCE_WRITE,
    block: ["department_viewer", "executive", "auditor", "quality_specialist", "team_lead", "bu_owner", "ai_specialist"],
  },
];

console.log("\n=== Route Lockdown RBAC Batch-2 (task #60) — ROUTE_PERMISSION_MAP unit tests ===\n");

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
  console.error("\n❌ Route lockdown RBAC batch-2 tests FAILED");
  process.exit(1);
}

console.log("\n✅ All route lockdown RBAC batch-2 tests passed");
