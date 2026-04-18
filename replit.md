# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. Built with Mastra (AI agent framework), Hono for HTTP, PostgreSQL, and Inngest for workflow orchestration. Serves HTML dashboards on port 5000 via Mastra dev server, designed for Autoscale deployment.

## Architecture
- **Framework**: Mastra (AI agent framework) with Hono HTTP server
- **Frontend**: Static HTML dashboards served from `dashboard/` directory
- **Backend**: Mastra API routes with Hono handlers
- **Database**: PostgreSQL (103+ tables across 21 module groups) via `pg` module
- **AI**: GPT-4o via Replit AI Integrations / OpenAI
- **Workflows**: Inngest for event-driven workflow orchestration
- **Auth**: Replit OIDC (`authRoutes.ts`) with HMAC-SHA256 signed session cookie (`walaplus_session`, 7-day expiry). Supports Google, GitHub, Apple, email login. Admin API key via `X-Admin-Key` header.
- **Security**: Nonce-based CSP, tiered rate limiting (100/10/5/10 per min), input sanitization, RBAC with 11 unified roles, UUID resource ID obfuscation
- **Email**: Resend for outgoing emails

## Project Structure
- `src/mastra/index.ts` - Main Mastra configuration (agents, tools, routes, server config, auth middleware)
- `src/mastra/agents/` - AI agent definitions
- `src/mastra/tools/` - AI tool definitions (callAnalysis, capaManagement, crmCompliance, consultant tools: queryPlatformData, analyzeNonconformities, suggestImprovements, checkRegulationCompliance, monitorKPIs, monitorRisks, createAlert, reviewDocument, searchKnowledge, checklistTools [runChecklist, manageChecklist], ncManagement, capaManagement)
- `src/mastra/workflows/` - Mastra workflow definitions
- `src/mastra/routes/authRoutes.ts` - Replit Auth (OIDC) routes and session management
- `src/data/` - Data layer (real Zoho CRM integration only, no mock data)
- `src/mastra/storage/` - Storage configuration
- `src/utils/` - Database utilities (audit, compliance, KPI, risk, policy, vendor, etc.) and security utilities:
  - `rbacMiddleware.ts` - RBAC enforcement, route permission map, `getSessionUser()`
  - `rbacDatabase.ts` - Role definitions (11 unified roles), permission CRUD
  - `userAccessDatabase.ts` - User invitations, platform users, screen permissions
  - `rateLimiter.ts` - Tiered rate limiting (100/10/5/10 + unauth 10/3)
  - `inputSanitizer.ts` - XSS/injection prevention, field whitelisting, password policy
  - `riskDatabase.ts` - Risk management + UUID obfuscation helpers
  - `aiAlertsDatabase.ts` - AI alerts table CRUD, dedup, unread count; 11 alert types including `sla_breach`
  - `aiBackgroundScanner.ts` - 14-check background scanner (KPIs, risks, NCs, policies, PDPL, audits, training, Sales SLA, SDR SLA, high-confidence duplicates, auto-NC from critical SLA breaches, CAPA recurrence detection)
  - `duplicateRadarDatabase.ts` - Multi-signal duplicate detection (email 40pts + domain 25pts + phone 30pts + company 20pts + mobile 25pts + CR# 35pts + VAT# 30pts + website 20pts), cross-module clustering (Leads/Contacts/Deals/Accounts), upsert with ON CONFLICT (incremental scan via DUPLICATE_SCAN_MODE env), pg_trgm + GIN index for fuzzy company match, JOIN-based queries (no N+1), phone_normalized + mobile_normalized computed atomically, RAG owner accountability (green ≤2% / amber 2-5% / red >5%), auto-resolve engine, smart AI recommendations, enhanced summary with resolution rate + top signals + top clusters by inflation, zoho_sync_state table for per-module sync tracking, duplicate_record_tasks table for Zoho Tasks, advanced filtering (module/owner/layout/pipeline/domain/confidence/date), 20+ enriched fields (layout, pipeline, products, CR#, VAT#, website, country, region, industry, title, lead_type, gov_type, account_type)
  - `knowledgeDatabase.ts` - Knowledge base document storage, chunk-based full-text search
  - `checklistDatabase.ts` - Compliance checklist engine with automated verification
  - `evidenceDatabase.ts` - Evidence/document management across QMS modules
  - `fileUpload.ts` - Document file upload/download/validation (PDF, DOCX, XLSX, PPTX, PNG, JPG; max 25MB)
  - `executiveDigest.ts` - Weekly quality digest email (NC/CAPA/risk/audit/KPI/compliance summary, HTML email via Resend or Replit Mail)
  - `analyticsEngine.ts` - Cycle time metrics (NC/CAPA/risk/policy), agent compliance reports, CAPA recurrence detection, trend data
  - `managementReviewDatabase.ts` - ISO 9001 Clause 9.3 management review CRUD, action items, auto-gather QMS inputs
  - `notificationHub.ts` - Unified notification routing (email, Slack, in-app)
  - `exportUtils.ts` - CSV export utilities
  - `changeHistoryDatabase.ts` - NC/CAPA change history audit trail
- `src/mastra/routes/consultantRoutes.ts` - AI Consultant API endpoints (chat, stream, alerts, scan)
- `src/mastra/routes/qmsEnhancedRoutes.ts` - Evidence management, CSV exports, bulk updates, change history, closure approval, CAPA effectiveness
- `src/mastra/routes/knowledgeRoutes.ts` - Knowledge base CRUD, search, checklist endpoints
- `src/mastra/routes/managementReviewRoutes.ts` - Management review CRUD, action items, gather inputs
- `src/mastra/routes/analyticsRoutes.ts` - Cycle times, agent compliance, CAPA recurrence, trends, executive digest
- `src/mastra/routes/notificationRoutes.ts` - Notifications, health index endpoints
- `src/triggers/` - Cron, Slack, Telegram triggers
- `dashboard/` - Static HTML dashboards (index.html, audits.html, login.html, etc.)
- `dashboard/css/` - Shared navigation CSS
- `dashboard/js/` - Shared navigation JS (includes user avatar/logout in nav bar, AI alert dropdown inbox with severity badges and timeAgo)
- `scripts/` - Build and inngest scripts
- `docs/mastra/` - Mastra documentation
- `tests/` - Test files

## Dashboards
- `/` - Main Quality Dashboard
- `/executive` - Executive Dashboard (Quality Health Index with 5 dimension progress bars, AI insights)
- `/grc` - GRC Control Tower
- `/admin` - Admin Panel (requires ADMIN_API_KEY)
- `/qms` - QMS Dashboard (CAPA detail modals, bulk close, effectiveness checks, CSV export, approval flows)
- `/audits` - Audit Readiness
- `/compliance` - Compliance Tracking (status filter, CSV export, gap analysis, PDPL 18 obligations seeded, dashboard stats)
- `/risks` - Risk Register (date filters, treatment progress bars, milestones, CSV export)
- `/policies` - Integrated QMS (Policies, Procedures, Work Instructions, SOPs, Forms, Templates — with document type filter, CSV export, file upload/download, confidentiality levels, tags)
- `/vendors` - Vendor Risk Management (CSV export)
- `/calls` - Call Intelligence
- `/roi` - ROI & NPV Evaluation
- `/team` - Team Performance
- `/projects` - PMP Project Portfolio
- `/logs` - System Event Logs
- `/pdpl` - PDPL Privacy Compliance (CSV export)
- `/users` - Users & Access Control
- `/consultant` - AI Consultant & Assistant (chat interface with 23 AI tools, SSE streaming, alerts modal, file upload)
- `/kpis` - KPI Tracking (status filter, CSV export, auto-calc timestamp)
- `/scorecard` - Scorecard
- `/duplicates` - Duplicate Radar (SSE scan stream, side-by-side comparison modal, RAG owner accountability, paginated clusters/records, auto-resolve, smart AI recommendations, KPI gauge)
- `/reviews` - Management Review (ISO 9001 Clause 9.3, action tracking, auto-gather QMS inputs)
- `/migration` - Data Migration
- `/crm` - CRM Data Hub (live enrichment via `runLiveQualityCheck()`/`assessDataQuality()` with additive penalty scoring, duplicate cluster cross-reference via `lookupRecordsByZohoIds()` with `ANY($1)`, 4-tier quality badges [good >=85, fair 50-84, poor 21-49, junk <=20], `isGibberishName()`/`isSuspiciousEmail()` junk detection, health summary bar, row-click detail modal with quality flags + cluster cards, hygiene warnings, cluster badges linking to Duplicate Radar, parallel enrichment via `Promise.all()`)
- `/feedback` - Feedback
- `/onboarding` - Onboarding
- `/sop` - Platform SOP (rendered markdown with TOC sidebar, print/download, public access)
- `/tablef` - Table F Governance

## Running
- `npm run dev` runs `mastra dev` which starts the Hono server on port 5000
- Inngest dev server runs on port 3000

## Authentication & Security
- **Replit Auth (OIDC)**: Primary login method via Replit's OpenID Connect provider on `/login`. Supports Google, GitHub, Apple, and email sign-in.
- **Session**: HMAC-signed cookies using `SESSION_SECRET`, 7-day expiry, HttpOnly/Secure/SameSite=Lax flags
- **Routes**: `GET /api/login` (initiate OIDC), `GET /api/callback` (OIDC callback), `GET /api/auth/me` (session check), `POST /api/auth/logout` (clear cookie), `GET /api/logout` (clear cookie + OIDC end session)
- **Protection**: All dashboard pages AND API endpoints require valid session. Public pages: `/login`, `/guide`, `/accept-invite`
- **RBAC**: Centralized ROUTE_PERMISSION_MAP in rbacMiddleware.ts enforces per-endpoint role/permission checks globally; roles: admin, grc_manager, quality_manager, ai_specialist, bu_owner, executive, department_viewer
- **API auth**: All API endpoints require session cookie or X-Admin-Key header (401 if neither present)
- **CORS**: Restricted to app domain only (no wildcard), derived from REPLIT_DOMAINS
- **Security headers**: CSP with per-request nonce (no unsafe-inline/unsafe-eval for scripts, frame-ancestors 'none'), X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, X-XSS-Protection, Permissions-Policy
- **Input sanitization**: HTML/script tag stripping, CSV formula injection prevention, prototype pollution protection, field-level max-length enforcement
- **Rate limiting**: Authenticated: 100 req/min read, 10 req/min write; Unauthenticated: 10 req/min read, 3 req/min write; Auth paths: 5 req/min; Export: 10 req/min (all per IP)
- **Endpoint enumeration prevention**: Non-existing protected API routes return generic 403 instead of 404
- **Resource ID obfuscation**: UUID `public_id` columns on enterprise_risks, risk_treatment_actions, vendors, policies, audits, regulations, obligations, compliance_assessments, team_feedback tables (auto-generated, backfilled); risk routes accept UUID lookups
- **Password policy**: 12+ chars, uppercase, lowercase, number, special character (enforced on invitation acceptance)
- **Error handling**: All error responses return generic messages; no raw error.message exposure
- **ROI validation**: Financial field validation (non-negative, max value, type checking)
- **Invitation deduplication**: Prevents duplicate pending invitations for same email
- **OAuth CSRF**: State parameter + PKCE code verifier validated in OIDC callback
- **User storage**: OIDC users upserted into `platform_users` table with google_id (stores OIDC sub), picture, auth_provider columns
- **Admin key**: Works as alternative auth for API endpoints and admin-only routes
- **Security utilities**: `src/utils/inputSanitizer.ts` (sanitization, validation, CSV escaping, password policy), `src/utils/rateLimiter.ts` (path-aware rate limiting), `src/utils/rbacMiddleware.ts` (RBAC enforcement)

## Key Secrets
- `DATABASE_URL` - PostgreSQL connection string
- `REPL_ID` - Replit OIDC client ID (auto-provided by Replit)
- `SESSION_SECRET` - Session cookie signing
- `ADMIN_API_KEY` - Admin panel access
- `RESEND_API_KEY` - Email sending via Resend
- `RESEND_FROM_EMAIL` - From address for emails
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` - Zoho CRM OAuth (read-only production access)
- `ZOHO_ACCOUNTS_URL` - Zoho OAuth endpoint (default: https://accounts.zoho.com)
- `ZOHO_API_DOMAIN` - Zoho API domain (default: https://www.zohoapis.com)
- `AI_INTEGRATIONS_OPENAI_API_KEY` - Replit-managed OpenAI key (preferred for AI Consultant)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` - Replit AI proxy base URL
- `OPENAI_API_KEY` - Direct OpenAI API key (fallback)
- `SLACK_BOT_TOKEN` - Slack Bot token for notifications
- `SLACK_CHANNEL_ID` - Slack channel ID for QMS alerts

## Database Setup
- Tables are auto-initialized by utility modules on first use (auditDatabase.ts, complianceDatabase.ts, kpiDatabase.ts, riskDatabase.ts, policyDatabase.ts, vendorDatabase.ts)
- Additional QMS tables created via `npx tsx scripts/createQMSTables.ts`
- Core tables: quality_scorecards, quality_audit_results, quality_trends, governance_documents + 30+ others
- governance_documents stores SOPs linked to CRM modules: Sales SOP (Deals/Sales team) v1.1 and SDR SOP (Leads/SDR team) v2.1, with structured rules_json containing SLAs, KPIs, stage definitions, and qualification criteria used by AI audit agents
- Data populates through platform usage (call evaluations, audits, governance document uploads)

## AI Consultant Feature
- **Agent**: `qmsConsultantAgent.ts` - GPT-4o powered QMS consultant with 23 tools, registered in Mastra agents config with @mastra/memory for conversation threading. Uses `generateLegacy()`/`streamLegacy()` with `openai.chat("gpt-4o")` via `@ai-sdk/openai` v1.3.24 (NOT v3.x).
- **Tools**: queryPlatformData, analyzeNonconformities, suggestImprovements, checkRegulationCompliance, monitorKPIs, monitorRisks, createAlert (supports sla_breach), reviewDocument, searchKnowledge, runChecklist, manageChecklist, createNc, getNcList, createCapa, updateCapa, getCapaList, getCapaDetails, addCapaAction, createTraining, getTrainingList, assignTraining, getTrainingAssignments, completeTraining
- **Background Scanner**: `aiBackgroundScanner.ts` - 14 parallelized checks running every 6 hours via Inngest, `createAlertIfNew` dedup, `errors[]` in ScanResult
- **KPI Auto-Calculation**: Daily cron (2 AM UTC, configurable via KPI_AUTO_CALC_CRON) runs 6 scorecard KPI calculators and records values automatically
- **Audit Trail**: `logEvent()` calls on all POST/PUT handlers across index.ts (NC/CAPA create), kpiRoutes (KPI create/update/value/report), pdplRoutes (inventory/DSAR/incidents/guardrails CRUD), authRoutes (logout)
- **Alerts Database**: `aiAlertsDatabase.ts` - ai_alerts table with CRUD, dedup, severity-ordered queries
- **Knowledge Base**: Upload regulatory documents (ISO, PDPL, SOPs), auto-chunked for full-text search, cited in AI responses
- **Checklist Engine**: Create/run structured compliance checklists with automated data verification (count_check, existence_check, threshold_check, data_query, manual)
- **Evidence Management**: Structured evidence upload/retrieval across NC, CAPA, compliance, risk, audit, policy modules
- **Change History**: Immutable audit trail for NC and CAPA field changes
- **Closure Workflow**: NC closure approval, CAPA effectiveness recording + closure approval
- **CSV Exports**: NCs, CAPAs, compliance, PDPL, KPIs, vendors
- **Routes**: consultantRoutes (chat, stream, alerts, scan), qmsEnhancedRoutes (evidence, exports, bulk ops, history, closures), knowledgeRoutes (docs, search, checklists), notificationRoutes (notifications, health index)
- **Shared Pool**: `src/utils/sharedPool.ts` - Single shared pg.Pool (max:20) used by all tools instead of per-file pools
- **Frontend**: `dashboard/consultant.html` - Full chat interface with XSS-safe renderMarkdown (placeholder tokens for code/tables), streaming SSE, chat history (localStorage), file upload, alert action buttons (ack/resolve/dismiss), alerts modal, scan progress bar, retry button, export chat as Markdown, Arabic RTL detection, touch swipe gestures, severity icons, relative time, welcome dashboard with KPI summary
- **Routes**: `consultantRoutes.ts` - Auth guards on all endpoints (session or X-Admin-Key), AbortController timeouts (120s chat / 300s scan via env vars), SSE endpoints for chat stream and scan-stream, file upload
- **Navigation**: Alert bell in nav bar polls `/api/consultant/alerts/count` every 60s, links to `/consultant`

## Recent Changes
- Native XLSX exports (Apr 18, 2026): Put the previously-unused `exceljs` dependency to work with three multi-sheet Excel exports. New shared utility `src/utils/excelExport.ts` (`buildWorkbook(sheets, meta)` + `xlsxResponseHeaders`) handles styled headers, frozen first row, auto-width, and de-duplicated sheet names (≤31 chars, no `\/?*[]:`). Three new endpoints: (1) `GET /api/audits/:id/export-xlsx` in `auditRoutes.ts` — Summary + Findings sheets, accepts both UUID (GRC `audits` table) and numeric IDs; (2) `GET /api/duplicates/export-xlsx` in `duplicateRadarRoutes.ts` — Summary + per-record-type sheets (Leads/Deals/Contacts/Accounts), strips the heavy `raw_data` JSONB blob in-memory before serialisation, optional `?include_raw=1` adds an "All Records" sheet; (3) `GET /api/kpis/export-xlsx` in `qmsEnhancedRoutes.ts` — Summary + one sheet per category (ai/audit/compliance/governance/individual/process/quality/risk/training/vendor) + All Values sheet, capped at 50K values defensively. Dashboard buttons added: emerald "Excel" buttons on `dashboard/duplicates.html` and `dashboard/kpis.html` next to the existing CSV buttons; emerald "XLSX" link in the actions column of `dashboard/audits.html` next to the PDF link. Verified live: audit XLSX 8KB/0.3s, duplicates XLSX 3.2MB/6.7s (39,856 rows across 4 module sheets), KPI XLSX 20KB/0.03s — all return correct `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` MIME and parse cleanly with exceljs.
- Module-specific governance + UI cleanup (Apr 18, 2026): Authored realistic per-module governance documents to replace the over-strict default ruleset that was firing `missing_required_field` on 100% of Leads/Deals/Accounts. Updated 2 existing docs and inserted 2 new ones via `governance_documents.rules_json`: SDR Process SOP (Leads, 6 rules — Owner/Last_Name/Lead_Source/Lead_Status + status enum + email format), Sales Management Process SOP (Deals, 8 rules — Owner/Deal_Name/Stage/Amount/Closing_Date/Account_Name + stage enum + On_Hold_Reason conditional), Account Master Data SOP (Accounts, 4 rules — Owner/Account_Name/Industry/Phone), Contact Master Data SOP (Contacts, 5 rules — Owner/Last_Name/Email + email format/Account_Name). All `is_active=true`. The audit engine in `src/utils/directAuditRunner.ts`, `src/mastra/workflows/qualityAuditWorkflow.ts`, and `src/mastra/tools/zohoCRMTool.ts` already read these via `getGovernanceDocumentByModule()` and prefer them over `DEFAULT_GOVERNANCE_RULES`. Verified Audit #25: total issues dropped 84% (844,752 → 131,035) on the same 180,945-record dataset. Tuned rules can be edited from the policies dashboard going forward. — Cosmetic: (1) Replaced the `cdn.tailwindcss.com` script tag in all 32 dashboard HTML files with a compiled local `tailwind.css` (620KB minified). Installed `tailwindcss@3` as a dev dependency, added `tailwind.config.js` (scans `dashboard/**/*.html` + `src/**/*` with a generous safelist for color/spacing/grid utilities) and `dashboard/tailwind.input.css` (`@tailwind base/components/utilities`). New route `/dashboard/tailwind.css` in `src/mastra/index.ts` (~line 1473) serves the compiled file with `text/css` content-type and 1h cache; added to auth public-paths list (line 227). Silences the "should not be used in production" console warning. To rebuild: `npx tailwindcss -c tailwind.config.js -i dashboard/tailwind.input.css -o dashboard/tailwind.css --minify`. (2) Wrapped the admin-key input in `dashboard/login.html` in a `<form id="admin-key-form" autocomplete="on" onsubmit="event.preventDefault(); loginWithAdminKey();">` with `autocomplete="current-password"` and a `name` attribute on the input. Removed the standalone `keydown` listener (form submit handles Enter natively). Silences both the "Password field is not contained in a form" and "Password forms should have username fields" browser warnings.
- Compliance % unfreeze (Apr 18, 2026): Compliance was effectively constant at ~99.5% because `raw_audit_data.recordCountsByModule` was being saved as `{Leads: null, Deals: null, ...}`. Root cause: the helper `analyzeRecordBatch` in `src/utils/directAuditRunner.ts` declared `recordsWithIssues: number` in its return type but the actual `return { issueCount, critical, high, medium, low }` literal omitted that property. Caller did `moduleRecordsWithIssues += batchResult.recordsWithIssues` → `+= undefined` → NaN → JSON.stringify saved as `null`. Fixed the return to include `recordsWithIssues`. Added matching `recordsWithIssues` tracking to the two backup paths so dashboard compliance still works if the inngest workflow path runs instead: `src/mastra/workflows/qualityAuditWorkflow.ts` (direct CRM step + raw_audit_data save site) and `src/mastra/tools/zohoCRMTool.ts` (auditCRMHygieneTool moduleBreakdown). Also added a 6h Inngest cron `quality-audit-auto-run` plus in-process fallback `runQualityAuditIfStale(6h)` so audits refresh automatically. Added `/api/dashboard/quality-trend` endpoint and a Data Quality Trend tile (4 stat cards + dual-axis Chart.js) on the main dashboard sourced from `quality_audit_results` + `duplicate_detection_logs`. Latest audit (id=24): 180,944 records audited, 140,648 with issues across modules — compliance now ~22.3% and will move with real CRM hygiene changes. *(Audits saved before this fix retain `null` per-module counts; the trend tile shows them as 0 records-with-issues for those rows until they age out of the 30-day window.)*
- Audit drill-down fairness fix — both audit paths (Apr 18, 2026): Two related issues caused the per-module drill-down to show only synthetic `summary_*` rows for every module except Leads. (1) `directAuditRunner.ts` (inngest-failure fallback) used a single global cap of 500 detailed per-record issues; Leads saturated it first, leaving zero entries for Deals/Contacts/Tasks/Accounts. Replaced with a per-module cap (`MAX_DETAILED_PER_MODULE = 200`) tracked via a `Map<string, number>`. (2) `qualityAuditWorkflow.ts` (the primary inngest cron + manual-trigger path) already had a per-module sampler, but its `detailedIssues` mapping omitted `layouts`, `products`, `createdBy`, `createdTime` — so even the rows that did render showed `-` in those columns. Now extracts those fields per-record (matching `runDirectAudit` shape exactly). All future audits — weekly cron, manual button, or direct fallback — will populate full per-record data for every module. (Audits saved before this fix retain the old truncated data; re-run the audit to refresh.)
- HITL AI Approval Gate (Apr 18, 2026): New module enforces human review on every AI-initiated write, aligned with controlled doc WP-DOC-005 + PDPL Article 26. New utilities: `aiApprovalDatabase.ts` (atomic `claimForApproval`, `expireStale`), `aiToolGovernance.ts` (RISK_BY_TOOL + APPROVER_ROLES_BY_RISK matrix), `withApprovalGate.ts` (AsyncLocalStorage-based wrapper that intercepts write-tools and queues high-risk actions), `controlledDocumentRegistry.ts` (seeds 147 controlled docs into `policies` table on boot). New REST API at `/api/ai/approvals` (list / get / approve / reject / pending-count) with role-based filtering and segregation-of-duties (cannot approve own request). New admin queue UI at `/ai-approvals.html`. `qmsConsultantAgent` write-tools wrapped; read-tools pass through. New Inngest cron `ai-approval-expiry` (15-min) auto-expires stale tickets. `consultantRoutes` routes session user through `withAgentUserContext` for attribution. Bootstrap log signature: `[ControlledDocSeeder] Inserted 147 coded documents`, `[AIApproval] ai_pending_actions table ready`, `[AI-Approval] Bootstrap complete`. SOP bumped to v4.5.
- AI Consultant 27-item enhancement (Apr 2026): Phase 1 Bugs — A1: XSS-safe renderMarkdown with placeholder tokens for code/tables; A2: sla_breach added to createAlertTool enum; A3: 9 `if(true)` scanner bugs → createAlertIfNew return; A4: Auto-NC status `'active'` → `IN ('open','acknowledged')`; A5: KPI join `kpi_definition_id` → `kpi_id`; A6: monitorRisksTool `rta.description` → `rta.action_description`; A7: Dead `checkAgainst` param removed; A8: Scan prompt revised (report-only, no force-create). Phase 2 Performance — B1: sharedPool.ts (single pg.Pool max:20); B2: AbortController timeouts (120s/300s); B3: Parallelized 13 scanner checks; B4: safeQuery logging + errors[]. Phase 3 Features — C1: Alert action buttons + modal; C2: Chat history (localStorage); C3: File upload endpoint; C4: Clickable knowledge docs; C5: Citation CSS; C6: Scan SSE progress bar; C7: 23 tools on agent (added updateCapa, addCapaAction, 5 training tools); C8: Auth guards on all endpoints; C9: Welcome dashboard. Phase 4 UI — D1: Consolidated polling; D2: Touch swipe + sticky input; D3: Severity icons + relative time; D4: Retry button; D5: Export chat; D6: Arabic RTL.
- Duplicate Radar 21-item enhancement (Apr 2026): Phase 1 Bug Fixes — A1: upsertRecord() with ON CONFLICT replaces destructive clear, DUPLICATE_SCAN_MODE env (incremental/full), markStaleRecords/cleanupOrphanClusters; A2: getEnhancedSummary() low_confidence only for clusters with total_records>1, added singletonCount/resolutionRate; A3: Fixed searchDuplicates() paramIndex bug for company_name; A6: RBAC on DELETE /api/duplicates/mock-data; A7: phone_normalized computed atomically in INSERT. Phase 2 Performance — B2: upsertRecord with phone_normalized; B3: Parallel module fetch via Promise.all(); B4: pg_trgm + GIN index, similarity() SQL; B5: JOIN-based getDuplicateRecordsByType() and getExportRecords(); B6: Indexes on zoho_record_id, email, phone_normalized, domain. Phase 3 Features — C1: SSE endpoint /api/duplicates/scan-stream; C2: /api/duplicates/contacts endpoint; C3: Owner accountability with RAG status (green ≤2%, amber 2-5%, red >5%); C4: Server-side pagination (30/page clusters, 50/page records); C5: Auto-resolve engine POST /api/duplicates/auto-resolve; C6: Date range filters on all endpoints; C7: Smart AI recommendations with multi-factor scoring. Phase 4 UI/UX — D1: Animated progress bar with module status chips; D2: Cluster modal with side-by-side comparison, AI recommendations, Zoho links, resolve/ignore actions; D4: Executive Summary with resolution rate, KPI gauge vs 2% target, top signals, top clusters by inflation, last scan info; D5: Removed Generate Test Data button from production UI.
- Quality Dashboard fixes (Apr 2026): Switched DATA_MODE to REAL for live Zoho CRM data in agent performance. Added data-driven recommendations API (`/api/audit/recommendations`) that generates insights from actual audit findings (replaces static text). Agent performance now uses 5000-record limit with 10-minute server-side cache for fast subsequent loads. Dashboard retry logic (3 retries with 10s delay) handles slow initial CRM data fetch. Active Framework shows meaningful defaults when no governance doc configured. View All Issues modal falls back to `issues_by_category` data for older audits without `all_issues` in raw_audit_data. Renamed "Agent Performance" → "CRM Owner Data Quality" for clarity.
- Agentic AI update (Apr 2026): Expanded QMS Consultant to 16 tools (added searchKnowledge, runChecklist, manageChecklist, NC/CAPA CRUD). Added knowledge base (document upload, chunking, full-text search), compliance checklist engine (automated verification), evidence management, change history, notification hub, CSV exports, NC/CAPA closure workflow with approval/effectiveness tracking. Agent registered in Mastra config with @mastra/memory. Fixed table names: nonconformances→nonconformance_records, capas→capa_records throughout tools/scanner. Added ALTER TABLE columns for closure_approved_by/at, effectiveness_result/evidence/reviewed_by/at, percent_complete/milestones. Model uses `openai.responses("gpt-4o")` via `@ai-sdk/openai` with Replit AI proxy. Added KPI auto-calculation cron (daily 2AM, 6 scorecard KPIs). Added logEvent audit trail to NC/CAPA create (index.ts), KPI CRUD (kpiRoutes), PDPL CRUD (pdplRoutes), auth logout (authRoutes). Fixed health-index pool leakage (try/finally).
- AI Consultant feature complete (Apr 2026): GPT-4o powered QMS AI Consultant with 8 tools, background scanner (6h Inngest cron, 8 checks), alerts system, full chat UI at `/consultant`, alert bell in nav bar.
- Audit History Date/Time (Apr 2026): Audit History table now shows full date/time instead of date-only.
- Slack webhook dual-path (Apr 2026): Webhook now accessible at both /webhooks/slack/action AND /api/webhooks/slack/action. Both paths are public (no auth required) and rate-limited. Challenge verification works on both paths for Slack Event Subscriptions URL verification.
- Security hardening post-review (Apr 2026): Mastra internal endpoints (/api/workflows/*, /api/memory/*, /api/agents/*) now require auth (was bypassed). Webhook endpoints (/webhooks/*) now rate-limited. Both fixes in index.ts middleware.
- Slack trigger registered (Apr 2026): registerSlackTrigger in apiRoutes of index.ts. Handler forwards messages to qualitySpecialistAgent and replies in thread. Challenge response moved before getClient() call for URL verification. Requires Slack connector in Replit integrations.
- OpenAI integration fix (Apr 2026): All AI agent/tool/route files now fallback from AI_INTEGRATIONS_OPENAI_API_KEY to OPENAI_API_KEY. Fixed directAuditRunner.ts trigger function names (was createAuditCompletedTrigger → now fireAuditCompletedTrigger) and payload contracts (ncIds: number[], ncId: number).
- Zoho CRM integration fixed (Apr 2026): Corrected ZOHO_ACCOUNTS_URL from zoho.sa to zoho.com, ZOHO_API_DOMAIN to zohoapis.com — all 5 modules (Leads, Deals, Contacts, Tasks, Accounts) now returning live data. Navigation dropdown UX fix: added 150ms hide delay + invisible bridge to prevent premature menu closing. Moved Duplicates from GRC to Quality nav group.
- Testing tracker v4.0 bug fixes (Apr 2026): Admin key login inline error feedback (was alert() → now banner), QMS checkAuth 429 retry with backoff + server-side admin key verify endpoint, GRC Array.isArray guards for rules/controls tables, Scorecard CDN switched from unpkg.com to jsdelivr, PDPL GET routes changed from requireAdminOrKey to requireAuthOrKey for read access, added /api/admin/auth/verify endpoint for HttpOnly cookie verification
- Pentest retest remediation complete (37/37 findings fixed): CSP nonce-based script-src, rate limiting (10 read/3 write), 404→403 enumeration prevention, UUID public_id obfuscation on all API responses (risks/vendors/compliance/feedback), dashboard UUID-aware onclick handlers, resolveGenericId for cross-module UUID resolution, export CSV + feedback 500 errors fixed (Apr 2026)
- Pentest v3.0 remediation (Task #3): Error message sanitization, password policy, invitation dedup, CSV formula prevention, ROI validation, rate limit tightening, CSP hardening, auth added to checklist/calendar POST endpoints (Mar 2026)
- Pentest v3.0 remediation (Task #2): Centralized RBAC middleware with ROUTE_PERMISSION_MAP, enforceRoutePermission globally applied, status change blocking, invitation token masking (Mar 2026)
- Security hardening: Fixed all 19 VAPT findings — API auth, CORS, CSP, input sanitization, rate limiting, OAuth state validation (Mar 2026)
- Migrated from Google OAuth 2.0 to Replit Auth (OIDC) for login — supports Google, GitHub, Apple, and email (Mar 2026)
- Added Google OAuth 2.0 login with login page, session cookies, and route protection (Feb 2026)
- Fixed audit API schema (VARCHAR foreign keys) and route ordering issues
- All 49 API endpoints verified passing
- Migrated from template scaffold to full WalaPlus QMS codebase (Feb 2026)
- Mastra + Hono + Inngest stack replacing Express + React + Vite

## Security Documentation
- `docs/VAPT_Remediation_Report.md` - VAPT remediation report (19 findings, all resolved)
- `docs/SCOPE_OF_WORK.md` - Full technical scope including Section 8 (Security) and Section 12 (Hosting/Migration)
