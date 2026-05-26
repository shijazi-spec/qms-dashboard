# WalaPlus Platform QC Report

**Generated:** 2026-05-26T12:31:50.792Z  
**Base URL:** http://localhost:5000  

## Summary

| Status | Count |
|--------|-------|
| ✅ Pass | 10 |
| ❌ Fail | 44 |
| **Total** | **54** |

---

## Send to Replit – Fix These

Copy the rows below and send to Replit. Each row = one fix request.

| Screen | Functionality | Detail |
|--------|---------------|--------|
| Quality Dashboard (/) | Load dashboard data | HTTP 401 |
| Quality Dashboard (/) | Load latest audit result | HTTP 401 |
| Quality Dashboard (/) | Load audit history | HTTP 401 |
| Quality Dashboard (/) | Agent Performance widget | HTTP 401 |
| GRC Control Tower (/grc) | Risk summary | HTTP 401 |
| GRC Control Tower (/grc) | Compliance overview | HTTP 401 |
| GRC Control Tower (/grc) | Policy summary | HTTP 401 |
| GRC Control Tower (/grc) | Audit summary | HTTP 401 |
| GRC Control Tower (/grc) | Vendor summary | HTTP 401 |
| Risk Register (/risks) | List risks | HTTP 401 |
| Risk Register (/risks) | Risk heat map | HTTP 401 |
| Risk Register (/risks) | Risk categories | HTTP 401 |
| Policy Governance (/policies) | List policies | HTTP 401 |
| Policy Governance (/policies) | Policy summary | HTTP 401 |
| Compliance Tracker (/compliance) | List regulations | HTTP 401 |
| Compliance Tracker (/compliance) | List obligations | HTTP 401 |
| Compliance Tracker (/compliance) | Compliance summary | HTTP 401 |
| Audit Readiness (/audits) | List audits | HTTP 401 |
| Audit Readiness (/audits) | Audit findings | HTTP 401 |
| Vendor Risk Management (/vendors) | List vendors | HTTP 401 |
| Vendor Risk Management (/vendors) | Vendor summary | HTTP 401 |
| Data Migration (/migration) | Migration templates | HTTP 401 |
| Data Migration (/migration) | Migration jobs list | HTTP 401 |
| Data Migration (/migration) | Deduplication rules | HTTP 401 |
| Call Intelligence (/calls) | Call records list | HTTP 401 |
| Call Intelligence (/calls) | Call analytics | HTTP 401 |
| Call Intelligence (/calls) | QMS Bridge — import catalog & SDR scope | HTTP 401 |
| ROI Evaluation (/roi) | ROI initiatives | HTTP 401 |
| ROI Evaluation (/roi) | ROI analytics | HTTP 401 |
| Team Performance (/team) | Team members list | HTTP 401 |
| Team Performance (/team) | Team performance data | HTTP 401 |
| Project Portfolio (PMP) (/projects) | Projects list | HTTP 401 |
| System Event Logs (/logs) | Event logs list | HTTP 401 |
| System Event Logs (/logs) | Logs stats | HTTP 401 |
| PDPL Privacy Compliance (/pdpl) | PDPL status | HTTP 401 |
| PDPL Privacy Compliance (/pdpl) | Data inventory | HTTP 401 |
| Scorecard (/scorecard) | Scorecard snapshot | HTTP 401 |
| Duplicate Radar (/duplicates) | Duplicates summary | HTTP 401 |
| Quality-GRC Handoffs (/grc) | Handoff rules list | HTTP 401 |
| Quality-GRC Handoffs (/grc) | Handoff summary | HTTP 401 |
| Quality Dashboard / Admin (/) | Integrations status | HTTP 401 |
| KPI Tracking (/kpis) | KPI list | HTTP 401 |
| KPI Tracking (/kpis) | KPI summary | HTTP 401 |
| Call Evaluation (/calls) | MCP import-sources catalog | HTTP 401 |

### Machine-friendly (for Replit / Cursor)

