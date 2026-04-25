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
# nonce on every script tag at request time, so this catches pages that
# accidentally bypass the global middleware and would silently fail in
# production.) Pages legitimately served via the middleware are listed in
# `INLINE_SCRIPT_NONCE_ALLOWLIST` inside `scripts/check-handlers.cjs`; new
# HTML pages must either be added to that allowlist (with confirmation that
# they're served via the middleware) or use external `<script src=…>` tags.
#
# Usage:
#   scripts/lint-dashboard-handlers.sh
#   scripts/lint-dashboard-handlers.sh --check-inline-scripts
#
# CI hook: wired into `scripts/post-merge.sh` with `--check-inline-scripts`
# enabled (Task #248). All dashboard HTML files — including the previously
# outstanding ai-ops.html and consultant.html — have been fully migrated to
# the `data-on-{event}` pattern (Task #209) and listed in the allowlist.
# Run manually before committing changes to any `dashboard/*.html`.

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/scripts/check-handlers.cjs" "$@"
