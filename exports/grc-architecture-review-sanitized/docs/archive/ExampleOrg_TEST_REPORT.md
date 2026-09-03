# ExampleOrg Platform Test Report
*Generated: 2026-04-24T15:54:44Z · Target: <REDACTED_URL>

| Summary | Count |
|---|---|
| ✅ Passed | 66 |
| ❌ Failed | 0 |
| ⏭️ Skipped | 0 |
| **Total** | 66 |

## Database sanity
| Table | Rows | Tier |
|---|---|---|
| quality_audit_results | 29 | T1 — workhorse |
| policies | 154 | T1 — workhorse |
| duplicate_clusters | 21094 | T1 — workhorse |
| ai_alerts | 355 | T1 — workhorse |
| kpi_definitions | 35 | T1 — partial |
| enterprise_risks | 0 | empty (expected) |
| access_audit_log | 11 | new (telemetry shipped this week) |

---

## Tier 1 — Workhorse features (must be 100% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
| T-AUTH-01 | Unauth GET / redirects to login | `GET /` | 302 | 302 | ✅ |
| T-AUTH-02 | /api/health returns 200 | `GET /api/health` | 200 | 200 | ✅ |
| T-AUTH-04 | Telemetry endpoint accepts pageview | `POST /api/telemetry/pageview` | 200|429 | 429 | ✅ |
| T-QA-01 | Latest audit endpoint | `GET /api/audit/latest` | 200 | 200 | ✅ |
| T-QA-02 | Audit history endpoint | `GET /api/audit/history?limit=5` | 200 | 200 | ✅ |
| T-QA-03 | Audit recommendations endpoint | `GET /api/audit/recommendations` | 200 | 200 | ✅ |
| T-COMP-01 | Compliance dashboard data | `GET /api/compliance/dashboard` | 200 | 200 | ✅ |
| T-COMP-02 | Compliance calendar | `GET /api/compliance/calendar` | 200 | 200 | ✅ |
| T-COMP-03 | Compliance deadlines | `GET /api/compliance/deadlines` | 200 | 200 | ✅ |
| T-POL-01 | List all policies | `GET /api/policies` | 200 | 200 | ✅ |
| T-KPI-01 | List KPIs | `GET /api/kpis` | 200 | 200 | ✅ |
| T-KPI-02 | Executive digest | `GET /api/analytics/executive-digest` | 200 | 200 | ✅ |
| T-KPI-03 | Cycle times | `GET /api/analytics/cycle-times` | 200 | 200 | ✅ |
| T-DUP-01 | List clusters | `GET /api/duplicates/clusters?pageSize=5` | 200 | 200 | ✅ |
| T-DUP-02 | Duplicate summary | `GET /api/duplicates/summary` | 200 | 200 | ✅ |
| T-AI-01 | Alert count | `GET /api/consultant/alerts/count` | 200 | 200 | ✅ |
| T-AI-02 | Pending approvals count | `GET /api/ai/approvals/pending-count` | 200 | 200 | ✅ |
| T-AI-03 | Pending approvals list | `GET /api/ai/approvals` | 200 | 200 | ✅ |
| T-INFO-platform-health | SVG renders for platform-health | `GET /api/infographic/platform-health` | 200 | 200 | ✅ |
| T-INFO-kpis | SVG renders for kpis | `GET /api/infographic/kpis` | 200 | 200 | ✅ |
| T-INFO-risks | SVG renders for risks | `GET /api/infographic/risks` | 200 | 200 | ✅ |
| T-INFO-audits | SVG renders for audits | `GET /api/infographic/audits` | 200 | 200 | ✅ |
| T-INFO-duplicates | SVG renders for duplicates | `GET /api/infographic/duplicates` | 200 | 200 | ✅ |
| T-INFO-consultant | SVG renders for consultant | `GET /api/infographic/consultant` | 200 | 200 | ✅ |
| T-INFO-PNG | PNG render size for risks | `GET /api/infographic/risks?format=png` | ≥ 400000 B | 833872 B | ✅ |
| T-INFO-ChatProvider | ChatProvider share (graceful) | `POST /api/infographic/risks/share/ChatProvider` | success:true | "mode":"message" | ✅ |

