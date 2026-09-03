# Prompts to Fix QC Failures in HostingPlatform

Copy the prompt(s) below into **HostingPlatform's AI chat** (or Agent). Use **Prompt 1** first for a full fix; use **Prompt 2** if you want to fix by module in smaller steps.

---

## Prompt 1 – Master prompt (fix all 52 API checks)

Copy everything below this line into HostingPlatform:

```
I need you to fix the ExampleOrg ExampleOrg so that all of these API endpoints work correctly. Our QC suite runs against this app and currently all 52 checks fail. Each endpoint should return HTTP 200 (or 401 for admin routes when X-Admin-Key is missing).

Please ensure each of these endpoints exists, is registered in the Mastra/Hono app (src/mastra/index.ts or the relevant route file), and returns valid JSON with the expected status:

**Quality Dashboard (route /)**
- GET /api/dashboard — Load dashboard data
- GET /api/audit/latest — Load latest audit result (200 or 404)
- GET /api/audit/history — Load audit history
- GET /api/agents/performance — Agent Performance widget (200 or 404)
- GET /api/integrations/status — Integrations status

**Admin Panel (route /admin)**
- GET /api/admin/documents — Governance Document Manager (with X-Admin-Key, or 401 without)
- GET /api/admin/scorecards — Scorecard list
- GET /api/admin/activities — Activity logging
- GET /api/workflow/runs — Workflow runs
- GET /api/triggers — Triggers list

**ExampleOrg (route /qms)**
- GET /api/qms/dashboard — ExampleOrg data
- GET /api/qms/capa — CAPA list
- GET /api/qms/nc — Nonconformance list
- GET /api/qms/evaluations — Deal evaluations

**GRC Control Tower (route /grc)**
- GET /api/risks/summary — Risk summary
- GET /api/compliance/summary — Compliance overview
- GET /api/policies/summary — Policy summary
- GET /api/audits/summary — Audit summary
- GET /api/vendors/summary — Vendor summary

**Risk Register (route /risks)**
- GET /api/risks — List risks
- GET /api/risks/heatmap — Risk heat map
- GET /api/risks/categories — Risk categories

**Policy Governance (route /policies)**
- GET /api/policies — List policies
- GET /api/policies/summary — Policy summary

**Compliance Tracker (route /compliance)**
- GET /api/compliance/regulations — List regulations
- GET /api/compliance/obligations — List obligations
- GET /api/compliance/summary — Compliance summary

**Audit Readiness (route /audits)**
- GET /api/audits — List audits
- GET /api/audits/findings — Audit findings

**Vendor Risk (route /vendors)**
- GET /api/vendors — List vendors
- GET /api/vendors/summary — Vendor summary

**Data Migration (route /migration)**
- GET /api/migration/templates — Migration templates
- GET /api/migration/jobs — Migration jobs list
- GET /api/migration/dedup-rules — Deduplication rules

**Call Intelligence (route /calls)**
- GET /api/calls — Call records list
- GET /api/calls/analytics — Call analytics

**ROI (route /roi)**
- GET /api/roi — ROI initiatives
- GET /api/roi/analytics — ROI analytics

**Team Performance (route /team)**
- GET /api/team/members — Team members list
- GET /api/team/performance — Team performance data

**Project Portfolio (route /projects)**
- GET /api/pmp/projects — Projects list

**System Event Logs (route /logs)**
- GET /api/logs — Event logs list
- GET /api/logs/stats — Logs stats

**PDPL (route /pdpl)**
- GET /api/pdpl/status — PDPL status
- GET /api/pdpl/inventory — Data inventory

**Users & Access (route /users)**
- GET /api/users/stats — User stats

**Scorecard (route /scorecard)**
- GET /api/scorecard/snapshot — Scorecard snapshot

**Duplicate Radar (route /duplicates)**
- GET /api/duplicates/summary — Duplicates summary

**Quality–GRC Handoffs**
- GET /api/handoff/rules — Handoff rules list
- GET /api/handoff/summary — Handoff summary

**KPI Tracking (route /kpis)**
- GET /api/kpis — KPI list
- GET /api/kpis/summary — KPI summary

For each endpoint: confirm the route is registered and the handler returns appropriate JSON. Fix any 500 errors, missing routes, or CORS/network issues so that a GET to the base URL + path returns 200 (or 401 for admin routes when no X-Admin-Key is sent). After your changes, I will re-run the QC suite to verify.
```

---

## Prompt 2 – Short version (if Prompt 1 is too long)

