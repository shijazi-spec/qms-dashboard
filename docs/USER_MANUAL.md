# WalaPlus Enterprise GRC & Quality Management Platform - User Manual

**Version 2.2** | Last Updated: 2026-05-21

> **Companion document:** [SCOPE_OF_WORK.md](./SCOPE_OF_WORK.md) — the technical contract this manual documents. Section cross-references are noted at each module heading.

---

## Table of Contents

### Quality Management Modules
1. [Introduction](#1-introduction)
2. [Getting Started](#2-getting-started)
3. [Quality Dashboard (Home)](#3-quality-dashboard-home)
4. [Admin Panel](#4-admin-panel)
5. [QMS Dashboard](#5-qms-dashboard)
6. [Table F Governance Engine](#6-table-f-governance-engine)
7. [Call Intelligence Module](#7-call-intelligence-module)
8. [ROI & NPV Evaluation Engine](#8-roi--npv-evaluation-engine)
9. [Quality Team Performance Tracker](#9-quality-team-performance-tracker)
10. [PMP Project Portfolio](#10-pmp-project-portfolio)
11. [System Event Logs](#11-system-event-logs)
12. [Testing Sandbox](#12-testing-sandbox)

### Enterprise GRC Modules
13. [GRC Control Tower](#13-grc-control-tower)
14. [Enterprise Risk Register](#14-enterprise-risk-register)
15. [Policy & Document Governance](#15-policy--document-governance)
16. [Compliance & Regulatory Tracker](#16-compliance--regulatory-tracker)
17. [Audit Readiness Module](#17-audit-readiness-module)
18. [Vendor Risk Management](#18-vendor-risk-management)
19. [Data Migration Engine](#19-data-migration-engine)
20. [Duplicate Radar](#20-duplicate-radar)

### Reference
21. [User Onboarding & Help](#21-user-onboarding--help)
22. [AI Features Overview](#22-ai-features-overview)
23. [Frequently Asked Questions](#23-frequently-asked-questions)

---

## 1. Introduction

### What is WalaPlus GRC & Quality Platform?

WalaPlus Enterprise GRC & Quality Management Platform is a comprehensive, AI-powered system combining governance, risk, and compliance (GRC) with quality management. The platform provides:

- **Enterprise Risk Management** with risk heat maps and treatment workflows
- **Policy Governance** with document lifecycle management
- **Regulatory Compliance Tracking** for PDPL, NCA-ECC, ISO 9001, and more
- **Quality Assurance** with automated weekly audits and AI recommendations
- **19 integrated dashboards** covering Quality Management, Enterprise GRC, and User Onboarding

### Key Capabilities

#### Quality Management Modules

| Module | URL | Purpose |
|--------|-----|---------|
| Quality Dashboard | `/` | Real-time quality scores and trends |
| Admin Panel | `/admin` | Governance document management |
| QMS Dashboard | `/qms` | CAPA, nonconformance, and training |
| Table F Engine | `/tablef` | COPC 50/75 KPI compliance |
| Call Intelligence | `/calls` | Call analysis and CRM compliance |
| ROI Engine | `/roi` | Financial evaluation of initiatives |
| Team Tracker | `/team` | Team performance and training |
| PMP Projects | `/projects` | Full project portfolio management |
| Event Logs | `/logs` | Audit trail and compliance reporting |
| Sandbox | `/sandbox` | Testing with mock data |

#### Enterprise GRC Modules

| Module | URL | Purpose |
|--------|-----|---------|
| GRC Control Tower | `/grc` | Executive GRC dashboard |
| Risk Register | `/risks` | Enterprise risk management |
| Policy Governance | `/policies` | Document lifecycle management |
| Compliance Tracker | `/compliance` | Regulatory obligation tracking |
| Audit Readiness | `/audits` | Audit scheduling and findings |
| Vendor Risk | `/vendors` | Third-party risk assessments |
| Data Migration | `/migration` | CSV/Excel import with AI mapping |
| Duplicate Radar | `/duplicates` | AI-powered CRM duplicate detection |

#### Support Modules

| Module | URL | Purpose |
|--------|-----|---------|
| User Onboarding | `/onboarding` | Welcome modal, guided tour, demo links (see §21) |

---

## 2. Getting Started

### Accessing the System

Navigate to the application URL. You will land on the **Quality Dashboard** (home page).

### Navigation

All dashboards share a unified navigation bar at the top with:
- **WalaPlus Logo** - Click to return to the Quality Dashboard
- **Module Buttons** - Color-coded quick access to each dashboard:
  - Blue: Projects
  - Purple: Team
  - Green: ROI
  - Indigo: Calls
  - Amber: Table F
  - Gray: QMS, Admin, Logs, Sandbox

### Color Coding (QMS Industry Standard)

The system uses consistent colors based on quality management standards:

| Color | Meaning | Used For |
|-------|---------|----------|
| Blue (#1E3A8A) | Quality/Governance | Headers, governance items |
| Green (#047857) | Compliance/Pass | Passing scores, met KPIs |
| Amber (#D97706) | Warning/At-Risk | Needs attention |
| Red (#B91C1C) | Nonconformance/Fail | Critical issues |
| Purple (#6D28D9) | Continuous Improvement | AI actions, improvements |

---

## 3. Quality Dashboard (Home)

**URL:** `/`

### Overview

The Quality Dashboard provides a real-time visualization of your organization's quality metrics.

### Features

#### Top Navigation Bar
- **Date Range Selector** - Filter data by: Today, Last 7 Days, Last 30 Days, Last 90 Days, or Custom Range
- **Customize Button** - Opens the customization panel to show/hide widgets and rearrange layout
- **Refresh Button** - Manually refresh all dashboard data

#### Key Metrics (Top Cards)

1. **Overall Quality Score** - A 0-100 score representing combined quality health
2. **3D Score Breakdown**:
   - **People Score** - Team performance metrics
   - **Process Score** - Workflow efficiency
   - **Governance Score** - Compliance adherence

#### Issues Widget

- Displays quality issues by category
- Click any category to drill down into specific issues
- Filter by severity: Critical, High, Medium, Low

#### AI Recommendations

- GPT-4o generated recommendations based on current quality data
- Actionable insights for immediate improvements

#### Trend Charts

- Historical quality score trends
- Interactive charts showing performance over time

#### Agent Performance Widget

**NEW in v2.1** - Real-time agent/team member performance tracking based on CRM Lead Owner data.

**Features:**
- Displays all agents/team members from Zoho CRM Lead Owners
- Shows quality score (0-100%) for each agent based on their owned records
- Issue breakdown by severity (Critical, High, Medium, Low)
- Team filter dropdown to view SDR, Sales, or All Teams
- Click any agent card to view detailed performance metrics

**Performance Calculation:**
- Scores are calculated based on data quality of records owned by each agent
- Missing required fields (email, lead source, status) reduce the score
- Weighted scoring: Critical issues (4x), High (3x), Medium (2x), Low (1x)

**Data Source:**
- Agent names pulled automatically from Zoho CRM Lead Owner field
- In MOCK mode, uses user mapping from `mockdata/users.json`
- In REAL mode, uses actual Zoho CRM user names with full pagination

### Buttons & Actions

| Button | Action |
|--------|--------|
| Refresh | Reload all dashboard data |
| Customize | Open settings panel to arrange widgets |
| Export CSV | Download issues as spreadsheet |
| Export JSON | Download issues as JSON file |

### Customization Options

Click **Customize** to:
1. Show/hide individual widgets using toggle switches
2. Drag widgets to reorder their position
3. Click **Reset to Default Layout** to restore original settings

---

## 4. Admin Panel

**URL:** `/admin`

**Access:** Requires ADMIN_API_KEY

### Purpose

Manage governance documents and adjust evaluation scorecard weights.

### Features

#### Governance Documents

- View all governance documents with version history
- Upload new versions with automatic version control
- Track document approvals and effective dates

#### Multi-Scorecard Governance System (NEW in v2.1)

The platform now supports multiple named scorecards per team with versioning, allowing different evaluation criteria for different use cases.

**Scorecard Management:**

| Feature | Description |
|---------|-------------|
| Module/Team Selection | Choose from SDR, Sales, CS, Marketplace teams |
| Scorecard Name | Create multiple named scorecards per team (e.g., "SDR Lead Quality v1.0") |
| Versioning | Track scorecard versions (v1.0, v1.1, v2.0, etc.) |
| Set Active | Toggle which scorecard is active for each team |
| Clone | Duplicate existing scorecard as new version |

**Scorecard Attributes:**

Each scorecard contains detailed attributes with the following fields:

| Field | Description |
|-------|-------------|
| Dimension | Category (People, Process, Governance) |
| Attribute Name | Specific quality criteria |
| Description | What this attribute measures |
| Weight (%) | Importance in overall score calculation |
| Severity | Critical, Major, or Minor classification |
| Evaluation Logic | How AI should evaluate this attribute |
| Evidence Source | Where to find evidence for evaluation |
| Active Toggle | Enable/disable attribute in evaluations |

**How to Manage Scorecards:**

1. **Select Module/Team** - Use the dropdown to choose which team's scorecards to view
2. **Select or Create Scorecard** - Choose existing scorecard or click "Create New"
3. **Add/Edit Attributes** - Click "Add Attribute" or edit existing ones
4. **Set Active** - Toggle the "Active" switch to make this the default for evaluations
5. **Clone for New Version** - Click "Clone" to create a new version with modifications

**AI Evaluation Integration:**

When audits run, the AI agent automatically:
- Loads the active scorecard for each team
- Uses attribute evaluation logic and evidence sources
- Applies severity weights to scoring
- Generates findings based on scorecard criteria

#### Scorecard Weights (Legacy)

- Adjust weights for evaluation criteria
- Changes affect quality score calculations
- Save configurations for audit trail

### Buttons & Actions

| Button | Action |
|--------|--------|
| Upload Document | Add new governance document |
| Save Weights | Apply scorecard weight changes |
| View History | See document version history |
| Create New Scorecard | Create new scorecard for selected team |
| Clone Scorecard | Duplicate scorecard with new version |
| Set Active | Make scorecard the default for team evaluations |
| Add Attribute | Add new evaluation criterion |
| Edit Attribute | Modify attribute details |
| Remove Attribute | Delete attribute from scorecard |
| Reorder Attributes | Drag to change display order |

---

## 5. QMS Dashboard

**URL:** `/qms`

**Access:** Requires ADMIN_API_KEY

### Purpose

Comprehensive Quality Management System interface for managing evaluations, corrective actions, nonconformances, and training compliance.

### Tabs

#### Overview Tab
- **Evaluations (30d)** - Number of deal evaluations in last 30 days
- **Open CAPAs** - Active Corrective and Preventive Actions
- **Open NCs** - Active Nonconformances
- **Training Compliance %** - Team training completion rate

#### Deal Evaluations Tab
- List of all deal evaluations
- Scoring based on governance criteria
- Status tracking (Open, In Progress, Closed)

#### CAPA Tab
Corrective and Preventive Action management:
- **Create CAPA** - Log new corrective action
- **Assign Owner** - Delegate responsibility
- **Track Progress** - Monitor through stages
- **Close CAPA** - Document resolution and effectiveness

**CAPA Statuses:**
- Open (Amber)
- In Progress (Blue)
- Closed (Green)

#### Nonconformances Tab
Track quality issues:
- **Severity Levels**: Critical, Major, Minor, Observation
- **Root Cause Analysis** fields
- **Corrective Action** links

#### Training Tab
- View training compliance by team member
- Track mandatory training completion
- Identify overdue certifications

#### Framework Tab
- View compliance frameworks (ISO 9001, COPC, Six Sigma)
- Reference documentation

### Buttons & Actions

| Button | Action |
|--------|--------|
| New Evaluation | Create deal evaluation |
| New CAPA | Log corrective action |
| New NC | Report nonconformance |
| Export | Download data |

---

## 6. Table F Governance Engine

**URL:** `/tablef`

### Purpose

Manage Key Performance Indicators (KPIs) with COPC 50/75 compliance tracking.

### Understanding COPC 50/75

COPC standard requires:
- **50% of KPIs** must be met consistently
- **75% of KPIs** must be met or showing improvement

### Tabs

#### Overview Tab
**Key Metrics:**
- Total KPIs across all departments
- KPIs Met (Green)
- Met + Improving (Blue)
- COPC 50/75 Status (Compliant/At-Risk/Non-Compliant)
- At Risk Departments

**Charts:**
- COPC Compliance by Department (bar chart)
- KPI Status Distribution (pie chart)

**Department Summary Table:**
- View each department's KPI performance
- Click Export CSV to download data

#### Department View Tab
- Select a department from dropdown
- View detailed KPI breakdown
- Track individual KPI trends
- Compare against targets

#### KPI Manager Tab
Add, edit, and manage KPIs:
- **KPI Name** and description
- **Department** assignment
- **Target Value** and unit
- **Measurement Frequency**
- **Data Source**

#### AI Insights Tab
AI-generated analysis including:
- Risk assessments for at-risk KPIs
- Improvement recommendations
- Trend predictions

#### Access & Roles Tab
Manage who can view and edit KPI data

### Buttons & Actions

| Button | Action |
|--------|--------|
| Refresh | Reload Table F data |
| Export CSV | Download department summary |
| Add KPI | Create new KPI |
| Period Select | Filter by year/quarter/month |

---

## 7. Call Intelligence Module

**URL:** `/calls`

### Purpose

Analyze sales calls using AI for sentiment analysis, quality scoring, and CRM compliance verification.

### Tabs

#### Overview Tab
**Metrics Cards:**
- Total Calls - All ingested calls
- Analyzed - AI-processed calls
- Avg Sentiment - Customer satisfaction (0-100)
- Avg QA Score - Quality assurance score
- Compliance Rate - CRM update compliance

**Charts:**
- Sentiment distribution
- Calls by agent
- Quality trends

#### Call Records Tab
List of all call records:
- **Status**: Pending, Analyzed, Failed
- **Sentiment**: Positive (green), Neutral (blue), Negative (red)
- **Duration** and timestamp
- Click any row to view details

**Call Details View:**
- Full transcript
- AI-generated summary
- Key topics detected
- Objections and how they were handled
- Action items identified

#### CRM Compliance Tab
Track if CRM was updated after calls:
- Notes updated
- Call logged
- Follow-up task created
- Stage updated
- Meeting outcome logged

**Compliance Status:**
- Pass (Green) - All checks passed
- Partial (Amber) - Some updates missing
- Fail (Red) - Critical updates missing

#### Analytics Tab
- Trend analysis over time
- Agent performance comparison
- Topic frequency analysis

### Buttons & Actions

| Button | Action |
|--------|--------|
| Refresh | Reload call data |
| Analyze | Trigger AI analysis on pending call |
| Run Compliance | Check CRM updates for call |

---

## 8. ROI & NPV Evaluation Engine

**URL:** `/roi`

### Purpose

Evaluate the financial viability of quality improvement initiatives using the Hybrid Business Case model with auto-calculated ROI, NPV, and payback period.

### Understanding Key Metrics

| Metric | Description |
|--------|-------------|
| **ROI %** | Return on Investment - percentage return on costs |
| **NPV** | Net Present Value - total value in today's money |
| **Payback Period** | Time to recover investment |

### Main Dashboard

**Summary Cards:**
- Total Initiatives
- Average ROI %
- Total NPV (SAR)
- Average Payback (months)

**Charts:**
- AI Recommendations distribution (Approve/Evaluate/Reject)
- NPV by Department (bar chart)

**Initiatives Table:**
- All ROI evaluations with key metrics
- Filter by recommendation status
- Sort by ROI, NPV, or Payback

### Creating an Initiative

Click **"+ New Initiative"** to open the Hybrid Model form:

#### Section A: Basic Information
- Initiative Name (required)
- Department (required)
- Priority (Low/Medium/High)
- Problem Statement
- Expected Monthly Savings
- Implementation Cost
- Project Duration
- Discount Rate %

#### Section B: Manpower Cost Breakdown
Click to expand:
- Average Monthly Salary
- GOSI %
- Insurance Cost
- Equipment Cost
- Software Seat Cost
- Headcount Affected
- Months Saved

#### Section C: Platform Costs
Add ongoing technology costs:
- Platform Name
- Monthly Cost
- Category (SaaS, Infrastructure, etc.)

#### Section D: Error/Rework Costs
Quantify current waste:
- Error Rate %
- Cost per Error
- Volume

#### Section E: Revenue Impact
Expected revenue effects:
- Customer Retention Improvement
- New Revenue Opportunities
- Cross-sell/Up-sell potential

#### Section F: Implementation Breakdown
- Technology costs
- Training costs
- Change management
- Consulting fees

#### Section G: Risk Inputs
- Risk factors
- Mitigation costs
- Contingency buffer

### AI Recommendations

The system automatically generates recommendations:
- **Approve** (Green) - Strong business case, proceed
- **Evaluate** (Amber) - Needs further analysis
- **Reject** (Red) - Not financially viable

### Buttons & Actions

| Button | Action |
|--------|--------|
| New Initiative | Create new ROI evaluation |
| View Details | Open full initiative breakdown |
| Edit | Modify existing initiative |
| Delete | Remove initiative |
| Validate | Run AI validation checks |
| Filter | Filter by recommendation |
| Sort | Sort by various metrics |

---

## 9. Quality Team Performance Tracker

**URL:** `/team`

### Purpose

Manage team members, track performance metrics, monitor training compliance, manage project assignments, and generate AI-powered insights.

### Tabs

#### Overview Tab
**Summary Cards:**
- Total Team Members
- Average Performance %
- Training Compliance %
- Active Projects

**Charts:**
- Team by Department
- Project Status distribution
- Team Status (Active/Inactive/On Leave)

**Top Performers List:**
- Ranked team members by performance score

#### Team Members Tab
Full team roster with:
- Name and contact info
- Role and department
- Status badge (Active/Inactive/On Leave/Probation)
- Performance score
- Training compliance %

**Add Member Button:**
Opens form to add new team member with all details.

#### Training Courses Tab
Manage training catalog:
- Course name and description
- Type (Mandatory/Optional)
- Department relevance
- Duration and passing score

**Add Course Button:**
Create new training course in system.

#### Training Matrix Tab
Visual matrix showing:
- Team members (rows)
- Courses (columns)
- Completion status at each intersection
- Identify training gaps

#### Projects Tab
View all project assignments:

**Table View:**
- Project details
- Assigned team members
- Status (Assigned/In Progress/Completed/On Hold)
- Priority and deadlines

**Kanban View:**
- Drag-and-drop cards between status columns
- Visual workflow management

**New Assignment Button:**
Assign team members to projects.

#### Analytics Tab
**AI Scope Generator:**
Click to generate a full project scope document using AI based on:
- Project objectives
- Team capabilities
- Historical data

### Buttons & Actions

| Button | Action |
|--------|--------|
| Add Member | Create new team member |
| Add Course | Create training course |
| New Assignment | Assign project |
| Table/Kanban Toggle | Switch project views |
| AI Scope Generator | Generate scope document |
| Filter | Filter by department/status |

---

## 10. PMP Project Portfolio

**URL:** `/projects`

### Purpose

Full PMP (Project Management Professional) compliant project management system covering all 10 PMBOK knowledge areas.

### Main Dashboard

**Summary Cards:**
- Total Projects
- Average SPI (Schedule Performance Index)
- Average CPI (Cost Performance Index)
- At Risk Projects
- High Risks

### Main Tabs

#### Portfolio Tab
View all projects in Cards or Table view:

**Project Card Shows:**
- Project name and status
- Priority badge
- Progress bar
- SPI and CPI indicators
- Owner/Manager
- Due date

**Status Options:**
- Initiation
- Planning
- Execution
- Monitoring
- Closing
- Completed
- On Hold

**Filters:**
- Status filter
- Priority filter
- Department filter

#### Analytics Tab
Charts showing:
- Projects by Status
- Projects by Priority
- Budget Overview
- Milestone Metrics

#### Risks Tab
Project Risk Register:
- Risk description
- Category (Technical, Schedule, Budget, etc.)
- Risk Score (Impact x Probability)
- Status (Open, Mitigated, Closed)
- Owner

**Risk Matrix:**
Visual 5x5 matrix showing risk distribution by impact and probability.

**Add Risk Button:**
Create new project risk.

#### Milestones Tab
Timeline of project milestones:
- Milestone name
- Planned date
- Actual date
- Variance (days early/late)
- Status

**Gantt Chart:**
Visual timeline of all milestones.

**Add Milestone Button:**
Create new milestone.

#### Stakeholders Tab
Stakeholder register:
- Name and role
- Type (Internal/External)
- Influence level (High/Medium/Low)
- Interest level
- Engagement strategy

**Add Stakeholder Button:**
Register new stakeholder.

#### Procurement Tab
Contract and vendor management:
- Vendor name
- Contract type
- Value
- Status
- Delivery dates

#### Change Control Tab
Change request management:
- Change description
- Requestor
- Impact assessment
- Status (Pending/Approved/Rejected)
- Implementation date

### AI Features

#### AI Charter Generator
Click **"AI Charter Generator"** to automatically create:
- Project charter document
- Objectives and scope
- Success criteria
- High-level timeline
- Initial risk assessment

#### Define Full Scope
Click **"Define Full Scope"** for wizard-guided scope definition.

### Buttons & Actions

| Button | Action |
|--------|--------|
| Quick Project | Create basic project |
| AI Charter Generator | Generate full charter |
| Define Full Scope | Scope wizard |
| Add Risk | Log project risk |
| Add Milestone | Create milestone |
| Add Stakeholder | Register stakeholder |
| Cards/Table Toggle | Switch views |

---

## 11. System Event Logs

**URL:** `/logs`

**Access:** Admin and Quality Manager roles

### Purpose

Enterprise-grade audit telemetry system for unified event tracking across all modules. Designed for compliance audits (ISO 9001, COPC, Six Sigma).

### Features

**Immutable Design:**
- Append-only logs - cannot be modified
- SHA-256 checksums for tamper detection
- Correlation IDs for cross-module tracing

**Summary Cards:**
- Total Logs
- Last 24 Hours
- Critical Events
- AI Actions

**Activity Chart:**
7-day timeline showing log volume by day.

### Filtering Options

| Filter | Options |
|--------|---------|
| Date Range | From/To date pickers |
| Action Type | CREATE, UPDATE, DELETE, STATUS_CHANGE, ASSIGN, AI_ACTION, etc. |
| Entity Type | PROJECT, TRAINING, ROI, USER, TEAM_MEMBER, CALL, NC, CAPA, TABLE_F |
| Severity | INFO, WARNING, CRITICAL |
| Module | All system modules |
| Correlation ID | Trace related events |

### Log Entry Details

Click any row to expand and view:
- Full description
- Old Value / New Value (for changes)
- AI Involved flag
- Timestamp and user info
- Checksum for verification

### Buttons & Actions

| Button | Action |
|--------|--------|
| Export CSV | Download filtered logs |
| Apply Filters | Refresh with filter criteria |
| Clear Filters | Reset all filters |
| Expand Row | View full log details |

---

## 12. Testing Sandbox

**URL:** `/sandbox`

### Purpose

Test quality scoring algorithms and duplicate detection logic with mock data without affecting production data.

### Features

- Generate mock CRM data
- Test scoring calculations
- Preview AI recommendations
- Validate dashboard displays
- **Duplicate Detection Testing** - Test duplicate matching logic

### Use Cases

1. **Training new users** - Practice without risk
2. **Testing configurations** - Validate before going live
3. **Debugging** - Isolate issues with known test data
4. **Duplicate Testing** - Verify duplicate detection accuracy

### Duplicate Detection Testing Section

The sandbox includes a dedicated section for testing duplicate detection:

#### Add Test Records
- Switch between Lead and Deal record types
- Enter First Name, Last Name, Email, Company, Owner
- **Email domain is key** - Records with the same email domain are grouped as duplicates
- Public domains (gmail.com, yahoo.com, etc.) are excluded

#### Quick Add Duplicates
Pre-configured test sets to quickly populate duplicate scenarios:
- **3 Leads @ acme-corp.com** - Three leads with same domain, different name spellings
- **2 Leads + 1 Deal @ techsolutions.sa** - Mixed record types in one cluster
- **2 Deals @ healthcare-ksa.com** - Two deals for same company

#### Run Detection
- Click "Run Duplicate Detection" to scan for duplicates
- View clusters found and total duplicate records
- Results appear in the Detected Duplicates panel

#### View Results
- Click any cluster to see matching records
- View record type (Lead/Deal), names, emails, companies
- "Domain Match" badge shows why records were grouped

#### Clear Data
- Use "Clear All Duplicate Test Data" to reset and start fresh

---

## 13. GRC Control Tower

> **Implements:** [SCOPE_OF_WORK.md §11.0 — GRC Control Tower Dashboard](./SCOPE_OF_WORK.md#110-grc-control-tower-dashboard).

**URL:** `/grc`

### Overview

The GRC Control Tower is the executive dashboard providing a unified view of your organization's governance, risk, and compliance posture. It aggregates data from all GRC modules into a single real-time view.

### Key Features

#### Summary Cards
- **Active Risks** - Total risks with critical count
- **Active Policies** - Total policies with draft count
- **Compliance Score** - Overall compliance percentage
- **Open Findings** - Audit findings requiring attention
- **Active Vendors** - Third-party vendors with high-risk count
- **Controls Active** - Control mappings with effectiveness

#### Risk Heat Map
Visual 4x4 matrix showing risk distribution by likelihood and impact:
- **Red zones** - Critical/High risk combinations
- **Amber zones** - Medium risk
- **Green zones** - Low risk

#### Module Status Chart
Doughnut chart showing relative activity across GRC modules.

#### Compliance by Framework
Progress bars showing compliance scores for each regulatory framework (PDPL, NCA-ECC, ISO 9001, etc.).

#### Handoff Rules Table
Shows Quality-GRC handoff automation rules with trigger counts.

#### Control Effectiveness Table
Displays control mappings with effectiveness scores.

---

## 14. Enterprise Risk Register

> **Implements:** [SCOPE_OF_WORK.md §11.1 — Enterprise Risk Register](./SCOPE_OF_WORK.md#111-enterprise-risk-register), with RBAC gates defined in [§4.8](./SCOPE_OF_WORK.md#48-rbac-role-based-access-control-routes).

**URL:** `/risks`

### Overview

The Enterprise Risk Register provides comprehensive risk management capabilities including identification, assessment, treatment, and monitoring.

### Features

#### Risk Summary Cards
- **Total Risks** - All registered risks
- **Critical Risks** - Risks with score >= 16
- **High Risks** - Risks with score 9-15
- **Pending Treatments** - Risks awaiting treatment

#### Adding a New Risk
1. Click the **+ Add Risk** button
2. Fill in the form:
   - **Title** - Descriptive risk name
   - **Description** - Detailed risk description
   - **Category** - Operational, Financial, Strategic, Compliance, Technology, Reputational
   - **Likelihood** - 1 (Rare) to 4 (Almost Certain)
   - **Impact** - 1 (Negligible) to 4 (Severe)
   - **Risk Owner** - Person responsible
3. Risk Score auto-calculates as Likelihood x Impact

#### Risk Heat Map
Interactive visual showing all risks positioned by likelihood and impact.

#### Managing Risks
- **View Details** - Click any risk to see full details
- **Add Treatment** - Click treatment button to add mitigation actions
- **Update Status** - Change risk status as treatments progress

#### Risk Acceptance (GRC Manager Role Required)

**Who Can Accept Risks?** Only users with the GRC Manager role (e.g., maram@walaplus.sa) can formally accept risks. This ensures proper governance and accountability.

**How to Accept a Risk:**
1. Open the risk detail view by clicking on any risk
2. Click the **"Accept Risk (GRC Only)"** button (slate-colored with shield icon)
3. Enter your GRC Manager email address when prompted
4. Provide a justification for accepting this risk (required)
5. If authorized, the risk status changes to "Monitoring" with treatment strategy "Accept"

**What Happens When Access is Denied:**
- Users without GRC Manager role receive a 403 "Permission Denied" error
- The system logs the attempt for audit trail
- The message indicates the required role (grc_manager)

**Accepted Risk Display:**
Once a risk is accepted, a slate-colored banner appears showing:
- Who accepted the risk (name and role)
- When it was accepted
- The acceptance justification

---

## 15. Policy & Document Governance

> **Implements:** [SCOPE_OF_WORK.md §11.2 — Policy & Document Governance](./SCOPE_OF_WORK.md#112-policy--document-governance). Dual-ownership schema in [§5.6](./SCOPE_OF_WORK.md#56-rbac-role-based-access-control-tables).

**URL:** `/policies`

### Overview

Manage your organization's policies through their complete lifecycle from draft to retirement.

### Policy Lifecycle

1. **Draft** - Initial policy creation
2. **Review** - Under stakeholder review
3. **Approval** - Awaiting approval
4. **Published** - Active and in effect
5. **Retired** - No longer active

### Features

#### Policy Summary Cards
- **Total Policies** - All policies
- **Published** - Active policies
- **Review Due** - Policies due for review
- **Draft** - Policies in draft

#### Creating a Policy
1. Click **+ Add Policy**
2. Enter policy details:
   - **Title** - Policy name
   - **Document Number** - Unique identifier
   - **Category** - HR, IT, Operations, Finance, Legal, Security, Quality
   - **Owner** - Responsible department/person
   - **Review Frequency** - Annual, Bi-Annual, Quarterly

#### Version Control
Each policy maintains version history. When updating a published policy:
1. A new version is automatically created
2. Previous versions remain accessible
3. Change notes are recorded

#### Approval Workflow
- Submit policy for approval
- Add approvers
- Track approval status
- Record approval date

#### GRC Approval (Dual Ownership System)

**What is Dual Ownership?**
Policies have two types of owners:
- **Operational Owner** - Responsible for day-to-day policy implementation
- **Compliance Owner** - GRC Manager who ensures regulatory alignment

**GRC Approval Requirement:**
Policies in "Approval" status **cannot be published** until the GRC Manager (Compliance Owner) approves them.

**How to Request GRC Approval:**
1. When viewing a policy in "Approval" status, click the **"Request GRC Approval"** button (slate-colored with shield icon)
2. Enter the GRC Manager email address (e.g., maram@walaplus.sa)
3. If the user has GRC Manager role, the policy receives compliance approval
4. Once approved, a green "GRC Approved" badge appears and the "Publish" button becomes available

**What Happens When Access is Denied:**
- Users without GRC Manager role receive a 403 "Permission Denied" error
- The system logs the failed attempt
- The message indicates the required role (grc_manager)

**Benefits of Dual Ownership:**
- Ensures compliance review before publication
- Creates clear audit trail
- Enforces separation of duties
- Meets Saudi regulatory requirements (PDPL, NCA)

---

## 16. Compliance & Regulatory Tracker

**URL:** `/compliance`

### Overview

Track your organization's compliance obligations against regulatory frameworks including Saudi regulations (PDPL, NCA-ECC, NCA-DCC) and international standards (ISO 9001, ISO 27001, COPC).

### Pre-Seeded Frameworks

| Framework | Description |
|-----------|-------------|
| PDPL | Saudi Personal Data Protection Law |
| NCA-ECC | National Cybersecurity Authority Essential Controls |
| NCA-DCC | National Cybersecurity Authority Data Cybersecurity Controls |
| ISO 9001 | Quality Management System |
| ISO 27001 | Information Security Management |
| COPC | Customer Operations Performance Center |

### Features

#### Compliance Dashboard
- **Overall Compliance Score** - Percentage across all frameworks
- **Framework-specific scores** - Individual progress
- **Obligation status** - Compliant/Non-Compliant/In Progress

#### Managing Obligations
1. Select a framework to view its obligations
2. For each obligation:
   - Update status (Compliant, Non-Compliant, In Progress)
   - Add evidence documentation
   - Set due dates
   - Assign owners

#### Adding Evidence
1. Click **Add Evidence** on any obligation
2. Upload supporting documentation
3. Add description and date

---

## 17. Audit Readiness Module

**URL:** `/audits`

### Overview

Manage internal and external audits, track findings, and generate evidence packs for regulatory compliance.

### Features

#### Audit Summary
- **Total Audits** - Scheduled and completed
- **Open Findings** - Findings requiring action
- **Critical Findings** - High-priority issues
- **Evidence Items** - Collected documentation

#### Scheduling Audits
1. Click **+ New Audit**
2. Enter audit details:
   - **Audit Name** - Descriptive title
   - **Type** - Internal or External
   - **Scope** - What areas are covered
   - **Lead Auditor** - Primary auditor
   - **Start/End Dates** - Audit timeline

#### Recording Findings
1. Open an audit
2. Click **Add Finding**
3. Enter finding details:
   - **Title** - Brief description
   - **Severity** - Critical, High, Medium, Low
   - **Description** - Full details
   - **Corrective Action** - Required remediation
   - **Due Date** - Remediation deadline

#### Evidence Pack Generation
1. Select an audit
2. Click **Generate Evidence Pack**
3. System compiles all related evidence into a downloadable package

---

## 18. Vendor Risk Management

**URL:** `/vendors`

### Overview

Assess and monitor third-party vendor risks, track due diligence, and manage remediation activities.

### Features

#### Vendor Dashboard
- **Active Vendors** - Current third parties
- **Critical Vendors** - High-risk vendors
- **Pending Assessments** - Due for evaluation
- **Open Remediations** - Actions in progress

#### Adding Vendors
1. Click **+ Add Vendor**
2. Complete vendor profile:
   - **Name** - Vendor company name
   - **Category** - IT, Finance, HR, Operations, Marketing, Legal
   - **Criticality** - Critical, High, Medium, Low
   - **Contact Info** - Primary contact details
   - **Contract Dates** - Start and end dates

#### Risk Assessments
1. Select a vendor
2. Click **New Assessment**
3. Complete risk questionnaire
4. System calculates overall risk score
5. AI generates risk recommendations

#### Remediation Tracking
1. Create remediation plans for identified risks
2. Assign owners and due dates
3. Track progress to completion

---

## 19. Data Migration Engine

**URL:** `/migration`

### Overview

Import data from CSV and Excel files with AI-powered field mapping and deduplication.

### Features

#### Templates
Pre-configured import templates for:
- Risk Register data
- Policy documents
- Compliance obligations
- Vendor information

#### Import Process
1. Select a template
2. Upload CSV/Excel file
3. **AI Field Mapping** - System suggests column mappings
4. Review and adjust mappings
5. **Validation Preview** - See data before import
6. **Deduplication** - AI identifies potential duplicates
7. Confirm and import

#### Deduplication Rules
The system includes 7 pre-configured rules:
- Risk title similarity
- Policy document number matching
- Vendor name matching
- Compliance obligation matching
- And more...

#### Rollback Capability
If issues are found after import:
1. Go to Import History
2. Select the import
3. Click **Rollback** to undo changes

---

## 20. Duplicate Radar

> **Implements:** [SCOPE_OF_WORK.md §11.8 — Duplicate Radar Module](./SCOPE_OF_WORK.md#118-duplicate-radar-module).

**URL:** `/duplicates`

### Overview

The Duplicate Radar module provides AI-powered duplicate detection for CRM data hygiene. It identifies duplicate Leads and Deals by analyzing email domains (company-based clustering) and provides confidence scoring to help your team clean up the CRM. The module operates in **READ-ONLY mode** - it detects and recommends, but humans take action in Zoho CRM.

### Key Concepts

#### Domain-Based Clustering
- Duplicates are grouped by email domain (e.g., all records with @acme-corp.com are clustered together)
- Public domains like gmail.com, yahoo.com, hotmail.com are excluded
- Each cluster represents a company with multiple CRM entries

#### Confidence Scoring
| Level | Score | Meaning |
|-------|-------|---------|
| High | ≥90% | Strong match - same domain, similar names |
| Medium | 60-89% | Likely match - same domain, some variation |
| Low | <60% | Possible match - requires manual review |

#### Read-Only Philosophy
"AI detects, humans act" - The system identifies duplicates and recommends actions, but does not automatically modify Zoho CRM data.

### Dashboard Views (7 Tabs)

#### 1. Executive Summary
Overview of duplicate status:
- **Total Clusters** - Number of company domains with duplicates
- **Duplicate Leads** - Total leads flagged as duplicates
- **Duplicate Deals** - Total deals flagged as duplicates
- **High/Medium Confidence** - Breakdown by match certainty
- **Pipeline Inflation** - Estimated value of duplicate deals (potential over-counting)
- **Charts** - Duplicates by source, confidence distribution
- **KPIs** - Duplicate rates for leads and deals

#### 2. Domain Clusters
Browse all detected duplicate clusters:
- Filter by confidence level (High/Medium/Low)
- Filter by status (Active/Resolved/Ignored)
- Click any cluster to view all records in that group

#### 3. Lead Duplicates
View duplicate leads specifically:
- Shows groups where multiple leads share the same company domain
- Click to expand and see all leads in the cluster
- View names, emails, owners, and creation dates

#### 4. Deal Duplicates
View duplicate deals specifically:
- Shows groups where multiple deals exist for the same company
- Critical for pipeline accuracy
- Shows deal values and stages

#### 5. Owner Accountability
See duplicates by CRM owner:
- Identifies which team members have the most duplicates
- Helps prioritize cleanup efforts
- Shows lead count, deal count, and total duplicates per owner

#### 6. Export Center
Export duplicate data for offline analysis:
- CSV export of all clusters
- Filter by confidence level or owner
- Download activity logs

#### 7. Logs
Detection and export activity history:
- When detections were run
- Export history
- Status changes

### Buttons

| Button | Action |
|--------|--------|
| **Generate Test Data** | Creates sample duplicate records for testing |
| **Export CSV** | Downloads current view as CSV file |
| **Refresh** | Reloads data from database |

### Workflow: Reviewing Duplicates

1. **Go to Executive Summary** - Check overall duplicate health
2. **Check High Confidence first** - These are most likely true duplicates
3. **Click a cluster** - View all records sharing that domain
4. **Review records** - Check names, emails, owners
5. **Take action in Zoho** - Merge or close duplicates in CRM
6. **Mark as Resolved** - Update cluster status in WalaPlus

### Testing in Sandbox

You can test duplicate detection logic in the Testing Sandbox (`/sandbox`):
1. Go to `/sandbox`
2. Scroll to "Duplicate Detection Testing" section
3. Use "Quick Add Duplicates" buttons to create test sets
4. Click "Run Duplicate Detection" to see results
5. Click any cluster to view matched records
6. Use "Clear All Duplicate Test Data" to reset

### Color Coding

| Color | Meaning |
|-------|---------|
| Violet (#7C3AED) | Duplicate Radar theme |
| Green | High confidence matches |
| Amber | Medium confidence matches |
| Red | Low confidence matches |
| Blue | Lead records |
| Green | Deal records |

---

## 21. User Onboarding & Help

> **Implements:** [SCOPE_OF_WORK.md §3.11 — User Onboarding & Help](./SCOPE_OF_WORK.md#311-user-onboarding--help).

**URL:** `/onboarding`

### Overview

The User Onboarding module helps new users learn the WalaPlus system through interactive guides, videos, and contextual help.

### Features

#### Welcome Modal
- **Introduction Video** - 2-4 minute system overview
- **Start Tour Button** - Begins the guided walkthrough
- **Skip Option** - For experienced users

#### Guided Tour (6 Steps)
The interactive tour highlights key areas:

1. **Dashboard Overview** - Main metrics and navigation
2. **Projects & Governance** - PMP portfolios and compliance
3. **ROI/NPV Calculator** - Submitting quality initiatives
4. **Event Logs** - Audit trail and compliance
5. **AI Assistance** - Using AI features throughout the system
6. **Submission Flow** - How initiatives are reviewed

#### Progress Tracking
- See your onboarding completion status
- Track video watched, tour completed
- Visual progress bar

#### Quick Actions
| Action | Description |
|--------|-------------|
| Watch Introduction Video | Replay the overview video |
| Restart Guided Tour | Take the tour again |
| Submit New Initiative | Quick link to ROI form |

### Contextual Tooltips

Throughout the ROI form, look for **purple question mark icons** next to key fields. Click them to see:
- Field explanation
- How to calculate the value
- Where to find the data

### Shareable Demo Links

Administrators can create demo links to share with external stakeholders:
- Time-limited access
- View-only demo mode
- Tracks view counts

### Admin View

Access admin statistics at `/onboarding?admin=true`:
- Total users onboarded
- Video watched count
- Tour completion rate
- Demo link management

---

## 22. AI Features Overview

### How the AI Works

WalaPlus uses **GPT-4o** (via Replit AI Integrations) to provide intelligent analysis and recommendations throughout the system.

### AI-Powered Features by Module

| Module | AI Feature |
|--------|------------|
| Quality Dashboard | AI Recommendations based on quality scores |
| QMS | Analysis of evaluation patterns |
| Table F | Risk assessments for at-risk KPIs |
| Call Intelligence | Sentiment analysis, topic extraction, call summaries |
| ROI Engine | Investment recommendations (Approve/Evaluate/Reject) |
| Team Tracker | AI Scope Generator for projects |
| PMP Projects | AI Project Charter Generator |
| Event Logs | AI Action tracking and correlation |

### Automated AI Workflow

The **Quality Specialist Agent** runs automatically:
- **Schedule:** Every Monday at 8 AM UTC
- **Process:**
  1. Fetches data from Google Calendar and Zoho CRM
  2. Runs AI analysis on data quality
  3. Calculates quality scores (People, Process, Governance)
  4. Stores results in database
  5. Sends email report to configured recipients

### AI Agent Capabilities

- **Data Hygiene Audits** - Checks for missing, duplicate, or stale data
- **Anomaly Detection** - Identifies unusual patterns
- **Trend Analysis** - Predicts future quality issues
- **Recommendations** - Prioritized action items

---

## 23. Frequently Asked Questions

### General

**Q: How often is data refreshed?**
A: Dashboard data refreshes when you load the page or click Refresh. Automated audits run weekly on Mondays at 8 AM UTC.

**Q: Who receives the weekly email reports?**
A: Reports are sent to amashah@outlook.com. Contact admin to add recipients.

**Q: What if CRM credentials aren't configured?**
A: The system handles this gracefully, showing appropriate messages and using available data.

### Quality Dashboard

**Q: What is a good Quality Score?**
A: Above 75% is considered good, 50-75% needs attention, below 50% requires immediate action.

**Q: Can I rearrange the dashboard widgets?**
A: Yes, click Customize and drag widgets by their headers to reorder.

### ROI Engine

**Q: How is ROI calculated?**
A: ROI = (Total Benefits - Total Costs) / Total Costs × 100

**Q: What does AI "Evaluate" recommendation mean?**
A: The initiative has potential but needs more data or refinement before approval.

### Event Logs

**Q: How long are logs retained?**
A: Logs are stored in monthly partitions. Retention policy should be set by your admin.

**Q: Can logs be modified?**
A: No, the system uses an immutable append-only design with SHA-256 checksums to prevent tampering.

---

## Support

For technical issues or feature requests, contact your system administrator.

---

*This manual covers WalaPlus Agentic AI Quality Specialist v1.0*
