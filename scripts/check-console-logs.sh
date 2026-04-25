#!/bin/bash
# ----------------------------------------------------------------------------
# CI gate — console.log / console.error secret-leak guardrail  (Task #61)
#
# Fails the build when:
#   1. Any of the four high-risk modules that were migrated to logger.ts still
#      contain a raw console.log / console.error call.
#   2. Any TypeScript file under src/ that is NOT on the allow-list introduces
#      a new console.log / console.error call.
#
# Allow-list philosophy
# ---------------------
# The list below captures every src/ file that already uses console.*  at the
# time this gate was introduced.  Existing uses are grandfathered; they should
# be migrated to logger.ts opportunistically.  If a developer adds console.*
# to a *new* file (or a file that was previously clean) the check fails and
# they must use logger.info / logger.error from src/utils/logger.ts instead.
#
# Updating the allow-list
# -----------------------
# If you legitimately need console.* in a new infrastructure file, append it
# to ALLOWED_FILES below and add a one-line comment explaining why.
#
# Allow-list ceiling (Task #357)
# ------------------------------
# A hard ceiling (MAX_ALLOWED_FILES) prevents the allow-list from silently
# growing back over time. The build fails if the number of entries exceeds
# the ceiling. As migrations remove files from the allow-list, the ceiling
# MUST be lowered in the same commit — this turns the migration into a one-
# way ratchet. Never raise the ceiling without an explicit, reviewed reason.
# ----------------------------------------------------------------------------
set -euo pipefail

PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

echo ""
echo "=== console.log / console.error guardrail ==="

# ---------------------------------------------------------------------------
# Part 1 — Migrated modules must be fully clean.
# These files were explicitly converted to logger.ts and must never regress.
# ---------------------------------------------------------------------------
MIGRATED_MODULES=(
  "src/utils/zohoCRM.ts"
  "src/utils/slackNotifications.ts"
  "src/mastra/routes/userAccessRoutes.ts"
  "src/utils/aiApprovalDatabase.ts"
)

echo ""
echo "--- Part 1: migrated modules must have zero console.* calls ---"
for file in "${MIGRATED_MODULES[@]}"; do
  if [ ! -f "$file" ]; then
    ok "$file — file does not exist (skipped)"
    continue
  fi
  count=$(grep -cE 'console\.(log|error|warn|debug)' "$file" || true)
  if [ "$count" -eq 0 ]; then
    ok "$file — clean (0 console.* calls)"
  else
    fail "$file — $count console.* call(s) found; use logger.info/logger.error from src/utils/logger.ts"
  fi
done

# ---------------------------------------------------------------------------
# Part 2 — No new files outside the allow-list may introduce console.*.
#
# Test files (*.test.ts, __tests__/**) and the logger infrastructure itself
# are unconditionally excluded from this check.
# ---------------------------------------------------------------------------

