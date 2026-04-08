# WalaPlus Enterprise GRC & Quality Management Platform
# Standard Operating Procedure (SOP)

**Version:** 3.2
**Last Updated:** April 8, 2026
**Classification:** Internal Use Only
**Published URL:** https://qms-dashboard.replit.app
**Approval Authority:** Quality Management Representative / Platform Admin
**Next Review Date:** July 8, 2026

---

## Document Control

| Field | Detail |
|-------|--------|
| **Document ID** | WP-SOP-001 |
| **Version** | 3.2 |
| **Status** | Approved |
| **Author** | Platform Engineering Team |
| **Approved By** | Quality Management Representative |
| **Effective Date** | April 8, 2026 |
| **Next Review** | July 8, 2026 (quarterly) |
| **Distribution** | All platform users (internal) |

### Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 2026 | Engineering | Initial SOP covering core platform modules |
| 2.0 | Mar 2026 | Engineering | Added security architecture, RBAC, pentest remediation |
| 2.1 | Apr 8, 2026 | Engineering | OAuth credential detection, GRC audit readiness, QMS NC modal, team Add Member, policies fix |
| 3.0 | Apr 8, 2026 | Engineering | Added Quality Policy, Document Control, Management Review, Internal Audit Program, PDPL/Data Protection, Incident Response, Backup & DR, Change Management, User Training, Continual Improvement, Glossary, RACI, SLAs |
| 3.1 | Apr 8, 2026 | Engineering | Corrected 10 inaccuracies: GRC audit readiness description, policy button name, QMS KPI cards, NC types, PKCE claim, rate limiting claims, audit process steps, link text, first-steps references |
| 3.2 | Apr 8, 2026 | Engineering | Comprehensive codebase audit: expanded database inventory (73+ tables), added PDPL backend details (data inventory, DSAR, AI guardrails, audit log with SHA-256), ROI engine details (manpower/platform/error costs, AI validation), Call Intelligence backend (transcripts, QA scores, meeting MOM), handoff & control mapping system, escalation system, Zoho write capability (record updates, evaluation notes), Google Calendar integration, Slack/Telegram triggers, sandbox/mock data endpoints, onboarding tour system, admin governance document & scorecard management, MFA schema, access audit log, data scopes, screen permissions, risk assessment history, compliance calendar, evidence packs, policy versions & acknowledgments, vendor assessments & remediations |

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
- **Automated governance enforcement** through configurable rules and scorecards
- **Transparent compliance tracking** aligned with ISO 9001, NCA ECC, and PDPL requirements
- **Data-driven decision making** supported by real-time dashboards and trend analysis
- **Continuous improvement** driven by audit findings, CAPA effectiveness, and user feedback

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

### 1.3 Quality Objective Review
- Quality objectives are reviewed during quarterly Management Review meetings (see Section 15)
- Targets are adjusted based on trend data, organizational maturity, and business priorities
- Changes to objectives require Quality Management Representative approval

---

## 2. Platform Overview

WalaPlus QMS is an AI-powered enterprise Quality Management System that integrates Governance, Risk, and Compliance (GRC) with quality management capabilities. The platform connects directly to Zoho CRM (production, via OAuth 2.0) to perform automated quality audits, data hygiene checks, and compliance monitoring.

**Platform URL:** https://qms-dashboard.replit.app
**Tech Stack:** Mastra AI Framework, Hono HTTP Server, PostgreSQL, Inngest Workflows
**Hosting:** Replit Autoscale with automatic health checks
**Database:** PostgreSQL with 73+ auto-initialized tables
**AI Engine:** GPT-4o via OpenAI (configurable)

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
- **Risk Heat Map:** Interactive likelihood x impact matrix showing risk distribution
- **GRC Module Status:** Chart showing item counts across all GRC modules
- **Compliance by Framework:** Per-regulation compliance breakdown
- **Audit Readiness Section:** List of audits showing code, type, status, lead auditor, and findings count with link to `/audits`
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

### 4.3 Audit Readiness (`/audits`)
**Purpose:** Track and manage audit preparation and findings.

**Key Features:**
- Audit schedule and calendar
- Finding tracking and remediation status
- Audit checklists with completion tracking
- Evidence pack management (compiled documents for auditors, stored with status tracking)
- Historical audit results and trends

**Backend Tables:** `audits`, `grc_audit_findings`, `evidence_packs`, `audit_checklists`

### 4.4 Compliance Tracking (`/compliance`)
**Purpose:** Monitor regulatory compliance status across all frameworks.

**Key Features:**
- Compliance assessment management with scoring
- Regulation tracking (NCA ECC, ISO 27001, PDPL, etc.) with jurisdiction and effective dates
- Obligation monitoring with due dates, priority levels, and requirement types
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
3. Fill in: policy_number, title, category, department, content, review date
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

