# WalaPlus Platform Hygiene Rules — By Module

---

## 1. Quality Management System (QMS)

### 1.1 Nonconformance (NC) Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| NC must have CAPA within 7 days | NC open > 7 days with no linked CAPA | Critical/High/Medium (based on NC severity) | Create CAPA with root cause analysis and corrective action timeline |
| NC severity classification | Each NC classified as critical, major, or minor | Determines alert severity | Critical NC = critical alert; Major = high; Minor = medium |

### 1.2 CAPA Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| CAPA effectiveness check required | CAPA marked for closure | Mandatory | Must provide: result (effective/partially_effective/not_effective), evidence, reviewedBy |
| Auto re-CAPA on not_effective | Effectiveness result = not_effective | High | System automatically creates a new follow-up CAPA |
| CAPA approval workflow | CAPA completion | Mandatory | Must go through approval before final closure |

### 1.3 Quality Audit Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| Audit score decline detection | 3+ consecutive audits with declining scores AND drop > 5% | High | Investigate root causes; focus on lowest-scoring dimension |
| Severity rating matrix | Audit results | Reference | Excellent: 90-100%, Good: 80-89%, Needs Improvement: 70-79%, Below Standard: 60-69%, Critical: 0-59% |

### 1.4 Quality Scorecard Dimensions (ISO 9001 + COPC aligned)
| Dimension | Weight | Key Attributes |
|-----------|--------|----------------|
| **People Score** | 25% | CRM Data Entry Accuracy (30%), Notes Quality (20%), Follow-up Discipline (25%), Calendar Sync (15%), Escalation Timeliness (10%) |
| **Process Score** | 35% | Stage Progression Accuracy (20%), First Contact SLA (15%), Proposal Cycle Time (20%), Meeting Confirmation (15%), Not Attend Handling (10%), Closed Lost Reason (10%), Stage Timeframe (10%) |
| **Governance Score** | 40% | Same-Day CRM Update (20%), Document Attachment (20%), Qualification Validation (15%), Agreement Review SLA (15%), Handover Completeness (15%), Audit Trail Integrity (15%) |

### 1.5 Evaluation Frameworks
**ISO 9001 Criteria:**
| Criteria | Weight | Target | Thresholds (Excellent/Good/Acceptable/Needs Improvement) |
|----------|--------|--------|----------------------------------------------------------|
| Customer Focus | 15% | 95% | 95 / 85 / 75 / 60 |
| Leadership Commitment | 10% | 90% | 100 / 80 / 60 / 40 |
| Process Approach | 15% | 90% | 95 / 85 / 70 / 50 |
| Evidence-Based Decisions | 12% | 90% | 95 / 85 / 70 / 55 |
| Continual Improvement | 10% | 85% | 90 / 80 / 65 / 50 |
| Risk-Based Thinking | 12% | 90% | 95 / 85 / 70 / 55 |
| Documentation Control | 10% | 95% | 100 / 90 / 80 / 60 |

**COPC Criteria:**
| Criteria | Weight | Target | Thresholds (Excellent/Good/Acceptable/Needs Improvement) |
|----------|--------|--------|----------------------------------------------------------|
| First Contact Resolution | 15% | 85% | 90 / 80 / 70 / 55 |
| Response Time SLA | 15% | 95% | 98 / 95 / 90 / 80 |
| Customer Satisfaction Score | 18% | 90% | 95 / 85 / 75 / 60 |
| Quality Monitoring Compliance | 12% | 92% | 95 / 90 / 85 / 75 |
| Escalation Handling | 10% | 95% | 98 / 92 / 85 / 70 |
| Agent Utilization | 8% | 85% | 90 / 82 / 75 / 65 |
| Average Handle Time | 8% | 90% | 95 / 88 / 80 / 70 |

**Six Sigma Criteria:**
| Criteria | Weight | Target | Thresholds |
|----------|--------|--------|------------|
| Define Phase Compliance | 10% | 95% | 98 / 90 / 80 / 65 |
| Measure Phase Compliance | 12% | 90% | 95 / 85 / 75 / 60 |
| Analyze Phase Compliance | 12% | 85% | 90 / 80 / 70 / 55 |

