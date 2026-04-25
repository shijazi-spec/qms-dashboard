#!/usr/bin/env bash
# WalaPlus — Inline event-handler guardrail
# ----------------------------------------------------------------------------
# Greps `dashboard/` and `src/mastra/` for inline event-handler attributes
# (onclick=, onsubmit=, onload=, onerror=, onmouseover=, onfocus=, onchange=,
# onkeydown=, onkeyup=, onkeypress=, onblur=, oninput=, onreset=, onselect=,
# ondblclick=, onmousedown=, onmouseup=, onmouseout=, oncontextmenu=,
# ondragstart=, ondrop=, onscroll=, onresize=, onbeforeunload=, onunload=,
# onabort=, oncancel=, onclose=, ontoggle=) and exits non-zero if any matches
# are found, so the strict Content Security Policy documented in
# docs/Security_Operations_SOP.md §5.5 (no inline event handlers under
# script-src 'self' 'nonce-${cspNonce}') does not get silently broken by
# future edits.
#
# How CSP rejects inline event handlers:
#   The CSP `script-src` directive is set to `'self' 'nonce-${cspNonce}'` (plus
#   the Tailwind / jsDelivr CDNs). Browsers block every `onclick="..."` and
#   similar attribute because attribute-level event handlers cannot carry a
#   nonce. The visible symptom is silent interaction breakage in the dashboard.
#
# Allowlist:
#   * Server-side email / report HTML generators are skipped because the HTML
#     they produce is delivered through email clients (which have no CSP) or
#     rendered to PNG/PDF, never served to a browser as a page.
#     See ALLOWLIST_FILES below.
#   * Any individual line tagged with the marker `csp-safe-inline-handler`
#     (e.g. in a `// csp-safe-inline-handler: <reason>` trailing comment) is
#     skipped. Use this sparingly and document the reason in the same comment.
#
# Wiring:
#   * Invoked by `tests/noInlineHandlers.test.ts`, which is auto-discovered by
#     `tests/runIntegrationTests.ts` (`npm test`) so every CI run blocks
#     regressions.
#   * Can also be run standalone: `bash scripts/check-no-inline-handlers.sh`.
# ----------------------------------------------------------------------------

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SEARCH_PATHS=("dashboard" "src/mastra")

# Files exempt from the scan because their inline event-handler attributes are
# emitted into HTML emails or PNG/PDF infographics — never into a browser page
# subject to CSP. Keep this list tiny and explicit.
ALLOWLIST_FILES=(
  "src/mastra/routes/userAccessRoutes.ts"
  "src/mastra/routes/infographicRoutes.ts"
  "src/mastra/tools/emailReportTool.ts"
  "src/mastra/workflows/qualityAuditWorkflow.ts"
)

# Build ripgrep --glob exclusions for the allowlist.
RG_GLOBS=()
for f in "${ALLOWLIST_FILES[@]}"; do
  RG_GLOBS+=(--glob "!${f}")
done

# Pattern: any HTML inline event-handler attribute.
# The word-boundary \b and `=` suffix ensure we match attribute names only, not
# identifiers like `onClickHandler` or JavaScript property assignments that are
# CSP-safe (e.g. `el.onclick = fn`).
PATTERN='\bon(click|submit|load|error|mouseover|focus|change|keydown|keyup|keypress|blur|input|reset|select|dblclick|mousedown|mouseup|mouseout|contextmenu|dragstart|drop|scroll|resize|beforeunload|unload|abort|cancel|close|toggle)='

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for scripts/check-no-inline-handlers.sh" >&2
  exit 2
fi

# Collect raw matches (path:line:content), then drop any line that opted out
# via the `csp-safe-inline-handler` marker.
matches=$(rg --line-number --no-heading --color=never \
  "${RG_GLOBS[@]}" \
  -- "$PATTERN" "${SEARCH_PATHS[@]}" 2>/dev/null \
  | grep -v 'csp-safe-inline-handler' || true)

if [ -n "$matches" ]; then
  count=$(printf '%s\n' "$matches" | wc -l | tr -d ' ')
  echo "✗ Inline handler guardrail FAILED — $count forbidden inline event-handler attribute(s) found:" >&2
  echo "" >&2
  printf '%s\n' "$matches" >&2
  echo "" >&2
  echo "Inline event handlers are blocked by the platform CSP (script-src 'self' 'nonce-…')." >&2
  echo "Fix options:" >&2
  echo "  1. Move the handler to an addEventListener() call in an external .js file (preferred)." >&2
  echo "  2. Use event delegation from a parent element already wired via addEventListener()." >&2
  echo "  3. If the markup is genuinely going into an email or PNG (NOT a browser page)," >&2
  echo "     either add the file to ALLOWLIST_FILES in this script or annotate the line" >&2
  echo "     with a trailing comment containing 'csp-safe-inline-handler: <reason>'." >&2
  echo "" >&2
  echo "See docs/Security_Operations_SOP.md §5.5 for the full CSP policy." >&2
  exit 1
fi

echo "✓ Inline handler guardrail PASS — no forbidden inline event-handler attributes in dashboard/ or src/mastra/."
exit 0
