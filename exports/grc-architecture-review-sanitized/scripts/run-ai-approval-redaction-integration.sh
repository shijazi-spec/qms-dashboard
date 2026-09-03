#!/bin/bash
# ----------------------------------------------------------------------------
# Run the AI approval-queue HTTP secret-leak integration test (Task #348).
#
# Drives `tests/aiApprovalRoutesRedaction.integration.ts` against a running
# dev server. The test seeds rows through the live `enqueuePendingAction`,
# signs a quality-manager session cookie with the same `SESSION_SECRET` the
# server uses, and exercises the full HTTP / middleware stack for:
#
#   GET  /api/ai/approvals
#   GET  /api/ai/approvals/pending-count
#   GET  /api/ai/approvals/:code           (pending then executed)
#   GET  /api/ai/approvals?status=executed
#   POST /api/ai/approvals/:code/approve   (success path — fresh secrets in result)
#   POST /api/ai/approvals/:code/approve   (throw path  — secret in error.message)
#
# It asserts that none of the seeded plaintext secrets appear in any response
# body, and that the redaction sentinel does appear (so the row was surfaced,
# not silently empty). The POST /approve coverage closes the gap that the
# in-process test (`tests/aiApprovalRoutesRedaction.test.ts`) cannot reach
# because the gated tool result is returned synchronously to the browser
# before it is masked on the way into ai_pending_actions — which is the
# single most dangerous secret-exposure point in the approval flow.
#
# The two synthetic canary tools required by the POST /approve assertions
# (`<REDACTED_SECRET>__ok` and
# `<REDACTED_SECRET>__throws`) are registered in the server
# at startup whenever NODE_ENV !== 'production'
# (src/utils/integrationTestFixtureTools.ts), so no extra runtime setup is
# required beyond starting the normal `npm run dev` process.
#
# Required environment:
#   DATABASE_URL    Postgres connection string used by both the dev server
#                   and the test harness to seed temporary platform_users
#                   and ai_pending_actions rows.
#   SESSION_SECRET  HMAC key used to sign the session cookie the test
#                   presents to the dev server. MUST match what the running
#                   dev server uses, otherwise every signed cookie comes
#                   back as 401 — never 200/500 — which would silently mask
#                   any redaction regression.
#
# Optional environment:
#   BASE_URL        Where to send the HTTP requests
#                   (default <REDACTED_URL>
#
# The test file individually validates DATABASE_URL and SESSION_SECRET and
# exits 2 with a clear error if either is missing — this wrapper adds an
# upfront check so the failure mode is visible at the first line of CI
# output rather than half-way through.
#
# Usage:
#   bash scripts/run-ai-approval-redaction-integration.sh
#
# Wired into:
#   - .SourceControlProvider/workflows/ai-approval-redaction-integration.yml (dedicated CI)
#   - .SourceControlProvider/workflows/test.yml via RUN_APPROVAL_REDACTION_INTEGRATION_E2E=1
#   - tests/runIntegrationTests.ts when RUN_APPROVAL_REDACTION_INTEGRATION_E2E=1
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
  echo "❌ AI approval redaction integration test cannot run — missing required env var(s):" >&2
  for v in "${missing[@]}"; do
    echo "   - $v" >&2
  done
  echo "" >&2
  echo "   DATABASE_URL must point at the same Postgres the dev server uses." >&2
  echo "   SESSION_SECRET must match the dev server's signing key (otherwise" >&2
  echo "   every signed cookie comes back as 401)." >&2
  echo "" >&2
  echo "   In CI these are set in" >&2
  echo "   .SourceControlProvider/workflows/ai-approval-redaction-integration.yml and" >&2
  echo "   .SourceControlProvider/workflows/test.yml. Locally, export them before running" >&2
  echo "   this script." >&2
  exit 2
fi

BASE_URL="${BASE_URL:-<REDACTED_URL>"

echo ""
echo "▶ AI approval-queue HTTP secret-leak integration test (Task #348)"
echo "   BASE_URL=${BASE_URL}"
echo ""

npx tsx tests/aiApprovalRoutesRedaction.integration.ts

echo ""
echo "✅ AI approval-queue HTTP secret-leak integration test passed"