---

## 2. Risk Management (GRC)

### 2.1 Risk Scoring Rules
| Rule | Formula / Threshold | Classification |
|------|---------------------|----------------|
| Risk Score | Impact (1-5) x Likelihood (1-5) | Auto-calculated, stored in DB |
| Critical Risk | Score >= 20 | Immediate escalation alert |
| High Risk | Score >= 12 | High-priority alert |
| Medium Risk | Score >= 6 | Standard monitoring |
| Low Risk | Score < 6 | Routine review |

### 2.2 Risk Treatment Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| Overdue treatment detection | Treatment action past due_date and not completed/cancelled | High (>30 days overdue) / Medium | Update status or request deadline extension with justification |
| Low-progress treatment alert | Progress < 30% AND due within 14 days | High (overdue) / Medium (upcoming) | Escalate to risk owner; review resource allocation; consider splitting into smaller milestones |
| High risk without treatment | Score >= 15 and status not closed/mitigated | Critical (>=20) / High | Review treatment plan; escalate to management |
| Residual risk tracking | After treatment applied | Mandatory | Must record residual_impact and residual_likelihood (both 1-5 scale) |
| Review frequency | Default: quarterly | Configurable | Track last_review_date and next_review_date |

### 2.3 Risk Register Constraints (Database-level)
- `impact_score` must be between 1 and 5
- `likelihood_score` must be between 1 and 5
- `residual_impact` must be between 1 and 5
- `residual_likelihood` must be between 1 and 5
- Risk level auto-calculated from score (critical/high/medium/low)
- Risk score history tracked on every change (previous vs new values)

---

## 3. Compliance Module

### 3.1 Compliance Checklist Hygiene Rules
| Rule | Detail |
|------|--------|
| Check types supported | `data_query`, `count_check`, `existence_check`, `threshold_check`, `manual` |
| Automated checks | System auto-queries database modules to verify compliance items |
| Critical items | Items flagged as `is_critical` must pass for overall compliance |
| Weight-based scoring | Each checklist item has a weight for weighted score calculation |
| Checklist run tracking | Every run records: overall_score, total_items, passed, failed, N/A, item_results, run_by |
| Standards support | ISO 9001, COPC, and custom standard checklists |

### 3.2 Obligation Tracking Rules
| Field | Rule |
|-------|------|
| `obligation_code` | Must be unique |
| `requirement_type` | Default: mandatory |
| `control_type` | Default: preventive |
| `compliance_frequency` | Default: annual; options include monthly, quarterly, annual |
| `evidence_requirements` | Must document what evidence is needed |
| `penalty_for_noncompliance` | Must document potential penalties |
| Linked controls/policies/risks | Cross-reference IDs tracked for traceability |

---

## 4. PDPL (Saudi Personal Data Protection Law)

### 4.1 Data Inventory Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| Empty data inventory | No records in data_inventory | High | Create records for all personal data processing activities (HR, CRM, customer-facing) |
| No AI guardrails active | No active records in pdpl_ai_guardrails | Medium | Configure AI guardrails for automated processing activities |
| Open data incidents | Unresolved records in data_incidents | High (>3) / Medium | Review and resolve; ensure breach notification timelines met per PDPL |

### 4.2 Data Classification Rules
| Category | Retention Default | Encryption | Masking | Examples |
|----------|-------------------|------------|---------|----------|
| Personal (email) | 730 days (2 years) | Yes | Yes | Lead email, deal contact email |
| Personal (phone) | 730 days (2 years) | Yes | Yes | Lead phone |
| Personal (name) | 730 days (2 years) | No | No | First name, last name, contact name |
| Business | 1,095 days (3 years) | No | No | Company name, lead owner |
| System/Audit | 2,555 days (7 years) | No | No | User email in system_users, user_name in event_logs |

