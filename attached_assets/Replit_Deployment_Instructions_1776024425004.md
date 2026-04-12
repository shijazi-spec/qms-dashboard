# WalaPlus QMS Platform - Deployment Instructions for Replit

## Overview

This document contains ALL code changes that need to be applied to the Replit project. There are **11 new files** to create and **8 existing files** to modify.

Send these instructions to the Replit Agent in batches (it may be too large for one message).

---

## BATCH 1: New Utility Files (create these in src/utils/)

### File 1: src/utils/changeHistoryDatabase.ts (NEW)
Purpose: NC/CAPA change history tracking for audit trail

### File 2: src/utils/exportUtils.ts (NEW)
Purpose: CSV export utility and universal filter builder

### File 3: src/utils/notificationHub.ts (NEW)
Purpose: Unified notification hub with email/Slack delivery

### File 4: src/utils/evidenceDatabase.ts (NEW)
Purpose: Evidence management across all QMS modules

### File 5: src/utils/checklistDatabase.ts (NEW)
Purpose: Compliance checklist engine - create, run, and track checklists

### File 6: src/utils/knowledgeDatabase.ts (NEW)
Purpose: Knowledge base with document ingestion and PostgreSQL full-text search

---

## BATCH 2: New Route Files (create these in src/mastra/routes/)

### File 7: src/mastra/routes/qmsEnhancedRoutes.ts (NEW)
Purpose: CSV exports, bulk operations, approval workflows, evidence management APIs

### File 8: src/mastra/routes/notificationRoutes.ts (NEW)
Purpose: Notification hub + Quality Health Index API

### File 9: src/mastra/routes/knowledgeRoutes.ts (NEW)
Purpose: Knowledge base upload/search + checklist management APIs

---

## BATCH 3: New Tool Files (create these in src/mastra/tools/)

### File 10: src/mastra/tools/checklistTools.ts (NEW)
Purpose: AI tools for running and managing compliance checklists

### File 11: src/mastra/tools/searchKnowledgeTool.ts (NEW)
Purpose: AI tool for searching the knowledge base

---

## BATCH 4: Modifications to Existing Files

### Modification 1: src/mastra/index.ts
Add these imports near the top (after existing route imports):
```typescript
import { qmsEnhancedRoutes } from "./routes/qmsEnhancedRoutes";
import { notificationRoutes } from "./routes/notificationRoutes";
import { knowledgeRoutes } from "./routes/knowledgeRoutes";
```

Add these to the apiRoutes array (near where ...consultantRoutes is):
```typescript
...qmsEnhancedRoutes,
...notificationRoutes,
...knowledgeRoutes,
```

Add logEvent calls to POST /api/qms/capa handler (after createCapaRecord succeeds):
```typescript
try {
  const { logEvent } = await import("../utils/eventLogsDatabase");
  await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(capa.id), entityName: capa.capa_number, description: `CAPA created: ${capa.title}`, module: 'qms', severity: 'INFO' });
} catch {}
```

Add logEvent calls to POST /api/qms/nc handler (after createNonconformance succeeds):
```typescript
try {
  const { logEvent } = await import("../utils/eventLogsDatabase");
  await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(nc.id), entityName: nc.nc_number, description: `Nonconformance created: ${nc.title}`, module: 'qms', severity: 'INFO' });
} catch {}
```

### Modification 2: src/mastra/agents/qmsConsultantAgent.ts
Add imports:
```typescript
import { runChecklistTool, manageChecklistTool } from "../tools/checklistTools";
import { searchKnowledgeTool } from "../tools/searchKnowledgeTool";
```

Add to tools object:
```typescript
runChecklistTool,
manageChecklistTool,
searchKnowledgeTool,
```

Update system prompt to include checklist engine and knowledge base workflow instructions.

### Modification 3: src/mastra/inngest/index.ts
Add KPI auto-calculation cron job before the aiScannerFunction:
- Runs daily at 2 AM (configurable via KPI_AUTO_CALC_CRON)
- Executes all 6 scorecard calculators
- Writes results to kpi_values

### Modification 4: src/utils/qmsDatabase.ts
Add to CapaRecord interface:
```typescript
closure_approved_by?: string;
closure_approved_at?: Date;
effectiveness_result?: 'effective' | 'partially_effective' | 'not_effective' | 'pending';
effectiveness_evidence?: string;
effectiveness_reviewed_by?: string;
effectiveness_reviewed_at?: Date;
```

Add to NonconformanceRecord interface:
```typescript
closure_approved_by?: string;
closure_approved_at?: Date;
investigation_notes?: string;
root_cause?: string;
```

Add functions: approveNCClosure, approveCAPAClosure, recordCAPAEffectiveness, initApprovalWorkflowColumns

