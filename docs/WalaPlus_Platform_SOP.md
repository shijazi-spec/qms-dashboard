# WalaPlus Enterprise GRC & Quality Management Platform
# Standard Operating Procedure (SOP)

**Version:** 4.5
**Last Updated:** April 18, 2026
**Classification:** Internal Use Only
**Published URL:** https://qms-dashboard.replit.app
**Approval Authority:** Quality Management Representative / Platform Admin
**Next Review Date:** July 17, 2026

---

## Document Control

| Field | Detail |
|-------|--------|
| **Document ID** | WP-SOP-001 |
| **Version** | 4.4 |
| **Status** | Approved |
| **Author** | Platform Engineering Team |
| **Approved By** | Quality Management Representative |
| **Effective Date** | April 18, 2026 |
| **Next Review** | July 17, 2026 (quarterly) |
| **Distribution** | All platform users (internal) |

### Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 2026 | Engineering | Initial SOP covering core platform modules |
| 2.0 | Mar 2026 | Engineering | Added security architecture, RBAC, pentest remediation |
| 2.1 | Apr 8, 2026 | Engineering | OAuth credential detection, GRC audit readiness, QMS NC modal, team Add Member, policies fix |
| 3.0 | Apr 8, 2026 | Engineering | Added Quality Policy, Document Control, Management Review, Internal Audit Program, PDPL/Data Protection, Incident Response, Backup & DR, Change Management, User Training, Continual Improvement, Glossary, RACI, SLAs |
| 3.1 | Apr 8, 2026 | Engineering | Corrected 10 inaccuracies: GRC audit readiness description, policy button name, QMS KPI cards, NC types, PKCE claim, rate limiting claims, audit process steps, link text, first-steps references |
| 3.2 | Apr 8, 2026 | Engineering | Comprehensive codebase audit: expanded database inventory (97+ tables), added PDPL backend details (data inventory, DSAR, AI guardrails, audit log with SHA-256), ROI engine details (manpower/platform/error costs, AI validation), Call Intelligence backend (transcripts, QA scores, meeting MOM), handoff & control mapping system, escalation system, Zoho write capability (record updates, evaluation notes), Google Calendar integration, Slack/Telegram triggers, sandbox/mock data endpoints, onboarding tour system, admin governance document & scorecard management, MFA schema, access audit log, data scopes, screen permissions, risk assessment history, compliance calendar, evidence packs, policy versions & acknowledgments, vendor assessments & remediations |
| 3.3 | Apr 8, 2026 | Engineering | Corrected 9 inaccuracies: database count 73→97+ tables, fixed section numbering (22→28 gap), corrected policy form fields, NC severity/source options, audit readiness naming, expanded table inventory (+24 tables, +2 groups) |
| 3.4 | Apr 9, 2026 | Engineering | Restored auth documentation (authRoutes.ts with OIDC + HMAC-SHA256 session signing exists in codebase), corrected CSP to reflect nonce implementation, documented tiered rate limiting, updated VAPT status to reflect post-retest remediation of final 5 findings, unified role system |
| 3.5 | Apr 9, 2026 | Engineering | CSP nonce removed (CSP Level 3 conflict with inline handlers), page-level auth now accepts admin_key cookie alongside session cookie, audit trigger uses Inngest-first with direct execution fallback, admin key login redirects to dashboard, inngest.sh DATABASE_URL check fixed, smoke test routes added (/api/health, /api/smoke) |
| 3.6 | Apr 9, 2026 | Engineering | 22-fix security hardening: SQL injection fixes (parameterized make_interval in getTrendData, getRiskTrends, getUpcomingDeadlines), path traversal fix in screenshot endpoint, kpiDatabase table name corrections, crmComplianceTool fake data removal + Zoho datacenter URL fix, OIDC nonce verification (via oauth_data cookie, redirect on mismatch), directAuditRunner trigger chain, eventLogsDatabase error propagation, UUID treatment action resolution, dashboard HTML fixes (policies.html, executive.html, pdpl.html), uniform requireAdminOrKey auth guards on rbacRoutes/pdplRoutes/callIntelligenceRoutes/duplicateRadarRoutes, Telegram webhook secret validation, Linear webhook HMAC-SHA256 signature verification with timingSafeEqual |
| 3.7 | Apr 10, 2026 | Engineering | SOP accuracy corrections: fixed OIDC nonce cookie name (oauth_data, not oidc_nonce) and rejection behavior (redirect to `/login?error=nonce_mismatch`, not 403), clarified Linear webhook HMAC-SHA256 implementation details (createHmac + timingSafeEqual), clarified uniform requireAdminOrKey usage across RBAC/PDPL/CallIntel/DuplicateRadar with note on requireWriteRole in other modules, updated Recent Changes Log |
| 3.8 | Apr 12, 2026 | Engineering | Added AI Consultant & Assistant module (Section 4.20/6.4/7/8): GPT-4o agent with 8 tools, background scanner (6h Inngest cron, 8 checks), alerts system, full chat UI at `/consultant`, alert bell in nav bar. Removed Sandbox module. Updated Audit History to show Date/Time. Added Slack notification integration details. Updated AI engine to GPT-4o. |
| 4.0 | Apr 13, 2026 | Engineering | **Major SOP overhaul.** AI Consultant upgraded to 16 tools (added NC/CAPA create/list, checklist runner, knowledge search). Duplicate Radar Tier 1–3 upgrade: multi-signal scoring (email 40pts + domain 25pts + phone 30pts + company 20pts), cross-module matching (Leads/Contacts/Deals/Accounts), merge workflow, owner accountability, real-time duplicate check, async scan with progress polling. AI Scanner expanded to 12 checks (added Sales SLA, SDR SLA, low-progress treatments, high-confidence duplicates). 76 CRM governance rules documented (Sales SOP + SDR SOP + 20 Account rules). 11 SDR KPIs seeded. 6-hourly duplicate auto-sync cron. KPI auto-calculation cron (daily 2 AM, 6 KPIs). Zoho pagination uncapped by default. Notification hub integration. Database expanded to 105+ tables. Complete route/utility/dashboard inventory. Updated all sections. |
| 4.1 | Apr 13, 2026 | Engineering | **Duplicate Radar 21-item enhancement (4 phases).** Phase 1 Bug Fixes: A1 – incremental upsert with ON CONFLICT replacing destructive clear, DUPLICATE_SCAN_MODE env (incremental/full), stale record cleanup + orphan cluster removal; A2 – getEnhancedSummary low_confidence only for clusters with >1 record, added singletonCount + resolutionRate; A3 – fixed searchDuplicates paramIndex bug for company_name; A6 – RBAC on DELETE /api/duplicates/mock-data; A7 – phone_normalized computed atomically in INSERT. Phase 2 Performance: B2 – upsertRecord with atomic phone_normalized; B3 – parallel 4-module fetch via Promise.all(); B4 – pg_trgm + GIN index for fuzzy company matching with Levenshtein fallback; B5 – JOIN-based getDuplicateRecordsByType and getExportRecords eliminating N+1 queries; B6 – performance indexes on zoho_record_id (unique), email, phone_normalized, domain. Phase 3 Features: C1 – SSE endpoint /api/duplicates/scan-stream for real-time scan progress; C2 – Contact Duplicates tab + /api/duplicates/contacts endpoint; C3 – Owner Accountability with RAG status (green ≤2%, amber 2-5%, red >5% vs 2% KPI target); C4 – server-side pagination (30/page clusters, 50/page records); C5 – auto-resolve engine POST /api/duplicates/auto-resolve (singletons→ignored, ≥95% confidence→resolved); C6 – date range filters on all endpoints; C7 – smart AI recommendations with multi-factor scoring (completeness, deal activity, recency, stage). Phase 4 UI/UX: D1 – animated progress bar with module status chips (pending/fetching/processing/done); D2 – enhanced cluster modal with side-by-side field comparison, AI recommendations (KEEP/MERGE/CLOSE), Zoho record links, resolve/ignore actions; D4 – Executive Summary with resolution rate, KPI gauge vs 2% target, top match signals, top 5 clusters by pipeline inflation, last scan info; D5 – Generate Test Data button removed from production UI. |
| 4.2 | Apr 13, 2026 | Engineering | **AI Consultant 27-item enhancement (4 phases).** Phase 1 Bugs: A1 – XSS-safe renderMarkdown with escapeHtml + placeholder tokens for code/tables + URL protocol sanitization; A2 – sla_breach added to createAlertTool Zod enum; A3 – 9 `if(true)` scanner bugs fixed (use createAlertIfNew return); A4 – Auto-NC status query `'active'` → `IN ('open','acknowledged')`; A5 – KPI join column `kpi_definition_id` → `kpi_id`; A6 – monitorRisksTool column `rta.description` → `rta.action_description`; A7 – Dead `checkAgainst` param removed from reviewDocumentTool; A8 – Scan prompt revised to report-only (no force-create). Phase 2 Performance: B1 – Shared pg.Pool in sharedPool.ts (max:20); B2 – AbortController timeouts on all agent calls (120s chat, 300s scan, configurable via env vars); B3 – 13 scanner checks parallelized via Promise.all; B4 – safeQuery error logging + errors[] in ScanResult. Phase 3 Features: C1 – Alert action buttons (ack/resolve/dismiss) + View All modal with status/severity filters; C2 – Chat history panel with localStorage persistence; C3 – File upload endpoint (PDF/DOCX/TXT, 10MB limit); C4 – Clickable knowledge docs; C5 – Citation CSS + sanitized markdown links; C6 – Scan SSE progress bar endpoint (/api/consultant/scan-stream); C7 – Agent upgraded to 23 tools (added updateCapa, addCapaAction, createTraining, getTrainingList, assignTraining, getTrainingAssignments, completeTraining); C8 – Auth guards (session or X-Admin-Key) on all consultant endpoints; C9 – Contextual welcome dashboard with KPI summary. Phase 4 UI: D1 – Consolidated alert polling (60s interval); D2 – Touch swipe gestures + sticky input; D3 – Severity icons + inline actions + relative time; D4 – Retry button on stream failure; D5 – Export chat as Markdown; D6 – Arabic RTL detection. |
| 4.3 | Apr 14, 2026 | Engineering | **CRM Data Hub & reliability fixes.** CRM page (`/crm`) rewritten as "CRM Data Hub" with live quality enrichment via `POST /api/crm/enrich`, additive penalty scoring via `assessDataQuality()`, junk detection (gibberish names, garbage names, suspicious emails), duplicate cluster cross-reference via `lookupRecordsByZohoIds()`. Frontend: health summary bar, 4-tier quality badges, cluster badges linking to Duplicate Radar, row-click detail modal, Hide Junk/Highlight Issues toggles, `escapeHtml()` XSS protection. Duplicate Radar: full CRM sync with `syncAllModules`, 6-hourly auto-sync, data quality scoring + junk quarantine, new filter/sync/quality endpoints, Data Quality tab, `zoho_sync_state` and `duplicate_record_tasks` tables. PDPL section corrected to reflect CRM data persistence. SOP accuracy audit: corrected 23 discrepancies. |
| 4.4 | Apr 17, 2026 | Engineering | **Duplicate Radar — cross-module intelligence, deletion sync, dashboard drill-downs.** (1) Module-aware recommendations: cluster decisions now distinguish MERGE (same module), LINK (cross-module — set `Account_Name`/`Contact_Name` instead of merging, per Zoho rule), CLOSE, and REVIEW. Account-first primary selection across cross-module clusters. Cluster API (`GET /api/duplicates/clusters/:id`) returns `primary_type`, `is_cross_module`, and `record_types`; cluster modal shows cross-module banner + per-record type tags, dynamic Resolve label, and post-merge sync hint. (2) Deletion detection: `fetchDeletedZohoRecords()` calls Zoho's `/deleted?type=all` with `If-Modified-Since`; `runDeletionDetection()` purges merged/deleted records on each scan. Removed unsafe `markStaleRecords()` from incremental sync to avoid false purges. Deletion detection is skipped on the very first scan (no `last_sync_at` baseline). (3) "View All" drill-down modals on the dashboard: new endpoints `GET /api/duplicates/clusters-by-inflation` and `GET /api/duplicates/clusters-by-signal/:signal` with DB helpers `getAllClustersByInflation` / `getClustersBySignal`. Generic `listModal` with "View all signals →" and "View all clusters →" links; inline signal rows are clickable. (4) Layout filter on Clusters tab: shared `buildClusterFilterClause()` helper used by both `getAllClusters` and `getClusterCount` (guarantees list/count parity); new `layouts` param uses an `EXISTS` subquery on `duplicate_records.layout_name` (uses existing `idx_duplicate_records_layout` index); Layout `<select>` populated once from `/api/duplicates/filters/options` with a live count hint. Resolved/ignored decisions are still LOST on full Rebuild Clusters (admin-only). |
| 4.5 | Apr 18, 2026 | Engineering | **Internal Audits re-architecture + Admin & Tools dropdown + External Audits.** (1) Internal Audits Dashboard (§4.26) — Annual Audit Programme panel with HITL sign-off routed through `/ai-approvals` (new role `head_of_operations_quality` as sole approver, WP-CTL-007); triggers now require a written dismiss reason (≥10 chars) and auto-re-evaluate in 24 h; critical triggers expose "Propose via HITL"; new Inngest cron `trigger-auto-escalate` (daily @ 03:00) re-activates dismissed triggers when the re-eval window elapses and auto-opens a formal `grc_audit_findings` row for Critical @ 7 d / Minor @ 30 d stale pending triggers, with bi-directional link via `escalation_finding_id`. (2) Manual Audit Intake (§4.27) — new `/intake` workspace, Quality Manager as central intake owner, GPT-4o structured finding extraction with paste-fallback for un-parsed binaries, per-finding accept/edit/reject review, `source_quote` traceability, `Finalize` promotes accepted findings into `grc_audit_findings` with `intake_id` lineage; tables `manual_audit_intake`, `manual_audit_findings`. (3) External Audits (§4.28) — separated into `/external-audits` with Calendar/Audits + Certificate Register + Readiness Checklist tabs; hero summary card on `/grc` showing Next Audit / Active Certs / Expiring ≤ 90 d; tables `external_audits`, `external_audit_certificates`, `external_audit_checklist`. (4) Admin & Tools dropdown (§4.29) — new top-nav group consolidating Data Migration Engine (moved from GRC), User & Role Management, Users & Access, AI Approvals Queue, System Logs (moved from Analytics); role-gated. (5) Migration Engine expanded with 5 Quality templates: CAPA Register, Nonconformity Log, Training Records, Audit Findings, Deal Evaluations (AI column-mapper + duplicate pre-check inherited). (6) 7 new controlled documents seeded: WP-SOP-040 (Audit Programme Governance), WP-SOP-041 (Manual Intake Control), WP-SOP-042 (External Audit Preparation), WP-FORM-055/056/057, WP-CTL-007 (Programme Sign-off Control). (7) `audits.source_party` + `audit_run_id`/`programme_id`/`intake_id` columns for full audit lineage. |
| 4.3 | Apr 14, 2026 | Engineering | **CRM Data Hub & reliability fixes.** CRM page (`/crm`) rewritten as "CRM Data Hub" with live quality enrichment via `POST /api/crm/enrich`, additive penalty scoring via `assessDataQuality()`, junk detection (gibberish names, garbage names, suspicious emails), duplicate cluster cross-reference via `lookupRecordsByZohoIds()`. Frontend: health summary bar, 4-tier quality badges, cluster badges linking to Duplicate Radar, row-click detail modal, Hide Junk/Highlight Issues toggles, `escapeHtml()` XSS protection. Duplicate Radar: full CRM sync with `syncAllModules`, 6-hourly auto-sync, data quality scoring + junk quarantine, new filter/sync/quality endpoints, Data Quality tab, `zoho_sync_state` and `duplicate_record_tasks` tables. PDPL section corrected to reflect CRM data persistence. SOP accuracy audit: corrected 23 discrepancies. |

### Document Control Procedure
1. This SOP is maintained in the project repository at `docs/WalaPlus_Platform_SOP.md`
2. All changes require review by the Quality Management Representative or Admin
3. Superseded versions are retained in version control (git history)
4. Users are notified of updates via platform announcements
5. The current version is always accessible from the platform admin panel

---

## 1. Quality Policy & Objectives

### 1.1 Quality Policy Statement

WalaPlus is committed to delivering an enterprise-grade Quality Management System that ensures the accuracy, completeness, and governance of CRM data and business processes. We achieve this through:

- **AI-powered continuous monitoring** of CRM data quality across all modules
- **Automated governance enforcement** through 76 configurable rules and scorecards
- **Transparent compliance tracking** aligned with ISO 9001, NCA ECC, and PDPL requirements
- **Data-driven decision making** supported by real-time dashboards and trend analysis
- **Proactive duplicate detection** with multi-signal scoring across all CRM modules
- **SLA monitoring** with automated breach detection for Sales and SDR pipelines
- **Continuous improvement** driven by audit findings, CAPA effectiveness, KPI tracking, and user feedback

### 1.2 Measurable Quality Objectives

| Objective | Target | Measurement Method | Review Frequency |
|-----------|--------|-------------------|-----------------|
| CRM Data Quality Score | ≥ 85% | AI audit (People + Process + Governance average) | Weekly |
| Audit Compliance Rate | ≥ 90% | Issues found / records audited | Weekly |
| CAPA Closure Rate | ≥ 80% within 30 days | Open vs closed CAPA records in QMS | Monthly |
| NC Resolution Time | ≤ 15 business days (major), ≤ 30 days (critical) | NC records aging in QMS | Monthly |
| First Pass Yield | ≥ 75% | QMS Audit KPI dashboard | Monthly |
| Platform Uptime | ≥ 99.5% | Replit health checks and monitoring | Monthly |
| User Satisfaction | ≥ 4.0/5.0 | Feedback module (`/feedback`) | Quarterly |
| Duplicate Rate | ≤ 2% | Duplicate Radar KPI SDR-KPI-09 | Monthly |
| SDR Contact Rate | ≥ 30% | KPI SDR-KPI-02 | Monthly |
| CRM Data Accuracy | ≥ 95% | KPI SDR-KPI-08 | Monthly |

### 1.3 Quality Objective Review
- Quality objectives are reviewed during quarterly Management Review meetings (see Section 15)
- Targets are adjusted based on trend data, organizational maturity, and business priorities
- Changes to objectives require Quality Management Representative approval

---

## 2. Platform Overview

WalaPlus QMS is an AI-powered enterprise Quality Management System that integrates Governance, Risk, and Compliance (GRC) with quality management capabilities. The platform connects directly to Zoho CRM (production, via OAuth 2.0) to perform automated quality audits, data hygiene checks, SLA monitoring, duplicate detection, and compliance monitoring.

**Platform URL:** https://qms-dashboard.replit.app
**Tech Stack:** Mastra AI Framework, Hono HTTP Server, PostgreSQL, Inngest Workflows
**Hosting:** Replit Autoscale with automatic health checks
**Database:** PostgreSQL with 105+ auto-initialized tables
**AI Engine:** GPT-4o via OpenAI / Replit AI Integrations (configurable)

### 2.1 Platform Architecture Summary

| Component | Count | Description |
|-----------|-------|-------------|
| Dashboard Pages | 31 | Static HTML dashboards with Tailwind CSS |
| API Route Files | 31 | Hono HTTP route handlers |
| Utility Modules | 47 | Database, security, integration, and business logic |
| AI Agents | 4 | Quality Specialist, AI Consultant, SDR Quality, Sales Quality |
| AI Tools | 23 | Consultant agent tools + 8 audit/analysis tools |
| Database Tables | 105+ | Auto-initialized, no manual migration required |
| CRM Governance Rules | 76 | Sales SOP (28) + SDR SOP (28) + Account Rules (20) |
| SDR KPIs | 11 | Seeded performance indicators |
| Background Checks | 14 | AI scanner automated checks (parallelized) |
| Cron Jobs | 4 | Audit, KPI calc, AI scanner, duplicate scan |

