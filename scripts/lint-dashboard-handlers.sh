#!/usr/bin/env bash
# WalaPlus dashboard CSP guard.
#
# Fails (exit 1) if any file under `dashboard/*.html` contains an inline
# event-handler attribute (`onclick=`, `onchange=`, `onsubmit=`, `oninput=`,
# `on*=` …). These attributes are silently blocked by the dashboard CSP
# (`script-src` no longer allows `'unsafe-inline'`) so the affected
# button/select would do nothing in production.
#
# Pass `--check-inline-scripts` to additionally flag bare `<script>...</script>`
# blocks that lack a `nonce=` attribute. (The CSP middleware auto-injects a
# nonce on every script tag at request time, so this opt-in check is
# defence-in-depth for routes that bypass the global middleware.)
#
# Usage:
#   scripts/lint-dashboard-handlers.sh
#   scripts/lint-dashboard-handlers.sh --check-inline-scripts
#
# CI hook: invoke from `scripts/post-merge.sh` once the two outstanding
# dashboards (ai-ops.html, consultant.html) have been migrated to the
# `data-on-{event}` pattern. Until then, run it manually before committing
# changes to any `dashboard/*.html`.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/.local/scripts/check-handlers.cjs" "$@"
