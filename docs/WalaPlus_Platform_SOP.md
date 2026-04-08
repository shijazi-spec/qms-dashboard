# WalaPlus Enterprise GRC & Quality Management Platform
# Standard Operating Procedure (SOP)

**Version:** 2.1
**Last Updated:** April 8, 2026
**Classification:** Internal Use Only
**Published:** https://qms-dashboard.replit.app

---

## 1. Platform Overview

WalaPlus QMS is an AI-powered enterprise Quality Management System that integrates Governance, Risk, and Compliance (GRC) with quality management capabilities. The platform connects directly to Zoho CRM (production, read-only via OAuth 2.0) to perform automated quality audits, data hygiene checks, and compliance monitoring.

**Platform URL:** https://qms-dashboard.replit.app
**Tech Stack:** Mastra AI Framework, Hono HTTP Server, PostgreSQL, Inngest Workflows
**Hosting:** Replit Autoscale with automatic health checks

---

## 2. User Roles & Access Control

### 2.1 Role Matrix

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

### 2.2 Login Process
1. Navigate to **https://qms-dashboard.replit.app**
2. Click **"Log in with Replit"**
3. Authenticate using Google, GitHub, Apple, or email
4. System creates/updates your user profile automatically
5. Default role assigned: **Department Viewer** (admin can upgrade via Users page)

### 2.3 User Management (Admin Only)
1. Navigate to **Users & Access Control** (`/users`)
2. Available actions:
   - **Invite new users** via email invitation (password must meet policy: 12+ characters, uppercase, lowercase, number, special character)
   - **Change user roles** from the role dropdown
   - **Deactivate/reactivate** user accounts
   - **View login history** and session activity
3. Duplicate invitations are automatically prevented

---

## 3. Platform Modules

### 3.1 Quality Dashboard (`/`)
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

### 3.2 GRC Control Tower (`/grc`)
**Purpose:** Centralized governance, risk, and compliance management.

**Key Features:**
- **Summary Cards:** Active Risks, Active Policies, Compliance Score, Open Findings, Active Vendors, Controls Active
- **Risk Heat Map:** Interactive likelihood x impact matrix showing risk distribution
- **GRC Module Status:** Chart showing item counts across all GRC modules
- **Compliance by Framework:** Per-regulation compliance breakdown
- **Audit Readiness Section:** Readiness Score, Completed Audits, Upcoming Audits, Overdue Findings with contextual guidance
- **Handoff Rules:** Quality-to-GRC integration rules with source/target/trigger details
- **Control Effectiveness:** Control mapping with type, coverage, and effectiveness ratings
- **Recent Handoff Events:** Latest cross-module events with timestamps

**How to Use:**
1. Navigate to `/grc`
2. Use the period filter (Month to Date / Quarter to Date / Year to Date) to adjust the view
3. Click "Refresh" to reload all data
4. Review the Audit Readiness section for readiness score and recommendations
5. Click on heat map cells to see risk details
6. Use "View Full Audit Dashboard" link to go to the detailed audits page

### 3.3 Audit Readiness (`/audits`)
**Purpose:** Track and manage audit preparation and findings.

**Key Features:**
- Audit schedule and calendar
- Finding tracking and remediation status
- Audit checklists with completion tracking
- Evidence management and attachment
- Historical audit results and trends

### 3.4 Compliance Tracking (`/compliance`)
**Purpose:** Monitor regulatory compliance status across all frameworks.

**Key Features:**
- Compliance assessment management with scoring
- Regulation tracking (NCA ECC, ISO 27001, PDPL, etc.)
- Obligation monitoring with due dates
- Gap analysis and remediation tracking
- Compliance score trends over time

### 3.5 Risk Register (`/risks`)
**Purpose:** Enterprise risk identification, assessment, and treatment.

**Key Features:**
- Risk registry with likelihood and impact scoring
- Risk treatment action plans with owners
- **Export to CSV** for offline analysis
- UUID-based risk identification (non-sequential for security)
- Risk trend analysis and heat maps

**How to Add a Risk:**
1. Navigate to `/risks`
2. Click "Add Risk"
3. Fill in risk details: title, category, likelihood (1-4), impact (1-4), owner
4. Add treatment actions and mitigation plans
5. Track status changes over time

### 3.6 Policy Governance (`/policies`)
**Purpose:** Policy lifecycle management from creation to retirement.

**Key Features:**
- Policy creation with category, department, and version tracking
- **Lifecycle workflow:** Draft → Review → Approval → Published → Archived/Retired
- GRC Manager approval gate (required before publishing)
- Policy acknowledgment tracking
- Version history with change summaries
- Review scheduling with overdue alerts

