#!/bin/bash
set -e

npm install

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
