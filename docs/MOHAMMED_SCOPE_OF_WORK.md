# Mohammed Al Muzaini - Scope of Work (2026)
## Quality & GRC Governance Officer

---

## Role Mission Statement

> **"Ensure governance discipline, visibility & readiness — NOT execution."**

Mohammed Al Muzaini is the Quality & GRC Governance Officer responsible for tracking, monitoring, and ensuring readiness of all governance-related activities. This role operates as the "governance watchdog" who ensures processes are followed, evidence is collected, and the organization is always audit-ready.

**Key Principle**: Mohammed TRACKS governance activities; he does NOT execute them. He follows up on actions, prepares evidence packs, maintains register hygiene, and supports reporting.

---

## Role Boundaries

### What Mohammed DOES
- Tracks document lifecycle compliance across all governance documents
- Monitors compliance obligation status and evidence collection
- Prepares and verifies audit evidence packs before audits
- Ensures Quality→GRC handoffs are completed successfully
- Maintains hygiene of risk registers (owner, status, review dates)
- Validates executive dashboard accuracy before leadership reviews
- Follows up with owners when items are overdue or incomplete
- Documents issues and escalates when necessary

### What Mohammed DOES NOT DO
- Make governance decisions (escalate to Sara/Maram)
- Approve policies or risk treatments (not an approver role)
- Execute risk treatments or remediation actions
- Conduct audits (supports audit readiness only)
- Accept risks on behalf of the organization

---

## The 6 KPIs Framework (2026)

### Overview

| KPI # | KPI Name | Weight | Target | Frequency |
|-------|----------|--------|--------|-----------|
| MAM-KPI-01 | Governance Documentation Lifecycle | 20% | 95% | Weekly |
| MAM-KPI-02 | Compliance Obligation Tracking | 20% | 95% | Weekly |
| MAM-KPI-03 | Audit Evidence Pack Readiness | 20% | 100% | Weekly |
| MAM-KPI-04 | Quality→GRC Handoff Effectiveness | 15% | 95% | Weekly |
| MAM-KPI-05 | Risk Register Hygiene | 15% | 100% | Weekly |
| MAM-KPI-06 | Executive GRC Reporting Readiness | 10% | 95% | Weekly |

---

## KPI 1: Governance Documentation Lifecycle (20%)

### Description
Ensure all documents follow the complete lifecycle: Draft → Review → Approval → Publish → Periodic Review

### Measurement
Percentage of documents compliant with lifecycle requirements

### Target
95% of documents in compliant status

### Data Source
- Policies Dashboard (`/policies`)
- Policy Review Cycles

### Screen Reference
![Policies Dashboard](/docs/screenshots/policies_dashboard_ui_mockup.png)
*The Policies Dashboard shows document lifecycle status, review dates, and owner assignments.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Open Policies Dashboard | Policy & Document Governance | Filter by status to see lifecycle stages | Documents stuck in Draft/Review too long | Follow up with document owner for status update |
| 2 | Check Review Dates | Policies Table | Look for red/overdue review dates | Review date passed | Contact owner (e.g., Sara) to schedule review |
| 3 | Verify Approval Evidence | Policy Details | Check approval status and approver name | Missing approval | Escalate to approver or document in QMS |
| 4 | Update Tracking | QMS Dashboard | Log follow-up action taken | Issue tracked | Set reminder for next check |

### Weekly Routine
1. Every Monday morning, run the Policies Dashboard filter
2. Export list of overdue reviews to tracking spreadsheet
3. Send reminder emails to document owners by Wednesday
4. Update tracking sheet with responses by Friday
5. Escalate non-responses to Sara (Quality Manager)

---

## KPI 2: Compliance Obligation Tracking (20%)

### Description
Accuracy of compliance mapping across PDPL, ISO 27001, NCA, and COPC frameworks

### Measurement
Percentage of obligations with owner + evidence + current status

### Target
95% of obligations fully tracked

### Data Source
- Compliance Dashboard (`/compliance`)
- Obligations Table

