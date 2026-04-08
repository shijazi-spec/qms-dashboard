# WalaPlus Enterprise GRC & Quality Management Platform
# Standard Operating Procedure (SOP)

**Version:** 2.0
**Last Updated:** April 8, 2026
**Classification:** Internal Use Only

---

## 1. Platform Overview

WalaPlus QMS is an AI-powered enterprise Quality Management System that integrates Governance, Risk, and Compliance (GRC) with quality management capabilities. The platform connects directly to Zoho CRM (production, read-only) to perform automated quality audits, data hygiene checks, and compliance monitoring.

**Platform URL:** https://qms-dashboard.replit.app
**Tech Stack:** Mastra AI Framework, Hono HTTP Server, PostgreSQL, Inngest Workflows

---

## 2. User Roles & Access Control

| Role | Access Level | Capabilities |
|------|-------------|--------------|
| **Admin** | Full access | All modules, user management, system settings, audit triggers |
| **Quality Manager** | Extended | Quality dashboards, audits, CRM data, compliance, policies |
| **GRC Manager** | Extended | GRC Control Tower, risks, compliance, regulations, policies |
| **Team Lead** | Standard+ | Team performance, call intelligence, audits, quality dashboards |
| **Auditor** | Standard+ | Audit readiness, compliance tracking, findings management |
| **Quality Specialist** | Standard | Quality dashboards, call analysis, CRM hygiene |
| **AI Specialist** | Standard | Call intelligence, AI agent tools, CRM analysis |
| **BU Owner** | Standard | Business unit dashboards, ROI evaluation, team metrics |
| **Executive** | Read-heavy | Executive dashboards, scorecards, KPIs, trend reports |
| **Department Viewer** | Read-only | Dashboard viewing, report access (default role for new users) |

### 2.1 Login Process
1. Navigate to the platform URL
2. Click "Log in with Replit"
3. Authenticate using Google, GitHub, Apple, or email
4. System creates/updates user profile automatically
5. Default role assigned: `department_viewer` (admin can upgrade via Users page)

### 2.2 User Management (Admin Only)
- Navigate to **Users & Access Control** (`/users`)
- Invite new users via email invitation
- Change user roles
- Deactivate/reactivate user accounts
- View login history and session activity

---

## 3. Platform Modules

### 3.1 Quality Dashboard (`/`)
**Purpose:** Central hub for AI-powered CRM quality monitoring and compliance tracking.

**Key Features:**
- Overall Quality Score (percentage) with People, Process, and Governance breakdown
- Audit Summary showing records audited, issues found, compliance rate
- Issues by category chart (Leads, Deals, Contacts, Tasks)
- Date filtering (Created date range, Modified date range)
- Run AI Audit button to trigger live CRM data analysis
- Export to PDF

**How to Use:**
1. Log in to the platform
2. The Quality Dashboard loads automatically
3. Set date filters if needed (Created/Modified date ranges)
4. Click "Apply Filters" to filter data
5. Click "Run AI Audit" to trigger a fresh audit against live Zoho CRM data
6. Dashboard refreshes automatically after audit completes (~15 seconds)

### 3.2 GRC Control Tower (`/grc`)
**Purpose:** Centralized governance, risk, and compliance management.

**Key Features:**
- Compliance posture overview
- Risk heat map
- Regulatory tracking
- Control effectiveness monitoring
- Obligation management

### 3.3 Audit Readiness (`/audits`)
**Purpose:** Track and manage audit preparation and findings.

**Key Features:**
- Audit schedule and calendar
- Finding tracking and remediation
- Audit checklists
- Evidence management
- Historical audit results

### 3.4 Compliance Tracking (`/compliance`)
**Purpose:** Monitor regulatory compliance status across all frameworks.

**Key Features:**
- Compliance assessment management
- Regulation tracking
- Obligation monitoring
- Gap analysis
- Compliance score trends

### 3.5 Risk Register (`/risks`)
**Purpose:** Enterprise risk identification, assessment, and treatment.

**Key Features:**
- Risk registry with severity scoring
- Risk treatment action plans
- Risk export to CSV
- UUID-based risk identification (non-sequential for security)
- Risk trend analysis

### 3.6 Policy Governance (`/policies`)
**Purpose:** Policy lifecycle management from creation to retirement.

