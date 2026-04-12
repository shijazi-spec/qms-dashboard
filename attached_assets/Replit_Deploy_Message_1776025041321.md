# Send this message to Replit Agent

---

I need you to apply a major enhancement update to the QMS platform. This includes 11 new files and modifications to several existing files. The enhancements add:

1. **Checklist Engine** — Create and run compliance checklists with automated data verification
2. **Knowledge Base** — Upload and search regulatory documents using PostgreSQL full-text search
3. **NC/CAPA Change History** — Audit trail for all field changes
4. **CSV Export APIs** — Export NCs, CAPAs, Compliance, PDPL, KPIs, Vendors as CSV
5. **Bulk Operations** — Bulk status updates for NCs and CAPAs
6. **Approval Workflows** — NC/CAPA closure approval with dual sign-off
7. **CAPA Effectiveness Verification** — Record and track CAPA effectiveness
8. **Evidence Management** — Structured evidence upload/retrieval across all modules
9. **Unified Notification Hub** — Multi-channel notifications (in-app, email, Slack)
10. **Quality Health Index** — Composite quality metric for management review
11. **KPI Auto-Calculation** — Daily Inngest cron for auto-calculating scorecard KPIs
12. **AI Consultant Enhancement** — 3 new tools (checklistTool, manageChecklistTool, searchKnowledgeTool) bringing total to 16

Please create ALL of the following new files with the exact content I'll provide, and apply ALL the modifications to existing files.

## NEW FILES TO CREATE

I'll send the content for each new file in follow-up messages. The 11 new files are:

### src/utils/ (6 files):
1. `src/utils/changeHistoryDatabase.ts`
2. `src/utils/exportUtils.ts`
3. `src/utils/notificationHub.ts`
4. `src/utils/evidenceDatabase.ts`
5. `src/utils/checklistDatabase.ts`
6. `src/utils/knowledgeDatabase.ts`

### src/mastra/routes/ (3 files):
7. `src/mastra/routes/qmsEnhancedRoutes.ts`
8. `src/mastra/routes/notificationRoutes.ts`
9. `src/mastra/routes/knowledgeRoutes.ts`

### src/mastra/tools/ (2 files):
10. `src/mastra/tools/checklistTools.ts`
11. `src/mastra/tools/searchKnowledgeTool.ts`

## MODIFICATIONS TO EXISTING FILES

### 1. src/mastra/index.ts
Add these 3 imports near the top (after existing route imports):
```typescript
import { qmsEnhancedRoutes } from "./routes/qmsEnhancedRoutes";
import { notificationRoutes } from "./routes/notificationRoutes";
import { knowledgeRoutes } from "./routes/knowledgeRoutes";
```

Add these to the apiRoutes array (near where `...consultantRoutes` is):
```typescript
...qmsEnhancedRoutes,
...notificationRoutes,
...knowledgeRoutes,
```

Add logEvent audit trail calls to POST /api/qms/capa handler (after createCapaRecord succeeds):
```typescript
try {
  const { logEvent } = await import("../utils/eventLogsDatabase");
  await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(capa.id), entityName: capa.capa_number, description: `CAPA created: ${capa.title}`, module: 'qms', severity: 'INFO' });
} catch {}
```

Add logEvent audit trail calls to POST /api/qms/nc handler (after createNonconformance succeeds):
```typescript
try {
  const { logEvent } = await import("../utils/eventLogsDatabase");
  await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(nc.id), entityName: nc.nc_number, description: `Nonconformance created: ${nc.title}`, module: 'qms', severity: 'INFO' });
} catch {}
```

### 2. src/mastra/agents/qmsConsultantAgent.ts
Add these imports after the existing tool imports:
```typescript
import { runChecklistTool, manageChecklistTool } from "../tools/checklistTools";
import { searchKnowledgeTool } from "../tools/searchKnowledgeTool";
```

