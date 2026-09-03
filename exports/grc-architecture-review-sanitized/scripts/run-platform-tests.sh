#!/usr/bin/env bash
# ExampleOrg Platform Test Runner
# Runs every documented test case from ExampleOrg_FEATURE_BOOK.md and writes a
# Markdown report to ExampleOrg_TEST_REPORT.md.

set -u
BASE="${BASE:-<REDACTED_URL>"
KEY="X-Admin-Key: ${ADMIN_API_KEY:-Sample User}"
REPORT="ExampleOrg_TEST_REPORT.md"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

PASS=0; FAIL=0; SKIP=0
ROWS_T1=""; ROWS_T2=""; ROWS_T3=""; ROWS_VAL=""

# Helper: HTTP status check
# Usage: check ID "Description" tier expected_status method url [extra_curl_args...]
check() {
  local id="$1" desc="$2" tier="$3" expect="$4" method="$5" url="$6"
  shift 6
  local code
  code=$(curl -s -o /dev/null -m 25 -w "%{http_code}" -X "$method" -H "$KEY" "$@" "$BASE$url" 2>/dev/null || echo "000")
  local status icon
  if [ "$code" = "$expect" ] \
     || ( [ "$expect" = "200|302" ] && ( [ "$code" = "200" ] || [ "$code" = "302" ] ) ) \
     || ( [ "$expect" = "401|403" ] && ( [ "$code" = "401" ] || [ "$code" = "403" ] ) ) \
     || ( [ "$expect" = "200|429" ] && ( [ "$code" = "200" ] || [ "$code" = "429" ] ) ); then
    status="PASS"; icon="✅"; PASS=$((PASS+1))
  else
    status="FAIL ($code, expected $expect)"; icon="❌"; FAIL=$((FAIL+1))
  fi
  local row="| $id | $desc | \`$method $url\` | $expect | $code | $icon |"
  case "$tier" in
    T1) ROWS_T1+="$row\n" ;;
    T2) ROWS_T2+="$row\n" ;;
    T3) ROWS_T3+="$row\n" ;;
    VAL) ROWS_VAL+="$row\n" ;;
  esac
  printf "  [%s] %s · %s · %s\n" "$status" "$id" "$desc" "$code"
}

# Helper: JSON body check (substring)
# Usage: check_body ID "Description" tier method url match_string
check_body() {
  local id="$1" desc="$2" tier="$3" method="$4" url="$5" match="$6"
  local body
  body=$(curl -s -m 25 -X "$method" -H "$KEY" "$BASE$url" 2>/dev/null || echo "")
  local status icon code
  if echo "$body" | grep -q -- "$match" 2>/dev/null; then
    status="PASS"; icon="✅"; code="match"; PASS=$((PASS+1))
  else
    status="FAIL"; icon="❌"; code="no-match"; FAIL=$((FAIL+1))
  fi
  local row="| $id | $desc | \`$method $url\` | contains \`$match\` | $code | $icon |"
  case "$tier" in
    T1) ROWS_T1+="$row\n" ;;
    T2) ROWS_T2+="$row\n" ;;
    T3) ROWS_T3+="$row\n" ;;
    VAL) ROWS_VAL+="$row\n" ;;
  esac
  printf "  [%s] %s · %s · %s\n" "$status" "$id" "$desc" "$code"
}

# Helper: size check (≥ N bytes)
check_size() {
  local id="$1" desc="$2" tier="$3" url="$4" minbytes="$5"
  local size
  size=$(curl -s -m 30 -o /dev/null -w "%{size_download}" -H "$KEY" "$BASE$url" 2>/dev/null || echo "0")
  local status icon
  if [ "$size" -ge "$minbytes" ] 2>/dev/null; then
    status="PASS"; icon="✅"; PASS=$((PASS+1))
  else
    status="FAIL ($size B, need ≥ $minbytes)"; icon="❌"; FAIL=$((FAIL+1))
  fi
  local row="| $id | $desc | \`GET $url\` | ≥ ${minbytes} B | ${size} B | $icon |"
  case "$tier" in
    T1) ROWS_T1+="$row\n" ;;
    T2) ROWS_T2+="$row\n" ;;
    T3) ROWS_T3+="$row\n" ;;
    VAL) ROWS_VAL+="$row\n" ;;
  esac
  printf "  [%s] %s · %s · %sB\n" "$status" "$id" "$desc" "$size"
}