### 4.3 Retention Policies
| Policy | Module | Table | Retention | Expiry Action |
|--------|--------|-------|-----------|---------------|
| CRM Leads Retention | CRM | leads | 730 days | Anonymize |
| CRM Deals Retention | CRM | deals | 1,095 days | Archive |
| Audit Logs Retention | System | event_logs | 2,555 days | Archive |
| Quality Audits Retention | QMS | quality_audit_results | 1,825 days | Archive |

### 4.4 Access Control Rules
| Data Field | Allowed Roles |
|------------|---------------|
| Email (CRM) | admin, quality_manager, grc_manager |
| Phone (CRM) | admin, quality_manager |
| Names (CRM) | admin, quality_manager, grc_manager, bu_owner |
| Company (CRM) | admin, quality_manager, grc_manager, bu_owner |
| System user email | admin only |
| Audit trail user_name | admin, grc_manager |

---

## 5. KPI Engine

### 5.1 KPI Threshold Rules (RAG - Red/Amber/Green)
**Quality Manager (Sara) KPIs:**
| KPI Code | KPI Name | Green | Amber | Red | Direction | Target |
|----------|----------|-------|-------|-----|-----------|--------|
| QM-GOV-001 | Governance Coverage | >= 90% | >= 75% | >= 60% | Higher is better | 95% |
| QM-DOC-001 | Document Completion Rate | >= 95% | >= 85% | >= 70% | Higher is better | 100% |
| QM-AUD-001 | Audit Execution Rate | >= 95% | >= 80% | >= 65% | Higher is better | 100% |
| QM-AUD-002 | Audit Finding Closure Rate | >= 85% | >= 70% | >= 50% | Higher is better | 90% |
| QM-AUD-003 | Repeat Findings Reduction | >= 20% | >= 10% | >= 0% | Higher is better | 25% |
| QM-TRN-001 | Training Coverage | >= 95% | >= 85% | >= 70% | Higher is better | 100% |
| QM-CI-001 | Continuous Improvement Index | >= 10 | >= 5 | >= 2 | Higher is better | 12 |
| QM-AUTO-001 | Automation Coverage | >= 60% | >= 40% | >= 20% | Higher is better | 75% |

**GRC Manager (Maram) KPIs:**
| KPI Code | KPI Name | Green | Amber | Red | Direction | Target |
|----------|----------|-------|-------|-----|-----------|--------|
| GRC-RSK-001 | Enterprise Risk Coverage | 100% | >= 85% | >= 70% | Higher is better | 100% |
| GRC-RSK-002 | Risk Treatment Completion | >= 90% | >= 75% | >= 60% | Higher is better | 95% |
| GRC-RSK-003 | High Risk Aging | <= 30 days | <= 60 days | <= 90 days | Lower is better | 14 days |
| GRC-CMP-001 | Compliance Coverage | >= 95% | >= 80% | >= 65% | Higher is better | 100% |
| GRC-AUD-001 | Audit Readiness Score | >= 90% | >= 75% | >= 60% | Higher is better | 95% |
| GRC-VND-001 | Vendor Risk Posture | >= 85% | >= 70% | >= 50% | Higher is better | 90% |
| GRC-REG-001 | Regulatory Response Time | <= 5 days | <= 10 days | <= 15 days | Lower is better | 3 days |

**Shared KPIs:**
| KPI Code | KPI Name | Green | Amber | Red | Direction | Target |
|----------|----------|-------|-------|-----|-----------|--------|
| SHR-GOV-001 | Governance Loop Closure | >= 90% | >= 75% | >= 60% | Higher is better | 95% |
| SHR-AI-001 | AI-Enabled Resolution Index | >= 50% | >= 30% | >= 10% | Higher is better | 60% |
| SHR-INT-001 | Cross-Module Integration Score | >= 85% | >= 70% | >= 50% | Higher is better | 90% |

### 5.2 KPI Miss Detection Rule
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| KPI below target | Latest actual_value < target_value | High (>20% gap) / Medium | Investigate root cause; create corrective action if recurring |

---

## 6. Vendor Risk Module

### 6.1 Vendor Risk Rating
| Field | Rule |
|-------|------|
| `overall_risk_level` | Tracked per vendor |
| Vendor Risk Posture KPI | % of critical vendors with acceptable (low/medium) risk rating; target >= 90% |

