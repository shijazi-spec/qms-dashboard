#!/bin/bash
set -e

npm install

# ----------------------------------------------------------------------------
# CI gate — secret-redaction tests
#
# Blocks the build if any future change bypasses the redactSensitiveFields()
# helper or removes a deny-list pattern, which would let raw secrets
# (password_hash, mfa_secret, access_token, refresh_token, api_key, …) leak
# into event_logs / change_history.
#
# See src/utils/redactSensitiveFields.test.ts and Task #37.
# ----------------------------------------------------------------------------
echo ""
echo "▶ CI gate: redactSensitiveFields + logEvent write-path tests"
npx tsx src/utils/redactSensitiveFields.test.ts
