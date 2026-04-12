# WalaPlus QMS Platform — Frontend & Automation Enhancement Deployment

## Summary

15 enhancements across 14 files (2 new, 12 modified) implementing the remaining items from the Platform Enhancement Roadmap.

---

## NEW FILES (2)

### 1. `src/utils/reportGenerator.ts`
PDF-ready HTML report generator with 3 exports:
- `generateCapaEffectivenessReport()` — CAPA effectiveness review summary
- `generateCompliancePostureReport()` — Regulatory compliance posture
- `generatePDPLInventoryReport()` — PDPL data inventory & incidents

### 2. `src/mastra/routes/reportRoutes.ts`
3 GET endpoints returning printable HTML:
- `GET /api/reports/capa-effectiveness`
- `GET /api/reports/compliance-posture`
- `GET /api/reports/pdpl-inventory`

---

## MODIFIED FILES (12)

### 3. `src/mastra/index.ts`
**Change:** Add import and registration for `reportRoutes`.
```
import { reportRoutes } from "./routes/reportRoutes";
```
And add `...reportRoutes` to the `apiRoutes` array.

### 4. `src/mastra/routes/qmsEnhancedRoutes.ts`
**Change:** In the `/api/qms/capa/:id/effectiveness` POST handler, added auto re-CAPA creation when `body.result === 'not_effective'`. The handler now:
- Imports `createCapaRecord` alongside `recordCAPAEffectiveness`
- Creates a new CAPA with title `Re-CAPA: {original title} (effectiveness failed)`
- Logs the event and sends a notification to quality_manager
- Returns `reCapaId` in the response

### 5. `src/utils/aiBackgroundScanner.ts`
**Change:** Added `checkLowProgressTreatments()` function that flags risk treatment actions with `<50% progress` and `due within 14 days`. Added to the `runBackgroundScan()` execution chain.

### 6. `dashboard/qms.html`
Major UI enhancements:
- **Checkbox columns** on both CAPA and NC tables with select-all
- **Bulk action toolbars** for batch status changes
- **Export CSV buttons** on both CAPA and NC sections
- **Clickable rows** opening a detail modal
- **Detail modal** with:
  - Full record information
  - Approval buttons (Approve Closure) for eligible records
  - CAPA Effectiveness form (result dropdown + evidence + reviewer)
  - Evidence management (attach/remove)
  - Change history timeline
- **15 new JS functions**: `showCapaDetail`, `renderCapaDetail`, `showNcDetail`, `renderNcDetail`, `closeDetailModal`, `approveCapaClosure`, `approveNcClosure`, `recordCapaEffectiveness`, `addEvidence`, `deleteEvidence`, `exportCSV`, `toggleAllCheckboxes`, `updateBulkToolbar`, `bulkUpdateRecords`

### 7. `dashboard/js/navigation.js`
- **Notification bell** replaced simple link with dropdown panel showing latest 10 notifications
- Badge now combines AI alerts + notification counts
- `timeAgo()` helper for relative timestamps
- `markRead()` for dismissing notifications from dropdown
- `loadNotifications()` polls every 60s

### 8. `dashboard/executive.html`
- **Quality Health Index widget** with circular SVG gauge + dimension progress bars
- `loadHealthIndex()` function calling `GET /api/health-index`
- Auto-loads on page init

### 9. `dashboard/compliance.html`
- **Export CSV** button in header
- **Status and priority filters** for obligations register
- `exportPageCSV('compliance')` function

### 10. `dashboard/pdpl.html`
- **Export CSV** button in header
- `exportPageCSV('pdpl')` function

### 11. `dashboard/kpis.html`
- **Export CSV** button in header
- **Status filter** dropdown (Green/Amber/Red)
- **Auto-calculation timestamp** display
- `exportPageCSV('kpis')` and `updateAutoCalcTimestamp()` functions

### 12. `dashboard/vendors.html`
- **Export CSV** button in header
- `exportPageCSV('vendors')` function

### 13. `dashboard/risks.html`
- **Date range filters** (From/To) in register toolbar
- **Treatment progress bar** with percentage in risk detail modal
- **Milestone sub-tasks** checklist rendering in treatment actions

---

## DEPLOYMENT STEPS

1. Create the 2 new files on Replit
2. Replace/update the 12 modified files
3. The server will auto-restart and all features will be live

No new dependencies or database migrations required.

---

## FEATURE VERIFICATION

After deployment, verify:

| # | Feature | How to Test |
|---|---------|-------------|
| 1 | NC/CAPA Detail | Click any row in NC or CAPA tab → modal opens |
| 2 | Approval | Set a CAPA to "verification" status, click row → "Approve Closure" appears |
| 3 | Effectiveness | Close a CAPA, click it → "Record Effectiveness" form appears |
| 4 | Auto Re-CAPA | Record effectiveness as "Not Effective" → new CAPA auto-created |
| 5 | Change History | Modify any NC/CAPA → timeline shows in detail modal |
| 6 | Evidence | In detail modal, attach a filename → appears in evidence list |
| 7 | Bulk Ops | Check multiple NC/CAPA boxes → bulk toolbar appears |
| 8 | CSV Export | Click Export CSV on any page → downloads .csv file |
| 9 | Notifications | Bell icon in nav → dropdown shows latest notifications |
| 10 | Health Index | Executive Dashboard → Quality Health Index widget with gauge |
| 11 | Risk Progress | View risk detail → treatment actions show progress bars |
| 12 | Filters | Risks/Compliance/KPIs → date range and status filters work |
| 13 | KPI Timestamp | KPIs page → shows auto-calculation schedule |
| 14 | PDF Reports | Visit `/api/reports/capa-effectiveness` → printable HTML report |
| 15 | Scanner Alert | Risk treatments <50% within 2 weeks → AI alert generated |