**How to Create a Policy:**
1. Navigate to `/policies`
2. Click "Add Policy"
3. Fill in: title, category, department, content, review date
4. Policy starts in Draft status
5. Use lifecycle buttons to advance: Submit for Review → Request Approval → Publish
6. GRC Manager must approve before publication (click "Request GRC Approval")

### 3.7 Vendor Risk Management (`/vendors`)
**Purpose:** Third-party vendor risk assessment and monitoring.

**Key Features:**
- Vendor registry with contact details
- Risk scoring (Low/Medium/High/Critical) and categorization
- Due diligence tracking with evidence
- Contract management and renewal alerts
- Vendor performance metrics

### 3.8 Call Intelligence (`/calls`)
**Purpose:** AI-powered call quality analysis and compliance monitoring.

**Key Features:**
- Call recording ingestion and analysis
- Quality scoring per call with dimension breakdown
- Compliance checklist verification
- CRM update compliance checking (was CRM updated after call?)
- Agent performance insights and benchmarking

### 3.9 ROI & NPV Evaluation (`/roi`)
**Purpose:** Financial impact analysis for deals and projects.

**Key Features:**
- ROI calculation with validated financial inputs
- Net Present Value analysis
- Deal evaluation scoring
- Financial validation (non-negative values, maximum limits, type checking)

### 3.10 Team Performance (`/team`)
**Purpose:** Team and individual performance monitoring.

**Tabs:**
- **Overview:** Summary cards (Total Members, Avg Performance, Training Compliance, Active Projects), department/status charts, top performers
- **Team Members:** Full member list with filtering by department and status, **"Add Member" button** to register new team members
- **Training Courses:** Course management and enrollment
- **Training Matrix:** Skill gap analysis and training assignments
- **Projects:** Project assignments and tracking
- **Analytics:** Performance trend analysis

**How to Add a Team Member:**
1. Navigate to `/team`
2. Click the **"Team Members"** tab
3. Click the **"Add Member"** button (top-right, next to filters)
4. Fill in: name, email, role, department, job title, phone, hire date
5. Click "Add Member" to save

### 3.11 QMS Dashboard (`/qms`)
**Purpose:** Comprehensive Quality Management System dashboard with evaluations, CAPA, nonconformances, and training.

**Tabs:**
- **Overview:** Summary cards (Evaluations, Open CAPA, Open NC, Training Completion) + **Audit KPI cards** (Audit KPI Score, First Pass Yield, CAPA Effectiveness) + Recent Evaluations & CAPA
- **Deal Evaluations:** Run and review deal quality evaluations
- **CAPA:** Corrective and Preventive Action management
- **Nonconformances:** NC records with **"New NC" button** to create nonconformances
- **Training:** Course and assignment management
- **Framework:** Evaluation framework configuration
- **Triggers:** Automated trigger management with acknowledge/dismiss/decide actions

**How to Create a Nonconformance:**
1. Navigate to `/qms`
2. Click the **"Nonconformances"** tab
3. Click the **"New NC"** button
4. Fill in: title, description, type (process/product/system/supplier/customer), severity (minor/major/critical/observation), source, assigned to
5. Click "Create NC" to save

### 3.12 PMP Project Portfolio (`/projects`)
**Purpose:** Project management and portfolio tracking.

**Key Features:**
- Project registry with milestones
- Resource allocation and assignment
- Status reporting (on-track, at-risk, delayed)
- Priority management

### 3.13 KPI Tracking (`/kpis`)
**Purpose:** Key Performance Indicator definition and monitoring.

**Key Features:**
- KPI definition with targets and thresholds
- Progress tracking with visual indicators
- Trend visualization over time
- Automated data collection from platform modules

### 3.14 Scorecard (`/scorecard`)
**Purpose:** Balanced scorecard for organizational performance measurement.

**Key Features:**
- Multi-dimensional scoring across quality dimensions
- Historical trend analysis
- Benchmark comparisons
- Configurable attributes and weights

### 3.15 Duplicate Radar (`/duplicates`)
**Purpose:** CRM data deduplication and hygiene management.

**Key Features:**
- Duplicate record detection across Leads, Contacts, Deals
- Confidence scoring for match quality
- AI-powered merge recommendations
- Cluster analysis for related duplicates
- Bulk duplicate management

### 3.16 PDPL Privacy Compliance (`/pdpl`)
**Purpose:** Personal Data Protection Law compliance tracking (Saudi Arabia).