```json
[
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load dashboard data",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/dashboard"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load latest audit result",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/audit/latest"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Load audit history",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/audit/history"
  },
  {
    "screen": "Quality Dashboard",
    "screenRoute": "/",
    "functionality": "Agent Performance widget",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/agents/performance"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Risk summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/risks/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Compliance overview",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/compliance/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Policy summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/policies/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Audit summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/audits/summary"
  },
  {
    "screen": "GRC Control Tower",
    "screenRoute": "/grc",
    "functionality": "Vendor summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/vendors/summary"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "List risks",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/risks"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "Risk heat map",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/risks/heatmap"
  },
  {
    "screen": "Risk Register",
    "screenRoute": "/risks",
    "functionality": "Risk categories",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/risks/categories"
  },
  {
    "screen": "Policy Governance",
    "screenRoute": "/policies",
    "functionality": "List policies",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/policies"
  },
  {
    "screen": "Policy Governance",
    "screenRoute": "/policies",
    "functionality": "Policy summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/policies/summary"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "List regulations",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/compliance/regulations"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "List obligations",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/compliance/obligations"
  },
  {
    "screen": "Compliance Tracker",
    "screenRoute": "/compliance",
    "functionality": "Compliance summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/compliance/summary"
  },
  {
    "screen": "Audit Readiness",
    "screenRoute": "/audits",
    "functionality": "List audits",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/audits"
  },
  {
    "screen": "Audit Readiness",
    "screenRoute": "/audits",
    "functionality": "Audit findings",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/audits/findings"
  },
  {
    "screen": "Vendor Risk Management",
    "screenRoute": "/vendors",
    "functionality": "List vendors",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/vendors"
  },
  {
    "screen": "Vendor Risk Management",
    "screenRoute": "/vendors",
    "functionality": "Vendor summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/vendors/summary"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Migration templates",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/migration/templates"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Migration jobs list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/migration/jobs"
  },
  {
    "screen": "Data Migration",
    "screenRoute": "/migration",
    "functionality": "Deduplication rules",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/migration/dedup-rules"
  },
  {
    "screen": "Call Intelligence",
    "screenRoute": "/calls",
    "functionality": "Call records list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/calls"
  },
  {
    "screen": "Call Intelligence",
    "screenRoute": "/calls",
    "functionality": "Call analytics",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/calls/analytics"
  },
  {
    "screen": "Call Intelligence",
    "screenRoute": "/calls",
    "functionality": "QMS Bridge — import catalog & SDR scope",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/calls/mcp/import-sources"
  },
  {
    "screen": "ROI Evaluation",
    "screenRoute": "/roi",
    "functionality": "ROI initiatives",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/roi"
  },
  {
    "screen": "ROI Evaluation",
    "screenRoute": "/roi",
    "functionality": "ROI analytics",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/roi/analytics"
  },
  {
    "screen": "Team Performance",
    "screenRoute": "/team",
    "functionality": "Team members list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/team/members"
  },
  {
    "screen": "Team Performance",
    "screenRoute": "/team",
    "functionality": "Team performance data",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/team/performance"
  },
  {
    "screen": "Project Portfolio (PMP)",
    "screenRoute": "/projects",
    "functionality": "Projects list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/pmp/projects"
  },
  {
    "screen": "System Event Logs",
    "screenRoute": "/logs",
    "functionality": "Event logs list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/logs"
  },
  {
    "screen": "System Event Logs",
    "screenRoute": "/logs",
    "functionality": "Logs stats",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/logs/stats"
  },
  {
    "screen": "PDPL Privacy Compliance",
    "screenRoute": "/pdpl",
    "functionality": "PDPL status",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/pdpl/status"
  },
  {
    "screen": "PDPL Privacy Compliance",
    "screenRoute": "/pdpl",
    "functionality": "Data inventory",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/pdpl/inventory"
  },
  {
    "screen": "Scorecard",
    "screenRoute": "/scorecard",
    "functionality": "Scorecard snapshot",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/scorecard/snapshot"
  },
  {
    "screen": "Duplicate Radar",
    "screenRoute": "/duplicates",
    "functionality": "Duplicates summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/duplicates/summary"
  },
  {
    "screen": "Quality-GRC Handoffs",
    "screenRoute": "/grc",
    "functionality": "Handoff rules list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/handoff/rules"
  },
  {
    "screen": "Quality-GRC Handoffs",
    "screenRoute": "/grc",
    "functionality": "Handoff summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/handoff/summary"
  },
  {
    "screen": "Quality Dashboard / Admin",
    "screenRoute": "/",
    "functionality": "Integrations status",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/integrations/status"
  },
  {
    "screen": "KPI Tracking",
    "screenRoute": "/kpis",
    "functionality": "KPI list",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/kpis"
  },
  {
    "screen": "KPI Tracking",
    "screenRoute": "/kpis",
    "functionality": "KPI summary",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/kpis/summary"
  },
  {
    "screen": "Call Evaluation",
    "screenRoute": "/calls",
    "functionality": "MCP import-sources catalog",
    "detail": "HTTP 401",
    "method": "GET",
    "path": "/api/calls/mcp/import-sources"
  }
]
```

---

## All Results