**Tabs:**
- **Overview:** Summary cards (Evaluations, Open CAPA, Open NC, Training Completion) + **Audit Runs card** showing total audits completed and open findings count + Recent Evaluations & CAPA
- **Deal Evaluations:** Run and review deal quality evaluations against configurable evaluation frameworks
- **CAPA:** Corrective and Preventive Action management with action items, root cause tracking, and types (corrective/preventive/improvement)
- **Nonconformances:** NC records with **"New NC" button** to create nonconformances
- **Training:** Course and assignment management with assessment scoring
- **Framework:** Evaluation framework configuration (dimensions, criteria, weights, thresholds)
- **Triggers:** Automated trigger management with acknowledge/dismiss/decide actions

**How to Create a Nonconformance:**
1. Navigate to `/qms`
2. Click the **"Nonconformances"** tab
3. Click the **"New NC"** button
4. Fill in the following fields:
   - **Title:** Descriptive name of the nonconformance
   - **Description:** Detailed explanation
   - **Type:** process, product, system, documentation, or data_quality
   - **Severity:** minor, major, critical, or observation
   - **Source:** internal_audit, external_audit, customer_complaint, process_monitoring, management_review, or other
   - **Assigned To:** Person responsible for resolution
5. Click "Create NC" to save

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
**Purpose:** Key Performance Indicator definition and monitoring.

**Key Features:**
- KPI definition with targets and thresholds
- Progress tracking with visual indicators
- Trend visualization over time
- Automated data collection from platform modules

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
**Purpose:** CRM data deduplication and hygiene management.

**Key Features:**
- Duplicate record detection across Leads, Contacts, Deals
- AI-detected duplicate clusters with confidence scoring
- AI-powered merge recommendations
- Cluster analysis for related duplicates
- Bulk duplicate management

**Backend Tables:** `duplicate_clusters`

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

### 4.18 CRM Integration (`/crm`)
**Purpose:** Zoho CRM data viewing and analysis.

**Key Features:**
- Live CRM data browsing across 5 modules (Leads, Deals, Contacts, Tasks, Accounts)
- Individual record detail viewing
- Data hygiene analysis per record
- Connection status monitoring

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
| Sandbox | `/sandbox` | Testing sandbox with mock data (Leads, Deals, Stats) for safe experimentation without affecting live CRM |
| Guide | `/guide` | Platform user guide (public, no login required) |
| Accept Invite | `/accept-invite` | Invitation acceptance page for new users (public) |

### 4.21 Handoff & Control Mapping System
**Purpose:** Automates data flow between QMS and GRC modules.

**Key Features:**
- **Handoff Rules:** Configurable automation rules that move data between modules (e.g., critical NC → enterprise risk)
- **Handoff Events:** Log of all automated data transfers with timestamps and status
- **Control Mappings:** Central mapping of internal controls to associated risks and policies, with type, coverage, and effectiveness ratings

**Backend Tables:** `handoff_rules`, `handoff_events`, `control_mappings`

### 4.22 Onboarding System
**Purpose:** Guided onboarding for new platform users.

**Key Features:**
- User onboarding status tracking per user
- Configurable onboarding tour steps
- Progress tracking through onboarding milestones

**Backend Tables:** `user_onboarding_status`, `onboarding_tour_steps`

---

## 5. Zoho CRM Integration

### 5.1 Connection Details
- **Access Type:** OAuth 2.0 with auto-refresh
- **Environment:** Zoho CRM Production
- **Authentication:** OAuth client credentials with refresh token
- **Token Refresh:** Automatic — tokens renew with a 5-minute buffer before expiry
- **Token Caching:** Access tokens cached in memory; auto-cleared and re-fetched on 401 errors
- **Credential Detection:** System recognizes both legacy access tokens AND OAuth credentials (Client ID + Client Secret + Refresh Token)
- **Pagination:** Supports fetching up to 10,000 records per module via automatic pagination

### 5.2 Modules Accessed
| Zoho Module | Data Read | Purpose |
|-------------|-----------|---------|
| **Leads** | Email, Phone, Lead Source, Status, Company, Region, Owner | Quality audits, hygiene scoring |
| **Deals** | Deal Name, Stage, Amount, Closing Date, Stage History | Pipeline governance, progression analysis |
| **Contacts** | Email, Last Name, Owner, Region, Title | Data completeness checks |
| **Tasks** | Subject, Due Date, Owner, Activity timestamps | Activity compliance verification |
| **Accounts** | Company details | Optional hygiene audits |

### 5.3 CRM Functions Available
| Function | Purpose |
|----------|---------|
| `fetchZohoRecords` | Fetches a single page of records from any module |
| `fetchAllZohoRecords` | Paginated retrieval of up to 10,000 records |
| `searchZohoRecords` | Searches records using Zoho COQL-like criteria |
| `analyzeRecordHygiene` | Validates records against required, format, enum, and custom rules |
| `calculateQualityScores` | Weight-based scoring producing People, Process, Governance, and Overall scores |
| `updateZohoRecord` | Updates record fields in CRM (used for evaluation logging) |
| `updateZohoRecordNotes` | Adds evaluation notes to CRM records |

### 5.4 What is NOT Accessed
- No employee/HR data
- No personal identification documents
- No financial/billing records beyond deal amounts
- Write operations limited to adding evaluation notes — no deletion or bulk modification

