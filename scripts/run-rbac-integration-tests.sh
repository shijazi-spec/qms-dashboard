#!/bin/bash
# ----------------------------------------------------------------------------
# Run the RBAC HTTP-level integration test suite.
#
# Bundles the two RBAC integration test files that drive real HTTP requests
# against the running dev server:
#
#   - tests/rbacRouteLockdown.integration.ts
#       KPI / executive / analytics / scorecard / health-pulse / infographic
#       (task #35 lockdown routes — covers viewer / executive / quality_manager
#        / admin / head_of_operations_quality)
#
#   - tests/rbacReportRoutes.integration.ts
#       /api/reports/* endpoints (department_viewer 403 vs executive 200)
#
# Required environment:
#   DATABASE_URL    Postgres connection string used by both the dev server
#                   and the test harness to seed temporary platform_users
#                   rows.
#   SESSION_SECRET  HMAC key used to sign the session cookies the tests
#                   present to the dev server. MUST match what the running
#                   dev server uses; otherwise every request comes back 401.
#
# Optional environment:
#   BASE_URL        Where to send the HTTP requests
#                   (default http://localhost:5000).
#
# Both test files individually validate DATABASE_URL and SESSION_SECRET and
# exit 2 with a clear error if either is missing — this wrapper adds an
# upfront check so the failure mode is visible at the first line of CI
# output rather than half-way through.
#
# Usage:
#   bash scripts/run-rbac-integration-tests.sh
#
# Wired into:
#   - .github/workflows/rbac-integration-tests.yml (CI)
#   - tests/runIntegrationTests.ts when RUN_RBAC_INTEGRATION_E2E=1 is set
# ----------------------------------------------------------------------------
set -euo pipefail

missing=()
if [ -z "${DATABASE_URL:-}" ]; then
  missing+=("DATABASE_URL")
fi
if [ -z "${SESSION_SECRET:-}" ]; then
  missing+=("SESSION_SECRET")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ RBAC integration tests cannot run — missing required env var(s):" >&2
  for v in "${missing[@]}"; do
    echo "   - $v" >&2
  done
  echo "" >&2
  echo "   DATABASE_URL must point at the same Postgres the dev server uses." >&2
  echo "   SESSION_SECRET must match the dev server's signing key (otherwise" >&2
  echo "   every signed cookie comes back as 401)." >&2
  echo "" >&2
  echo "   In CI these are set in .github/workflows/rbac-integration-tests.yml." >&2
  echo "   Locally, export them before running this script." >&2
  exit 2
fi

BASE_URL="${BASE_URL:-http://localhost:5000}"

echo ""
echo "▶ RBAC HTTP-level integration tests"
echo "   BASE_URL=${BASE_URL}"
echo ""

echo "── tests/rbacRouteLockdown.integration.ts ──"
npx tsx tests/rbacRouteLockdown.integration.ts

echo ""
echo "── tests/rbacReportRoutes.integration.ts ──"
npx tsx tests/rbacReportRoutes.integration.ts

echo ""
echo "✅ Both RBAC HTTP integration suites passed"
