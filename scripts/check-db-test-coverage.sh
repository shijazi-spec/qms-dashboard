#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# CI gate — every src/utils/*Database.ts writer must ship with a companion
# secret-leak integration test that is wired into scripts/post-merge.sh.
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
# developer could add `src/utils/fooDatabase.ts` without a companion test and
# nothing would block the merge. This script discovers every *Database.ts
# file and fails the build the moment that happens.
#
# What it checks
# --------------
#   1. For every src/utils/*Database.ts file, a companion test file exists.
#      Default convention: `src/utils/<name>Database.test.ts`. Files that
#      legitimately ship under a different test filename are listed in the
#      COMPANION_TESTS map below.
#   2. The companion test is wired into CI via scripts/post-merge.sh — either
#      explicitly invoked (`npx tsx <path>`) or auto-discovered by `npm test`
#      (which runs tests/runIntegrationTests.ts and recursively picks up every
#      src/**/*.test.ts file).
#
# Grandfathered files
# -------------------
# When this gate was introduced, only changeHistoryDatabase.ts and
# eventLogsDatabase.ts had matching secret-leak tests. The remaining writers
# are temporarily exempt via the GRANDFATHERED list below so the gate could
# be turned on without rewriting every test in a single task. Each entry is a
# standing TODO — please write a *Database.test.ts following
# src/utils/changeHistoryDatabase.test.ts as a reference and remove the entry.
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
# `<name>Database.test.ts` convention. Prefer renaming new tests to match.
# ----------------------------------------------------------------------------
declare -A COMPANION_TESTS
COMPANION_TESTS["src/utils/eventLogsDatabase.ts"]="src/utils/redactSensitiveFields.test.ts"

# ----------------------------------------------------------------------------
# Grandfathered modules — must eventually receive a secret-leak test.
# DO NOT add new entries. New *Database.ts files MUST ship with a companion
# *.test.ts in src/utils/ following the rules in src/utils/README.md.
#
# Task #459 backfilled secret-leak tests for all 27 historically grandfathered
# `src/utils/*Database.ts` writers; the allow-list is now empty and any new
# writer ships with its companion test on day one.
# ----------------------------------------------------------------------------
declare -A GRANDFATHERED

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

# `npm test` (via tests/runIntegrationTests.ts) recursively discovers every
# src/**/*.test.ts file. If the post-merge script invokes `npm test`, any
# companion test placed under src/utils/ is wired in by construction.
POST_MERGE_RUNS_NPM_TEST=0
if grep -qE '^[[:space:]]*npm[[:space:]]+test([[:space:]]|$)' "$POST_MERGE"; then
  POST_MERGE_RUNS_NPM_TEST=1
fi

# ----------------------------------------------------------------------------
# Discover every src/utils/*Database.ts source file (excluding *.test.ts).
# ----------------------------------------------------------------------------
shopt -s nullglob
DB_FILES=()
for path in src/utils/*Database.ts; do
  case "$path" in
    *.test.ts) continue ;;
  esac
  DB_FILES+=("$path")
done
shopt -u nullglob

if [ "${#DB_FILES[@]}" -eq 0 ]; then
  echo "  ✗ No src/utils/*Database.ts files were discovered — refusing to silently pass."
  exit 1
fi

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

for src_file in "${DB_FILES[@]}"; do
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
  echo "   Every src/utils/*Database.ts file MUST ship with a companion"
  echo "   *.test.ts in src/utils/ that mocks pg.Pool.prototype.query, calls"
  echo "   every public write function with payloads containing"
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
