#!/bin/bash
set -e

npm install

# ----------------------------------------------------------------------------
# CI gate — DB writer secret-leak test coverage (Task #268)
#
# Runs FIRST so a missing companion test fails the build immediately with a
# clear diagnostic, before the slower full test suite. Discovers every
# src/utils/*Database.ts file and verifies it has a matching *.test.ts that
# is wired into this script (either explicitly or via `npm test` auto-
# discovery). See src/utils/README.md and the script header for details.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: DB writer secret-leak test coverage (Task #268)"
bash scripts/check-db-test-coverage.sh

# ----------------------------------------------------------------------------
# CI gate — full test suite
#
# Runs every test file discovered by tests/runIntegrationTests.ts (60+ files),
# including src/**/*.test.ts (e.g. redactSensitiveFields.test.ts).
# Replaces the previous hand-picked subset of npx tsx ... invocations.
# A failure in any file blocks the merge.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: full test suite (npm test)"
npm test

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

# ----------------------------------------------------------------------------
# CI gate — console.log / console.error secret-leak guardrail (Task #61)
#
# Prevents secrets from leaking through raw console.log / console.error calls:
#   Part 1: The four high-risk modules migrated to logger.ts must stay clean.
#   Part 2: No TypeScript file outside the known allow-list may introduce a
#           new console.* call (stops the problem from spreading to new code).
#
# Implementation: scripts/check-console-logs.sh + tests/safeLoggerRedaction.test.ts
# See also: src/utils/logger.ts — the safe wrapper that runs every payload
#           through redactSensitiveFields() before forwarding to pino.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: console.log / console.error guardrail + safeLogger redaction tests (Task #61)"
bash scripts/check-console-logs.sh
npx tsx tests/safeLoggerRedaction.test.ts
