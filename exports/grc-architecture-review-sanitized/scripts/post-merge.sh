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
echo "▶ CI gate: full test suite (tests/runIntegrationTests.ts)"
npx tsx tests/runIntegrationTests.ts

# ----------------------------------------------------------------------------
# CI gate — i18n coverage guardrail (Task #125 / #150 / #345 / #373)
#
# The full i18n guardrail (`scripts/check-i18n.cjs --report-unused`) is run
# as part of the integration suite above via `tests/i18nCoverage.test.ts`,
# which spawns the script with `--report-unused` and bubbles up its exit
# code. The previously-explicit `node scripts/check-i18n.cjs --report-unused`
# call here was removed in Task #373 because it executed the same six checks
# a second time, doubling the i18n wall-clock cost without adding coverage.
# To register a new dynamic-lookup prefix, edit
# `dashboard/i18n/.referenced-dynamically.json`.
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# CI gate — dashboard inline-handler + inline-<script> CSP guard
#                                          (Task #171 / Task #131 / Task #248)
#
# Blocks merges that:
#   1. Reintroduce inline `onclick=` / `onchange=` / etc. on any
#      `dashboard/*.html` or `public/*.html` page. These would be silently
#      dropped by the strict CSP (`script-src` has no `'unsafe-inline'`),
#      turning the affected button into a no-op in production. Equivalent
#      behaviour MUST go through `dashboard/js/safe-actions.js` using the
#      `data-on-{event}` pattern.
#   2. (Task #248) Add a NEW HTML page with bare `<script>…</script>` blocks
#      lacking `nonce=` that is not on the explicit allowlist in
#      `scripts/check-handlers.cjs` (`INLINE_SCRIPT_NONCE_ALLOWLIST`). This
#      catches pages that accidentally bypass the global CSP middleware
#      (`src/mastra/middleware/index.ts` → `injectCspNonce`) — those scripts
#      would silently fail in production. The allowlist also fails on stale
#      entries so it cannot rot.
#
# All 38 dashboard HTML files are migrated for (1) (the last two — ai-ops
# and consultant — were finished in Task #131) and listed in the allowlist
# for (2). The gate enforces zero-tolerance going forward.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: dashboard inline-handler + inline-<script> CSP guard (Task #171 / #131 / #248)"
bash scripts/lint-dashboard-handlers.sh --check-inline-scripts

# ----------------------------------------------------------------------------
# CI gate — console.log / console.error secret-leak guardrail (Tasks #61, #356)
#
# Prevents secrets from leaking through raw console.log / console.error calls.
# Task #356 finished the migration of every src/ module away from console.* and
# removed the grandfathered allow-list, so the guardrail is now a hard ban: any
# console.log / console.error / console.warn / console.debug call under src/
# (other than test files and src/utils/logger.ts itself) fails the build.
#
# Implementation: scripts/check-console-logs.sh + tests/safeLoggerRedaction.test.ts
# See also: src/utils/logger.ts — the safe wrapper that runs every payload
#           through redactSensitiveDeep() before forwarding to pino, with the
#           redaction primitives now living in src/utils/sensitiveRedaction.ts.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: console.log / console.error guardrail + safeLogger redaction tests (Tasks #61, #356)"
bash scripts/check-console-logs.sh
npx tsx tests/safeLoggerRedaction.test.ts

# ----------------------------------------------------------------------------
# CI gate — dashboard RTL physical-direction class guard (Tasks #315 / #628 / #743)
#
# Blocks merges that reintroduce physical-direction Tailwind classes on the
# the highest-impact dashboard surfaces:
#   * `<th>` headers using `text-left` / `text-right`
#   * stat-card borders using `border-l-4` / `border-r-4`
#   * `<button>` icon gutters using `ml-<n>` / `mr-<n>`
#   * any element using `space-x-<n>` (margin-left between flex children;
#     does not flip in RTL — use `gap-<n>` instead)
#   * any element using `rounded-l-*` / `rounded-r-*` (use `rounded-s-*` /
#     `rounded-e-*`)
#   * any non-`<th>` element using `text-left` / `text-right` such as
#     `<td>`, `<div>`, `<p>`, `<li>`, `<span>` (use `text-start` /
#     `text-end`)
# These pin the layout to LTR and silently break the Arabic (RTL)
# experience served via `html[dir="rtl"]` set by `dashboard/js/i18n.js`.
# Equivalent behaviour MUST use logical-direction utilities: `text-start`,
# `border-s-4`, `ms-<n>`, `me-<n>`, `gap-<n>`, `rounded-s-*` (see
# HostingPlatform.md → "RTL Layout Convention").
#
# Task #743 extends the gate with a SECOND PASS that parses every inline
# `<script>` body with acorn and re-applies the forbidden-class rules to
# every JS string literal + template-literal quasi. The dashboard renders
# most of its row-level UI from JS template strings, so without this pass
# a `mr-2` dropped into a button template would ship silently. Running the
# script with no flags executes both passes (HTML + JS-string) — there is
# no separate command to wire in.
#
# All currently-violating pages are grandfathered via per-rule allowlists in
# the script (HTML rules: `ALLOWLISTS`; JS-string rules: `JS_ALLOWLISTS`);
# new dashboard HTML files (or removing one from an allowlist) are subject
# to the full rule. Also covered by
# `tests/noPhysicalDirectionClasses.test.ts` (auto-discovered by `npm test`).
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: dashboard RTL physical-direction class guard (Tasks #315 / #628 / #743)"
node scripts/check-rtl-classes.cjs

# ----------------------------------------------------------------------------
# CI gate — dashboard <th scope> accessibility guardrail (Task #757)
#
# Hardens Task #46 / Task #263 (which added `scope="col|row"` by hand to
# every existing `<th>` in dashboard/*.html). Without `scope`, screen
# readers (NVDA, JAWS, VoiceOver, TalkBack) fall back to a positional
# heuristic that silently mis-associates headers with cells in any table
# that has a corner spacer cell, multiple header rows, or row headers —
# making the table unusable for assistive-tech users.
#
# This gate runs two passes against `dashboard/*.html`:
#   1. HTML pass — every `<th …>` opening tag must carry a valid
#      `scope="col|row|colgroup|rowgroup"` attribute.
#   2. JS-string pass — every `<th …>` rendered from a JS template
#      string inside an inline `<script>` block must carry the same
#      (the dashboard renders many tables this way: crm.html,
#      duplicates.html, ai-ops.html, …).
#
# All currently-shipping pages pass both passes (Task #263 finished the
# migration). Adding a new dashboard HTML file or a new `<th>` without
# `scope` fails the build. Per-line opt-out marker `th-scope-safe: <reason>`
# is available for the rare presentational <th> in a non-data table.
#
# Also covered by `tests/thScopeAccessibility.test.ts` (auto-discovered by
# the integration-test runner).
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: dashboard <th scope> accessibility guardrail (Task #757)"
node scripts/check-th-scope.cjs
