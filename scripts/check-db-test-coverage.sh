#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# CI gate — every TypeScript file that persists user-controlled data via
# INSERT/UPDATE against Postgres must ship with a companion secret-leak
# integration test that is wired into scripts/post-merge.sh.
#
# Why this exists
# ---------------
# src/utils/README.md spells out the rule: any module that persists user-
# controlled data must have a *.test.ts that mocks pg.Pool, drives every
# public write function with payloads containing the required deny-list keys
# (password_hash, mfa_secret, access_token, refresh_token, api_key) and
# asserts the raw values never reach the INSERT/UPDATE params vector.
#
# Until this gate existed, that rule was enforced only by the README. A
# developer could add `src/utils/fooDatabase.ts` (or any other DB writer) and
# nothing would block the merge. This script discovers every writer and fails
# the build the moment one ships without a companion test.
#
# Scope (Task #460)
# -----------------
# The original gate (Task #268) only covered `src/utils/*Database.ts`. That
# left several known leak surfaces uncovered:
#   • `src/utils/callIntelligenceDb.ts` — note the `Db` (not `Database`) suffix
#   • `src/utils/database.ts`, `src/utils/notificationHub.ts`,
#     `src/utils/aiTelemetry.ts`, etc. — utilities that do their own writes
#   • `src/mastra/routes/*.ts` — request handlers that issue INSERT/UPDATE
#     directly against the pool instead of going through a *Database.ts module
#   • `src/data/` — currently has no writers, but is included in the scan so
#     any future writer added there is caught automatically
#
# The discovery now combines two strategies:
#   1. An explicit include glob for known writer conventions
#      (`src/utils/*Database.ts`, `src/utils/*Db.ts`).
#   2. A repo-wide `rg` scan of every `src/**/*.ts` file (excluding
#      `*.test.ts`) for `INSERT INTO` or `UPDATE <table> SET` patterns.
# Both sets are merged and deduplicated, so adding a new writer in any
# directory under `src/` is automatically picked up.
#
# What it checks
# --------------
#   1. For every discovered writer, a companion test file exists at
#      `<dirname>/<basename>.test.ts`. Files that ship a differently-named
#      companion test list it explicitly in COMPANION_TESTS below.
#   2. The companion test is wired into CI via scripts/post-merge.sh — either
#      explicitly invoked (`npx tsx <path>`) or auto-discovered by `npm test`
#      (which runs tests/runIntegrationTests.ts and recursively picks up every
#      src/**/*.test.ts file).
#
# Grandfathered files
# -------------------
# When this gate was first introduced (Task #268), only changeHistoryDatabase
# and eventLogsDatabase had matching secret-leak tests. The Task #460
# expansion added many more pre-existing writers (routes, callIntelligenceDb,
# aiTelemetry, etc.) that also lacked tests on day one. All of them are
# temporarily exempt via the GRANDFATHERED list below so the broader gate
# could be turned on without writing dozens of tests in a single task. Each
# entry is a standing TODO — please write a `<name>.test.ts` following
# `src/utils/changeHistoryDatabase.test.ts` as a reference and remove the
# entry.
#
# **Do not add new entries to GRANDFATHERED.** The whole point of this gate
# is to make new untested writers impossible. Add the test instead.
# ----------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

POST_MERGE="scripts/post-merge.sh"

# ----------------------------------------------------------------------------
# Non-standard companion test mappings.
# Use this only when the historical test filename does not follow the
# `<name>.test.ts` convention. Prefer renaming new tests to match.
# ----------------------------------------------------------------------------
declare -A COMPANION_TESTS
COMPANION_TESTS["src/utils/eventLogsDatabase.ts"]="src/utils/redactSensitiveFields.test.ts"
# Pure SQL-fragment helper shared between two redaction sweeps (Task #575).
# Doesn't issue its own queries; matched by the rg scan because of a comment
# describing the `UPDATE ai_call_metrics SET …` clause it splices into. The
# canonical companion test lives under tests/ and is auto-discovered by
# `npm test`.
COMPANION_TESTS["src/utils/aiCallMetricsPreviewBreadcrumb.ts"]="tests/aiCallMetricsPreviewBreadcrumb.test.ts"