# Files already known to use console.* — grandfathered until migrated.
declare -A ALLOWED_FILES
ALLOWED_FILES["src/data/index.ts"]=1
ALLOWED_FILES["src/mastra/index.ts"]=1
ALLOWED_FILES["src/mastra/inngest/index.ts"]=1
ALLOWED_FILES["src/mastra/routes/a11yRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/adminApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/aiApprovalRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/aiOpsRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/auditProgrammeRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/auditRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/authRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/callIntelligenceRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/complianceRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/consultantRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/dashboardApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/dashboardRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/duplicateRadarRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/eventLogsRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/externalAuditRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/feedbackApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/handoffRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/infographicRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/knowledgeRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/kpiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/manualAuditRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/migrationRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/notificationRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/onboardingRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/pdplRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/pmpRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/policyRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/qmsApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/qmsEnhancedRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/rbacRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/riskRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/roiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/sandboxApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/scorecardRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/smokeTestRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/sopRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/staticAssetRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/staticPageRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/tablefApiRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/tablefRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/teamRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/triggerRoutes.ts"]=1
ALLOWED_FILES["src/mastra/routes/vendorRoutes.ts"]=1
ALLOWED_FILES["src/mastra/tools/exampleTool.ts"]=1
ALLOWED_FILES["src/mastra/workflows/promptRegressionAlertsCron.ts"]=1
ALLOWED_FILES["src/mastra/workflows/toolHealthAlertsCron.ts"]=1
ALLOWED_FILES["src/triggers/exampleConnectorTrigger.ts"]=1
ALLOWED_FILES["src/triggers/slackTriggers.ts"]=1
ALLOWED_FILES["src/triggers/telegramTriggers.ts"]=1
ALLOWED_FILES["src/utils/aiBackgroundScanner.ts"]=1
ALLOWED_FILES["src/utils/aiTelemetry.ts"]=1
ALLOWED_FILES["src/utils/auditDatabase.ts"]=1
ALLOWED_FILES["src/utils/auditProgrammeDatabase.ts"]=1
ALLOWED_FILES["src/utils/auditTriggerDatabase.ts"]=1
ALLOWED_FILES["src/utils/callIntelligenceDb.ts"]=1
ALLOWED_FILES["src/utils/checklistDatabase.ts"]=1
ALLOWED_FILES["src/utils/complianceDatabase.ts"]=1
ALLOWED_FILES["src/utils/controlledDocumentRegistry.ts"]=1
ALLOWED_FILES["src/utils/database.ts"]=1
ALLOWED_FILES["src/utils/duplicateRadarDatabase.ts"]=1
ALLOWED_FILES["src/utils/eventLogsDatabase.ts"]=1
ALLOWED_FILES["src/utils/excelExport.ts"]=1
ALLOWED_FILES["src/utils/handoffDatabase.ts"]=1
ALLOWED_FILES["src/utils/infographicBuilder.ts"]=1
ALLOWED_FILES["src/utils/knowledgeDatabase.ts"]=1
ALLOWED_FILES["src/utils/kpiDatabase.ts"]=1
ALLOWED_FILES["src/utils/managementReviewDatabase.ts"]=1
ALLOWED_FILES["src/utils/migrationDatabase.ts"]=1
ALLOWED_FILES["src/utils/notificationHub.ts"]=1
ALLOWED_FILES["src/utils/onboardingDatabase.ts"]=1
ALLOWED_FILES["src/utils/pdplDatabase.ts"]=1
ALLOWED_FILES["src/utils/platformHealthPulse.ts"]=1
ALLOWED_FILES["src/utils/policyDatabase.ts"]=1
ALLOWED_FILES["src/utils/rateLimiter.ts"]=1
ALLOWED_FILES["src/utils/rbacDatabase.ts"]=1
ALLOWED_FILES["src/utils/redactHistoricalLogs.ts"]=1
ALLOWED_FILES["src/utils/resendMail.ts"]=1
ALLOWED_FILES["src/utils/riskDatabase.ts"]=1
ALLOWED_FILES["src/utils/scheduledJobs.ts"]=1
ALLOWED_FILES["src/utils/scorecardDatabase.ts"]=1
ALLOWED_FILES["src/utils/toolHealthAlertNotifier.ts"]=1
ALLOWED_FILES["src/utils/toolHealthConfigDatabase.ts"]=1
ALLOWED_FILES["src/utils/userAccessDatabase.ts"]=1
ALLOWED_FILES["src/utils/vendorDatabase.ts"]=1
ALLOWED_FILES["src/utils/aiMetricsRetentionConfig.ts"]=1
ALLOWED_FILES["src/utils/rateLimit429SpikeAlert.ts"]=1
ALLOWED_FILES["src/utils/rbacMiddleware.ts"]=1
ALLOWED_FILES["src/scripts/backfillAiCallMetricsRedaction.ts"]=1

# ---------------------------------------------------------------------------
# Allow-list ceiling — prevents the list from silently growing back (Task #357)
# ---------------------------------------------------------------------------
# Hard cap on how many files may sit on the allow-list. When migrations
# remove entries, lower this number in the same commit so the ratchet only
# moves one way. To raise it you need a documented, reviewed reason.
MAX_ALLOWED_FILES=91

ALLOWED_COUNT=${#ALLOWED_FILES[@]}

echo ""
echo "--- Part 2a: allow-list size ceiling (Task #357) ---"
if [ "$ALLOWED_COUNT" -le "$MAX_ALLOWED_FILES" ]; then
  ok "Allow-list size ${ALLOWED_COUNT} is within the ceiling of ${MAX_ALLOWED_FILES}"
  if [ "$ALLOWED_COUNT" -lt "$MAX_ALLOWED_FILES" ]; then
    echo "    ↳ Ceiling can be lowered to ${ALLOWED_COUNT} in scripts/check-console-logs.sh (MAX_ALLOWED_FILES)."
  fi
else
  fail "Allow-list has grown to ${ALLOWED_COUNT} files, above the ceiling of ${MAX_ALLOWED_FILES}."
  echo ""
  echo "    The console.* allow-list is meant to shrink over time, not grow."
  echo "    To resolve this:"
  echo "      1. Migrate the offending file(s) to logger.ts (preferred), OR"
  echo "      2. If a new infrastructure file legitimately needs console.*,"
  echo "         raise MAX_ALLOWED_FILES in scripts/check-console-logs.sh by"
  echo "         the exact number of files added and explain why in the commit."
fi

echo ""
echo "--- Part 2b: no new files outside the allow-list may use console.* ---"

NEW_VIOLATIONS=0
while IFS= read -r file; do
  # Skip test infrastructure and the logger itself
  case "$file" in
    *".test.ts"|*"__tests__"*|"src/utils/logger.ts") continue ;;
  esac

  # Skip migrated modules — they are already covered (and enforced) in Part 1
  skip=0
  for m in "${MIGRATED_MODULES[@]}"; do
    [ "$file" = "$m" ] && skip=1 && break
  done
  [ $skip -eq 1 ] && continue

  if [ -z "${ALLOWED_FILES[$file]+x}" ]; then
    fail "NEW console.* usage in $file — use logger.info/logger.error from src/utils/logger.ts"
    NEW_VIOLATIONS=$((NEW_VIOLATIONS + 1))
  fi
done < <(grep -rlE 'console\.(log|error|warn|debug)' src/ --include="*.ts" 2>/dev/null | sort)

if [ $NEW_VIOLATIONS -eq 0 ]; then
  ok "No new files outside the allow-list use console.*"
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
