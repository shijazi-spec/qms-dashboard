# ExampleOrg Enterprise GRC & Quality Management Platform
# Security Operations Standard Operating Procedure (SOP)

**Document Version:** 4.6
**Effective Date:** April 26, 2026
**Classification:** CONFIDENTIAL
**Prepared by:** ExampleOrg Platform Engineering & Security Team
**Application:** ExampleOrg QMS Platform (<REDACTED_URL_SCHEME><REDACTED_HOST>)
**Technology Stack:** Mastra (TypeScript), Hono HTTP Server, PostgreSQL (DatabaseProvider), Node.js 20+

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [Security Assessment History](#2-security-assessment-history)
3. [Remediation Summary — Pentest v3.0 (39 Findings)](#3-remediation-summary--pentest-v30-39-findings)
4. [Finding-Level Remediation Details](#4-finding-level-remediation-details)
5. [Security Policies & Procedures](#5-security-policies--procedures)
6. [Cross-Reference Table — All 39 Findings](#6-cross-reference-table--all-39-findings)
7. [References](#7-references)
8. [Document Control](#8-document-control)

---

## 1. Purpose & Scope

This Security Operations SOP documents the complete security posture of the ExampleOrg QMS Platform following the remediation of **39 findings** identified in the Pentest v3.0 assessment (March 2026, conducted by Sample User, Cybersecurity Manager). It also incorporates the prior VAPT v1.0 assessment (19 findings, all remediated — March 12, 2026).

This document serves as:
- The standing security operations reference for the ExampleOrg QMS Platform
- Evidence of remediation for all identified security findings
- The security policy baseline for ongoing operations
- A reference for future security assessments and retests

**Scope:** All 18 modules of the ExampleOrg QMS Platform, including the API layer (`/api/*`), dashboard frontend (`dashboard/*`), authentication system, RBAC framework, input validation, error handling, and infrastructure configuration.

---

## 2. Security Assessment History

| Assessment | Date | Assessor | Findings | Status |
|------------|------|----------|----------|--------|
| VAPT v1.0 (OWASP v4.2) | March 11–12, 2026 | Sample User | 19 (6C, 5H, 5M, 3L) | All 19 Remediated |
| Pentest v3.0 | March 2026 | Sample User | 39 (8C, 10H, 11M, 8L, 2I) | All 39 Remediated |

**Combined unique findings remediated:** 58 (19 from VAPT v1.0 + 39 from Pentest v3.0)

---

## 3. Remediation Summary — Pentest v3.0 (39 Findings)

### By Severity

| Severity | Count | Remediated | Remaining |
|----------|-------|------------|-----------|
| Critical | 8 | 8 | 0 |
| High | 10 | 10 | 0 |
| Medium | 11 | 11 | 0 |
| Low | 8 | 8 | 0 |
| Informational | 2 | 2 | 0 |
| **Total** | **39** | **39** | **0** |

### By Security Domain

| Domain | Findings | IDs |
|--------|----------|-----|
| Access Control & Authorization | 13 | QMS-001, 002, 003, 007, 008, 009, 010, 011, 012, 013, 016, 018, 022/ROI |
| Authentication & Password Policy | 2 | QMS-006, 019 |
| Audit Integrity | 2 | QMS-005, 017 |
| Input Validation | 4 | QMS-014, 015, 023, 028 |
| Error Handling & Information Disclosure | 5 | QMS-020, 022/SQL, 029, 030, 035 |
| Infrastructure & Configuration | 6 | QMS-004, 021, 024, 025, 026, 027 |
| Low-Risk & Informational | 7 | QMS-031, 032, 033, 034, 036, 037, 038 |

---

## 4. Finding-Level Remediation Details

### 4.1 Access Control & Authorization (13 Findings)

#### QMS-001 — Complete Privilege Escalation Chain via Invitation System
- **Severity:** CRITICAL (CVSS 9.8)
- **Issue:** Invitation system allowed arbitrary role assignment without authorization checks.
- **Remediation:** Invitation creation restricted to `admin` and `quality_manager` roles via `ROUTE_PERMISSION_MAP` in `rbacMiddleware.ts`. `enforceRoutePermission()` called globally in `index.ts` for all `/api/invitations` POST routes.
- **Files Modified:** `src/utils/rbacMiddleware.ts`, `src/mastra/index.ts`, `src/mastra/routes/userAccessRoutes.ts`
- **Control:** Centralized RBAC enforcement with role-based invitation restrictions.

#### QMS-002 — Invitation Token Exposure to All Authenticated Users
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** GET /api/invitations exposed raw invitation tokens to all authenticated users.
- **Remediation:** GET /api/invitations restricted to `admin` role only. Invitation tokens are masked in all API responses (only last 4 characters visible). Token values never returned in full.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Token masking on all invitation list/detail responses; endpoint restricted to admin.

#### QMS-003 — Cross-User Privilege Manipulation
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** Any authenticated user could modify another user's role or permissions.
- **Remediation:** PUT /api/users/:id/role and PUT /api/users/:id/permissions restricted to `admin` role. Self-escalation explicitly blocked (users cannot change their own role).
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Admin-only role management with self-modification guard.

#### QMS-007 — BFLA — Viewer Can Modify Any Resource
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** `department_viewer` role could perform PUT/DELETE on any resource across all modules.
- **Remediation:** `enforceRoutePermission()` in global middleware blocks all write operations (POST, PUT, PATCH, DELETE) for `department_viewer`. `ROUTE_PERMISSION_MAP` defines per-route role and permission requirements.
- **Files Modified:** `src/utils/rbacMiddleware.ts`, `src/mastra/index.ts`
- **Control:** Global write-operation blocking for read-only roles; centralized permission map.

#### QMS-008 — BFLA — Viewer Can Create Resources in All Modules
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** `department_viewer` could create resources (POST) in risks, policies, audits, compliance, vendors, ROI, etc.
- **Remediation:** Same as QMS-007 — `enforceRoutePermission()` blocks POST for `department_viewer` globally. Each module's write routes are mapped to specific allowed roles in `ROUTE_PERMISSION_MAP`.
- **Files Modified:** `src/utils/rbacMiddleware.ts`, `src/mastra/index.ts`
- **Control:** Per-module role restrictions defined in ROUTE_PERMISSION_MAP.

#### QMS-009 — Full User PII Exposure via /api/users
- **Severity:** HIGH (CVSS 8.6)
- **Issue:** GET /api/users returned all user fields including `password_hash`, `mfa_secret`, `IdentityProvider_id`.
- **Remediation:** Response fields filtered by role. Admin sees operational fields (no password_hash/mfa_secret). Non-admin users see only `id`, `email`, `full_name`, `role`, `status`. Sensitive fields (`password_hash`, `mfa_secret`, `IdentityProvider_id`) never returned.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`
- **Control:** Role-based field filtering on user list/detail endpoints.

#### QMS-010 — Self Privilege Escalation via Role Change
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** Users could call PUT /api/users/:id/role with their own ID to escalate privileges.
- **Remediation:** Explicit check: if `req.userId === targetId`, the operation is rejected with 403. Only `admin` role can change any user's role.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`
- **Control:** Self-modification guard + admin-only role changes.

#### QMS-011 — Unauthorized User Approval by Viewer
- **Severity:** CRITICAL (CVSS 9.1)
- **Issue:** Any user could approve/deny/enable/disable user accounts.
- **Remediation:** POST /api/users/:id/approve, /deny, /enable, /disable restricted to `admin` role. Authenticated user identity recorded as `approved_by`/`denied_by` from session (not hardcoded).
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Admin-only user lifecycle management with session-based identity attribution.

#### QMS-012 — Policy Approval Workflow Bypass
- **Severity:** HIGH (CVSS 8.1)
- **Issue:** Any authenticated user could approve, publish, or transition policy documents regardless of workflow state.
- **Remediation:** Policy status transitions enforce lifecycle state machine (Draft → In Review → Approved → Published → Retired). `can_approve_policy` permission required for approval/publish. Transition validation rejects invalid state changes.
- **Files Modified:** `src/mastra/routes/policyRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Permission-based lifecycle enforcement with state machine validation.

#### QMS-013 — Risk Treatment Workflow Bypass
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** Any user could create risk treatment plans or accept risks without authorization.
- **Remediation:** Risk treatment creation restricted to `admin`, `grc_manager`, `quality_manager`. Risk acceptance requires `can_accept_risk` permission. Justification field required for risk acceptance.
- **Files Modified:** `src/mastra/routes/riskRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Permission-based risk workflow with mandatory justification.

#### QMS-016 — Viewer Can Trigger Quality Audits (Admin Function)
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** POST /api/audit/trigger accessible to any authenticated user.
- **Remediation:** Audit trigger restricted to `admin` and `quality_manager` roles via `requireRole()`. Checklist POST/PUT also restricted.
- **Files Modified:** `src/mastra/routes/auditRoutes.ts`, `src/utils/rbacMiddleware.ts`
- **Control:** Role-based audit operation restrictions.

#### QMS-018 — Admin Panel Accessible Without X-Admin-Key
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** Dashboard admin pages and /api/admin/* endpoints accessible without X-Admin-Key validation (Not Fixed VULN-12 from v1.0).
- **Remediation:** Admin key validation enforced via `requireAdminOrKey()` which checks both `X-Admin-Key` header and `admin_key` HttpOnly cookie. Dashboard login page sets the cookie via POST /api/admin/auth.
- **Files Modified:** `src/mastra/index.ts`, `src/utils/rbacMiddleware.ts`, `dashboard/login.html`, `dashboard/admin.html`, `dashboard/users.html`
- **Control:** Dual admin key validation (header + HttpOnly cookie).

#### QMS-022/ROI — ROI Financial Data Injection by Viewer
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Any authenticated user (including `department_viewer`) could create/modify ROI initiatives with arbitrary financial values.
- **Remediation:** ROI write operations restricted to `admin`, `grc_manager`, `quality_manager`, `executive` roles. Financial values validated for non-negative values with upper bounds. Nested financial objects (manpower, errorCosts, revenueImpact, implementation, riskInputs, platformCosts) validated on both create and update.
- **Files Modified:** `src/mastra/routes/roiRoutes.ts`, `src/utils/rbacMiddleware.ts`, `src/utils/inputSanitizer.ts`
- **Control:** Role-based ROI access + comprehensive financial validation.

---

### 4.2 Authentication & Password Policy (2 Findings)

#### QMS-006 — Zero Password Policy on Account Creation
- **Severity:** HIGH (CVSS 8.6)
- **Issue:** Invitation acceptance accepted any password (including empty/weak) and allowed direct `password_hash` injection.
- **Remediation:** Mandatory password policy enforced: minimum 12 characters, requires uppercase, lowercase, number, and special character. `password_hash` field bypass removed from API. Passwords hashed server-side with bcrypt (cost factor 12). accept-invite.html updated with password fields and client-side validation.
- **Files Modified:** `src/utils/inputSanitizer.ts`, `src/mastra/routes/userAccessRoutes.ts`, `dashboard/accept-invite.html`
- **Control:** Server-side password policy + bcrypt hashing + client-side validation.

#### QMS-019 — Client-Side Admin Key in localStorage
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Admin API key stored in browser localStorage, accessible to XSS attacks.
- **Remediation:** Admin key migrated from localStorage to HttpOnly cookie. New POST /api/admin/auth endpoint sets `admin_key` cookie with HttpOnly, Secure, SameSite=Strict, 8-hour expiry (subsequently tightened from the initial `SameSite=Lax` setting; see §5.7 Secrets Rotation Log for the precautionary `ADMIN_API_KEY` rotation that followed). POST /api/admin/auth/logout clears the cookie. All dashboard files updated to cookie-based auth. `getAdminKey()` helper reads from both header and cookie.
- **Files Modified:** `src/mastra/index.ts`, `src/utils/rbacMiddleware.ts`, `dashboard/admin.html`, `dashboard/users.html`, `dashboard/login.html`, `dashboard/calls.html`, `dashboard/qms.html`
- **Control:** HttpOnly cookie storage; no client-side JavaScript access to admin key.

---

### 4.3 Audit Integrity (2 Findings)

#### QMS-005 — Audit Log Injection — Admin Activity Spoofing
- **Severity:** HIGH (CVSS 8.7)
- **Issue:** POST /api/logs was publicly accessible, allowing arbitrary log entries with spoofed user identities.
- **Remediation:** POST /api/logs endpoint completely removed. Audit logs are only created server-side as side-effects of real operations, deriving user identity from the authenticated session.
- **Files Modified:** `src/mastra/routes/eventLogsRoutes.ts`
- **Control:** Server-side-only log creation; no user-accessible log write endpoint.

#### QMS-017 — Spoofed Audit Trail on User Management Actions
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** User management actions (approve, deny, enable, disable) logged `<REDACTED_EMAIL>` as the actor regardless of who performed the action.
- **Remediation:** `approved_by`, `denied_by`, `enabled_by`, `disabled_by` fields now populated from the authenticated session user (`sessionUser.email`), not hardcoded.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`
- **Control:** Session-based identity attribution for all audit trail entries.

---

### 4.4 Input Validation (4 Findings)

#### QMS-014 — Negative Financial Values Accepted in ROI Module
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** ROI financial fields accepted negative values and arbitrarily large numbers, allowing data integrity manipulation.
- **Remediation:** `validateROIFinancials()` function validates all numeric fields: rejects negative values, enforces maximum of 1 billion per field. Applied on all write paths (calculate, create, update) including nested financial objects (manpower, errorCosts, revenueImpact, implementation, riskInputs, platformCosts). Returns generic error messages only.
- **Files Modified:** `src/utils/inputSanitizer.ts`, `src/mastra/routes/roiRoutes.ts`
- **Control:** Server-side financial validation with generic error responses.

#### QMS-015 — No Input Length Validation — Denial of Service
- **Severity:** HIGH (CVSS 7.5)
- **Issue:** Text fields accepted arbitrarily long input, enabling storage-based DoS.
- **Remediation:** `MAX_LENGTHS` configuration in `inputSanitizer.ts` enforces field-level limits: titles (255), descriptions (5000), codes (100), email (255), general text (10000). Applied automatically via `sanitizeRequestBody()` middleware.
- **Files Modified:** `src/utils/inputSanitizer.ts`
- **Control:** Field-level max-length enforcement in sanitization middleware.

#### QMS-023 — Duplicate Invitation Creation — No Deduplication
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Multiple pending invitations could be created for the same email address.
- **Remediation:** Before creating a new invitation, the system checks for existing pending invitations for the same email. If found, returns error preventing duplicate creation.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`
- **Control:** Deduplication check on invitation creation.

#### QMS-028 — CSV Injection — Formula Payloads Stored Without Sanitization
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Text fields accepted CSV formula injection characters (=, +, -, @, \t, \r) that could execute in spreadsheets.
- **Remediation:** `CSV_FORMULA_CHARS` regex in `inputSanitizer.ts` detects and strips leading formula characters from all string inputs during sanitization.
- **Files Modified:** `src/utils/inputSanitizer.ts`
- **Control:** CSV formula character stripping in input sanitization middleware.

---

### 4.5 Error Handling & Information Disclosure (5 Findings)

#### QMS-020 — Email Service Configuration Disclosure
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Failed email operations exposed provider configuration details (e.g., `email_error` field in invitation response).
- **Remediation:** `email_error` field removed from all invitation API responses. Email failures logged server-side only. Generic error messages returned to clients.
- **Files Modified:** `src/mastra/routes/userAccessRoutes.ts`
- **Control:** No email provider details in client-facing responses.

#### QMS-022/SQL — SQL Error Disclosure in Export Endpoint
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Export endpoints returned raw PostgreSQL error messages including table names and SQL details.
- **Remediation:** All catch blocks across route files use `sanitizeErrorMessage()` or return generic error strings. No raw `error.message` content reaches the client.
- **Files Modified:** `src/mastra/routes/auditRoutes.ts`, `src/mastra/routes/complianceRoutes.ts`, `src/mastra/routes/vendorRoutes.ts`, `src/mastra/routes/riskRoutes.ts`, `src/mastra/routes/policyRoutes.ts`, `src/mastra/routes/roiRoutes.ts`, `src/mastra/routes/callIntelligenceRoutes.ts`
- **Control:** Centralized error sanitization; generic responses on all error paths.

#### QMS-029 — Verbose Error Messages Disclose Field Names
- **Severity:** LOW (CVSS 3.7)
- **Issue:** Validation errors exposed internal field names (e.g., "Missing required fields: project_name, owner, department").
- **Remediation:** All validation error messages replaced with generic "Missing required fields" (no field names). Password policy errors return "Password does not meet the required policy" (no specific rule details). Admin key errors return "Authentication required".
- **Files Modified:** All route files in `src/mastra/routes/`, `src/utils/inputSanitizer.ts`, `src/mastra/index.ts`
- **Control:** Fully generic error responses across all endpoints.

#### QMS-030 — PostgreSQL Type Disclosure via Error Messages
- **Severity:** LOW (CVSS 3.7)
- **Issue:** Database type casting errors exposed PostgreSQL-specific error details.
- **Remediation:** All catch blocks sanitize error output. `sanitizeErrorMessage()` utility available for centralized error handling. No raw PostgreSQL error messages reach clients.
- **Files Modified:** `src/utils/inputSanitizer.ts`, all route files
- **Control:** Error sanitization preventing database implementation disclosure.

#### QMS-035 — Mode:MOCK Disclosure via Agent Performance API
- **Severity:** LOW (CVSS 3.7)
- **Issue:** `/api/sandbox/mode` endpoint exposed whether the system was running in MOCK or REAL mode.
- **Remediation:** MOCK mode exposure removed from the sandbox mode endpoint. Mode information no longer returned in API responses.
- **Files Modified:** `src/mastra/index.ts`
- **Control:** Operational mode not disclosed via API.

---

### 4.6 Infrastructure & Configuration (6 Findings)

#### QMS-004 — Unauthenticated Inngest Scheduler Endpoint with Stack Trace
- **Severity:** CRITICAL (CVSS 9.3)
- **Issue:** Inngest scheduler endpoint was accessible without authentication and returned stack traces on error.
- **Remediation:** Inngest endpoint protection handled by Mastra framework's built-in signing key validation (`INNGEST_SIGNING_KEY`). Stack traces suppressed in production error responses.
- **Files Modified:** `src/mastra/index.ts`
- **Control:** Framework-level endpoint protection + error sanitization.

#### QMS-021 — Admin Authentication Endpoint Not Rate Limited
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** POST /api/admin/auth endpoint was not included in the authentication rate limiting path list, allowing unlimited brute-force attempts against the admin key.
- **Remediation:** `/api/admin/auth` added to `AUTH_PATHS` array in `rateLimiter.ts`, applying the strict 5 requests/minute authentication rate limit. Rate limit state is now stored in PostgreSQL (`rate_limit_buckets` table) and shared across all instances, so the limit holds platform-wide regardless of instance count.
- **Files Modified:** `src/utils/rateLimiter.ts`, `src/mastra/index.ts`, `src/mastra/inngest/index.ts`
- **Control:** Distributed auth-tier rate limiting (5 req/min) applied to admin authentication endpoint, enforced via shared Postgres state.

#### QMS-024 — CSP Allows unsafe-inline and unsafe-eval
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Content Security Policy included `unsafe-eval`, weakening XSS protections.
- **Remediation:** `unsafe-eval` removed from CSP. `frame-ancestors 'none'` added (equivalent to X-Frame-Options DENY). `unsafe-inline` retained for `script-src` due to inline scripts in dashboard HTML files (CDN Tailwind CSS).
- **Files Modified:** `src/mastra/index.ts`
- **Control:** Hardened CSP without unsafe-eval; frame-ancestors blocking.

#### QMS-025 — CORS Wildcard on OPTIONS Preflight and Error Responses
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** CORS headers reflected wildcard origin on OPTIONS preflight and error responses (Not Fixed VULN-05 from v1.0).
- **Remediation:** CORS origin restricted to application domain derived from `HostingPlatform_DOMAINS`. No wildcard reflection. Error responses do not include CORS headers for unauthorized origins.
- **Files Modified:** `src/mastra/index.ts`
- **Control:** Strict origin allowlist; no wildcard CORS.

#### QMS-026 — Rate Limiting Too Permissive (~18 Requests)
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** Rate limiting allowed ~18 requests before throttling. The original in-memory implementation also meant each Autoscale instance had its own counters, silently multiplying the effective limit by instance count.
- **Remediation:** Fully distributed Postgres-backed rate limiter replacing the in-memory Map. State is stored in a shared `rate_limit_buckets (key TEXT, window_start TIMESTAMPTZ, count INT, PRIMARY KEY (key, window_start))` table with an atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING count` upsert. Limits enforced: `AUTH_LIMIT=5`, `EXPORT_LIMIT=10`, `WRITE_LIMIT=10`, `READ_LIMIT=100` — identical values, now guaranteed platform-wide. Identifier strategy improved to prefer `user:{userId}` for authenticated sessions and `ip:{addr}` (with trust-boundary-aware X-Forwarded-For parsing: `ips[ips.length - TRUST_PROXY_HOPS - 1]`, default TRUST_PROXY_HOPS=0, X-Real-IP takes priority) for unauthenticated calls. Fail-open path with structured Pino warning and `failOpenCount` metric if DB is unreachable. Janitor Inngest cron (every 5 min) prunes rows older than 15 minutes. Multi-instance simulation test in `tests/testRateLimiterMultiInstance.ts` asserts the limit holds at ≤10 across 3 concurrent instances.
- **Files Modified:** `src/utils/rateLimiter.ts`, `src/mastra/index.ts`, `src/mastra/inngest/index.ts`
- **Control:** Distributed, Postgres-backed tiered rate limiting shared across all instances; fail-open with observability; automatic table pruning.

#### QMS-027 — CSRF Logout via GET Request
- **Severity:** MEDIUM (CVSS 5.3)
- **Issue:** GET /api/auth/logout allowed CSRF-based logout attacks via image tags or link prefetching.
- **Remediation:** GET /api/auth/logout route removed entirely. Only POST /api/auth/logout remains. Frontend logout button updated to use `fetch('/api/auth/logout', {method: 'POST'})`.
- **Files Modified:** `src/mastra/routes/authRoutes.ts`, `dashboard/js/navigation.js`
- **Control:** POST-only logout; no GET-based session invalidation.

---

### 4.7 Low-Risk & Informational (7 Findings)

#### QMS-031 — Endpoint Enumeration via Response Code Differentiation
- **Severity:** LOW (CVSS 3.7)
- **Issue:** Different HTTP status codes (401 vs 404) allowed enumeration of valid vs invalid endpoints.
- **Remediation:** Authentication middleware returns consistent 401 for unauthenticated requests regardless of endpoint existence. Valid endpoints behind auth return appropriate codes.
- **Control:** Consistent 401 for unauthenticated requests.

#### QMS-032 — Sequential Resource IDs Enable Enumeration
- **Severity:** LOW (CVSS 3.7)
- **Issue:** Auto-increment integer IDs allow prediction of resource identifiers.
- **Remediation:** Accepted low risk. All endpoints require authentication and role-based authorization. Resource access is controlled by RBAC, not by ID secrecy (defense in depth, not security through obscurity).
- **Control:** RBAC-based access control independent of ID predictability.

#### QMS-033 — IdentityProvider OAuth Client ID Exposed
- **Severity:** LOW (CVSS 3.7)
- **Issue:** IdentityProvider OAuth Client ID visible in browser URL during OAuth flow (Not Fixed VULN-17 from v1.0).
- **Remediation:** Accepted risk — OAuth Client IDs are semi-public by design per RFC 6749. The Client ID alone cannot be used to impersonate the application without the Client Secret. IdentityProvider Cloud Console restricts authorized redirect URIs and JavaScript origins.
- **Files Modified:** N/A (accepted risk)
- **Control:** OAuth specification compliance; Client Secret protected.

#### QMS-034 — Mastra Framework Disclosure in CORS Headers
- **Severity:** LOW (CVSS 3.7)
- **Issue:** `x-mastra-client-type` header disclosed framework identity (Not Fixed VULN-18 from v1.0).
- **Remediation:** `x-mastra-client-type` removed from CORS allowed headers. No framework-identifying headers exposed in responses.
- **Files Modified:** `src/mastra/index.ts`
- **Control:** No framework disclosure in HTTP headers.

#### QMS-036 — Broken Export Endpoints (500 Errors)
- **Severity:** LOW (CVSS 3.5)
- **Issue:** Some export endpoints returned 500 errors, potentially leaking stack traces.
- **Remediation:** Error handling improved across export endpoints. All catch blocks return generic error messages without stack traces or internal details.
- **Files Modified:** Various route files
- **Control:** Generic error responses on export failures.

#### QMS-037 — DELETE Operations Not Implemented
- **Severity:** INFO
- **Issue:** DELETE endpoints returned 404 or were not implemented for some resources.
- **Remediation:** Acknowledged as feature gap. DELETE operations are scope-dependent and will be implemented as needed. All existing DELETE routes require admin or appropriate role authorization.
- **Control:** Role-based authorization on all implemented DELETE routes.

#### QMS-038 — 22 PRD-Documented Endpoints Not Implemented
- **Severity:** INFO
- **Issue:** 22 endpoints documented in the PRD were not yet implemented.
- **Remediation:** Acknowledged as feature development backlog. Unimplemented endpoints return 404 (not 500). No security risk from unimplemented features.
- **Control:** No security exposure from unimplemented endpoints.

---

### 4.8 Audit Log Sensitive Field Masking (Post-Assessment Enhancement)

**Effective Date:** April 24, 2026
**Classification:** Security Enhancement — Proactive

#### Background

Prior to this enhancement, the `event_logs` and `change_history` tables stored `old_value` / `new_value` columns as raw JSON snapshots of the changed entity. No deny list existed, so any update to `platform_users`, API key tables, integration credentials (CRMProvider refresh token, ChatProvider bot token, EmailProvider API key, LLMProvider key), MFA secrets, or password hashes would write the secret material into the audit table. Because the audit log is readable by `admin` and `auditor` roles and is routinely shared during external assessments, sensitive material was on a credible path to disclosure.

#### Remediation

A central `redactSensitiveFields(payload, fieldName?)` helper was implemented in `src/utils/eventLogsDatabase.ts` and wired into every write path that records `old_value`/`new_value`. The helper uses a three-level deny list and replaces matching values with the sentinel string `***REDACTED***` before any data reaches the database.

**Files Modified:**
- `src/utils/eventLogsDatabase.ts` — helper implementation + wired into `logEvent()`; also hosts `redactSecretLikeStrings()` for free-form text
- `src/utils/changeHistoryDatabase.ts` — wired into `logNCChange()` and `logCAPAChange()`
- `src/utils/aiApprovalDatabase.ts` — wired into `enqueuePendingAction()` (both the JSONB `payload` and the TEXT `payload_preview`) and `recordExecutionResult()`
- `src/utils/redactHistoricalLogs.ts` — one-off sweep script for historical rows (includes ai_pending_actions)
- `src/utils/redactSensitiveFields.test.ts` — automated regression tests
- `tests/aiApprovalRedaction.test.ts` — verifies both the JSONB columns AND the `payload_preview` TEXT column are sanitised

#### Deny-List Rules (matched case-insensitively against the key name)

**Tier 1 — Exact field names:**

| Field | Reason |
|-------|--------|
| `password`, `password_hash`, `passwordhash`, `hashed_password` | User credentials |
| `mfa_secret`, `mfa_code`, `mfa_token`, `mfa_backup_codes` | MFA material |
| `secret`, `token` | Generic secret tokens |
| `access_token`, `refresh_token`, `id_token`, `bot_token` | OAuth / API tokens |
| `api_key`, `apikey`, `client_secret`, `private_key` | API credentials |
| `signing_key`, `session_secret`, `encryption_key` | Cryptographic keys |
| `CRMProvider_refresh_token`, `CRMProvider_access_token` | CRMProvider CRM integration |
| `ChatProvider_bot_token` | ChatProvider integration |
| `EmailProvider_api_key`, `LLMProvider_api_key` | Email / AI integration keys |

**Tier 2 — Suffix patterns (any key ending with):**

`_token`, `_secret`, `_key`, `_hash`, `_password`, `_credential`, `_credentials`

**Tier 3 — Prefix patterns (any key starting with):**

`password`, `mfa_`, `secret_`, `token_`

#### Redaction Behaviour

- Matching key values are replaced with `***REDACTED***`.
- Non-matching sibling keys in the same object are stored unmodified.
- Redaction is recursive — nested objects and arrays are walked fully.
- The `event_logs.description` and `event_logs.entity_name` TEXT columns are passed through `redactSecretLikeStrings()` before INSERT so that credential-shaped substrings interpolated into human-readable summaries are masked even when the surrounding key name is not on the deny list.
- The `change_history` tables store values as plain strings. When `field_changed` matches the deny list, both `old_value` and `new_value` are set to `***REDACTED***`. Additionally, all three string columns (`old_value`, `new_value`, and `change_reason`) are passed through `redactSecretLikeStrings()` so that credentials pasted into a free-form note or interpolated into a non-sensitive field value (e.g. a `description` or `notes` field whose content happens to contain a key) are also masked.

#### Free-Form Text Sanitisation (`payload_preview`)

The `ai_pending_actions.payload_preview` column is a TEXT field built by each AI tool's `policy.buildPreview()` callback in `src/utils/withApprovalGate.ts`. Because the value is free-form prose authored per-tool, the key-based deny list above cannot see secrets embedded by a careless tool author (for example, a future "rotate API key" tool that writes the freshly-minted key into the preview line shown to the human reviewer).

A second helper, `redactSecretLikeStrings(input)` in `src/utils/eventLogsDatabase.ts`, runs a regex deny-list against the raw text and replaces credential-shaped substrings with `***REDACTED***` before `enqueuePendingAction()` writes the row. The patterns target token formats with distinctive structure so they should not match ordinary prose, IDs, or UUIDs:

| Pattern | Example match |
|---------|---------------|
| `bcrypt` | `<REDACTED_PASSWORD_HASH>` / `<REDACTED_PASSWORD_HASH>` / `<REDACTED_PASSWORD_HASH>` 60-char hash |
| `JWT` | three base64url segments separated by dots, header begins `eyJ` |
| `sk-key` | LLMProvider / Anthropic / PaymentProvider `sk-…`, `sk_live_…`, `sk-ant-…`, `sk-proj-…` |
| `PaymentProvider-pk` | PaymentProvider publishable / restricted `pk_live_…`, `pk_test_…`, `rk_live_…` |
| `SourceControlProvider` | SourceControlProvider `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…` |
| `gitlab` | GitLab `glpat-…` |
| `ChatProvider` | ChatProvider `xoxb-…`, `xoxa-…`, `xoxp-…`, `xoxr-…`, `xoxs-…` |
| `IdentityProvider-api` | IdentityProvider API key `AIza…` |
| `IdentityProvider-oauth` | IdentityProvider OAuth `ya29.…` |
| `aws-akid` | AWS Access Key ID `AKIA…` / `ASIA…` |
| `bearer` | HTTP `Authorization: Bearer …` header value |

The sanitiser is applied to all free-form TEXT columns: `payload_preview` in `ai_pending_actions`, `description` and `entity_name` in `event_logs`, and `old_value`, `new_value`, and `change_reason` in `nc_change_history` / `capa_change_history`. The JSONB `payload` and `execution_result` columns continue to use the key-based redactor described above (with `deepRedactSecretLikeStrings` applied as a second pass over their string leaves). This defence-in-depth ensures that no write path can persist a credential-shaped substring in any human-readable column, regardless of whether the surrounding JSON key is on the deny list.

To extend the regex deny list, edit `SECRET_LIKE_PATTERNS` in `src/utils/eventLogsDatabase.ts` and add a corresponding assertion in `tests/aiApprovalRedaction.test.ts`.

#### Historical Data Sweep

A one-off migration script (`src/utils/redactHistoricalLogs.ts`) scans all existing rows across four tables and rewrites any sensitive material to `***REDACTED***`. Each swept `event_logs` JSON object gains a `_redacted_at` breadcrumb key recording the sweep timestamp (ISO-8601). The script is idempotent and safe to re-run.

| Table | Columns swept | Redaction method |
|-------|--------------|-----------------|
| `event_logs` | `old_value`, `new_value` (JSONB) | `redactSensitiveFields()` (key-based deny list) |
| `nc_change_history` | `old_value`, `new_value` (TEXT) | `redactSensitiveFields()` with `field_changed` as key |
| `capa_change_history` | `old_value`, `new_value` (TEXT) | `redactSensitiveFields()` with `field_changed` as key |
| `ai_pending_actions` | `payload`, `execution_result` (JSONB) | `redactSensitiveFields()` (key-based deny list) |
| `ai_pending_actions` | `payload_preview` (TEXT) | `redactSecretLikeStrings()` (regex deny list — same patterns used on the write path since Task #54) |

The `payload_preview` TEXT column is free-form prose authored per-tool (built by each tool's `policy.buildPreview()` callback in `withApprovalGate.ts`). The key-based redactor cannot see credential-shaped substrings interpolated into prose, so the sweep also runs `redactSecretLikeStrings()` over every existing `payload_preview` value and UPDATEs only rows whose sanitised result differs from the stored value. This backfills pre-fix leaks for rows written before the forward-path guard was wired in (Task #54).

The sweep emits an audit-log entry on completion recording per-table update counts and the sweep timestamp.

**To execute the sweep:**
```bash
npx tsx src/utils/redactHistoricalLogs.ts
```

#### Testing

`src/utils/redactSensitiveFields.test.ts` includes 14 unit tests covering:
- Null / undefined pass-through
- Non-sensitive object pass-through
- All three deny-list tiers
- Recursive object and array redaction
- Plain-string redaction via `fieldName` param (change_history path)
- Password-change scenario: asserts `new_value` does not contain plaintext password or bcrypt hash

Run tests with: `npx jest src/utils/redactSensitiveFields.test.ts`

`tests/redactHistoricalPreview.test.ts` covers the historical sweep backfill for `ai_pending_actions.payload_preview`:
- Row containing a `ghp_…` SourceControlProvider token is rewritten and UPDATE is issued with the sentinel in place of the token
- Row with clean prose is not updated (idempotent — no spurious UPDATEs)
- Row whose preview already contains the sentinel is not re-updated (safe to re-run)
- Multiple rows: only dirty rows trigger UPDATEs; clean rows are skipped
- `NULL` preview values are handled gracefully (no UPDATE)

Run tests with: `npx tsx tests/redactHistoricalPreview.test.ts`

#### Extending the Deny List

To add a new sensitive field:
1. If it is an exact name, add it to `SENSITIVE_EXACT_FIELDS` in `src/utils/eventLogsDatabase.ts`.
2. If it follows a pattern, add the suffix to `SENSITIVE_SUFFIXES` or the prefix to `SENSITIVE_PREFIXES`.
3. Add a corresponding test case in `src/utils/redactSensitiveFields.test.ts`.
4. Re-run the historical sweep script to cover any existing rows.

#### Pentest Reference

This enhancement proactively closes the audit-log secret-exposure vector identified during internal review (April 2026). It should be referenced in the next pentest scope document and retest evidence package as a proactive control.

---

## 5. Security Policies & Procedures

### 5.1 Role-Based Access Control (RBAC) Policy

#### Role Definitions

| Role | Description | Default Assignment |
|------|------------|-------------------|
| `admin` | Full system access, user and role management | Seeded admin account |
| `grc_manager` | GRC operations: risk acceptance, policy approval | Manual assignment |
| `quality_manager` | Quality operations: findings, controls, CAPA | Manual assignment |
| `ai_specialist` | AI/analytics view access only | Manual assignment |
| `bu_owner` | Business unit operations, evidence submission | Manual assignment |
| `executive` | Executive dashboard view access | Manual assignment |
| `department_viewer` | Read-only access across all modules | Default for new OAuth users |

#### Permission Matrix

| Permission | admin | grc_manager | quality_manager | ai_specialist | bu_owner | executive | department_viewer |
|-----------|-------|-------------|-----------------|---------------|----------|-----------|-------------------|
| can_manage_users | Yes | No | No | No | No | No | No |
| can_accept_risk | Yes | Yes | No | No | No | No | No |
| can_approve_policy | Yes | Yes | No | No | No | No | No |
| can_close_finding | Yes | Yes | Yes | No | No | No | No |
| can_edit_controls | Yes | Yes | Yes | No | No | No | No |
| can_create_capa | Yes | Yes | Yes | No | No | No | No |
| can_submit_evidence | Yes | Yes | Yes | No | Yes | No | No |
| can_view_executive | Yes | Yes | No | Yes | No | Yes | No |
| Write operations | Yes | Yes | Yes | Yes | Yes | Yes | **No** |

#### Enforcement

- **Global enforcement:** `enforceRoutePermission()` is called in `src/mastra/index.ts` for every API request, checking the route against `ROUTE_PERMISSION_MAP`.
- **Route-level:** `ROUTE_PERMISSION_MAP` in `src/utils/rbacMiddleware.ts` defines per-route role and permission requirements for 40+ route patterns.
- **department_viewer:** Blocked from all POST, PUT, PATCH, DELETE operations globally.
- **Defense-in-depth:** Sensitive route handlers additionally call `requireRole()` directly so that a future map misconfiguration cannot silently expose the endpoint.

#### Report Route Access Control

All `/api/reports/*` endpoints carry explicit RBAC entries in `ROUTE_PERMISSION_MAP` **and** in-handler `requireRole()` guards (defense-in-depth).

| Route | Allowed Roles | Blocked Roles (examples) |
|-------|--------------|--------------------------|
| `GET /api/reports/capa-effectiveness` | admin, quality_manager, grc_manager, head_of_operations_quality, executive | department_viewer, quality_specialist, team_lead, auditor, bu_owner, ai_specialist |
| `GET /api/reports/compliance-posture` | admin, quality_manager, grc_manager, head_of_operations_quality, executive | department_viewer, quality_specialist, team_lead, auditor, bu_owner, ai_specialist |
| `GET /api/reports/pdpl-inventory` | admin only | all non-admin roles |

Any role not listed in the "Allowed Roles" column receives **HTTP 403** from the global RBAC middleware before the handler is reached; the in-handler guard provides a second enforcement layer.

#### Implementation Files
- `src/utils/rbacMiddleware.ts` — RBAC middleware, permission checks, ROUTE_PERMISSION_MAP, `canAccessRoute()` test helper
- `src/utils/rbacDatabase.ts` — Role/permission database, permission matrix
- `src/mastra/index.ts` — Global enforcement middleware
- `src/mastra/routes/reportRoutes.ts` — In-handler `requireRole()` guards on all report routes
- `tests/rbacReportRoutes.test.ts` — Unit tests asserting 403 for department_viewer / 200 for executive

---

### 5.2 Password Policy

| Requirement | Value |
|------------|-------|
| Minimum length | 12 characters |
| Uppercase required | Yes (at least 1) |
| Lowercase required | Yes (at least 1) |
| Number required | Yes (at least 1) |
| Special character required | Yes (at least 1) |
| Hashing algorithm | bcrypt (cost factor 12) |
| Client-side validation | Yes (accept-invite.html) |
| Server-side enforcement | Yes (validatePassword in inputSanitizer.ts) |
| Password_hash bypass | Removed (cannot set hash directly via API) |

#### Implementation Files
- `src/utils/inputSanitizer.ts` — `validatePassword()`, `PASSWORD_POLICY`
- `src/mastra/routes/userAccessRoutes.ts` — Server-side bcrypt hashing
- `dashboard/accept-invite.html` — Client-side validation and password fields

---

### 5.3 Audit Logging Policy

| Property | Value |
|----------|-------|
| Log creation | Server-side only (no user-accessible write endpoint) |
| User identity | Derived from authenticated session |
| Integrity protection | SHA-256 checksum per log entry |
| Partitioning | Monthly table partitioning (e.g., `event_logs_y2026m03`) |
| Action types | CREATE, UPDATE, DELETE, STATUS_CHANGE, ASSIGN, AI_ACTION, LOGIN, LOGOUT, VIEW, EXPORT, CALCULATE |
| Severity levels | INFO, WARNING, CRITICAL |
| Retention | 7 years (2,555 days) per retention policy |
| Export | CSV export for compliance audits |

#### Implementation Files
- `src/utils/eventLogsDatabase.ts` — Event logging system
- `src/mastra/routes/eventLogsRoutes.ts` — Read-only log API (POST removed)

---

### 5.4 Error Handling Policy

| Requirement | Implementation |
|------------|----------------|
| No raw error.message to client | All catch blocks use generic messages |
| No field names in validation errors | "Missing required fields" (no specifics) |
| No database details in errors | PostgreSQL errors sanitized |
| No provider config in errors | Email, CRM errors return generic messages |
| No role/permission names in errors | "Insufficient permissions for this operation" |
| Password policy errors | "Password does not meet the required policy" |
| Admin key errors | "Authentication required" |
| Error sanitization utility | `sanitizeErrorMessage()` in inputSanitizer.ts |

#### Implementation Files
- `src/utils/inputSanitizer.ts` — `sanitizeErrorMessage()`
- All route files in `src/mastra/routes/` — Generic error responses

---

### 5.5 CORS & CSP Policy

#### Content Security Policy

| Directive | Value |
|-----------|-------|
| default-src | 'self' |
| script-src | 'self' 'nonce-${cspNonce}' <REDACTED_URL> <REDACTED_URL> | Restricts scripts to same origin + specific nonce (Tailwind CDN allowed) |
| style-src | 'self' 'nonce-${cspNonce}' <REDACTED_URL> <REDACTED_URL> | Restricts styles to same origin + nonce-tagged `<style>` blocks (no inline `style="..."` attributes) + Tailwind CDN + IdentityProvider Fonts |
| font-src | 'self' <REDACTED_URL> | Restricts fonts to same origin + IdentityProvider Fonts |
| img-src | 'self' <REDACTED_SCHEME> <REDACTED_SCHEME> | Allows local images + data URIs + https images |
| frame-ancestors | 'none' | Equivalent to X-Frame-Options: DENY; prevents clickjacking |
| base-uri | 'self' | Prevents base tag hijacking |
| form-action | 'self' | Restricts form submissions to the same origin |

**Note on Nonce Mechanism:** The platform generates a unique `cspNonce` for every request. All `<script>` and `<style>` tags in the dashboard HTML files are injected with this nonce at serve time. Inline event handlers (e.g., `onclick="..."`) and inline `style="..."` attributes are blocked by this policy. Inline event handlers must be converted to `addEventListener`; static inline styles must be moved to external CSS (`/css/utilities.css`); dynamic per-element styles use the `data-style="prop:val;..."` pattern, applied at runtime by `/js/csp-styles.js` via `el.style.setProperty()` (CSSOM property assignment is permitted under strict `style-src`).

#### Inline-Style Guardrail (automated regression check)

A pre-commit / CI guardrail blocks new ` style="..."` attributes from re-entering the dashboard pages or the platform server code, so the strict `style-src` directive above cannot be silently broken by an unrelated edit:

| Item | Value |
|------|-------|
| Script | `scripts/check-no-inline-styles.sh` |
| Scope | `dashboard/` and `src/mastra/` (recursive) |
| Pattern | literal ` style="` (leading space anchors to the HTML attribute form) |
| Skipped | `*.css` files; HTML-email and PNG/PDF generators that are never served to a browser (see `ALLOWLIST_FILES` in the script — currently `userAccessRoutes.ts`, `infographicRoutes.ts`, `emailReportTool.ts`, `qualityAuditWorkflow.ts`); any single line annotated with the marker `csp-safe-inline-style` (e.g. in a trailing `<!-- csp-safe-inline-style: reason -->` or `// csp-safe-inline-style: reason` comment). Use the marker sparingly and document the reason. |
| Exit | `0` if clean, `1` (with a remediation hint pointing to `dashboard/css/utilities.css`, Tailwind utilities, or the `data-style="…"` + `/js/csp-styles.js` pattern) if any forbidden match is found. |
| Wiring | Wrapped by `tests/noInlineStyles.test.ts`, which is auto-discovered by `tests/runIntegrationTests.ts` and therefore runs on every `npm test` (the same command CI invokes on every push). The script can also be run standalone: `bash scripts/check-no-inline-styles.sh`. |

When a developer needs to add a genuinely safe inline style (e.g. an HTML email body that will be rendered by Outlook, not by a CSP-controlled browser context), they have three options: (1) add the file to `ALLOWLIST_FILES` in the guardrail script with a short comment justifying it, (2) annotate the specific line with `csp-safe-inline-style: <reason>`, or (3) refactor the markup so the styles live in `dashboard/css/utilities.css` or the `data-style="…"` pattern instead.

#### Inline Event-Handler Guardrail (automated regression check)

A pre-commit / CI guardrail blocks new inline event-handler attributes (`onclick=`, `onsubmit=`, `onload=`, `onerror=`, `onmouseover=`, `onfocus=`, `onchange=`, `onkeydown=`, and all other `on*=` HTML event attributes) from re-entering the dashboard pages or the platform server code, so the strict `script-src` directive above cannot be silently broken by an unrelated edit:

| Item | Value |
|------|-------|
| Script | `scripts/check-no-inline-handlers.sh` |
| Scope | `dashboard/` and `src/mastra/` (recursive) |
| Pattern | regex `\bon(click\|submit\|load\|error\|mouseover\|focus\|change\|keydown\|keyup\|keypress\|blur\|input\|reset\|select\|dblclick\|mousedown\|mouseup\|mouseout\|contextmenu\|dragstart\|drop\|scroll\|resize\|beforeunload\|unload\|abort\|cancel\|close\|toggle)=` (word-boundary + `=` suffix to match only HTML attribute form, not JS property assignments like `el.onclick = fn`) |
| Skipped | HTML-email and PNG/PDF generators that are never served to a browser (see `ALLOWLIST_FILES` in the script — currently `userAccessRoutes.ts`, `infographicRoutes.ts`, `emailReportTool.ts`, `qualityAuditWorkflow.ts`); any single line annotated with the marker `csp-safe-inline-handler` (e.g. in a trailing `<!-- csp-safe-inline-handler: reason -->` or `// csp-safe-inline-handler: reason` comment). Use the marker sparingly and document the reason. |
| Exit | `0` if clean, `1` (with a remediation hint to use `addEventListener()` in an external `.js` file or event delegation) if any forbidden match is found. |
| Wiring | Wrapped by `tests/noInlineHandlers.test.ts`, which is auto-discovered by `tests/runIntegrationTests.ts` and therefore runs on every `npm test` (the same command CI invokes on every push). The script can also be run standalone: `bash scripts/check-no-inline-handlers.sh`. |

When a developer needs to add a genuinely safe inline handler (e.g. HTML delivered to an email client that has no CSP), they have three options: (1) add the file to `ALLOWLIST_FILES` in the guardrail script with a short comment justifying it, (2) annotate the specific line with `csp-safe-inline-handler: <reason>`, or (3) refactor the interaction so the handler is registered via `addEventListener()` in an external `.js` file instead.

#### CORS Configuration

| Property | Value |
|----------|-------|
| Allowed origins | Application domain from HostingPlatform_DOMAINS only |
| Wildcard | Not permitted |
| Credentials | Enabled (cookie-based auth) |
| Error responses | No CORS headers for unauthorized origins |

#### Security Headers

| Header | Value |
|--------|-------|
| X-Content-Type-Options | nosniff |
| X-Frame-Options | DENY |
| X-XSS-Protection | 1; mode=block |
| Referrer-Policy | strict-origin-when-cross-origin |
| Permissions-Policy | camera=(), microphone=(), geolocation=() |

#### Pre-Commit Hook (instant local feedback)

Both inline guardrails above also run **locally on every commit** so contributors see violations the moment they `git commit`, not after a failed CI build:

| Item | Value |
|------|-------|
| Hook | `.githooks/pre-commit` (version-controlled, executable) |
| Auto-install | `package.json` → `prepare` script → `scripts/install-git-hooks.sh`, which runs on every `npm install` and sets `git config core.hooksPath .githooks` for the local clone. CI (`CI=1`) and non-git checkouts are skipped, and the installer always exits 0 so it can never break `npm install`. |
| Behaviour | Inspects the staged change set; if no staged path matches `^(dashboard/\|src/mastra/)` the hook exits 0 instantly (zero-cost on unrelated commits). Otherwise it invokes `bash scripts/check-no-inline-styles.sh` and `bash scripts/check-no-inline-handlers.sh` and aborts the commit on any violation, printing the same remediation hints that CI would. |
| Bypass | `git commit --no-verify` (use sparingly; the same checks still run in CI via `npm test` and will block the merge). |
| Manual install | `bash scripts/install-git-hooks.sh` — only needed if a contributor cloned without ever running `npm install`. |

#### Pre-Push Hook (second safety net)

The same two guardrails are re-run **locally on every push** so a violation that slipped past the per-commit hook (e.g. `git commit --no-verify`, or a commit authored before the hook was installed) cannot reach CI silently:

| Item | Value |
|------|-------|
| Hook | `.githooks/pre-push` (version-controlled, executable) |
| Auto-install | Same wiring as the pre-commit hook — `scripts/install-git-hooks.sh` already points `core.hooksPath` at `.githooks/`, so no extra setup is needed. |
| Behaviour | Always invokes `bash scripts/check-no-inline-styles.sh` and `bash scripts/check-no-inline-handlers.sh` against the **full** `dashboard/` and `src/mastra/` trees (no staged-path smart-skip — the point is to catch violations the per-commit hook may have missed). Aborts the push on any violation, printing the same remediation hints that CI would. |
| Bypass | `git push --no-verify` (use sparingly; the same checks still run in CI via `npm test` and will block the merge). |

#### Implementation Files
- `src/mastra/index.ts` — CSP, CORS, and security header middleware
- `src/mastra/middleware/index.ts` — `cspMiddleware` (per-request nonce + header emission)
- `scripts/check-no-inline-styles.sh` — guardrail that blocks new inline `style="..."` attributes
- `tests/noInlineStyles.test.ts` — integration-test wrapper that runs the inline-style guardrail under `npm test` / CI
- `scripts/check-no-inline-handlers.sh` — guardrail that blocks new inline event-handler attributes (`onclick=` etc.)
- `tests/noInlineHandlers.test.ts` — integration-test wrapper that runs the inline-handler guardrail under `npm test` / CI
- `.githooks/pre-commit` — local pre-commit hook that runs both guardrails before every commit (instant feedback, blocks the commit on violation)
- `.githooks/pre-push` — local pre-push hook that re-runs both guardrails on the full tree before every push (second safety net; blocks the push on violation)
- `scripts/install-git-hooks.sh` — auto-wires `core.hooksPath = .githooks` for the local clone; invoked by the `prepare` npm script on every `npm install`

---

### 5.6 Rate Limiting Policy

| Path Category | Limit | Window |
|---------------|-------|--------|
| Auth endpoints (/api/auth/, /api/invitations/accept, /login, /api/admin/auth) | 5 requests | 1 minute |
| Export endpoints (*/export*, */pdf*) | 10 requests | 1 minute |
| Write operations (POST, PUT, PATCH, DELETE) | 10 requests | 1 minute |
| Read operations (GET) | 100 requests | 1 minute |

| Property | Value |
|----------|-------|
| Tracking | Per IP address |
| Response | 429 Too Many Requests with Retry-After header |
| Cleanup | Automatic entry expiry every 60 seconds |

#### Implementation Files
- `src/utils/rateLimiter.ts` — Rate limiter with path-aware categorization

#### Testing & validation

The rate limiter is exercised by both unit and integration suites:

| Suite | Purpose | How it runs |
|-------|---------|-------------|
| `tests/rateLimiter.test.ts` | Unit coverage of path categorization, counter expiry, `Retry-After` header. | Default `npm test` run. |
| `tests/rateLimiterIntegration.e2e.test.ts` | End-to-end check that the limiter actually engages against a live Hono server (auth, write, read, export categories) and that 429 responses include the correct `Retry-After`. | Opt-in: requires `RUN_RATE_LIMITER_INTEGRATION_E2E=1` so it does not slow the default suite. |

Operational caveat — `RATE_LIMIT_DISABLED`: the limiter honours
`process.env.RATE_LIMIT_DISABLED=1` as a global kill-switch. This exists for
the integration tests above and for short-lived local debugging only. It must
**never** be set in production or staging environments. The startup banner in
`src/mastra/index.ts` logs a `[rateLimiter] DISABLED via RATE_LIMIT_DISABLED`
warning whenever the flag is observed; CI fails any deployment whose runtime
env exports the flag with a truthy value.

---

### 5.7 Authentication Policy

| Property | Value |
|----------|-------|
| Primary method | IdentityProvider OAuth 2.0 |
| Secondary method | Admin API Key (X-Admin-Key header or admin_key HttpOnly cookie) |
| Session token | HMAC-SHA256 signed, 7-day expiry |
| Cookie flags | HttpOnly, Secure (production), SameSite=Strict, Path=/ |
| Admin key storage | HttpOnly cookie (migrated from localStorage) |
| OAuth CSRF protection | state parameter validated against oauth_state cookie |
| Logout | POST only (no GET-based logout) |
| Default role | department_viewer (least privilege) |

#### Public Paths (No Auth Required)
- `/login`, `/guide`, `/accept-invite`
- `/api/auth/IdentityProvider`, `/api/auth/IdentityProvider/callback`
- `/api/auth/me`, `/api/auth/logout`
- `/api/invitations/validate/:token`, `/api/invitations/accept`
- `/api/admin/auth`, `/api/admin/auth/logout`

#### Implementation Files
- `src/mastra/routes/authRoutes.ts` — OAuth flow, session management
- `src/mastra/index.ts` — Global auth middleware, public paths
- `src/utils/rbacMiddleware.ts` — `getAdminKey()`, `requireAdminOrKey()`

#### Auth Cookie Inventory

The platform issues exactly three auth-related cookies. Each cookie has a
fixed flag set; deviations require updating both this table and the matching
guardrail script in the same change.

| Cookie | Set by | Purpose | HttpOnly | Secure | SameSite | Path | Max-Age | Notes |
|--------|--------|---------|----------|--------|----------|------|---------|-------|
| `admin_key` | `src/mastra/routes/adminApiRoutes.ts` (`/api/admin/auth`, `/api/admin/auth/logout`) and `src/mastra/routes/authRoutes.ts` (`/api/auth/logout`, `/api/logout` clear it) | Carries the admin API key for the admin-key auth path. High-privilege Bearer <REDACTED_TOKEN> | **always** | **always** (unconditional, even on local HTTP) | **Strict** (unconditional) | `/` | 28800 (set) / 0 (clear) | All three flags are unconditional and must never be made conditional on `isSecureDomain()`. Enforced by `scripts/check-admin-cookie-flags.sh` (`tests/adminCookieFlags.test.ts`). |
| `ExampleOrg_session` | `src/mastra/routes/authRoutes.ts` (`/api/callback` set; `/api/auth/logout` + `/api/logout` clear) | Signed OIDC session token (HMAC-SHA256, 7-day expiry). | **always** | conditional via `${secure ? "; Secure" : ""}` where `secure = isSecureDomain()` | **Lax** (top-level OIDC redirect must carry the cookie back) | `/` | `SESSION_MAX_AGE` (set) / 0 (clear) | `Secure` is omitted only on plain-HTTP local dev so the cookie still round-trips; production is always HTTPS so `isSecureDomain()` returns true and `Secure` is emitted. SameSite is `Lax` — not `Strict` — because the OIDC provider redirects the user agent back to `/api/callback` cross-site, and `Strict` would strip the cookie on that navigation. |
| `oauth_data` | `src/mastra/routes/authRoutes.ts` (`/api/login` set; `/api/callback` clear) | Short-lived (600 s) PKCE/state/nonce envelope tying a `/api/login` request to its `/api/callback`. Cleared on success. | **always** | conditional via `${secure ? "; Secure" : ""}` | **Lax** (same OIDC top-level-redirect reason as `ExampleOrg_session`) | `/` | 600 (set) / 0 (clear) | `Secure` is conditional for the same plain-HTTP-dev reason as `ExampleOrg_session`. |

**Why the conditional `Secure` is acceptable on `ExampleOrg_session` /
`oauth_data` but not on `admin_key`:** the admin key is a long-lived Bearer <REDACTED_TOKEN> that grants full admin access; we accept the inconvenience of
local-dev breakage to guarantee it is never transmitted in cleartext, even
by mistake. The OIDC session and the 600-second oauth_data envelope are
issued only by the OIDC flow, which on production always runs over HTTPS
(`isSecureDomain()` returns true), so the conditional adds dev ergonomics
without weakening production security.

**Static guardrails (CI-enforced on every PR via `tests/runIntegrationTests.ts`):**
- `scripts/check-admin-cookie-flags.sh` — asserts every `admin_key`
  `Set-Cookie` line in `src/mastra/routes/` carries `HttpOnly`, `Secure`,
  and `SameSite=Strict` unconditionally. Wrapped by
  `tests/adminCookieFlags.test.ts`.
- `scripts/check-auth-cookie-flags.sh` — asserts every `ExampleOrg_session`
  and `oauth_data` `Set-Cookie` line in `src/mastra/routes/` carries
  `HttpOnly`, `SameSite=Lax`, `Path=/`, and the literal token `Secure`
  (matching either an unconditional emission or the documented
  `${secure ? "; Secure" : ""}` ternary). Wrapped by
  `tests/authCookieFlags.test.ts`.

If a future change legitimately needs to alter any flag in this table, update
this section, the matching guardrail script, and the inline `// Security:`
comment on the cookie-emitting line in the same commit.

#### Secrets Rotation Log

The `ADMIN_API_KEY` secret is rotated out-of-band whenever a related security
property of the `admin_key` cookie changes, on annual cadence, or on suspected
compromise. Rotation is performed by replacing the secret in the platform
environment store; the new value takes effect on the next process start, and the
previous value is no longer accepted by `src/mastra/routes/adminApiRoutes.ts`
(the `/api/admin/auth` handler reads the current `process.env.ADMIN_API_KEY` on
every authentication request).

| Date | Secret | Reason | Operator | Verification |
|------|--------|--------|----------|--------------|
| April 25, 2026 | `ADMIN_API_KEY` | Precautionary rotation following the `admin_key` cookie hardening from `SameSite=Lax` to `SameSite=Strict`. The prior `Lax` setting left a theoretical CSRF window for cross-site POST against admin endpoints during the time the previous key was active. `HttpOnly` was already in place, so XSS exfiltration was not in scope. | ExampleOrg Platform Engineering | New high-entropy value (≥ 256 bits) installed via the platform secrets store; prior key confirmed rejected by `/api/admin/auth` (returns HTTP 401 with `{"error":"Authentication required"}`). |
| April 26, 2026 | `ADMIN_API_KEY` | Operator usability rotation: the April 25 high-entropy value (64 hex / 256 bits) was difficult to recall and was tripping legitimate admin logins. Replaced with a memorable mnemonic passphrase that still clears the §5.7 startup strength gate (≥ 32 chars, ≥ 10 distinct). Prior 64-hex value retired. | ExampleOrg Platform Engineering (operator-initiated) | Strength check: 38 chars, 25 distinct (both criteria pass). Workflow restarted to reload `process.env.ADMIN_API_KEY`. `POST /api/admin/auth` with the **April 25** value returns HTTP 401 `{"error":"Authentication required"}`; with the **April 26** value returns HTTP 200 `{"success":true}` and sets the `admin_key` HttpOnly/Secure/SameSite=Strict cookie. |

Rotation procedure:
1. Generate a new high-entropy value (e.g. `openssl rand -hex 32` — 64 hex chars / 256 bits of entropy).
2. Replace the `ADMIN_API_KEY` secret in the platform environment store (HostingPlatform Secrets). Do **not** commit it to source control or write it to disk.
3. Restart the application workflow so the new value is loaded into `process.env`.
4. Verify: `POST /api/admin/auth` with the **old** key returns HTTP 401; the **new** key returns HTTP 200 and sets the `admin_key` HttpOnly/Secure/SameSite=Strict cookie.
5. Append a new row to the table above with the date, reason, operator, and verification notes.

##### Enforced minimum strength (startup gate)

The bootstrap path in `src/mastra/index.ts` calls
`assertAdminApiKeyStrengthOrThrow()` from `src/utils/rbacMiddleware.ts`
**before** `new Mastra({...})` registers any `/api/admin/*` route. The check
mirrors the rotation guidance above and refuses to start the server when a
configured `ADMIN_API_KEY`:

| Criterion | Minimum | Rationale |
|-----------|---------|-----------|
| Total length | ≥ **32** characters | Matches `openssl rand -hex 32` (64 hex chars / 256 bits) and tolerates other generators (base64url, urandom-derived tokens) at comparable length. |
| Distinct characters | ≥ **10** | Catches degenerate rotations like `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` or `passwordpasswordpasswordpassword` without rejecting reasonable random tokens. |

Failure mode: the process logs every failed criterion and throws, aborting
bootstrap. A weak key therefore can never serve a single admin request.
`ADMIN_API_KEY` being **unset** is *not* a startup failure — the dashboard's
`Setup Required` page flow handles first-run / unconfigured platforms via
`isAdminKeyConfigured()`. Step 1 above (`openssl rand -hex 32`) clears both
thresholds with very high probability; if you generate a key by hand, ensure
it meets both criteria before installing it.

Coverage: `tests/adminApiKeyStrength.test.ts` exercises the accept and reject
paths of `validateAdminApiKeyStrength()` and the wrapping startup gate.

---

### 5.8 Input Sanitization Policy

| Protection | Implementation |
|-----------|----------------|
| HTML tag stripping | Regex removal of all HTML tags from string inputs |
| Script injection | javascript:, eval(), expression() patterns removed |
| Event handlers | on* attributes stripped |
| Prototype pollution | __proto__, constructor, prototype keys removed |
| CSV formula injection | Leading =, +, -, @, \t, \r characters stripped |
| Field length limits | Enforced per MAX_LENGTHS configuration |
| Financial validation | Non-negative, max 1 billion per field |

#### Implementation Files
- `src/utils/inputSanitizer.ts` — All sanitization and validation functions

---

### 5.9 Safe Rendering Rules (Stored XSS Prevention)

These rules apply to all dashboard JavaScript that renders API-sourced data into the DOM. A violation creates a stored XSS vulnerability.

#### Core Rules

| Rule | Required Practice | Violation |
|------|-------------------|-----------|
| **SR-1** | Use `element.textContent = value` for all plain-text output | `element.innerHTML = value` with API data |
| **SR-2** | HTML-escape every API field used in a template literal inside `.innerHTML` | Unescaped `${field}` in innerHTML template |
| **SR-3** | Validate numeric IDs as safe integers before embedding in event attributes | `onclick="fn(${n.id})"` without integer validation |
| **SR-4** | CSS class names derived from API data must be validated against an allowlist | `class="status-${o.status}"` without allowlist check |
| **SR-5** | Use `SafeRender.escape()` or the local `escapeHtml()` function; never roll your own ad-hoc escaping | Custom regex that misses edge cases |
| **SR-6** | `SafeRender.setHtml()` (and `.innerHTML =`) is only permitted for **static, developer-authored** markup | Using `setHtml` / `.innerHTML` with any computed or API-derived string |

#### Shared Helper — `dashboard/js/safe-render.js`

All dashboard pages should load this file. It provides:
- `SafeRender.escape(str)` — HTML-escape for use in template literals inside `.innerHTML`
- `SafeRender.setText(el, value)` — safe equivalent of `.textContent =`
- `SafeRender.safeInt(value)` — validates a value is a non-negative integer (for IDs in event attributes)
- `SafeRender.allow(value, allowedList, fallback)` — allowlist validation for class names / enum fields
- `SafeRender.appendText(parent, tag, text, className)` — creates and appends an element safely
- `SafeRender.setHtml(el, staticHtml)` — explicitly named to make unsafe use visible in code review

#### Already-fixed locations (April 2026)

| File | Field(s) Fixed | Technique |
|------|---------------|-----------|
| `dashboard/js/navigation.js` | `n.module` (CSS class + text), `n.id` (onclick attribute) | Allowlist for module; `safeInt` pattern for ID |
| `dashboard/duplicates.html` | `l.detection_type`, `l.triggered_by`, `l.status` (log table) | `escapeHtml()` + status allowlist |
| `dashboard/duplicates.html` | `o.rag_status` (CSS class), `c.confidence_level`, `cluster.confidence_level` | Inline allowlist `['green','amber','red']` / `['high','medium','low']` |
| `dashboard/feedback.html` | All user-visible fields | `escapeHtml()` already applied before this task |
| `dashboard/tablef.html` | All user-visible fields | `escapeHtml()` already applied before this task |

#### AI-generated content — `ai-consultant-widget.js`

The `renderMarkdown()` function in `ai-consultant-widget.js` HTML-escapes all text content before rendering. AI responses are rendered safely. Static error strings in this file are developer-authored (no escaping needed).

#### Code Review Checklist for Stored XSS

When reviewing any PR that touches dashboard JavaScript:
- [ ] Search for `.innerHTML =` — every instance must use only static markup or `escapeHtml()`-escaped data
- [ ] Search for `` `<`` in template literals — confirm all interpolated fields are escaped
- [ ] Search for `onclick=` with interpolated values — confirm IDs are validated as integers
- [ ] Search for `class="${` — confirm class name values are allowlist-validated
- [ ] Confirm new API fields are not implicitly trusted as safe

#### Implementation Files
- `dashboard/js/safe-render.js` — Shared safe-render helpers (canonical `escapeHtml`, `safeInt`, `allow`, etc.)
- `dashboard/js/navigation.js` — Notification list rendering (fixed April 2026)
- `dashboard/duplicates.html` — Log table and owner RAG status rendering (fixed April 2026)

---

### 5.10 Storage Health Monitoring & Quiet Hours

The storage-health monitor (`src/utils/storageHealthMonitor.ts`) periodically
samples Postgres usage and emits ChatProvider/email alerts when free-space or growth
thresholds are crossed. To prevent alert fatigue during scheduled maintenance
or off-hours, alert delivery (not measurement) can be muted via a configurable
quiet-hours window:

| Variable | Purpose | Format / Default |
|----------|---------|------------------|
| `STORAGE_HEALTH_QUIET_HOURS_START` | Inclusive start of the daily mute window. | `HH:MM` 24-hour, e.g. `22:00`. Unset = no quiet hours. |
| `STORAGE_HEALTH_QUIET_HOURS_END`   | Exclusive end of the daily mute window.   | `HH:MM` 24-hour, e.g. `06:00`. Required when start is set. |
| `STORAGE_HEALTH_QUIET_HOURS_TZ`    | IANA timezone the window is evaluated in. | e.g. `Africa/Cairo`. Defaults to `UTC` when unset. |

Behavioural guarantees:

- **Measurements are never skipped.** The monitor still polls Postgres and
  records every sample to `storage_health_samples`; only outbound
  ChatProvider/email notifications are suppressed during the window.
- **Critical alerts override the mute.** Samples flagged `severity=critical`
  (e.g. < 5% free space) bypass quiet hours so on-call is always paged.
- **Cross-midnight windows are supported.** A window like `22:00`–`06:00`
  correctly covers the overnight period in the configured timezone.
- **Misconfigured windows fail open.** If either bound is missing, malformed,
  or the timezone is invalid, the monitor logs a warning and disables quiet
  hours rather than silently dropping alerts.

Coverage: `tests/storageHealthQuietHours.test.ts` exercises window parsing,
timezone handling, cross-midnight windows, the critical-severity override,
and fail-open behaviour for malformed input.

#### Implementation Files
- `src/utils/storageHealthMonitor.ts` — Sampler, threshold logic, quiet-hours gate
- `src/utils/quietHoursWindow.ts` — Reusable HH:MM/IANA window parser

---

### 5.11 AI Metrics Retention Pruning & Notifier

The AI telemetry tables (`ai_telemetry_events`, `ai_pending_actions`,
`ai_metrics_*`) are pruned on a scheduled cadence by
`src/utils/aiMetricsRetention.ts`. Manual prunes — invoked via the admin
dashboard or the `scripts/pruneAiMetrics.ts` CLI — additionally surface a
human-readable summary to the configured notification channels so operators
have an audit trail outside the database.

| Variable | Purpose | Default |
|----------|---------|---------|
| `AI_METRICS_RETENTION_PRUNE_NOTIFY` | When `1`/`true`, manual prunes post a ChatProvider/email summary (rows deleted per table, retention window, operator). | `0` (off) |
| `AI_METRICS_RETENTION_DAYS` | Existing retention window used by both scheduled and manual prunes. | `90` |

Notifier guarantees:

- **Scheduled prunes are unaffected** — only operator-initiated runs notify,
  to avoid drowning channels in routine cron output.
- **Operator identity is preserved.** The notifier captures the admin user
  email (or `cli:<hostname>` for CLI invocations) and the request ID so the
  message can be cross-referenced with the audit log.
- **Failure is non-fatal.** If the notifier transport (ChatProvider webhook, SMTP)
  fails, the prune itself still commits and the failure is logged at WARN
  with the redacted notifier payload — pruning correctness never depends on
  the notifier.

Coverage: `tests/aiMetricsRetentionNotifier.test.ts` exercises the on/off
flag, scheduled-vs-manual gating, operator-identity capture, and the
fail-open behaviour when the transport throws.

#### Implementation Files
- `src/utils/aiMetricsRetention.ts` — Prune logic + notifier hook
- `scripts/pruneAiMetrics.ts` — Operator CLI

---

### 5.12 Post-Restore Verification Alerts

Following any database restore (point-in-time recovery, branch promotion, or
manual `pg_restore`), the platform runs a sweep that compares per-table row
counts against the pre-restore baseline and surfaces deltas in the
**Post-Restore Sweep** dashboard panel (`/admin/post-restore`).

The panel renders:

- **Per-table row counts** — current vs. baseline with absolute delta and
  percentage change. Tables with deltas outside ±1% are flagged amber;
  outside ±5% are flagged red.
- **Deep link to the runbook** — every flagged table row links directly to
  the corresponding section of `docs/runbooks/post_restore_recovery.md` so
  the responder lands on the exact remediation step (e.g. re-running the
  audit-log redaction sweep, refreshing materialised views, replaying the
  Inngest dead-letter queue) without scrolling.

Operational rules:

- **The sweep is read-only.** It never mutates data; remediation is always a
  follow-up action triggered by an operator.
- **The baseline is captured at backup time** by `scripts/captureRestoreBaseline.ts`
  and stored in `restore_baselines`. A restore without a baseline shows the
  panel in `unknown` state with a clear "no baseline available" banner —
  rather than silently passing.
- **Sensitive tables are listed first.** `event_logs`, `change_history`, and
  `ai_pending_actions` are pinned to the top of the panel so audit-integrity
  regressions are seen before low-severity drift.

Coverage: `tests/postRestoreSweepPanel.spec.ts` (Playwright) verifies the
panel renders the per-table table, applies the amber/red thresholds, and
that every flagged row's deep link resolves to a non-empty runbook anchor.

#### Implementation Files
- `src/mastra/routes/postRestoreRoutes.ts` — Sweep API
- `dashboard/post-restore.html` — Panel UI
- `scripts/captureRestoreBaseline.ts` — Baseline capture
- `docs/runbooks/post_restore_recovery.md` — Deep-link target runbook

---

### 5.13 Vendored Dependency Patches

A small number of upstream npm packages ship code or declarations that break
the platform when used as-is. To keep both the TypeScript build and the
production deployment bundle clean without forking each package, the platform
uses a single deterministic post-install patch step that applies a list of
surgical, scoped, idempotent patches.

| Step | File | Purpose |
|------|------|---------|
| `postinstall` script | `package.json` | Runs `node scripts/patch-mastra-core.mjs` after every `npm install` (including the deploy build's install step). |
| Patch script | `scripts/patch-mastra-core.mjs` | Iterates the patch list below. Each patch is idempotent, scoped to a single file + single line, and exits silently if its target is missing. |

#### Patches applied

| # | Target file | Symptom without patch | Fix |
|---|-------------|----------------------|-----|
| 1 | `node_modules/@mastra/core/dist/llm/model/provider-types.generated.d.ts` | `tsc --noEmit` and `npm run check` cascade-fail with 200+ errors because the unquoted `readonly 302ai:` property key starts with a digit (not a valid TS identifier). | Quote the key as `readonly '302ai':`. (Task #641.) |
| 2 | `node_modules/lazystream/lib/lazystream.js` | The deployed `mastra build` bundle crashes on startup with `ERR_MODULE_NOT_FOUND: Cannot find module '...readable-stream/passthrough'`. The local Repl works only because lazystream's nested `node_modules/<REDACTED_EMAIL>` happens to expose `passthrough.js` at the package root; the production install flattens to a single top-level `<REDACTED_EMAIL>`, which has no such file. | Rewrite line 2 from `require('readable-stream/passthrough')` to `require('readable-stream').PassThrough` — the public named export, identical behaviour on `<REDACTED_EMAIL>` and `@3`. (Discovered April 26, 2026 from a deployment crash-loop.) |

Operational guarantees:

- **Idempotent.** Running the patch twice in a row leaves both files
  byte-identical the second time. Verified by running the script twice and
  asserting no second-run output.
- **Bounded scope.** Each patch resolves a single, hard-coded file path
  under `node_modules/` and uses an exact regex match. Anything outside the
  matched pattern is left untouched.
- **Fail-safe.** A missing target file is treated as "package not installed
  yet" and skipped, so the script never blocks `npm install`.
- **Self-deprecating.** When upstream ships a fix, the regex no longer
  matches and that patch becomes a permanent no-op; the entry can then be
  removed from the script and from this table.

#### Implementation Files
- `scripts/patch-mastra-core.mjs` — Idempotent post-install patcher (multiple patches)
- `package.json` — `postinstall` hook wiring

---

### 5.14 Streaming-Export Cache Location Health Check

The platform stages streaming XLSX/CSV exports to a per-job temp file under
`${tmpdir}/ExampleOrg-export-cache` (or the override path in
`STREAMING_EXPORT_CACHE_DIR`) so interrupted multi-GB downloads can resume
via HTTP Range. The cache directory itself is locked down to mode `0o700`
and every staged file to `0o600`, but those modes only protect the *contents*
of the directory — the file *names* (which embed tenant + report identifiers
via the cache key) are still discoverable through parent-directory traversal
when an ancestor grants group/other read or execute.

To catch the misconfiguration on day one rather than during an audit, the
worker runs a one-shot health check at boot
(`checkStagedExportCacheLocation()` in `src/utils/excelExport.ts`).

| Aspect | Behaviour |
|--------|-----------|
| When it runs | Once during Mastra startup, alongside the ADMIN_API_KEY strength gate. The probe first calls `ensureStagedExportDir()` so the resolved path actually exists on disk before the ancestor walk — this materialises any missing segments at mode `0o700` (Node's `mkdir(recursive: true, mode: 0o700)` applies the mode to every newly-created intermediate, not just the leaf), so the worker hardens the operator's path on its own behalf. The walk then runs against the now-existing chain. |
| When it stays silent | `STREAMING_EXPORT_CACHE_DIR` is unset (default `/tmp`-based path on a single-tenant box; `/tmp` is intentionally sticky-bit world-traversable). Also silent on `win32` where Node ignores fs modes, and silent whenever the operator-controlled portion of the configured path has any single owner-only (`0o700`) ancestor between the cache dir and the system boundary — that tight barrier blocks non-owners from traversing past it, so anything above it is irrelevant. Crucially: when the worker is the one that creates a missing parent segment, that segment comes out at `0o700` and contributes no findings. |
| What the walk does | Walks parents upward from the resolved cache directory, reporting each ancestor whose mode has group/other read or execute (`mode & 0o055 ≠ 0`). The walk stops at the first owner-only ancestor (tight barrier) **and** at well-known system roots the operator cannot meaningfully `chmod` (`/`, the resolved `os.tmpdir()`, and the FHS roots `/var`, `/srv`, `/opt`, `/usr`, `/home`, `/mnt`, `/run`). Only the operator-controlled segments below those boundaries are scanned. |
| When it warns | An ancestor of the cache dir was created out-of-band (by ops provisioning, `install -d`, an older build, a sibling service, etc.) at `0o755` (or otherwise group/other r+x) and the worker does not own it tightly enough to silently fix it. Example: env override `/srv/shared/exports` where `/srv/shared` was pre-provisioned by ops at `0o755 root:deploy`. The structured warning lists each offending ancestor with its octal mode and a recommended fix. |

#### Recommended fix when the warning fires

Pick whichever is simpler in your environment:

1. **Tighten the offending ancestor.** `chmod o-rx,g-rx /srv/shared` (or
   whichever path the warning lists). The worker should normally be the
   owner — if not, `chown` it to the worker user as well. Re-run the worker;
   the warning should disappear.
2. **Re-point the cache under a tight parent.** Set
   `STREAMING_EXPORT_CACHE_DIR` to a path whose immediate (or any) parent is
   owned by the worker user and `chmod 0o700` — e.g.
   `/var/lib/ExampleOrg/export-cache` with `/var/lib/ExampleOrg` chmod `0o700`.
   The tight `0o700` barrier short-circuits the walk before it ever reaches
   `/var/lib`, so no findings are produced.

#### Implementation Files

- `src/utils/excelExport.ts` — `checkStagedExportCacheLocation()` and the
  `ExportCacheLocationCheckResult` shape it returns for tests.
- `src/mastra/index.ts` — calls the check during the boot sequence.

---

## 6. Cross-Reference Table — All 39 Findings

| # | Finding ID | Title | Severity | CVSS | Domain | Status | Primary Files Modified |
|---|-----------|-------|----------|------|--------|--------|----------------------|
| 1 | QMS-001 | Complete Privilege Escalation Chain via Invitation System | Critical | 9.8 | Access Control | Fixed | rbacMiddleware.ts, userAccessRoutes.ts |
| 2 | QMS-002 | Invitation Token Exposure to All Authenticated Users | Critical | 9.1 | Access Control | Fixed | userAccessRoutes.ts, rbacMiddleware.ts |
| 3 | QMS-003 | Cross-User Privilege Manipulation | Critical | 9.1 | Access Control | Fixed | userAccessRoutes.ts, rbacMiddleware.ts |
| 4 | QMS-004 | Unauthenticated Inngest Scheduler Endpoint with Stack Trace | Critical | 9.3 | Infrastructure | Fixed | index.ts |
| 5 | QMS-007 | BFLA — Viewer Can Modify Any Resource | Critical | 9.1 | Access Control | Fixed | rbacMiddleware.ts, index.ts |
| 6 | QMS-008 | BFLA — Viewer Can Create Resources in All Modules | Critical | 9.1 | Access Control | Fixed | rbacMiddleware.ts, index.ts |
| 7 | QMS-010 | Self Privilege Escalation via Role Change | Critical | 9.1 | Access Control | Fixed | userAccessRoutes.ts |
| 8 | QMS-011 | Unauthorized User Approval by Viewer | Critical | 9.1 | Access Control | Fixed | userAccessRoutes.ts, rbacMiddleware.ts |
| 9 | QMS-005 | Audit Log Injection — Admin Activity Spoofing | High | 8.7 | Audit Integrity | Fixed | eventLogsRoutes.ts |
| 10 | QMS-006 | Zero Password Policy on Account Creation | High | 8.6 | Authentication | Fixed | inputSanitizer.ts, userAccessRoutes.ts, accept-invite.html |
| 11 | QMS-009 | Full User PII Exposure via /api/users | High | 8.6 | Access Control | Fixed | userAccessRoutes.ts |
| 12 | QMS-012 | Policy Approval Workflow Bypass | High | 8.1 | Access Control | Fixed | policyRoutes.ts, rbacMiddleware.ts |
| 13 | QMS-013 | Risk Treatment Workflow Bypass | High | 7.5 | Access Control | Fixed | riskRoutes.ts, rbacMiddleware.ts |
| 14 | QMS-014 | Negative Financial Values Accepted in ROI Module | High | 7.5 | Input Validation | Fixed | inputSanitizer.ts, roiRoutes.ts |
| 15 | QMS-015 | No Input Length Validation — Denial of Service | High | 7.5 | Input Validation | Fixed | inputSanitizer.ts |
| 16 | QMS-016 | Viewer Can Trigger Quality Audits (Admin Function) | High | 7.5 | Access Control | Fixed | auditRoutes.ts, rbacMiddleware.ts |
| 17 | QMS-017 | Spoofed Audit Trail on User Management Actions | High | 7.5 | Audit Integrity | Fixed | userAccessRoutes.ts |
| 18 | QMS-018 | Admin Panel Accessible Without X-Admin-Key | High | 7.5 | Access Control | Fixed | index.ts, rbacMiddleware.ts, dashboard files |
| 19 | QMS-019 | Client-Side Admin Key in localStorage | Medium | 5.3 | Authentication | Fixed | index.ts, rbacMiddleware.ts, dashboard files |
| 20 | QMS-020 | Email Service Configuration Disclosure | Medium | 5.3 | Error Handling | Fixed | userAccessRoutes.ts |
| 21 | QMS-021 | Admin Authentication Endpoint Not Rate Limited | Medium | 5.3 | Infrastructure | Fixed | rateLimiter.ts |
| 22 | QMS-022/ROI | ROI Financial Data Injection by Viewer | Medium | 5.3 | Access Control | Fixed | roiRoutes.ts, rbacMiddleware.ts, inputSanitizer.ts |
| 23 | QMS-022/SQL | SQL Error Disclosure in Export Endpoint | Medium | 5.3 | Error Handling | Fixed | Multiple route files |
| 24 | QMS-023 | Duplicate Invitation Creation — No Deduplication | Medium | 5.3 | Input Validation | Fixed | userAccessRoutes.ts |
| 25 | QMS-024 | CSP Allows unsafe-inline and unsafe-eval | Medium | 5.3 | Infrastructure | Fixed | index.ts |
| 26 | QMS-025 | CORS Wildcard on OPTIONS Preflight and Error Responses | Medium | 5.3 | Infrastructure | Fixed | index.ts |
| 27 | QMS-026 | Rate Limiting Too Permissive (~18 Requests) | Medium | 5.3 | Infrastructure | Fixed | rateLimiter.ts |
| 28 | QMS-027 | CSRF Logout via GET Request | Medium | 5.3 | Infrastructure | Fixed | authRoutes.ts, navigation.js |
| 29 | QMS-028 | CSV Injection — Formula Payloads Stored Without Sanitization | Medium | 5.3 | Input Validation | Fixed | inputSanitizer.ts |
| 30 | QMS-029 | Verbose Error Messages Disclose Field Names | Low | 3.7 | Error Handling | Fixed | All route files, inputSanitizer.ts |
| 31 | QMS-030 | PostgreSQL Type Disclosure via Error Messages | Low | 3.7 | Error Handling | Fixed | All route files, inputSanitizer.ts |
| 32 | QMS-031 | Endpoint Enumeration via Response Code Differentiation | Low | 3.7 | Low-Risk | Fixed | index.ts |
| 33 | QMS-032 | Sequential Resource IDs Enable Enumeration | Low | 3.7 | Low-Risk | Accepted | N/A (mitigated by RBAC) |
| 34 | QMS-033 | IdentityProvider OAuth Client ID Exposed | Low | 3.7 | Low-Risk | Accepted | N/A (by design per RFC 6749) |
| 35 | QMS-034 | Mastra Framework Disclosure in CORS Headers | Low | 3.7 | Low-Risk | Fixed | index.ts |
| 36 | QMS-035 | Mode:MOCK Disclosure via Agent Performance API | Low | 3.7 | Error Handling | Fixed | index.ts |
| 37 | QMS-036 | Broken Export Endpoints (500 Errors) | Low | 3.5 | Low-Risk | Fixed | Various route files |
| 38 | QMS-037 | DELETE Operations Not Implemented | Info | — | Low-Risk | Acknowledged | N/A |
| 39 | QMS-038 | 22 PRD-Documented Endpoints Not Implemented | Info | — | Low-Risk | Acknowledged | N/A |
| 40 | QMS-040 | Stored XSS in Dashboard | High | 8.1 | Input Validation | Fixed | safe-render.js, navigation.js, duplicates.html |

**Severity Distribution Verification:** Critical=8 (rows 1–8), High=11 (rows 9–18, 40), Medium=11 (rows 19–29), Low=8 (rows 30–37), Info=2 (rows 38–39). **Total: 40 findings.**

**Note:** QMS-022 was reported as two distinct sub-findings (QMS-022/ROI covering unauthorized financial data injection, and QMS-022/SQL covering SQL error disclosure), counted as two separate findings in this table.

---

## 7. References

| Document | Location | Description |
|----------|----------|-------------|
| VAPT Remediation Report v1.0 | `docs/VAPT_Remediation_Report.md` | 19 findings from OWASP v4.2 assessment (March 12, 2026) |
| Security Assessment Response | `docs/QMS_Security_Assessment_Response.md` | Comprehensive security questionnaire response |
| Scope of Work | `docs/SCOPE_OF_WORK.md` | Platform technical scope and API reference |
| User Manual | `docs/USER_MANUAL.md` | Platform user documentation |
| RBAC Middleware | `src/utils/rbacMiddleware.ts` | Central RBAC enforcement and ROUTE_PERMISSION_MAP |
| Input Sanitizer | `src/utils/inputSanitizer.ts` | Input validation, sanitization, password policy |
| Rate Limiter | `src/utils/rateLimiter.ts` | Path-aware rate limiting |
| Auth Routes | `src/mastra/routes/authRoutes.ts` | OAuth flow, session management |
| Main Server | `src/mastra/index.ts` | Global middleware, CSP, CORS, security headers |
| Sensitive Field Redaction | `src/utils/eventLogsDatabase.ts` | `redactSensitiveFields()` helper + deny-list rules |
| Change History Redaction | `src/utils/changeHistoryDatabase.ts` | Redaction wired into NC/CAPA change history |
| Historical Redaction Sweep | `src/utils/redactHistoricalLogs.ts` | One-off migration to mask existing audit rows |
| Redaction Tests | `src/utils/redactSensitiveFields.test.ts` | 14 unit tests for the redaction helper |
| Storage Health Monitor | `src/utils/storageHealthMonitor.ts` | Postgres usage sampler with quiet-hours gating |
| Quiet-Hours Window Parser | `src/utils/quietHoursWindow.ts` | HH:MM + IANA timezone window utility (cross-midnight aware) |
| AI Metrics Retention | `src/utils/aiMetricsRetention.ts` | Scheduled + manual prune with optional notifier |
| AI Metrics Prune CLI | `scripts/pruneAiMetrics.ts` | Operator CLI for manual prune runs |
| Post-Restore Sweep API | `src/mastra/routes/postRestoreRoutes.ts` | Per-table row-count comparison vs. baseline |
| Post-Restore Panel | `dashboard/post-restore.html` | Sweep UI with runbook deep links |
| Restore Baseline Capture | `scripts/captureRestoreBaseline.ts` | Pre-backup baseline snapshot |
| Post-Restore Runbook | `docs/runbooks/post_restore_recovery.md` | Deep-link target for flagged tables |
| Mastra Core Patch | `scripts/patch-mastra-core.mjs` | Idempotent post-install `.d.ts` fix-up |

---

## 8. Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | March 12, 2026 | ExampleOrg Security Team | Initial VAPT remediation (19 findings) |
| 2.0 | March 15, 2026 | ExampleOrg Security Team | Security Assessment Response document |
| 3.0 | March 24, 2026 | ExampleOrg Security Team | Pentest v3.0 full remediation (39 findings), comprehensive SOP |
| 3.1 | April 24, 2026 | ExampleOrg Platform Engineering | RBAC lock-down of /api/reports/* routes; Added section 4.8: Audit Log Sensitive Field Masking. Implemented `redactSensitiveFields()` deny-list helper, wired into all event_logs and change_history write paths, retroactive sweep script, regression tests. In-handler requireRole() defense-in-depth; updated §5.1 Report Route Access Control table. |
| 4.0 | April 24, 2026 | ExampleOrg Security Team | Stored XSS remediation: shared safe-render helper, innerHTML escaping fixes (navigation.js, duplicates.html), CSP nonce enforcement (removed unsafe-inline from script-src), Safe Rendering Rules (§5.9) |
| 4.1 | April 24, 2026 | ExampleOrg Platform Engineering | Extended §4.8: added `redactSecretLikeStrings()` regex deny-list (sk-*, ghp_*, JWT, bcrypt, AWS, IdentityProvider, ChatProvider, GitLab, Bearer) and wired it into `enqueuePendingAction()` so the `ai_pending_actions.payload_preview` TEXT column is sanitised in addition to the JSONB columns; added preview-string assertions to `tests/aiApprovalRedaction.test.ts`. |
| 4.2 | April 24, 2026 | ExampleOrg Platform Engineering | §4.8 Historical Data Sweep extended to cover `ai_pending_actions.payload_preview` (TEXT): `redactHistoricalLogs.ts` now runs `redactSecretLikeStrings()` over each existing preview string and UPDATEs only rows whose sanitised value differs (idempotent). Added `tests/redactHistoricalPreview.test.ts` (27 assertions) verifying ghp_… tokens in historical previews are rewritten, clean rows are skipped, and NULL values are handled gracefully. |
| 4.3 | April 25, 2026 | ExampleOrg Platform Engineering | §5.7 Authentication Policy: added **Secrets Rotation Log** subsection with rotation procedure and table; recorded the April 25, 2026 precautionary rotation of `ADMIN_API_KEY` following the `admin_key` cookie tightening from `SameSite=Lax` to `SameSite=Strict`. New high-entropy value (≥ 256 bits) installed in the platform secrets store; prior key no longer accepted by `/api/admin/auth`. |
| 4.5 | April 26, 2026 | ExampleOrg Platform Engineering | §5.7 Secrets Rotation Log: recorded the April 26, 2026 operator-usability rotation of `ADMIN_API_KEY` from the April 25 high-entropy 64-hex value to a memorable mnemonic passphrase (38 chars / 25 distinct — clears the startup strength gate). Workflow restarted; prior value verified rejected, new value verified accepted. |
| 4.6 | April 26, 2026 | ExampleOrg Platform Engineering | §5.13 Vendored Dependency Patches expanded with a second patch entry: `lazystream/lib/lazystream.js` (transitive via `exceljs` → `archiver` → `archiver-utils`) calls `require('readable-stream/passthrough')`, a subpath that only exists in `<REDACTED_EMAIL>`. Local Repl resolves it via lazystream's nested `<REDACTED_EMAIL>`; the production deploy bundle flattens to top-level `<REDACTED_EMAIL>` (no `passthrough.js` at root) and crash-loops with `ERR_MODULE_NOT_FOUND`. Patch rewrites the require to use the public `PassThrough` named export from `readable-stream`'s main entry — identical behaviour on v2 and v3. Applied via the existing `scripts/patch-mastra-core.mjs` postinstall hook (now multi-patch); idempotency reverified. Local app boot, admin auth, and export-route gate confirmed unaffected. |
| 4.7 | May 3, 2026 | ExampleOrg Platform Engineering | Documentation correction: synced stale `admin_key` cookie wording with the production code (`src/mastra/routes/adminApiRoutes.ts`). Updated the §5.7 Authentication Policy "Cookie flags" row from `SameSite=Lax` to `SameSite=Strict`, and rewrote the §4.2 QMS-019 remediation note to reflect the current Strict setting and cross-link the §5.7 Secrets Rotation Log entry for the precautionary `ADMIN_API_KEY` rotation. No code changes; SOP-only fix to remove the last stale `SameSite=Lax` references for the admin cookie. |
| 4.4 | April 26, 2026 | ExampleOrg Platform Engineering | Added §5.10 Storage Health Monitoring & Quiet Hours (`STORAGE_HEALTH_QUIET_HOURS_START/END/TZ`, critical-severity override, fail-open on misconfiguration); §5.11 AI Metrics Retention Pruning & Notifier (`AI_METRICS_RETENTION_PRUNE_NOTIFY`, manual-only gating, operator-identity capture, fail-open notifier); §5.12 Post-Restore Verification Alerts (per-table row-count deltas, amber/red thresholds, runbook deep links, baseline-required policy); §5.13 Vendored Dependency Patches (`scripts/patch-mastra-core.mjs` postinstall hook, idempotency + bounded-scope guarantees). Extended §5.6 with a Testing & validation subsection covering `RUN_RATE_LIMITER_INTEGRATION_E2E` and the `RATE_LIMIT_DISABLED` operational caveat. Added the corresponding implementation files to §7 References. |

**Next Review:** June 2026 (Quarterly)
**Classification:** CONFIDENTIAL — For internal use and security assessment purposes only.
