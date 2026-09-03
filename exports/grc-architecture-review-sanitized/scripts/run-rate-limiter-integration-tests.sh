#!/bin/bash
# ----------------------------------------------------------------------------
# Run the HTTP-level rate-limiter integration test suite (Task #664).
#
# Bundles the two HTTP rate-limiter tests that drive real concurrent fetch()
# calls against the running dev server's middleware chain:
#
#   - tests/testRateLimiterHttp.ts
#       Eight scenarios covering write / auth-flow / read / export /
#       unauth-read / unauth-write buckets, plus window-rollover assertions
#       for each. Proves the IP-keyed buckets engage and reset at the next
#       60 s minute boundary. Authenticates via X-Admin-Key, so it never
#       exercises the user-keyed path.
#
#   - tests/testRateLimiterPerUserHttp.ts
#       Two scenarios covering the user-keyed path that the IP-keyed
#       script above cannot reach:
#         * Per-user isolation under shared X-Forwarded-For — proves two
#           signed sessions behind one office NAT each get their own
#           bucket (catches a regression that falls back to IP keying for
#           authenticated users).
#         * Per-user READ_LIMIT window reset — proves the
#           `user:<userId>:auth:general:r` bucket rolls over at the next
#           60 s minute boundary.
#
# Why this wrapper exists:
#   Both files were originally only runnable by hand with `npx tsx ...` and
#   needed the dev server to have rate limiting enabled. In the Replit dev
#   environment the server runs with `RATE_LIMIT_DISABLED=true` so the
#   limiter short-circuits to allow-all, which means the burst phase of
#   every scenario produces zero 429+Retry-After responses and the tests
#   silently degrade to false-positives. Without an enforced runner, neither
#   the original IP-keyed scenarios nor the per-user scenarios would catch a
#   future regression.
#
#   This wrapper, plus the matching CI plumbing in
#   `.github/workflows/rate-limiter-integration.yml` and `.github/workflows/test.yml`
#   (which run `npm run dev` *without* setting `RATE_LIMIT_DISABLED=true`,
#   so the limiter is enforced), makes both files run on every pipeline
#   and exit non-zero on any limiter regression.
#
# Required environment:
#   DATABASE_URL    Postgres connection string used by the per-user test
#                   harness to seed temporary platform_users rows for the
#                   isolation + reset scenarios. Must point at the same
#                   Postgres the dev server uses.
#   SESSION_SECRET  HMAC key used by the per-user test to sign session
#                   cookies. MUST match the dev server's value, otherwise
#                   the limiter sees the requests as unauthenticated and
#                   uses UNAUTH_READ_LIMIT/UNAUTH_WRITE_LIMIT instead of
#                   the user-keyed buckets — silently masking any regression.
#   ADMIN_API_KEY   Required by `tests/testRateLimiterHttp.ts` so its
#                   audit-trigger / read / export scenarios can authenticate
#                   via X-Admin-Key.
#
# Optional environment:
#   RATE_LIMIT_TEST_URL  Where to send the HTTP requests
#                        (default <REDACTED_URL>
#   PORT                 Used to derive the default URL when
#                        RATE_LIMIT_TEST_URL is not set.
#
# Each test file individually checks for ADMIN_API_KEY / SESSION_SECRET /
# DATABASE_URL and prints a clear error before exiting, but this wrapper
# adds an upfront check so the failure mode is visible at the first line of
# CI output rather than half-way through.
#
# Window-boundary note:
#   Both test files include a ~60 s wait per scenario for the next minute
#   boundary, but they parallelise their reset scenarios so the total
#   wall-clock runtime stays at roughly one ~60 s window per file
#   (~120-180 s for the whole wrapper). The CI workflow's timeout-minutes
#   accounts for this.
#
# Usage:
#   bash scripts/run-rate-limiter-integration-tests.sh
#
# Wired into:
#   - .github/workflows/rate-limiter-integration.yml (dedicated CI)
#   - .github/workflows/test.yml via RUN_RATE_LIMITER_INTEGRATION_E2E=1
#   - tests/runIntegrationTests.ts when RUN_RATE_LIMITER_INTEGRATION_E2E=1
# ----------------------------------------------------------------------------
set -euo pipefail

missing=()
if [ -z "${DATABASE_URL:-}" ]; then
  missing+=("DATABASE_URL")
fi
if [ -z "${SESSION_SECRET:-}" ]; then
  missing+=("SESSION_SECRET")
fi
if [ -z "${ADMIN_API_KEY:-}" ]; then
  missing+=("ADMIN_API_KEY")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ Rate-limiter integration tests cannot run — missing required env var(s):" >&2
  for v in "${missing[@]}"; do
    echo "   - $v" >&2
  done
  echo "" >&2
  echo "   DATABASE_URL must point at the same Postgres the dev server uses." >&2
  echo "   SESSION_SECRET must match the dev server's signing key (otherwise" >&2
  echo "   the per-user test sees its requests as unauthenticated and the" >&2
  echo "   user-keyed limiter never engages — silently masking regressions)." >&2
  echo "   ADMIN_API_KEY is needed by the IP-keyed test's authenticated" >&2
  echo "   audit/read/export scenarios." >&2
  echo "" >&2
  echo "   In CI these are set in" >&2
  echo "   .github/workflows/rate-limiter-integration.yml and" >&2
  echo "   .github/workflows/test.yml. Locally, export them before running" >&2
  echo "   this script — and make sure the dev server is running WITHOUT" >&2
  echo "   RATE_LIMIT_DISABLED=true (otherwise every burst sees zero 429s)." >&2
  exit 2
fi

# Defensive: if RATE_LIMIT_DISABLED leaks into the test process from the
# Replit dev environment, the test process itself doesn't care (it only
# sends HTTP requests) but we emit a clear warning so a developer running
# this against a dev server they haven't reconfigured isn't surprised by
# every burst returning zero 429s.
if [ "${RATE_LIMIT_DISABLED:-}" = "true" ]; then
  echo "⚠ RATE_LIMIT_DISABLED=true is set in this shell." >&2
  echo "  This wrapper sends HTTP requests against an external server, so the" >&2
  echo "  flag here is harmless — but the *server* this wrapper points at" >&2
  echo "  MUST have been started with RATE_LIMIT_DISABLED unset (or =false)." >&2
  echo "  Otherwise every burst produces zero 429+Retry-After responses and" >&2
  echo "  the tests will fail with 'burst produced 0 limiter blocks'." >&2
fi

DEFAULT_PORT="${PORT:-5000}"
RATE_LIMIT_TEST_URL="${RATE_LIMIT_TEST_URL:-<REDACTED_URL>"
export RATE_LIMIT_TEST_URL

echo ""
echo "▶ HTTP rate-limiter integration tests (Task #664)"
echo "   RATE_LIMIT_TEST_URL=${RATE_LIMIT_TEST_URL}"
echo ""

echo "── tests/testRateLimiterHttp.ts ──"
npx tsx tests/testRateLimiterHttp.ts

echo ""
echo "── tests/testRateLimiterPerUserHttp.ts ──"
npx tsx tests/testRateLimiterPerUserHttp.ts

echo ""
echo "✅ Both HTTP rate-limiter integration suites passed"