### Regulatory Frameworks Covered
- **PDPL**: Saudi Personal Data Protection Law
- **ISO 27001**: Information Security Management
- **NCA**: National Cybersecurity Authority requirements
- **COPC**: Contact Center Operations standards

### Screen Reference
![Compliance Dashboard](/docs/screenshots/compliance_dashboard_ui_mockup.png)
*The Compliance Dashboard tracks obligations by regulation, owner, evidence status, and due dates.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Open Compliance Dashboard | Compliance & Regulatory Tracker | Review obligation summary by regulation | Missing mappings for PDPL/NCA/ISO | Flag to Maram (GRC Manager) for review |
| 2 | Check Obligation Details | Obligations Table | Verify each obligation has owner + evidence | Owner missing | Assign to responsible department head |
| 3 | Verify Evidence Status | Compliance Assessments | Check evidence_provided field is populated | No evidence uploaded | Request evidence from IT/department owner |
| 4 | Update Status | Compliance Dashboard | Mark as Compliant when evidence complete | All fields complete | Log in tracking sheet for audit trail |

### Weekly Routine
1. Review compliance dashboard by regulation type
2. Identify obligations with missing owners or evidence
3. Send evidence requests to department heads
4. Track responses and update assessment records
5. Prepare weekly compliance status summary

---

## KPI 3: Audit Evidence Pack Readiness (20%)

### Description
Audit readiness before internal/external audits begin

### Measurement
Percentage of audits with complete evidence packs pre-audit

### Target
100% of audits fully prepared before Day 1

### Data Source
- Audit Readiness Dashboard (`/audits`)
- Evidence Packs Table

### Screen Reference
![Audit Readiness Dashboard](/docs/screenshots/audit_readiness_dashboard_mockup.png)
*The Audit Readiness Dashboard shows upcoming audits, evidence pack status, and checklist progress.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Check Upcoming Audits | Audit Readiness Dashboard | Review audits scheduled in next 30 days | Audit in 3 weeks | Check evidence pack status immediately |
| 2 | Review Evidence Packs | Evidence Packs Section | Verify pack status (Draft/Compiled/Reviewed) | Pack still in Draft | Escalate to pack owner for completion |
| 3 | Complete Checklist | Audit Checklists | Ensure all checklist items have responses | 3 items missing evidence | Request documents from relevant teams before Day 1 |
| 4 | Final Verification | Audit Details | Confirm all sections marked complete | Pack ready | Mark as Reviewed and notify audit lead |

### Audit Preparation Timeline
- **T-30 days**: Begin evidence collection, assign checklist items
- **T-14 days**: Follow up on outstanding items, escalate delays
- **T-7 days**: Complete evidence pack compilation
- **T-3 days**: Final review and quality check
- **T-1 day**: Confirm 100% readiness with audit lead

---

## KPI 4: Quality→GRC Handoff Effectiveness (15%)

### Description
Proper handoff of Quality findings into GRC tracking for resolution

### Measurement
Percentage of critical findings logged and tracked to closure

### Target
95% of handoffs completed successfully

### Data Source
- Quality-GRC Handoff Engine (`/handoffs`)
- Handoff Events Table

### Screen Reference
![Quality-GRC Handoff Dashboard](/docs/screenshots/quality-grc_handoff_dashboard.png)
*The Handoff Engine tracks Quality findings being transferred to GRC systems with priority and status indicators.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Monitor Handoff Events | Quality-GRC Handoff Engine | Check for pending/failed handoffs | Handoff failed | Investigate error and retry or log manually |
| 2 | Track Critical Findings | Handoff Events Table | Filter by priority=critical | Critical finding not in GRC | Log in GRC tracker manually, assign to HR/Maram |
| 3 | Verify GRC Entry | GRC Control Tower | Confirm finding appears in risk/compliance register | Entry exists | Link to source QMS record |
| 4 | Track to Closure | Risk Register / Compliance | Monitor status until resolved | Evidence uploaded, closed | Mark handoff as complete in tracker |

### Handoff Rules
1. **Critical findings**: Must be logged in GRC within 24 hours
2. **High priority**: Log within 3 business days
3. **Medium priority**: Log within 1 week
4. **Low priority**: Log within 2 weeks