Copy into HostingPlatform:

```
Our platform QC suite checks 52 API endpoints. All are failing. Please fix the ExampleOrg Mastra app so these endpoints respond correctly:

1. Quality: GET /api/dashboard, /api/audit/latest, /api/audit/history, /api/agents/performance, /api/integrations/status
2. Admin: GET /api/admin/documents, /api/admin/scorecards, /api/admin/activities, /api/workflow/runs, /api/triggers (use X-Admin-Key or return 401)
3. QMS: GET /api/qms/dashboard, /api/qms/capa, /api/qms/nc, /api/qms/evaluations
4. GRC: GET /api/risks/summary, /api/compliance/summary, /api/policies/summary, /api/audits/summary, /api/vendors/summary
5. Risks: GET /api/risks, /api/risks/heatmap, /api/risks/categories
6. Policies: GET /api/policies, /api/policies/summary
7. Compliance: GET /api/compliance/regulations, /api/compliance/obligations, /api/compliance/summary
8. Audits: GET /api/audits, /api/audits/findings
9. Vendors: GET /api/vendors, /api/vendors/summary
10. Migration: GET /api/migration/templates, /api/migration/jobs, /api/migration/dedup-rules
11. Calls: GET /api/calls, /api/calls/analytics
12. ROI: GET /api/roi, /api/roi/analytics
13. Team: GET /api/team/members, /api/team/performance
14. Projects: GET /api/pmp/projects
15. Logs: GET /api/logs, /api/logs/stats
16. PDPL: GET /api/pdpl/status, /api/pdpl/inventory
17. Users: GET /api/users/stats
18. Scorecard: GET /api/scorecard/snapshot
19. Duplicates: GET /api/duplicates/summary
20. Handoff: GET /api/handoff/rules, /api/handoff/summary
21. KPIs: GET /api/kpis, /api/kpis/summary

Ensure each route is registered and returns 200 (or 401 for admin routes without key). Fix missing routes and 500 errors.
```

---

## Prompt 3 – Fix by module (use one at a time)

**Quality Dashboard only:**
```
Fix these API endpoints for the Quality Dashboard so they return 200 and valid JSON: GET /api/dashboard, /api/audit/latest, /api/audit/history, /api/agents/performance, /api/integrations/status. They are used by the dashboard at route /. Check src/mastra/index.ts and ensure the handlers exist and don’t throw 500.
```

**Admin + QMS only:**
```
Fix these API endpoints so they return 200 with X-Admin-Key or 401 without: GET /api/admin/documents, /api/admin/scorecards, /api/admin/activities, /api/workflow/runs, /api/triggers, /api/qms/dashboard, /api/qms/capa, /api/qms/nc, /api/qms/evaluations. Check route registration and handlers in the Mastra app.
```

**GRC modules (Risks, Policies, Compliance, Audits, Vendors):**
```
Fix these GRC API endpoints so they return 200 and valid JSON: GET /api/risks, /api/risks/summary, /api/risks/heatmap, /api/risks/categories, /api/policies, /api/policies/summary, /api/compliance/regulations, /api/compliance/obligations, /api/compliance/summary, /api/audits, /api/audits/summary, /api/audits/findings, /api/vendors, /api/vendors/summary. Ensure routes are registered in the Mastra app.
```

**Rest (Migration, Calls, ROI, Team, Projects, Logs, PDPL, Users, Scorecard, Duplicates, Handoff, KPIs):**
```
Fix these API endpoints so they return 200 and valid JSON: GET /api/migration/templates, /api/migration/jobs, /api/migration/dedup-rules, /api/calls, /api/calls/analytics, /api/roi, /api/roi/analytics, /api/team/members, /api/team/performance, /api/pmp/projects, /api/logs, /api/logs/stats, /api/pdpl/status, /api/pdpl/inventory, /api/users/stats, /api/scorecard/snapshot, /api/duplicates/summary, /api/handoff/rules, /api/handoff/summary, /api/kpis, /api/kpis/summary. Ensure each is registered and returns valid JSON.
```

---

## After HostingPlatform applies fixes

1. In HostingPlatform: run the app (e.g. **Run** or `npm run dev`) and leave it running.
2. On your PC (PowerShell): run  
   `$env:QC_BASE_URL="<REDACTED_URL_SCHEME><REDACTED_HOST>"; npm run qc`
3. Open `tests/qc/qc-report.md` and check the new Pass/Fail counts and the “Send to HostingPlatform – Fix These” section for any remaining failures.
