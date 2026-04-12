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
  - `duplicateRadarDatabase.ts` - Multi-signal duplicate detection (email 40pts + domain 25pts + phone 30pts + company 20pts), cross-module clustering (Leads/Contacts/Deals/Accounts), merge workflow, owner accountability, real-time pre-creation check
  - `knowledgeDatabase.ts` - Knowledge base document storage, chunk-based full-text search
  - `checklistDatabase.ts` - Compliance checklist engine with automated verification
  - `evidenceDatabase.ts` - Evidence/document management across QMS modules
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
- `/compliance` - Compliance Tracking (status filter, CSV export)
- `/risks` - Risk Register (date filters, treatment progress bars, milestones, CSV export)
- `/policies` - Policy Governance
- `/vendors` - Vendor Risk Management (CSV export)
- `/calls` - Call Intelligence
- `/roi` - ROI & NPV Evaluation
- `/team` - Team Performance
- `/projects` - PMP Project Portfolio
- `/logs` - System Event Logs
- `/pdpl` - PDPL Privacy Compliance (CSV export)
- `/users` - Users & Access Control
- `/consultant` - AI Consultant & Assistant (chat interface with 16 AI tools)
- `/kpis` - KPI Tracking (status filter, CSV export, auto-calc timestamp)
- `/scorecard` - Scorecard
- `/duplicates` - Duplicate Radar (async Zoho scan with progress polling)
- `/reviews` - Management Review (ISO 9001 Clause 9.3, action tracking, auto-gather QMS inputs)
- `/migration` - Data Migration
- `/crm` - CRM Integration
- `/feedback` - Feedback
- `/onboarding` - Onboarding
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
- Data populates through platform usage (call evaluations, audits, governance document uploads)

## AI Consultant Feature
- **Agent**: `qmsConsultantAgent.ts` - GPT-4o powered QMS consultant with 16 tools, registered in Mastra agents config with @mastra/memory for conversation threading
- **Tools**: queryPlatformData, analyzeNonconformities, suggestImprovements, checkRegulationCompliance, monitorKPIs, monitorRisks, createAlert, reviewDocument, searchKnowledge, runChecklist, manageChecklist, createNc, getNcList, createCapa, getCapaList, getCapaDetails
- **Background Scanner**: `aiBackgroundScanner.ts` - 12 automated checks running every 6 hours via Inngest
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
- **Frontend**: `dashboard/consultant.html` - Full chat interface with sidebar quick actions, markdown rendering, streaming responses, alert bell integration
- **Navigation**: Alert bell in nav bar polls `/api/consultant/alerts/count` every 60s, links to `/consultant`

## Recent Changes
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