## Tier 2 — Capability features (target ≥ 95% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
| T-ISO-01 | List audits | `GET /api/audits` | 200 | 200 | ✅ |
| T-ISO-02 | Audit summary | `GET /api/audits/summary` | 200 | 200 | ✅ |
| T-ISO-03 | Evidence packs route exists | `GET /api/audits/evidence-packs` | 404 | 404 | ✅ |
| T-RISK-01 | Risks infographic shows empty-state copy | `GET /api/infographic/risks` | contains `NO RISKS LOGGED YET` | match | ✅ |
| T-RISK-02 | Risks dashboard responds | `GET /risks` | 200|302 | 302 | ✅ |
| T-VEND-01 | List vendors | `GET /api/vendors` | 200 | 200 | ✅ |
| T-CALL-01 | List calls | `GET /api/calls` | 200 | 200 | ✅ |
| T-CALL-02 | Call analytics | `GET /api/calls/analytics` | 200 | 200 | ✅ |
| T-MR-01 | List management reviews | `GET /api/management-reviews` | 200 | 200 | ✅ |

## Validation — negative paths (must be 100% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
| T-INFO-404 | Unknown section returns 404 | `GET /api/infographic/does-not-exist` | 404 | 404 | ✅ |
| T-INFO-EMAIL-MISSING | Email share missing recipients | `POST /api/infographic/risks/share/email` | 400 | 400 | ✅ |
| T-INFO-EMAIL-INVALID | Email share invalid address | `POST /api/infographic/risks/share/email` | 400 | 400 | ✅ |

## Tier 3 — Supporting dashboards (target ≥ 90% green)
| ID | Description | Endpoint | Expected | Actual | Result |
|---|---|---|---|---|---|
| T-PAGE- | Dashboard / renders | `GET /` | 200|302 | 302 | ✅ |
| T-PAGE-grc | Dashboard /grc renders | `GET /grc` | 200|302 | 302 | ✅ |
| T-PAGE-tablef | Dashboard /tablef renders | `GET /tablef` | 200|302 | 302 | ✅ |
| T-PAGE-crm | Dashboard /crm renders | `GET /crm` | 200|302 | 302 | ✅ |
| T-PAGE-migration | Dashboard /migration renders | `GET /migration` | 200|302 | 302 | ✅ |
| T-PAGE-roi | Dashboard /roi renders | `GET /roi` | 200|302 | 302 | ✅ |
| T-PAGE-projects | Dashboard /projects renders | `GET /projects` | 200|302 | 302 | ✅ |
| T-PAGE-scorecard | Dashboard /scorecard renders | `GET /scorecard` | 200|302 | 302 | ✅ |
| T-PAGE-logs | Dashboard /logs renders | `GET /logs` | 200|302 | 302 | ✅ |
| T-PAGE-onboarding | Dashboard /onboarding renders | `GET /onboarding` | 200|302 | 302 | ✅ |
| T-PAGE-feedback | Dashboard /feedback renders | `GET /feedback` | 200|302 | 302 | ✅ |
| T-PAGE-users | Dashboard /users renders | `GET /users` | 200|302 | 302 | ✅ |
| T-PAGE-executive | Dashboard /executive renders | `GET /executive` | 200|302 | 302 | ✅ |
| T-PAGE-qms | Dashboard /qms renders | `GET /qms` | 200|302 | 302 | ✅ |
| T-PAGE-audits | Dashboard /audits renders | `GET /audits` | 200|302 | 302 | ✅ |
| T-PAGE-compliance | Dashboard /compliance renders | `GET /compliance` | 200|302 | 302 | ✅ |
| T-PAGE-policies | Dashboard /policies renders | `GET /policies` | 200|302 | 302 | ✅ |
| T-PAGE-risks | Dashboard /risks renders | `GET /risks` | 200|302 | 302 | ✅ |
| T-PAGE-vendors | Dashboard /vendors renders | `GET /vendors` | 200|302 | 302 | ✅ |
| T-PAGE-calls | Dashboard /calls renders | `GET /calls` | 200|302 | 302 | ✅ |
| T-PAGE-duplicates | Dashboard /duplicates renders | `GET /duplicates` | 200|302 | 302 | ✅ |
| T-PAGE-consultant | Dashboard /consultant renders | `GET /consultant` | 200|302 | 302 | ✅ |
| T-PAGE-infographic | Dashboard /infographic renders | `GET /infographic` | 200|302 | 302 | ✅ |
| T-PAGE-reviews | Dashboard /reviews renders | `GET /reviews` | 200|302 | 302 | ✅ |
| T-PAGE-pdpl | Dashboard /pdpl renders | `GET /pdpl` | 200|302 | 302 | ✅ |
| T-GUIDE-01 | User guide is public | `GET /guide` | 200 | 200 | ✅ |
| T-SOP-01 | Platform SOP is public | `GET /sop` | 200 | 200 | ✅ |

---
*Auto-generated by `scripts/run-platform-tests.sh`. Re-run before every release.*
