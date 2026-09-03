#!/usr/bin/env bash
# ExampleOrg — Inline-style guardrail
# ----------------------------------------------------------------------------
# Greps `dashboard/` and `src/mastra/` for ` style="` attributes and exits
# non-zero if any are found, so the strict Content Security Policy documented
# in docs/Security_Operations_SOP.md §5.5 (no `'unsafe-inline'` for styles)
# does not get silently broken by future edits.
#
# How CSP rejects inline styles:
#   The CSP `style-src` directive is set to `'self' 'nonce-${cspNonce}'` (plus
#   the Tailwind / Google Fonts CDNs). Browsers reject every `style="..."`
#   attribute on an element because the attribute cannot carry a nonce. The
#   visible symptom is silent layout breakage in the dashboard.
#
# Allowlist:
#   * CSS files (`*.css`) are skipped — they ARE the styling layer.
#   * Server-side email / report HTML generators are skipped because the HTML
#     they produce is delivered through email clients (which require inline
#     styles and do not enforce CSP) or rendered to PNG/PDF, never served to
#     a browser as a page. See ALLOWLIST_FILES below.
#   * Any individual line tagged with the marker `csp-safe-inline-style`
#     (e.g. in a `// csp-safe-inline-style: …` trailing comment) is skipped.
#     Use this sparingly and document the reason in the same comment.
#
# Wiring:
#   * Invoked by `tests/noInlineStyles.test.ts`, which is auto-discovered by
#     `tests/runIntegrationTests.ts` (`npm test`) so every CI run blocks
#     regressions.
#   * Can also be run standalone: `bash scripts/check-no-inline-styles.sh`.
# ----------------------------------------------------------------------------

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SEARCH_PATHS=("dashboard" "src/mastra")

# Files exempt from the scan because their inline `style="..."` attributes are
# emitted into HTML emails or PNG/PDF infographics — never into a browser page
# subject to CSP. Keep this list tiny and explicit.
ALLOWLIST_FILES=(
  "src/mastra/routes/userAccessRoutes.ts"
  "src/mastra/routes/infographicRoutes.ts"
  "src/mastra/tools/emailReportTool.ts"
  "src/mastra/workflows/qualityAuditWorkflow.ts"
  # Sends prompt-regression / recovery alert emails via Slack/email — the
  # `style="..."` attributes go into the HTML body of an email, never into
  # a browser page subject to CSP.
  "src/mastra/workflows/promptRegressionAlertsCron.ts"
  # Tech-request response email sent to the assignee — the `style="..."`
  # attributes are in the email HTML body, never in a browser page.
  "src/mastra/routes/techRequestRoutes.ts"
  # Handoff-task notification email sent to the responsible party — same
  # email-only context as techRequestRoutes above.
  "src/mastra/routes/handoffTaskRoutes.ts"
)

# Build ripgrep --glob exclusions for the allowlist + CSS files.
RG_GLOBS=(--glob '!**/*.css')
for f in "${ALLOWLIST_FILES[@]}"; do
  RG_GLOBS+=(--glob "!${f}")
done

# Pattern: literal ` style="` (leading space anchors to attribute usage and
# avoids matching identifiers like `myStyle="..."` or CSS `font-style:`).
PATTERN=' style="'

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: ripgrep (rg) is required for scripts/check-no-inline-styles.sh" >&2
  exit 2
fi

# Collect raw matches (path:line:content), then drop any line that opted out
# via the `csp-safe-inline-style` marker.
matches=$(rg --line-number --no-heading --color=never \
  "${RG_GLOBS[@]}" \
  -- "$PATTERN" "${SEARCH_PATHS[@]}" 2>/dev/null \
  | grep -v 'csp-safe-inline-style' || true)

if [ -n "$matches" ]; then
  count=$(printf '%s\n' "$matches" | wc -l | tr -d ' ')
  echo "✗ Inline style guardrail FAILED — $count forbidden \` style=\"\` attribute(s) found:" >&2
  echo "" >&2
  printf '%s\n' "$matches" >&2
  echo "" >&2
  echo "Inline styles are blocked by the platform CSP (style-src 'self' 'nonce-…')." >&2
  echo "Fix options:" >&2
  echo "  1. Move the rule into dashboard/css/utilities.css (preferred for static styles)." >&2
  echo "  2. Use Tailwind utility classes already loaded on the page." >&2
  echo "  3. For dynamic per-element values, use the data-style=\"prop:val;…\" pattern" >&2
  echo "     handled by /js/csp-styles.js (CSSOM property assignment is CSP-safe)." >&2
  echo "  4. If the markup is genuinely going into an email or PNG (NOT a browser page)," >&2
  echo "     either add the file to ALLOWLIST_FILES in this script or annotate the line" >&2
  echo "     with a trailing comment containing 'csp-safe-inline-style: <reason>'." >&2
  echo "" >&2
  echo "See docs/Security_Operations_SOP.md §5.5 for the full CSP policy." >&2
  exit 1
fi

echo "✓ Inline style guardrail PASS — no forbidden inline styles in dashboard/ or src/mastra/."
exit 0
