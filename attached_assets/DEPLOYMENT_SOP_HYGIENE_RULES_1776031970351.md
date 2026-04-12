# WalaPlus QMS Platform — SOP Hygiene Rules & 100K+ Scale Deployment

## Summary of Changes

This update implements **comprehensive CRM hygiene rules** aligned with the Sales SOP (v1.1) and SDR SOP (v2.1), adds **20 Account hygiene rules**, enables **automated SLA enforcement**, adds **11 SDR KPIs**, and upgrades the audit engine to handle **100K+ records** with batch processing.

---

## Modified Files (7 files)

### 1. `src/utils/zohoCRM.ts` — Core Governance Engine
**Changes:**
- **`GovernanceRule` interface** — Added 4 new optional fields:
  - `stageCondition: string[]` — Only apply the rule when record is in one of these stages
  - `stageField: string` — Which field to check for stage (defaults to `Stage`, can be `Lead_Status`)
  - `sourceCondition: string[]` — Only apply when source matches (e.g., `Outbound`, `Cold Call`)
  - `sourceField: string` — Which field to check for source (defaults to `Lead_Source`)
- **`analyzeRecordHygiene()` function** — Now evaluates `stageCondition` and `sourceCondition` before applying rules. Skips the rule if conditions don't match.
- **`DEFAULT_GOVERNANCE_RULES` array** — Expanded from 14 rules to **~65 rules**:

  **Deals (Sales SOP):**
  - Always required: `Deal_Name`, `Stage`, `Amount`, `Closing_Date`, `Account_Name`, `Contact_Name`, `Pipeline`, `Lead_Source`
  - Stage enum validation (7 valid stages)
  - **Proposal stage conditional:** `Probability` (1-100%), `Bundle_Type`, `Discount%` (0-100%)
  - **On Hold stage conditional:** `On_Hold_Reason` (required + 7 valid enum values)
  - **Agreement Signed conditional:** `Onboarding_Method` (3 enum values), `Contract_No_of_Employees`, `Trial_Period`, `Trial_Period_Days` (if Trial=Yes), `National_Address`

  **Leads (SDR SOP):**
  - Always required: `Email`, `Phone`, `Lead_Source`, `Lead_Status`, `Company`, `First_Name`, `Last_Name`, `Designation`, `City`, `No_of_Employees`, `Industry`
  - Email format + business email validation (flags free providers)
  - Phone format: KSA country code `+966` required
  - `Lead_Source` enum (11 values), `Lead_Status` enum (9 values)
  - **Outbound conditional (from Contacting stage):** `Outgoing_Call_Result` (required + 6 enum values), `Not_Qualified_Reason` (when disqualified)
  - **All-source from Contacting stage:** `Tag`, `Description`/Notes

  **Contacts:** `Email`, `Last_Name`, `Phone`, `Account_Name`, `Title`

  **Tasks:** `Subject`, `Due_Date`, `Status`

  **Accounts (20 new rules):**
  - Required: `Account_Name`, `Account_Type`, `Industry`, `Phone`, `Website`, `Billing_City`, `Billing_Country`, `Employees`, `Annual_Revenue`, `Account_Number`, `Rating`, `SIC_Code`, `Ownership`, `Description`, `Billing_Street`
  - `Account_Type` enum (7 values)
  - Generic name detection (test, sample, N/A, etc.)
  - Phone country code format
  - Business email validation (no free providers)
  - `Shipping_City` required for Customer accounts

### 2. `src/utils/governanceRules.ts` — SDR Governance Configuration
**Changes:**
- Added `walaPlusSDRGovernanceRules` export with complete SDR SOP configuration:
  - 9 lead stage definitions with `maxDuration`, `requiredFields`, `validReasons`, `qualificationCriteria`
  - 7 SDR SLAs (Initial Contact 2h, Outbound First Call 4h, Follow-Up 24h, Qualification Decision 3 days, Handoff 1 day, CRM Update same-day, Duplicate Check immediate)
  - 11 SDR KPIs (6 individual + 5 process) with targets, formulas, and calculations
  - Qualification criteria (KSA market, 15+ employees, valid roles)
  - 4 escalation rules

### 3. `src/utils/aiBackgroundScanner.ts` — SLA Enforcement Checks
**Changes:**
- Added `checkSalesSLAViolations()` — Scans up to 500 deals for:
  - **PR2:** First Contact SLA (>1 business day after deal creation)
  - **PR3:** Proposal Cycle Time (>2 business days after meeting)
  - **G4:** Agreement Review (>10 business days in Agreement Sent stage)
  - **G1:** Same-day CRM Update (deals not modified in >2 business days while in active stages)
  - **Stage max duration:** Meeting ≤10d, Proposal ≤90d, Agreement Sent ≤90d, On Hold ≤180d, Not Attend Meeting ≤5d

- Added `checkSDRSLAViolations()` — Scans up to 500 leads for:
  - **Initial Contact SLA:** Inbound ≤2h, Outbound ≤4h (alerts after 3x threshold)
  - **Qualification Decision SLA:** ≤3 business days from first contact
  - **Lead stage aging:** Contacting ≤5d, Contacted ≤3d, On Hold ≤90d, Nurturing ≤180d