---

## 7. Sales Governance (Zoho CRM Integration)

### 7.1 Deal Stage Rules
| Stage | Max Duration | Required Fields | Valid Next Stages |
|-------|-------------|-----------------|-------------------|
| New Deal | None | Company Name, Contact Person, No. of Employees, Region, Industry | Contacted |
| Contacted | None | First Call Activity Logged | Meeting, Not Attend Meeting |
| Not Attend Meeting | 5 business days | Not Attend Reason (from approved list of 7 reasons) | Contacted, Closed Lost |
| Meeting | 10 business days | Meeting Notes, Client Requirements | Proposal, Agreement Sent, On Hold, Closed Lost |
| Proposal | 90 days | Proposal Document Attached, Proposal Sent Date | Agreement Sent, On Hold, Closed Lost |
| On Hold | 180 days | On Hold Reason | Proposal, Agreement Sent, Closed Lost |
| Agreement Sent | 90 days | Agreement Document, Agreement Sent Date | Agreement Signed, Closed Lost |
| Agreement Signed | None | Signed Agreement, Invoice/Quotation in Zoho Books | (end state) |
| Closed Lost | None | Closed Lost Reason (from approved list of 9 reasons) | (end state) |

### 7.2 SLA Rules
| SLA | Timeframe | Description |
|-----|-----------|-------------|
| Contact After SDR Handoff | 1 business day | Time between SDR handoff and first client contact |
| Proposal Preparation | 2 business days | From meeting completion to sending first proposal |
| Proposal Validity Update | 30 days | From proposal expiry to re-issuance |
| Agreement Review & Signature | 10 business days | From client acceptance to full signature |
| Agreement Escalation Window | 5 business days | From GRC delay to escalation |
| Zoho CRM Activity Logging | Same day | Log activities same business day |
| Follow-Up Compliance | Same day | Complete follow-ups same business day |
| CS Handover Acknowledgment | 1 business day | CS acknowledgment after Agreement Signed |
| Issue Escalation Window | 4 hours | Submit escalation notice within 4 hours |

### 7.3 Sales KPIs
**Individual KPIs:**
| KPI | Target | Benchmark |
|-----|--------|-----------|
| Conversion Rate of SQL | >= 25% | B2B 20-30% |
| Proposal Cycle Time | <= 2 Days | Internal SLA |

**Process KPIs:**
| KPI | Target | Formula |
|-----|--------|---------|
| Agreement Cycle Time | <= 20 Days | Agreement Signed Date - Proposal Sent Date |
| Data Accuracy Score | >= 95% | (Compliant Deals / Sample) x 100 |
| Documents Attachment Compliance | >= 95% | (Deals with Complete Attachments / Total Closed Deals) x 100 |
| Deal Velocity Index | Upward trend quarterly | Total Closed Deals / Total Days in Cycle |
| Follow-Up Effectiveness Rate | >= 95% | (On-Time Follow-Ups / Total Follow-Ups) x 100 |

**Governance KPIs:**
| KPI | Target | Benchmark |
|-----|--------|-----------|
| SLA Adherence Rate | >= 90% | (On-Time Activities / Total Activities) x 100 |
| Audit Compliance Score | >= 85% | Best Practice >= 80% |

### 7.4 Escalation Rules
| Case | Trigger | First Layer | Second Layer |
|------|---------|-------------|--------------|
| Delay in CRM Update | CRM not updated within 24 hours | Sales TL | Sales Manager |
| Proposal Delay | Proposal not sent within 2 business days | Sales TL | Sales Manager |
| SLA Breach - Follow-up Delay | Missed follow-up > 24 hours | Sales TL | Sales Manager |
| Agreement Stuck > 2 Months | No client response for > 2 months | Sales Manager | Head of Sales |

### 7.5 Qualification Criteria
| Criterion | Rule |
|-----------|------|
| Target Market | KSA |
| Minimum Employees | 15 |
| Valid Roles | HR, Operations, Procurement |
| Seniority Levels | Manager, Director, Head |
| Exclusions | Existing active client, Blacklisted/disqualified accounts |