---

## KPI 5: Risk Register Hygiene (15%)

### Description
Maintain cleanliness of risk register - ensure all risks have proper ownership and tracking

### Measurement
Percentage of risks with owner, status, and review date

### Target
100% of risks with complete hygiene

### Data Source
- Enterprise Risk Register (`/risks`)
- Risk Treatment Actions

### Screen Reference
![Risk Register Dashboard](/docs/screenshots/risk_register_dashboard_mockup.png)
*The Risk Register shows all enterprise risks with owners, ratings, review dates, and treatment status.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Review Risk Register | Enterprise Risk Register | Identify risks missing owner field | Risk without owner detected | Flag to Maram for owner assignment |
| 2 | Check Review Dates | Risk Register Table | Look for overdue review dates (red) | Review overdue by 30+ days | Contact risk owner to schedule reassessment |
| 3 | Verify Treatment Status | Risk Treatment Actions | Check all treatments have current status | Status is stale/unclear | Request update from treatment owner |
| 4 | Update Register | Risk Details | Ensure all fields populated correctly | All hygiene checks pass | Document in weekly hygiene report |

### Hygiene Checklist
- [ ] Every risk has an assigned owner
- [ ] Every risk has a current status (open/in_treatment/closed)
- [ ] Every risk has a next review date within 90 days
- [ ] Every high/critical risk has an active treatment plan
- [ ] All treatment actions have owners and due dates

---

## KPI 6: Executive GRC Reporting Readiness (10%)

### Description
Accuracy and timeliness of executive GRC views for leadership reviews

### Measurement
Timely, error-free dashboards and summaries

### Target
95% reporting accuracy

### Data Source
- Executive Dashboard (`/executive`)
- GRC Control Tower (`/grc`)
- KPI Engine (`/kpis`)

### Screen Reference
![GRC Control Tower](/docs/screenshots/grc_control_tower_dashboard.png)
*The GRC Control Tower provides executive-level overview of governance, risk, and compliance health.*

### Navigation Steps

| Step | Action | Screen | What to Check | If Result | Then Action |
|------|--------|--------|---------------|-----------|-------------|
| 1 | Review GRC Control Tower | GRC Control Tower | Verify all metrics are current and accurate | Data looks outdated | Trigger data refresh or investigate source |
| 2 | Check Executive Dashboard | Executive Dashboard | Confirm no errors or missing sections | Section shows error/blank | Check data source and fix or escalate |
| 3 | Validate KPI Engine | KPI Engine | Ensure all KPIs have recent values | KPI value missing/stale | Update KPI calculation or request data input |
| 4 | Pre-Leadership Review | All Dashboards | Do quick walkthrough before exec meeting | All current and accurate | Confirm ready for CEO/leadership review |

### Pre-Meeting Checklist
- [ ] All dashboard metrics showing current data
- [ ] No error messages or broken charts
- [ ] KPI values updated within last week
- [ ] Risk heat map reflecting current status
- [ ] Compliance scores accurate

---

## Daily Routine

### Morning (8:00 - 9:00)
1. Check for failed handoff events
2. Review overnight audit status changes
3. Scan for urgent escalations

### Mid-Day (12:00 - 13:00)
1. Follow up on pending evidence requests
2. Update tracking spreadsheet
3. Log completed actions

### End of Day (16:00 - 17:00)
1. Document daily progress
2. Update KPI status in system
3. Prepare next-day priority list

---

## Weekly Routine

### Monday
- Run all 6 KPI calculations
- Generate weekly status report
- Identify top 5 priorities for the week

### Wednesday
- Follow up on all pending items
- Send reminder notifications
- Prepare mid-week status update

### Friday
- Complete weekly hygiene report
- Update documentation
- Prepare handover notes for next week

---

## Escalation Matrix

| Issue Type | First Contact | Escalate To | Timeframe |
|------------|--------------|-------------|-----------|
| Document Review Overdue | Document Owner | Sara (Quality Manager) | 48 hours |
| Missing Compliance Evidence | Department Head | Maram (GRC Manager) | 72 hours |
| Failed Handoff | IT Support | System Admin | 24 hours |
| Risk Without Owner | Business Unit Lead | Maram (GRC Manager) | 48 hours |
| Dashboard Error | IT Support | System Admin | 4 hours |