Add these 3 tools to the `tools` object in the agent config:
```typescript
runChecklistTool,
manageChecklistTool,
searchKnowledgeTool,
```

Update the system prompt (instructions) to add after the "### Action Tools" section:

```
### Checklist Engine Tools
14. **runChecklistTool**: Execute compliance checklists against live platform data. Use action="list" to see available checklists, action="run" with a checklistId to execute one and get a scored pass/fail report, or action="history" to see past runs and score trends.
15. **manageChecklistTool**: Create, view, or delete structured compliance checklists. When a user asks you to create a checklist (e.g., "Create an ISO 9001 Clause 10.2 checklist"), build the items with appropriate check_types (count_check, existence_check, threshold_check, data_query, or manual) and module_to_query fields so they can be auto-verified. Available modules: nonconformances, capas, risks, policies, compliance, kpis, training, pdpl, vendors, audits, event_logs.

### Knowledge Base Tools
16. **searchKnowledgeTool**: Search the uploaded regulatory knowledge base. Use action="search" with a query to find relevant clauses, requirements, or guidance from uploaded documents (ISO standards, PDPL law, SOPs). Use action="list" to see all uploaded documents. When answering regulatory questions, ALWAYS search the knowledge base first to provide citations from actual uploaded documents rather than relying solely on training knowledge.
```

Also add these workflow instructions to the system prompt:

```
## CHECKLIST WORKFLOW

When a user asks you to create a compliance checklist:
1. Ask which standard/regulation and which specific area (e.g., "ISO 9001 Clause 10.2 - Nonconformity")
2. Generate checklist items with automated checks where possible:
   - count_check: verify record counts (e.g., "All NCs have assigned owners" -> module=nonconformances, query_config={condition: "detected_by IS NULL", max_count: 0})
   - existence_check: verify records exist (e.g., "PDPL data inventory exists" -> module=pdpl, query_config={should_exist: true})
   - threshold_check: verify averages meet thresholds (e.g., "Audit scores above 80%" -> module=audits, query_config={column: "overall_score", min_threshold: 80})
   - data_query: custom SQL for complex checks
   - manual: items requiring human verification
3. Create the checklist using manageChecklistTool
4. Ask if the user wants to run it immediately

When a user asks to run a checklist:
1. Use runChecklistTool with action="list" to show available checklists
2. Run the selected checklist with action="run"
3. Present results as a structured report with pass/fail per item, overall score, and gap analysis
4. For failed items, provide specific recommendations citing relevant regulation clauses
5. If knowledge base documents are available, use searchKnowledgeTool to cite exact clause text for failed items

## KNOWLEDGE BASE WORKFLOW

When answering questions about regulations or standards:
1. First use searchKnowledgeTool to check if relevant documents have been uploaded
2. If documents exist, cite specific text from the knowledge base in your response
3. If no documents are found, use your training knowledge but recommend uploading the relevant document for precise referencing
```

And add to the PLATFORM CONTEXT section at the end:
```
Additional capabilities:
- Knowledge Base: Upload and search regulatory documents, SOPs, and standards for precise clause referencing
- Checklist Engine: Create and run structured compliance checklists with automated data verification against live platform data
- Evidence Management: Structured evidence upload and retrieval across all modules
- Notification Hub: Unified notifications with email and Slack delivery
- Quality Health Index: Composite quality metric for management review
```

### 3. src/mastra/inngest/index.ts
Add this KPI auto-calculation cron function BEFORE the existing `aiScannerFunction`:

```typescript
const kpiAutoCalcFunction = inngest.createFunction(
  { id: "kpi-auto-calculation" },
  { cron: process.env.KPI_AUTO_CALC_CRON || "0 2 * * *" },
  async ({ step }) => {
    return await step.run("run-kpi-auto-calc", async () => {
      console.log("[KPI Auto] Daily KPI calculation triggered");
      const results: any[] = [];
      try {
        const {
          calculateKPI1_GovernanceDocLifecycle,
          calculateKPI2_ComplianceObligationTracking,
          calculateKPI3_AuditEvidencePackReadiness,
          calculateKPI4_QualityGRCHandoff,
          calculateKPI5_RiskRegisterHygiene,
          calculateKPI6_ExecutiveReportingReadiness,
        } = await import("../../utils/scorecardDatabase");
        const { recordKPIValue, getKPIDefinitions } = await import("../../utils/kpiDatabase");

        const calculators = [
          { name: 'Governance Doc Lifecycle', fn: calculateKPI1_GovernanceDocLifecycle },
          { name: 'Compliance Obligation Tracking', fn: calculateKPI2_ComplianceObligationTracking },
          { name: 'Audit Evidence Pack Readiness', fn: calculateKPI3_AuditEvidencePackReadiness },
          { name: 'Quality→GRC Handoff', fn: calculateKPI4_QualityGRCHandoff },
          { name: 'Risk Register Hygiene', fn: calculateKPI5_RiskRegisterHygiene },
          { name: 'Executive Reporting Readiness', fn: calculateKPI6_ExecutiveReportingReadiness },
        ];

        const kpiDefs = await getKPIDefinitions({});
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        for (const calc of calculators) {
          try {
            const { value } = await calc.fn();
            const matchingKpi = kpiDefs.definitions.find((k: any) =>
              k.name.toLowerCase().includes(calc.name.split(' ')[0].toLowerCase())
            );
            if (matchingKpi) {
              await recordKPIValue({
                kpi_id: matchingKpi.id,
                actual_value: value,
                period_start: periodStart,
                period_end: periodEnd,
                calculated_by: 'system_auto',
                notes: `Auto-calculated by scheduled job`,
              });
            }
            results.push({ kpi: calc.name, value, status: 'recorded' });
          } catch (err) {
            results.push({ kpi: calc.name, error: String(err), status: 'failed' });
          }
        }
      } catch (err) {
        console.error("[KPI Auto] Fatal error:", err);
      }
      console.log("[KPI Auto] Completed:", results);
      return { calculated: results.length, results };
    });
  },
);
inngestFunctions.push(kpiAutoCalcFunction);
```

### 4. src/utils/qmsDatabase.ts
Add to the `CapaRecord` interface:
```typescript
closure_approved_by?: string;
closure_approved_at?: Date;
effectiveness_result?: 'effective' | 'partially_effective' | 'not_effective' | 'pending';
effectiveness_evidence?: string;
effectiveness_reviewed_by?: string;
effectiveness_reviewed_at?: Date;
```

Add to the `NonconformanceRecord` interface:
```typescript
closure_approved_by?: string;
closure_approved_at?: Date;
investigation_notes?: string;
root_cause?: string;
```

Add this function at the end of the file (for schema migration):
```typescript
export async function initApprovalWorkflowColumns(): Promise<void> {
  const statements = [
    `ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS closure_approved_by VARCHAR(255)`,
    `ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS closure_approved_at TIMESTAMP`,
    `ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS investigation_notes TEXT`,
    `ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS root_cause TEXT`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS closure_approved_by VARCHAR(255)`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS closure_approved_at TIMESTAMP`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_result VARCHAR(30)`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_evidence TEXT`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_reviewed_by VARCHAR(255)`,
    `ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_reviewed_at TIMESTAMP`,
  ];
  for (const sql of statements) {
    try { await pool.query(sql); } catch {}
  }
}
```

Add these 3 functions at the end:
```typescript
export async function approveNCClosure(id: number, approvedBy: string): Promise<any> {
  const result = await pool.query(
    `UPDATE nonconformance_records SET status = 'closed', closure_approved_by = $2, closure_approved_at = NOW(), closed_by = $2, closed_date = NOW() WHERE id = $1 AND status != 'closed' RETURNING *`,
    [id, approvedBy]
  );
  return result.rows[0] || null;
}

