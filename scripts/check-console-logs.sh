#!/bin/bash
# ----------------------------------------------------------------------------
# CI gate — console.log / console.error secret-leak guardrail  (Tasks #61, #356)
#
# Fails the build when ANY TypeScript file under src/ contains a raw
# console.log / console.error / console.warn / console.debug call.
#
# Task #61 migrated the four highest-risk modules (zohoCRM, slackNotifications,
# userAccessRoutes, aiApprovalDatabase) to the logger.ts wrapper.  Task #356
# migrated the remaining ~90 grandfathered files and removed the allow-list
# entirely, so the guardrail is now a hard ban: every console.* call must be
# replaced with logger.info / logger.error / logger.warn / logger.debug from
# src/utils/logger.ts, which performs key-based + regex-based redaction
# before writing to stdout.
#
# Test files (*.test.ts, __tests__/**), files prefixed with "__" (test
# harnesses by convention — see src/utils/__redactionTestHarness.ts), and the
# logger infrastructure itself are unconditionally excluded from this check.
# ----------------------------------------------------------------------------
set -euo pipefail

PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== console.log / console.error guardrail ==="
echo ""
echo "--- No src/ TypeScript file may use console.* ---"

VIOLATIONS=0
while IFS= read -r file; do
  # Skip test infrastructure and the logger itself
  base=$(basename "$file")
  case "$file" in
    *".test.ts"|*"__tests__"*|"src/utils/logger.ts") continue ;;
  esac
  # CLI scripts under src/scripts/ are designed to print to stdout/stderr
  # as their primary output channel (not a web request handler) — console.*
  # is the right tool there, not the structured logger.
  case "$file" in
    "src/scripts/"*) continue ;;
  esac
  case "$base" in
    __*) continue ;;
  esac

  fail "console.* usage in $file — use logger.info/logger.error from src/utils/logger.ts"
  VIOLATIONS=$((VIOLATIONS + 1))
done < <(grep -rlE 'console\.(log|error|warn|debug)' src/ --include="*.ts" 2>/dev/null | sort)

if [ $VIOLATIONS -eq 0 ]; then
  ok "No src/ files use console.* — all logging routed through src/utils/logger.ts"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "❌ console.log guardrail FAILED — use logger.info / logger.error from src/utils/logger.ts"
  exit 1
fi

echo ""
echo "✅ console.log guardrail passed"