---

## 3. User Roles & Access Control

### 3.1 Role Matrix

| Role | Access Level | Capabilities |
|------|-------------|--------------|
| **Admin** | Full access | All modules, user management, system settings, audit triggers, admin panel |
| **Quality Manager** | Extended | Quality dashboards, audits, CRM data, compliance, policies, audit triggers |
| **GRC Manager** | Extended | GRC Control Tower, risks, compliance, regulations, policies, policy approval |
| **Team Lead** | Standard+ | Team performance, call intelligence, audits, quality dashboards |
| **Auditor** | Standard+ | Audit readiness, compliance tracking, findings management |
| **Quality Specialist** | Standard | Quality dashboards, call analysis, CRM hygiene |
| **AI Specialist** | Standard | Call intelligence, AI agent tools, CRM analysis |
| **BU Owner** | Standard | Business unit dashboards, ROI evaluation, team metrics |
| **Executive** | Read-heavy | Executive dashboards, scorecards, KPIs, trend reports |
| **Department Viewer** | Read-only | Dashboard viewing, report access (default role for new users) |
| **Custom** | Configurable | Per-screen permissions assigned by admin; used for non-standard access patterns |

### 3.2 Login Process
1. Navigate to **https://qms-dashboard.replit.app**
2. Click **"Log in with Replit"**
3. Authenticate using Google, GitHub, Apple, or email
4. System creates/updates your user profile automatically
5. Default role assigned: **Department Viewer** (admin can upgrade via Users page)

### 3.3 User Management (Admin Only)
1. Navigate to **Users & Access Control** (`/users`)
2. Available actions:
   - **Invite new users** via email invitation (password must meet policy: 12+ characters, uppercase, lowercase, number, special character)
   - **Change user roles** from the role dropdown
   - **Deactivate/reactivate** user accounts
   - **View login history** and session activity
3. Duplicate invitations are automatically prevented

### 3.4 Advanced Access Control
- **Role Permissions:** Per-role permission matrix (e.g., `can_accept_risk`, `can_approve_policy`, `can_close_finding`) stored in `role_permissions` table
- **Screen Permissions:** Granular UI visibility control per user stored in `screen_permissions` table
- **Data Scopes:** Row-level security settings (Team/Module/Record scopes) stored in `data_scopes` table
- **Access Audit Log:** All login events, permission changes, and access attempts logged in `access_audit_log` table
- **Escalation System:** Overdue compliance actions (CAPAs, risk treatments) automatically escalated to executive level via `escalation_log` table
- **MFA Support:** Database schema includes `mfa_enabled` and `mfa_secret` fields for future multi-factor authentication

---

## 4. Platform Modules

### 4.1 Quality Dashboard (`/`)
**Purpose:** Central hub for AI-powered CRM quality monitoring and compliance tracking.

**Key Features:**
- Overall Quality Score (percentage) with People, Process, and Governance breakdown
- Audit Summary showing records audited, issues found, compliance rate
- Issues by category chart (Leads, Deals, Contacts, Tasks)
- Date filtering (Created date range, Modified date range)
- **Run AI Audit** button to trigger live CRM data analysis
- Export to PDF

**How to Run an AI Audit:**
1. Log in to the platform
2. The Quality Dashboard loads automatically at `/`
3. Optionally set date filters (Created/Modified date ranges) and click "Apply Filters"
4. Click the purple **"Run AI Audit"** button in the top-right area
5. The button shows a spinner while the audit runs (~15 seconds)
6. On completion, the button shows "Audit Started!" and the dashboard refreshes automatically with updated scores
7. The audit connects to live Zoho CRM data using OAuth credentials

### 4.2 GRC Control Tower (`/grc`)
**Purpose:** Centralized governance, risk, and compliance management.

**Key Features:**
- **Summary Cards:** Active Risks, Active Policies, Compliance Score, Open Findings, Active Vendors, Controls Active
- **External Audits hero card** *(v4.5)*: Next scheduled audit, active certificates, certificates expiring within 90 days; deep-links to `/external-audits` (see §4.28)
- **Risk Heat Map:** Interactive likelihood x impact matrix showing risk distribution
- **GRC Module Status:** Chart showing item counts across all GRC modules
- **Compliance by Framework:** Per-regulation compliance breakdown
- **Audit Readiness Table:** List of audits showing code, type, status, lead auditor, and findings count with link to `/audits`
- **Handoff Rules:** Quality-to-GRC integration rules with source/target/trigger details
- **Control Effectiveness:** Control mapping with type, coverage, and effectiveness ratings
- **Recent Handoff Events:** Latest cross-module events with timestamps

**How to Use:**
1. Navigate to `/grc`
2. Use the period filter (Month to Date / Quarter to Date / Year to Date) to adjust the view
3. Click "Refresh" to reload all data
4. Review the Audit Readiness table for scheduled and completed audits
5. Click on heat map cells to see risk details
6. Use "View All Audits" link (`/audits`) to go to the detailed audits page

### 4.3 Audit Readiness (`/audits`) — Superseded
**Status:** Superseded by §4.26 in v4.5.

The `/audits` surface was re-architected in v4.5 as the **Internal Audits Dashboard** with an Annual Audit Programme panel, Manual Intake link, finding traceability, and HITL sign-off through `/ai-approvals`. See **§4.26 Internal Audits Dashboard** for the current surface, features, backend tables, and operating procedure.

### 4.4 Compliance Tracking (`/compliance`)
**Purpose:** Monitor regulatory compliance status across all frameworks.

**Key Features:**
- Compliance assessment management with scoring
- Regulation tracking (NCA ECC, ISO 27001, PDPL, etc.) with jurisdiction and effective dates
- Obligation monitoring with compliance frequency, priority levels, and requirement types
- Gap analysis and remediation tracking
- Compliance score trends over time
- Compliance calendar for scheduled compliance events

**Backend Tables:** `regulations`, `obligations`, `compliance_assessments`, `compliance_calendar`

### 4.5 Risk Register (`/risks`)
**Purpose:** Enterprise risk identification, assessment, and treatment.

**Key Features:**
- Risk registry with likelihood (1–4) and impact (1–4) scoring, auto-calculated risk score
- Risk treatment action plans with owners, due dates, and action types (control_implementation, process_change, training, policy_update, technology, insurance, other)
- Risk assessment history tracking (audit trail of score changes over time)
- Risk categories taxonomy (Operational, Financial, Strategic, Compliance, etc.)
- **Export to CSV** for offline analysis
- UUID-based risk identification (non-sequential for security)
- Risk trend analysis and heat maps

**Backend Tables:** `enterprise_risks`, `risk_treatment_actions`, `risk_assessment_history`, `risk_categories`

### 4.6 Policy Governance (`/policies`)
**Purpose:** Policy lifecycle management from creation to retirement.

**Key Features:**
- Policy creation with category, department, and version tracking
- **Lifecycle workflow:** Draft → Review → Approval → Published → Archived/Retired
- GRC Manager approval gate (required before publishing)
- Policy version history (full historical record of all policy versions)
- Policy acknowledgment tracking (staff sign-off with timestamps per policy)
- Policy review cycles (scheduled review dates with overdue alerts)
- Review scheduling with overdue alerts

**How to Create a Policy:**
1. Navigate to `/policies`
2. Click "New Policy"
3. Fill in: policy number, category, title, description, owner name, owner department, policy content, acknowledgment tracking
4. Policy starts in Draft status
5. Use lifecycle buttons to advance: Submit for Review → Request Approval → Publish
6. GRC Manager must approve before publication (click "Request GRC Approval")

**Backend Tables:** `policies`, `policy_versions`, `policy_acknowledgments`, `policy_review_cycles`

### 4.7 Vendor Risk Management (`/vendors`)
**Purpose:** Third-party vendor risk assessment and monitoring.

**Key Features:**
- Vendor registry with contact details and categorization
- Risk scoring (Low/Medium/High/Critical) and categorization
- Vendor assessments with security and risk scoring for third parties
- Vendor remediations tracking (issues found during vendor audits)
- Due diligence tracking with evidence
- Contract management and renewal alerts
- Vendor performance metrics

**Backend Tables:** `vendors`, `vendor_assessments`, `vendor_remediations`

### 4.8 Call Intelligence (`/calls`)
**Purpose:** AI-powered call quality analysis and compliance monitoring.

**Key Features:**
- Call recording ingestion from Five9/Twilio (metadata stored in `call_records`)
- Full call transcripts stored for analysis (`call_transcripts`)
- AI-powered sentiment analysis, topic extraction, and insights (`call_analysis`)
- Automated quality scoring per call with dimension breakdown (`call_qa_scores`)
- CRM update compliance checking — verifies CRM was updated after each call (`call_compliance`)
- AI-generated Minutes of Meetings (`meeting_mom`)
- Agent performance insights and benchmarking

**Backend Tables:** `call_records`, `call_transcripts`, `call_analysis`, `call_qa_scores`, `call_compliance`, `meeting_mom`

### 4.9 ROI & NPV Evaluation (`/roi`)
**Purpose:** Financial impact analysis for deals and projects.

**Key Features:**
- ROI initiative tracking with full business case documentation
- Manpower cost breakdown analysis (`roi_manpower_breakdown`)
- Platform cost tracking (`roi_platform_costs`)
- Error cost analysis — cost of poor quality (`roi_error_costs`)
- AI-powered validation of financial claims (`roi_ai_validation_logs`)
- Net Present Value analysis
- Deal evaluation scoring
- Financial validation (non-negative values, maximum limits, type checking)

**Backend Tables:** `roi_initiatives`, `roi_manpower_breakdown`, `roi_platform_costs`, `roi_error_costs`, `roi_ai_validation_logs`

### 4.10 Team Performance (`/team`)
**Purpose:** Team and individual performance monitoring.

**Tabs:**
- **Overview:** Summary cards (Total Members, Avg Performance, Training Compliance, Active Projects), department/status charts, top performers
- **Team Members:** Full member list with filtering by department and status, **"Add Member" button** to register new team members
- **Training Courses:** Course management and enrollment
- **Training Matrix:** Skill gap analysis and training assignments
- **Projects:** Project assignments and tracking (PMP-style with milestones, risks, and change requests)
- **Analytics:** Performance trend analysis

**How to Add a Team Member:**
1. Navigate to `/team`
2. Click the **"Team Members"** tab
3. Click the **"Add Member"** button (top-right, next to filters)
4. Fill in: name, email, role, department, job title, phone, hire date
5. Click "Add Member" to save

**Backend Tables:** `team_members`, `team_performance_metrics`, `pmp_projects`, `project_risks`, `project_milestones`

### 4.11 QMS Dashboard (`/qms`)
**Purpose:** Comprehensive Quality Management System dashboard with evaluations, CAPA, nonconformances, and training.

**Navigation Label:** "Audit Reports" in sidebar

**Tabs:**
- **Overview:** Summary cards (Evaluations, Open CAPA, Open NC, Training Completion) + **Audit Runs card** showing total audits completed and open findings count + Recent Evaluations & CAPA
- **Deal Evaluations:** Run and review deal quality evaluations against configurable evaluation frameworks
- **CAPA:** Corrective and Preventive Action management with action items, root cause tracking, and types (corrective/preventive/improvement)
- **Nonconformances:** NC records with **"New NC" button** to create nonconformances
- **Training:** Course and assignment management with assessment scoring
- **Framework:** Evaluation framework configuration (dimensions, criteria, weights, thresholds)
- **Triggers:** Automated trigger management with acknowledge/dismiss/decide actions. *(v4.5 HITL gate)* Dismissing a trigger now requires a written reason of ≥10 characters; the trigger is auto-re-evaluated 24 hours later by the `trigger-auto-escalate` Inngest cron (daily @ 03:00 UTC). Critical-severity triggers expose a **"Propose via HITL"** button that creates an `/ai-approvals` ticket for `head_of_operations_quality` adjudication. Stale pending triggers (Critical @ 7d / Minor @ 30d) auto-open a formal `grc_audit_findings` row, with bi-directional linkage via `escalation_finding_id`.

**How to Create a Nonconformance:**
1. Navigate to `/qms`
2. Click the **"Nonconformances"** tab
3. Click the **"New NC"** button
4. Fill in the following fields:
   - **Title:** Descriptive name of the nonconformance
   - **Description:** Detailed explanation
   - **Type:** process, product, system, documentation, or data_quality
   - **Severity:** minor, major, or critical
   - **Source:** audit, customer_complaint, internal_review, or data_analysis
   - **Assigned To:** Person responsible for resolution
5. Click "Create NC" to save

**Enhanced Features:**
- Evidence management for NCs and CAPAs
- CSV export for NCs and CAPAs
- Bulk status updates
- Change history audit trail
- Closure approval workflow
- CAPA effectiveness review

**Backend Tables:** `evaluation_frameworks`, `evaluation_criteria`, `deal_evaluations`, `capa_records`, `capa_action_items`, `nonconformance_records`, `training_records`, `training_assignments`, `audit_findings`, `quality_metrics`, `qms_documents`

### 4.12 PMP Project Portfolio (`/projects`)
**Purpose:** Project management and portfolio tracking.

**Key Features:**
- Project registry with milestones and deliverables
- Project risk tracking (separate from enterprise risks)
- Resource allocation and assignment
- Status reporting (on-track, at-risk, delayed)
- Priority management
- Project types: governance, audit, capa, rca, six_sigma, redesign, training, quality_improvement, process, compliance, other
- Change request tracking (scope, schedule, cost, quality, resource, requirement, technical, process changes)

**Backend Tables:** `pmp_projects`, `project_risks`, `project_milestones`

### 4.13 KPI Tracking (`/kpis`)
**Purpose:** Key Performance Indicator definition, monitoring, and automated calculation.

**Key Features:**
- KPI definition with targets, thresholds, weights, and navigation maps
- Progress tracking with visual indicators
- Trend visualization over time
- Automated data collection from platform modules
- **11 SDR KPIs** pre-seeded via `POST /api/kpis/seed-sdr`
- KPI auto-calculation cron (daily at 2:00 AM) for 6 platform KPIs

**Pre-Seeded SDR KPIs:**

| Code | KPI Name | Target | Formula |
|------|----------|--------|---------|
| SDR-KPI-01 | Calls Per Day | 40 calls/day | Total outbound calls / working days |
| SDR-KPI-02 | Contact Rate | 30% | (Connected calls / Total calls) × 100 |
| SDR-KPI-03 | Qualification Rate | 25% | (Qualified leads / Total contacted) × 100 |
| SDR-KPI-04 | Meetings Booked Per Week | 5 meetings | Count of qualified meetings booked |
| SDR-KPI-05 | Show Rate | 80% | (Meetings attended / Meetings booked) × 100 |
| SDR-KPI-06 | Average Speed to Lead | 2 hours | Average time from creation to first attempt |
| SDR-KPI-07 | Lead-to-Qualified Conversion | 20% | (Qualified / Total new leads) × 100 |
| SDR-KPI-08 | CRM Data Accuracy Score | 95% | % of leads with all required fields |
| SDR-KPI-09 | Duplicate Rate | ≤ 2% | (Duplicate leads / Total leads) × 100 |
| SDR-KPI-10 | Pipeline Aging | ≤ 5 days | Avg days in Contacting/Contacted |
| SDR-KPI-11 | Follow-Up Compliance | 95% | % of follow-up tasks completed on time |

**Auto-Calculated Platform KPIs (daily 2 AM):**

| KPI | Calculation |
|-----|-------------|
| Governance Doc Lifecycle | % of policies with valid review cycles |
| Compliance Obligation Tracking | % of obligations not overdue |
| Audit Evidence Pack Readiness | % of evidence packs with complete status |
| Quality→GRC Handoff | Count of active handoff rules |
| Risk Register Hygiene | % of risks with treatment plans assigned |
| Executive Reporting Readiness | Count of executive reports generated |

**Backend Tables:** `kpi_definitions`, `kpi_entries`

### 4.14 Scorecard (`/scorecard`)
**Purpose:** Balanced scorecard for organizational performance measurement.

**Key Features:**
- Employee scorecards with KPI snapshots (e.g., quality scores, activity compliance)
- Multi-dimensional scoring across quality dimensions
- Historical trend analysis
- Benchmark comparisons
- Configurable attributes and weights

**Backend Tables:** `employee_scorecards`

### 4.15 Duplicate Radar (`/duplicates`)
**Purpose:** AI-powered CRM data deduplication, hygiene management, and pipeline inflation detection across all Zoho modules.