- Both functions integrated into `runBackgroundScan()` (runs every 6 hours via cron)

### 4. `src/utils/aiAlertsDatabase.ts` — New Alert Type
**Changes:**
- Added `'sla_breach'` to the `AlertType` union type for SLA violation alerts

### 5. `src/utils/directAuditRunner.ts` — 100K+ Scale Audit Engine
**Changes:**
- **Pagination:** Changed from `fetchZohoRecords(module, { perPage: 100 })` to `fetchAllZohoRecords(module, { maxRecords: 50000 })` — fetches all records with built-in pagination (200/page)
- **Batch processing:** Records analyzed in batches of 500 to avoid memory pressure (`BATCH_SIZE = 500`)
- **Accounts module added:** Modules list expanded from `["Leads", "Deals", "Contacts", "Tasks"]` to `["Leads", "Deals", "Contacts", "Tasks", "Accounts"]`
- **Memory-efficient issue counting:** Instead of storing all issues in memory, counts are aggregated per-batch via `analyzeRecordBatch()` helper
- **Progress logging:** Logs progress every 5,000 records for large datasets
- Added `buildIssueSummary()` helper to reconstruct issue distribution for `calculateQualityScores()`

### 6. `src/utils/kpiDatabase.ts` — SDR KPI Definitions
**Changes:**
- Added `seedSDRKPIs()` function with 11 KPI definitions:
  - SDR-KPI-01: Calls Per Day (target: 40)
  - SDR-KPI-02: Contact Rate (target: 30%)
  - SDR-KPI-03: Qualification Rate (target: 25%)
  - SDR-KPI-04: Meetings Booked Per Week (target: 5)
  - SDR-KPI-05: Show Rate (target: 80%)
  - SDR-KPI-06: Average Speed to Lead (target: 2 hours)
  - SDR-KPI-07: Lead-to-Qualified Conversion (target: 20%)
  - SDR-KPI-08: CRM Data Accuracy Score - SDR (target: 95%)
  - SDR-KPI-09: Duplicate Rate (target: ≤2%)
  - SDR-KPI-10: Pipeline Aging (target: 5 days avg)
  - SDR-KPI-11: Follow-Up Compliance - SDR (target: 95%)
- Each KPI includes thresholds (green/amber/red), direction, and navigation maps
- Added `seedSDRKPIsManual()` export for manual seeding endpoint
- Updated `initKPITables()` to call `seedSDRKPIs()` on startup
- Updated `owner_type` CHECK constraint to include `sdr_team` and `sales_team`

### 7. `src/mastra/routes/kpiRoutes.ts` — SDR KPI API Endpoint
**Changes:**
- Imported `seedSDRKPIsManual`
- Added `POST /api/kpis/seed-sdr` endpoint for manual SDR KPI seeding

---

## Deployment Steps

### Step 1: Copy Modified Files to Replit
Copy these 7 files to the Replit project, replacing existing versions:
1. `src/utils/zohoCRM.ts`
2. `src/utils/governanceRules.ts`
3. `src/utils/aiBackgroundScanner.ts`
4. `src/utils/aiAlertsDatabase.ts`
5. `src/utils/directAuditRunner.ts`
6. `src/utils/kpiDatabase.ts`
7. `src/mastra/routes/kpiRoutes.ts`

### Step 2: Restart the Server
The server will automatically:
- Update the `kpi_definitions` table `owner_type` constraint
- Seed the 11 SDR KPIs (if not already present)
- Apply new governance rules on next audit run

### Step 3: Verify
1. **Trigger an audit:** Click "Run AI Audit" — it should now audit Accounts module and use paginated fetching
2. **Check KPIs:** Go to `/kpis` and verify SDR Team KPIs appear
3. **Check scanner:** Wait for next background scan (or trigger manually) and verify SLA breach alerts appear for any non-compliant deals/leads
4. **Test conditional rules:** Create a test deal in "Proposal" stage without Probability — it should flag as an issue

### Step 4: Optional — Seed SDR KPIs Manually
```bash
curl -X POST https://your-replit-url/api/kpis/seed-sdr
```

---

## Architecture Impact

| Aspect | Before | After |
|--------|--------|-------|
| Governance rules | 14 basic rules | ~65 rules with stage/source conditions |
| Modules audited | Leads, Deals, Contacts, Tasks | + Accounts (5 modules) |
| Records per audit | 100 per module (max 400) | 50,000 per module with pagination |
| Batch processing | None (all in memory) | 500-record batches |
| SLA enforcement | None (scorecard only) | Automated scanner (6-hourly) |
| Lead pipeline audit | Basic 5 fields | Full SDR SOP coverage (20+ rules) |
| Account audit | None | 20 hygiene rules |
| SDR KPIs | None | 11 KPIs with thresholds |
| Alert types | 10 types | + `sla_breach` (11 types) |
