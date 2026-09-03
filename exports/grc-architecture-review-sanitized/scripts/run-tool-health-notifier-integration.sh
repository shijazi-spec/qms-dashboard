#!/bin/bash
# ----------------------------------------------------------------------------
# Run the tool-health on-call notifier integration test.
#
# Drives `tests/toolHealthAlertNotifier.integration.ts`, which posts to a
# real Slack channel and/or a real Resend inbox using the production
# Block Kit and plaintext renderers — NOT stubs — so broken Block Kit
# shapes, bad subject lines, plaintext truncation, and character-escaping
# bugs are caught before they page on-call at 3 AM.
#
# SKIP behaviour
# ──────────────
# The test file individually self-skips (exits 0) when none of the
# required credential pairs are set. At least one of the following pairs
# must be present for the test to actually run:
#
#   Slack:  SLACK_BOT_TOKEN    — bot token with chat:write scope
#           SLACK_TEST_CHANNEL — channel id/name to receive the test message
#
#   Email:  RESEND_API_KEY     — Resend API key
#           RESEND_TEST_EMAIL  — delivery address (use a Resend test address
#                                if you don't want real mail, e.g.
#                                user@example.invalid)
#
# Optional environment:
#   TOOL_HEALTH_APP_URL          — base origin of the deployed app; when set
#                                  the Slack message will include an
#                                  "Open AI Operations panel" button with
#                                  an absolute URL.
#   TOOL_HEALTH_CONFIG_NOTIFY=1  — opts in to the additional threshold-tuning
#                                  Slack smoke test (`notifyToolHealthConfigChange`).
#                                  Off by default to keep the suite lightweight.
#
# Unlike the RBAC and AI-approval-redaction wrappers, this script does NOT
# hard-fail on missing env vars — the underlying test file is designed to
# self-skip cleanly so the standard `npm test` run can include it
# unconditionally and only exercise it when the optional Slack/Resend
# credentials are wired in for that environment. This wrapper just prints
# an upfront note about which channel(s) will actually be exercised so
# the CI log is easy to scan.
#
# Usage:
#   bash scripts/run-tool-health-notifier-integration.sh
#
# Wired into:
#   - .github/workflows/tool-health-notifier-integration.yml (dedicated CI)
#   - .github/workflows/test.yml via RUN_TOOL_HEALTH_INTEGRATION_E2E=1
#   - tests/runIntegrationTests.ts when RUN_TOOL_HEALTH_INTEGRATION_E2E=1
# ----------------------------------------------------------------------------
set -euo pipefail

slack_ready="no"
email_ready="no"
if [ -n "${SLACK_BOT_TOKEN:-}" ] && [ -n "${SLACK_TEST_CHANNEL:-}" ]; then
  slack_ready="yes (channel: ${SLACK_TEST_CHANNEL})"
fi
if [ -n "${RESEND_API_KEY:-}" ] && [ -n "${RESEND_TEST_EMAIL:-}" ]; then
  email_ready="yes (to: ${RESEND_TEST_EMAIL})"
fi

echo ""
echo "▶ tool-health on-call notifier integration test"
echo "   Slack ready: ${slack_ready}"
echo "   Email ready: ${email_ready}"
if [ "${slack_ready}" = "no" ] && [ "${email_ready}" = "no" ]; then
  echo "   (no credentials configured — the test file will self-skip cleanly)"
fi
echo ""

npx tsx tests/toolHealthAlertNotifier.integration.ts

echo ""
echo "✅ tool-health on-call notifier integration test finished"