**Key Features:**
- Data processing activity registry
- Consent management and tracking
- Privacy impact assessments
- Data subject request tracking and response

### 3.17 Table F Governance (`/tablef`)
**Purpose:** Table F compliance tracking and governance scoring.

**Key Features:**
- Governance rule compliance per CRM record
- Field completeness tracking and scoring
- Stage progression analysis
- Activity logging compliance verification

### 3.18 CRM Integration (`/crm`)
**Purpose:** Zoho CRM data viewing and analysis.

**Key Features:**
- Live CRM data browsing across 5 modules (Leads, Deals, Contacts, Tasks, Accounts)
- Individual record detail viewing
- Data hygiene analysis per record
- Connection status monitoring

### 3.19 System Event Logs (`/logs`)
**Purpose:** Audit trail for all system activities.

**Key Features:**
- Action logging (create, update, delete, login, export)
- User activity tracking with timestamps
- API access logs
- Security event monitoring
- Filterable by action type, user, and date range

### 3.20 Additional Modules
| Module | URL | Purpose |
|--------|-----|---------|
| Executive Dashboard | `/executive` | High-level executive summary with key metrics |
| Data Migration | `/migration` | Data import/export tools |
| Feedback | `/feedback` | User feedback collection (also accessible via floating "Give Feedback" button) |
| Onboarding | `/onboarding` | New user onboarding flow |
| Admin Panel | `/admin` | System administration (requires Admin API Key) |
| Sandbox | `/sandbox` | Testing and experimentation area |

---

## 4. Zoho CRM Integration

### 4.1 Connection Details
- **Access Type:** Read-only (OAuth 2.0 with auto-refresh)
- **Environment:** Zoho CRM Production
- **Authentication:** OAuth client credentials with refresh token
- **Token Refresh:** Automatic — tokens renew every hour without manual intervention
- **Credential Detection:** System recognizes both legacy access tokens AND OAuth credentials (Client ID + Client Secret + Refresh Token)

### 4.2 Modules Accessed
| Zoho Module | Data Read | Purpose |
|-------------|-----------|---------|
| **Leads** | Email, Phone, Lead Source, Status, Company, Region, Owner | Quality audits, hygiene scoring |
| **Deals** | Deal Name, Stage, Amount, Closing Date, Stage History | Pipeline governance, progression analysis |
| **Contacts** | Email, Last Name, Owner, Region, Title | Data completeness checks |
| **Tasks** | Subject, Due Date, Owner, Activity timestamps | Activity compliance verification |
| **Accounts** | Company details | Optional hygiene audits |

### 4.3 What is NOT Accessed
- No employee/HR data
- No personal identification documents
- No financial/billing records beyond deal amounts
- No write operations — the platform never modifies CRM data

### 4.4 AI Audit Process
When "Run AI Audit" is triggered (via button or weekly schedule):
1. System authenticates to Zoho CRM via OAuth (auto-refreshes tokens if expired)
2. Fetches up to 100 records per module (Leads, Deals, Contacts, Tasks)
3. Loads module-specific governance documents (if configured) or uses default rules
4. Applies governance rules to each record:
   - Missing required fields (email, phone, company, etc.)
   - Format validation (email format, phone format)
   - Enum checks (valid lead source, deal stage values)
   - Activity compliance (overdue tasks, stale records)
5. Calculates quality scores across three dimensions:
   - **People Score:** Owner assignment, contact completeness, activity compliance
   - **Process Score:** Stage progression, follow-up timing, task completion
   - **Governance Score:** Field completeness, naming conventions, data standards
6. Computes overall quality score (weighted average)
7. Saves results to database for trend tracking
8. Dashboard refreshes with updated scores

### 4.5 Regional Configuration
If your Zoho account is in the Saudi Arabia (.sa) region:
- Set `ZOHO_ACCOUNTS_URL` to `https://accounts.zoho.sa`
- Set `ZOHO_API_DOMAIN` to `https://www.zohoapis.sa`

Default (global) endpoints work for most other regions:
- `ZOHO_ACCOUNTS_URL` = `https://accounts.zoho.com`
- `ZOHO_API_DOMAIN` = `https://www.zohoapis.com`

---

## 5. AI Agents

### 5.1 Quality Specialist Agent
- Performs comprehensive CRM data hygiene audits across all modules
- Analyzes record completeness against governance rules
- Generates quality improvement recommendations
- Uses configurable governance documents and scorecards