---

## Tools & Access Required

### WalaPlus Dashboards
- `/` - Main Quality Dashboard
- `/grc` - GRC Control Tower
- `/policies` - Policy & Document Governance
- `/compliance` - Compliance & Regulatory Tracker
- `/audits` - Audit Readiness Dashboard
- `/risks` - Enterprise Risk Register
- `/handoffs` - Quality-GRC Handoff Engine
- `/kpis` - KPI Engine (filter by Mohammed)
- `/executive` - Executive Dashboard

### External Tools
- Email for sending follow-up notifications
- Spreadsheet for tracking log (optional)
- Calendar for scheduling reviews

---

## Platform v2.1 Features for Governance (NEW)

### Multi-Scorecard Governance System

The platform now supports multiple named scorecards per team with versioning. This is relevant to Mohammed's governance tracking work:

**How This Helps Mohammed:**
- **Track Scorecard Compliance**: Monitor which teams have active scorecards defined
- **Verify Evaluation Logic**: Ensure each scorecard attribute has proper evaluation logic documented
- **Evidence Field Mapping**: Confirm that evidence sources are correctly mapped for audit readiness
- **Version Control**: Track scorecard versions to ensure teams are using approved criteria

**Navigation Path:**
1. Go to Admin Panel (`/admin`)
2. Select "Scorecards" tab
3. Filter by Module/Team
4. Review active scorecards and their attributes

**What to Check Weekly:**
- Each team (SDR, Sales, CS, Marketplace) has an active scorecard
- Scorecard attributes have Severity levels assigned (Critical, Major, Minor)
- Evaluation Logic field is populated for AI audit readiness
- Evidence Source field maps to correct CRM fields

### Agent Performance Tracking

Real-time performance tracking based on Zoho CRM Lead Owner data provides visibility into team member quality scores.

**How This Helps Mohammed:**
- **Identify Low Performers**: Agents with scores below 70% may need intervention
- **Track Improvement**: Monitor score trends for agents receiving coaching
- **Support Audit Evidence**: Agent performance data supports People dimension audits
- **Team Comparisons**: Compare performance across SDR, Sales, and other teams

**Navigation Path:**
1. Go to Quality Dashboard (`/`)
2. Scroll to "Agent Performance" widget
3. Use team filter dropdown to view specific teams
4. Click any agent card for detailed breakdown

**Performance Score Calculation:**
- Based on data quality of CRM records owned by each agent
- Issue weighting: Critical (4x), High (3x), Medium (2x), Low (1x)
- Score = 100 - (weighted issues / max possible weight) × 100

**What to Report:**
- Agents with scores below 70% (Red status)
- Teams with average scores below 80%
- Week-over-week trends for at-risk agents

---

## Success Metrics

### Green Status (On Track)
- KPI score ≥ 85%
- All urgent items addressed within SLA
- No audit findings for missing evidence

### Amber Status (At Risk)
- KPI score 70-84%
- Some overdue items pending
- Minor gaps identified

### Red Status (Critical)
- KPI score < 70%
- Multiple overdue items
- Significant gaps affecting audit readiness

---

## Reporting Cadence

| Report | Frequency | Audience | Content |
|--------|-----------|----------|---------|
| KPI Status Summary | Weekly | Sara, Maram | All 6 KPI scores with trends |
| Hygiene Report | Weekly | GRC Team | Risk register status |
| Audit Prep Status | As needed | Audit Lead | Evidence pack readiness |
| Executive Summary | Monthly | Leadership | Overall governance health |

---

## Contact Information

**Reports To**: Sara (Quality Manager) & Maram (GRC Manager)

**Collaborates With**:
- Department Heads (for evidence collection)
- IT Team (for system issues)
- Audit Team (for audit preparation)
- HR (for training-related compliance)

---

*Last Updated: January 2026*
*Document Version: 2.1*
