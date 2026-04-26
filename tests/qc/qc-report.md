# WalaPlus Platform QC Report

**Generated:** 2026-02-19T12:08:38.497Z  
**Base URL:** https://qms-dashboard.replit.app  

## Summary

| Status | Count |
|--------|-------|
| ✅ Pass | 0 |
| ❌ Fail | 52 |
| **Total** | **52** |

---

## Send to Replit – Fix These

Copy the rows below and send to Replit. Each row = one fix request.

| Screen | Functionality | Detail |
|--------|---------------|--------|
| Quality Dashboard (/) | Load dashboard data | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard (/) | Load latest audit result | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard (/) | Load audit history | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard (/) | Agent Performance widget | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel (/admin) | Governance Document Manager | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel (/admin) | Scorecard list | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel (/admin) | Activity logging | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard (/qms) | QMS dashboard data | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard (/qms) | CAPA list | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard (/qms) | Nonconformance list | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard (/qms) | Deal evaluations | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower (/grc) | Risk summary | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower (/grc) | Compliance overview | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower (/grc) | Policy summary | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower (/grc) | Audit summary | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower (/grc) | Vendor summary | fetch failed (self-signed certificate in certificate chain) |
| Risk Register (/risks) | List risks | fetch failed (self-signed certificate in certificate chain) |
| Risk Register (/risks) | Risk heat map | fetch failed (self-signed certificate in certificate chain) |
| Risk Register (/risks) | Risk categories | fetch failed (self-signed certificate in certificate chain) |
| Policy Governance (/policies) | List policies | fetch failed (self-signed certificate in certificate chain) |
| Policy Governance (/policies) | Policy summary | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker (/compliance) | List regulations | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker (/compliance) | List obligations | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker (/compliance) | Compliance summary | fetch failed (self-signed certificate in certificate chain) |
| Audit Readiness (/audits) | List audits | fetch failed (self-signed certificate in certificate chain) |
| Audit Readiness (/audits) | Audit findings | fetch failed (self-signed certificate in certificate chain) |
| Vendor Risk Management (/vendors) | List vendors | fetch failed (self-signed certificate in certificate chain) |
| Vendor Risk Management (/vendors) | Vendor summary | fetch failed (self-signed certificate in certificate chain) |
| Data Migration (/migration) | Migration templates | fetch failed (self-signed certificate in certificate chain) |
| Data Migration (/migration) | Migration jobs list | fetch failed (self-signed certificate in certificate chain) |
| Data Migration (/migration) | Deduplication rules | fetch failed (self-signed certificate in certificate chain) |
| Call Intelligence (/calls) | Call records list | fetch failed (self-signed certificate in certificate chain) |
| Call Intelligence (/calls) | Call analytics | fetch failed (self-signed certificate in certificate chain) |
| ROI Evaluation (/roi) | ROI initiatives | fetch failed (self-signed certificate in certificate chain) |
| ROI Evaluation (/roi) | ROI analytics | fetch failed (self-signed certificate in certificate chain) |
| Team Performance (/team) | Team members list | fetch failed (self-signed certificate in certificate chain) |
| Team Performance (/team) | Team performance data | fetch failed (self-signed certificate in certificate chain) |
| Project Portfolio (PMP) (/projects) | Projects list | fetch failed (self-signed certificate in certificate chain) |
| System Event Logs (/logs) | Event logs list | fetch failed (self-signed certificate in certificate chain) |
| System Event Logs (/logs) | Logs stats | fetch failed (self-signed certificate in certificate chain) |
| PDPL Privacy Compliance (/pdpl) | PDPL status | fetch failed (self-signed certificate in certificate chain) |
| PDPL Privacy Compliance (/pdpl) | Data inventory | fetch failed (self-signed certificate in certificate chain) |
| Users & Access Control (/users) | User stats | fetch failed (self-signed certificate in certificate chain) |
| Scorecard (/scorecard) | Scorecard snapshot | fetch failed (self-signed certificate in certificate chain) |
| Duplicate Radar (/duplicates) | Duplicates summary | fetch failed (self-signed certificate in certificate chain) |
| Quality-GRC Handoffs (/grc) | Handoff rules list | fetch failed (self-signed certificate in certificate chain) |
| Quality-GRC Handoffs (/grc) | Handoff summary | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard / Admin (/) | Integrations status | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel (/admin) | Workflow runs | fetch failed (self-signed certificate in certificate chain) |
| KPI Tracking (/kpis) | KPI list | fetch failed (self-signed certificate in certificate chain) |
| KPI Tracking (/kpis) | KPI summary | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel (/admin) | Triggers list | fetch failed (self-signed certificate in certificate chain) |