export async function approveCAPAClosure(id: number, approvedBy: string): Promise<any> {
  const result = await pool.query(
    `UPDATE capa_records SET status = 'closed', closure_approved_by = $2, closure_approved_at = NOW(), completion_date = NOW() WHERE id = $1 AND effectiveness_result IS NOT NULL RETURNING *`,
    [id, approvedBy]
  );
  return result.rows[0] || null;
}

export async function recordCAPAEffectiveness(id: number, effectivenessResult: string, evidence: string, reviewedBy: string): Promise<any> {
  const result = await pool.query(
    `UPDATE capa_records SET effectiveness_result = $2, effectiveness_evidence = $3, effectiveness_reviewed_by = $4, effectiveness_reviewed_at = NOW() WHERE id = $1 RETURNING *`,
    [id, effectivenessResult, evidence, reviewedBy]
  );
  return result.rows[0] || null;
}
```

### 5. src/utils/riskDatabase.ts
Add to the `RiskTreatmentAction` interface:
```typescript
percent_complete?: number;
milestones?: any;
```

Add to `initRiskTables()` function (after existing ALTER TABLE statements):
```typescript
await pool.query(`ALTER TABLE risk_treatment_actions ADD COLUMN IF NOT EXISTS percent_complete INTEGER DEFAULT 0`);
await pool.query(`ALTER TABLE risk_treatment_actions ADD COLUMN IF NOT EXISTS milestones JSONB DEFAULT '[]'::jsonb`);
```

### 6. AI Tool Table Name Fixes (CRITICAL)

In the following files, make sure SQL references use the correct table names:

**src/mastra/tools/queryPlatformDataTool.ts**: In the MODULE_TABLE_MAP, ensure:
- `nonconformances` maps to table `'nonconformance_records'`
- `capas` maps to table `'capa_records'`

**src/mastra/tools/analyzeNonconformitiesTool.ts**: Ensure all SQL queries use `FROM nonconformance_records` (NOT `FROM nonconformances`) and `FROM capa_records` (NOT `FROM capas`)

**src/mastra/tools/suggestImprovementsTool.ts**: Ensure SQL queries use `FROM nonconformance_records` (NOT `FROM nonconformances`)

**src/mastra/tools/checkRegulationComplianceTool.ts**: Ensure SQL queries use `FROM nonconformance_records` and `FROM capa_records`

**src/utils/aiBackgroundScanner.ts**: Ensure the query uses:
```sql
FROM nonconformance_records n
LEFT JOIN capa_records c ON c.source_id = n.id::text
```
(NOT `LEFT JOIN capa_records c ON c.nc_id = n.id`)

### 7. dashboard/consultant.html
Add to the sidebar (between the existing Quick Actions and Alerts sections):

**Checklists section:**
```html
<div class="px-4 mb-4">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Checklists</h3>
    <div id="checklists-list" class="space-y-1 text-xs text-gray-300 mb-2">Loading...</div>
    <button onclick="sendMessage('List all available compliance checklists')" class="w-full text-left text-xs px-2 py-1 rounded bg-indigo-900/30 text-indigo-300 hover:bg-indigo-900/50">+ Create Checklist via AI</button>
</div>
```

**Knowledge Base section:**
```html
<div class="px-4 mb-4">
    <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Knowledge Base</h3>
    <div id="knowledge-list" class="space-y-1 text-xs text-gray-300 mb-2">Loading...</div>
    <button onclick="showUploadModal()" class="w-full text-left text-xs px-2 py-1 rounded bg-green-900/30 text-green-300 hover:bg-green-900/50">+ Upload Document</button>