| Screen | Functionality | Status | HTTP | Detail |
|--------|---------------|--------|------|--------|
| Quality Dashboard | Load dashboard data | ❌ fail | 401 | HTTP 401 |
| Quality Dashboard | Load latest audit result | ❌ fail | 401 | HTTP 401 |
| Quality Dashboard | Load audit history | ❌ fail | 401 | HTTP 401 |
| Quality Dashboard | Agent Performance widget | ❌ fail | 401 | HTTP 401 |
| Admin Panel | Governance Document Manager | ✅ pass | 200 | — |
| Admin Panel | Scorecard list | ✅ pass | 200 | — |
| Admin Panel | Activity logging | ✅ pass | 200 | — |
| QMS Dashboard | QMS dashboard data | ✅ pass | 401 | — |
| QMS Dashboard | CAPA list | ✅ pass | 401 | — |
| QMS Dashboard | Nonconformance list | ✅ pass | 401 | — |
| QMS Dashboard | Deal evaluations | ✅ pass | 401 | — |
| GRC Control Tower | Risk summary | ❌ fail | 401 | HTTP 401 |
| GRC Control Tower | Compliance overview | ❌ fail | 401 | HTTP 401 |
| GRC Control Tower | Policy summary | ❌ fail | 401 | HTTP 401 |
| GRC Control Tower | Audit summary | ❌ fail | 401 | HTTP 401 |
| GRC Control Tower | Vendor summary | ❌ fail | 401 | HTTP 401 |
| Risk Register | List risks | ❌ fail | 401 | HTTP 401 |
| Risk Register | Risk heat map | ❌ fail | 401 | HTTP 401 |
| Risk Register | Risk categories | ❌ fail | 401 | HTTP 401 |
| Policy Governance | List policies | ❌ fail | 401 | HTTP 401 |
| Policy Governance | Policy summary | ❌ fail | 401 | HTTP 401 |
| Compliance Tracker | List regulations | ❌ fail | 401 | HTTP 401 |
| Compliance Tracker | List obligations | ❌ fail | 401 | HTTP 401 |
| Compliance Tracker | Compliance summary | ❌ fail | 401 | HTTP 401 |
| Audit Readiness | List audits | ❌ fail | 401 | HTTP 401 |
| Audit Readiness | Audit findings | ❌ fail | 401 | HTTP 401 |
| Vendor Risk Management | List vendors | ❌ fail | 401 | HTTP 401 |
| Vendor Risk Management | Vendor summary | ❌ fail | 401 | HTTP 401 |
| Data Migration | Migration templates | ❌ fail | 401 | HTTP 401 |
| Data Migration | Migration jobs list | ❌ fail | 401 | HTTP 401 |
| Data Migration | Deduplication rules | ❌ fail | 401 | HTTP 401 |
| Call Intelligence | Call records list | ❌ fail | 401 | HTTP 401 |
| Call Intelligence | Call analytics | ❌ fail | 401 | HTTP 401 |
| Call Intelligence | QMS Bridge — import catalog & SDR scope | ❌ fail | 401 | HTTP 401 |
| ROI Evaluation | ROI initiatives | ❌ fail | 401 | HTTP 401 |
| ROI Evaluation | ROI analytics | ❌ fail | 401 | HTTP 401 |
| Team Performance | Team members list | ❌ fail | 401 | HTTP 401 |
| Team Performance | Team performance data | ❌ fail | 401 | HTTP 401 |
| Project Portfolio (PMP) | Projects list | ❌ fail | 401 | HTTP 401 |
| System Event Logs | Event logs list | ❌ fail | 401 | HTTP 401 |
| System Event Logs | Logs stats | ❌ fail | 401 | HTTP 401 |
| PDPL Privacy Compliance | PDPL status | ❌ fail | 401 | HTTP 401 |
| PDPL Privacy Compliance | Data inventory | ❌ fail | 401 | HTTP 401 |
| Users & Access Control | User stats | ✅ pass | 401 | — |
| Scorecard | Scorecard snapshot | ❌ fail | 401 | HTTP 401 |
| Duplicate Radar | Duplicates summary | ❌ fail | 401 | HTTP 401 |
| Quality-GRC Handoffs | Handoff rules list | ❌ fail | 401 | HTTP 401 |
| Quality-GRC Handoffs | Handoff summary | ❌ fail | 401 | HTTP 401 |
| Quality Dashboard / Admin | Integrations status | ❌ fail | 401 | HTTP 401 |
| Admin Panel | Workflow runs | ✅ pass | 401 | — |
| KPI Tracking | KPI list | ❌ fail | 401 | HTTP 401 |
| KPI Tracking | KPI summary | ❌ fail | 401 | HTTP 401 |
| Admin Panel | Triggers list | ✅ pass | 401 | — |
| Call Evaluation | MCP import-sources catalog | ❌ fail | 401 | HTTP 401 |
