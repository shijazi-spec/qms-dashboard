#!/usr/bin/env bash
# WalaPlus — auth cookie security-flag guardrail (session + oauth_data)
# ----------------------------------------------------------------------------
# Sibling to `scripts/check-admin-cookie-flags.sh`. That script enforces the
# strict policy for the `admin_key` cookie (HttpOnly + Secure + SameSite=Strict
# unconditionally). This script enforces the documented policy for the two
# OIDC-flow auth cookies that are allowed to omit `Secure` only on plain-HTTP
# local development (gated by `isSecureDomain()`):
#
#   * walaplus_session   — HttpOnly, SameSite=Lax, Path=/, and `Secure` either
#                          unconditional or via the `${secure ? "; Secure" : ""}`
#                          ternary derived from isSecureDomain().
#   * oauth_data         — same invariants as walaplus_session (short-lived
#                          PKCE/state envelope, 600s max-age).
#
# The cookie-by-cookie policy lives in `docs/Security_Operations_SOP.md`
# § 5.7 ("Auth Cookie Inventory"). Update both this script and that table
# together if the policy ever changes.
#
# Background:
#   The admin_key cookie was silently missing SameSite=Strict for a period of
#   time, caught only by manual review. The admin guardrail prevents that
#   recurrence on admin_key. This sibling guardrail extends the same static
#   protection to walaplus_session + oauth_data so a future edit cannot
#   silently drop HttpOnly, SameSite, Path, or the `Secure` ternary on either
#   cookie without failing CI.
#
# How the scan resolves cookie strings:
#   The cookie body may be written inline as a single template literal, e.g.
#       c.header("Set-Cookie", `oauth_data=${oauthData}; ${cookieBase}`);
#   …where the `${...}` is a separately-defined cookie-flag variable. For each
#   matched `Set-Cookie ... <cookie>=` line we extract `${varName}`
#   interpolations and append the matching `const|let|var varName = ...`
#   lines from the same file before checking for the required flags.
#
# Wiring:
#   * Invoked by `tests/authCookieFlags.test.ts`, which is auto-discovered by
#     `tests/runIntegrationTests.ts` (`npm test`), so every CI run on every PR
#     blocks regressions.
#   * Can also be run standalone: `bash scripts/check-auth-cookie-flags.sh`.
# ----------------------------------------------------------------------------

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ROUTES_DIR="src/mastra/routes"

if [ ! -d "$ROUTES_DIR" ]; then
  echo "ERROR: routes directory not found: $ROOT/$ROUTES_DIR" >&2
  exit 2
fi

# Cookie name -> required flag substrings (space-separated).
# `Secure` is matched as a substring, so the documented conditional form
#   `${secure ? "; Secure" : ""}`
# satisfies the check while still failing closed if the literal `Secure`
# token is removed entirely.
# Per-cookie scan pattern: an extended-regex alternation that matches both
# the literal cookie name and any documented `${VAR}` interpolation that
# resolves to it. Update the alternation if the source ever renames the
# constant (and update docs/Security_Operations_SOP.md § 5.7 to match).
COOKIES=("walaplus_session" "oauth_data")
# Patterns anchor on the opening backtick of the cookie's template literal so
# we match only actual Set-Cookie payload strings (not, e.g., a regex that
# parses an inbound `oauth_data=...` cookie). This means our scan no longer
# requires the literal "Set-Cookie" string to live on the same source line —
# important because some routes pass Set-Cookie via the `[header, value]`
# response-init array form, where the header name and the cookie body are on
# different lines.
PATTERN_walaplus_session='`(walaplus_session|\$\{SESSION_COOKIE_NAME\})='
REQUIRED_walaplus_session=("HttpOnly" "Secure" "SameSite=Lax" "Path=/")
PATTERN_oauth_data='`oauth_data='
REQUIRED_oauth_data=("HttpOnly" "Secure" "SameSite=Lax" "Path=/")

failed=0
total_checked=0

scan_cookie() {
  local cookie_name="$1"
  local cookie_pattern="$2"
  shift 2
  local required=("$@")

  local checked=0

  while IFS= read -r -d '' file; do
    while IFS=: read -r linenum content; do
      [ -z "$linenum" ] && continue
      # Skip lines that use the cookie name in a parser/matcher context
      # (RegExp construction, .match() argument, etc.) rather than emitting a
      # Set-Cookie payload. These read inbound cookies and have no security
      # flags to enforce.
      case "$content" in
        *RegExp\(*|*.match\(*) continue ;;
      esac
      checked=$((checked + 1))
      total_checked=$((total_checked + 1))

      # Resolve the cookie attribute string by appending the contents of any
      # `${varName}` interpolation referenced on this line — looked up as
      # `const|let|var varName =` definitions in the same file.
      local resolved="$content"
      local interpolations
      interpolations="$(printf '%s' "$content" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' | sed -E 's/^\$\{//; s/\}$//' | sort -u || true)"
      local varname
      for varname in $interpolations; do
        local def_lines
        def_lines="$(grep -E "(^|[[:space:]])(const|let|var)[[:space:]]+${varname}[[:space:]]*=" "$file" || true)"
        if [ -n "$def_lines" ]; then
          resolved="${resolved}"$'\n'"${def_lines}"
        fi
      done

      local missing=()
      local flag
      for flag in "${required[@]}"; do
        if ! printf '%s' "$resolved" | grep -qF "$flag"; then
          missing+=("$flag")
        fi
      done

      if [ "${#missing[@]}" -gt 0 ]; then
        failed=1
        echo "✗ ${cookie_name} cookie missing required flag(s): ${missing[*]}" >&2
        echo "    File:   $file:$linenum" >&2
        echo "    Source: $(printf '%s' "$content" | sed 's/^[[:space:]]*//')" >&2
        echo "" >&2
      fi
    done < <(grep -nE "${cookie_pattern}" "$file" 2>/dev/null || true)
  done < <(find "$ROUTES_DIR" -type f -name '*.ts' ! -name '*.d.ts' ! -name '*.test.ts' ! -name '*.integration.ts' -print0)

  if [ "$checked" -eq 0 ]; then
    echo "ERROR: no ${cookie_name} Set-Cookie headers were found under $ROUTES_DIR." >&2
    echo "       Either the cookie has been renamed (update this script + docs/Security_Operations_SOP.md § 5.7)" >&2
    echo "       or the scan path is wrong. Refusing to silently pass." >&2
    exit 2
  fi
}

scan_cookie "walaplus_session" "$PATTERN_walaplus_session" "${REQUIRED_walaplus_session[@]}"
scan_cookie "oauth_data" "$PATTERN_oauth_data" "${REQUIRED_oauth_data[@]}"

if [ "$failed" -ne 0 ]; then
  echo "Auth cookie security guardrail FAILED — every Set-Cookie header that emits" >&2
  echo "walaplus_session or oauth_data must carry HttpOnly, SameSite=Lax, Path=/, and" >&2
  echo "Secure (either unconditional or via the documented \`\${secure ? \"; Secure\" : \"\"}\`" >&2
  echo "ternary derived from isSecureDomain()). See docs/Security_Operations_SOP.md § 5.7." >&2
  exit 1
fi

echo "✓ auth cookie guardrail PASS — all ${total_checked} Set-Cookie header(s) for walaplus_session + oauth_data carry HttpOnly, Secure, SameSite=Lax, Path=/."
exit 0