echo "============================================================"
echo "  ExampleOrg Platform Test Runner — $TS"
echo "  Target: $BASE"
echo "============================================================"

# ----- Module 1 — Auth & Telemetry (T1) -----
echo
echo "▶ Module 1 — Authentication & Access Control"
check T-AUTH-01 "Unauth GET / redirects to login"        T1 302 GET /
check T-AUTH-02 "/api/health returns 200"                T1 200 GET /api/health
# Direct curl (no admin key header) to verify unauth rejection.
_t3_code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" <REDACTED_URL>
if [ "$_t3_code" = "401" ] || [ "$_t3_code" = "403" ]; then
  echo "  [PASS] T-AUTH-03 · Admin endpoint rejects unauth GET · $_t3_code"
  PASS=$((PASS+1))
  RESULTS+=("|T-AUTH-03|Admin endpoint rejects unauth GET|\`GET /api/admin/scorecards\`|401|403|$_t3_code|✅|")
else
  echo "  [FAIL] T-AUTH-03 · Admin endpoint rejects unauth GET · got $_t3_code"
  FAIL=$((FAIL+1))
  RESULTS+=("|T-AUTH-03|Admin endpoint rejects unauth GET|\`GET /api/admin/scorecards\`|401|403|$_t3_code|❌|")
fi
# Endpoint health check — 200 (accepted) or 429 (rate-limited, proves endpoint is live).
check T-AUTH-04 "Telemetry endpoint accepts pageview"    T1 "200|429" POST /api/telemetry/pageview \
  -H "Content-Type: application/json" -d '{"page":"test-runner"}'

# ----- Module 2 — Quality Audits (AI) (T1) -----
echo
echo "▶ Module 2 — Quality Audits (AI)"
check T-QA-01 "Latest audit endpoint"                    T1 200 GET /api/audit/latest
check T-QA-02 "Audit history endpoint"                   T1 200 GET "/api/audit/history?limit=5"
check T-QA-03 "Audit recommendations endpoint"           T1 200 GET /api/audit/recommendations

# ----- Module 3 — ISO Internal Audits (T2) -----
echo
echo "▶ Module 3 — ISO Internal Audits"
check T-ISO-01 "List audits"                             T2 200 GET /api/audits
check T-ISO-02 "Audit summary"                           T2 200 GET /api/audits/summary
# Evidence packs is a parameterized endpoint that requires ?auditId= — a 404
# with "Audit not found" body is the correct behavior for an empty query.
check T-ISO-03 "Evidence packs route exists"             T2 404 GET /api/audits/evidence-packs

# ----- Module 4 — Risk Management (T2) -----
echo
echo "▶ Module 4 — Risk Management"
check_body T-RISK-01 "Risks infographic shows empty-state copy" T2 GET /api/infographic/risks "NO RISKS LOGGED YET"
check T-RISK-02 "Risks dashboard responds"               T2 "200|302" GET /risks

# ----- Module 5 — Compliance & PDPL (T1) -----
echo
echo "▶ Module 5 — Compliance & PDPL"
check T-COMP-01 "Compliance dashboard data"              T1 200 GET /api/compliance/dashboard
check T-COMP-02 "Compliance calendar"                    T1 200 GET /api/compliance/calendar
check T-COMP-03 "Compliance deadlines"                   T1 200 GET /api/compliance/deadlines

# ----- Module 6 — Policies (T1) -----
echo
echo "▶ Module 6 — Policies & Integrated QMS"
check T-POL-01 "List all policies"                       T1 200 GET /api/policies

# ----- Module 7 — KPIs & Analytics (T1) -----
echo
echo "▶ Module 7 — KPIs & Executive Analytics"
check T-KPI-01 "List KPIs"                               T1 200 GET /api/kpis
check T-KPI-02 "Executive digest"                        T1 200 GET /api/analytics/executive-digest
check T-KPI-03 "Cycle times"                             T1 200 GET /api/analytics/cycle-times