### 5.2 SDR Quality Agent
- Evaluates SDR (Sales Development Representative) performance
- Audits **Leads** module specifically
- Checks CRM update compliance after calls
- Scores agent performance against SDR-specific scorecards

### 5.3 Sales Quality Agent
- Monitors sales process adherence
- Audits **Deals** module specifically
- Evaluates deal stage progression and pipeline hygiene
- Scores against Sales-specific scorecards

---

## 6. AI Tools

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
| **Email Reports** | Automated email report delivery via Resend |
| **Training Management** | Training record management, course tracking, and assignments |
| **Google Calendar** | Calendar integration for audit scheduling and reminders |

---

## 7. Automated Workflows

### 7.1 Weekly Quality Audit (Cron)
- **Schedule:** Every Monday at 8:00 AM (configurable via `SCHEDULE_CRON_EXPRESSION`)
- **Process:**
  1. Validates environment configuration (CRM credentials, AI keys)
  2. Fetches calendar events for the audit period
  3. Runs CRM hygiene audit across all modules (parallel by department if AI is available)
  4. Generates AI insights and recommendations
  5. Saves audit results and quality scores to database
  6. Sends email report to configured recipients
- **Output:** Updated quality scores, issue reports, trend data, email notifications

### 7.2 Audit Triggers
- Automated triggers fire when specific conditions are met (e.g., critical NC detected, CAPA overdue)
- Triggers appear in the QMS Dashboard **Triggers** tab
- Actions: Acknowledge, Dismiss, or Decide (approve/reject)

---

## 8. Security Architecture

### 8.1 Authentication
- **Replit Auth (OIDC):** Primary login via Replit's OpenID Connect provider
- **Supported providers:** Google, GitHub, Apple, and email
- **Session management:** HMAC-signed cookies (7-day expiry)
- **Cookie flags:** HttpOnly, Secure, SameSite=Lax
- **OAuth security:** State parameter + PKCE code verifier validated in callback

### 8.2 Authorization
- **RBAC:** Centralized role-based access control enforced globally via route permission map
- **10 roles** with granular per-endpoint permissions
- **Admin API Key:** Alternative authentication for admin-only routes and API access
- **Policy approval gate:** GRC Manager role required to approve policies before publication

### 8.3 Data Protection
- **CSP:** Content Security Policy with per-request nonces (no unsafe-inline for scripts)
- **Input sanitization:** HTML/script tag stripping, CSV formula injection prevention, prototype pollution protection
- **Rate limiting:**
  - Authenticated: 100 read / 10 write requests per minute
  - Unauthenticated: 10 read / 3 write requests per minute
  - Auth paths: 5 requests per minute
  - Export endpoints: 10 requests per minute
- **Endpoint enumeration prevention:** Protected routes return 403 (not 404)
- **Resource ID obfuscation:** UUID public_id columns on 9+ tables
- **Password policy:** 12+ characters, uppercase, lowercase, number, special character
- **Error handling:** Generic error messages only — no raw error exposure
- **CORS:** Restricted to app domain only (no wildcard)
- **Security headers:** X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, X-XSS-Protection, Permissions-Policy

### 8.4 Penetration Testing
- **37 out of 37 findings remediated** across VAPT v1, v2, v3, and retest rounds
- All critical, high, medium, and low severity issues resolved
- Detailed documentation: `docs/VAPT_Remediation_Report.md`

---

## 9. Environment Configuration

### 9.1 Required Secrets
| Secret | Purpose | Notes |
|--------|---------|-------|
| `DATABASE_URL` | PostgreSQL connection string | Auto-provided if using Replit's DB |
| `SESSION_SECRET` | Session cookie signing | Any random long string |
| `ADMIN_API_KEY` | Admin panel and API access | Strong key, e.g. 64-char hex |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth | From Zoho API Console |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth | From Zoho API Console |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM OAuth | Generated during CRM authorization |

### 9.2 Optional but Recommended Secrets
| Secret | Default | Purpose |
|--------|---------|---------|
| `ZOHO_ACCOUNTS_URL` | https://accounts.zoho.com | Zoho OAuth endpoint (use .sa for Saudi region) |
| `ZOHO_API_DOMAIN` | https://www.zohoapis.com | Zoho API domain (use .sa for Saudi region) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | — | OpenAI API key for AI-powered audit insights |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | https://api.openai.com/v1 | OpenAI endpoint |
| `RESEND_API_KEY` | — | Email delivery via Resend |
| `RESEND_FROM_EMAIL` | — | Sender address for quality report emails |