# ----------------------------------------------------------------------------
# Grandfathered modules — must eventually receive a secret-leak test.
# DO NOT add new entries. New writer files MUST ship with a companion
# *.test.ts following the rules in src/utils/README.md.
#
# History:
#   • Task #268 introduced the gate with 27 `src/utils/*Database.ts` writers
#     in this allow-list. Task #459 backfilled companion secret-leak tests
#     for every one of them, so those entries are no longer needed.
#   • Task #460 then expanded the gate's discovery beyond `*Database.ts` to
#     pick up `*Db.ts`, other `src/utils/*` writers, and `src/mastra/routes/*`.
#     The pre-existing writers in those new categories did not have tests on
#     day one and are listed below — please write a `<name>.test.ts` per
#     `src/utils/changeHistoryDatabase.test.ts` and remove the entry.
# ----------------------------------------------------------------------------
declare -A GRANDFATHERED

# Task #460 expansion — additional writers picked up by the broader scan.
# src/utils/* writers that don't follow the *Database.ts naming convention.
GRANDFATHERED["src/utils/aiBackgroundScanner.ts"]=1
GRANDFATHERED["src/utils/aiMetricsRetentionConfig.ts"]=1
GRANDFATHERED["src/utils/aiTelemetry.ts"]=1
GRANDFATHERED["src/utils/alertEmailRecipients.ts"]=1
GRANDFATHERED["src/utils/callIntelligenceDb.ts"]=1
GRANDFATHERED["src/utils/controlledDocumentRegistry.ts"]=1
GRANDFATHERED["src/utils/database.ts"]=1
GRANDFATHERED["src/utils/notificationHub.ts"]=1
GRANDFATHERED["src/utils/platformHealthPulse.ts"]=1
GRANDFATHERED["src/utils/rateLimiter.ts"]=1
GRANDFATHERED["src/utils/redactHistoricalLogs.ts"]=1
GRANDFATHERED["src/utils/scheduledJobs.ts"]=1

# Express route modules under src/mastra/routes/ that issue INSERT/UPDATE
# directly. Long-term these should be refactored to go through a *Database.ts
# module (which then carries the secret-leak test); for now each route file
# needs its own companion test.
GRANDFATHERED["src/mastra/routes/authRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/callIntelligenceRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/exportDownloadRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/i18nRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/qmsEnhancedRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/tablefApiRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/tablefRoutes.ts"]=1
GRANDFATHERED["src/mastra/routes/triggerRoutes.ts"]=1

PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== DB writer secret-leak test coverage gate ==="

if [ ! -f "$POST_MERGE" ]; then
  echo "  ✗ $POST_MERGE not found — cannot verify CI wiring."
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "  ✗ ripgrep ('rg') is required for the broad writer scan but is not installed."
  exit 1
fi

# `npm test` (via tests/runIntegrationTests.ts) recursively discovers every
# src/**/*.test.ts file. If the post-merge script invokes `npm test`, any
# companion test placed alongside its source under src/ is wired in by
# construction.
POST_MERGE_RUNS_NPM_TEST=0
if grep -qE '^[[:space:]]*npm[[:space:]]+test([[:space:]]|$)' "$POST_MERGE"; then
  POST_MERGE_RUNS_NPM_TEST=1
fi

# ----------------------------------------------------------------------------
# Discover every writer under src/.
#
# Strategy:
#   1. Explicit include globs for known writer conventions
#      (src/utils/*Database.ts and src/utils/*Db.ts). These are caught even
#      if the file happens to not match the pattern scan (e.g. an aggregator
#      that re-exports writes from another module).
#   2. Repo-wide rg scan of src/**/*.ts (excluding *.test.ts) for raw
#      INSERT INTO / UPDATE <table> SET statements. Catches writers in any
#      directory — src/utils/ outside the *Database.ts naming, src/data/,
#      src/mastra/routes/, and any future location.
#
# The two sets are merged and deduplicated.
# ----------------------------------------------------------------------------
declare -A WRITERS