**Key Features:**
- Policy creation and versioning
- Approval workflows
- Policy distribution tracking
- Review scheduling
- Compliance mapping

### 3.7 Vendor Risk Management (`/vendors`)
**Purpose:** Third-party vendor risk assessment and monitoring.

**Key Features:**
- Vendor registry
- Risk scoring and categorization
- Due diligence tracking
- Contract management
- Vendor performance metrics

### 3.8 Call Intelligence (`/calls`)
**Purpose:** AI-powered call quality analysis and compliance monitoring.

**Key Features:**
- Call recording analysis
- Quality scoring per call
- Compliance checklist verification
- CRM update compliance checking
- Agent performance insights

### 3.9 ROI & NPV Evaluation (`/roi`)
**Purpose:** Financial impact analysis for deals and projects.

**Key Features:**
- ROI calculation
- Net Present Value analysis
- Deal evaluation scoring
- Financial validation (non-negative, max value checks)

### 3.10 Team Performance (`/team`)
**Purpose:** Team and individual performance monitoring.

**Key Features:**
- Agent performance metrics
- Quality scores per team member
- Activity compliance tracking
- Feedback collection and management

### 3.11 PMP Project Portfolio (`/projects`)
**Purpose:** Project management and portfolio tracking.

**Key Features:**
- Project registry
- Milestone tracking
- Resource allocation
- Status reporting

### 3.12 KPI Tracking (`/kpis`)
**Purpose:** Key Performance Indicator definition and monitoring.

**Key Features:**
- KPI definition and targets
- Progress tracking
- Trend visualization
- Automated data collection

### 3.13 Scorecard (`/scorecard`)
**Purpose:** Balanced scorecard for organizational performance measurement.

**Key Features:**
- Multi-dimensional scoring
- Historical trend analysis
- Benchmark comparisons

### 3.14 Duplicate Radar (`/duplicates`)
**Purpose:** CRM data deduplication and hygiene management.

**Key Features:**
- Duplicate record detection across Leads, Contacts, Deals
- Confidence scoring
- AI-powered merge recommendations
- Cluster analysis
- Bulk duplicate management

### 3.15 PDPL Privacy Compliance (`/pdpl`)
**Purpose:** Personal Data Protection Law compliance tracking (Saudi Arabia).

**Key Features:**
- Data processing activity registry
- Consent management
- Privacy impact assessments
- Data subject request tracking

### 3.16 Table F Governance (`/tablef`)
**Purpose:** Table F compliance tracking and governance scoring.

**Key Features:**
- Governance rule compliance
- Field completeness tracking
- Stage progression analysis
- Activity logging compliance

### 3.17 CRM Integration (`/crm`)
**Purpose:** Zoho CRM data viewing and analysis.

**Key Features:**
- Live CRM data browsing (Leads, Deals, Contacts, Tasks, Accounts)
- Record detail viewing
- Data hygiene analysis
- Connection status monitoring

### 3.18 System Event Logs (`/logs`)
**Purpose:** Audit trail for all system activities.

**Key Features:**
- Action logging (create, update, delete)
- User activity tracking
- API access logs
- Security event monitoring

### 3.19 Additional Modules
- **Executive Dashboard** (`/executive`) — High-level executive summary
- **Data Migration** (`/migration`) — Data import/export tools
- **Feedback** (`/feedback`) — User feedback collection
- **Onboarding** (`/onboarding`) — New user onboarding flow
- **Admin Panel** (`/admin`) — System administration (requires Admin API Key)

---

## 4. Zoho CRM Integration

### 4.1 Connection Details
- **Access Type:** Read-only (OAuth 2.0 with auto-refresh)
- **Environment:** Zoho CRM Production
- **Authentication:** OAuth client credentials with refresh token (auto-renews every hour)

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
- No write operations (read-only token)

### 4.4 AI Audit Process
When "Run AI Audit" is triggered:
1. System authenticates to Zoho CRM via OAuth
2. Fetches up to 100 records per module (Leads, Deals, Contacts, Tasks)
3. Applies governance rules to each record (missing fields, format validation, enum checks)
4. Calculates quality scores (People, Process, Governance)
5. Saves results to database
6. Dashboard refreshes with new scores

---

## 5. AI Agents

### 5.1 Quality Specialist Agent
- Performs comprehensive CRM data hygiene audits
- Analyzes record completeness and compliance
- Generates quality improvement recommendations

