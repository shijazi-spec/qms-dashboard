# WalaPlus Enterprise GRC & Quality Management Platform - Technical Scope of Work

**Version 2.2** | Last Updated: 2026-05-21

> **Companion document:** [USER_MANUAL.md](./USER_MANUAL.md) — end-user documentation for every module specified here. Section cross-references are noted at each module spec.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Module Specifications](#3-module-specifications)
4. [API Reference](#4-api-reference)
5. [Database Schema](#5-database-schema)
6. [External Integrations](#6-external-integrations)
7. [AI/ML Components](#7-aiml-components)
8. [Security & Compliance](#8-security--compliance)
9. [UI/UX Specifications](#9-uiux-specifications)
10. [Deployment & Infrastructure](#10-deployment--infrastructure)
11. [GRC Module Specifications](#11-grc-module-specifications)
12. [Hosting, Data Classification & Migration Plan](#12-hosting-data-classification--migration-plan)

---

## 1. Executive Summary

### Project Overview

WalaPlus Enterprise GRC & Quality Management Platform is an enterprise-grade system combining governance, risk, and compliance (GRC) with quality management. It provides autonomous monitoring, governance validation, quality scoring, risk management, policy governance, compliance tracking, and vendor risk assessment.

### Technology Stack

| Component | Technology |
|-----------|------------|
| Backend Framework | Mastra (TypeScript) |
| AI/LLM | GPT-4o via Replit AI Integrations |
| Database | PostgreSQL (Neon-backed) with 39+ tables |
| Workflow Orchestration | Inngest |
| Email | Replit Mail |
| Frontend | HTML5, TailwindCSS, Chart.js |
| Runtime | Node.js 20+ |

### Core Modules (19 Total)

#### Quality Management Modules (10)
1. Quality Dashboard (`/`)
2. Admin Panel (`/admin`)
3. QMS Dashboard (`/qms`)
4. Testing Sandbox (`/sandbox`)
5. Table F Governance Engine (`/tablef`)
6. Call Intelligence (`/calls`)
7. ROI & NPV Evaluation Engine (`/roi`)
8. Quality Team Performance Tracker (`/team`)
9. PMP Project Portfolio (`/projects`)
10. System Event Logs (`/logs`)

#### Enterprise GRC Modules (8)
11. GRC Control Tower (`/grc`)
12. Enterprise Risk Register (`/risks`)
13. Policy & Document Governance (`/policies`)
14. Compliance & Regulatory Tracker (`/compliance`)
15. Audit Readiness Module (`/audits`)
16. Vendor Risk Management (`/vendors`)
17. Data Migration Engine (`/migration`)
18. Duplicate Radar (`/duplicates`)

#### Support Modules (1)
19. User Onboarding & Help (`/onboarding`)

---

## 2. System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Frontend Layer                              │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │Dashboard│ │   QMS   │ │ Table F │ │  Calls  │ │   ROI   │   │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘   │
│       │           │           │           │           │         │
│  ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐   │
│  │  Team   │ │Projects │ │  Logs   │ │ Sandbox │ │  Admin  │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
└─────────────────────────────┬───────────────────────────────────┘
                              │ REST API
┌─────────────────────────────┴───────────────────────────────────┐
│                      Mastra Backend                              │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Route Handlers                         │    │
│  │  dashboardRoutes │ tablefRoutes │ callIntelligenceRoutes │    │
│  │  roiRoutes │ teamRoutes │ pmpRoutes │ eventLogsRoutes    │    │
│  └─────────────────────────┬───────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────┴───────────────────────────────┐    │
│  │                 Database Utilities                        │    │
│  │  database.ts │ qmsDatabase.ts │ roiDatabase.ts          │    │
│  │  teamDatabase.ts │ callIntelligenceDb.ts │ eventLogsDb  │    │
│  └─────────────────────────┬───────────────────────────────┘    │
│                            │                                     │
│  ┌─────────────────────────┴───────────────────────────────┐    │
│  │              AI Agent & Workflow Engine                   │    │
│  │  qualitySpecialistAgent │ qualityAuditWorkflow           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                    Data & Services Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  PostgreSQL  │  │ Replit Mail  │  │   Inngest    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Google Cal   │  │  Zoho CRM    │  │    Five9     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Mastra Instance                          │
│  src/mastra/index.ts                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │    Agent     │  │   Workflow   │  │    Tools     │      │
│  │ (1 instance) │  │ (1 instance) │  │  (multiple)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────────────────────────────────────────┐      │
│  │               Custom Routes (7 files)              │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Module Specifications

### 3.1 Quality Dashboard

**File:** `dashboard/index.html`

**Purpose:** Real-time quality metrics visualization and monitoring.

**Features:**
- Overall Quality Score (0-100)
- 3D Score Breakdown (People, Process, Governance)
- Issues by Category with drill-down
- Historical trend charts
- AI-powered recommendations
- Customizable widget layout
- Date range filtering

**Data Sources:**
- Quality audit results (PostgreSQL)
- Google Calendar events
- Zoho CRM data

---

### 3.2 Admin Panel

**File:** `dashboard/admin.html`

**Purpose:** Governance document and scorecard weight management.

**Features:**
- Governance document CRUD with version control
- Scorecard weight configuration
- Audit trail of changes
- Access control

**Security:** Requires ADMIN_API_KEY header

---

### 3.3 QMS Dashboard

**File:** `dashboard/qms.html`

**Purpose:** Quality Management System per ISO 9001/COPC/Six Sigma.

**Features:**
- Deal Evaluations - Quality assessments of deals
- CAPA Management - Corrective and Preventive Actions
- Nonconformance Tracking - Issue logging and resolution
- Training Compliance - Team training status
- Framework Reference - Compliance standard documentation

**Tabs:** Overview, Evaluations, CAPA, NC, Training, Framework

---

### 3.4 Table F Governance Engine

**File:** `dashboard/tablef.html`

**Purpose:** COPC 50/75 KPI compliance tracking.

**Features:**
- Department-level KPI management
- COPC 50/75 compliance calculation:
  - 50% of KPIs must be Met
  - 75% of KPIs must be Met or Improving
- Performance trend tracking
- AI risk assessments
- CSV export

**Tabs:** Overview, Department View, KPI Manager, AI Insights, Access & Roles

---

### 3.5 Call Intelligence Module

**File:** `dashboard/calls.html`

**Purpose:** AI-powered call analysis and CRM compliance.

**Features:**
- Call record ingestion (Five9 integration)
- AI Analysis:
  - Sentiment scoring (0-100)
  - Voice of Customer extraction
  - Topic detection
  - Objection handling assessment
  - Call summarization
  - Action item extraction
- CRM Compliance Verification:
  - Notes updated
  - Call logged
  - Task created
  - Stage updated
  - Meeting outcome logged
- QA Scoring

**Tabs:** Overview, Call Records, CRM Compliance, Analytics

---

### 3.6 ROI & NPV Evaluation Engine

**File:** `dashboard/roi.html`

**Purpose:** Financial evaluation of quality improvement initiatives using Hybrid Business Case model.

**Features:**
- Initiative Creation with 7 cost sections:
  - A. Basic Information
  - B. Manpower Cost Breakdown
  - C. Platform Costs
  - D. Error/Rework Costs
  - E. Revenue Impact
  - F. Implementation Breakdown
  - G. Risk Inputs
- Auto-calculated metrics:
  - ROI % = (Benefits - Costs) / Costs x 100
  - NPV = Sum of (Cash Flow / (1 + r)^t)
  - Payback Period (months)
- AI Recommendations (Approve/Evaluate/Reject)
- AI Validation checks
- Charts and analytics

**Currency:** SAR (Saudi Riyal)

---

### 3.7 Quality Team Performance Tracker

**File:** `dashboard/team.html`

**Purpose:** Team management, performance tracking, and training compliance.

**Features:**
- Team Member Management:
  - CRUD operations
  - Status tracking (Active, Inactive, On Leave, Probation)
  - Performance scoring
- Training System:
  - Course catalog management
  - Assignment and completion tracking
  - Training matrix visualization
- Project Assignments:
  - Table and Kanban views
  - Status workflow (Assigned -> In Progress -> Completed)
  - Priority levels
- AI Scope Generator:
  - Generates project scope documents using GPT-4o
- **Team Performance Scorecards (GRQ scope — deferred, see [§4.1.2](#412-grq-role-based-scorecard-management-api-new-in-v21) + [§5.15](#515-grq-role-based-scorecard-tables-new-in-v21)):**
  - Per-role KPI scorecards for GRQ team members with platform access
  - In-scope roles: `head_of_operations_quality` (Head of Ops & GRQ), `quality_manager`, `grc_manager`, `quality_specialist` (GRQ Specialist)
  - Each scorecard follows the Mohammed pattern: weighted KPIs with current value, target, RAG status, trend, navigation_map, and data_sources
  - Surfaced as the "Team Performance" tab within `/team` once delivered — not as a standalone `/scorecard` page

**Tabs:** Overview, Team Members, Training Courses, Training Matrix, Projects, Analytics, **Team Performance** *(scorecards — deferred)*

---

### 3.8 PMP Project Portfolio

**File:** `dashboard/projects.html`

**Purpose:** Full PMP-compliant project management covering 10 PMBOK knowledge areas.

**Features:**
- Portfolio Dashboard with metrics:
  - SPI (Schedule Performance Index)
  - CPI (Cost Performance Index)
  - At Risk count
  - High Risks count
- Project CRUD with status workflow
- Risk Register with 5x5 matrix
- Milestone Timeline with Gantt chart
- Stakeholder Register with influence/interest mapping
- Procurement Management
- Change Control with approval workflow
- AI Charter Generator
- Full Scope Wizard

**Tabs:** Portfolio, Analytics, Risks, Milestones, Stakeholders, Procurement, Changes

**PMBOK Knowledge Areas Covered:**
1. Integration Management
2. Scope Management
3. Schedule Management
4. Cost Management
5. Quality Management
6. Resource Management
7. Communications Management
8. Risk Management
9. Procurement Management
10. Stakeholder Management

---

### 3.9 System Event Logs

**File:** `dashboard/logs.html`

**Purpose:** Enterprise-grade audit telemetry for compliance.

**Features:**
- Immutable append-only design
- SHA-256 checksums for tamper detection
- Monthly table partitioning for scalability
- Severity levels: INFO, WARNING, CRITICAL
- AI involvement tracking
- Correlation IDs for cross-module tracing
- Comprehensive filtering
- CSV export for compliance audits

**Compliance:** ISO 9001, COPC, Six Sigma audit requirements

---

### 3.10 Testing Sandbox

**File:** `dashboard/sandbox.html`

**Purpose:** Safe testing environment with mock data.

**Features:**
- Mock data generation
- Score calculation testing
- Dashboard preview
- No production data impact

---

### 3.11 User Onboarding & Help

> **Documented in:** [USER_MANUAL.md §21 — User Onboarding & Help](./USER_MANUAL.md#21-user-onboarding--help).

**File:** `dashboard/onboarding.html`
**Route File:** `src/mastra/routes/onboardingRoutes.ts`

**Purpose:** Guided activation surface for new users and a shareable demo channel for external stakeholders. Reduces time-to-first-value and gives admins visibility into adoption.

**Features:**
- **Welcome modal** — Introduction video (2–4 min) + Start Tour / Skip controls
- **Guided tour (6 steps)** — Walks new users through: Dashboard Overview → Projects & Governance → ROI/NPV Calculator → Event Logs → AI Assistance → Submission Flow
- **Progress tracking** — Per-user completion state (video watched, tour completed) with a visual progress bar
- **Quick actions** — "Watch Introduction Video", "Restart Guided Tour", "Submit New Initiative" deep-links
- **Contextual tooltips** — Purple `?` icons on ROI form fields with field-level explanations
- **Shareable demo links** — Admins can mint time-limited, view-only links for external stakeholders with view-count tracking
- **Admin view** — `/onboarding?admin=true` exposes: total onboarded users, video watch count, tour completion rate, demo-link management

**API Endpoints (see also §4):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/onboarding/status` | Get current user's onboarding state |
| GET | `/api/onboarding/stats` | Admin-only aggregate stats |
| POST | `/api/onboarding/demo-link` | Mint a new shareable demo link |
| GET | `/api/onboarding/demo-links` | List existing demo links (admin) |

**Access Control:** Any authenticated user can access `/onboarding`. The admin sub-view and demo-link mint are gated to `admin` role.

---

## 4. API Reference

### 4.1 Dashboard Routes

**File:** `src/mastra/index.ts` (Dashboard API section)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Fetch dashboard data |
| GET | `/api/audit/latest` | Get latest audit result |
| GET | `/api/audit/history` | Get audit history |
| GET | `/api/governance` | Get active governance document |
| GET | `/api/scorecard` | Get active scorecard |
| POST | `/api/audit/trigger` | Trigger manual audit |
| GET | `/api/agents/performance` | Get agent performance from CRM Lead Owners |

---

### 4.1.1 Agent Performance API (NEW in v2.1)

**Endpoint:** `GET /api/agents/performance`

**Description:** Returns agent/team member performance metrics calculated from CRM Lead Owner data.

**Response:**
```json
{
  "success": true,
  "mode": "MOCK" | "REAL",
  "agents": [
    {
      "id": "user_002",
      "name": "Sara Mohammed",
      "team": "SDR",
      "role": "SDR Representative",
      "score": 82,
      "recordsAudited": 23,
      "issues": {
        "critical": 0,
        "high": 3,
        "medium": 3,
        "low": 2
      }
    }
  ],
  "totalLeads": 50,
  "totalDeals": 30
}
```

**Score Calculation:**
- Weighted issues: Critical (4x), High (3x), Medium (2x), Low (1x)
- Score = 100 - (weightedIssues / maxPossibleWeight) * 100

---

### 4.1.2 GRQ Role-Based Scorecard Management API (NEW in v2.1)

> **DELIVERY STATUS — DEFERRED (as of v2.2 / 2026-05-21):**
>
> **Intent:** The scorecard system is a tracking surface for **all KPIs assigned to each GRQ team role** — one scorecard per role (Quality Manager, GRC Manager, Quality & GRC Governance Officer, Quality Specialist, Auditor, AI Specialist, Head of Operations & Quality, etc.). Each scorecard carries the KPIs relevant to that role on the same pattern shipped today for Mohammed: weighted KPIs with current value, target, RAG status, trend, navigation_map (drill-down path), and data_sources. The endpoints below are what an Admin needs to author, version, and activate those role scorecards from the platform UI.
>
> **Current state:** Only `getMohammedScorecard()` is implemented (`src/mastra/routes/scorecardRoutes.ts:77`), serving the **single Quality & GRC Governance Officer scorecard** for Mohammed Al Muzaini with 6 hard-coded KPIs (see [MOHAMMED_SCOPE_OF_WORK.md](./MOHAMMED_SCOPE_OF_WORK.md)). The remaining GRQ team roles have **no scorecard surface**. The endpoints below — CRUD per role, activate, clone, attribute management — are not built, and the §5.15 schema is not yet created in the database.
>
> **Placement (when built):** Lives inside the Quality Team Performance Tracker (§3.7) as a new "Team Performance" tab within `/team` — **not** as a standalone `/scorecard` page. Audience is restricted to GRQ team members with platform access: `head_of_operations_quality`, `quality_manager`, `grc_manager`, `quality_specialist`. The `/scorecard` page may be retired or redirected once Team Performance ships.
>
> **Resolution path:** Either (a) extend the Mohammed pattern role-by-role into the schema in §5.15, (b) descope the role-based scorecard from the SoW, or (c) re-baseline before v2.3. The pattern itself is sound — only the multiplexing across roles is missing.

**File:** `src/mastra/index.ts` (Admin Scorecard Routes)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/scorecards` | List all scorecards (filter by module, team) |
| POST | `/api/admin/scorecards` | Create new scorecard |
| GET | `/api/admin/scorecards/:id` | Get scorecard by ID |
| PUT | `/api/admin/scorecards/:id` | Update scorecard |
| DELETE | `/api/admin/scorecards/:id` | Delete scorecard |
| PUT | `/api/admin/scorecards/:id/activate` | Set scorecard as active for team |
| POST | `/api/admin/scorecards/:id/clone` | Clone scorecard with new version |
| GET | `/api/admin/scorecards/:id/attributes` | Get scorecard attributes |
| POST | `/api/admin/scorecards/:id/attributes` | Add attribute to scorecard |
| PUT | `/api/admin/scorecards/:id/attributes/:attrId` | Update attribute |
| DELETE | `/api/admin/scorecards/:id/attributes/:attrId` | Delete attribute |
| PUT | `/api/admin/scorecards/:id/attributes/reorder` | Reorder attributes |

---

### 4.2 Table F Routes

**File:** `src/mastra/index.ts` (Table F API section)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tablef/departments` | Fetch active departments |
| GET | `/api/tablef/kpis` | Fetch KPIs (filter by department) |
| POST | `/api/tablef/kpis` | Create/update KPI |
| DELETE | `/api/tablef/kpis/:kpiId` | Archive KPI |
| GET | `/api/tablef/performance` | Get performance data |
| POST | `/api/tablef/performance` | Log performance entry |
| GET | `/api/tablef/snapshots` | Get snapshots |
| POST | `/api/tablef/snapshots/calculate` | Calculate department snapshots |
| GET | `/api/tablef/users` | Get users |
| POST | `/api/tablef/users` | Create/update user |
| GET | `/api/tablef/insights` | Get AI insights |

---

### 4.3 Call Intelligence Routes

**File:** `src/mastra/routes/callIntelligenceRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/calls/ingest` | Ingest call record |
| GET | `/api/calls` | List call records (paginated) |
| GET | `/api/calls/analytics` | Get call analytics summary |
| GET | `/api/calls/compliance` | Get compliance records |
| GET | `/api/calls/:callId` | Get call with full analysis |
| POST | `/api/calls/:callId/analyze` | Trigger AI analysis |
| POST | `/api/calls/:callId/compliance` | Run CRM compliance check |
| GET | `/api/calls/:callId/compliance` | Get compliance data |
| GET | `/api/calls/:callId/transcript` | Get transcript |
| GET | `/api/calls/agent/:email` | Get calls by agent |
| GET | `/api/calls/lead/:leadId` | Get calls by lead |
| POST | `/api/meetings/mom` | Generate Minutes of Meeting |
| GET | `/api/meetings/mom/:eventId` | Get MoM for event |
| GET | `/calls` | Serve dashboard HTML |

---

### 4.4 ROI Routes

**File:** `src/mastra/routes/roiRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/roi` | List initiatives (filtered, sorted) |
| GET | `/api/roi/analytics` | Get ROI analytics |
| POST | `/api/roi/calculate` | Calculate ROI metrics |
| POST | `/api/roi` | Create initiative |
| GET | `/api/roi/initiatives/:id/full` | Get full initiative details |
| POST | `/api/roi/initiatives/:id/manpower` | Save manpower breakdown |
| POST | `/api/roi/initiatives/:id/platform-costs` | Add platform cost |
| GET | `/api/roi/initiatives/:id/platform-costs` | List platform costs |
| DELETE | `/api/roi/platform-costs/:costId` | Delete platform cost |
| POST | `/api/roi/initiatives/:id/error-costs` | Save error costs |
| POST | `/api/roi/initiatives/:id/revenue-impact` | Save revenue impact |
| POST | `/api/roi/initiatives/:id/implementation` | Save implementation |
| POST | `/api/roi/initiatives/:id/risk-inputs` | Save risk inputs |
| GET | `/api/roi/initiatives/:id/validation-logs` | Get validation logs |
| POST | `/api/roi/initiatives/:id/validate` | Run AI validation |
| GET | `/api/roi/:id` | Get initiative by ID |
| PUT | `/api/roi/:id` | Update initiative |
| DELETE | `/api/roi/:id` | Delete initiative |
| GET | `/roi` | Serve dashboard HTML |

---

### 4.5 Team Routes

**File:** `src/mastra/routes/teamRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/team/members` | List team members |
| POST | `/api/team/members` | Create member |
| GET | `/api/team/members/:memberId` | Get member |
| PUT | `/api/team/members/:memberId` | Update member |
| DELETE | `/api/team/members/:memberId` | Delete member |
| GET | `/api/team/analytics` | Get team analytics |
| GET | `/api/team/performance` | Get performance metrics |
| POST | `/api/team/performance` | Add performance metric |
| GET | `/api/team/projects` | List project assignments |
| POST | `/api/team/projects` | Create assignment |
| PUT | `/api/team/projects/:assignmentId` | Update assignment |
| DELETE | `/api/team/projects/:assignmentId` | Delete assignment |
| GET | `/api/team/training-matrix` | Get training matrix |
| GET | `/api/team/courses` | List courses |
| POST | `/api/team/courses` | Create course |
| GET | `/api/team/courses/:courseId` | Get course |
| PUT | `/api/team/courses/:courseId` | Update course |
| DELETE | `/api/team/courses/:courseId` | Delete course |
| GET | `/api/team/course-assignments` | List course assignments |
| POST | `/api/team/course-assignments` | Create assignment |
| PUT | `/api/team/course-assignments/:assignmentId` | Update assignment |
| DELETE | `/api/team/course-assignments/:assignmentId` | Delete assignment |
| GET | `/api/team/kanban` | Get Kanban data |
| GET | `/api/team/course-training-matrix` | Get course matrix |
| GET | `/api/audit-trail` | Get audit logs |
| POST | `/api/team/ai-scope-generator` | Generate AI scope |
| GET | `/team` | Serve dashboard HTML |

---

### 4.6 PMP Routes

**File:** `src/mastra/routes/pmpRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/pmp/projects` | List projects |
| POST | `/api/pmp/projects` | Create project |
| GET | `/api/pmp/projects/:projectId` | Get project with related data |
| PUT | `/api/pmp/projects/:projectId` | Update project |
| DELETE | `/api/pmp/projects/:projectId` | Delete project |
| GET | `/api/pmp/risks` | List risks |
| POST | `/api/pmp/risks` | Create risk |
| GET | `/api/pmp/risks/:riskId` | Get risk |
| PUT | `/api/pmp/risks/:riskId` | Update risk |
| DELETE | `/api/pmp/risks/:riskId` | Delete risk |
| GET | `/api/pmp/milestones` | List milestones |
| POST | `/api/pmp/milestones` | Create milestone |
| GET | `/api/pmp/milestones/:milestoneId` | Get milestone |
| PUT | `/api/pmp/milestones/:milestoneId` | Update milestone |
| DELETE | `/api/pmp/milestones/:milestoneId` | Delete milestone |
| GET | `/api/pmp/stakeholders` | List stakeholders |
| POST | `/api/pmp/stakeholders` | Create stakeholder |
| GET | `/api/pmp/stakeholders/:stakeholderId` | Get stakeholder |
| PUT | `/api/pmp/stakeholders/:stakeholderId` | Update stakeholder |
| DELETE | `/api/pmp/stakeholders/:stakeholderId` | Delete stakeholder |
| GET | `/api/pmp/portfolio/analytics` | Get portfolio analytics |
| GET | `/api/pmp/projects/:projectId/gantt` | Get Gantt chart data |
| POST | `/api/pmp/generate-charter` | AI generate charter |
| GET | `/api/pmp/procurement` | List procurement |
| POST | `/api/pmp/procurement` | Create procurement |
| GET | `/api/pmp/procurement/:procurementId` | Get procurement |
| PUT | `/api/pmp/procurement/:procurementId` | Update procurement |
| DELETE | `/api/pmp/procurement/:procurementId` | Delete procurement |
| GET | `/api/pmp/change-requests` | List change requests |
| POST | `/api/pmp/change-requests` | Create change request |
| GET | `/api/pmp/change-requests/:changeRequestId` | Get change request |
| PUT | `/api/pmp/change-requests/:changeRequestId` | Update change request |
| DELETE | `/api/pmp/change-requests/:changeRequestId` | Delete change request |
| GET | `/projects` | Serve dashboard HTML |

---

### 4.7 Event Logs Routes

**File:** `src/mastra/routes/eventLogsRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs` | List logs (paginated, filtered) |
| GET | `/api/logs/stats` | Get log statistics |
| GET | `/api/logs/export` | Export logs as CSV |
| GET | `/api/logs/:id` | Get specific log entry |
| POST | `/api/logs` | Create log entry |
| GET | `/logs` | Serve dashboard HTML |

**Query Parameters for GET /api/logs:**
- `page` - Page number (default: 1)
- `pageSize` - Items per page (default: 50)
- `module` - Filter by module
- `severity` - Filter by severity
- `actionType` - Filter by action type
- `entityType` - Filter by entity type
- `correlationId` - Filter by correlation ID
- `fromDate` - Start date filter
- `toDate` - End date filter

---

### 4.8 RBAC (Role-Based Access Control) Routes

**File:** `src/mastra/routes/rbacRoutes.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rbac/users` | List system users (filter by role, department) |
| GET | `/api/rbac/users/:email` | Get user by email |
| POST | `/api/rbac/users` | Create system user |
| PUT | `/api/rbac/users/:id` | Update system user |
| GET | `/api/rbac/permissions/:role` | Get role permissions |
| POST | `/api/rbac/check-permission` | Check if user has permission |
| GET | `/api/rbac/bu-processes` | List business unit processes |
| POST | `/api/rbac/bu-processes` | Create BU process |
| PUT | `/api/rbac/bu-processes/:id` | Update BU process |
| POST | `/api/rbac/calculate-control-readiness` | Calculate control readiness scores |
| POST | `/api/rbac/escalate-overdue` | Escalate overdue actions |
| GET | `/api/rbac/escalations` | List escalation log entries |
| PUT | `/api/rbac/escalations/:id/resolve` | Resolve escalation |
| GET | `/api/rbac/roles` | List available roles |

**Role-Protected Endpoints:**

| Method | Endpoint | Required Role | Description |
|--------|----------|---------------|-------------|
| POST | `/api/risks/:id/accept` | grc_manager | Accept risk (returns 403 if unauthorized) |
| POST | `/api/policies/:id/grc-approval` | grc_manager | Approve policy for publication |
| POST | `/api/policies/:id/publish` | any (requires prior GRC approval) | Publish policy |
| POST | `/api/policies/:id/set-owners` | any | Set dual ownership (operational + compliance) |

**System Roles:**

The platform defines **12 roles** in `UserRole` (`src/utils/rbacDatabase.ts:8-20`). Default permissions for the 7 primary roles are seeded in `ROLE_PERMISSIONS` (`rbacDatabase.ts:60-141`); the 5 secondary roles inherit zero defaults from `DEFAULT FALSE` on every permission column and are intended for org-specific customization.

| Role | Tier | Default Capabilities | Typical User |
|------|------|----------------------|--------------|
| admin | Primary | Full system access incl. user management | System Admin |
| head_of_operations_quality | Primary | Accept risks, approve policies, close findings, edit controls, create CAPA, executive view (audit programme sign-off per ISO 19011 §5.2) | Head of Ops & Quality |
| grc_manager | Primary | Accept risks, approve policies, compliance sign-off, executive view | Maram |
| quality_manager | Primary | Close findings, edit controls, create CAPA, submit evidence | Sara |
| ai_specialist | Primary | Executive view + configure AI settings (no write actions) | AI Team |
| bu_owner | Primary | Submit evidence; update action status only | Department Heads |
| executive | Primary | Read-only strategic / executive views | C-Suite |
| quality_specialist | Secondary | None by default — customizable in admin | Quality Analysts |
| team_lead | Secondary | None by default — customizable in admin | Team Leads |
| department_viewer | Secondary | None by default — customizable in admin | Departmental Reviewers |
| auditor | Secondary | None by default — customizable in admin (intended read-only audit access) | Internal/External Auditors |
| custom | Secondary | None by default — fully configurable per user | Tenant-specific roles |

> **Doc-sync note (2026-05-21):** The §5.6 `role_permissions` schema below predates the current `RolePermission` interface (`rbacDatabase.ts:48-58`). Code adds `can_close_finding`, `can_view_executive`, `can_edit_controls`, `can_submit_evidence` and removes `can_approve_capa`, `can_create_finding`, `can_create_training`, `can_approve_compliance`, `can_view_dashboards`. Schema reconciliation to be tracked in a separate ticket.

---

## 5. Database Schema

### 5.1 Event Logs Table (Partitioned)

```sql
CREATE TABLE event_logs (
  id SERIAL,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  user_id INTEGER,
  user_name VARCHAR(255),
  user_email VARCHAR(255),
  user_role VARCHAR(50),
  action_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100),
  entity_name VARCHAR(255),
  description TEXT,
  old_value JSONB,
  new_value JSONB,
  ai_involved BOOLEAN DEFAULT FALSE,
  severity VARCHAR(20) DEFAULT 'INFO',
  correlation_id VARCHAR(100),
  ip_address VARCHAR(45),
  user_agent TEXT,
  module VARCHAR(50),
  checksum VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);
```

**Partitions:** Monthly (previous, current, next month auto-created)

**Indexes:**
- `idx_event_logs_timestamp`
- `idx_event_logs_user_id`
- `idx_event_logs_action_type`
- `idx_event_logs_entity_type`
- `idx_event_logs_module`
- `idx_event_logs_severity`
- `idx_event_logs_correlation_id`
- `idx_event_logs_created_at`

---

### 5.2 ROI Tables

**roi_initiatives**
```sql
CREATE TABLE roi_initiatives (
  id SERIAL PRIMARY KEY,
  project_name VARCHAR(255) NOT NULL,
  department VARCHAR(100),
  priority VARCHAR(20) DEFAULT 'medium',
  problem_statement TEXT,
  expected_savings_monthly DECIMAL(15,2) DEFAULT 0,
  implementation_cost DECIMAL(15,2) DEFAULT 0,
  project_duration_months INTEGER DEFAULT 12,
  discount_rate DECIMAL(5,2) DEFAULT 10,
  calculated_roi DECIMAL(10,2),
  calculated_npv DECIMAL(15,2),
  calculated_payback_months DECIMAL(10,2),
  ai_recommendation VARCHAR(50),
  ai_recommendation_text TEXT,
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**roi_manpower_breakdown**
```sql
CREATE TABLE roi_manpower_breakdown (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  avg_monthly_salary DECIMAL(15,2),
  gosi_percent DECIMAL(5,2),
  insurance_cost DECIMAL(15,2),
  equipment_cost DECIMAL(15,2),
  software_seat_cost DECIMAL(15,2),
  headcount_affected INTEGER,
  months_saved DECIMAL(10,2),
  total_manpower_savings DECIMAL(15,2)
);
```

**roi_platform_costs**
```sql
CREATE TABLE roi_platform_costs (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  platform_name VARCHAR(255),
  monthly_cost DECIMAL(15,2),
  category VARCHAR(100)
);
```

**roi_error_costs**
```sql
CREATE TABLE roi_error_costs (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  error_rate_percent DECIMAL(5,2),
  cost_per_error DECIMAL(15,2),
  volume_per_month INTEGER,
  total_monthly_error_cost DECIMAL(15,2)
);
```

**roi_revenue_impact**
```sql
CREATE TABLE roi_revenue_impact (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  retention_improvement_percent DECIMAL(5,2),
  new_revenue_monthly DECIMAL(15,2),
  cross_sell_revenue DECIMAL(15,2)
);
```

**roi_implementation_breakdown**
```sql
CREATE TABLE roi_implementation_breakdown (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  technology_cost DECIMAL(15,2),
  training_cost DECIMAL(15,2),
  change_management_cost DECIMAL(15,2),
  consulting_cost DECIMAL(15,2)
);
```

**roi_risk_inputs**
```sql
CREATE TABLE roi_risk_inputs (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  risk_factors TEXT,
  mitigation_cost DECIMAL(15,2),
  contingency_percent DECIMAL(5,2)
);
```

**roi_validation_logs**
```sql
CREATE TABLE roi_validation_logs (
  id SERIAL PRIMARY KEY,
  initiative_id INTEGER REFERENCES roi_initiatives(id),
  validation_type VARCHAR(100),
  result VARCHAR(50),
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 5.3 Team Tables

**team_members**
```sql
CREATE TABLE team_members (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(50),
  role VARCHAR(100),
  department VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active',
  hire_date DATE,
  performance_score DECIMAL(5,2),
  training_compliance_percent DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**training_courses**
```sql
CREATE TABLE training_courses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  course_type VARCHAR(50) DEFAULT 'optional',
  department VARCHAR(100),
  duration_hours DECIMAL(5,2),
  passing_score INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**course_assignments**
```sql
CREATE TABLE course_assignments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES team_members(id),
  course_id INTEGER REFERENCES training_courses(id),
  status VARCHAR(50) DEFAULT 'assigned',
  score INTEGER,
  completion_date DATE,
  due_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**project_assignments**
```sql
CREATE TABLE project_assignments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES team_members(id),
  project_name VARCHAR(255) NOT NULL,
  project_description TEXT,
  status VARCHAR(50) DEFAULT 'assigned',
  priority VARCHAR(20) DEFAULT 'medium',
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 5.4 PMP Tables

**pmp_projects**
```sql
CREATE TABLE pmp_projects (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  department VARCHAR(100),
  status VARCHAR(50) DEFAULT 'initiation',
  priority VARCHAR(20) DEFAULT 'medium',
  project_manager VARCHAR(255),
  sponsor VARCHAR(255),
  start_date DATE,
  end_date DATE,
  budget DECIMAL(15,2),
  actual_cost DECIMAL(15,2),
  progress_percent DECIMAL(5,2) DEFAULT 0,
  spi DECIMAL(5,2) DEFAULT 1.00,
  cpi DECIMAL(5,2) DEFAULT 1.00,
  charter TEXT,
  scope_statement TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**pmp_risks**
```sql
CREATE TABLE pmp_risks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pmp_projects(id),
  description TEXT NOT NULL,
  category VARCHAR(100),
  probability INTEGER,
  impact INTEGER,
  risk_score INTEGER,
  status VARCHAR(50) DEFAULT 'open',
  owner VARCHAR(255),
  mitigation_strategy TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**pmp_milestones**
```sql
CREATE TABLE pmp_milestones (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pmp_projects(id),
  name VARCHAR(255) NOT NULL,
  milestone_type VARCHAR(50),
  planned_date DATE,
  actual_date DATE,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**pmp_stakeholders**
```sql
CREATE TABLE pmp_stakeholders (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pmp_projects(id),
  name VARCHAR(255) NOT NULL,
  role VARCHAR(100),
  stakeholder_type VARCHAR(50),
  influence_level VARCHAR(20),
  interest_level VARCHAR(20),
  engagement_strategy TEXT,
  contact_info VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**pmp_procurement**
```sql
CREATE TABLE pmp_procurement (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pmp_projects(id),
  vendor_name VARCHAR(255),
  contract_type VARCHAR(100),
  contract_value DECIMAL(15,2),
  status VARCHAR(50),
  start_date DATE,
  end_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**pmp_change_requests**
```sql
CREATE TABLE pmp_change_requests (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES pmp_projects(id),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  requestor VARCHAR(255),
  impact_assessment TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  decision_date DATE,
  implementation_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 5.5 Call Intelligence Tables

**call_records**
```sql
CREATE TABLE call_records (
  id SERIAL PRIMARY KEY,
  call_id VARCHAR(100) UNIQUE,
  source VARCHAR(50) DEFAULT 'five9',
  lead_id VARCHAR(100),
  deal_id VARCHAR(100),
  contact_name VARCHAR(255),
  agent_email VARCHAR(255),
  agent_name VARCHAR(255),
  call_type VARCHAR(50),
  direction VARCHAR(20),
  duration_seconds INTEGER,
  recording_url TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  call_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**call_transcripts**
```sql
CREATE TABLE call_transcripts (
  id SERIAL PRIMARY KEY,
  call_record_id INTEGER REFERENCES call_records(id),
  transcript_text TEXT,
  language VARCHAR(10) DEFAULT 'en',
  confidence_score DECIMAL(5,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**call_analysis**
```sql
CREATE TABLE call_analysis (
  id SERIAL PRIMARY KEY,
  call_record_id INTEGER REFERENCES call_records(id),
  sentiment_score DECIMAL(5,2),
  sentiment_label VARCHAR(20),
  voice_of_customer TEXT,
  objections_detected JSONB,
  key_topics JSONB,
  action_items JSONB,
  next_steps JSONB,
  call_summary TEXT,
  ai_insights TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**call_qa_scores**
```sql
CREATE TABLE call_qa_scores (
  id SERIAL PRIMARY KEY,
  call_record_id INTEGER REFERENCES call_records(id),
  agent_type VARCHAR(50),
  overall_score DECIMAL(5,2),
  category_scores JSONB,
  feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**call_compliance**
```sql
CREATE TABLE call_compliance (
  id SERIAL PRIMARY KEY,
  call_record_id INTEGER REFERENCES call_records(id),
  lead_id VARCHAR(100),
  deal_id VARCHAR(100),
  notes_updated BOOLEAN,
  call_logged BOOLEAN,
  task_created BOOLEAN,
  stage_updated BOOLEAN,
  meeting_outcome_logged BOOLEAN,
  overall_compliance BOOLEAN,
  compliance_score DECIMAL(5,2),
  missing_actions JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

### 5.6 RBAC (Role-Based Access Control) Tables

**system_users**
```sql
CREATE TABLE system_users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  department VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Default Users Seeded:**
| Email | Name | Role | Department |
|-------|------|------|------------|
| sara@walaplus.sa | Sara Al-Rashid | quality_manager | Quality |
| maram@walaplus.sa | Maram Al-Ghamdi | grc_manager | GRC |
| admin@walaplus.sa | System Admin | admin | IT |
| ahmed@walaplus.sa | Ahmed Al-Farsi | bu_owner | Operations |
| fatima@walaplus.sa | Fatima Al-Hassan | executive | Executive |
| ai@walaplus.sa | AI Specialist | ai_specialist | AI Team |

**bu_processes**
```sql
CREATE TABLE bu_processes (
  id SERIAL PRIMARY KEY,
  process_code VARCHAR(50) UNIQUE NOT NULL,
  process_name VARCHAR(255) NOT NULL,
  department VARCHAR(100) NOT NULL,
  owner_email VARCHAR(255),
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**role_permissions**
```sql
CREATE TABLE role_permissions (
  id SERIAL PRIMARY KEY,
  role VARCHAR(50) UNIQUE NOT NULL,
  can_create_capa BOOLEAN DEFAULT FALSE,
  can_approve_capa BOOLEAN DEFAULT FALSE,
  can_create_finding BOOLEAN DEFAULT FALSE,
  can_create_training BOOLEAN DEFAULT FALSE,
  can_accept_risk BOOLEAN DEFAULT FALSE,
  can_approve_policy BOOLEAN DEFAULT FALSE,
  can_approve_compliance BOOLEAN DEFAULT FALSE,
  can_manage_users BOOLEAN DEFAULT FALSE,
  can_view_dashboards BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Default Role Permissions:**
| Role | Accept Risk | Approve Policy | Manage Users |
|------|-------------|----------------|--------------|
| quality_manager | No | No | No |
| grc_manager | Yes | Yes | No |
| ai_specialist | No | No | No |
| bu_owner | No | No | No |
| executive | No | No | No |
| admin | Yes | Yes | Yes |

**escalation_log**
```sql
CREATE TABLE escalation_log (
  id SERIAL PRIMARY KEY,
  source_type VARCHAR(50) NOT NULL,
  source_id INTEGER NOT NULL,
  source_title VARCHAR(255),
  days_overdue INTEGER,
  escalated_to VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending',
  resolved_by VARCHAR(255),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Policy Table Extensions (Added to existing policies table):**
```sql
ALTER TABLE policies ADD COLUMN operational_owner VARCHAR(255);
ALTER TABLE policies ADD COLUMN operational_owner_email VARCHAR(255);
ALTER TABLE policies ADD COLUMN compliance_owner VARCHAR(255);
ALTER TABLE policies ADD COLUMN compliance_owner_email VARCHAR(255);
ALTER TABLE policies ADD COLUMN compliance_approved BOOLEAN DEFAULT FALSE;
ALTER TABLE policies ADD COLUMN compliance_approved_by VARCHAR(255);
ALTER TABLE policies ADD COLUMN compliance_approved_at TIMESTAMPTZ;
ALTER TABLE policies ADD COLUMN approval_blocked_reason TEXT;
```

**Risk Table Extensions (Added to existing enterprise_risks table):**
```sql
ALTER TABLE enterprise_risks ADD COLUMN accepted_by VARCHAR(255);
ALTER TABLE enterprise_risks ADD COLUMN accepted_by_role VARCHAR(50);
ALTER TABLE enterprise_risks ADD COLUMN accepted_at TIMESTAMPTZ;
ALTER TABLE enterprise_risks ADD COLUMN acceptance_justification TEXT;
ALTER TABLE enterprise_risks ADD COLUMN grc_approval_required BOOLEAN DEFAULT FALSE;
```

---

### 5.15 GRQ Role-Based Scorecard Tables (NEW in v2.1)

> **DELIVERY STATUS — DEFERRED (as of v2.2 / 2026-05-21):** Tables below back the role-based scorecard system described in §4.1.2 — one `quality_scorecards` row per GRQ team role, with each role's KPIs broken out into `scorecard_attributes`. Tables are **not yet created** in the live database. The platform today uses only the single-employee `employee_scorecards` table (`src/utils/scorecardDatabase.ts:49`), which stores the Mohammed scorecard as a row with `kpi_details` JSONB rather than as relational attributes. Paired with the deferred API in §4.1.2; resolve together. When built, the data surfaces under §3.7's "Team Performance" tab and is scoped to GRQ roles: `head_of_operations_quality`, `quality_manager`, `grc_manager`, `quality_specialist`.

**quality_scorecards**
```sql
CREATE TABLE quality_scorecards (
  id SERIAL PRIMARY KEY,
  module VARCHAR(50) NOT NULL,
  team VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  version VARCHAR(20) DEFAULT 'v1.0',
  created_by VARCHAR(255),
  dimensions JSONB DEFAULT '{}',
  governance_doc_id INTEGER,
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**scorecard_attributes**
```sql
CREATE TABLE scorecard_attributes (
  id SERIAL PRIMARY KEY,
  scorecard_id INTEGER REFERENCES quality_scorecards(id) ON DELETE CASCADE,
  dimension VARCHAR(50) NOT NULL,
  attribute_name VARCHAR(255) NOT NULL,
  description TEXT,
  weight DECIMAL(5,2) DEFAULT 0,
  severity VARCHAR(20) DEFAULT 'minor',
  evaluation_logic TEXT,
  evidence_fields TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Fields:**
- `severity`: Critical, Major, or Minor - impacts weighted scoring
- `evaluation_logic`: Instructions for AI on how to evaluate this attribute
- `evidence_fields`: Which CRM fields to check for evidence
- `is_active`: Toggle to enable/disable attribute in evaluations
- `order_index`: Display order in admin UI

---

## 6. External Integrations

### 6.1 Google Calendar

**File:** `src/utils/googleCalendar.ts`

**Purpose:** Fetch calendar events for scheduling analysis in quality audits.

**Authentication:** OAuth 2.0 service account

---

### 6.2 Zoho CRM

**File:** `src/utils/zohoCRM.ts`

**Purpose:** Fetch CRM data (Leads, Deals) for data hygiene audits.

**Authentication:** OAuth 2.0 with automatic token refresh

**Environment Variables:**
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_API_DOMAIN` (optional, defaults to `https://www.zohoapis.com`)
- `ZOHO_ACCOUNTS_URL` (optional, defaults to `https://accounts.zoho.com`)

**Pagination Support (NEW in v2.1):**

The system now supports full pagination to fetch ALL records from Zoho CRM:

```typescript
// fetchAllZohoRecords handles pagination automatically
const allLeads = await fetchAllZohoRecords('Leads', {
  maxRecords: 10000  // Optional limit (default: 10000)
});
```

**How it works:**
1. Fetches 200 records per page (Zoho API limit)
2. Loops through all pages until no more data
3. Logs progress: `Fetched page 1: 200 records (total: 200)`
4. Returns complete dataset for accurate audits

**Data Mode:**
- `MOCK`: Uses local mock data from `mockdata/` directory
- `REAL`: Fetches live data from Zoho CRM with pagination

Set via `DATA_MODE` environment variable.

---

### 6.3 Five9 (Call Intelligence)

**Purpose:** Source of call records for the Call Intelligence module.

**Data Flow:**
1. Calls ingested via POST `/api/calls/ingest`
2. Transcripts processed
3. AI analysis triggered

---

### 6.4 Replit Mail

**File:** `src/utils/replitmail.ts`

**Purpose:** Send automated quality report emails.

**Features:**
- Weekly report delivery
- HTML formatted reports
- Attachment support

---

## 7. AI/ML Components

### 7.1 Quality Specialist Agent

**File:** `src/mastra/agents/qualitySpecialistAgent.ts`

**Model:** GPT-4o (via Replit AI Integrations)

**Capabilities:**
- Data hygiene audits
- Anomaly detection
- Quality score calculation
- Recommendation generation
- Insights extraction

**Memory:** PostgreSQL-backed for conversation history

---

### 7.2 Quality Audit Workflow

**File:** `src/mastra/workflows/qualityAuditWorkflow.ts`

**Trigger:** Cron - Every Monday at 8 AM UTC

**Steps:**
1. Environment validation
2. Google Calendar data fetch
3. Zoho CRM data fetch
4. AI analysis (GPT-4o)
5. Score calculation
6. Result storage
7. Email report generation

---

### 7.3 AI Features by Module

| Module | AI Feature | Model |
|--------|------------|-------|
| Quality Dashboard | Recommendations | GPT-4o |
| Table F | Risk Assessment | GPT-4o |
| Call Intelligence | Sentiment, Topics, Summary | GPT-4o |
| ROI Engine | Investment Recommendation | GPT-4o |
| Team Tracker | Scope Generator | GPT-4o |
| PMP Projects | Charter Generator | GPT-4o |

---

## 8. Security & Compliance

### 8.1 Authentication

- **Google OAuth 2.0**: Primary login method via "Sign in with Google" on `/login`
- **Session Management**: HMAC-signed cookies using `SESSION_SECRET`, 7-day expiry
- **Admin Endpoints**: Accept Google session cookies OR `X-Admin-Key` header for authorization
- **Route Protection**: All dashboard pages redirect to `/login` if no valid session; public pages: `/login`, `/guide`, `/accept-invite`
- **User Storage**: Google-authenticated users are upserted into `platform_users` table with `google_id`, `picture`, and `auth_provider` columns

### 8.2 Data Protection

- SHA-256 checksums on event logs
- Immutable audit trail
- JSONB encryption for sensitive fields
- HTTPS/TLS encryption in transit (enforced by Replit deployment)
- Secrets managed via Replit environment secrets (never exposed in code)

### 8.3 Compliance Standards

| Standard | Coverage |
|----------|----------|
| ISO 9001 | QMS, CAPA, NC, Training |
| COPC | Table F 50/75, KPI tracking |
| Six Sigma | Quality scores, trends |
| NCA-ECC | Essential Cybersecurity Controls alignment |
| NCA-DCC | Data Cybersecurity Controls alignment |
| PDPL | Saudi Personal Data Protection Law compliance module |

### 8.4 Audit Trail

Event logs capture:
- User actions (CREATE, UPDATE, DELETE)
- System events
- AI actions
- Severity levels
- Correlation IDs

---

## 9. UI/UX Specifications

### 9.1 Design System

**Typography:** Inter font family (300-700 weights)

**Color Palette (QMS Standard):**

| Variable | Hex | Usage |
|----------|-----|-------|
| `--qms-blue` | #1E3A8A | Quality/Governance |
| `--qms-blue-light` | #2563EB | Interactive elements |
| `--qms-blue-bg` | #DBEAFE | Blue backgrounds |
| `--qms-green` | #047857 | Compliance/Pass |
| `--qms-green-light` | #22C55E | Success states |
| `--qms-green-bg` | #D1FAE5 | Green backgrounds |
| `--qms-amber` | #D97706 | Warning/At-Risk |
| `--qms-amber-light` | #F59E0B | Warning states |
| `--qms-amber-bg` | #FEF3C7 | Amber backgrounds |
| `--qms-red` | #B91C1C | Nonconformance/Fail |
| `--qms-red-light` | #EF4444 | Error states |
| `--qms-red-bg` | #FEE2E2 | Red backgrounds |
| `--qms-purple` | #6D28D9 | AI/Improvement |
| `--qms-purple-light` | #A855F7 | AI states |
| `--qms-purple-bg` | #EDE9FE | Purple backgrounds |

### 9.2 Navigation

**Header Bar:**
- White background
- WalaPlus branding (left)
- Module navigation buttons (right)
- Color-coded CTAs for key modules

**Button Styling:**
- Primary: Indigo (`bg-indigo-600`)
- Success: Green (`bg-green-600`)
- Info: Purple (`bg-purple-600`)
- Warning: Amber (`bg-amber-500`)
- Neutral: Gray border

### 9.3 Components

**Cards:**
- White background
- Rounded corners (`rounded-xl`)
- Shadow (`shadow-sm`)
- Border (`border-gray-200`)

**Tables:**
- Sticky headers
- Zebra striping on hover
- Sortable columns
- Pagination

**Charts:**
- Chart.js library
- Fixed height containers (280px)
- Responsive canvas

**Modals:**
- Dark backdrop (50% opacity)
- Centered, scrollable content
- Close button (X) top-right

---

## 10. Deployment & Infrastructure

### 10.1 Environment

**Platform:** Replit

**Runtime:** Node.js 20+

**Workflows:**
- `Start application` - `mastra dev` (port 5000)
- `Start inngest server` - Inngest event processing

### 10.2 Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `SESSION_SECRET` | Session cookie signing key |
| `ADMIN_API_KEY` | Admin authentication (fallback) |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | OpenAI endpoint |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | OpenAI key |
| `RESEND_API_KEY` | Email sending via Resend |
| `RESEND_FROM_EMAIL` | From address for emails |
| `ZOHO_CLIENT_ID` | Zoho OAuth |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth |
| `ZOHO_REFRESH_TOKEN` | Zoho OAuth |

### 10.3 Scheduled Tasks

| Task | Schedule | Purpose |
|------|----------|---------|
| Quality Audit | Monday 8 AM UTC | Weekly quality report |

### 10.4 Deployment Process

1. Push code to Replit
2. Workflows auto-restart
3. Database migrations run on startup
4. Verify via Playground tab

---

## 11. GRC Module Specifications

### 11.0 GRC Control Tower Dashboard

> **Documented in:** [USER_MANUAL.md §13 — GRC Control Tower](./USER_MANUAL.md#13-grc-control-tower).

**Dashboard File:** `dashboard/grc.html`
**Route:** `GET /grc` (served by `src/mastra/routes/staticPageRoutes.ts`)

**Purpose:** Unified executive view across the six underlying GRC modules (§11.1–§11.6). Read-only aggregation page — all writes happen in the individual module dashboards. Designed for `executive` and `grc_manager` roles as a single-pane situational view.

**Aggregated Components:**

| Component | Source Module(s) | Data |
|-----------|------------------|------|
| KPI Cards (6) | All GRC modules | Active risks, policies count, compliance score, open findings, vendors at-risk, control effectiveness |
| Risk Heat Map | §11.1 Risk Register | 5×5 likelihood × impact matrix with drill-down |
| GRC Module Status Chart | All GRC modules | Per-module health indicator (green/amber/red) |
| Compliance by Framework | §11.3 Compliance Tracker | Horizontal bar chart per regulatory framework (PDPL, NCA-ECC, ISO-9001, etc.) |
| Handoff Rules Table | §11.7 Quality-GRC Handoff Engine | Active rules and their last-fired timestamps |
| Control Effectiveness Table | §11.7 Handoff Engine | Per-control type effectiveness ratings |
| Audit Readiness Summary | §11.4 Audit Module | Upcoming audits + finding closure rate |
| Recent Handoff Events | §11.7 Handoff Engine | Last 20 cross-module escalation events |

**Data Sources:** No dedicated tables. The page calls existing module summary endpoints in parallel: `/api/risks/summary`, `/api/policies/summary`, `/api/compliance/summary`, `/api/audits/summary`, `/api/vendors/summary`, `/api/handoff/summary`, `/api/handoff/controls`.

**Refresh:** Page refreshes module summaries on load and on the "Refresh" button. No automatic polling.

**Access Control:** Visible to any authenticated user; the data shown is already filtered by each underlying summary endpoint's own role gates.

---

### 11.1 Enterprise Risk Register

> **Documented in:** [USER_MANUAL.md §14 — Enterprise Risk Register](./USER_MANUAL.md#14-enterprise-risk-register). Schema extensions for risk acceptance live in [§5.6 RBAC Tables](#56-rbac-role-based-access-control-tables).

**Route File:** `src/mastra/routes/riskRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/risks` | List all risks with filters |
| GET | `/api/risks/:id` | Get single risk |
| POST | `/api/risks` | Create new risk |
| PUT | `/api/risks/:id` | Update risk |
| DELETE | `/api/risks/:id` | Delete risk |
| GET | `/api/risks/summary` | Dashboard summary |
| GET | `/api/risks/heatmap` | Heat map data |
| POST | `/api/risks/:id/treatments` | Add treatment |
| PUT | `/api/risks/treatments/:id` | Update treatment |
| POST | `/api/risks/:id/audit` | Record audit trail |
| POST | `/api/risks/:id/accept` | Accept risk — **grc_manager only** (see §4.8 + acceptance workflow below) |

#### Risk Acceptance Workflow

The risk acceptance endpoint `POST /api/risks/:id/accept` enforces a four-gate workflow before a risk's status is set to `accepted`:

1. **Role gate** — Caller must hold the `grc_manager` role (or `admin`). Other roles receive `403 Forbidden`. Permission flag: `can_accept_risk` (see [§5.6 role_permissions](#56-rbac-role-based-access-control-tables)).
2. **Justification required** — Request body must include a non-empty `justification` field. Missing or blank → `400 Bad Request`.
3. **Email verification** — The acting user's email must resolve to a registered `system_user`. Anonymous or unknown emails → `403 Forbidden`.
4. **Audit persistence** — On success, the risk row is updated with `accepted_by`, `accepted_by_role`, `accepted_at`, and `acceptance_justification` (see schema extensions in [§5.6](#56-rbac-role-based-access-control-tables)). A corresponding entry is written to `event_logs` with `severity = 'WARNING'`.

UI flow: The Risk Register dashboard shows an "Accept Risk" action only when the current user has `can_accept_risk = true`. The action opens a modal that requires the justification text; a 403 from the API surfaces as an inline error and no state changes.

#### Database Tables

**risks**
```sql
id SERIAL PRIMARY KEY,
risk_code VARCHAR(50) UNIQUE,
title VARCHAR(255) NOT NULL,
description TEXT,
category VARCHAR(100), -- Operational, Financial, Strategic, Compliance, Technology, Reputational
likelihood INTEGER CHECK (1-4),
impact INTEGER CHECK (1-4),
risk_score INTEGER GENERATED ALWAYS AS (likelihood * impact) STORED,
risk_level VARCHAR(20) GENERATED ALWAYS AS (...) STORED,
risk_owner VARCHAR(255),
status VARCHAR(50) DEFAULT 'open',
created_at TIMESTAMP,
updated_at TIMESTAMP
```

**risk_treatments**
```sql
id SERIAL PRIMARY KEY,
risk_id INTEGER REFERENCES risks(id),
treatment_type VARCHAR(100), -- Mitigate, Transfer, Accept, Avoid
description TEXT,
responsible_party VARCHAR(255),
target_date DATE,
status VARCHAR(50),
effectiveness_rating INTEGER
```

### 11.2 Policy & Document Governance

> **Documented in:** [USER_MANUAL.md §15 — Policy & Document Governance](./USER_MANUAL.md#15-policy--document-governance). Dual-ownership schema extensions live in [§5.6 RBAC Tables](#56-rbac-role-based-access-control-tables).

**Route File:** `src/mastra/routes/policyRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/policies` | List policies |
| GET | `/api/policies/:id` | Get single policy |
| POST | `/api/policies` | Create policy (dual ownership required) |
| PUT | `/api/policies/:id` | Update policy |
| PUT | `/api/policies/:id/transition` | Transition lifecycle |
| DELETE | `/api/policies/:id` | Delete policy |
| GET | `/api/policies/summary` | Dashboard summary |
| GET | `/api/policies/:id/versions` | Get version history |
| POST | `/api/policies/:id/versions` | Create new version |
| POST | `/api/policies/:id/comments` | Add comment |
| POST | `/api/policies/:id/set-owners` | Set/update operational + compliance owners |
| POST | `/api/policies/:id/grc-approval` | GRC compliance sign-off — **grc_manager only** (see §4.8) |
| POST | `/api/policies/:id/publish` | Publish policy (blocked if `compliance_approved = false`) |

#### Dual-Ownership Approval Workflow

Every policy carries two owners — an **operational owner** (the business unit accountable for execution) and a **compliance owner** (the GRC representative accountable for regulatory sign-off). Publication is gated on both ownership being set and on explicit GRC approval.

1. **Owner assignment** — `POST /api/policies` and `POST /api/policies/:id/set-owners` both require non-empty `operational_owner` and `compliance_owner` (plus emails). Missing either → `400 Bad Request` with the offending field named.
2. **GRC approval gate** — `POST /api/policies/:id/grc-approval` is the only path that flips `compliance_approved` to `true`. It requires the `grc_manager` role (`can_approve_policy` permission). On success, the row is updated with `compliance_approved`, `compliance_approved_by`, and `compliance_approved_at`. Rejection records `approval_blocked_reason`.
3. **Publish gate** — `POST /api/policies/:id/publish` reads `compliance_approved`. If `false`, returns `409 Conflict` with `approval_blocked_reason` echoed back. UI surfaces this as a banner: *"Publish blocked — awaiting GRC compliance sign-off from <compliance_owner>."*
4. **Audit trail** — Each transition (owners set, approval granted, publish) emits an `event_logs` entry tagged with `module = 'policies'` and the correlation ID of the originating request.

#### Database Tables

**policies**
```sql
id SERIAL PRIMARY KEY,
document_number VARCHAR(100) UNIQUE,
title VARCHAR(255) NOT NULL,
description TEXT,
category VARCHAR(100),
status VARCHAR(50) DEFAULT 'draft', -- draft, review, approval, published, retired
owner VARCHAR(255),
current_version VARCHAR(20),
review_frequency VARCHAR(50),
next_review_date DATE,
effective_date DATE,
created_at TIMESTAMP,
updated_at TIMESTAMP
```

**policy_versions**
```sql
id SERIAL PRIMARY KEY,
policy_id INTEGER REFERENCES policies(id),
version_number VARCHAR(20),
change_summary TEXT,
document_url TEXT,
created_by VARCHAR(255),
approved_by VARCHAR(255),
approved_at TIMESTAMP,
created_at TIMESTAMP
```

### 11.3 Compliance & Regulatory Tracker

**Route File:** `src/mastra/routes/complianceRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/compliance/frameworks` | List frameworks |
| GET | `/api/compliance/frameworks/:id` | Get framework |
| POST | `/api/compliance/frameworks` | Create framework |
| GET | `/api/compliance/obligations` | List obligations |
| POST | `/api/compliance/obligations` | Create obligation |
| PUT | `/api/compliance/obligations/:id` | Update obligation |
| GET | `/api/compliance/summary` | Compliance summary |
| POST | `/api/compliance/evidence` | Add evidence |

#### Pre-Seeded Frameworks

| Code | Name | Description |
|------|------|-------------|
| PDPL | Personal Data Protection Law | Saudi data privacy regulation |
| NCA-ECC | NCA Essential Cybersecurity Controls | Saudi cybersecurity requirements |
| NCA-DCC | NCA Data Cybersecurity Controls | Saudi data cybersecurity |
| ISO-9001 | ISO 9001:2015 | Quality management system |
| ISO-27001 | ISO 27001:2022 | Information security management |
| COPC | COPC CX Standard | Customer operations performance |

### 11.4 Audit Readiness Module

**Route File:** `src/mastra/routes/auditRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audits` | List audits |
| GET | `/api/audits/:id` | Get audit |
| POST | `/api/audits` | Create audit |
| PUT | `/api/audits/:id` | Update audit |
| DELETE | `/api/audits/:id` | Delete audit |
| GET | `/api/audits/summary` | Audit summary |
| GET | `/api/audits/findings` | List findings |
| POST | `/api/audits/:id/findings` | Add finding |
| PUT | `/api/audits/findings/:id` | Update finding |
| POST | `/api/audits/:id/evidence` | Add evidence |
| GET | `/api/audits/:id/evidence-pack` | Generate evidence pack |

### 11.5 Vendor Risk Management

**Route File:** `src/mastra/routes/vendorRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/vendors` | List vendors |
| GET | `/api/vendors/:id` | Get vendor |
| POST | `/api/vendors` | Create vendor |
| PUT | `/api/vendors/:id` | Update vendor |
| DELETE | `/api/vendors/:id` | Delete vendor |
| GET | `/api/vendors/summary` | Vendor summary |
| POST | `/api/vendors/:id/assessments` | Add assessment |
| PUT | `/api/vendors/assessments/:id` | Update assessment |
| POST | `/api/vendors/:id/remediations` | Add remediation |
| PUT | `/api/vendors/remediations/:id` | Update remediation |
| POST | `/api/vendors/:id/ai-assessment` | AI risk assessment |

### 11.6 Data Migration Engine

**Route File:** `src/mastra/routes/migrationRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/migration/templates` | List templates |
| GET | `/api/migration/templates/:id` | Get template with mappings |
| POST | `/api/migration/templates` | Create template |
| POST | `/api/migration/mappings` | Add field mapping |
| GET | `/api/migration/rules` | List deduplication rules |
| POST | `/api/migration/rules` | Create rule |
| POST | `/api/migration/ai-mapping` | AI field mapping |
| POST | `/api/migration/import` | Execute import |
| GET | `/api/migration/imports` | Import history |
| POST | `/api/migration/rollback/:id` | Rollback import |

#### Pre-Seeded Templates

| Template | Target Table | Description |
|----------|--------------|-------------|
| risk_import | risks | Enterprise risk register |
| policy_import | policies | Policy documents |
| compliance_import | compliance_obligations | Regulatory obligations |
| vendor_import | vendors | Vendor directory |

#### Deduplication Rules

| Rule | Module | Match Criteria |
|------|--------|----------------|
| risk_title_match | risks | Title similarity >85% |
| risk_code_exact | risks | Exact risk_code match |
| policy_docnum_exact | policies | Exact document_number |
| policy_title_match | policies | Title similarity >90% |
| vendor_name_match | vendors | Name similarity >80% |
| compliance_code_exact | compliance | Exact obligation_code |
| audit_name_date | audits | Name + date combination |

### 11.7 Quality-GRC Handoff Engine

**Route File:** `src/mastra/routes/handoffRoutes.ts`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/handoff/rules` | List handoff rules |
| POST | `/api/handoff/rules` | Create rule |
| PUT | `/api/handoff/rules/:id` | Update rule |
| GET | `/api/handoff/events` | List handoff events |
| POST | `/api/handoff/trigger` | Manual trigger |
| GET | `/api/handoff/summary` | Handoff summary |
| GET | `/api/handoff/controls` | List control mappings |
| POST | `/api/handoff/controls` | Create control |
| PUT | `/api/handoff/controls/:id` | Update control |

#### Pre-Configured Rules

| Rule | Source | Target | Trigger |
|------|--------|--------|---------|
| CAPA→Risk | capa_records | risks | Severity >= High |
| Call Sentiment→Compliance | call_records | compliance | Sentiment < 3 |
| Nonconformance→Finding | nonconformances | grc_audit_findings | Any nonconformance |
| Training Gap→Compliance | training_records | compliance | Overdue training |

#### Control Mappings

| Control | Type | Source Domain | Target Domain |
|---------|------|---------------|---------------|
| CAPA Risk Escalation | Preventive | Quality | Risk Management |
| Call Quality Monitoring | Detective | Quality | Compliance |
| NCR Audit Linking | Corrective | Quality | Audit |
| Training Compliance Check | Preventive | Quality | Compliance |
| Vendor Quality Review | Detective | Quality | Vendor Risk |
| Document Control Sync | Preventive | Quality | Policy Governance |

### 11.8 Duplicate Radar Module

**Route File:** `src/mastra/routes/duplicateRadarRoutes.ts`
**Database File:** `src/utils/duplicateRadarDatabase.ts`
**Dashboard:** `dashboard/duplicates.html`

#### Purpose

AI-powered CRM duplicate detection for Leads and Deals using domain-based clustering. Operates in READ-ONLY mode - detects and recommends, but does not modify Zoho CRM data.

#### Database Tables

| Table | Purpose |
|-------|---------|
| duplicate_clusters | Groups records by email domain |
| duplicate_records | Individual lead/deal records within clusters |
| duplicate_detection_logs | Detection run history |
| duplicate_export_logs | CSV export activity |

#### duplicate_clusters Schema

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| domain | VARCHAR(255) | Email domain (e.g., acme-corp.com) |
| company_name | VARCHAR(255) | Primary company name |
| total_leads | INTEGER | Count of leads in cluster |
| total_deals | INTEGER | Count of deals in cluster |
| total_records | INTEGER | Total records in cluster |
| confidence_level | VARCHAR(20) | high/medium/low |
| confidence_score | INTEGER | 0-100 confidence percentage |
| owners_involved | TEXT[] | Array of owner emails |
| estimated_pipeline_value | DECIMAL | Sum of deal values (duplicate inflation) |
| status | VARCHAR(20) | active/resolved/ignored |
| ai_recommendation | TEXT | AI-generated action suggestion |

#### duplicate_records Schema

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| cluster_id | INTEGER | FK to duplicate_clusters |
| record_type | VARCHAR(20) | lead/deal |
| zoho_record_id | VARCHAR(255) | Zoho CRM record ID |
| record_name | VARCHAR(255) | Lead name or Deal name |
| email | VARCHAR(255) | Contact email |
| domain | VARCHAR(255) | Email domain |
| company_name | VARCHAR(255) | Company name |
| owner_name | VARCHAR(255) | Record owner name |
| owner_email | VARCHAR(255) | Record owner email |
| deal_value | DECIMAL | Deal amount (if deal) |
| is_primary | BOOLEAN | Whether this is the primary record |
| confidence_score | INTEGER | Match confidence 0-100 |
| is_mock_data | BOOLEAN | Whether from sandbox testing |

#### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/duplicates` | Serve dashboard HTML |
| GET | `/api/duplicates/summary` | Get cluster summary and KPIs |
| GET | `/api/duplicates/clusters` | List all clusters (with pagination) |
| GET | `/api/duplicates/clusters/:id` | Get cluster with records |
| PATCH | `/api/duplicates/clusters/:id/status` | Update cluster status |
| GET | `/api/duplicates/by-owner` | Group duplicates by owner |
| GET | `/api/duplicates/by-source` | Group duplicates by source |
| GET | `/api/duplicates/leads` | Get lead duplicate groups |
| GET | `/api/duplicates/deals` | Get deal duplicate groups |
| GET | `/api/duplicates/logs` | Get detection logs |
| GET | `/api/duplicates/export` | Export clusters as CSV |
| POST | `/api/duplicates/generate-mock` | Generate test data |
| POST | `/api/duplicates/clear-mock` | Clear test data |
| POST | `/api/duplicates/test-record` | Add sandbox test record |
| POST | `/api/duplicates/ai-recommendations/:clusterId` | Get AI merge recommendations |

#### Detection Algorithm

1. **Domain Extraction** - Extract email domain from lead/deal contact
2. **Public Domain Exclusion** - Skip gmail.com, yahoo.com, hotmail.com, etc.
3. **Cluster Assignment** - Group records by domain
4. **Confidence Scoring**:
   - High (≥90%): Same domain + 3+ records
   - Medium (60-89%): Same domain + 2 records
   - Low (<60%): Weak signals
5. **Pipeline Inflation Calculation** - Sum deal values per cluster

#### KPI Metrics

| KPI | Calculation |
|-----|-------------|
| Duplicate Lead Rate | (Duplicate Leads / Total Leads) × 100 |
| Duplicate Deal Rate | (Duplicate Deals / Total Deals) × 100 |
| Domains with Multiple Deals | Count of domains having >1 deal |

#### Integration with Sandbox

The Testing Sandbox (`/sandbox`) includes a Duplicate Detection Testing section:
- `POST /api/duplicates/test-record` - Add lead/deal for testing
- Pre-configured quick-add buttons for test scenarios
- Real-time detection results display

---

## 12. Hosting, Data Classification & Migration Plan

### 12.1 Current Hosting Infrastructure

| Component | Details |
|-----------|---------|
| **Platform** | Replit (Autoscale Deployment) |
| **Cloud Provider** | Google Cloud Platform (GCP) |
| **Server Region** | United States |
| **Database** | PostgreSQL (hosted on Replit infrastructure) |
| **Domain** | `qms-dashboard.replit.app` |
| **TLS/SSL** | Enforced by default on all deployed applications |
| **Scaling** | Autoscale — scales up under load, scales down when idle |

### 12.2 Platform Justification

WalaPlus is hosted on Replit for the following strategic reasons:

**Rapid Development & Iteration**
- Replit provides an integrated development, testing, and deployment environment that enables rapid prototyping and iteration of the GRC & QMS platform
- Changes can be deployed to production within minutes, supporting agile governance requirements
- Built-in version control with checkpoint/rollback capabilities protects against deployment failures

**Cost Efficiency**
- Autoscale deployment eliminates the need for dedicated server provisioning and maintenance
- No infrastructure team required during the development and pilot phase
- Pay-for-usage model reduces overhead compared to maintaining dedicated servers

**Security Controls**
- All secrets and API keys are managed through Replit's encrypted secrets management (never exposed in code or logs)
- HTTPS/TLS encryption enforced on all traffic by default
- Google OAuth 2.0 authentication with HMAC-signed session cookies
- Immutable audit trail with SHA-256 checksums on all event logs

**This platform is intended as a development and operational pilot environment.** The application architecture is designed to be fully portable and can be migrated to on-premises or private cloud infrastructure at any time (see Section 12.4).

### 12.3 Data Classification

The WalaPlus platform has been designed with a clear data classification policy. The following outlines what data resides on the platform and its sensitivity level.

#### Data Present on the Platform

| Data Category | Examples | Classification | Sensitivity |
|---------------|----------|---------------|-------------|
| Employee Profiles | Name, email, role, team, Google profile picture | Internal | Medium |
| Quality Records | Audit results, scorecards, CAPA actions, quality trends | Internal | Low-Medium |
| Governance Documents | Policies, procedures, governance document metadata | Internal | Low-Medium |
| Risk Register | Risk entries, assessments, treatment plans | Internal | Medium |
| Compliance Records | Compliance obligation status, evidence tracking | Internal | Medium |
| KPIs & Scorecards | Performance metrics, scoring data | Internal | Low |
| Vendor Assessments | Vendor risk scores, evaluation records | Internal | Low-Medium |
| Call Evaluations | Call quality scores, evaluation criteria | Internal | Low-Medium |
| System Logs | Event logs, user activity audit trail | Internal | Low |
| Project Data | PMP project portfolio entries | Internal | Low |

#### Data NOT Present on the Platform

| Data Category | Status |
|---------------|--------|
| Customer personal data (PII) | NOT stored |
| Financial records or banking data | NOT stored |
| Payment card or transaction data | NOT stored |
| National ID numbers or government IDs | NOT stored |
| Medical or health records | NOT stored |
| Customer contact information | NOT stored |
| Proprietary trade secrets | NOT stored |
| Classified or restricted government data | NOT stored |

#### Summary

The platform contains **operational and employee-related data only** — primarily employee names, emails, roles, and internal quality/governance records. No customer-facing sensitive data, financial data, or personally identifiable information (PII) of external parties is stored on this platform. The employee data present is limited to what is necessary for access control, role-based permissions, and audit trail accountability.

### 12.4 Migration Plan — Moving to On-Premises or Private Cloud

The WalaPlus platform is built on standard, open-source technologies (Node.js, PostgreSQL, TypeScript) with no vendor lock-in to Replit. The organization retains full capability to migrate the application to its own servers or data center at any time.

#### 12.4.1 Architecture Portability

| Component | Current (Replit) | Target (On-Premises / Private DC) |
|-----------|-----------------|-----------------------------------|
| Runtime | Node.js 20+ on Replit | Node.js 20+ on any Linux server |
| Database | PostgreSQL on Replit | PostgreSQL on any server or managed service (e.g., AWS RDS, Azure Database, self-hosted) |
| Web Server | Hono (built-in HTTP) on port 5000 | Same — Hono serves on any port, behind Nginx/Apache reverse proxy |
| AI/LLM | OpenAI GPT-4o API | Same — API key based, works from any server |
| Email | Resend API | Same — API key based, works from any server |
| CRM | Zoho CRM API | Same — OAuth token based, works from any server |
| Auth | Google OAuth 2.0 | Same — update redirect URI to new domain |

#### 12.4.2 Migration Steps

**Phase 1: Prepare Target Environment (1-2 days)**

1. Provision a Linux server (Ubuntu 22.04+ recommended) or VM in your data center
2. Install Node.js 20+ and PostgreSQL 15+
3. Install Nginx as a reverse proxy (for TLS termination and domain routing)
4. Configure firewall rules (allow ports 80, 443 inbound; restrict database to localhost)

**Phase 2: Export & Transfer Code (1 day)**

1. Clone the full repository from Replit (or GitHub if synced):
   ```bash
   git clone <repository-url> /opt/walaplus
   cd /opt/walaplus
   npm install
   ```
2. Copy all environment secrets to the new server's environment (`.env` file or system environment):
   ```
   DATABASE_URL=postgresql://user:password@localhost:5432/walaplus
   GOOGLE_CLIENT_ID=<your-google-client-id>
   GOOGLE_CLIENT_SECRET=<your-google-client-secret>
   SESSION_SECRET=<your-session-secret>
   ADMIN_API_KEY=<your-admin-key>
   RESEND_API_KEY=<your-resend-key>
   RESEND_FROM_EMAIL=<your-from-email>
   ZOHO_CLIENT_ID=<your-zoho-client-id>
   ZOHO_CLIENT_SECRET=<your-zoho-client-secret>
   ZOHO_REFRESH_TOKEN=<your-zoho-refresh-token>
   ```

**Phase 3: Database Migration (1 day)**

1. Export the database from Replit PostgreSQL:
   ```bash
   pg_dump $DATABASE_URL --no-owner --no-acl > walaplus_backup.sql
   ```
2. Create the target database:
   ```bash
   createdb walaplus
   ```
3. Import the data:
   ```bash
   psql -d walaplus < walaplus_backup.sql
   ```
4. Verify table counts and data integrity

**Phase 4: Configure & Launch (1 day)**

1. Update the `DATABASE_URL` to point to the local/private PostgreSQL instance
2. Update Google OAuth redirect URI in Google Cloud Console to the new domain
3. Configure Nginx reverse proxy:
   ```nginx
   server {
       listen 443 ssl;
       server_name qms.yourdomain.com;
       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;
       location / {
           proxy_pass http://127.0.0.1:5000;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
4. Start the application:
   ```bash
   cd /opt/walaplus
   npm run build
   node dist/index.js
   ```
5. (Recommended) Use PM2 or systemd for process management:
   ```bash
   pm2 start dist/index.js --name walaplus
   pm2 save
   pm2 startup
   ```

**Phase 5: Validation & Cutover (1 day)**

1. Verify all 18+ dashboards load correctly
2. Verify Google OAuth login works with new redirect URI
3. Verify all API endpoints return correct data
4. Verify audit trail and event logging
5. Update DNS to point the domain to the new server
6. Monitor for 48 hours before decommissioning the Replit deployment

#### 12.4.3 Estimated Migration Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Phase 1 | 1-2 days | Server provisioning and software installation |
| Phase 2 | 1 day | Code transfer and environment setup |
| Phase 3 | 1 day | Database export, transfer, and import |
| Phase 4 | 1 day | Configuration, proxy setup, and launch |
| Phase 5 | 1 day | Testing, validation, and DNS cutover |
| **Total** | **5-6 working days** | Full migration with validation |

#### 12.4.4 Post-Migration Considerations

- **Backups**: Set up automated PostgreSQL backups (daily `pg_dump` or streaming replication)
- **Monitoring**: Install monitoring tools (e.g., Uptime Kuma, Prometheus + Grafana)
- **SSL Certificates**: Use Let's Encrypt for free, auto-renewing TLS certificates
- **Updates**: Establish a process for applying Node.js and PostgreSQL security updates
- **Inngest**: If using Inngest for workflow orchestration, either self-host Inngest or replace with a cron-based alternative

---

## Document Maintenance

This Scope of Work document should be updated whenever:
- New features are added
- APIs are modified
- Database schema changes
- Integration points are added/removed
- Hosting or infrastructure changes occur

**Last Updated:** 2026-05-21
**Version:** 2.2