### Machine-friendly (for Replit / Cursor)

```json
[
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load dashboard data",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/dashboard"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load latest audit result",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/audit/latest"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load audit history",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/audit/history"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Agent Performance widget",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/agents/performance"
  },
  {
    "screen": "Admin Panel",
    "screenRoute": "/admin",
    "functionality": "Governance Document Manager",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/admin/documents"
  },
  {
    "screen": "Admin Panel",
    "screenRoute": "/admin",
    "functionality": "Scorecard list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/admin/scorecards"
  },
  {
    "screen": "Admin Panel",
    "screenRoute": "/admin",
    "functionality": "Activity logging",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/admin/activities"
  },
  {
    "screen": "QMS Dashboard",
    "screenRoute": "/qms",
    "functionality": "QMS dashboard data",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/qms/dashboard"
  },
  {
    "screen": "QMS Dashboard",
    "screenRoute": "/qms",
    "functionality": "CAPA list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/qms/capa"
  },
  {
    "screen": "QMS Dashboard",
    "screenRoute": "/qms",
    "functionality": "Nonconformance list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/qms/nc"
  },
  {
    "screen": "QMS Dashboard",
    "screenRoute": "/qms",
    "functionality": "Deal evaluations",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/qms/evaluations"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Risk summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/risks/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Compliance overview",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/compliance/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Policy summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/policies/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Audit summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/audits/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Vendor summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/vendors/summary"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "List risks",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/risks"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "Risk heat map",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/risks/heatmap"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "Risk categories",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/risks/categories"
  },
  {
    "screen": "Policy Governance",
    "screenRoute": "/policies",
    "functionality": "List policies",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/policies"
  },
  {
    "screen": "Policy Governance",
    "screenRoute": "/policies",
    "functionality": "Policy summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/policies/summary"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "List regulations",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/compliance/regulations"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "List obligations",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/compliance/obligations"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "Compliance summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/compliance/summary"
  },
  {
    "screen": "Audit Readiness",
    "screenRoute": "/audits",
    "functionality": "List audits",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/audits"
  },
  {
    "screen": "Audit Readiness",
    "screenRoute": "/audits",
    "functionality": "Audit findings",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/audits/findings"
  },
  {
    "screen": "Vendor Risk Management",
    "screenRoute": "/vendors",
    "functionality": "List vendors",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/vendors"
  },
  {
    "screen": "Vendor Risk Management",
    "screenRoute": "/vendors",
    "functionality": "Vendor summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/vendors/summary"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Migration templates",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/migration/templates"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Migration jobs list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/migration/jobs"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Deduplication rules",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/migration/dedup-rules"
  },
  {
    "screen": "Call Intelligence",
    "screenRoute": "/calls",
    "functionality": "Call records list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/calls"
  },
  {
    "screen": "Call Intelligence",
    "screenRoute": "/calls",
    "functionality": "Call analytics",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/calls/analytics"
  },
  {
    "screen": "ROI Evaluation",
    "screenRoute": "/roi",
    "functionality": "ROI initiatives",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/roi"
  },
  {
    "screen": "ROI Evaluation",
    "screenRoute": "/roi",
    "functionality": "ROI analytics",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/roi/analytics"
  },
  {
    "screen": "Team Performance",
    "screenRoute": "/team",
    "functionality": "Team members list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/team/members"
  },
  {
    "screen": "Team Performance",
    "screenRoute": "/team",
    "functionality": "Team performance data",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/team/performance"
  },
  {
    "screen": "Project Portfolio (PMP)",
    "screenRoute": "/projects",
    "functionality": "Projects list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/pmp/projects"
  },
  {
    "screen": "System Event Logs",
    "screenRoute": "/logs",
    "functionality": "Event logs list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/logs"
  },
  {
    "screen": "System Event Logs",
    "screenRoute": "/logs",
    "functionality": "Logs stats",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/logs/stats"
  },
  {
    "screen": "PDPL Privacy Compliance",
    "screenRoute": "/pdpl",
    "functionality": "PDPL status",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/pdpl/status"
  },
  {
    "screen": "PDPL Privacy Compliance",
    "screenRoute": "/pdpl",
    "functionality": "Data inventory",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/pdpl/inventory"
  },
  {
    "screen": "Users & Access Control",
    "screenRoute": "/users",
    "functionality": "User stats",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/users/stats"
  },
  {
    "screen": "Scorecard",
    "screenRoute": "/scorecard",
    "functionality": "Scorecard snapshot",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/scorecard/snapshot"
  },
  {
    "screen": "Duplicate Radar",
    "screenRoute": "/duplicates",
    "functionality": "Duplicates summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/duplicates/summary"
  },
  {
    "screen": "Quality-GRC Handoffs",
    "screenRoute": "/grc",
    "functionality": "Handoff rules list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/handoff/rules"
  },
  {
    "screen": "Quality-GRC Handoffs",
    "screenRoute": "/grc",
    "functionality": "Handoff summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/handoff/summary"
  },
  {
    "screen": "Quality Dashboard / Admin",
    "screenRoute": "/",
    "functionality": "Integrations status",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/integrations/status"
  },
  {
    "screen": "Admin Panel",
    "screenRoute": "/admin",
    "functionality": "Workflow runs",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/workflow/runs"
  },
  {
    "screen": "KPI Tracking",
    "screenRoute": "/kpis",
    "functionality": "KPI list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/kpis"
  },
  {
    "screen": "KPI Tracking",
    "screenRoute": "/kpis",
    "functionality": "KPI summary",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/kpis/summary"
  },
  {
    "screen": "Admin Panel",
    "screenRoute": "/admin",
    "functionality": "Triggers list",
    "detail": "fetch failed (self-signed certificate in certificate chain)",
    "method": "GET",
    "path": "/api/triggers"
  }
]
```