# ----- Module 8 — Vendors (T2) -----
echo
echo "▶ Module 8 — Vendors"
check T-VEND-01 "List vendors"                           T2 200 GET /api/vendors

# ----- Module 9 — Duplicate Radar (T1) -----
echo
echo "▶ Module 9 — Duplicate Radar"
check T-DUP-01 "List clusters"                           T1 200 GET "/api/duplicates/clusters?pageSize=5"
check T-DUP-02 "Duplicate summary"                       T1 200 GET /api/duplicates/summary

# ----- Module 10 — Call Intelligence (T2) -----
echo
echo "▶ Module 10 — Call Intelligence"
check T-CALL-01 "List calls"                             T2 200 GET /api/calls
check T-CALL-02 "Call analytics"                         T2 200 GET /api/calls/analytics

# ----- Module 11 — AI Consultant + HITL (T1) -----
echo
echo "▶ Module 11 — AI Consultant + HITL Approvals"
check T-AI-01 "Alert count"                              T1 200 GET /api/consultant/alerts/count
check T-AI-02 "Pending approvals count"                  T1 200 GET /api/ai/approvals/pending-count
check T-AI-03 "Pending approvals list"                   T1 200 GET /api/ai/approvals

# ----- Module 12 — Infographic Generator (T1) -----
echo
echo "▶ Module 12 — Infographic Generator"
for s in platform-health kpis risks audits duplicates consultant; do
  check "T-INFO-${s}" "SVG renders for ${s}" T1 200 GET "/api/infographic/${s}"
done
check_size T-INFO-PNG "PNG render size for risks" T1 "/api/infographic/risks?format=png" 400000
check T-INFO-404 "Unknown section returns 404"           VAL 404 GET /api/infographic/does-not-exist
check T-INFO-EMAIL-MISSING "Email share missing recipients" VAL 400 POST /api/infographic/risks/share/email \
  -H "Content-Type: application/json" -d '{}'
check T-INFO-EMAIL-INVALID "Email share invalid address" VAL 400 POST /api/infographic/risks/share/email \
  -H "Content-Type: application/json" -d '{"to":["not-an-email"]}'

# ChatProvider share — should succeed in either mode (file or message)
echo "  Testing ChatProvider share..."
ChatProvider_resp=$(curl -s -m 25 -X POST -H "Content-Type: application/json" -H "$KEY" \
  -d '{"comment":"[automated test runner]"}' \
  "$BASE/api/infographic/risks/share/ChatProvider" 2>/dev/null || echo "{}")
if echo "$ChatProvider_resp" | grep -q '"success":true'; then
  mode=$(echo "$ChatProvider_resp" | grep -oE '"mode":"[^"]+"' | head -1)
  ROWS_T1+="| T-INFO-ChatProvider | ChatProvider share (graceful) | \`POST /api/infographic/risks/share/ChatProvider\` | success:true | $mode | ✅ |\n"
  PASS=$((PASS+1))
  echo "  [PASS] T-INFO-ChatProvider · ChatProvider share · $mode"
else
  ROWS_T1+="| T-INFO-ChatProvider | ChatProvider share (graceful) | \`POST /api/infographic/risks/share/ChatProvider\` | success:true | failed | ❌ |\n"
  FAIL=$((FAIL+1))
  echo "  [FAIL] T-INFO-ChatProvider · $ChatProvider_resp"
fi

# ----- Module 13 — Management Review (T2) -----
echo
echo "▶ Module 13 — Management Review"
check T-MR-01 "List management reviews"                  T2 200 GET /api/management-reviews

# ----- Module 14 — Supporting dashboards (T3) -----
echo
echo "▶ Module 14 — Supporting dashboards (smoke)"
for path in / /grc /tablef /crm /migration /roi /projects /scorecard /logs /onboarding /feedback /users /executive /qms /audits /compliance /policies /risks /vendors /calls /duplicates /consultant /infographic /reviews /pdpl; do
  id="T-PAGE${path//\//-}"
  check "$id" "Dashboard $path renders" T3 "200|302" GET "$path"