### 5.2 SDR Quality Agent
- Evaluates SDR (Sales Development Representative) call quality
- Checks CRM update compliance after calls
- Scores agent performance

### 5.3 Sales Quality Agent
- Monitors sales process adherence
- Evaluates deal stage progression
- Assesses pipeline hygiene

---

## 6. AI Tools

| Tool | Function |
|------|----------|
| **CRM Hygiene Audit** | Audits Zoho CRM records for data quality issues |
| **CRM Activity Check** | Verifies activity compliance and follow-ups |
| **Call Analysis** | AI-powered call recording analysis |
| **Call Ingest** | Processes and stores call recordings |
| **CRM Compliance** | Validates post-call CRM updates |
| **Deal Evaluation** | Assesses deal quality and risk |
| **CAPA Management** | Corrective/Preventive Action tracking |
| **NC Management** | Non-Conformance tracking |
| **Meeting MOM** | Minutes of Meeting generation |
| **Email Reports** | Automated email report delivery |
| **Training Management** | Training record management |
| **Google Calendar** | Calendar integration for scheduling |

---

## 7. Automated Workflows

### 7.1 Weekly Quality Audit
- **Schedule:** Every Monday at 8:00 AM
- **Process:** Automatically runs CRM hygiene audit across all modules
- **Output:** Updated quality scores, issue reports, trend data

---

## 8. Security Architecture

### 8.1 Authentication
- Replit Auth (OIDC) supporting Google, GitHub, Apple, and email
- HMAC-signed session cookies (7-day expiry)
- HttpOnly, Secure, SameSite=Lax cookie flags

### 8.2 Authorization
- Role-Based Access Control (RBAC) enforced globally
- Route permission map controls per-endpoint access
- Admin API Key for system administration endpoints

### 8.3 Data Protection
- CSP with per-request nonces (no unsafe-inline for scripts)
- Input sanitization (HTML stripping, CSV formula prevention)
- Rate limiting (auth-aware, per-IP)
- Endpoint enumeration prevention (403 for non-existing protected routes)
- UUID-based resource identification (non-sequential IDs)
- Password policy: 12+ characters, uppercase, lowercase, number, special character

### 8.4 Penetration Testing
- **37 out of 37 findings remediated** (VAPT v1, v2, v3, and retest)
- All critical, high, medium, and low severity issues resolved
- Documentation: `docs/VAPT_Remediation_Report.md`

---

## 9. Environment Configuration

### 9.1 Required Secrets
| Secret | Purpose |
|--------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `SESSION_SECRET` | Cookie signing |
| `ADMIN_API_KEY` | Admin panel access |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM OAuth |
| `RESEND_API_KEY` | Email delivery |
| `RESEND_FROM_EMAIL` | Sender address |

### 9.2 Environment Variables
| Variable | Default | Purpose |
|----------|---------|---------|
| `ZOHO_ACCOUNTS_URL` | https://accounts.zoho.com | Zoho OAuth endpoint |
| `ZOHO_API_DOMAIN` | https://www.zohoapis.com | Zoho API domain |

---

## 10. Database

- **Engine:** PostgreSQL
- **Tables:** 39+ auto-initialized tables
- **Key Table Groups:**
  - Quality: scorecards, audit results, trends, governance documents
  - Risk: enterprise risks, risk treatment actions
  - Compliance: assessments, regulations, obligations
  - CRM: duplicate radar records, call records, compliance checks
  - Users: platform users, invitations, RBAC permissions
  - Operations: event logs, feedback, KPIs, policies, vendors

---

## 11. Deployment

- **Hosting:** Replit Autoscale
- **Domain:** qms-dashboard.replit.app
- **Process:** Publish via Replit dashboard
- **Health:** Automatic health checks and restart

---

## 12. Support & Troubleshooting

### Common Issues
| Issue | Solution |
|-------|----------|
| Can't log in | Clear browser cookies, try a different auth provider |
| Dashboard shows 0 records | Run AI Audit to fetch fresh CRM data |
| Permission denied | Contact admin to upgrade your role |
| Audit shows sample data | Verify Zoho CRM credentials are configured |
| Page not loading | Check internet connection, try hard refresh (Ctrl+Shift+R) |

### Contact
- Platform Admin: Use the admin panel or contact your system administrator
- Feedback: Use the "Give Feedback" button on any dashboard page