---

## All Results

| Screen | Functionality | Status | HTTP | Detail |
|--------|---------------|--------|------|--------|
| Quality Dashboard | Load dashboard data | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard | Load latest audit result | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard | Load audit history | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard | Agent Performance widget | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel | Governance Document Manager | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel | Scorecard list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel | Activity logging | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard | QMS dashboard data | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard | CAPA list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard | Nonconformance list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| QMS Dashboard | Deal evaluations | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower | Risk summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower | Compliance overview | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower | Policy summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower | Audit summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| GRC Control Tower | Vendor summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Risk Register | List risks | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Risk Register | Risk heat map | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Risk Register | Risk categories | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Policy Governance | List policies | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Policy Governance | Policy summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker | List regulations | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker | List obligations | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Compliance Tracker | Compliance summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Audit Readiness | List audits | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Audit Readiness | Audit findings | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Vendor Risk Management | List vendors | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Vendor Risk Management | Vendor summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Data Migration | Migration templates | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Data Migration | Migration jobs list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Data Migration | Deduplication rules | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Call Intelligence | Call records list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Call Intelligence | Call analytics | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| ROI Evaluation | ROI initiatives | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| ROI Evaluation | ROI analytics | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Team Performance | Team members list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Team Performance | Team performance data | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Project Portfolio (PMP) | Projects list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| System Event Logs | Event logs list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| System Event Logs | Logs stats | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| PDPL Privacy Compliance | PDPL status | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| PDPL Privacy Compliance | Data inventory | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Users & Access Control | User stats | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Scorecard | Scorecard snapshot | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Duplicate Radar | Duplicates summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality-GRC Handoffs | Handoff rules list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality-GRC Handoffs | Handoff summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Quality Dashboard / Admin | Integrations status | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel | Workflow runs | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| KPI Tracking | KPI list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| KPI Tracking | KPI summary | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
| Admin Panel | Triggers list | ❌ fail | — | fetch failed (self-signed certificate in certificate chain) |