### 5.5 Default Governance Rules
The system applies default hygiene rules when no custom governance documents are configured:

| Module | Required Fields | Format Rules | Enum Checks |
|--------|----------------|--------------|-------------|
| Leads | Email, Phone, Lead Source, Owner | Email format, Phone format | Valid Lead Source values |
| Deals | Deal Name, Stage, Amount, Closing Date | — | Valid Stage values |
| Contacts | Email, Last Name, Owner | Email format | — |
| Tasks | Subject, Due Date, Owner | — | — |
| All | Owner | — | — |

### 5.6 AI Audit Process
When "Run AI Audit" is triggered (via button or weekly schedule):
1. System authenticates to Zoho CRM via OAuth (auto-refreshes tokens if expired)
2. Fetches up to 100 records per module (Leads, Deals, Contacts, Tasks)
3. Loads active scorecards and governance documents from the database
4. AI agents perform parallel audits: SDR Quality Agent audits Leads, Sales Quality Agent audits Deals
5. Falls back to direct (non-AI) rule-based audit if OpenAI keys are not configured
6. Applies governance rules to each record:
   - Missing required fields (email, phone, company, etc.)
   - Format validation (email format, phone format)
   - Enum checks (valid lead source, deal stage values)
   - Activity compliance (overdue tasks, stale records)
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
- Analyzes record completeness against governance rules
- Generates executive summaries, AI insights, and quality improvement recommendations
- Uses configurable governance documents and scorecards
- Orchestrates the insight-generation step of the audit workflow

### 6.2 SDR Quality Agent
- Evaluates SDR (Sales Development Representative) performance
- Audits **Leads** module specifically using SDR-specific scorecards
- Checks CRM update compliance after calls
- Runs in parallel with Sales Quality Agent during audits

### 6.3 Sales Quality Agent
- Monitors sales process adherence
- Audits **Deals** module specifically using Sales-specific scorecards
- Evaluates deal stage progression and pipeline hygiene
- Runs in parallel with SDR Quality Agent during audits

---

## 7. AI Tools

| Tool | Function |
|------|----------|
| **CRM Hygiene Audit** | Audits Zoho CRM records for data quality issues across modules |
| **CRM Activity Check** | Verifies activity compliance, follow-up timing, and task completion |
| **Call Analysis** | AI-powered call recording analysis with quality scoring |
| **Call Ingest** | Processes and stores call recordings for analysis |
| **CRM Compliance** | Validates post-call CRM updates (was CRM updated after call?) |
| **Deal Evaluation** | Assesses deal quality, risk factors, and progression compliance |
| **CAPA Management** | Corrective/Preventive Action tracking and effectiveness monitoring |
| **NC Management** | Non-Conformance creation, tracking, and resolution |
| **Meeting MOM** | Minutes of Meeting generation from call/meeting data |
| **Email Reports** | Automated email report delivery via Resend (with Replit mail fallback) |
| **Training Management** | Training record management, course tracking, and assignments |
| **Google Calendar** | Calendar integration for fetching events during audit periods |

---

## 8. Automated Workflows

### 8.1 Quality Audit Workflow (Inngest)
- **Trigger:** Manual (via Run AI Audit button or API call) or Cron schedule
- **Schedule:** Every Monday at 8:00 AM (configurable via `SCHEDULE_CRON_EXPRESSION`)
- **Engine:** Inngest event-driven workflow with multi-step execution
- **Steps:**
  1. `validate-environment` — Checks Zoho credentials and OpenAI API keys
  2. `fetch-calendar-events` — Retrieves Google Calendar events for the last 7 days
  3. `audit-crm-with-agent` — Parallel AI audit of Leads (SDR agent) and Deals (Sales agent), with direct-logic fallback
  4. `generate-insights` — AI-generated executive summary and recommendations
  5. `send-report` — Email delivery, database persistence, and trigger firing
- **Output:** Updated quality scores, issue reports, trend data, email notifications, automated triggers

### 8.2 Automated Triggers
- **AUDIT_COMPLETED:** Fires after every successful audit
- **NONCONFORMANCE_DETECTED:** Fires when issues are found during an audit
- **CAPA_REQUIRED:** Fires when critical or high-severity issues are detected
- Triggers appear in the QMS Dashboard **Triggers** tab
- Actions: Acknowledge, Dismiss, or Decide (approve/reject)

### 8.3 External Notification Triggers
- **Cron Triggers:** Configurable scheduled triggers for weekly/monthly audits (`src/triggers/cronTriggers.ts`)
- **Slack Integration:** Automated notifications to Slack channels (`src/triggers/slackTrigger.ts`)
- **Telegram Integration:** Automated notifications to Telegram chats (`src/triggers/telegramTrigger.ts`)

---

## 9. Security Architecture

### 9.1 Authentication
- **Replit Auth (OIDC):** Primary login via Replit's OpenID Connect provider
- **Supported providers:** Google, GitHub, Apple, and email
- **Session management:** HMAC-SHA256 signed session payloads using `SESSION_SECRET` (7-day expiry)
- **Cookie flags:** HttpOnly, Secure (auto-enabled in production), SameSite=Lax
- **Cookie name:** `walaplus_session`
- **OAuth CSRF protection:** State and nonce parameters validated in OIDC callback
- **MFA:** Database schema supports `mfa_enabled` and `mfa_secret` fields (available for future activation)

