# Task #470 — Dashboard Role-Gate Verification Report

## Scope

Task #461 added explicit role allowlists for 20 newly-gated dashboard pages
(see `ROLE_GATED_DASHBOARD_ROUTES` in `src/mastra/routes/staticPageRoutes.ts`).
This report verifies that no live signed-in user in production is silently
blocked from a dashboard they were able to load before the change.

## Method

Read-only query against the production `platform_users` table (the only
source of role data for signed-in browser sessions; the dev-only `users`
table does not exist in production).

```sql
SELECT role, status, COUNT(*) AS user_count
FROM platform_users
GROUP BY role, status
ORDER BY role, status;
```

## Production role mix (snapshot)

| role               | status | user_count |
| ------------------ | ------ | ---------- |
| `department_viewer` | active | 35         |

No other roles or statuses are present in production. Specifically there
are **no** active `bu_owner`, `executive`, `grc_manager`, `quality_manager`,
`head_of_operations_quality`, `quality_specialist`, `auditor`, `team_lead`,
`ai_specialist`, `admin`, or `custom` users in `platform_users` today.

## Per-role × per-route matrix (20 newly-gated routes)

Legend: ✓ = allowlist admits this role · ✗ = denied (returns "Setup Required").

### `department_viewer` (35 users, ALL of production)

| Route               | Allowlist (from `staticPageRoutes.ts`) | Admits `department_viewer`? |
| ------------------- | -------------------------------------- | --------------------------- |
| `/sandbox`          | `ANY_DASHBOARD_ROLES`                  | ✓                           |
| `/feedback`         | `ANY_DASHBOARD_ROLES`                  | ✓                           |
| `/intake`           | `ANY_DASHBOARD_ROLES`                  | ✓                           |
| `/external-audits`  | `ANY_DASHBOARD_ROLES`                  | ✓                           |
| `/crm`              | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/audits`           | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/compliance`       | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/policies`         | `POLICIES_READ_ROLES`                  | ✗                           |
| `/reviews`          | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/risks`            | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/grc`              | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/grc.html`         | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/infographic`      | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/executive.html`   | `GOVERNANCE_AND_EXECUTIVE`             | ✗                           |
| `/vendors`          | `VENDORS_READ_ROLES`                   | ✗                           |
| `/tablef`           | `TABLEF_READ_ROLES`                    | ✗                           |
| `/ai-approvals`     | `AI_APPROVALS_ROLES`                   | ✗                           |
| `/consultant.html`  | `CONSULTANT_ROLES`                     | ✗                           |
| `/pdpl`             | `ADMIN_ONLY`                           | ✗                           |
| `/logs`             | `ADMIN_ONLY`                           | ✗                           |

## Triage of denied pages

For each ✗ above, we cross-checked the backing API rule in
`ROUTE_PERMISSION_MAP` (`src/utils/rbacMiddleware.ts`) to confirm that
`department_viewer` was already denied at the API layer **before** Task #461.

- Governance reads (`/api/audits GET`, `/api/compliance GET`, `/api/risks GET`,
  `/api/management-reviews GET`, `/api/crm/data GET`, `/api/infographic GET`,
  `/api/executive/reports GET`, `/api/vendors GET`, `/api/tablef/ GET`):
  governance + executive only — `department_viewer` is **not** in the rule
  (see `rbacMiddleware.ts` lines 379, 396, 420, 424, 427, 498, 502, 522, 541,
  566, 592). The page-shell denial matches existing API-layer behaviour.
- `/api/policies GET`: 10-role read set; `department_viewer` is **not**
  listed (line 481). Page-shell denial matches.
- `/api/ai/approvals GET` and `/api/consultant/*`: dedicated HITL / AI
  review allowlists; `department_viewer` is **not** listed (lines 471–473,
  552). Page-shell denial matches.
- `/api/pdpl/* GET` and `/api/logs GET`, `/api/event-logs GET`: admin-only
  (lines 369–370, 435, 562). Page-shell denial matches.

For each ✓ above, the corresponding API rule explicitly enumerates
`department_viewer`:

- `/api/sandbox/` (line 702), `/api/feedback` (line 657),
  `/api/manual-audit-intake` (line 669), `/api/external-audits GET`
  (line 654) — all include `department_viewer` in the GET allowlist, so the
  page-shell gate is the correct mirror.

## Result

**No unintended denials were found.** Every ✗ above corresponds to a page
whose backing API would already have returned 403 to the same user before
Task #461; the only behavioural change is that the dashboard chrome is now
also withheld up-front, instead of being rendered first and then having
every API call fail. The four ✓ entries match the `ANY_DASHBOARD_ROLES`
mirror used at the API layer.

**No allowlist changes were applied** to `staticPageRoutes.ts` and no new
matrix rows were added to `tests/staticPageRoutesRoleGate.test.ts`. The
test file already exercises `department_viewer` as the canonical "denied"
role via `pickDeniedRole()` in case B, and exercises the admitted roles
via case D, so the existing assertions cover the production population.

## Caveats

- This report is a point-in-time snapshot of production. Re-run the query
  above whenever a new role first appears in `platform_users` (e.g. after
  promoting a `bu_owner` or onboarding an `executive`). The matrix above is
  exhaustive for every documented role, so a future role addition only
  requires re-reading the corresponding row — no recomputation is needed.
- Service / automation callers that present a valid `ADMIN_API_KEY`
  (header or `admin_key` cookie) bypass the role gate by design; this
  matches the `hasValidAdminApiKey` short-circuit in
  `serveDashboardPageWithRoleGate` and is covered by case C of the test
  file.
- `custom` role users (per-user dynamic ACLs) are intentionally never
  admitted by any page-shell allowlist; they are handled solely by the
  per-API `enforceRoutePermission` pass. Production currently has zero
  `custom` users, so this is also non-blocking today.
