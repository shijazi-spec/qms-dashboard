#!/usr/bin/env bash
# ExampleOrg — admin_key cookie security-flag guardrail
# ----------------------------------------------------------------------------
# Scans every `src/mastra/routes/*.ts` file for `Set-Cookie` headers that
# emit the `admin_key` cookie (whether on POST /api/admin/auth login,
# /api/auth/logout, /api/logout, or any future route) and asserts that each
# emitted cookie carries ALL THREE required security flags:
#
#   * HttpOnly        — blocks JavaScript access (defends against XSS).
#   * Secure          — forces HTTPS-only transmission.
#   * SameSite=Strict — blocks cross-site request forgery (CSRF).
#
# Background:
#   The admin_key cookie was silently missing SameSite=Strict for a period of
#   time — caught only by manual review. This guardrail prevents recurrence by
#   failing CI on the next push the moment any of the three flags is dropped.
#
# How the scan resolves cookie strings:
#   The cookie body may be written inline as a single template literal, e.g.
#       c.header('Set-Cookie', `admin_key=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
#   …or it may interpolate a separately-defined `*Flags` variable, e.g.
#       const adminKeyCookieFlags = `<REDACTED_SECRET>`;
#       c.header('Set-Cookie', `admin_key=; ${adminKeyCookieFlags}`, { append: true });
#   For each `Set-Cookie ... admin_key=`<REDACTED_SECRET>`${varName}`
#   interpolations and append the matching `const|let|var varName = ...` lines
#   from the same file before checking for the required flags.
#
# Wiring:
#   * Invoked by `tests/adminCookieFlags.test.ts`, which is auto-discovered by
#     `tests/runIntegrationTests.ts` (`npm test`), so every CI run on every PR
#     blocks regressions.
#   * Can also be run standalone: `bash scripts/check-admin-cookie-flags.sh`.
# ----------------------------------------------------------------------------

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REQUIRED_FLAGS=("HttpOnly" "Secure" "SameSite=Strict")
ROUTES_DIR="src/mastra/routes"

if [ ! -d "$ROUTES_DIR" ]; then
  echo "ERROR: routes directory not found: $ROOT/$ROUTES_DIR" >&2
  exit 2
fi

failed=0
checked=0

# Iterate every .ts file under the routes directory. Skipping .d.ts files.
while IFS= read -r -d '' file; do
  # Find every line that emits a Set-Cookie header containing `admin_key=`.
  # The pattern intentionally matches both the inline form
  #   `admin_key=${key}; ... HttpOnly; Secure; SameSite=Strict; ...`
  # and the variable-interpolation form
  #   `admin_key=; ${adminKeyCookieFlags}`.
  while IFS=: read -r linenum content; do
    [ -z "$linenum" ] && continue
    checked=$((checked + 1))

    # Resolve the full cookie attribute string by appending the contents of
    # any `${varName}` interpolation referenced on this line — looked up as
    # `const|let|var varName =` definitions in the same file. The required
    # flags can then be matched against the union of inline + resolved text.
    resolved="$content"
    interpolations="$(printf '%s' "$content" | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' | sed -E 's/^\$\{//; s/\}$//' | sort -u || true)"
    for varname in $interpolations; do
      def_lines="$(grep -E "(^|[[:space:]])(const|let|var)[[:space:]]+${varname}[[:space:]]*=" "$file" || true)"
      if [ -n "$def_lines" ]; then
        resolved="${resolved}"$'\n'"${def_lines}"
      fi
    done

    missing=()
    for flag in "${REQUIRED_FLAGS[@]}"; do
      if ! printf '%s' "$resolved" | grep -qF "$flag"; then
        missing+=("$flag")
      fi
    done

    if [ "${#missing[@]}" -gt 0 ]; then
      failed=1
      echo "✗ admin_key cookie missing required flag(s): ${missing[*]}" >&2
      echo "    File:   $file:$linenum" >&2
      echo "    Source: $(printf '%s' "$content" | sed 's/^[[:space:]]*//')" >&2
      echo "" >&2
    fi
  done < <(grep -nE "Set-Cookie.*admin_key="<REDACTED_SECRET>"$file" 2>/dev/null || true)
done < <(find "$ROUTES_DIR" -type f -name '*.ts' ! -name '*.d.ts' -print0)

if [ "$checked" -eq 0 ]; then
  echo "ERROR: no admin_key Set-Cookie headers were found under $ROUTES_DIR." >&2
  echo "       Either the cookie has been renamed (update this script + the docstring)" >&2
  echo "       or the scan path is wrong. Refusing to silently pass." >&2
  exit 2
fi

if [ "$failed" -ne 0 ]; then
  echo "Cookie security guardrail FAILED — every Set-Cookie header that emits" >&2
  echo "the admin_key cookie must carry HttpOnly, Secure, and SameSite=Strict." >&2
  echo "Add the missing flag(s) to the cookie string (or to the *Flags variable" >&2
  echo "it interpolates) and re-run \`bash scripts/check-admin-cookie-flags.sh\`." >&2
  exit 1
fi

echo "✓ admin_key cookie guardrail PASS — all $checked Set-Cookie header(s) under $ROUTES_DIR carry HttpOnly, Secure, SameSite=Strict."
exit 0