**Key Features:**
- **Multi-Signal Confidence Scoring:** Email match (40 points), domain match (25 points), phone match (30 points), company name match (20 points). Maximum confidence: 100.
- **Cross-Module Matching:** Detects duplicates across Leads, Contacts, Deals, and Accounts simultaneously
- **Module-Aware Recommendations (v4.4):** Cluster decisions are now classified as **MERGE** (records in the same Zoho module — safe to merge), **LINK** (records in different modules — must NOT be merged; instead set `Account_Name`/`Contact_Name` on the child record per Zoho's cross-module rule), **CLOSE** (low-value duplicates), or **REVIEW**. Cluster API returns `primary_type`, `is_cross_module`, and `record_types`. The cluster modal shows a cross-module banner, per-record type tags, a dynamic Resolve button label that reflects the recommended action, and a post-merge sync hint. Account-first selection is used for the primary record in cross-module clusters.
- **Deletion Detection (v4.4):** `fetchDeletedZohoRecords()` calls Zoho's `/deleted?type=all` endpoint with an `If-Modified-Since` header derived from `zoho_sync_state.last_sync_at`. `runDeletionDetection()` purges merged/deleted Zoho records from the local store on each scan. Skipped automatically on the first scan (no baseline). The unsafe `markStaleRecords()` call has been removed from the incremental sync path to prevent false purges when Zoho returns partial pages.
- **5-Signal Cluster Matching:** domain → email → phone → exact company name → fuzzy company name (pg_trgm similarity with Levenshtein fallback)
- **Confidence Levels:** Strong (≥90 points, red), Moderate (60–89 points, amber), Weak (<60 points, green)
- **Pipeline Inflation:** Calculates estimated duplicate deal value (non-primary deals only)
- **Merge Workflow:** Resolve/ignore clusters, mark primary records, bulk resolution
- **Owner Accountability with RAG Status:** Track duplicate clusters per CRM owner with traffic-light status (green ≤2%, amber 2-5%, red >5% duplicate rate) benchmarked against the 2% KPI target
- **Real-Time Duplicate Check:** Pre-creation validation endpoint to check if a record already exists
- **Incremental Scanning:** Upsert-based scan with ON CONFLICT (configurable via `DUPLICATE_SCAN_MODE` env: `incremental` or `full`). Incremental mode marks existing records stale, upserts new data, then cleans up stale records and orphan clusters — avoiding destructive data loss between scans
- **SSE Scan Stream:** Real-time Server-Sent Events endpoint (`/api/duplicates/scan-stream`) for live progress during scans, with module status chips and percentage updates
- **Parallel Module Fetch:** All 4 Zoho modules (Leads, Deals, Contacts, Accounts) fetched simultaneously via `Promise.all()` for faster scan completion
- **pg_trgm Fuzzy Matching:** PostgreSQL `pg_trgm` extension with GIN index on `company_name_normalized` for efficient fuzzy company name matching. Falls back to Levenshtein distance if `pg_trgm` is unavailable
- **Server-Side Pagination:** Clusters paginated at 30/page, records at 50/page, reducing frontend memory usage for large datasets
- **Auto-Resolve Engine:** Automatically ignores singleton clusters (≤1 record) and resolves clusters with ≥95% confidence and a clear primary record
- **Smart AI Recommendations:** Multi-factor scoring considering data completeness, deal value, modification recency, record age, and deal stage. Outputs KEEP/MERGE/CLOSE actions with confidence scores and reasons
- **Date Range Filters:** Server-side date filtering on all endpoints (clusters, leads, deals, contacts, accounts)
- **Side-by-Side Comparison Modal:** Cluster detail modal shows all records in a field-by-field comparison table with AI recommendations row and Zoho CRM record links
- **KPI Dashboard:** Executive summary includes resolution rate gauge, KPI gauge vs 2% target, top match signal sources, top 5 clusters by pipeline inflation, and last scan timestamp/details
- **Export:** CSV export with all duplicate records and recommendations, with owner/date filters

**Tabs:**
- **Executive Summary:** Resolution rate, KPI gauge, true duplicate clusters, confidence distribution, pipeline inflation, top signals, top clusters by inflation, last scan info, charts (source distribution, similarity scores)
- **Search:** Multi-field search (domain, phone, company, contract, email, name, owner) with cluster grouping
- **Domain Clusters:** Paginated clusters (30/page) with status, confidence, record counts, and filter by similarity/status
- **Lead Duplicates:** Paginated groups of duplicate leads (50/page) with Zoho links
- **Deal Duplicates:** Paginated groups of duplicate deals with combined value
- **Account Duplicates:** Duplicate accounts from Zoho Accounts module
- **Contact Duplicates:** Duplicate contacts from Zoho Contacts module
- **Owner Accountability:** RAG status table with total records, duplicate count, duplicate rate, KPI status badge, high-confidence count, estimated waste value, and per-owner CSV export link
- **Export Center:** CSV export with type/date filters
- **Logs:** Scan history with records scanned, clusters found, duration, and status
- **Data Quality:** Quality distribution, top data issues, junk/spam record counts, and quality by module breakdown

**Filter Panel:** Shared filters across tabs — Module (Leads/Deals/Contacts/Accounts), Layout, Owner, Created Date range, Domain, and Pipeline

**Clusters Tab Filters (v4.4):** In addition to Similarity and Status (Active/Resolved/Ignored), the Clusters tab now exposes a **Layout** dropdown that filters clusters to those containing at least one record in the selected Zoho layout (Corporate Accounts, Standard, Marketplace, ...). The dropdown is populated once from `/api/duplicates/filters/options` and shows a live count hint such as `"42 cluster(s) in 'Corporate Accounts'"`. The list and total count always stay in lock-step because both queries share `buildClusterFilterClause()`.

**Dashboard Drill-Down Modals (v4.4):** The Executive Summary's "Top Match Signals" and "Top 5 Clusters by Inflation" panels now expose **"View all signals →"** and **"View all clusters →"** links that open a generic `listModal` powered by `GET /api/duplicates/clusters-by-inflation` and `GET /api/duplicates/clusters-by-signal/:signal`. Inline signal rows are also clickable.

**Scan Process:**
1. Click **"Scan from Zoho"** button on the Duplicate Radar page
2. Animated progress bar appears with module status chips (pending → fetching → processing → done)
3. In incremental mode, existing records are marked stale; in full mode, previous data is cleared
4. All 4 modules (Leads, Contacts, Deals, Accounts) are fetched from Zoho (no per-module cap by default; the `DUPLICATE_SCAN_LIMIT` env var can optionally set a limit, default 50,000)
5. Records are upserted using ON CONFLICT on `zoho_record_id` — existing records are updated, new records are inserted
6. Stale records (not refreshed during scan) and orphan clusters (no remaining records) are cleaned up
7. Cluster statistics are recalculated (confidence scores, pipeline inflation, owner lists)
8. On completion, dashboard refreshes with results
9. Real-time progress available via SSE at `/api/duplicates/scan-stream` or polling at `/api/duplicates/scan-status`

**Environment Variables:**
- `DUPLICATE_SCAN_MODE`: `incremental` (default) or `full` — controls whether scan uses upsert+stale cleanup vs destructive clear
- `DUPLICATE_SCAN_LIMIT`: Maximum records per module for manual scan (default: 50000; auto-sync uses unlimited by default)

**API Endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/duplicates/summary` | GET | Summary with KPIs, enhanced data, and last scan date |
| `/api/duplicates/enhanced-summary` | GET | Enhanced summary with resolution rate, top signals, top clusters by inflation |
| `/api/duplicates/clusters` | GET | Paginated clusters (30/page) with status/confidence/date/`layouts` filters (v4.4) |
| `/api/duplicates/clusters-by-inflation` | GET | Full list of clusters ranked by estimated pipeline inflation (powers "View all clusters" modal, v4.4) |
| `/api/duplicates/clusters-by-signal/:signal` | GET | Full list of clusters matched on a given signal (email / domain / phone / company / mobile / cr_number / vat_number / website) for the "View all signals" modal (v4.4) |
| `/api/duplicates/clusters/:id` | GET | Cluster details with all records and smart AI recommendations |
| `/api/duplicates/clusters/:id/status` | PATCH | Update cluster status (active/resolved/ignored) |
| `/api/duplicates/clusters/:id/resolve` | POST | Resolve cluster with action (resolve/ignore) and notes (RBAC) |
| `/api/duplicates/clusters/:id/primary` | POST | Mark a record as primary in the cluster (RBAC) |
| `/api/duplicates/bulk-resolve` | POST | Bulk resolve multiple clusters (RBAC) |
| `/api/duplicates/auto-resolve` | POST | Auto-resolve singletons and high-confidence clusters (RBAC) |
| `/api/duplicates/merge-history` | GET | Get merge/resolution history |
| `/api/duplicates/check` | POST | Real-time duplicate check (email/phone/company) |
| `/api/duplicates/owner-accountability` | GET | Owner accountability with RAG status |
| `/api/duplicates/by-owner` | GET | Duplicate records by owner |
| `/api/duplicates/by-source` | GET | Duplicate records by lead source |
| `/api/duplicates/kpis` | GET | Dedup KPI metrics |
| `/api/duplicates/search` | GET/POST | Search duplicates by domain/phone/company/email/name/owner |
| `/api/duplicates/scan-zoho` | POST | Start async Zoho scan (RBAC) |
| `/api/duplicates/scan-status` | GET | Poll scan progress with module statuses and percentage |
| `/api/duplicates/scan-stream` | GET | SSE real-time scan progress stream |
| `/api/duplicates/export` | GET | Export CSV with owner/date filters |
| `/api/duplicates/leads` | GET | Paginated lead duplicate groups (50/page) with date filters |
| `/api/duplicates/deals` | GET | Paginated deal duplicate groups (50/page) with date filters |
| `/api/duplicates/contacts` | GET | Paginated contact duplicate groups (50/page) with date filters |
| `/api/duplicates/accounts` | GET | Paginated account duplicate groups (50/page) with date filters |
| `/api/duplicates/logs` | GET | Scan detection logs |
| `/api/duplicates/ai-recommendations/:id` | POST | Smart AI recommendations per cluster (multi-factor scoring) |
| `/api/duplicates/mock-data` | DELETE | Clear mock/test data (RBAC) |
| `/api/duplicates/generate-mock-data` | POST | Generate mock/test data for sandbox testing (RBAC) |
| `/api/duplicates/test-record` | POST | Add test record for sandbox testing |
| `/api/duplicates/filter-meta` | GET | Distinct values for filter dropdowns (owners, layouts, domains, products, pipelines) |
| `/api/duplicates/sync-state` | GET | Per-module sync status, last sync time, and record counts |
| `/api/duplicates/filtered-clusters` | GET | Clusters filtered by module, layout, owner, date range, domain, pipeline |
| `/api/duplicates/filtered-summary` | GET | Summary statistics with applied filters |
| `/api/duplicates/clusters/:id/tasks` | GET | Zoho Tasks linked to a cluster's records |
| `/api/duplicates/data-quality` | GET | Data quality stats: junk count, quality distribution, top issues, quality by module |

**Cross-Module Merge Rule (v4.4 — IMPORTANT):**
Zoho does not allow merging records that live in different modules. The Resolve action therefore branches on `is_cross_module`:
- **Same module (Leads↔Leads, Deals↔Deals, ...):** safe to merge in Zoho; the cluster recommendation is `MERGE` and the Resolve button reads "Merge in Zoho".
- **Cross-module (e.g. Account ↔ Contact ↔ Deal):** the cluster recommendation is `LINK`; the Resolve button reads "Link in Zoho" and the post-merge sync hint instructs the operator to set `Account_Name` / `Contact_Name` on the child record so the relationship is preserved without data loss.

**Performance Optimizations (v4.1):**
- `ON CONFLICT` upsert eliminates destructive data clearing
- `pg_trgm` GIN index for sub-second fuzzy company name matching
- JOIN-based queries for lead/deal/contact/account endpoints (no N+1)
- Unique index on `zoho_record_id`, indexes on `email`, `phone_normalized`, `domain`
- `phone_normalized` computed atomically in INSERT (no separate UPDATE)
- Parallel module fetch reduces scan time by ~60%
- Server-side pagination limits memory usage

**Backend Tables:** `duplicate_clusters` (with `company_name_normalized`, `match_signals`, `resolved_by`, `resolved_at`), `duplicate_records` (with `phone_normalized`, `mobile_normalized`, `match_signals`, `data_quality_score`, `data_quality_flags`, `layout_name`, `layout_id`, `zoho_module`, `pipeline`, `products`, `contact_name`, `account_name`, `cr_number`, `vat_number`, `website`, `country`, `region`, `industry`, `no_of_employees`, `title`, `lead_type`, `gov_type`, `account_type`, unique index on `zoho_record_id`), `duplicate_merge_actions`, `duplicate_detection_logs`, `duplicate_export_logs`, `zoho_sync_state` (per-module sync tracking), `duplicate_record_tasks` (linked Zoho Tasks)

### 4.16 PDPL Privacy Compliance (`/pdpl`)
**Purpose:** Personal Data Protection Law compliance tracking (Saudi Arabia).

**Key Features:**
- **Data Inventory:** Map of PII and sensitive data fields across the platform
- **DSAR Requests:** Data Subject Access Request tracking with status and response timeline
- **Retention Policies:** Automated data lifecycle rules per data category
- **Data Incidents:** Breach and privacy incident log with severity and response tracking
- **AI Guardrails:** PII masking patterns for AI interactions (prevents AI from exposing sensitive data)
- **Immutable Audit Log:** PDPL-specific audit trail with SHA-256 checksums for tamper detection
- Consent management and tracking
- Privacy impact assessments

**Backend Tables:** `data_inventory`, `dsar_requests`, `retention_policies`, `data_incidents`, `ai_guardrails`, `pdpl_audit_log`

### 4.17 Table F Governance (`/tablef`)
**Purpose:** Table F compliance tracking and governance scoring.

**Key Features:**
- Governance rule compliance per CRM record
- Field completeness tracking and scoring
- Stage progression analysis
- Activity logging compliance verification

### 4.18 CRM Data Hub (`/crm`)
**Purpose:** Live CRM data browsing with integrated quality enrichment, junk detection, and duplicate cross-referencing.

**Key Features:**
- Live CRM data browsing across 5 modules (Leads, Deals, Contacts, Tasks, Accounts)
- **Live Quality Enrichment:** Each page of records is sent to `POST /api/crm/enrich` which runs `assessDataQuality()` (from `duplicateRadarDatabase.ts`) and returns a 0-100 quality score per record using additive penalty scoring (starts at 100, subtracts fixed penalties per issue: -50 gibberish name, -40 garbage name, -30 gibberish company, -20 missing name, -15 missing company/suspicious email, -10 missing email/phone, -5 missing owner/no business domain)
- **Junk/Spam Detection:** Identifies gibberish names (20+ all-letter strings, high consonant-to-vowel ratio >8:1, zero vowels in 10+ letter strings, consecutive 8+ capitals), garbage names (test, asdf, qwerty, demo, sample, etc.), and suspicious emails (6+ consecutive digits in local part, excessive dots in long local parts)
- **Duplicate Cluster Cross-Reference:** Batch lookup via `lookupRecordsByZohoIds()` matches CRM records against synced duplicate radar clusters, showing cluster badges that link directly to the Duplicate Radar page
- **Health Summary Bar:** Displays Total Records, Clean, With Issues, Junk/Spam, and In Dup. Clusters counts for the current page
- **Quality Score Badges:** Color-coded badges on each table row: green (≥85 good), amber (50–84 fair), orange (21–49 poor), red (≤20 junk)
- **Row-Click Detail Modal:** Full quality assessment with severity-tagged issues, cluster info with confidence level, and all record fields with XSS-safe rendering
- **Filtering Controls:** Hide Junk checkbox and Highlight Issues toggle for focused data review
- **Hygiene Warning Indicators:** Inline warnings for phone length issues and suspicious emails
- **"How to Read" Legend:** Explains all badges, colors, and indicators
- **Security:** XSS-safe rendering (`escapeHtml()`) on all dynamic content including modal innerHTML

**Backend Endpoint:** `POST /api/crm/enrich` (requires admin key or session auth)
**Backend Tables:** Uses `duplicate_records` and `duplicate_clusters` tables via `lookupRecordsByZohoIds()`

### 4.19 System Event Logs (`/logs`)
**Purpose:** Audit trail for all system activities.

**Key Features:**
- Action logging (create, update, delete, login, export)
- User activity tracking with timestamps
- API access logs
- Security event monitoring
- Filterable by action type, user, and date range
- Supports table partitioning for high-volume log data

**Backend Tables:** `event_logs`

### 4.20 Additional Modules

| Module | URL | Purpose |
|--------|-----|---------|
| Executive Dashboard | `/executive` | High-level executive summary with key metrics |
| Data Migration | `/migration` | Data import/export tools |
| Feedback | `/feedback` | User feedback collection (also accessible via floating "Give Feedback" button) |
| Onboarding | `/onboarding` | New user onboarding flow with guided tour steps |
| Admin Panel | `/admin` | System administration (requires Admin API Key) — includes governance document and scorecard management |
| Guide | `/guide` | Platform user guide (public, no login required) |
| Accept Invite | `/accept-invite` | Invitation acceptance page for new users (public) |

### 4.21 AI Consultant & Assistant (`/consultant`)
**Purpose:** AI-powered quality management consultant providing real-time guidance, automated platform monitoring, proactive alerting, and direct QMS operations (NC/CAPA management, training management, checklists, knowledge search).

**Key Features:**
- **Chat Interface:** Full conversational UI with GPT-4o powered responses, supporting both English and Arabic (automatic RTL detection)
- **Quick Actions Sidebar:** Pre-built prompts for common queries (full platform scan, PDPL compliance check, NC analysis, risk register review, KPI status, improvement suggestions)
- **23 AI Tools:** Query platform data across 11 modules, analyze nonconformities, suggest improvements, check regulation compliance, monitor KPIs, monitor risks, create alerts (supports sla_breach type), review documents, create/list NCs, create/update/list/detail CAPAs, add CAPA actions, run/manage compliance checklists, search knowledge base, create/list/assign/complete training
- **Streaming Responses:** Server-Sent Events (SSE) for real-time streaming chat and scan progress, with standard response fallback
- **XSS-Safe Markdown:** Rendered with escapeHtml + placeholder tokens for code/tables, URL protocol sanitization (blocks javascript:/data: URLs)
- **Alert Management:** Sidebar alert list with severity icons, relative timestamps, and inline action buttons (Acknowledge/Resolve/Dismiss). "View All" modal with status/severity filters
- **Chat History:** Conversations saved to localStorage, restorable from sidebar panel (up to 20 sessions)
- **Knowledge Base Integration:** Document search from sidebar, file upload (PDF/DOCX/TXT, 10MB limit)
- **Checklist Panel:** View available checklists, run them via AI, create new ones
- **Scan Progress:** Full platform scan with SSE progress bar showing step-by-step status
- **Export:** Export full conversation as Markdown file
- **Welcome Dashboard:** KPI summary (open alerts, KPI health, last scan time) shown on first load
- **Retry on Error:** Retry button appears on stream failures
- **Background Scanner:** Automated 6-hour scans detecting 14 quality issue types (see Section 8.2), parallelized for performance
- **Auth Guards:** All API endpoints require valid session cookie or X-Admin-Key header
- **Timeouts:** AbortController-based timeouts — 120s for chat (configurable via `CONSULTANT_CHAT_TIMEOUT`), 300s for scan (configurable via `CONSULTANT_SCAN_TIMEOUT`)
- **Shared Pool:** All database operations use a single shared pg.Pool (max 20 connections) via `sharedPool.ts`
- **Mobile Support:** Touch swipe gestures for sidebar, sticky chat input

**How to Use:**
1. Navigate to `/consultant` or click "AI Consultant" in the Support navigation group
2. The welcome dashboard shows current alert count, KPI health, and last scan time
3. Type a question in the chat input or click a quick action button in the sidebar
4. The AI consultant queries live platform data to answer your question
5. Ask the AI to create NCs, CAPAs, assign training, or run checklists directly from chat
6. Click "Full Platform Scan" to run a comprehensive quality health check with progress tracking
7. Review alerts in the sidebar — click Ack/Resolve/Dismiss for quick actions, or "View All" for the full modal
8. Use the chat history panel to restore previous conversations
9. Upload regulatory documents via the Knowledge Base section
10. Export conversations via the "Export" button for record-keeping

**API Endpoints:**

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/consultant/chat` | POST | Send a message and receive AI response | Session / Admin Key |
| `/api/consultant/chat/stream` | POST | Send a message with SSE streaming response | Session / Admin Key |
| `/api/consultant/alerts` | GET | List all AI alerts (filterable by status, severity, type) | Session / Admin Key |
| `/api/consultant/alerts/count` | GET | Get unread alert count | Session / Admin Key |
| `/api/consultant/alerts/:id/acknowledge` | POST | Acknowledge an alert | Session / Admin Key |
| `/api/consultant/alerts/:id/resolve` | POST | Mark alert as resolved | Session / Admin Key |
| `/api/consultant/alerts/:id/dismiss` | POST | Dismiss an alert | Session / Admin Key |
| `/api/consultant/scan` | POST | Trigger a manual background scan | Session / Admin Key |
| `/api/consultant/scan-stream` | POST | SSE-streamed scan with progress updates | Session / Admin Key |
| `/api/knowledge/upload-file` | POST | Upload regulatory document (PDF/DOCX/TXT) | Session / Admin Key |

**Backend Tables:** `ai_alerts`, `knowledge_documents`, `ai_pending_actions` (HITL gate — see §4.21.1)

### 4.21.1 AI Approval Queue — Human-in-the-Loop (HITL) Gate (`/ai-approvals`)

**Purpose:** Prevents the AI Consultant from autonomously creating or modifying Quality Management records. Every AI-proposed write action (NC, CAPA, training, checklist) is queued for **Quality Manager** approval before execution. This is the primary compensating control for PDPL Art. 16 (human review of automated decisions) and the governance anchor for the platform's AI tools.

**Governing documents (controlled):**
- `WP-SOP-011` — Automated Decision and Processing Process *(primary)*
- `WP-DOC-004` — AI Adoption Guidelines
- `WP-DOC-005` — Segregation of Duties Guidelines
- `WP-DOC-008` — Accountability Framework
- `WP-FORM-013` — Automated Decision Risk Assessment Template
- `WP-FORM-044` — AI Tool Approval Checklist
- `WP-SOP-009` — Nonconformity, Violation and Corrective Action Process
- `WP-SOP-017` — Information Security Competence Development Process
- `WP-SOP-019` — Control of Documented Information Process

**Gated AI tools and their risk classification:**

| Tool | Risk | Controlled-doc anchor | What the gate prevents |
|------|------|-----------------------|------------------------|
| `create-nonconformance` | HIGH | WP-SOP-009, WP-SOP-011 | AI inventing a false NC |
| `create-capa` | HIGH | WP-SOP-009, WP-DOC-008 | Unauthorized CAPA creation |
| `update-capa` | HIGH | WP-SOP-019 | Silent CAPA state changes |
| `complete-training` | HIGH | WP-SOP-017, WP-SOP-019 | False competence records |
| `add-capa-action` | MED  | WP-SOP-009 | Action items without owner review |
| `create-training` | MED  | WP-SOP-017 | Uncontrolled training records |
| `assign-training` | MED  | WP-SOP-017 | Misassigned mandatory training |
| `manage-checklist` | MED  | WP-SOP-019, WP-FORM-044 | Compliance checklist tampering |
| `create-alert` | LOW | *(exempted)* | Internal alerts — no side-effect on quality records |

**How it works (end-to-end):**
1. User asks the AI Consultant to perform an action (e.g. "Create an NC for the SLA breach on deal #1234").
2. The AI prepares the payload and calls the gated tool.
3. The tool's wrapper (`withApprovalGate`) inserts a row into `ai_pending_actions` with status `pending`, a 24-hour `expires_at`, a PII-masked preview, risk level, and the controlled-doc references.
4. The AI receives `{ queued: true, actionCode: "APR-YYYYMMDD-XXXXXX" }` and tells the user "Approval required — see card below" — it does not claim the record was created.
5. An inline approval card appears below the AI message with **Approve ✓** / **Reject ✗** buttons. The card links every cited WP-code to the current controlled version of that document.
6. A Quality Manager reviews the card (requester cannot approve their own proposal per WP-DOC-005) and clicks Approve.
7. The backend atomically claims the row (pending → approved), then executes the original tool with the stored payload, and records the real NC/CAPA/etc. ID back into `ai_pending_actions.result_entity_id`.
8. Every transition (queued, approved, rejected, executed, failed, expired) is written to `event_logs` with `correlation_id = action_code` — full immutable audit trail.

**Authorization rules:**
- **View own pending actions:** any authenticated user
- **View all pending actions:** `quality_manager`, `admin`
- **Approve ANY risk tier:** `quality_manager`, `admin` *(current policy — initial rollout)*
- **Reject own draft:** the original requester may always cancel their own proposal
- **Segregation of duties (WP-DOC-005):** non-admin users cannot approve their own AI proposals
- **Break-glass:** set `AI_APPROVAL_GATE_ENABLED=false` to disable the gate during incidents — every bypassed action is logged to `event_logs` with severity=`WARNING` for after-action review

**UI surfaces:**
- `/consultant` — inline approval cards rendered below each assistant message containing an `APR-*` ticket (auto-detected from response text via `MutationObserver`)
- `/ai-approvals` — dedicated queue page for Quality Manager with filters (status, risk, "only mine"), auto-refresh every 30s, and Approve/Reject inline actions
- Each card links every WP-code to `/policies?policy_number=WP-XXX-YYY` so the approver reads the exact controlled document before approving

**API Endpoints:**

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/ai/approvals` | GET | List approvals (filters: status, risk_level, mine) | Session / Admin Key |
| `/api/ai/approvals/pending-count` | GET | Badge count of pending approvals for current user | Session / Admin Key |
| `/api/ai/approvals/:code` | GET | Approval detail + resolved WP-doc links + `can_approve` flag | Session / Admin Key |
| `/api/ai/approvals/:code/approve` | POST | Claim + execute the gated tool | `quality_manager` or `admin` |
| `/api/ai/approvals/:code/reject` | POST | Reject with required `reason` (min 3 chars) | Requester or approver role |

**Data retention & expiry:**
- Pending actions auto-expire 24 hours after creation (configurable via TTL in `enqueuePendingAction`)
- An Inngest cron (`ai-approval-expiry`) runs every 15 minutes to flip expired rows from `pending` → `expired`
- Rows are **never deleted** — expired and rejected rows remain for audit inspection (per WP-SOP-019 and WP-POL-013 Records Retention)

**Controlled-Document Registry:** On first boot the platform seeds the existing `policies` table with all 140+ WP-coded documents (POL/DOC/SOP/FORM/CTL) using `seedControlledDocumentRegistry()`. Seeded rows have `status='draft'` and no file attached; the Quality Manager uploads the approved `.docx`/`.pdf` via `/policies` → **Upload** (`POST /api/documents/upload`). The existing `policy_versions` table handles version history. Approval cards resolve WP-codes via `resolveControlledDocuments()` so they always point at the *latest* uploaded revision.

**Backend files:**
- `src/utils/aiApprovalDatabase.ts` — `ai_pending_actions` schema + CRUD + immutable status machine
- `src/utils/aiToolGovernance.ts` — per-tool risk + WP-code references + approver-role policy
- `src/utils/withApprovalGate.ts` — higher-order wrapper + `AsyncLocalStorage` user-context isolation + `executeApprovedAction()`
- `src/utils/controlledDocumentRegistry.ts` — seed data + resolver for all 140+ WP codes
- `src/mastra/routes/aiApprovalRoutes.ts` — 5 API endpoints + `/ai-approvals` HTML page route
- `dashboard/consultant.html` — inline approval-card renderer (MutationObserver on assistant bubbles)
- `dashboard/ai-approvals.html` — approvals queue dashboard
- `src/mastra/inngest/index.ts` — `ai-approval-expiry` cron (15-min interval)

**Compliance traceability (ISO / PDPL / PCI):**

| External requirement | Satisfied by |
|----------------------|--------------|
| PDPL Art. 16 (human review of automated decisions) | Every gated tool stores proposal, approval, and executor identities with timestamps |
| PDPL Art. 19–20 (data subject rights, logging) | `event_logs` row per transition with `correlation_id = action_code` |
| PCI DSS v4.0 §7.1 / §12.3.1 (restricted access, documented approval) | `APPROVER_ROLES_BY_RISK` + segregation-of-duties check |
| ISO 27001:2022 A.5.37 (documented operating procedures) | Wrapper is itself the procedure; every decision is signed |
| ISO 27001:2022 A.5.10 (authorized use of information assets) | Role gate rejects unauthorized approvers with HTTP 403 |
| ISO 9001:2015 §8.5.1 / §7.5.3 | Quality records cannot be created or modified without authorized release |

### 4.22 Handoff & Control Mapping System
**Purpose:** Automates data flow between QMS and GRC modules.

**Key Features:**
- **Handoff Rules:** Configurable automation rules that move data between modules (e.g., critical NC → enterprise risk)
- **Handoff Events:** Log of all automated data transfers with timestamps and status
- **Control Mappings:** Central mapping of internal controls to associated risks and policies, with type, coverage, and effectiveness ratings

**Backend Tables:** `handoff_rules`, `handoff_events`, `control_mappings`

### 4.23 Onboarding System
**Purpose:** Guided onboarding for new platform users.

**Key Features:**
- User onboarding status tracking per user
- Configurable onboarding tour steps
- Progress tracking through onboarding milestones

**Backend Tables:** `user_onboarding_status`, `onboarding_tour_steps`

### 4.24 Knowledge Base
**Purpose:** Centralized repository for regulatory documents, SOPs, and organizational knowledge.

**Key Features:**
- Document upload and storage with metadata
- Chunk-based full-text search across all documents
- AI-powered knowledge retrieval via the Consultant agent's `searchKnowledgeTool`
- Compliance checklist engine with automated verification

**Backend Tables:** Knowledge base tables managed by `knowledgeDatabase.ts`

### 4.25 Notification Hub
**Purpose:** Unified notification routing across channels.

**Key Features:**
- In-app notifications with severity levels
- Slack channel notifications (via `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`)
- Email notifications via Resend (with Replit mail fallback)
- Triggered by 6-hourly duplicate auto-syncs, AI scanner findings, and audit completion

---

### 4.26 Internal Audits Dashboard (`/audits`) — Programme, Triggers & Finding Traceability

**Purpose:** Single control plane for every audit the company **runs itself** — platform-driven (AI) **and** manual audits conducted by the Quality team across other departments. Covers the full ISO 19011:2018 audit cycle: programme → plan → conduct → report → follow-up.

**Two Tabs:**

1. **Internal Audits Dashboard** — live operational view (programme panel, triggers, findings, CAPA SLA).
2. **Internal Audits AI** — AI-driven audit runs (was "Quality Audits (AI)" — renamed in v3.9).

**Key Features:**

- **Annual Audit Programme Panel** (top of dashboard)
  - Draft → **Submit for sign-off** → HITL ticket routed to `/ai-approvals` for the **Head of Operations & Quality** to approve/reject.
  - Sign-off is captured with `approved_by_email`, `approved_at`, and `approval_action_code` for immutable traceability (WP-CTL-007).
  - Controlled under **WP-SOP-040 — Audit Programme Governance**.
- **Triggers (with HITL gate)**
  - Triggers remain in place (ISO 19011 §6.7 follow-up signal).
  - **Dismissal** now **requires** a written reason (≥10 chars) logged to `event_logs` and auto-re-evaluated in **24 h** (dismissed triggers flip back to `pending` via `trigger-auto-escalate` cron).
  - **Critical** triggers expose a **"Propose via HITL"** button — routes the decision through the AI Approvals Queue for Quality Manager sign-off.
  - **Auto-escalation cron (daily @ 03:00):**
    - Critical trigger pending > **7 days** → auto-generates a formal `AuditFinding` in `grc_audit_findings` with severity `major`.
    - Warning/Info pending > **30 days** → auto-generates finding with severity `minor`/`observation`.
    - Trigger is marked `actioned` with `auto_escalated_at` + `escalation_finding_id` for bi-directional linking.
- **Manual Audit Intake (button/link to `/intake`)** — see §4.27.
- **Source-party separation:** All audits carry `source_party` (`internal_platform` / `internal_manual` / `external`) and `audit_run_id` / `programme_id` / `intake_id` for lineage.

**New RBAC Role:** `head_of_operations_quality` — sole approver for annual audit programme sign-off.

**Backend Tables:** `audits` (extended), `audit_triggers` (extended with `dismiss_reason`, `next_reevaluate_at`, `hitl_action_code`, `auto_escalated_at`, `escalation_finding_id`), `audit_programme`, `audit_programme_signoff`, `audit_runs`.

**Controlling Documents:** WP-SOP-040, WP-SOP-041, WP-SOP-042, WP-FORM-055, WP-FORM-056, WP-FORM-057, WP-CTL-007.

---

### 4.27 Manual Audit Intake (`/intake`) — Off-Platform Audit Workspace

**Purpose:** Centralise every audit report that is **conducted off-platform** (e.g., a Finance process audit done on paper by the Quality team, or an ad-hoc walk-through captured in Word/PDF) so the findings still enter the **same** `grc_audit_findings` register and inherit the same CAPA SLA rules.

**Ownership:** The **Quality Manager** is the single-point intake owner (centralised to prevent shadow audit registers in each department).

**Workflow:**

1. **Upload** — Quality Manager uploads the report file (PDF/DOCX/XLSX/MD) with title, source department, audit date, auditor name.
2. **AI extraction (GPT-4o)** — structured extraction of `findings[]` with `{ title, description, severity, category, source_quote, confidence }`. For binary files where native parsing isn't yet wired, a **paste-fallback** textarea accepts raw text and routes through the same prompt.
3. **Review** — each extracted finding is reviewable: **Accept** / **Edit (title+description)** / **Reject (with reason)**. Every decision is logged.
4. **Promote** — `Finalize` button promotes all `accepted` + `edited` findings into `grc_audit_findings` with a parent `audits` row (source_party = `internal_manual`, `intake_id` preserved).

**Traceability (what makes auditors trust it):** every promoted finding carries `source_quote` (the exact paragraph the AI read it from) and a link back to the original uploaded file — so any statement can be traced to a primary document.

**Backend Tables:** `manual_audit_intake`, `manual_audit_findings`.
**Controlling Documents:** WP-SOP-041 — Manual / Off-Platform Audit Intake Control.

---

### 4.28 External Audits (`/external-audits`) — Regulatory, Certification & Surveillance

**Purpose:** Dedicated workspace for audits conducted **on** the company by third parties — regulators, certification bodies (CBs), or surveillance visits. Deliberately separated from Internal Audits (§4.26) because the governance chain, evidence expectations, and accountability differ.

**Surfaces:**

- **Summary card on `/grc`** — shows *Next Audit*, *Active Certificates*, *Expiring ≤ 90 days* (hero card linking into `/external-audits`).
- **Three tabs:**
  1. **Calendar / Audits** — chronological register filterable by kind (regulatory / certification / surveillance / customer / other) and status (planned / in progress / closed / cancelled).
  2. **Certificate Register** — all issued certificates with `certificate_number`, `standard`, `certification_body`, `issued_at`, `expires_at`, derived status (`active`/`expiring`/`expired`) and evidence link.
  3. **Readiness Checklist** — per-audit checklist (item, category, owner, status, evidence link) so readiness isn't a chase in Excel the week before the audit.

**Capabilities:**

- Create a new external audit with planned dates, scope summary, and CB.
- Register a new certificate against an external audit.
- Add / update readiness checklist items with owner + evidence link.
- Status is derived automatically (expires ≤ 90d = "expiring", past expiry = "expired") — no manual flag rot.

**Backend Tables:** `external_audits`, `external_audit_certificates`, `external_audit_checklist`.
**Controlling Documents:** WP-SOP-042 — External Audit Preparation & Surveillance Control, WP-FORM-055 (Annual Programme), WP-FORM-056 (Intake Review), WP-FORM-057 (External Audit Readiness).

---

### 4.29 Admin & Tools Dropdown — Operator Workspace

**Purpose:** A single top-nav group consolidating operator / platform-wide tooling that is **not** part of day-to-day Quality/GRC work. Separated from business modules so Quality Managers don't see RBAC panels and System Logs in their main navigation.

**Contents (role-gated):**

| Item | Route | Purpose |
|------|-------|---------|
| Data Migration Engine | `/migration` | Bulk import of spreadsheets (previously under GRC, now here). See §4.29.1. |
| User & Role Management | `/admin` | RBAC admin UI. |
| Users & Access | `/users` | User directory / access review. |
| AI Approvals Queue | `/ai-approvals` | HITL ticket queue (programme sign-off, trigger decisions, AI write-tools). |
| System Logs | `/logs` | Append-only event log (moved from Analytics). |

**Access:** `admin`, `head_of_operations_quality`, `grc_manager`, `quality_manager`, `ai_specialist`.

#### 4.29.1 Data Migration Engine — Expanded Scope

Templates now include **Quality modules** (previously only GRC):

| Template | Target Module | Source Document |
|----------|---------------|-----------------|
| Compliance Obligations Import | `compliance` | (existing) |
| Policy Library Import | `policies` | (existing) |
| Risk Register Import | `risks` | (existing) |
| Vendor Registry Import | `vendors` | (existing) |
| **CAPA Register Import** | `capa` | WP-SOP-009 |
| **Nonconformity (NC) Log Import** | `nonconformities` | WP-SOP-009 / ISO 9001 §10.2 |
| **Training Records Import** | `training` | ISO 19011:2018 §7 (auditor competence) |
| **Audit Findings Import** | `audit_findings` | WP-SOP-042 |
| **Deal Evaluations Import** | `deal_evaluations` | Internal quality scoring |

All imports run through the **same** AI column-mapper + duplicate pre-check + auditable migration job record.

---

## 5. Zoho CRM Integration

### 5.1 Connection Details
- **Access Type:** OAuth 2.0 with auto-refresh
- **Environment:** Zoho CRM Production
- **Authentication:** OAuth client credentials with refresh token
- **Token Refresh:** Automatic — tokens renew with a 5-minute buffer before expiry
- **Token Caching:** Access tokens cached in memory; auto-cleared and re-fetched on 401 errors
- **Credential Detection:** System recognizes both legacy access tokens AND OAuth credentials (Client ID + Client Secret + Refresh Token)
- **Pagination:** Supports fetching all records per module via automatic pagination (200 records/page, no hard cap by default; configurable via `maxRecords` parameter)

### 5.2 Modules Accessed

| Zoho Module | Data Read | Purpose |
|-------------|-----------|---------|
| **Leads** | Email, Phone, Lead Source, Status, Company, Region, Owner, City, No_of_Employees, Industry, Designation, Outgoing_Call_Result, Description, Tag | Quality audits, hygiene scoring, SDR SLA monitoring, duplicate detection |
| **Deals** | Deal_Name, Stage, Amount, Closing_Date, Stage_History, Account_Name, Contact_Name, Pipeline, Lead_Source, Owner, First_Call_Date, Meeting_Date, Proposal_Sent_Date, Agreement_Sent_Date, Agreement_Signed_Date, On_Hold_Reason, Probability, Bundle_Type, Discount, Onboarding_Method, Contract_No_of_Employees, Trial_Period, National_Address | Pipeline governance, Sales SLA monitoring, duplicate detection |
| **Contacts** | Email, Phone, Mobile, Last_Name, First_Name, Owner, Account_Name, Lead_Source | Data completeness checks, duplicate detection |
| **Tasks** | Subject, Due Date, Owner, Activity timestamps | Activity compliance verification |
| **Accounts** | Account_Name, Website, Email, Phone, Owner | Hygiene audits, duplicate detection |

### 5.3 CRM Functions Available

| Function | Purpose |
|----------|---------|
| `fetchZohoRecords` | Fetches a single page of records from any module |
| `fetchAllZohoRecords` | Paginated retrieval of all records per module (no hard cap; 200/page with rate-limit backoff) |
| `searchZohoRecords` | Searches records using Zoho COQL-like criteria |
| `analyzeRecordHygiene` | Validates records against 76 governance rules |
| `calculateQualityScores` | Weight-based scoring producing People, Process, Governance, and Overall scores |
| `lookupRecordsByZohoIds` | Batch lookup of Zoho record IDs against duplicate radar database for cluster cross-reference (used by CRM Data Hub enrichment) |
| `updateZohoRecord` | Updates record fields in CRM (used for evaluation logging) |
| `updateZohoRecordNotes` | Adds evaluation notes to CRM records |

### 5.4 What is NOT Accessed
- No employee/HR data
- No personal identification documents
- No financial/billing records beyond deal amounts
- Write operations limited to adding evaluation notes — no deletion or bulk modification

### 5.5 CRM Governance Rules (76 Rules)

The platform enforces 76 governance rules across three SOPs:

#### 5.5.1 Sales SOP Rules (28 Rules)

**Document:** Sales SOP v1.1, Effective 2025-12-01, Prepared by Sarah Hijazi

**Deal Stage Requirements:**

| Stage | Max Duration | Required Fields | SLA |
|-------|-------------|----------------|-----|
| New Deal | — | Company Name, Contact Person, No. of Employees, Region, Industry | Qualified lead from SDR |
| Contacted | — | First Call Activity Logged | Contact within 1 business day of SDR handoff |
| Not Attend Meeting | 5 business days | Not Attend Reason (Client emergency, Postponed, etc.) | — |
| Meeting | 10 business days | Meeting Notes, Client Requirements | — |
| Proposal | 90 days | Proposal Document Attached, Proposal Sent Date | Proposal within 2 business days of meeting |
| On Hold | 180 days | On Hold Reason (Critical, mandatory) | — |
| Agreement Sent | 90 days | Agreement Document, Sent Date | Review & signature within 10 business days |
| Agreement Signed | — | Signed Agreement, Invoice/Quotation in Zoho Books | — |
| Closed Lost | — | Closed Lost Reason (Budget, SDR Issue, Client Not Responding, etc.) | — |

**Sales SLAs:**
- Contact after SDR Handoff: ≤ 1 business day
- Proposal Preparation: ≤ 2 business days from meeting
- Agreement Review & Signature: ≤ 10 business days
- Zoho CRM Activity Logging: Same day

**Sales Qualification Criteria:**
- Market: KSA only
- Minimum Employees: 15
- Target Roles: HR, Operations, Procurement
- Target Levels: Manager, Director, Head

#### 5.5.2 SDR SOP Rules (28 Rules)

**Document:** SDR SOP v2.1, Effective 2025-12-04

**Lead Stage Requirements:**

| Stage | Max Duration | Required Fields | SLA |
|-------|-------------|----------------|-----|
| New | — | Company, Name, Phone, Email, Lead Source | Inbound: ≤ 2 hours initial contact; Outbound: ≤ 4 hours |
| Contacting | 5 business days | Outgoing Call Result | — |
| Contacted | 3 business days | Description, Tag | — |
| Qualified | 1 business day | No. of Employees (min 15), Industry, City, Designation | Handoff to Sales within 1 business day |
| Not Qualified | — | Reason (Duplicate, Competitor, Budget, etc.) | — |
| On Hold | 90 days | On Hold Reason | — |
| Nurturing | 180 days | Nurturing Description | — |

**SDR SLAs:**
- Initial Contact (Inbound): ≤ 2 hours from creation
- Outbound First Call: ≤ 4 hours from creation
- Follow-up (No Answer): ≤ 24 hours
- Handoff to Sales: ≤ 1 business day from qualification

#### 5.5.3 Account/Deal Hygiene Rules (20 Rules)

| Rule | Module | Severity | Description |
|------|--------|----------|-------------|
| Owner Required | All | High | All records must have an assigned owner |
| Deal Name | Deals | High | Deal name is required |
| Stage | Deals | High | Stage must be set |
| Amount | Deals | High | Deal amount required |
| Closing Date | Deals | High | Closing date required |
| Account Name | Deals | High | Account must be associated |
| Contact Name | Deals | High | Contact must be linked |
| Pipeline | Deals | Medium | Pipeline must be set |
| Lead Source | Deals | Medium | Lead source required |
| Employees | Deals | Medium | Number of employees required |
| Region | Deals | Medium | Region must be set |
| Industry | Deals | Medium | Industry required |
| Proposal Stage: Probability | Deals | High | Probability required (1-100%) in Proposal stage |
| Proposal Stage: Bundle Type | Deals | Medium | Bundle Type required in Proposal stage |
| Proposal Stage: Discount% | Deals | Medium | Discount (0-100%) required in Proposal stage |
| On Hold: Reason | Deals | Critical | On Hold Reason mandatory when stage is On Hold |
| Agreement Signed: Onboarding Method | Deals | High | Onboarding Method required when Agreement Signed |
| Agreement Signed: Contract Employees | Deals | High | Contract No. of Employees required |
| Business Email (Leads) | Leads | Medium | Free providers (Gmail, Yahoo, etc.) prohibited |
| Phone Format (Leads) | Leads | Medium | Must start with KSA code +966 |

### 5.6 AI Audit Process
When "Run AI Audit" is triggered (via button or weekly schedule):
1. System authenticates to Zoho CRM via OAuth (auto-refreshes tokens if expired)
2. Fetches up to 100 records per module (Leads, Deals, Contacts, Tasks)
3. Loads active scorecards and governance documents from the database
4. AI agents perform parallel audits: SDR Quality Agent audits Leads, Sales Quality Agent audits Deals
5. Falls back to direct (non-AI) rule-based audit if OpenAI keys are not configured
6. Applies 76 governance rules to each record:
   - Missing required fields (email, phone, company, etc.)
   - Format validation (email format, phone format, KSA +966)
   - Enum checks (valid lead source, deal stage values)
   - Activity compliance (overdue tasks, stale records)
   - Stage-specific requirements (Proposal fields, On Hold reason, Agreement Signed fields)
   - Business email enforcement (no free email providers for leads)
7. Calculates quality scores across three dimensions:
   - **People Score:** Owner assignment, contact completeness, activity compliance
   - **Process Score:** Stage progression, follow-up timing, task completion
   - **Governance Score:** Field completeness, naming conventions, data standards
8. Computes overall quality score (weighted average)
9. Saves results to database for trend tracking
10. Fires automated triggers:
    - `AUDIT_COMPLETED` — always
    - `NONCONFORMANCE_DETECTED` — if issues > 0
    - `CAPA_REQUIRED` — if critical/high issues found
11. Sends email report to configured recipients via Resend (with fallback to Replit mail)
12. Dashboard refreshes with updated scores

### 5.7 Regional Configuration
If your Zoho account is in the Saudi Arabia (.sa) region:
- Set `ZOHO_ACCOUNTS_URL` to `https://accounts.zoho.sa`
- Set `ZOHO_API_DOMAIN` to `https://www.zohoapis.sa`

Default (global) endpoints work for most other regions:
- `ZOHO_ACCOUNTS_URL` = `https://accounts.zoho.com`
- `ZOHO_API_DOMAIN` = `https://www.zohoapis.com`

---

## 6. AI Agents

### 6.1 Quality Specialist Agent
- Performs comprehensive CRM data hygiene audits across all modules
- Analyzes record completeness against 76 governance rules
- Generates executive summaries, AI insights, and quality improvement recommendations
- Uses configurable governance documents and scorecards
- Orchestrates the insight-generation step of the audit workflow

### 6.2 AI Consultant Agent
- GPT-4o powered QMS AI Consultant accessible at `/consultant`
- Provides real-time quality management guidance through a chat interface
- Equipped with **23 specialized tools** (see Section 7)
- Supports both standard and streaming (SSE) chat responses with AbortController timeouts
- Responds in English or Arabic based on user's language (automatic RTL detection)
- Does not expose internal tool mechanics or database queries to users
- Uses `@ai-sdk/openai` v3.x (`^3.0.29`) via Replit AI proxy (`AI_INTEGRATIONS_OPENAI_BASE_URL`)
- Can directly create/update NCs, CAPAs (with action items), manage training assignments, run checklists, and search knowledge base documents
- All database operations use shared pg.Pool (max 20 connections) via `sharedPool.ts`
- Auth guards on all endpoints (session cookie or X-Admin-Key header)

### 6.3 SDR Quality Agent
- Evaluates SDR (Sales Development Representative) performance
- Audits **Leads** module specifically using SDR-specific scorecards and 28 SDR SOP rules
- Checks CRM update compliance after calls
- Monitors SDR SLAs (initial contact timing, follow-up compliance)
- Runs in parallel with Sales Quality Agent during audits

### 6.4 Sales Quality Agent
- Monitors sales process adherence
- Audits **Deals** module specifically using Sales-specific scorecards and 28 Sales SOP rules
- Evaluates deal stage progression and pipeline hygiene
- Monitors Sales SLAs (contact after handoff, proposal timing, agreement review)
- Runs in parallel with SDR Quality Agent during audits

---

## 7. AI Tools (23 Consultant Tools + 8 Audit Tools)

### 7.1 AI Consultant Tools (23)

| # | Tool | ID | Function |
|---|------|-----|----------|
| 1 | **Query Platform Data** | `query-platform-data` | Queries data across 11 QMS modules (NCs, CAPAs, risks, policies, audits, KPIs, compliance, training, vendors, PDPL, team) |
| 2 | **Analyze Nonconformities** | `analyze-nonconformities` | NC pattern detection, overdue CAPAs, severity distribution, and trend analysis |
| 3 | **Suggest Improvements** | `suggest-improvements` | Quality score analysis with structured improvement recommendations |
| 4 | **Check Regulation Compliance** | `check-regulation-compliance` | PDPL, ISO 9001, ISO 27001, NCA ECC compliance gap checks |
| 5 | **Review Document** | `review-document` | Governance document review, gap analysis, and compliance checking |
| 6 | **Monitor Risks** | `monitor-risks` | Risk register monitoring with threshold breach detection and overdue treatment actions |
| 7 | **Monitor KPIs** | `monitor-kpis` | KPI missed targets, trends, and performance status monitoring |
| 8 | **Create Alert** | `create-alert` | AI alert creation with automatic deduplication (supports sla_breach type) |
| 9 | **Create NC** | `create-nonconformance` | Create new nonconformance records directly from chat |
| 10 | **Get NC List** | `get-nonconformance-list` | List existing nonconformances with filters |
| 11 | **Create CAPA** | `create-capa` | Create new CAPA (Corrective/Preventive Action) records |
| 12 | **Update CAPA** | `update-capa` | Update existing CAPA records with status, root cause, corrective/preventive actions |
| 13 | **Get CAPA List** | `get-capa-list` | List existing CAPAs with filters |
| 14 | **Get CAPA Details** | `get-capa-details` | Retrieve detailed CAPA info including action items |
| 15 | **Add CAPA Action** | `add-capa-action` | Add action items to a CAPA record (immediate, corrective, preventive, verification) |
| 16 | **Run Checklist** | `run-checklist` | Execute compliance checklists against live platform data |
| 17 | **Manage Checklist** | `manage-checklist` | Create, update, or view compliance checklists |
| 18 | **Search Knowledge Base** | `search-knowledge-base` | Search regulatory knowledge base, SOPs, and uploaded documents |
| 19 | **Create Training** | `create-training` | Create new training courses/programs in the system |
| 20 | **Get Training List** | `get-training-list` | List available training courses with filtering by type, status |
| 21 | **Assign Training** | `assign-training` | Assign training to employees with due dates |
| 22 | **Get Training Assignments** | `get-training-assignments` | Retrieve training assignments with filters (employee, status, training) |
| 23 | **Complete Training** | `complete-training` | Mark training assignments as completed with optional assessment scores |

### 7.2 Audit & Analysis Tools (8)

| Tool | Function |
|------|----------|
| **CRM Hygiene Audit** | Audits Zoho CRM records for data quality issues across modules |
| **CRM Activity Check** | Verifies activity compliance, follow-up timing, and task completion |
| **Call Analysis** | AI-powered call recording analysis with quality scoring |
| **Call Ingest** | Processes and stores call recordings for analysis |
| **CRM Compliance** | Validates post-call CRM updates (was CRM updated after call?) |
| **Deal Evaluation** | Assesses deal quality, risk factors, and progression compliance |
| **Meeting MOM** | Minutes of Meeting generation from call/meeting data |
| **Email Reports** | Automated email report delivery via Resend (with Replit mail fallback) |

---

## 8. Automated Workflows

### 8.1 Quality Audit Workflow
- **Trigger:** Manual (via Run AI Audit button or API call) or Cron schedule
- **Schedule:** Every Monday at 8:00 AM (configurable via `SCHEDULE_CRON_EXPRESSION`)
- **Engine:** Inngest-first with direct execution fallback. The audit trigger endpoint (`/api/audit/trigger`) first attempts to send an Inngest event (`replit/cron.trigger`). If Inngest dispatch fails (e.g., no Inngest Cloud configured), it falls back to `runDirectAudit()` (`src/utils/directAuditRunner.ts`) which executes in-process (fire-and-forget, non-blocking HTTP response).
- **Steps:**
  1. `validate-environment` — Checks Zoho credentials and OpenAI API keys
  2. `fetch-calendar-events` — Retrieves Google Calendar events for the last 7 days
  3. `audit-crm-with-agent` — Parallel AI audit of Leads (SDR agent) and Deals (Sales agent), with direct-logic fallback
  4. `generate-insights` — AI-generated executive summary and recommendations
  5. `send-report` — Email delivery, database persistence, and trigger firing
- **Output:** Updated quality scores, issue reports, trend data, email notifications, automated triggers

### 8.2 AI Background Scanner
- **Trigger:** Inngest cron — every 6 hours (`0 */6 * * *`, configurable via `AI_SCANNER_CRON`)
- **Purpose:** Proactively scans platform data for quality and compliance issues, creating AI alerts
- **Architecture:** All 14 checks run in parallel via `Promise.all` for performance; errors are captured in `ScanResult.errors[]` without stopping other checks; all database queries use `sharedPool.ts` (shared pg.Pool, max 20 connections); alert creation uses `createAlertIfNew` deduplication (no duplicate alerts for same finding)
- **Checks performed (14 total, parallelized):**
  1. **Nonconformances without CAPA** — Open NCs older than 7 days with no linked CAPA record
  2. **High-severity risks** — Risks with likelihood × impact ≥ 15 without treatment plans
  3. **Overdue risk treatment actions** — Treatment actions past their due date (uses `action_description` column)
  4. **Low-progress treatments** — Treatments due within 14 days but less than 50% complete
  5. **KPIs missing target** — KPI entries below their defined target values (uses `kpi_id` join column)
  6. **Expiring/expired policies** — Governance documents with review dates within 30 days or past
  7. **PDPL compliance gaps** — Checks 3 conditions: empty data inventory, no active AI guardrails, open data incidents
  8. **Audit score decline** — Detects declining trend across 3+ recent audits with >5% cumulative drop
  9. **Training compliance gaps** — Overdue training assignments past due date
  10. **Sales SLA violations** — Scans up to 500 Deals for: late first contact (>2 biz days), late proposal (>3 biz days), pending agreement (>14 days), stale CRM (>3 biz days no update), stage aging exceeding SOP maximums
  11. **SDR SLA violations** — Scans up to 500 Leads for: late initial contact (inbound >2h, outbound >4h), stuck in Contacting/Contacted (>5 days), lead aging exceeding SOP stage maximums
  12. **High-confidence duplicates** — Flags active duplicate clusters with confidence ≥90% and total estimated pipeline inflation
  13. **CAPA recurrence detection** — Identifies similar CAPAs that may indicate recurring systemic issues
  14. **Auto-NC from critical SLA breaches** — Automatically creates nonconformance records from critical SLA breach alerts (status `IN ('open', 'acknowledged')`, last 24 hours)
- **Output:** Creates deduplicated AI alerts in the `ai_alerts` table with severity levels (critical, high, medium, low)
- **Alert Types:** `nc_detection`, `risk_alert`, `kpi_miss`, `policy_expiry`, `regulation_gap`, `audit_decline`, `training_gap`, `improvement`, `sla_breach`, `doc_review`
- **Alert bell:** Navigation bar displays unread alert count badge, polls `/api/consultant/alerts/count` every 60 seconds
- **Scan prompt:** Report-only mode — scan presents findings for user review; does NOT auto-create alerts, NCs, or CAPAs unless explicitly confirmed by user

### 8.3 KPI Auto-Calculation
- **Trigger:** Inngest cron — daily at 2:00 AM (`0 2 * * *`, configurable via `KPI_AUTO_CALC_CRON`)
- **Purpose:** Automatically calculates 6 platform KPIs from live data
- **KPIs Calculated:**
  1. Governance Doc Lifecycle compliance
  2. Compliance Obligation Tracking
  3. Audit Evidence Pack Readiness
  4. Quality→GRC Handoff activity
  5. Risk Register Hygiene
  6. Executive Reporting Readiness

### 8.4 Duplicate Radar Auto-Sync
- **Trigger:** Inngest cron — every 6 hours (`0 */6 * * *`, configurable via `DUPLICATE_SCAN_CRON`)
- **Function ID:** `duplicate-radar-auto-sync`
- **Purpose:** Automated CRM data synchronization and duplicate detection across all modules (Leads, Deals, Contacts, Accounts)
- **Process:** Two-step pipeline:
  1. `sync-crm-data` — Calls `syncAllModules('incremental')` which fetches records modified since last sync from Zoho, upserts them into the local database, assesses data quality per record, quarantines junk records, fetches and stores linked Zoho Tasks, and updates sync state per module
  2. `detect-duplicates` — Calls `runDuplicateDetection()` which re-clusters all locally synced records and updates cluster statistics
- **Notification:** If high-confidence duplicates are found, sends notification via the Notification Hub with:
  - Total records synced
  - Duplicate clusters detected
  - High-confidence count
  - Estimated pipeline inflation (SAR)
  - Link to `/duplicates` dashboard

### 8.5 Automated Triggers
- **AUDIT_COMPLETED:** Fires after every successful audit
- **NONCONFORMANCE_DETECTED:** Fires when issues are found during an audit
- **CAPA_REQUIRED:** Fires when critical or high-severity issues are detected
- Triggers appear in the QMS Dashboard **Triggers** tab
- Actions: Acknowledge, Dismiss, or Decide (approve/reject)

### 8.6 External Notification Triggers
- **Cron Triggers:** Configurable scheduled triggers for weekly/monthly audits (`src/triggers/cronTriggers.ts`)
- **Slack Integration:** Automated notifications to Slack channels (`src/triggers/slackTrigger.ts`). Uses `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` environment variables.
- **Telegram Integration:** Automated notifications to Telegram chats (`src/triggers/telegramTrigger.ts`). Webhook endpoint protected by `TELEGRAM_WEBHOOK_SECRET` query parameter validation when the secret is configured.
- **Linear Webhook Integration:** Issue-created webhook handler (`src/triggers/exampleConnectorTrigger.ts`) with full HMAC-SHA256 signature verification when `LINEAR_WEBHOOK_SECRET` is configured. The handler computes `createHmac('sha256', secret).update(rawBody).digest('hex')` and compares against the `Linear-Signature` header using `timingSafeEqual` for constant-time comparison. Requests with invalid signatures are rejected with 403.

---

## 9. Security Architecture

### 9.1 Authentication
- **Replit OIDC:** Primary login via Replit's OpenID Connect provider (`authRoutes.ts`). Discovery URL: `https://replit.com/oidc`
- **Supported providers:** Google, GitHub, Apple, and email (via Replit OIDC)
- **OIDC callback:** `/api/callback` handles token exchange, nonce verification (v3.6), user profile sync, and session creation
- **OIDC nonce verification (v3.6):** The authorization flow generates a cryptographic nonce stored inside the `oauth_data` HttpOnly cookie (as part of a base64url-encoded JSON payload alongside state and PKCE verifier). On callback, the `id_token` nonce claim is parsed from the JWT payload and verified against the stored nonce to prevent replay attacks. Mismatches redirect to `/login?error=nonce_mismatch`.
- **Session signing:** HMAC-SHA256 signed stateless tokens (`signSession()` / `verifySession()` in `authRoutes.ts`)
- **Session cookie:** `walaplus_session` — HttpOnly, Secure, SameSite=Lax, 7-day expiry (`SESSION_MAX_AGE = 604800`)
- **Logout:** POST-only `/api/logout` — clears session cookie, prevents CSRF-based logout
- **Admin API Key:** Alternative auth via `X-Admin-Key` header or `admin_key` cookie for system-level/automated access. Admin key login (via `/api/admin/auth`) sets an HttpOnly `admin_key` cookie (8-hour expiry, SameSite=Lax). Both page-level middleware and API-level middleware accept the `admin_key` cookie for authentication, allowing admin key users full dashboard and API access.
- **Admin key login flow:** Login page (`/login`) offers admin key entry → POST `/api/admin/auth` validates key → sets `admin_key` cookie → redirects to `/` (dashboard)
- **User sync:** `upsertOidcUser()` syncs OIDC profile to `platform_users` table (email, name, picture, auth_provider)
- **MFA:** Database schema supports `mfa_enabled` and `mfa_secret` fields (available for future activation)

### 9.2 Authorization
- **RBAC:** Centralized role-based access control enforced globally via route permission map
- **11 roles** with granular per-endpoint permissions (see Section 3.1): admin, quality_manager, quality_specialist, grc_manager, team_lead, department_viewer, auditor, ai_specialist, bu_owner, executive, custom
- **Permission examples:** `can_accept_risk`, `can_approve_policy`, `can_close_finding`, `can_manage_users`
- **Admin API Key:** Alternative authentication via `X-Admin-Key` header or `admin_key` cookie for system-level or automated access
- **Route-level auth enforcement (v3.6):** All API endpoints across RBAC, PDPL, Call Intelligence, and Duplicate Radar modules require authentication — unauthenticated requests return `401 Authentication required`. All four modules uniformly use `requireAdminOrKey` (admin API key or authenticated session). Call Intelligence uses a `verifyAdminKey` wrapper that delegates to `requireAdminOrKey`. Other modules (ROI, Audit, Risk, Vendor, Compliance, Handoff, Migration) use `requireWriteRole` for write operations.
- **Policy approval gate:** GRC Manager role required to approve policies before publication
- **Escalation:** Overdue CAPAs and risk treatments automatically escalated to executive level

### 9.3 Data Protection
- **CSP:** Content Security Policy with `'unsafe-inline'` for `script-src` to support inline event handlers (`onclick` attributes used throughout dashboard HTML). `unsafe-eval` removed. `style-src` retains `unsafe-inline` for CDN Tailwind CSS compatibility. Nonce-based CSP was previously implemented but removed in v3.5 because CSP Level 3 browsers ignore `'unsafe-inline'` when a nonce is present — this silently blocked all `onclick` handlers across the dashboard (login button, audit triggers, filter buttons).
- **CSP directive:** `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://replit.com https://accounts.google.com https://oauth2.googleapis.com; frame-ancestors 'none'; form-action 'self'`
- **SQL injection prevention (v3.6):** All dynamic SQL interval expressions use parameterized `make_interval(days => $N)` with integer clamping (1–365 days) instead of string interpolation. Affected functions: `getTrendData()`, `getRiskTrends()`, `getUpcomingDeadlines()`.
- **Path traversal prevention (v3.6):** Screenshot endpoint (`/docs/screenshots/:filename`) validates filenames against `..`, `/`, `\\` traversal characters and enforces image extension allowlist (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`).
- **Input sanitization** (`inputSanitizer.ts`):
  - HTML/script tag stripping (XSS prevention)
  - CSV formula injection prevention (prefixes `=`, `+`, `-`, `@` with single quote)
  - Prototype pollution protection (blocks `__proto__`, `constructor`, `prototype` keys)
  - Field whitelisting per module (only recognized fields processed)
- **Rate limiting** (`rateLimiter.ts`): Tiered in-memory rate limiter, per IP, 60-second sliding window:
  - Authenticated: READ_LIMIT=100, WRITE_LIMIT=10 requests/min
  - Unauthenticated: UNAUTH_READ_LIMIT=10, UNAUTH_WRITE_LIMIT=3 requests/min
  - Auth endpoints (`/api/auth/`, `/login`): AUTH_LIMIT=5 requests/min
  - Export endpoints (`/export`, `/pdf`): EXPORT_LIMIT=10 requests/min
  - Audit trigger: Additional 60-second cooldown to prevent duplicate runs
  - Exceeding limits returns `429 Too Many Requests` with `Retry-After` header
- **Endpoint enumeration prevention:** Unauthenticated requests to any protected API endpoint return `401 Authentication required` regardless of whether the endpoint exists, preventing enumeration
- **Resource ID obfuscation:** UUID public_id columns on 9+ tables (enterprise_risks, risk_treatment_actions, vendors, policies, audits, regulations, obligations, compliance_assessments, team_feedback). API responses use `obfuscateResourceIds()` and `resolveGenericId()` to map between internal IDs and public UUIDs
- **Password policy:** 12+ characters, uppercase, lowercase, number, special character (`validatePassword()` in `inputSanitizer.ts`)
- **Error handling:** Generic error messages only — internal errors (e.g., unique constraint violations) mapped to user-friendly messages; no raw error exposure (`scrubErrorMessage()` in `inputSanitizer.ts`)
- **CORS:** Dynamically validates origins against `REPLIT_DOMAINS`, enforces `Access-Control-Allow-Credentials: true` (no wildcard)
- **Security headers:**
  - `X-Frame-Options: DENY` (anti-clickjacking)
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-XSS-Protection: 1; mode=block`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()` (disabled by default)
  - CSP `frame-ancestors 'none'`

### 9.4 Penetration Testing
- **37 out of 37 findings remediated** across VAPT v1, v2, v3, and retest rounds
- Pentest v4 retest (April 2, 2026): 31/37 initially confirmed fixed; remaining 5 subsequently remediated
- All critical, high, medium, and low severity issues now resolved
- Final 5 findings closed (April 8–9, 2026, post-retest):
  - **QMS-024** (Medium): CSP `script-src` hardened — `unsafe-eval` removed. `'unsafe-inline'` retained for `script-src` because dashboard HTML uses `onclick` inline handlers throughout; nonce-based CSP was attempted but removed after discovering CSP Level 3 browsers ignore `'unsafe-inline'` when a nonce is present, silently blocking all inline event handlers. XSS risk mitigated by input sanitization (`inputSanitizer.ts`), HTML tag stripping, and strict `connect-src`/`frame-ancestors` directives.
  - **QMS-026** (Medium): Tiered rate limiting enforced on ALL requests including unauthenticated: 10 read / 3 write req/min for unauthenticated; 100 read / 10 write for authenticated. Auth endpoints: 5/min.
  - **QMS-031** (Low): Unauthenticated requests to protected API endpoints return consistent `401 Authentication required` regardless of endpoint existence, preventing enumeration. Authenticated enumeration mitigated by RBAC permission checks returning `403`.
  - **QMS-032** (Low): UUID `public_id` columns added to 9+ tables. API responses use `obfuscateResourceIds()` to replace sequential IDs with `R-XXXXXXXX` format references.
  - **QMS-036** (Low): Export CSV and feedback endpoints stabilized; all return HTTP 200 with proper error handling.
- Detailed documentation: `docs/VAPT_Remediation_Report.md`, `docs/Pentest_v3_Detailed_Remediation_Report.md`

---

## 10. Environment Configuration

### 10.1 Required Secrets

| Secret | Purpose | Notes |
|--------|---------|-------|
| `DATABASE_URL` | PostgreSQL connection string | Auto-provided if using Replit's DB |
| `SESSION_SECRET` | Session cookie HMAC signing | Any random long string |
| `ADMIN_API_KEY` | Admin panel and API access | Strong key, e.g. 64-char hex |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth | From Zoho API Console |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth | From Zoho API Console |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM OAuth | Generated during CRM authorization |

### 10.2 Optional but Recommended Secrets

| Secret | Default | Purpose |
|--------|---------|---------|
| `ZOHO_ACCOUNTS_URL` | https://accounts.zoho.com | Zoho OAuth endpoint (use .sa for Saudi region) |
| `ZOHO_API_DOMAIN` | https://www.zohoapis.com | Zoho API domain (use .sa for Saudi region) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | — | OpenAI API key (Replit-managed, preferred) for AI audits and AI Consultant |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | https://api.openai.com/v1 | Replit AI proxy endpoint |
| `OPENAI_API_KEY` | — | Direct OpenAI API key (fallback if Replit-managed key unavailable) |
| `SLACK_BOT_TOKEN` | — | Slack Bot token for QMS notifications |
| `SLACK_CHANNEL_ID` | — | Slack channel ID for QMS alert notifications |
| `RESEND_API_KEY` | — | Email delivery via Resend |
| `RESEND_FROM_EMAIL` | — | Sender address for quality report emails |
| `TELEGRAM_WEBHOOK_SECRET` | — | Telegram webhook secret for validating incoming webhook requests |
| `LINEAR_WEBHOOK_SECRET` | — | Linear webhook HMAC signing secret for signature verification |

### 10.3 Configurable Cron Schedules

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `SCHEDULE_CRON_EXPRESSION` | `0 8 * * 1` | Quality audit (Monday 8 AM) |
| `KPI_AUTO_CALC_CRON` | `0 2 * * *` | KPI auto-calculation (daily 2 AM) |
| `AI_SCANNER_CRON` | `0 */6 * * *` | AI background scanner (every 6 hours) |
| `CONSULTANT_CHAT_TIMEOUT` | `120000` | AI Consultant chat request timeout in ms (120s default) |
| `CONSULTANT_SCAN_TIMEOUT` | `300000` | AI Consultant scan request timeout in ms (300s default) |
| `DUPLICATE_SCAN_CRON` | `0 */6 * * *` | Duplicate Radar auto-sync (every 6 hours) |

### 10.4 Reference File
A `.env.example` file is included in the project root with all variables documented. Do not deploy this file.

---

## 11. Database

- **Engine:** PostgreSQL
- **Tables:** 105+ auto-initialized tables (created on first use, no manual migration needed)
- **Key Table Groups:**

| Group | Count | Tables | Purpose |
|-------|-------|--------|---------|
| QMS | 11 | evaluation_frameworks, evaluation_criteria, deal_evaluations, capa_records, capa_action_items, nonconformance_records, training_records, training_assignments, audit_findings, quality_metrics, qms_documents | Quality management operations |
| Quality Core | 4 | quality_scorecards, quality_audit_results, quality_trends, governance_documents | Audit results and quality tracking |
| Risk | 4 | enterprise_risks, risk_treatment_actions, risk_assessment_history, risk_categories | Risk registry and treatment plans |
| Compliance | 4 | regulations, obligations, compliance_assessments, compliance_calendar | Regulatory compliance tracking |
| Audit | 7 | audits, grc_audit_findings, evidence_packs, audit_checklists, audit_triggers, audit_notifications, audit_trail | Audit readiness, evidence, and trail |
| Policy | 4 | policies, policy_versions, policy_acknowledgments, policy_review_cycles | Policy governance lifecycle |
| Users & RBAC | 9 | system_users, platform_users, user_invitations, bu_processes, role_permissions, screen_permissions, data_scopes, access_audit_log, escalation_log | User management and access control |
| Call Intelligence | 8 | call_records, call_transcripts, call_analysis, call_qa_scores, call_compliance, meeting_mom, ai_training_feedback, sdr_call_evaluations | Call analysis, compliance, and AI training |
| PDPL Privacy | 6 | data_inventory, dsar_requests, retention_policies, data_incidents, ai_guardrails, pdpl_audit_log | Data protection and privacy |
| ROI Engine | 8 | roi_initiatives, roi_manpower_breakdown, roi_platform_costs, roi_error_costs, roi_ai_validation_logs, roi_revenue_impact, roi_implementation_breakdown, roi_risk_inputs | Financial analysis and risk inputs |
| Vendor | 3 | vendors, vendor_assessments, vendor_remediations | Vendor risk management |
| Handoff & Controls | 3 | handoff_rules, handoff_events, control_mappings | Cross-module automation |
| Team & Projects | 11 | team_members, team_performance_metrics, team_project_assignments, pmp_projects, project_risks, project_milestones, project_stakeholders, project_team_assignments, project_procurement, project_change_requests, training_courses | Team, project, and training management |
| Scorecard | 2 | employee_scorecards, course_assignments | Performance scorecards and course tracking |
| Duplicate Radar | 7 | duplicate_clusters, duplicate_records, duplicate_merge_actions, duplicate_detection_logs, duplicate_export_logs, zoho_sync_state, duplicate_record_tasks | CRM deduplication, merge workflow, sync tracking, linked tasks, and audit |
| Onboarding | 2 | user_onboarding_status, onboarding_tour_steps | User onboarding |
| Event Logs | 1 | event_logs | System audit trail |
| KPI & Reporting | 3 | kpi_definitions, kpi_entries, executive_reports | KPI tracking and executive reporting |
| AI Consultant | 2 | ai_alerts, knowledge_documents | AI-generated alerts, background scan findings, knowledge base documents |
| Migration | 4 | demo_links, tooltip_definitions, integration_config, team_feedback | Migration support, UI config, and feedback |
| Knowledge Base | 2+ | knowledge documents, knowledge chunks | Document storage and search |

---

## 12. API Architecture

### 12.1 Core API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/dashboard` | GET | Aggregated dashboard data |
| `/api/audit/trigger` | POST | Manual trigger for Quality Audit workflow |
| `/api/integrations/status` | GET | Status of Zoho CRM, Google Calendar, and Email integrations |
| `/api/crm/data` | GET | Fetches live records from Zoho CRM |
| `/api/inngest` | POST | Inngest webhook for workflow execution |
| `/api/health` | GET | Platform health check |
| `/api/smoke` | GET | Smoke test endpoint |

### 12.2 Module API Endpoints

| Module | Base Path | Operations |
|--------|-----------|------------|
| Auth | `/api/auth/`, `/api/login`, `/api/callback`, `/api/logout` | Login, callback, session check, logout |
| Audits | `/api/audits/` | Latest results, history, summary |
| QMS | `/api/qms/evaluations`, `/api/qms/capa`, `/api/qms/nc`, `/api/qms/training` | CRUD for all QMS entities |
| QMS Enhanced | `/api/qms/*/export`, `/api/qms/*/bulk-update` | Evidence, CSV exports, bulk updates, change history, closure approval, CAPA effectiveness |
| Risks | `/api/risks/` | CRUD, summary, heat map, CSV export |
| Policies | `/api/policies/` | CRUD, lifecycle transitions, acknowledgments |
| Compliance | `/api/compliance/` | Assessments, regulations, obligations |
| Vendors | `/api/vendors/` | CRUD, assessments, summary |
| ROI | `/api/roi/` | Initiative CRUD, financial calculations |
| Call Intelligence | `/api/calls/` | Analysis, transcripts, QA scores |
| PDPL | `/api/pdpl/` | Data inventory, DSAR, incidents |
| RBAC | `/api/rbac/` | Permissions, roles, data scopes |
| Handoff | `/api/handoff/` | Rules, events, control mappings |
| Admin | `/api/admin/documents`, `/api/admin/scorecards` | Governance document and scorecard CRUD |
| AI Consultant | `/api/consultant/chat`, `/api/consultant/chat/stream`, `/api/consultant/alerts`, `/api/consultant/scan`, `/api/consultant/scan-stream`, `/api/knowledge/upload-file` | AI chat (standard + SSE stream), alerts (CRUD + actions), background scanning (standard + SSE stream), file upload |
| Duplicates | `/api/duplicates/` | Clusters, scan, search, merge, accountability, export (30 endpoints — see Section 4.15) |
| KPIs | `/api/kpis/`, `/api/kpis/seed-sdr` | KPI definitions, entries, SDR seed |
| Scorecard | `/api/scorecard/` | Employee scorecards, snapshots |
| Notifications | `/api/notifications/` | Notification management, health index |
| Knowledge | `/api/knowledge/` | Document CRUD, search, checklists |

### 12.3 Route Files (31)

| Route File | Module |
|------------|--------|
| `auditRoutes.ts` | Quality audit triggers and results |
| `authRoutes.ts` | OIDC login, callback, session |
| `callIntelligenceRoutes.ts` | Call analysis and QA |
| `complianceRoutes.ts` | Compliance assessments |
| `consultantRoutes.ts` | AI consultant chat and alerts |
| `dashboardRoutes.ts` | Dashboard aggregation |
| `duplicateRadarRoutes.ts` | Duplicate detection and merge (30 endpoints) |
| `eventLogsRoutes.ts` | System event logs |
| `handoffRoutes.ts` | QMS↔GRC handoff |
| `knowledgeRoutes.ts` | Knowledge base and checklists |
| `kpiRoutes.ts` | KPI definitions and entries |
| `migrationRoutes.ts` | Data migration tools |
| `notificationRoutes.ts` | Notifications and health index |
| `onboardingRoutes.ts` | User onboarding |
| `pdplRoutes.ts` | PDPL privacy compliance |
| `pmpRoutes.ts` | Project management |
| `policyRoutes.ts` | Policy lifecycle |
| `qmsEnhancedRoutes.ts` | Evidence, export, bulk ops, change history |
| `rbacRoutes.ts` | RBAC permissions and roles |
| `reportRoutes.ts` | Report generation |
| `riskRoutes.ts` | Risk register |
| `roiRoutes.ts` | ROI evaluation |
| `scorecardRoutes.ts` | Scorecards |
| `smokeTestRoutes.ts` | Health/smoke checks |
| `tablefRoutes.ts` | Table F governance |
| `teamRoutes.ts` | Team management |
| `triggerRoutes.ts` | Automated triggers |
| `userAccessRoutes.ts` | User management |
| `vendorRoutes.ts` | Vendor management |

### 12.4 Utility Modules (47)

| Utility | Purpose |
|---------|---------|
| `zohoCRM.ts` | Zoho CRM OAuth, fetch, search, hygiene analysis, 76 governance rules |
| `governanceRules.ts` | Sales SOP (28 rules) + SDR SOP (28 rules) |
| `database.ts` | Core PostgreSQL database operations |
| `duplicateRadarDatabase.ts` | Multi-signal duplicate detection, merge workflow, owner accountability, `lookupRecordsByZohoIds()` batch lookup for CRM Data Hub enrichment |
| `aiBackgroundScanner.ts` | 14-check background scanner (parallelized via Promise.all) |
| `aiAlertsDatabase.ts` | AI alerts CRUD, dedup, unread count |
| `kpiDatabase.ts` | KPI definitions, entries, 11 SDR KPIs seed |
| `scorecardDatabase.ts` | Scorecard management |
| `qmsDatabase.ts` | QMS operations |
| `riskDatabase.ts` | Risk management + UUID obfuscation |
| `complianceDatabase.ts` | Compliance tracking |
| `policyDatabase.ts` | Policy lifecycle |
| `vendorDatabase.ts` | Vendor management |
| `callIntelligenceDb.ts` | Call analysis storage |
| `roiDatabase.ts` | ROI financial calculations |
| `pdplDatabase.ts` | PDPL privacy management |
| `teamDatabase.ts` | Team operations |
| `auditDatabase.ts` | Audit results |
| `auditTriggerDatabase.ts` | Audit trigger management |
| `handoffDatabase.ts` | Handoff rules/events |
| `eventLogsDatabase.ts` | Event log storage |
| `rbacDatabase.ts` | RBAC permissions |
| `userAccessDatabase.ts` | User account management |
| `knowledgeDatabase.ts` | Knowledge base, chunk-based search |
| `checklistDatabase.ts` | Compliance checklists |
| `evidenceDatabase.ts` | Evidence/document management |
| `changeHistoryDatabase.ts` | NC/CAPA change audit trail |
| `onboardingDatabase.ts` | Onboarding status |
| `migrationDatabase.ts` | Migration data |
| `notificationHub.ts` | Unified notification routing (email, Slack, in-app) |
| `directAuditRunner.ts` | Direct audit execution fallback |
| `evaluationSchema.ts` | Evaluation framework schemas |
| `reportGenerator.ts` | Report generation |
| `exportUtils.ts` | CSV export utilities |
| `inputSanitizer.ts` | XSS/injection prevention, field whitelisting |
| `rateLimiter.ts` | Tiered rate limiting |
| `rbacMiddleware.ts` | Auth middleware (requireAdminOrKey, requireWriteRole) |
| `slackNotifications.ts` | Slack message delivery |
| `googleCalendar.ts` | Google Calendar integration |

---

## 13. Dashboard Pages (31)

| Page | URL | Purpose |
|------|-----|---------|
| `index.html` | `/` | Quality Dashboard (main) |
| `login.html` | `/login` | Authentication page |
| `admin.html` | `/admin` | Administration panel |
| `audits.html` | `/audits` | Audit readiness |
| `calls.html` | `/calls` | Call intelligence |
| `compliance.html` | `/compliance` | Compliance tracking |
| `consultant.html` | `/consultant` | AI Consultant chat |
| `crm.html` | `/crm` | CRM Data Hub (quality enrichment + duplicate cross-reference) |
| `duplicates.html` | `/duplicates` | Duplicate Radar |
| `executive.html` | `/executive` | Executive dashboard |
| `feedback.html` | `/feedback` | User feedback |
| `grc.html` | `/grc` | GRC Control Tower |
| `guide.html` | `/guide` | Platform user guide |
| `kpis.html` | `/kpis` | KPI tracking |
| `logs.html` | `/logs` | System event logs |
| `migration.html` | `/migration` | Data migration |
| `onboarding.html` | `/onboarding` | User onboarding |
| `pdpl.html` | `/pdpl` | PDPL privacy compliance |
| `policies.html` | `/policies` | Policy governance |
| `projects.html` | `/projects` | PMP projects |
| `qms.html` | `/qms` | QMS dashboard (Audit Reports) |
| `risks.html` | `/risks` | Risk register |
| `roi.html` | `/roi` | ROI/NPV evaluation |
| `scorecard.html` | `/scorecard` | Performance scorecards |
| `tablef.html` | `/tablef` | Table F governance |
| `team.html` | `/team` | Team performance |
| `users.html` | `/users` | User access control |
| `vendors.html` | `/vendors` | Vendor management |
| `accept-invite.html` | `/accept-invite` | Invitation acceptance |

---

## 14. Deployment

- **Hosting:** Replit Autoscale
- **Domain:** https://qms-dashboard.replit.app
- **Process:** Publish via Replit dashboard (automatic build, TLS, health checks)
- **Server:** Mastra dev server on port 5000 serving both API and HTML dashboards
- **Inngest:** Dev server on port 3000 available for workflow orchestration (preferred path for audit triggers when Inngest Cloud is configured; direct execution fallback when unavailable)
- **Auto-restart:** Health checks ensure uptime

---

## 15. First Steps After Deployment

1. **Set all secrets** in the Replit Secrets tab (see Section 10)
2. **Open the platform** at https://qms-dashboard.replit.app
3. **Log in** using any supported provider (Google, GitHub, Apple, or email)
4. **Go to `/admin`** and enter your ADMIN_API_KEY to access admin features
5. **Upload governance documents** via Admin Panel — these define the rules AI agents use during audits
6. **Configure scorecards** via Admin Panel — these define evaluation criteria for SDR and Sales agents
7. **Run your first AI Audit:** Go to `/` (Quality Dashboard) and click "Run AI Audit" — this pulls live data from Zoho CRM
8. **Seed SDR KPIs:** Call `POST /api/kpis/seed-sdr` to initialize 11 SDR KPIs
9. **Run Duplicate Radar:** Go to `/duplicates` and click "Scan from Zoho" to detect duplicates across CRM
10. **Check `/grc`** — verify the Audit Readiness table loads with audit records
11. **Check `/policies`** — click "New Policy" and create a test policy to verify the workflow
12. **Check `/team`** — use the "Add Member" button to register team members
13. **Check `/qms`** — verify the Audit Runs card displays and try creating a test NC via "New NC"
14. **Check `/pdpl`** — set up data inventory and retention policies
15. **Check `/consultant`** — ask the AI Consultant a question like "What is the current quality score?" to verify the AI integration
16. **Check `/kpis`** — verify KPI definitions appear and auto-calculation is scheduled

---

## 16. Data Protection & PDPL Compliance

### 16.1 Data Protection Officer (DPO)
- The organization must designate a DPO responsible for overseeing PDPL compliance
- DPO contact details should be configured in the PDPL module (`/pdpl`)
- The DPO is responsible for: data processing oversight, breach notification, DSAR coordination, and cross-border transfer reviews

### 16.2 Data Processing Register
The PDPL module (`/pdpl`) maintains a register of all data processing activities via the `data_inventory` table, including:
- **Processing purpose** for each data category
- **Legal basis** for processing (consent, legitimate interest, contractual necessity, legal obligation)
- **Data categories** processed (CRM records: names, emails, phone numbers, company details, deal amounts)
- **Data subjects** (leads, contacts, account holders in Zoho CRM)
- **Recipients** (internal platform users only — no data shared with third parties)
- **Retention periods** (see Section 16.5)

### 16.3 Breach Notification Procedure
In the event of a personal data breach (tracked in `data_incidents` table):

| Step | Action | Timeline | Responsible |
|------|--------|----------|-------------|
| 1 | Detect breach via security monitoring or user report | Immediate | Any user / Admin |
| 2 | Assess scope, affected data subjects, and severity | Within 4 hours | Admin + DPO |
| 3 | Contain the breach (revoke tokens, disable access) | Within 4 hours | Admin |
| 4 | Notify SDAIA (Saudi Data & AI Authority) if breach poses risk to data subjects | Within 72 hours | DPO |
| 5 | Notify affected data subjects if high risk | Without undue delay | DPO |
| 6 | Document breach in event logs (`/logs`) and `data_incidents` table | Ongoing | Admin |
| 7 | Post-incident review and corrective actions | Within 5 business days | DPO + Admin |
| 8 | Create CAPA record in QMS for root cause analysis | Within 5 business days | Quality Manager |

### 16.4 Cross-Border Data Transfer Controls
- WalaPlus is hosted on Replit infrastructure (US-based servers)
- CRM data is read from Zoho CRM via OAuth 2.0 for two purposes:
  - **AI Audits:** Records are processed in-memory and only aggregated quality metrics (scores, issue summaries) are stored
  - **Duplicate Radar sync:** Full CRM records (names, emails, phones, company names, owners, stages, etc.) are persisted in the `duplicate_records` table for ongoing duplicate detection, data quality scoring, and cross-module matching. This data is incrementally updated every 6 hours via the auto-sync cron
- **CRM Data Hub enrichment:** Records from live Zoho API calls are scored in-memory via `assessDataQuality()` and cross-referenced against the persisted `duplicate_records` table; no additional CRM data is persisted by this endpoint
- Cross-border transfer is justified under PDPL Article 29 (legitimate business interest with adequate protection). The persisted CRM data in `duplicate_records` is subject to the data retention schedule below

### 16.5 Data Retention Schedule
Retention policies are configurable via the `retention_policies` table in the PDPL module:

| Data Category | Retention Period | Disposal Method |
|---------------|-----------------|-----------------|
| Audit results and quality scores | 3 years | Database deletion |
| Event logs | 1 year | Automatic purge |
| User session data | 7 days (cookie expiry) | Automatic expiry |
| CAPA and NC records | 5 years (regulatory) | Database deletion with approval |
| CRM data (AI audit in-memory) | Duration of audit only | Not persisted |
| CRM data (Duplicate Radar sync) | Retained until record is marked stale and cleaned up during incremental sync | Database deletion (stale cleanup + orphan cluster removal) |
| User feedback | 2 years | Database deletion |
| Call recordings and analysis | 1 year | Database deletion |
| Invitation records | 90 days after acceptance/expiry | Database deletion |
| Duplicate scan results | Retained across incremental syncs; stale records cleaned on next sync cycle | Stale record cleanup + orphan cluster removal |

### 16.6 Data Subject Access Requests (DSARs)
- DSARs are tracked in the PDPL module (`/pdpl`) via the `dsar_requests` table
- **Response SLA:** 30 calendar days from receipt (see Appendix C for all SLAs)
- Supported rights: access, rectification, erasure, restriction, portability, objection
- The DPO coordinates responses and ensures completeness

### 16.7 AI Guardrails
- The `ai_guardrails` table stores PII masking patterns for AI interactions
- Prevents AI agents from exposing sensitive data during analysis
- Patterns applied before sending CRM data to AI models

### 16.8 PDPL Audit Log
- The `pdpl_audit_log` table provides an immutable audit trail for all privacy-related actions
- Each log entry includes a SHA-256 checksum for tamper detection
- Used for regulatory audits and SDAIA compliance demonstrations

---

## 17. Management Review

### 17.1 Schedule
- **Frequency:** Quarterly (minimum), with ad-hoc reviews for critical issues
- **Participants:** Admin, Quality Manager, GRC Manager, DPO (as applicable)
- **Duration:** 1–2 hours

### 17.2 Agenda Items

| # | Topic | Data Source |
|---|-------|------------|
| 1 | Review of previous meeting actions | Meeting minutes |
| 2 | Audit results and quality score trends | Quality Dashboard (`/`), trend data |
| 3 | CAPA status (open, overdue, effectiveness) | QMS Dashboard (`/qms`) CAPA tab |
| 4 | NC status and resolution rates | QMS Dashboard (`/qms`) NC tab |
| 5 | Risk register changes (new, escalated, closed) | Risk Register (`/risks`) |
| 6 | Compliance posture and gap analysis | Compliance Tracking (`/compliance`) |
| 7 | Customer/user feedback summary | Feedback module (`/feedback`) |
| 8 | Platform performance (uptime, incidents) | Event Logs (`/logs`), Replit dashboard |
| 9 | PDPL/privacy status and any DSARs | PDPL module (`/pdpl`) |
| 10 | Quality objective performance vs targets | Section 1.2 targets |
| 11 | KPI performance and trends | KPI Tracking (`/kpis`) |
| 12 | Duplicate Radar results and pipeline hygiene | Duplicate Radar (`/duplicates`) |
| 13 | Sales/SDR SLA compliance | AI Alerts (`/consultant` alert bell) |
| 14 | Improvement opportunities | All modules |
| 15 | Resource needs and training gaps | Team Performance (`/team`) |
| 16 | Escalation log review | `escalation_log` table |

### 17.3 Outputs
- Updated quality objectives (if targets need adjustment)
- Action items with owners and due dates
- Decisions on resource allocation
- Minutes recorded and distributed to all participants

---

## 18. Internal Audit Program

### 18.1 Purpose
The internal audit program verifies that the WalaPlus QMS platform itself operates in conformance with organizational requirements, ISO 9001 principles, and security policies. This is distinct from the CRM data audits performed by the AI agents.

### 18.2 Audit Schedule

| Audit Area | Frequency | Auditor | Criteria |
|------------|-----------|---------|----------|
| RBAC and access control effectiveness | Quarterly | Admin or designated auditor | All users have correct roles; no unauthorized access |
| Data protection and PDPL compliance | Semi-annually | DPO or designated auditor | PDPL articles, data retention schedule |
| Security controls (CSP, input sanitization) | Semi-annually | Admin or security reviewer | VAPT report baseline, security headers |
| CRM integration and data accuracy | Quarterly | Quality Manager | Zoho data matches audit results |
| CAPA and NC process effectiveness | Quarterly | Quality Manager | Closure rates, SLA compliance |
| Backup and disaster recovery | Annually | Admin | RTO/RPO targets met (see Section 20) |
| User training compliance | Semi-annually | Team Lead | Required training completed per role |
| Policy governance lifecycle | Quarterly | GRC Manager | Policies reviewed on schedule, approvals in place |
| AI guardrails and PII masking | Semi-annually | DPO | AI guardrail patterns effective, no PII leakage |
| Duplicate Radar accuracy | Quarterly | Quality Manager | Scan results match manual spot-checks |
| SLA compliance (Sales/SDR) | Monthly | Quality Manager | AI scanner SLA alerts reviewed and addressed |
| KPI auto-calculation accuracy | Quarterly | Admin | Auto-calculated KPI values match manual calculations |

### 18.3 Audit Process
1. **Plan:** Auditor reviews scope, criteria, and previous findings
2. **Execute:** Auditor examines platform data, interviews users, reviews logs
3. **Report:** Findings documented with severity (observation, minor, major, critical)
4. **Follow-up:** Findings entered as NC records in QMS; CAPA created for major/critical findings
5. **Close:** Verify corrective actions are effective before closing the finding

### 18.4 Auditor Independence
- Auditors must not audit their own work or modules they manage
- Admin audits should be performed by Quality Manager or external reviewer
- Audit results are accessible to all Management Review participants

---

## 19. Incident Response

### 19.1 Incident Categories

| Category | Examples | Severity |
|----------|----------|----------|
| **Security Breach** | Unauthorized access, credential compromise, data exfiltration | Critical |
| **System Outage** | Platform down, database unavailable, Replit hosting failure | High |
| **Data Integrity** | Incorrect audit results, corrupted records, sync failures | High |
| **Performance Degradation** | Slow response times, timeout errors, scan timeouts | Medium |
| **Zoho Integration Failure** | OAuth token expired, API errors, empty data returns | Medium |
| **User-Reported Bug** | UI errors, broken functionality, missing data | Low–Medium |

### 19.2 Escalation Matrix

| Severity | First Responder | Escalation To | Escalation Timeline |
|----------|----------------|---------------|-------------------|
| Critical | Admin | DPO + Executive | Immediate |
| High | Admin | Quality Manager | Within 1 hour |
| Medium | Admin | Relevant module owner | Within 4 hours |
| Low | Any team member | Admin | Within 24 hours |

### 19.3 Incident Response Steps
1. **Detect:** Monitor event logs (`/logs`), user reports, Replit health checks, AI alerts
2. **Classify:** Determine category and severity per the table above
3. **Contain:** Isolate affected components (disable integrations, restrict access if needed)
4. **Investigate:** Review logs, identify root cause, document findings
5. **Resolve:** Apply fix, verify resolution, restore service
6. **Communicate:** Notify affected users and stakeholders
7. **Document:** Log the incident in event logs with full timeline
8. **Review:** Conduct post-incident review within 5 business days
9. **Improve:** Create CAPA record for systemic issues; update procedures if needed

---

## 20. Backup & Disaster Recovery

### 20.1 Database Backup
- **Provider:** Replit manages PostgreSQL database infrastructure
- **Backup frequency:** Automatic (managed by Replit hosting platform)
- **Backup type:** Full database snapshots
- **Retention:** Per Replit's data retention policy
- **Additional protection:** Project checkpoints (code + database state) created automatically

### 20.2 Recovery Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | 1 hour | Platform redeploy from checkpoint |
| **RPO** (Recovery Point Objective) | 1 hour | Based on Replit checkpoint frequency |

### 20.3 Recovery Procedures
1. **Platform failure:** Replit Autoscale automatically restarts the application on health check failure
2. **Database corruption:** Restore from Replit checkpoint (admin can initiate rollback via Replit dashboard)
3. **Code regression:** Roll back to a previous checkpoint via Replit dashboard
4. **Zoho integration failure:** System automatically retries OAuth token refresh; manual re-authorization via Zoho API Console if refresh token is revoked
5. **Complete disaster:** Redeploy from git repository + restore database from latest checkpoint

### 20.4 Recovery Testing
- Recovery procedures should be tested annually as part of the internal audit program (see Section 18)
- Test should include: checkpoint rollback, service restart verification, and Zoho re-authentication

---

## 21. Change Management

### 21.1 Change Categories

| Category | Examples | Approval Required |
|----------|----------|-------------------|
| **Emergency** | Security patch, critical bug fix, data breach response | Admin (post-implementation review) |
| **Standard** | New feature, UI enhancement, report addition | Admin + Quality Manager |
| **Configuration** | Secret update, Zoho region change, role modification, cron schedule change | Admin |
| **Infrastructure** | Database schema change, hosting change, new integration | Admin + Quality Manager + GRC Manager |

### 21.2 Change Process
1. **Request:** Document the change (what, why, impact, rollback plan)
2. **Review:** Appropriate approver reviews the change per category above
3. **Test:** Verify changes in the development environment (Replit workspace)
4. **Approve:** Obtain required approval(s)
5. **Implement:** Apply changes and publish via Replit dashboard
6. **Verify:** Confirm functionality after deployment (run relevant module checks)
7. **Document:** Update this SOP if the change affects procedures, roles, or modules
8. **Rollback:** If issues arise, roll back to previous checkpoint via Replit dashboard

### 21.3 Change Log
All changes are tracked in:
- Git version control (commit history)
- Replit checkpoints (code + database snapshots)
- Event Logs (`/logs`) for runtime configuration changes
- Section 25 (Recent Changes Log) of this SOP for procedural changes

---

## 22. User Training Requirements

### 22.1 Mandatory Training by Role

| Role | Required Training | Completion Deadline |
|------|-------------------|-------------------|
| **All users** | Platform navigation, login procedure, feedback submission | Within 1 week of onboarding |
| **Admin** | Full platform training, security procedures, incident response, user management | Before assuming role |
| **Quality Manager** | Quality Dashboard, AI Audit, QMS (CAPA/NC), audit program, management review, Duplicate Radar, KPI tracking | Within 2 weeks |
| **GRC Manager** | GRC Control Tower, Risk Register, Compliance, Policy governance, audit readiness | Within 2 weeks |
| **Team Lead** | Team Performance, Call Intelligence, training matrix management | Within 2 weeks |
| **Auditor** | Audit Readiness, Compliance Tracking, findings management | Within 2 weeks |
| **DPO** | PDPL module, data protection procedures, breach notification, DSAR handling | Before assuming role |

### 22.2 Training Records
- Training assignments and completions are tracked in the Team Performance module (`/team`) under the Training Matrix tab
- Course management is available in the QMS Dashboard (`/qms`) Training tab
- Training compliance percentage is displayed on the Team Overview dashboard

### 22.3 Refresher Training
- All users must complete annual refresher training on platform usage and security awareness
- Role-specific refresher training is required when:
  - A major platform update is released
  - New modules are added to the user's role permissions
  - Security incidents occur that require procedural changes

---

## 23. Continual Improvement

### 23.1 Improvement Sources
The following sources feed into the continual improvement process:

| Source | Module | Frequency |
|--------|--------|-----------|
| AI Audit findings | Quality Dashboard (`/`) | Weekly |
| CAPA effectiveness reviews | QMS Dashboard (`/qms`) | Monthly |
| NC trend analysis | QMS Dashboard (`/qms`) | Monthly |
| User feedback | Feedback module (`/feedback`) | Ongoing |
| Internal audit findings | Section 18 | Per schedule |
| Management review actions | Section 17 | Quarterly |
| Pentest and security reviews | Section 9.4 | As conducted |
| Platform performance data | Event Logs (`/logs`) | Ongoing |
| AI Consultant alerts | AI Consultant (`/consultant`) alert bell | Ongoing (every 6 hours) |
| Sales/SDR SLA breach alerts | AI Background Scanner | Ongoing (every 6 hours) |
| Duplicate Radar findings | Duplicate Radar (`/duplicates`) | Every 6 hours (auto-sync) + on-demand |
| KPI trend analysis | KPI Tracking (`/kpis`) | Daily (auto-calculated) |
| Escalation log trends | `escalation_log` table | Monthly |

### 23.2 Improvement Process
1. **Identify:** Collect improvement opportunities from all sources above
2. **Prioritize:** Rank by impact (quality score improvement, risk reduction, user satisfaction) and effort
3. **Plan:** Define scope, owner, timeline, and success criteria
4. **Implement:** Execute the improvement (following the Change Management process in Section 21)
5. **Measure:** Track effectiveness using platform KPIs and dashboards
6. **Standardize:** Update SOPs, governance rules, or scorecards if the improvement is effective
7. **Report:** Present results at the next Management Review

### 23.3 Key Performance Indicators for Improvement
- Quality Score trend (should be improving or stable quarter-over-quarter)
- CAPA recurrence rate (same root cause should not recur)
- NC resolution time trend (should be decreasing)
- User satisfaction trend (should be improving)
- Duplicate rate (should be decreasing — target ≤ 2%)
- SLA compliance rate (should be improving — Sales and SDR)
- CRM data accuracy (should be improving — target ≥ 95%)

---

## 24. Support & Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| Can't log in | Clear browser cookies, try a different auth provider (Google, GitHub, Apple, email) |
| Dashboard shows 0 records | Click "Run AI Audit" to fetch fresh CRM data |
| "Run AI Audit" not working | Verify Zoho OAuth secrets are configured (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) |
| Permission denied on a page | Contact admin to upgrade your role via `/users` |
| Audit shows sample/mock data | Verify Zoho CRM credentials are properly configured in secrets |
| Policies page not loading | Hard refresh the page (Ctrl+Shift+R) |
| CRM data returning empty | Check Zoho region — Saudi accounts need `.sa` endpoints (see Section 5.7) |
| Page not loading at all | Check internet connection, try hard refresh (Ctrl+Shift+R), check if app is published |
| Email reports not sending | Verify RESEND_API_KEY and RESEND_FROM_EMAIL are configured |
| AI audit uses sample data instead of live CRM | Verify Zoho OAuth secrets; check `/api/integrations/status` for connection status |
| AI Consultant not responding | Verify `AI_INTEGRATIONS_OPENAI_API_KEY` or `OPENAI_API_KEY` is configured and has available quota. Check `CONSULTANT_CHAT_TIMEOUT` (default 120s). Ensure `@ai-sdk/openai` is at v3.x (`^3.0.29`). |
| AI Consultant returns 401 | All consultant API endpoints require valid session or X-Admin-Key header. Log in first or pass admin key. |
| AI Consultant scan times out | Increase `CONSULTANT_SCAN_TIMEOUT` env var (default 300000ms). Scan-stream SSE endpoint provides real-time progress. |
| Alert bell not showing count | Check `/api/consultant/alerts/count` — ensure the `ai_alerts` table was initialized |
| Chat history not loading | Chat history is stored in browser localStorage. Clear browser data to reset. |
| Duplicate scan shows "Gateway Timeout" | Scan runs in background now — check progress via the UI polling or `/api/duplicates/scan-status` |
| Duplicate scan shows 0 results | Run "Scan from Zoho" first, or wait for the 6-hourly auto-sync to populate data. Incremental mode retains records across syncs |
| KPIs not auto-calculating | Verify `KPI_AUTO_CALC_CRON` is not overridden; check Inngest cron logs |

### Feedback
Use the **"Give Feedback"** floating button (bottom-right corner of every page) to submit feedback, bug reports, or feature requests.

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **CAPA** | Corrective and Preventive Action — a structured process for identifying root causes of nonconformances and implementing corrective/preventive measures |
| **COQL** | CRM Object Query Language — Zoho's query language for searching CRM records |
| **CRM** | Customer Relationship Management — a system for managing business interactions with customers and prospects (Zoho CRM in this context) |
| **CSP** | Content Security Policy — an HTTP header that restricts which resources a browser can load, preventing XSS attacks |
| **DPO** | Data Protection Officer — the individual responsible for overseeing data protection compliance |
| **DSAR** | Data Subject Access Request — a request by an individual to access, correct, or delete their personal data |
| **GRC** | Governance, Risk, and Compliance — an integrated approach to managing governance requirements, enterprise risks, and regulatory compliance |
| **Inngest** | Event-driven workflow engine used for orchestrating multi-step audit workflows |
| **ISO 9001** | International standard for Quality Management Systems, specifying requirements for organizations to demonstrate consistent quality |
| **KPI** | Key Performance Indicator — a measurable value that demonstrates how effectively objectives are being achieved |
| **Levenshtein Distance** | A string similarity metric measuring the minimum number of single-character edits needed to change one word into another — used in duplicate detection fuzzy company name matching |
| **Mastra** | AI agent framework used as the core application server, providing agent orchestration and tool management |
| **MFA** | Multi-Factor Authentication — an authentication method requiring two or more verification factors |
| **MOM** | Minutes of Meeting — AI-generated summary of meeting discussions and action items |
| **NC** | Non-Conformance — a deviation from a specified requirement, standard, or expectation |
| **NCA ECC** | National Cybersecurity Authority Essential Cybersecurity Controls — Saudi Arabia's cybersecurity framework |
| **NPV** | Net Present Value — a financial calculation determining the present value of future cash flows minus the initial investment |
| **OIDC** | OpenID Connect — an authentication protocol built on OAuth 2.0, used for user identity verification |
| **PDPL** | Personal Data Protection Law — Saudi Arabia's data privacy regulation (similar to GDPR) |
| **Pipeline Inflation** | The overstatement of CRM pipeline value caused by duplicate deal records — detected and quantified by the Duplicate Radar |
| **PMP** | Project Management Professional — project management methodology used for the projects module |
| **QMS** | Quality Management System — a formalized system documenting processes, procedures, and responsibilities for achieving quality policies and objectives |
| **RACI** | Responsible, Accountable, Consulted, Informed — a matrix for clarifying roles and responsibilities |
| **RBAC** | Role-Based Access Control — a method of restricting system access based on assigned user roles |
| **ROI** | Return on Investment — a financial metric measuring the profitability of an investment |
| **RPO** | Recovery Point Objective — the maximum acceptable amount of data loss measured in time |
| **RTO** | Recovery Time Objective — the maximum acceptable time to restore service after an outage |
| **SDAIA** | Saudi Data and Artificial Intelligence Authority — the regulator for PDPL compliance in Saudi Arabia |
| **SDR** | Sales Development Representative — a sales role focused on lead qualification and outreach |
| **SHA-256** | Secure Hash Algorithm — a cryptographic hash function used for tamper detection in PDPL audit logs |
| **SLA** | Service Level Agreement — a commitment defining expected response/resolution times |
| **SOP** | Standard Operating Procedure — a documented set of step-by-step instructions for performing routine operations |
| **VAPT** | Vulnerability Assessment and Penetration Testing — security testing to identify and exploit vulnerabilities |
| **XSS** | Cross-Site Scripting — a security vulnerability where malicious scripts are injected into web pages |

---

## Appendix B: RACI Matrix

**R** = Responsible (does the work) | **A** = Accountable (final authority) | **C** = Consulted (provides input) | **I** = Informed (kept updated)

| Process / Activity | Admin | Quality Manager | GRC Manager | DPO | Team Lead | Auditor | Exec |
|-------------------|-------|----------------|-------------|-----|-----------|---------|------|
| Run AI Audit | R/A | R | I | I | I | I | I |
| Review Audit Results | I | R/A | C | I | I | C | I |
| Create/Update Policies | I | C | R/A | C | I | I | I |
| Approve Policies | I | C | R/A | C | I | I | I |
| Manage Risks | I | C | R/A | C | I | C | I |
| CAPA Management | I | R/A | C | I | C | C | I |
| NC Management | I | R/A | C | I | C | C | I |
| User Management | R/A | I | I | I | I | I | I |
| Internal Audit | C | R | C | C | I | R/A | I |
| Management Review | R | R/A | R | R | C | C | I |
| Incident Response | R/A | C | C | R | I | I | I |
| PDPL/Privacy | C | I | C | R/A | I | I | I |
| DSAR Processing | C | I | I | R/A | I | I | I |
| Breach Notification | R | I | C | R/A | I | I | I |
| Change Management | R/A | C | C | I | I | I | I |
| Training Management | C | C | C | I | R/A | I | I |
| Vendor Assessment | I | C | R/A | C | I | C | I |
| Compliance Tracking | I | C | R/A | C | I | R | I |
| KPI/Scorecard Review | C | R/A | C | I | C | I | R |
| Continual Improvement | C | R/A | C | C | C | C | I |
| Governance Doc Upload | R/A | C | C | I | I | I | I |
| Scorecard Config | R/A | R | I | I | I | I | I |
| Escalation Review | I | C | C | I | I | I | R/A |
| Handoff Rule Config | R/A | C | C | I | I | I | I |
| AI Consultant Usage | I | R | R | C | R | R | I |
| AI Alert Review | I | R/A | C | I | C | C | I |
| Duplicate Radar Review | I | R/A | I | I | C | I | I |
| SLA Compliance Review | I | R/A | C | I | C | I | I |
| KPI Seeding/Config | R/A | C | I | I | I | I | I |

---

## Appendix C: Service Level Agreements (SLAs)

### C.1 Operational SLAs

| Process | Metric | Target | Measurement |
|---------|--------|--------|-------------|
| AI Audit Completion | Time from trigger to results | ≤ 60 seconds | Platform timer |
| Dashboard Data Refresh | Staleness after audit | ≤ 5 minutes | Automatic refresh |
| Platform Availability | Monthly uptime | ≥ 99.5% | Replit health checks |
| Login Response | Authentication time | ≤ 5 seconds | OIDC callback timing |
| Duplicate Scan | Full 4-module scan | ≤ 10 minutes | Scan duration timer |

### C.2 Quality Process SLAs

| Process | Metric | Target | Escalation |
|---------|--------|--------|------------|
| **CAPA Closure** | Time from open to closed | ≤ 30 calendar days | Escalate to Quality Manager at 20 days |
| **NC Resolution (Observation)** | Time from open to resolved | ≤ 30 calendar days | Notify Quality Manager at 20 days |
| **NC Resolution (Minor)** | Time from open to resolved | ≤ 15 business days | Escalate to Quality Manager at 10 days |
| **NC Resolution (Major)** | Time from open to resolved | ≤ 15 business days | Escalate to Admin at 10 days |
| **NC Resolution (Critical)** | Time from open to resolved | ≤ 5 business days | Immediate escalation to Admin + Quality Manager |
| **Policy Review** | Time from review-due to completed | ≤ 30 calendar days | Notify GRC Manager at 15 days |
| **Risk Treatment Action** | Time from creation to implementation | ≤ 60 calendar days | Escalate to GRC Manager at 45 days |

### C.3 Sales SLAs (Monitored by AI Scanner)

| Process | Metric | Target | Alert Type |
|---------|--------|--------|------------|
| **SDR Handoff Response** | Time from handoff to first contact | ≤ 1 business day | `sla_breach` (high) |
| **Proposal Preparation** | Time from meeting to proposal sent | ≤ 2 business days | `sla_breach` (high) |
| **Agreement Review** | Time from sent to signed | ≤ 10 business days | `sla_breach` (critical at 30+ days) |
| **CRM Activity Logging** | Time from activity to CRM update | Same day | `sla_breach` (medium) |
| **Stage Duration: Meeting** | Max time in Meeting stage | 10 days | `sla_breach` |
| **Stage Duration: Proposal** | Max time in Proposal stage | 90 days | `sla_breach` |
| **Stage Duration: Agreement Sent** | Max time in Agreement Sent | 90 days | `sla_breach` |
| **Stage Duration: On Hold** | Max time in On Hold | 180 days | `sla_breach` |

### C.4 SDR SLAs (Monitored by AI Scanner)

| Process | Metric | Target | Alert Type |
|---------|--------|--------|------------|
| **Inbound Lead Contact** | Time from creation to first attempt | ≤ 2 hours | `sla_breach` |
| **Outbound Lead Contact** | Time from creation to first call | ≤ 4 hours | `sla_breach` |
| **Follow-up (No Answer)** | Time to next attempt | ≤ 24 hours | `sla_breach` |
| **Qualification Decision** | Time from Contacted to Qualified/Not Qualified | ≤ 3 business days | `sla_breach` |
| **Handoff to Sales** | Time from Qualified to Sales handoff | ≤ 1 business day | `sla_breach` |
| **Stage Duration: Contacting** | Max time in Contacting | 5 days | `sla_breach` |
| **Stage Duration: Contacted** | Max time in Contacted | 3 days | `sla_breach` |
| **Stage Duration: On Hold** | Max time in On Hold | 90 days | `sla_breach` |
| **Stage Duration: Nurturing** | Max time in Nurturing | 180 days | `sla_breach` |

### C.5 Privacy & Compliance SLAs

| Process | Metric | Target | Regulatory Basis |
|---------|--------|--------|-----------------|
| **DSAR Response** | Time from receipt to response | ≤ 30 calendar days | PDPL Article 14 |
| **Breach Notification (Authority)** | Time from detection to SDAIA notification | ≤ 72 hours | PDPL Article 20 |
| **Breach Notification (Subjects)** | Time from detection to data subject notification | Without undue delay | PDPL Article 20 |

### C.6 Incident Response SLAs

| Severity | Acknowledgment | Containment | Resolution |
|----------|---------------|-------------|------------|
| Critical | ≤ 15 minutes | ≤ 4 hours | ≤ 24 hours |
| High | ≤ 1 hour | ≤ 8 hours | ≤ 48 hours |
| Medium | ≤ 4 hours | ≤ 24 hours | ≤ 5 business days |
| Low | ≤ 24 hours | N/A | ≤ 10 business days |

---

## 25. Recent Changes Log

| Date | Change | Impact |
|------|--------|--------|
| Apr 14, 2026 | **SOP v4.3 — CRM Data Hub & reliability fixes.** CRM page (`/crm`) rewritten as "CRM Data Hub" with live quality enrichment via `POST /api/crm/enrich` (additive penalty scoring via `assessDataQuality()`, junk detection, duplicate cluster cross-reference via `lookupRecordsByZohoIds()`). Frontend: health summary bar, 4-tier quality badges, cluster badges, row-click detail modal, Hide Junk/Highlight Issues toggles, `escapeHtml()` XSS protection. Duplicate Radar: full CRM sync model with `syncAllModules`, 6-hourly auto-sync, data quality scoring + junk quarantine, new filter/sync/quality endpoints, Data Quality tab, 2 new tables (`zoho_sync_state`, `duplicate_record_tasks`). PDPL section corrected to reflect CRM data persistence in `duplicate_records`. SOP accuracy audit: corrected 23 discrepancies (counts, formulas, function names, retention claims). | CRM data visibility with integrated quality intelligence; PDPL compliance accuracy; duplicate radar full CRM sync |
| Apr 13, 2026 | **SOP v4.2 — AI Consultant 27-item enhancement (4 phases).** Phase 1 Bugs: XSS-safe renderMarkdown (placeholder tokens + URL sanitization), sla_breach enum, `if(true)` scanner bugs, auto-NC status fix, KPI join column, monitorRisksTool column, dead param removal, scan prompt report-only. Phase 2 Performance: sharedPool.ts (shared pg.Pool max:20), AbortController timeouts (120s/300s configurable), parallelized 14 scanner checks, safeQuery error logging. Phase 3 Features: alert action buttons + modal, chat history, file upload, clickable knowledge docs, citation CSS, scan SSE progress bar, 23 tools on agent (+updateCapa +addCapaAction +5 training tools), auth guards on all endpoints, welcome dashboard. Phase 4 UI: consolidated polling, touch swipe, severity icons + relative time, retry button, export chat, Arabic RTL. | AI Consultant security hardening, performance optimization, feature completion, and UX polish |
| Apr 13, 2026 | **SOP v4.0 major overhaul:** Comprehensive update reflecting all platform features as of this date. AI Consultant tools expanded from 8→16 (added NC/CAPA create/list, CAPA details, checklist run/manage, knowledge search). Duplicate Radar upgraded to Tier 1–3: multi-signal scoring (email 40pts + domain 25pts + phone 30pts + company 20pts), cross-module matching (Leads/Contacts/Deals/Accounts), merge workflow (resolve/ignore/mark primary/bulk resolve), owner accountability, real-time pre-creation check, async scan with progress polling. AI Scanner expanded from 8→12 checks (added Sales SLA violations, SDR SLA violations, low-progress treatments, high-confidence duplicates). 76 CRM governance rules fully documented (Sales SOP 28 + SDR SOP 28 + Account Rules 20). 11 SDR KPIs seeded. 6 platform KPIs auto-calculated daily. 6-hourly duplicate auto-sync cron. Zoho pagination uncapped by default. Database tables expanded 98→105+. Added complete dashboard page inventory (29), route file inventory (29), utility module inventory (39). All SLA tables updated with Sales/SDR SLA monitoring. RACI matrix updated. Added Knowledge Base, Notification Hub modules. | Full platform documentation reflecting all implemented capabilities |
| Apr 13, 2026 | **SOP v4.1 — Duplicate Radar 21-item enhancement (4 phases).** Phase 1: Incremental upsert (ON CONFLICT), enhanced summary (singletonCount, resolutionRate), paramIndex fix, RBAC on mock-data DELETE, atomic phone_normalized. Phase 2: Parallel Promise.all() fetch, pg_trgm GIN index, JOIN-based queries, performance indexes. Phase 3: SSE scan-stream, Contact Duplicates tab, Owner RAG status, server-side pagination, auto-resolve engine, date range filters, smart multi-factor AI recommendations. Phase 4: Animated progress bar with module chips, side-by-side comparison modal with Zoho links, KPI gauge + resolution rate dashboard, Generate Test Data button removed. | Comprehensive Duplicate Radar upgrade: reliability, performance, features, and UX |
| Apr 12, 2026 | Duplicate Radar async scan: Scan runs in background with progress polling; no more gateway timeouts | Improved scan reliability for large CRM datasets |
| Apr 12, 2026 | AI Consultant & Assistant module added: GPT-4o agent with 16 tools, background scanner (6h Inngest cron, 12 checks), alerts system, full chat UI at `/consultant`, alert bell in nav bar. Removed Sandbox module. Updated Audit History to show Date/Time. Added Slack notification integration details. | New AI-powered quality management guidance module; proactive issue detection via background scanning |
| Apr 9, 2026 | SOP v3.6: 22-fix security hardening — SQL injection (parameterized intervals), path traversal, fake data removal, OIDC nonce (oauth_data cookie, redirect on mismatch), uniform requireAdminOrKey auth guards on RBAC/PDPL/CallIntel/DuplicateRadar, webhook validation (Telegram secret + Linear HMAC-SHA256 with timingSafeEqual), audit trigger chain in fallback, error propagation, UUID resolution, dashboard HTML fixes | Protected API endpoints require authentication; webhook endpoints validated; SQL injection vectors eliminated |
| Apr 9, 2026 | SOP v3.5: Removed CSP nonce (CSP Level 3 conflict with inline handlers), page-level auth accepts admin_key cookie, audit trigger uses Inngest-first with direct fallback, admin key login redirects to dashboard, inngest.sh fixed, smoke test routes added | CSP, auth, and audit trigger accuracy verified |
| Apr 9, 2026 | SOP v3.4: Restored auth documentation, corrected CSP, documented tiered rate limiting, updated VAPT status to 37/37, unified role system | SOP accuracy verified against deployed codebase |
| Apr 8, 2026 | SOP v3.0–3.3: Added Quality Policy, Document Control, Management Review, Internal Audit, PDPL/Data Protection, Incident Response, Backup & DR, Change Management, User Training, Continual Improvement, Glossary, RACI, SLAs. Corrected 19 inaccuracies. Expanded database to 97+ tables. | Comprehensive QMS documentation |
| Apr 8, 2026 | Fixed CRM credential detection, policies.html, Added Member button, Audit Readiness to GRC, NC creation modal | Core platform functionality fixes |
| Apr 2, 2026 | Pentest v4 retest — 31/37 initially confirmed fixed | Retest baseline |
| Apr 8–9, 2026 | Post-retest remediation — remaining 5 findings (QMS-024, 026, 031, 032, 036) closed | 37/37 findings now resolved |
| Mar 2026 | Migrated to Replit Auth (OIDC), Centralized RBAC middleware | Google, GitHub, Apple, email login + granular access control |
| Feb 2026 | Platform launched | Full WalaPlus QMS codebase deployed |
