# Internal Audits — Unified Feature Specification
**Version:** 1.0 · **Effective:** 18 April 2026 · **Status:** Live

> **One destination for every internal audit activity at WalaPlus** — combining ISO-style internal audits, findings, evidence, AI-powered Quality Audits, CAPA, and nonconformance management.

---

## 1 · Why this merge happened

Before this release the platform had **two parallel audit experiences**:

| Old surface | URL | What it covered |
|---|---|---|
| ISO Internal Audits → "Audit Readiness Center" | `/audits` | Audit schedule, findings, evidence packs |
| Quality Audits (AI) → "Quality Management System" | `/qms` | AI-driven evaluations, CAPA, NCs, training, framework |

This caused three problems:

1. **Auditors didn't know where to go.** A finding raised in an AI quality audit had no obvious path to becoming an ISO audit finding.
2. **Two metrics dashboards** tracked overlapping work — leading to confusion about "the real" audit numbers.
3. **Navigation was cluttered** with two near-identical entries, both branded "Audit".

The merge consolidates everything under a single **Internal Audits** entry in the sidebar, with two clear sub-tabs.

---

## 2 · What's there now

### 2.1 — URL & navigation

| Aspect | Value |
|---|---|
| Primary URL | `/audits` |
| Direct deep-link to AI tab | `/audits?tab=quality` |
| Old `/qms` URL | Still works — used internally as the embedded source for the Quality tab |
| Sidebar label | **Internal Audits** (single entry, replaces two old entries) |
| Page title | "WalaPlus — Internal Audits" |
| H1 on page | "Internal Audits" |

### 2.2 — Page anatomy