### 9.2 Authorization
- **RBAC:** Centralized role-based access control enforced globally via route permission map
- **10 roles** with granular per-endpoint permissions (see Section 3.1)
- **Permission examples:** `can_accept_risk`, `can_approve_policy`, `can_close_finding`, `can_manage_users`
- **Admin API Key:** Alternative authentication via `X-Admin-Key` header for system-level or automated access
- **Policy approval gate:** GRC Manager role required to approve policies before publication
- **Escalation:** Overdue CAPAs and risk treatments automatically escalated to executive level

### 9.3 Data Protection
- **CSP:** Content Security Policy with per-request randomly generated nonces (no unsafe-inline/unsafe-eval for scripts)
- **CSP nonce injection:** Server automatically injects nonce into `<script>` tags in HTML responses
- **Input sanitization:**
  - HTML/script tag stripping (XSS prevention)
  - CSV formula injection prevention (prefixes `=`, `+`, `-`, `@` with single quote)
  - Prototype pollution protection (blocks `__proto__`, `constructor`, `prototype` keys)
  - Field whitelisting per module (only recognized fields processed)
- **Rate limiting:** Audit trigger has a 60-second cooldown to prevent duplicate runs. Global request-level rate limiting is not yet implemented and is planned for a future release.
- **Endpoint enumeration prevention:** Protected routes return 403 (not 404)
- **Resource ID obfuscation:** UUID public_id columns on 9+ tables (enterprise_risks, risk_treatment_actions, vendors, policies, audits, regulations, obligations, compliance_assessments, team_feedback)
- **Password policy:** 12+ characters, uppercase, lowercase, number, special character
- **Error handling:** Generic error messages only — internal errors (e.g., unique constraint violations) mapped to user-friendly messages; no raw error exposure
- **CORS:** Dynamically validates origins against `REPLIT_DOMAINS`, enforces `Access-Control-Allow-Credentials: true` (no wildcard)
- **Security headers:**
  - `X-Frame-Options: DENY` (anti-clickjacking)
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-XSS-Protection: 1; mode=block`
  - `Permissions-Policy: camera=(), microphone=(), geolocation()` (disabled by default)
  - CSP `frame-ancestors 'none'`

### 9.4 Penetration Testing
- **37 out of 37 findings remediated** across VAPT v1, v2, v3, and retest rounds
- All critical, high, medium, and low severity issues resolved
- Detailed documentation: `docs/VAPT_Remediation_Report.md`

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
| `AI_INTEGRATIONS_OPENAI_API_KEY` | — | OpenAI API key for AI-powered audit insights |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | https://api.openai.com/v1 | OpenAI endpoint |
| `RESEND_API_KEY` | — | Email delivery via Resend |
| `RESEND_FROM_EMAIL` | — | Sender address for quality report emails |

### 10.3 Reference File
A `.env.example` file is included in the project root with all variables documented. Do not deploy this file.

---

## 11. Database

- **Engine:** PostgreSQL
- **Tables:** 73+ auto-initialized tables (created on first use, no manual migration needed)
- **Key Table Groups:**

| Group | Count | Tables | Purpose |
|-------|-------|--------|---------|
| QMS | 11 | evaluation_frameworks, evaluation_criteria, deal_evaluations, capa_records, capa_action_items, nonconformance_records, training_records, training_assignments, audit_findings, quality_metrics, qms_documents | Quality management operations |
| Quality Core | 4 | quality_scorecards, quality_audit_results, quality_trends, governance_documents | Audit results and quality tracking |
| Risk | 4 | enterprise_risks, risk_treatment_actions, risk_assessment_history, risk_categories | Risk registry and treatment plans |
| Compliance | 4 | regulations, obligations, compliance_assessments, compliance_calendar | Regulatory compliance tracking |
| Audit | 4 | audits, grc_audit_findings, evidence_packs, audit_checklists | Audit readiness and evidence |
| Policy | 4 | policies, policy_versions, policy_acknowledgments, policy_review_cycles | Policy governance lifecycle |
| Users & RBAC | 9 | system_users, platform_users, user_invitations, bu_processes, role_permissions, screen_permissions, data_scopes, access_audit_log, escalation_log | User management and access control |
| Call Intelligence | 6 | call_records, call_transcripts, call_analysis, call_qa_scores, call_compliance, meeting_mom | Call analysis and compliance |
| PDPL Privacy | 6 | data_inventory, dsar_requests, retention_policies, data_incidents, ai_guardrails, pdpl_audit_log | Data protection and privacy |
| ROI Engine | 5 | roi_initiatives, roi_manpower_breakdown, roi_platform_costs, roi_error_costs, roi_ai_validation_logs | Financial analysis |
| Vendor | 3 | vendors, vendor_assessments, vendor_remediations | Vendor risk management |
| Handoff & Controls | 3 | handoff_rules, handoff_events, control_mappings | Cross-module automation |
| Team & Projects | 5 | team_members, team_performance_metrics, pmp_projects, project_risks, project_milestones | Team and project management |
| Scorecard | 1 | employee_scorecards | Performance scorecards |
| Duplicate Radar | 1 | duplicate_clusters | CRM deduplication |
| Onboarding | 2 | user_onboarding_status, onboarding_tour_steps | User onboarding |
| Event Logs | 1 | event_logs | System audit trail |

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

### 12.2 Module API Endpoints
| Module | Base Path | Operations |
|--------|-----------|------------|
| Auth | `/api/auth/`, `/api/login`, `/api/callback`, `/api/logout` | Login, callback, session check, logout |
| Audits | `/api/audits/` | Latest results, history, summary |
| QMS | `/api/qms/evaluations`, `/api/qms/capa`, `/api/qms/nc`, `/api/qms/training` | CRUD for all QMS entities |
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
| Sandbox | `/api/sandbox/leads`, `/api/sandbox/deals`, `/api/sandbox/stats` | Mock data for testing |

---

## 13. Deployment

- **Hosting:** Replit Autoscale
- **Domain:** https://qms-dashboard.replit.app
- **Process:** Publish via Replit dashboard (automatic build, TLS, health checks)
- **Server:** Mastra dev server on port 5000 serving both API and HTML dashboards
- **Inngest:** Dev server on port 3000 for workflow orchestration
- **Auto-restart:** Health checks ensure uptime

---

## 14. First Steps After Deployment

1. **Set all secrets** in the Replit Secrets tab (see Section 10)
2. **Open the platform** at https://qms-dashboard.replit.app
3. **Log in** using any supported provider (Google, GitHub, Apple, or email)
4. **Go to `/admin`** and enter your ADMIN_API_KEY to access admin features
5. **Upload governance documents** via Admin Panel — these define the rules AI agents use during audits
6. **Configure scorecards** via Admin Panel — these define evaluation criteria for SDR and Sales agents
7. **Run your first AI Audit:** Go to `/` (Quality Dashboard) and click "Run AI Audit" — this pulls live data from Zoho CRM
8. **Check `/grc`** — verify the Audit Readiness table loads with audit records
9. **Check `/policies`** — click "New Policy" and create a test policy to verify the workflow
10. **Check `/team`** — use the "Add Member" button to register team members
11. **Check `/qms`** — verify the Audit Runs card displays and try creating a test NC via "New NC"
12. **Check `/pdpl`** — set up data inventory and retention policies
13. **Test sandbox:** Go to `/sandbox` to explore the platform using mock data without affecting live CRM

---

## 15. Data Protection & PDPL Compliance

### 15.1 Data Protection Officer (DPO)
- The organization must designate a DPO responsible for overseeing PDPL compliance
- DPO contact details should be configured in the PDPL module (`/pdpl`)
- The DPO is responsible for: data processing oversight, breach notification, DSAR coordination, and cross-border transfer reviews

### 15.2 Data Processing Register
The PDPL module (`/pdpl`) maintains a register of all data processing activities via the `data_inventory` table, including:
- **Processing purpose** for each data category
- **Legal basis** for processing (consent, legitimate interest, contractual necessity, legal obligation)
- **Data categories** processed (CRM records: names, emails, phone numbers, company details, deal amounts)
- **Data subjects** (leads, contacts, account holders in Zoho CRM)
- **Recipients** (internal platform users only — no data shared with third parties)
- **Retention periods** (see Section 15.5)

### 15.3 Breach Notification Procedure
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

### 15.4 Cross-Border Data Transfer Controls
- WalaPlus is hosted on Replit infrastructure (US-based servers)
- CRM data is read from Zoho CRM and processed in-memory during audits
- Audit results (scores, issue summaries) are stored in the platform database
- No raw CRM records are persisted — only aggregated quality metrics
- Cross-border transfer is justified under PDPL Article 29 (legitimate business interest with adequate protection)

### 15.5 Data Retention Schedule
Retention policies are configurable via the `retention_policies` table in the PDPL module:

| Data Category | Retention Period | Disposal Method |
|---------------|-----------------|-----------------|
| Audit results and quality scores | 3 years | Database deletion |
| Event logs | 1 year | Automatic purge |
| User session data | 7 days (cookie expiry) | Automatic expiry |
| CAPA and NC records | 5 years (regulatory) | Database deletion with approval |
| CRM data (in-memory during audit) | Duration of audit only | Not persisted |
| User feedback | 2 years | Database deletion |
| Call recordings and analysis | 1 year | Database deletion |
| Invitation records | 90 days after acceptance/expiry | Database deletion |

### 15.6 Data Subject Access Requests (DSARs)
- DSARs are tracked in the PDPL module (`/pdpl`) via the `dsar_requests` table
- **Response SLA:** 30 calendar days from receipt (see Appendix C for all SLAs)
- Supported rights: access, rectification, erasure, restriction, portability, objection
- The DPO coordinates responses and ensures completeness

### 15.7 AI Guardrails
- The `ai_guardrails` table stores PII masking patterns for AI interactions
- Prevents AI agents from exposing sensitive data during analysis
- Patterns applied before sending CRM data to AI models

### 15.8 PDPL Audit Log
- The `pdpl_audit_log` table provides an immutable audit trail for all privacy-related actions
- Each log entry includes a SHA-256 checksum for tamper detection
- Used for regulatory audits and SDAIA compliance demonstrations

---

## 16. Management Review

### 16.1 Schedule
- **Frequency:** Quarterly (minimum), with ad-hoc reviews for critical issues
- **Participants:** Admin, Quality Manager, GRC Manager, DPO (as applicable)
- **Duration:** 1–2 hours

### 16.2 Agenda Items

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
| 11 | Improvement opportunities | All modules |
| 12 | Resource needs and training gaps | Team Performance (`/team`) |
| 13 | Escalation log review | `escalation_log` table |

### 16.3 Outputs
- Updated quality objectives (if targets need adjustment)
- Action items with owners and due dates
- Decisions on resource allocation
- Minutes recorded and distributed to all participants

---

## 17. Internal Audit Program

### 17.1 Purpose
The internal audit program verifies that the WalaPlus QMS platform itself operates in conformance with organizational requirements, ISO 9001 principles, and security policies. This is distinct from the CRM data audits performed by the AI agents.

### 17.2 Audit Schedule

| Audit Area | Frequency | Auditor | Criteria |
|------------|-----------|---------|----------|
| RBAC and access control effectiveness | Quarterly | Admin or designated auditor | All users have correct roles; no unauthorized access |
| Data protection and PDPL compliance | Semi-annually | DPO or designated auditor | PDPL articles, data retention schedule |
| Security controls (CSP, input sanitization) | Semi-annually | Admin or security reviewer | VAPT report baseline, security headers |
| CRM integration and data accuracy | Quarterly | Quality Manager | Zoho data matches audit results |
| CAPA and NC process effectiveness | Quarterly | Quality Manager | Closure rates, SLA compliance |
| Backup and disaster recovery | Annually | Admin | RTO/RPO targets met (see Section 19) |
| User training compliance | Semi-annually | Team Lead | Required training completed per role |
| Policy governance lifecycle | Quarterly | GRC Manager | Policies reviewed on schedule, approvals in place |
| AI guardrails and PII masking | Semi-annually | DPO | AI guardrail patterns effective, no PII leakage |

### 17.3 Audit Process
1. **Plan:** Auditor reviews scope, criteria, and previous findings
2. **Execute:** Auditor examines platform data, interviews users, reviews logs
3. **Report:** Findings documented with severity (observation, minor, major, critical)
4. **Follow-up:** Findings entered as NC records in QMS; CAPA created for major/critical findings
5. **Close:** Verify corrective actions are effective before closing the finding

### 17.4 Auditor Independence
- Auditors must not audit their own work or modules they manage
- Admin audits should be performed by Quality Manager or external reviewer
- Audit results are accessible to all Management Review participants

---

## 18. Incident Response

### 18.1 Incident Categories

| Category | Examples | Severity |
|----------|----------|----------|
| **Security Breach** | Unauthorized access, credential compromise, data exfiltration | Critical |
| **System Outage** | Platform down, database unavailable, Replit hosting failure | High |
| **Data Integrity** | Incorrect audit results, corrupted records, sync failures | High |
| **Performance Degradation** | Slow response times, timeout errors | Medium |
| **Zoho Integration Failure** | OAuth token expired, API errors, empty data returns | Medium |
| **User-Reported Bug** | UI errors, broken functionality, missing data | Low–Medium |

### 18.2 Escalation Matrix

| Severity | First Responder | Escalation To | Escalation Timeline |
|----------|----------------|---------------|-------------------|
| Critical | Admin | DPO + Executive | Immediate |
| High | Admin | Quality Manager | Within 1 hour |
| Medium | Admin | Relevant module owner | Within 4 hours |
| Low | Any team member | Admin | Within 24 hours |

### 18.3 Incident Response Steps
1. **Detect:** Monitor event logs (`/logs`), user reports, Replit health checks
2. **Classify:** Determine category and severity per the table above
3. **Contain:** Isolate affected components (disable integrations, restrict access if needed)
4. **Investigate:** Review logs, identify root cause, document findings
5. **Resolve:** Apply fix, verify resolution, restore service
6. **Communicate:** Notify affected users and stakeholders
7. **Document:** Log the incident in event logs with full timeline
8. **Review:** Conduct post-incident review within 5 business days
9. **Improve:** Create CAPA record for systemic issues; update procedures if needed

---

## 19. Backup & Disaster Recovery

### 19.1 Database Backup
- **Provider:** Replit manages PostgreSQL database infrastructure
- **Backup frequency:** Automatic (managed by Replit hosting platform)
- **Backup type:** Full database snapshots
- **Retention:** Per Replit's data retention policy
- **Additional protection:** Project checkpoints (code + database state) created automatically

### 19.2 Recovery Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | 1 hour | Platform redeploy from checkpoint |
| **RPO** (Recovery Point Objective) | 1 hour | Based on Replit checkpoint frequency |

### 19.3 Recovery Procedures
1. **Platform failure:** Replit Autoscale automatically restarts the application on health check failure
2. **Database corruption:** Restore from Replit checkpoint (admin can initiate rollback via Replit dashboard)
3. **Code regression:** Roll back to a previous checkpoint via Replit dashboard
4. **Zoho integration failure:** System automatically retries OAuth token refresh; manual re-authorization via Zoho API Console if refresh token is revoked
5. **Complete disaster:** Redeploy from git repository + restore database from latest checkpoint

### 19.4 Recovery Testing
- Recovery procedures should be tested annually as part of the internal audit program (see Section 17)
- Test should include: checkpoint rollback, service restart verification, and Zoho re-authentication

---

## 20. Change Management

### 20.1 Change Categories

| Category | Examples | Approval Required |
|----------|----------|-------------------|
| **Emergency** | Security patch, critical bug fix, data breach response | Admin (post-implementation review) |
| **Standard** | New feature, UI enhancement, report addition | Admin + Quality Manager |
| **Configuration** | Secret update, Zoho region change, role modification | Admin |
| **Infrastructure** | Database schema change, hosting change, new integration | Admin + Quality Manager + GRC Manager |

### 20.2 Change Process
1. **Request:** Document the change (what, why, impact, rollback plan)
2. **Review:** Appropriate approver reviews the change per category above
3. **Test:** Verify changes in the development environment (Replit workspace)
4. **Approve:** Obtain required approval(s)
5. **Implement:** Apply changes and publish via Replit dashboard
6. **Verify:** Confirm functionality after deployment (run relevant module checks)
7. **Document:** Update this SOP if the change affects procedures, roles, or modules
8. **Rollback:** If issues arise, roll back to previous checkpoint via Replit dashboard

### 20.3 Change Log
All changes are tracked in:
- Git version control (commit history)
- Replit checkpoints (code + database snapshots)
- Event Logs (`/logs`) for runtime configuration changes
- Section 28 (Recent Changes Log) of this SOP for procedural changes

---

## 21. User Training Requirements

### 21.1 Mandatory Training by Role

| Role | Required Training | Completion Deadline |
|------|-------------------|-------------------|
| **All users** | Platform navigation, login procedure, feedback submission | Within 1 week of onboarding |
| **Admin** | Full platform training, security procedures, incident response, user management | Before assuming role |
| **Quality Manager** | Quality Dashboard, AI Audit, QMS (CAPA/NC), audit program, management review | Within 2 weeks |
| **GRC Manager** | GRC Control Tower, Risk Register, Compliance, Policy governance, audit readiness | Within 2 weeks |
| **Team Lead** | Team Performance, Call Intelligence, training matrix management | Within 2 weeks |
| **Auditor** | Audit Readiness, Compliance Tracking, findings management | Within 2 weeks |
| **DPO** | PDPL module, data protection procedures, breach notification, DSAR handling | Before assuming role |

### 21.2 Training Records
- Training assignments and completions are tracked in the Team Performance module (`/team`) under the Training Matrix tab
- Course management is available in the QMS Dashboard (`/qms`) Training tab
- Training compliance percentage is displayed on the Team Overview dashboard

### 21.3 Refresher Training
- All users must complete annual refresher training on platform usage and security awareness
- Role-specific refresher training is required when:
  - A major platform update is released
  - New modules are added to the user's role permissions
  - Security incidents occur that require procedural changes

---

## 22. Continual Improvement

### 22.1 Improvement Sources
The following sources feed into the continual improvement process:

| Source | Module | Frequency |
|--------|--------|-----------|
| AI Audit findings | Quality Dashboard (`/`) | Weekly |
| CAPA effectiveness reviews | QMS Dashboard (`/qms`) | Monthly |
| NC trend analysis | QMS Dashboard (`/qms`) | Monthly |
| User feedback | Feedback module (`/feedback`) | Ongoing |
| Internal audit findings | Section 17 | Per schedule |
| Management review actions | Section 16 | Quarterly |
| Pentest and security reviews | Section 9.4 | As conducted |
| Platform performance data | Event Logs (`/logs`) | Ongoing |
| Escalation log trends | `escalation_log` table | Monthly |

### 22.2 Improvement Process
1. **Identify:** Collect improvement opportunities from all sources above
2. **Prioritize:** Rank by impact (quality score improvement, risk reduction, user satisfaction) and effort
3. **Plan:** Define scope, owner, timeline, and success criteria
4. **Implement:** Execute the improvement (following the Change Management process in Section 20)
5. **Measure:** Track effectiveness using platform KPIs and dashboards
6. **Standardize:** Update SOPs, governance rules, or scorecards if the improvement is effective
7. **Report:** Present results at the next Management Review

### 22.3 Key Performance Indicators for Improvement
- Quality Score trend (should be improving or stable quarter-over-quarter)
- CAPA recurrence rate (same root cause should not recur)
- NC resolution time trend (should be decreasing)
- User satisfaction trend (should be improving)

---

## 23. Support & Troubleshooting

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
| Sandbox shows mock data | This is expected — sandbox (`/sandbox`) uses mock data by design |

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
| **Mastra** | AI agent framework used as the core application server, providing agent orchestration and tool management |
| **MFA** | Multi-Factor Authentication — an authentication method requiring two or more verification factors |
| **MOM** | Minutes of Meeting — AI-generated summary of meeting discussions and action items |
| **NC** | Non-Conformance — a deviation from a specified requirement, standard, or expectation |
| **NCA ECC** | National Cybersecurity Authority Essential Cybersecurity Controls — Saudi Arabia's cybersecurity framework |
| **NPV** | Net Present Value — a financial calculation determining the present value of future cash flows minus the initial investment |
| **OIDC** | OpenID Connect — an authentication protocol built on OAuth 2.0, used for user identity verification |
| **PDPL** | Personal Data Protection Law — Saudi Arabia's data privacy regulation (similar to GDPR) |
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

---

## Appendix C: Service Level Agreements (SLAs)

### C.1 Operational SLAs

| Process | Metric | Target | Measurement |
|---------|--------|--------|-------------|
| AI Audit Completion | Time from trigger to results | ≤ 60 seconds | Platform timer |
| Dashboard Data Refresh | Staleness after audit | ≤ 5 minutes | Automatic refresh |
| Platform Availability | Monthly uptime | ≥ 99.5% | Replit health checks |
| Login Response | Authentication time | ≤ 5 seconds | OIDC callback timing |

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

### C.3 Privacy & Compliance SLAs

| Process | Metric | Target | Regulatory Basis |
|---------|--------|--------|-----------------|
| **DSAR Response** | Time from receipt to response | ≤ 30 calendar days | PDPL Article 14 |
| **Breach Notification (Authority)** | Time from detection to SDAIA notification | ≤ 72 hours | PDPL Article 20 |
| **Breach Notification (Subjects)** | Time from detection to data subject notification | Without undue delay | PDPL Article 20 |

### C.4 Incident Response SLAs

| Severity | Acknowledgment | Containment | Resolution |
|----------|---------------|-------------|------------|
| Critical | ≤ 15 minutes | ≤ 4 hours | ≤ 24 hours |
| High | ≤ 1 hour | ≤ 8 hours | ≤ 48 hours |
| Medium | ≤ 4 hours | ≤ 24 hours | ≤ 5 business days |
| Low | ≤ 24 hours | N/A | ≤ 10 business days |

---

## 28. Recent Changes Log

| Date | Change | Impact |
|------|--------|--------|
| Apr 8, 2026 | SOP v3.2: Comprehensive codebase audit — expanded database to 73+ tables, added PDPL backend (data inventory, DSAR, AI guardrails, SHA-256 audit log), ROI engine (5 cost tables + AI validation), Call Intelligence (6 tables incl. transcripts, QA scores, MOM), handoff/control system, escalation system, vendor assessments, policy versions/acknowledgments, risk history, compliance calendar, evidence packs, onboarding system, sandbox/mock endpoints, admin governance/scorecard management, API architecture section, Zoho write capabilities, Google Calendar integration, Slack/Telegram triggers, MFA schema, access audit log, data scopes, screen permissions | SOP now reflects complete implemented codebase |
| Apr 8, 2026 | SOP v3.1: Corrected 10 inaccuracies — GRC audit readiness, policy button, QMS KPI cards, NC types, PKCE, rate limiting, audit steps, link text, first-steps | SOP accuracy verified |
| Apr 8, 2026 | SOP v3.0: Added Quality Policy, Document Control, Management Review, Internal Audit, PDPL/Data Protection, Incident Response, Backup & DR, Change Management, User Training, Continual Improvement, Glossary, RACI, SLAs | Comprehensive QMS documentation |
| Apr 8, 2026 | Fixed CRM credential detection in audit workflow (OAuth support) | AI audits now work with OAuth credentials |
| Apr 8, 2026 | Fixed policies.html JavaScript SyntaxError | Policy viewing, transitions, and approvals work correctly |
| Apr 8, 2026 | Added "Add Member" button to Team page | Team members can be added directly from the members tab |
| Apr 8, 2026 | Added Audit Readiness section to GRC Control Tower | Audit list visible on GRC page |
| Apr 8, 2026 | Added Audit Runs card to QMS overview | Audit metrics on QMS dashboard |
| Apr 8, 2026 | Added NC creation modal to QMS | Nonconformances can be created from the QMS dashboard |
| Apr 8, 2026 | Created .env.example reference file | Easier secret configuration for new deployments |
| Apr 2026 | Pentest retest — all 37 findings resolved | Full security compliance achieved |
| Mar 2026 | Migrated to Replit Auth (OIDC) | Google, GitHub, Apple, and email login support |
| Mar 2026 | Centralized RBAC middleware | Granular per-endpoint role-based access control |
| Feb 2026 | Platform launched | Full WalaPlus QMS codebase deployed |
