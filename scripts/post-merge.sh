#!/bin/bash
set -e

npm install

# ----------------------------------------------------------------------------
# CI gate — secret-redaction tests
#
# Blocks the build if any future change bypasses the redactSensitiveFields()
# helper or removes a deny-list pattern, which would let raw secrets
# (password_hash, mfa_secret, access_token, refresh_token, api_key, …) leak
# into event_logs / change_history.
#
# See src/utils/redactSensitiveFields.test.ts and Task #37.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: redactSensitiveFields + logEvent write-path tests"
npx tsx src/utils/redactSensitiveFields.test.ts

echo ""
echo "▶ CI gate: changeHistoryDatabase write-path secret-leak tests"
npx tsx src/utils/changeHistoryDatabase.test.ts

echo ""
echo "▶ CI gate: ai_pending_actions store-side redaction tests"
npx tsx tests/aiApprovalRedaction.test.ts

echo ""
echo "▶ CI gate: AI approval queue HTTP read-path secret-leak tests"
npx tsx tests/aiApprovalRoutesRedaction.test.ts

echo ""
echo "▶ CI gate: AI approval queue rejection-note secret-leak tests"
npx tsx tests/aiApprovalRejectionRedaction.test.ts

# ----------------------------------------------------------------------------
# CI gate — RBAC route-lockdown + admin-auth helper tests
#
# `rbacRouteLockdown.test.ts` asserts ROUTE_PERMISSION_MAP is correctly
# configured (KPIs, executive, analytics, scorecard, health-pulse,
# infographic).
#
# `adminAuthHelpers.test.ts` (Tasks #82 / #96) covers the shared helpers
# `hasValidAdminApiKey` / `getAdminKey` / `isAdminAuthorized` and also the
# role-gate helpers `requireAdminOrKey` / `requireRoleOrKey` / `requireAuthOrKey`
# plus the `getSessionUser` admin-key fallback that back every admin-key
# authorization site (admin/qms/dashboard/static/health-pulse routes and the
# global middleware). Regressing these would silently weaken every admin
# endpoint at once.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: RBAC route-lockdown permission-map tests"
npx tsx tests/rbacRouteLockdown.test.ts

echo ""
echo "▶ CI gate: admin-auth helper unit tests"
npx tsx tests/adminAuthHelpers.test.ts

# ----------------------------------------------------------------------------
# CI gate — requireRole session-path unit tests (Task #253)
#
# Task #96 covered the admin-key short-circuit branches; this gate covers the
# remaining session-path of `requireRole`, which calls `getPlatformUser` to
# (a) confirm the platform record is `status = 'active'` and
# (b) re-read the live role from the DB so role demotions take effect on the
# next request. A regression here would let inactive or role-demoted users
# silently keep access via a stale-but-valid session cookie. The test stubs
# pg.Pool so it runs without a live DB.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: requireRole session-path unit tests (Task #253)"
npx tsx tests/requireRoleSessionPath.test.ts

# ----------------------------------------------------------------------------
# CI gate — gateApiRoute wrapper unit tests (Task #254)
#
# `gateApiRoute` in src/utils/rbacMiddleware.ts wraps every /api/ route with a
# `requireAuthOrKey` gate so an unauthenticated caller can never reach a
# handler — even when the global middleware in src/mastra/middleware/index.ts
# is bypassed (e.g. when an integration test invokes a handler directly via
# tests/_helpers/fakeContext.ts). Regressing the wrapper would silently let
# anonymous callers hit routes that look gated everywhere else.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: gateApiRoute wrapper unit tests (Task #254)"
npx tsx tests/gateApiRoute.test.ts

echo ""
echo "▶ CI gate: ai_pending_actions historical sweep backfill (Task #85)"
npx tsx tests/aiApprovalSweepBackfill.test.ts

echo ""
echo "▶ CI gate: historical sweep keyset pagination (Task #289)"
npx tsx tests/redactHistoricalPagination.test.ts

# ----------------------------------------------------------------------------
# CI gate — i18n coverage guardrail (Task #125 / #150)
#
# Blocks merges that:
#   * Add a `dashboard/*.html` page without `/js/i18n.js` + the
#     `WalaPlusI18n.init().then(applyToDOM)` bootstrap.
#   * Reference a `data-i18n="ns.key"` whose key is missing from
#     `dashboard/i18n/en.json` or `dashboard/i18n/ar.json`.
#   * Drift the `en.json` / `ar.json` key trees apart (orphans either way,
#     or a leaf turning into a sub-object on one side only).
#   * Use a static `WalaPlusI18n.t('ns.key')` call in `dashboard/js/*.js` or
#     an inline <script> block whose key is missing from en.json / ar.json.
#     Dynamic t(variable) calls are surfaced as non-blocking ⚠ warnings.
#
# All five checks live in `scripts/check-i18n.cjs` and are also covered by
# `tests/i18nCoverage.test.ts` (auto-discovered by `npm test`).
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: i18n coverage (Task #125 / #150)"
node scripts/check-i18n.cjs

# ----------------------------------------------------------------------------
# CI gate — dashboard inline-handler CSP guard (Task #171 / Task #131)
#
# Blocks merges that reintroduce inline `onclick=` / `onchange=` / etc. on any
# `dashboard/*.html` or `public/*.html` page. These would be silently dropped
# by the strict CSP (`script-src` has no `'unsafe-inline'`), turning the
# affected button into a no-op in production. Equivalent behaviour MUST go
# through `dashboard/js/safe-actions.js` using the `data-on-{event}` pattern.
#
# All 38 dashboard HTML files are now fully migrated (including
# dashboard/ai-ops.html and dashboard/consultant.html — the last two
# migrated in Task #131). The gate enforces zero-tolerance going forward.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: dashboard inline-handler CSP guard (Task #171 / #131)"
bash scripts/lint-dashboard-handlers.sh