```
┌─────────────────────────────────────────────────────────────┐
│  Internal Audits                                            │
│  ISO audit readiness, findings, evidence packs, and         │
│  AI-powered Quality Audits in one place                     │
│                                  [+ Finding]  [+ New Audit] │
├─────────────────────────────────────────────────────────────┤
│  [ ISO Audits ]  [ Quality Audits  AI ]   ← sub-tab strip   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ACTIVE PANEL CONTENT                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 — Tab 1: **ISO Audits** (default)

This is the original Audit Readiness Center surface, unchanged in functionality:

- **6 KPI tiles**: Total Audits · Planned · In Progress · Closed · Open Findings · Overdue Findings
- **Audit Schedule table** with status filter (Planned / In Progress / Fieldwork Complete / Report Draft / Closed)
- **Findings by Severity** panel
- **Upcoming Audits** sidebar
- **Action buttons** in header: `+ Finding`, `+ New Audit`
- Per-row XLSX and PDF evidence-pack download links

**Backed by:** `audits`, `audit_findings`, `evidence_packs`, `evidence_records` tables · `/api/audits/*` endpoints

### 2.4 — Tab 2: **Quality Audits (AI)**

Embeds the full QMS dashboard via a same-origin iframe (`/qms?embed=1`). Embed mode hides the global navigation chrome so it visually integrates with the parent page.

The Quality tab itself contains its own tab strip:

| QMS tab | Purpose |
|---|---|
| **Overview** | Evaluations (30d), Open CAPA, Open NC, Training Completion, Audit KPI Score, First Pass Yield, CAPA Effectiveness |
| **Deal Evaluations** | AI-graded sales call/deal evaluations against scorecard |
| **CAPA** | Corrective & Preventive Actions register |
| **Nonconformances** | NC log with severity, source, status |
| **Training** | Training matrix and completion tracking |
| **Framework** | ISO 9001 / COPC framework mapping |
| **Triggers** | Automated rules that raise NCs/CAPAs |

**Backed by:** `quality_audit_results`, `capa_records`, `non_conformances`, `team_performance_metrics`, `kpi_definitions` tables · `/api/qms/*` and `/api/audit/*` endpoints

### 2.5 — Tab behavior details

| Behavior | Implementation |
|---|---|
| **Default tab** | ISO Audits |
| **URL deep-link** | `?tab=quality` opens directly on Quality tab |
| **Tab persistence** | Switching updates the URL via `history.replaceState` (no reload) |
| **Lazy load** | Quality iframe `src` is set only when the tab is first opened — saves a full QMS page load on default visits |
| **Action bar visibility** | `+ Finding` / `+ New Audit` buttons hide on Quality tab (Quality has its own actions inside the iframe) |
| **Accessibility** | Tabs use `role="tablist"`, `role="tab"`, `aria-selected`, panels use `role="tabpanel"` |
| **Test IDs** | `tab-iso-audits`, `tab-quality-audits`, `iframe-quality-audits`, `text-page-title` |

---

## 3 · Data model touchpoints

| Concept | Lives in | Surfaced on tab |
|---|---|---|
| Planned/In-progress/Closed audits | `audits` | ISO Audits |
| ISO findings | `audit_findings` | ISO Audits |
| Evidence files (PDF/XLSX) | `evidence_packs`, `evidence_records` | ISO Audits |
| AI quality audit runs (180k+ records) | `quality_audit_results` | Quality Audits → Overview |
| Deal-level evaluations | `qms_deal_evaluations` | Quality Audits → Deal Evaluations |
| CAPA records | `capa_records`, `capa_action_items`, `capa_change_history` | Quality Audits → CAPA |
| Nonconformances | `non_conformances`, `nonconformance_records`, `nc_change_history` | Quality Audits → Nonconformances |
| Audit KPIs | `kpi_definitions` (filter: ISO 9001) | Both tabs |

---

## 4 · API surface (no breaking changes)

All endpoints kept their original paths — the merge is purely a UI consolidation:

| Endpoint | Purpose |
|---|---|
| `GET /api/audits` | List ISO audits |
| `GET /api/audits/summary` | KPI tile counts |
| `GET /api/audits/:id` | Single audit detail |
| `GET /api/audits/evidence-packs?auditId=...` | Evidence pack listing |
| `GET /api/audit/latest` | Latest AI quality audit run |
| `GET /api/audit/history?limit=N` | History of AI audit runs |
| `GET /api/audit/recommendations` | AI-generated recommendations |
| `GET /api/qms/dashboard` | QMS overview data |
| `GET /api/qms/evaluations` | Deal evaluations list |
| `GET /api/qms/evaluations/stats` | Evaluation rollups |
| `GET /api/qms/capa` / `POST /api/qms/capa` | CAPA list / create |
| `GET /api/qms/capa/:id` | Single CAPA + action items |
| `GET /api/qms/capa/export` | CAPA Excel export |

---

## 5 · User journeys after the merge

### 5.1 — ISO auditor preparing for a surveillance audit
1. Click **Internal Audits** in the sidebar
2. ISO Audits tab is open by default — see schedule, planned vs overdue
3. Click `+ New Audit` to add the upcoming surveillance entry
4. Add findings as they are identified, attach evidence packs
5. Generate XLSX/PDF for external auditor
6. **Same destination, one click** to switch to Quality Audits to cross-reference recent NCs

### 5.2 — Quality manager reviewing AI audit findings
1. Click **Internal Audits**
2. Click **Quality Audits (AI)** sub-tab — single click, no page navigation
3. See Overview KPIs (evaluations 30d, open CAPA, open NC, training)
4. Drill into CAPA tab → review open actions
5. Drill into Nonconformances → review and update status
6. Click **ISO Audits** to log a parallel ISO finding if needed

### 5.3 — Executive reviewing audit posture (deep-link from email)
1. Click `https://qms-dashboard.replit.app/audits?tab=quality` in an email
2. Lands directly on the Quality Audits Overview
3. Sees the AI Audit KPI Score against 95% target
4. Closes browser — URL state preserved if they bookmark

---

## 6 · Acceptance criteria (Gherkin)

```gherkin
Scenario: Default landing on ISO Audits tab
  Given I am authenticated
  When I navigate to /audits
  Then the page H1 is "Internal Audits"
  And the "ISO Audits" tab is selected
  And the original Audit Readiness Center content is visible
  And the "+ Finding" and "+ New Audit" buttons are visible

Scenario: Switching to Quality Audits tab
  Given I am on /audits with ISO Audits tab active
  When I click the "Quality Audits" tab
  Then the QMS dashboard loads inside an iframe
  And the global navigation does NOT appear inside the iframe
  And the URL updates to /audits?tab=quality
  And the "+ Finding" and "+ New Audit" buttons are hidden

Scenario: Deep-link directly to Quality tab
  Given I am authenticated
  When I navigate to /audits?tab=quality
  Then the "Quality Audits" tab is selected immediately
  And the QMS iframe begins loading

Scenario: Lazy-load saves a request
  Given I navigate to /audits and stay on ISO Audits
  Then the QMS iframe src is "about:blank"
  And no /qms request is made

Scenario: Sidebar shows single entry
  When I open the navigation menu
  Then I see exactly one "Internal Audits" entry
  And I do NOT see a separate "Quality Audits (AI)" entry
```

---

## 7 · Files changed in this release

| File | Change |
|---|---|
| `dashboard/audits.html` | Title + H1 → "Internal Audits"; added tab strip; wrapped existing content in `#panel-iso`; added `#panel-quality` with iframe; added `setupInternalAuditsTabs` script |
| `dashboard/qms.html` | Embed-mode detection (`?embed=1` hides nav, transparent body) |
| `dashboard/js/navigation.js` | Removed standalone "Quality Audits (AI)" entry; renamed "ISO Internal Audits" → "Internal Audits" |

**Lines of code:** ~85 net additions · **Breaking changes:** none · **Backend changes:** none

---

## 8 · Enhancement roadmap (post-merge ideas)

Sorted by effort × impact. Pick whatever your manager wants to pursue.

### 8.1 — Cross-tab linking (high-impact, low-effort)
- From an ISO finding, add a "Link to NC/CAPA" button that opens the relevant Quality tab item
- From a Quality NC marked "ISO-relevant", surface a "Promote to ISO Finding" action
- **Why:** Removes the manual copy-paste between the two registers

### 8.2 — Unified audit timeline (medium effort)
- New tab "Timeline" that merges ISO audits + AI audit runs + NCs + CAPAs into one chronological view
- Filter by date range, audit type, status
- **Why:** Gives auditors a single narrative for evidence requests

### 8.3 — Single overview tile strip on top (low effort)
- Add a thin metrics row above the tabs showing key numbers from BOTH worlds: Total Audits · Open Findings · Open CAPA · Open NC · Audit KPI Score
- **Why:** Manager sees posture without switching tabs

### 8.4 — Evidence pack auto-link (medium effort)
- When an AI quality audit flags a high-severity issue, auto-attach the evidence (call recording, deal record snapshot) to the next planned ISO audit's evidence pack
- **Why:** Closes the AI → audit evidence loop automatically

### 8.5 — Trigger ISO audit from AI alert (medium-high effort)
- When AI Quality Audit detects ≥ N high-severity issues in a quarter, auto-suggest an ad-hoc ISO audit
- **Why:** Risk-based audit planning per ISO 9001 §9.2.2

### 8.6 — Single export pack (low effort)
- "Download Audit Pack" button that bundles: ISO audits + findings + evidence + AI audit recommendations into one ZIP
- **Why:** External auditor handover in one click

### 8.7 — Replace iframe with native merge (high effort)
- Currently Quality Audits is embedded via iframe — works perfectly but is a layout boundary
- Eventually rewrite QMS sub-tabs as native sections inside the same page for a more seamless UX
- **Why:** Removes scrollbar quirks, allows shared header/filter state

### 8.8 — Role-aware default tab (low effort)
- ISO auditor role → land on ISO tab
- Sales/Quality manager role → land on Quality tab
- Reuses existing role-based landing infrastructure
- **Why:** Each persona sees their primary view first

### 8.9 — Cross-tab search (medium effort)
- Single search bar above the tabs that finds findings, NCs, CAPAs, audits across both worlds
- **Why:** "Where did I log that nonconformance about supplier X?" — answered in one box

### 8.10 — In-page AI consultant for audits (medium effort)
- Floating "Ask AI Auditor" button that knows context of the current tab/audit
- "Suggest findings for this audit", "Draft a CAPA for this NC", "What ISO clause applies?"
- **Why:** Turns this page into the place auditors actually do their thinking

---

## 9 · Risks & known limitations

| Risk | Severity | Mitigation |
|---|---|---|
| Iframe adds a small layout boundary (no shared scroll) | Low | Acceptable for now; eventually replaced by 8.7 |
| Two action button sets (parent header + iframe internal) could confuse | Low | Action bar hides on Quality tab; iframe has its own |
| Old links to `/qms` still work but skip the new tab framing | Low — by design | Old links still resolve correctly to the standalone QMS view |
| Browser back button between tabs uses history.replaceState, not pushState | Low | Intentional — tabs aren't "navigations", they're view toggles |

---

## 10 · How to validate (manual smoke test)

1. Sign in to the platform
2. Click sidebar → confirm a single **Internal Audits** entry
3. Land on `/audits` → confirm H1 = "Internal Audits", default tab = ISO Audits, KPI tiles & schedule visible
4. Click **Quality Audits** tab → confirm QMS dashboard loads inside the page (no global nav inside the embed)
5. Confirm URL changed to `/audits?tab=quality`
6. Click **ISO Audits** tab → confirm action bar (`+ Finding`, `+ New Audit`) reappears, URL drops the `?tab=quality`
7. Open `/audits?tab=quality` in a fresh tab → confirm Quality tab opens directly
8. Open `/qms` directly → confirm it still works as a standalone page (back-compat)

**Automated coverage:** existing `scripts/run-platform-tests.sh` continues to pass 66/66 — no contracts broken.

---

*This document is the source of truth for the Internal Audits feature. Update as enhancements ship.*