### 9.3 Reference File
A `.env.example` file is included in the project root with all variables documented. Do not deploy this file.

---

## 10. Database

- **Engine:** PostgreSQL
- **Tables:** 39+ auto-initialized tables (created on first use, no manual migration needed)
- **Key Table Groups:**

| Group | Tables | Purpose |
|-------|--------|---------|
| Quality | quality_scorecards, quality_audit_results, quality_trends, governance_documents | Audit results and quality tracking |
| Risk | enterprise_risks, risk_treatment_actions | Risk registry and treatment plans |
| Compliance | compliance_assessments, regulations, obligations | Regulatory compliance tracking |
| CRM | duplicate_radar, call_records, crm_compliance_checks | CRM data analysis |
| Users | platform_users, invitations, rbac_permissions | User management and access control |
| QMS | capa_records, nc_records, training_courses, deal_evaluations | Quality management operations |
| Operations | event_logs, team_feedback, kpis, policies, vendors | Platform operations |

---

## 11. Deployment

- **Hosting:** Replit Autoscale
- **Domain:** https://qms-dashboard.replit.app
- **Process:** Publish via Replit dashboard (automatic build, TLS, health checks)
- **Server:** Mastra dev server on port 5000 serving both API and HTML dashboards
- **Auto-restart:** Health checks ensure uptime

---

## 12. First Steps After Deployment

1. **Set all secrets** in the Replit Secrets tab (see Section 9)
2. **Open the platform** at https://qms-dashboard.replit.app
3. **Log in** using any supported provider (Google, GitHub, Apple, or email)
4. **Go to `/admin`** and enter your ADMIN_API_KEY to access admin features
5. **Run your first AI Audit:** Go to `/` (Quality Dashboard) and click "Run AI Audit" — this pulls live data from Zoho CRM
6. **Check `/grc`** — verify the Audit Readiness section loads with scores
7. **Check `/policies`** — create a test policy to verify the workflow
8. **Check `/team`** — use the "Add Member" button to register team members
9. **Check `/qms`** — verify the Audit KPI cards display and try creating a test NC

---

## 13. Support & Troubleshooting

### Common Issues
| Issue | Solution |
|-------|----------|
| Can't log in | Clear browser cookies, try a different auth provider (Google, GitHub, Apple, email) |
| Dashboard shows 0 records | Click "Run AI Audit" to fetch fresh CRM data |
| "Run AI Audit" not working | Verify Zoho OAuth secrets are configured (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN) |
| Permission denied on a page | Contact admin to upgrade your role via `/users` |
| Audit shows sample/mock data | Verify Zoho CRM credentials are properly configured in secrets |
| Policies page not loading | Hard refresh the page (Ctrl+Shift+R) — a JavaScript fix was applied |
| CRM data returning empty | Check Zoho region — Saudi accounts need `.sa` endpoints (see Section 4.5) |
| Page not loading at all | Check internet connection, try hard refresh (Ctrl+Shift+R), check if app is published |
| Email reports not sending | Verify RESEND_API_KEY and RESEND_FROM_EMAIL are configured |

### Feedback
Use the **"Give Feedback"** floating button (bottom-right corner of every page) to submit feedback, bug reports, or feature requests.

---

## 14. Recent Changes Log

| Date | Change | Impact |
|------|--------|--------|
| Apr 8, 2026 | Fixed CRM credential detection in audit workflow (OAuth support) | AI audits now work with OAuth credentials |
| Apr 8, 2026 | Fixed policies.html JavaScript SyntaxError | Policy viewing, transitions, and approvals work correctly |
| Apr 8, 2026 | Added "Add Member" button to Team page | Team members can be added directly from the members tab |
| Apr 8, 2026 | Added Audit Readiness section to GRC Control Tower | Readiness score, completed/upcoming audits visible on GRC page |
| Apr 8, 2026 | Added Audit KPI cards to QMS overview | KPI Score, First Pass Yield, CAPA Effectiveness metrics |
| Apr 8, 2026 | Added NC creation modal to QMS | Nonconformances can be created from the QMS dashboard |
| Apr 8, 2026 | Created .env.example reference file | Easier secret configuration for new deployments |
| Apr 2026 | Pentest retest — all 37 findings resolved | Full security compliance achieved |
| Mar 2026 | Migrated to Replit Auth (OIDC) | Google, GitHub, Apple, and email login support |
| Mar 2026 | Centralized RBAC middleware | Granular per-endpoint role-based access control |
| Feb 2026 | Platform launched | Full WalaPlus QMS codebase deployed |
