# GRC Maturity Enhancement — Deployment Instructions

## Summary
This deployment adds 6 new features to mature the platform for GRC & Quality departments:
1. **Management Review Module** (ISO 9001 §9.3)
2. **Analytics Engine** (Cycle Times, Per-Agent Reports, CAPA Recurrence, Trends)
3. **Executive Quality Digest** (Weekly Email)
4. **Auto-NC from Critical SLA Breaches** (AI Scanner Check #13)
5. **CAPA Recurrence Detection** (AI Scanner Check #14)
6. **Management Review Dashboard Page** (`/reviews`)

---

## New Files (5)

### Backend Utilities
1. `src/utils/managementReviewDatabase.ts` — Management review DB (tables, CRUD, auto-gather inputs)
2. `src/utils/analyticsEngine.ts` — Cycle times, agent compliance, CAPA recurrence, trend data
3. `src/utils/executiveDigest.ts` — Weekly executive digest data + HTML generation + email send

### API Routes
4. `src/mastra/routes/managementReviewRoutes.ts` — 9 endpoints for management reviews + actions
5. `src/mastra/routes/analyticsRoutes.ts` — 6 endpoints for analytics + digest

### Dashboard
6. `dashboard/reviews.html` — Management Review dashboard page

---

## Modified Files (4)

### 1. `src/mastra/index.ts`
- Import and register `managementReviewRoutes` and `analyticsRoutes`
- Add `/reviews` page serving route

### 2. `src/utils/aiBackgroundScanner.ts`
- Added `autoCreateNCsFromCriticalSLABreaches()` — Check #13: auto-creates NC records from critical SLA breach alerts
- Added `checkCAPARecurrence()` — Check #14: detects recurring root causes across CAPAs (90-day window)
- Updated `runBackgroundScan()` to call both new checks (total: 14 checks)

### 3. `src/mastra/inngest/index.ts`
- Added `executiveDigestFunction` Inngest cron job (Monday 7 AM, configurable via `DIGEST_CRON`)
- Sends digest email via Resend/Replit Mail, creates notification on success

### 4. `dashboard/js/navigation.js`
- Added "Mgmt Review" nav item under GRC group (href: `/reviews`)

---

## Environment Variables (Optional)
| Variable | Purpose | Default |
|----------|---------|---------|
| `DIGEST_CRON` | Executive digest cron schedule | `0 7 * * 1` (Mon 7 AM) |
| `QUALITY_DIGEST_EMAIL` | Digest recipient email | Falls back to `ADMIN_EMAIL` |

---

## New Database Tables (Auto-created)
- `management_reviews` — Review records with review_number, attendees, agenda, minutes, decisions, inputs
- `management_review_actions` — Action items linked to reviews with assignee, due date, status, priority

---

## API Endpoints Added

### Management Reviews
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/management-reviews` | List reviews (status/year filter) |
| GET | `/api/management-reviews/:id` | Review detail with actions |
| POST | `/api/management-reviews` | Create review |
| PUT | `/api/management-reviews/:id` | Update review |
| DELETE | `/api/management-reviews/:id` | Delete review |
| POST | `/api/management-reviews/:id/actions` | Add action item |
| PUT | `/api/management-reviews/actions/:actionId` | Update action |
| GET | `/api/management-reviews/actions/summary` | Action stats |
| POST | `/api/management-reviews/:id/gather-inputs` | Auto-gather QMS data |

### Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/cycle-times` | Process cycle time metrics |
| GET | `/api/analytics/agent-compliance` | Per-agent compliance reports |
| GET | `/api/analytics/capa-recurrence` | CAPA recurrence detection |
| GET | `/api/analytics/trends` | NC/CAPA/Audit/Risk trends |
| GET | `/api/analytics/executive-digest` | Digest preview (JSON or HTML) |
| POST | `/api/analytics/executive-digest/send` | Send digest email |

---

## Deployment Steps

1. Copy the 5 new files to Replit
2. Apply the 4 file modifications
3. Restart the server
4. Verify:
   - `/reviews` page loads
   - `GET /api/management-reviews` returns `{ reviews: [], total: 0 }`
   - `GET /api/analytics/cycle-times` returns metrics object
   - `GET /api/analytics/agent-compliance` returns `{ reports: [] }`
   - `GET /api/analytics/executive-digest` returns digest data
   - Create a management review and verify it appears
   - Click "Gather Data" and verify inputs are populated

---

## Verification Checklist
- [ ] `/reviews` page loads with Management Review UI
- [ ] Navigation shows "Mgmt Review" under GRC group
- [ ] Can create, edit, delete management reviews
- [ ] "Gather Data" button populates review inputs from live QMS data
- [ ] Action items can be added and completed
- [ ] `/api/analytics/cycle-times` returns NC/CAPA cycle time data
- [ ] `/api/analytics/agent-compliance` returns per-agent reports
- [ ] `/api/analytics/capa-recurrence` detects recurring root causes
- [ ] `/api/analytics/trends` returns trend data
- [ ] `/api/analytics/executive-digest?format=html` shows formatted digest
- [ ] AI Scanner now runs 14 checks (verify in console logs)