### 7.6 Required Documents
| Stage | Required Documents |
|-------|-------------------|
| Proposal | Commercial Offer/Quotation |
| Agreement | Service Agreement, Signed Agreement |
| Client | CR (Commercial Registration), VAT Certificate |
| Optional | NDA, Security Questionnaire |

### 7.7 Spot Check Criteria
1. Completeness of Zoho CRM fields
2. Correct stage movement
3. Document/attachment accuracy
4. Follow-up frequency

### 7.8 Root Cause Analysis Method
| Setting | Value |
|---------|-------|
| Approach | 5 Whys |
| Classification | People, Process, System, Client-Side |
| Verification Window | 3 business days |

### 7.9 Mandatory CRM Fields
| Module | Required Fields |
|--------|----------------|
| Deals | Deal_Name, Account_Name, Deal_Owner, Stage, Amount, Closing_Date, Contact_Person, No_of_Employees, Region, Industry |
| Tasks | Subject, Due_Date, Owner, Related_Deal, Status, Priority |
| Contacts | First_Name, Last_Name, Email, Phone, Account_Name, Title |

---

## 8. Duplicate Radar

### 8.1 Duplicate Detection Rules
| Rule | Detail |
|------|--------|
| Confidence levels | High, Medium, Low |
| Confidence score | 0-100 numeric score |
| Cluster grouping | By domain + company name (including Arabic) |
| Record types scanned | Leads and Deals from Zoho CRM |
| Matching fields | Email domain, company name, phone, contact name |
| Detection types | Manual, Scheduled, On-demand |
| Primary record marking | One record per cluster marked as primary (keeper) |
| AI recommendation | Each cluster gets an AI-generated recommendation |
| Pipeline inflation tracking | Estimated pipeline value inflation from duplicates |

---

## 9. Training Module

### 9.1 Training Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| Overdue training detection | Training due_date past and status not completed/cancelled | High (>5 overdue) / Medium | Follow up with assigned team members; reschedule overdue trainings |
| Training Coverage KPI | % of staff with up-to-date training | Target: 100%, Red: <70% | Ensure all staff complete assigned training |

---

## 10. Governance Documents (Policy Management)

### 10.1 Policy Hygiene Rules
| Rule | Trigger | Severity | Action |
|------|---------|----------|--------|
| Expiring document | review_date within 30 days and not archived/superseded | Medium | Schedule document review cycle |
| Expired document | review_date has passed and not archived/superseded | High | Immediate review; update content; get re-approval from document owner |

---

## 11. AI Background Scanner (Cross-Module)

The platform runs **9 automated hygiene scans** across all modules:

| # | Scan Name | Module | What It Checks |
|---|-----------|--------|----------------|
| 1 | checkOpenNCsWithoutCAPA | QMS | NCs open > 7 days without a linked CAPA |
| 2 | checkHighRisks | Risk | Risks with score >= 15 that are not closed/mitigated |
| 3 | checkOverdueTreatments | Risk | Treatment actions past their due date |
| 4 | checkLowProgressTreatments | Risk | Treatments < 30% progress due within 14 days |
| 5 | checkMissedKPIs | KPIs | KPIs where actual value is below target |
| 6 | checkExpiringPolicies | Governance | Documents with review_date within 30 days or expired |
| 7 | checkPDPLGaps | PDPL | Empty data inventory, no AI guardrails, open data incidents |
| 8 | checkAuditScoreDecline | Quality | 3+ consecutive declining audit scores with >5% total drop |
| 9 | checkTrainingGaps | Training | Training assignments past their due date |

Each scan creates AI alerts with severity levels (critical/high/medium) and actionable suggestions. Alerts are deduplicated to avoid repeated notifications for the same issue.

---

*Document generated from WalaPlus Platform codebase — April 2026*
*Reference: governanceRules.ts, evaluationSchema.ts, aiBackgroundScanner.ts, kpiDatabase.ts, riskDatabase.ts, pdplDatabase.ts, checklistDatabase.ts, duplicateRadarDatabase.ts*