### Modification 5: src/utils/riskDatabase.ts
Add to RiskTreatmentAction interface:
```typescript
percent_complete?: number;
milestones?: any;
```

Add ALTER TABLE in initRiskTables():
```sql
ALTER TABLE risk_treatment_actions ADD COLUMN IF NOT EXISTS percent_complete INTEGER DEFAULT 0;
ALTER TABLE risk_treatment_actions ADD COLUMN IF NOT EXISTS milestones JSONB DEFAULT '[]'::jsonb;
```

### Modification 6: scripts/createQMSTables.ts
Add ALTER TABLE statements after CREATE TABLE block for approval workflow columns.

### Modification 7: AI Tool Table Name Fixes
In these files, change SQL table references:
- `FROM nonconformances` → `FROM nonconformance_records`
- `FROM capas` → `FROM capa_records`
- `LEFT JOIN capas c ON c.nc_id` → `LEFT JOIN capa_records c ON c.source_id = n.id::text`

Files to fix:
- src/mastra/tools/queryPlatformDataTool.ts (MODULE_TABLE_MAP values)
- src/mastra/tools/analyzeNonconformitiesTool.ts (4 SQL queries)
- src/mastra/tools/suggestImprovementsTool.ts (2 SQL queries)
- src/mastra/tools/checkRegulationComplianceTool.ts (2 SQL queries)
- src/utils/aiBackgroundScanner.ts (table + JOIN fix)

### Modification 8: dashboard/consultant.html
Add to sidebar (between quick actions and alerts):
- "Checklists" section with dynamic list and "Create Checklist via AI" button
- "Knowledge Base" section with document list and "Upload Document" button
- Document upload modal (title, type, tags, content textarea)
- JavaScript functions: loadChecklists(), loadKnowledgeDocs(), uploadDocument()

### Modification 9: Add logEvent to routes
Add logEvent calls (wrapped in try/catch) to:
- src/mastra/routes/kpiRoutes.ts (5 POST/PUT handlers)
- src/mastra/routes/pdplRoutes.ts (3 POST handlers)
- src/mastra/routes/authRoutes.ts (login callback + 2 logout handlers)

---

## New API Endpoints Summary

After deployment, these new endpoints will be available:

### Exports
- GET /api/qms/nc/export — NC CSV export
- GET /api/qms/capa/export — CAPA CSV export
- GET /api/compliance/export — Compliance obligations CSV
- GET /api/pdpl/export — PDPL inventory CSV
- GET /api/kpis/export — KPI values CSV
- GET /api/vendors/export — Vendor assessments CSV

### Bulk Operations
- POST /api/qms/nc/bulk-update — Bulk NC status update
- POST /api/qms/capa/bulk-update — Bulk CAPA status update

### Approval Workflows
- POST /api/qms/nc/:id/approve-closure — NC closure approval
- POST /api/qms/capa/:id/approve-closure — CAPA closure approval
- POST /api/qms/capa/:id/effectiveness — Record CAPA effectiveness

### Change History
- GET /api/qms/nc/:id/history — NC change history
- GET /api/qms/capa/:id/history — CAPA change history

### Evidence Management
- GET /api/evidence/:entityType/:entityId — Get evidence for entity
- POST /api/evidence — Upload evidence metadata
- DELETE /api/evidence/:id — Delete evidence
- GET /api/evidence-pack — Compile evidence pack
- GET /api/evidence-summary — Evidence summary by type

### Notifications
- GET /api/notifications — List notifications
- GET /api/notifications/count — Unread count
- POST /api/notifications/:id/read — Mark as read
- POST /api/notifications/:id/dismiss — Dismiss

### Quality Health Index
- GET /api/health-index — Composite quality score

### Knowledge Base
- GET /api/knowledge/documents — List documents
- POST /api/knowledge/upload — Upload and ingest document
- GET /api/knowledge/search?q=... — Full-text search
- DELETE /api/knowledge/documents/:id — Delete document

### Checklists
- GET /api/checklists — List checklists
- GET /api/checklists/:id — Checklist detail
- POST /api/checklists/:id/run — Execute checklist
- GET /api/checklists/:id/runs — Run history

---

## New Database Tables

The following tables are auto-created on first use:
1. nc_change_history — NC field change tracking
2. capa_change_history — CAPA field change tracking
3. notifications — Unified notification inbox
4. evidence_records — Structured evidence storage
5. compliance_checklists — Checklist definitions
6. checklist_items — Checklist verification items
7. checklist_runs — Checklist execution results
8. knowledge_documents — Uploaded document metadata
9. knowledge_chunks — Searchable text segments with full-text index
