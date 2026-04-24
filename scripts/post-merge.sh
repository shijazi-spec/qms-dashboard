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
echo "▶ CI gate: ai_pending_actions store-side redaction tests"
npx tsx tests/aiApprovalRedaction.test.ts

echo ""
echo "▶ CI gate: AI approval queue HTTP read-path secret-leak tests"
npx tsx tests/aiApprovalRoutesRedaction.test.ts

# ----------------------------------------------------------------------------
# CI gate — RBAC route-lockdown + admin-auth helper tests
#
# `rbacRouteLockdown.test.ts` asserts ROUTE_PERMISSION_MAP is correctly
# configured (KPIs, executive, analytics, scorecard, health-pulse,
# infographic).
#
# `adminAuthHelpers.test.ts` (Task #82) covers the shared helpers
# `hasValidAdminApiKey` / `getAdminKey` / `isAdminAuthorized` that back every
# admin-key authorization site (admin/qms/dashboard/static/health-pulse routes
# and the global middleware). Regressing these would silently weaken every
# admin endpoint at once.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: RBAC route-lockdown permission-map tests"
npx tsx tests/rbacRouteLockdown.test.ts

echo ""
echo "▶ CI gate: admin-auth helper unit tests"
npx tsx tests/adminAuthHelpers.test.ts