</div>
```

**Document upload modal** (add before closing body tag):
```html
<div id="upload-modal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
    <div class="bg-gray-800 rounded-xl p-6 w-full max-w-lg mx-4">
        <h3 class="text-lg font-semibold text-white mb-4">Upload Document to Knowledge Base</h3>
        <div class="space-y-3">
            <input id="doc-title" type="text" placeholder="Document Title" class="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm">
            <select id="doc-type" class="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm">
                <option value="regulation">Regulation</option>
                <option value="standard">Standard</option>
                <option value="sop">SOP</option>
                <option value="policy">Policy</option>
                <option value="guideline">Guideline</option>
                <option value="other">Other</option>
            </select>
            <input id="doc-tags" type="text" placeholder="Tags (comma-separated)" class="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm">
            <textarea id="doc-content" rows="10" placeholder="Paste document content here..." class="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm"></textarea>
        </div>
        <div class="flex justify-end gap-2 mt-4">
            <button onclick="hideUploadModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white">Cancel</button>
            <button onclick="uploadDocument()" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">Upload</button>
        </div>
    </div>
</div>
```

**JavaScript functions** (add to the script section):
```javascript
function showUploadModal() { document.getElementById('upload-modal').classList.remove('hidden'); }
function hideUploadModal() { document.getElementById('upload-modal').classList.add('hidden'); }

async function loadChecklists() {
    try {
        const res = await fetch('/api/checklists');
        const data = await res.json();
        const list = document.getElementById('checklists-list');
        if (data.checklists && data.checklists.length > 0) {
            list.innerHTML = data.checklists.map(c => `<div class="truncate cursor-pointer hover:text-indigo-300" onclick="sendMessage('Run checklist #${c.id}: ${c.name}')">${c.name} <span class="text-gray-500">(${c.standard})</span></div>`).join('');
        } else {
            list.innerHTML = '<div class="text-gray-500">No checklists yet</div>';
        }
    } catch { document.getElementById('checklists-list').innerHTML = '<div class="text-gray-500">No checklists yet</div>'; }
}

async function loadKnowledgeDocs() {
    try {
        const res = await fetch('/api/knowledge/documents');
        const data = await res.json();
        const list = document.getElementById('knowledge-list');
        if (data.documents && data.documents.length > 0) {
            list.innerHTML = data.documents.map(d => `<div class="truncate" title="${d.title}">${d.title} <span class="text-gray-500">(${d.document_type})</span></div>`).join('');
        } else {
            list.innerHTML = '<div class="text-gray-500">No documents yet</div>';
        }
    } catch { document.getElementById('knowledge-list').innerHTML = '<div class="text-gray-500">No documents yet</div>'; }
}

async function uploadDocument() {
    const title = document.getElementById('doc-title').value;
    const type = document.getElementById('doc-type').value;
    const tags = document.getElementById('doc-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    const content = document.getElementById('doc-content').value;
    if (!title || !content) { alert('Title and content are required'); return; }
    try {
        const res = await fetch('/api/knowledge/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, documentType: type, tags, content }),
        });
        const data = await res.json();
        if (data.success) {
            hideUploadModal();
            loadKnowledgeDocs();
            sendMessage(`I just uploaded "${title}" to the knowledge base. Please confirm it's searchable.`);
        } else { alert(data.error || 'Upload failed'); }
    } catch (err) { alert('Upload failed: ' + err.message); }
}

// Load checklists and knowledge docs on page load
loadChecklists();
loadKnowledgeDocs();
```

### 8. Add logEvent audit trail to route files

**src/mastra/routes/kpiRoutes.ts**: Add `logEvent()` calls (wrapped in try/catch) to all POST and PUT handlers that create or update KPI data.

**src/mastra/routes/pdplRoutes.ts**: Add `logEvent()` calls to POST handlers that create PDPL records.

**src/mastra/routes/authRoutes.ts**: Add `logEvent()` calls to the login callback and logout handlers.

The pattern for all logEvent calls is:
```typescript
try {
  const { logEvent } = await import("../../utils/eventLogsDatabase");
  await logEvent({ actionType: 'CREATE', entityType: 'TYPE', entityId: String(id), description: 'Description', module: 'module_name', severity: 'INFO' });
} catch {}
```

---

After applying all changes, restart the application to initialize all new database tables automatically.