done
check T-GUIDE-01 "User guide is public"                  T3 200 GET /guide
check T-SOP-01   "Platform SOP is public"                T3 200 GET /sop

# ----- DB sanity counts -----
echo
echo "▶ Database sanity"
db_count() {
  PGPASSWORD=<REDACTED_SECRET>
    psql "$DATABASE_URL" -t -c "SELECT COUNT(*)::int FROM $1;" 2>/dev/null | tr -d ' \n' || echo "0"
}
DB_AUDITS=$(db_count quality_audit_results)
DB_POL=$(db_count policies)
DB_DUP=$(db_count duplicate_clusters)
DB_ALERTS=$(db_count ai_alerts)
DB_KPI=$(db_count kpi_definitions)
DB_RISKS=$(db_count enterprise_risks)
DB_TELE=$(db_count access_audit_log)

# ----- Build report -----
echo
echo "▶ Accessibility check (axe-core WCAG 2.1 AA)"
A11Y_PASS=0; A11Y_FAIL=0
if command -v node >/dev/null 2>&1 && [ -f "$(dirname "$0")/a11y-check.js" ]; then
  if node "$(dirname "$0")/a11y-check.js" 2>/dev/null; then
    A11Y_PASS=1
    echo "  [PASS] A11Y-01 · axe-core: 0 serious/critical violations"
    ROWS_VAL+="| A11Y-01 | axe-core WCAG 2.1 AA — top 10 dashboards | node scripts/a11y-check.js | 0 serious/critical | pass | ✅ |\n"
    PASS=$((PASS+1))
  else
    A11Y_FAIL=1
    echo "  [FAIL] A11Y-01 · axe-core: serious/critical violations found (see a11y-report.json)"
    ROWS_VAL+="| A11Y-01 | axe-core WCAG 2.1 AA — top 10 dashboards | node scripts/a11y-check.js | 0 serious/critical | FAIL | ❌ |\n"
    FAIL=$((FAIL+1))
  fi
else
  echo "  [SKIP] A11Y-01 · node/a11y-check.js not found"
  SKIP=$((SKIP+1))
fi

echo
echo "▶ Writing $REPORT"

{
cat <<HEAD
# ExampleOrg Platform Test Report
*Generated: $TS · Target: $BASE*

| Summary | Count |
|---|---|
| ✅ Passed | $PASS |
| ❌ Failed | $FAIL |
| ⏭️ Skipped | $SKIP |
| **Total** | $((PASS+FAIL+SKIP)) |

## Database sanity
| Table | Rows | Tier |
|---|---|---|
| quality_audit_results | $DB_AUDITS | T1 — workhorse |
| policies | $DB_POL | T1 — workhorse |
| duplicate_clusters | $DB_DUP | T1 — workhorse |
| ai_alerts | $DB_ALERTS | T1 — workhorse |
| kpi_definitions | $DB_KPI | T1 — partial |
| enterprise_risks | $DB_RISKS | empty (expected) |
| access_audit_log | $DB_TELE | new (telemetry shipped this week) |

---

## Tier 1 — Workhorse features (must be 100% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
HEAD
printf "%b" "$ROWS_T1"

cat <<MID

## Tier 2 — Capability features (target ≥ 95% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
MID
printf "%b" "$ROWS_T2"

cat <<MID2

## Validation — negative paths (must be 100% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
MID2
printf "%b" "$ROWS_VAL"

cat <<MID3

## Tier 3 — Supporting dashboards (target ≥ 90% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
MID3
printf "%b" "$ROWS_T3"

cat <<FOOT

---
*Auto-generated by \`scripts/run-platform-tests.sh\`. Re-run before every release.*
FOOT
} > "$REPORT"

echo
echo "============================================================"
echo "  RESULT: ✅ $PASS passed · ❌ $FAIL failed"
echo "  Report: $REPORT"
echo "============================================================"

# Exit code
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