shopt -s nullglob
for path in src/utils/*Database.ts src/utils/*Db.ts; do
  case "$path" in
    *.test.ts) continue ;;
  esac
  [ -f "$path" ] && WRITERS["$path"]=1
done
shopt -u nullglob

# rg-based scan. -l prints file names, --type ts limits to *.ts, -g excludes
# test files. The pattern matches `INSERT INTO <table>` and `UPDATE <table>
# SET` — the two write verbs that can carry user-controlled data into a
# parameterised query.
SCAN_PATTERN='INSERT INTO|UPDATE [A-Za-z_][A-Za-z0-9_]* SET'
while IFS= read -r path; do
  [ -z "$path" ] && continue
  WRITERS["$path"]=1
done < <(rg -l --type ts -g '!**/*.test.ts' "$SCAN_PATTERN" src/ 2>/dev/null | sort)

if [ "${#WRITERS[@]}" -eq 0 ]; then
  echo "  ✗ No DB writer files were discovered — refusing to silently pass."
  exit 1
fi

# Stable iteration order for deterministic output.
WRITER_PATHS=()
for path in "${!WRITERS[@]}"; do
  WRITER_PATHS+=("$path")
done
IFS=$'\n' WRITER_PATHS=($(sort <<<"${WRITER_PATHS[*]}"))
unset IFS

UNKNOWN_GRANDFATHERED=()
for grandfathered in "${!GRANDFATHERED[@]}"; do
  if [ ! -f "$grandfathered" ]; then
    UNKNOWN_GRANDFATHERED+=("$grandfathered")
  fi
done
if [ "${#UNKNOWN_GRANDFATHERED[@]}" -gt 0 ]; then
  for stale in "${UNKNOWN_GRANDFATHERED[@]}"; do
    fail "Stale GRANDFATHERED entry: $stale no longer exists. Remove it from scripts/check-db-test-coverage.sh."
  done
fi

for src_file in "${WRITER_PATHS[@]}"; do
  if [ -n "${GRANDFATHERED[$src_file]+x}" ]; then
    ok "$src_file — grandfathered (TODO: write companion *.test.ts per src/utils/README.md)"
    continue
  fi

  if [ -n "${COMPANION_TESTS[$src_file]+x}" ]; then
    test_file="${COMPANION_TESTS[$src_file]}"
  else
    base="${src_file%.ts}"
    test_file="${base}.test.ts"
  fi

  if [ ! -f "$test_file" ]; then
    fail "$src_file → missing companion secret-leak test at $test_file. See src/utils/README.md for the required structure (mock pg.Pool, drive every write fn with deny-list keys, assert raw values never reach INSERT/UPDATE params)."
    continue
  fi

  if grep -qF "$test_file" "$POST_MERGE"; then
    ok "$src_file → $test_file (explicitly invoked in $POST_MERGE)"
  elif [ "$POST_MERGE_RUNS_NPM_TEST" -eq 1 ]; then
    ok "$src_file → $test_file (auto-discovered by 'npm test' in $POST_MERGE)"
  else
    fail "$src_file → $test_file exists but is not wired into $POST_MERGE. Either add 'npx tsx $test_file' or ensure 'npm test' is invoked."
  fi
done

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "❌ DB writer secret-leak test coverage FAILED."
  echo ""
  echo "   Every TypeScript file under src/ that runs INSERT INTO or"
  echo "   UPDATE <table> SET against Postgres MUST ship with a companion"
  echo "   <name>.test.ts in the same directory that mocks pg.Pool.prototype"
  echo "   .query, calls every public write function with payloads containing"
  echo "   password_hash / mfa_secret / access_token / refresh_token / api_key,"
  echo "   and asserts those values are replaced with '***REDACTED***' before"
  echo "   they reach the INSERT/UPDATE params vector."
  echo ""
  echo "   See src/utils/changeHistoryDatabase.test.ts for a reference and"
  echo "   src/utils/README.md for the full checklist."
  exit 1
fi

echo ""
echo "✅ DB writer secret-leak test coverage gate passed"
