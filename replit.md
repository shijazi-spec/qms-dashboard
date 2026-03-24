# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. Built with Mastra (AI agent framework), Hono for HTTP, PostgreSQL, and Inngest for workflow orchestration. Serves HTML dashboards on port 5000 via Mastra dev server, designed for Autoscale deployment.

## Architecture
- **Framework**: Mastra (AI agent framework) with Hono HTTP server
- **Frontend**: Static HTML dashboards served from `dashboard/` directory
- **Backend**: Mastra API routes with Hono handlers
- **Database**: PostgreSQL (39+ tables) via `pg` module
- **AI**: GPT-4o via Replit AI Integrations / OpenAI
- **Workflows**: Inngest for event-driven workflow orchestration
- **Auth**: Google OAuth 2.0 with signed session cookies (SESSION_SECRET)
- **Email**: Resend for outgoing emails

## Project Structure
- `src/mastra/index.ts` - Main Mastra configuration (agents, tools, routes, server config, auth middleware)
- `src/mastra/agents/` - AI agent definitions
- `src/mastra/tools/` - AI tool definitions (callAnalysis, capaManagement, crmCompliance, etc.)
- `src/mastra/workflows/` - Mastra workflow definitions
- `src/mastra/routes/authRoutes.ts` - Google OAuth 2.0 routes and session management
- `src/mastra/data/` - Data layer and mock data
- `src/mastra/storage/` - Storage configuration
- `src/utils/` - Database utilities (audit, compliance, KPI, risk, policy, vendor, etc.)
- `src/triggers/` - Cron, Slack, Telegram triggers
- `dashboard/` - Static HTML dashboards (index.html, audits.html, login.html, etc.)
- `dashboard/css/` - Shared navigation CSS
- `dashboard/js/` - Shared navigation JS (includes user avatar/logout in nav bar)
- `scripts/` - Build and inngest scripts
- `docs/mastra/` - Mastra documentation
- `tests/` - Test files

## Dashboards
- `/` - Main Quality Dashboard
- `/grc` - GRC Control Tower
- `/admin` - Admin Panel (requires ADMIN_API_KEY)
- `/qms` - QMS Dashboard (requires ADMIN_API_KEY)
- `/audits` - Audit Readiness
- `/compliance` - Compliance Tracking
- `/risks` - Risk Register
- `/policies` - Policy Governance
- `/vendors` - Vendor Risk Management
- `/calls` - Call Intelligence
- `/roi` - ROI & NPV Evaluation
- `/team` - Team Performance
- `/projects` - PMP Project Portfolio
- `/logs` - System Event Logs
- `/pdpl` - PDPL Privacy Compliance
- `/users` - Users & Access Control
- `/sandbox` - Testing Sandbox
- `/kpis` - KPI Tracking
- `/scorecard` - Scorecard
- `/duplicates` - Duplicate Radar
- `/migration` - Data Migration
- `/crm` - CRM Integration
- `/feedback` - Feedback
- `/onboarding` - Onboarding
- `/tablef` - Table F Governance

## Running
- `npm run dev` runs `mastra dev` which starts the Hono server on port 5000
- Inngest dev server runs on port 3000

## Authentication & Security
- **Google OAuth 2.0**: Primary login method via "Sign in with Google" on `/login`
- **Session**: HMAC-signed cookies using `SESSION_SECRET`, 7-day expiry, HttpOnly/Secure/SameSite=Lax flags
- **Routes**: `GET /api/auth/google` (initiate), `GET /api/auth/google/callback` (callback), `GET /api/auth/me` (session check), `POST|GET /api/auth/logout`
- **Protection**: All dashboard pages AND API endpoints require valid session. Public pages: `/login`, `/guide`, `/accept-invite`
- **RBAC**: Centralized ROUTE_PERMISSION_MAP in rbacMiddleware.ts enforces per-endpoint role/permission checks globally; roles: admin, grc_manager, quality_manager, ai_specialist, bu_owner, executive, department_viewer
- **API auth**: All API endpoints require Google session cookie or X-Admin-Key header (401 if neither present)
- **CORS**: Restricted to app domain only (no wildcard), derived from REPLIT_DOMAINS
- **Security headers**: CSP (no unsafe-eval, frame-ancestors 'none'), X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy, X-XSS-Protection, Permissions-Policy
- **Input sanitization**: HTML/script tag stripping, CSV formula injection prevention, prototype pollution protection, field-level max-length enforcement
- **Rate limiting**: 100 req/min read, 20 req/min write, 5 req/min auth, 10 req/min export per IP
- **Password policy**: 12+ chars, uppercase, lowercase, number, special character (enforced on invitation acceptance)
- **Error handling**: All error responses return generic messages; no raw error.message exposure
- **ROI validation**: Financial field validation (non-negative, max value, type checking)
- **Invitation deduplication**: Prevents duplicate pending invitations for same email
- **OAuth CSRF**: State parameter validated against oauth_state cookie in callback
- **User storage**: Google users upserted into `platform_users` table with google_id, picture, auth_provider columns
- **Admin key**: Works as alternative auth for API endpoints and admin-only routes
- **Security utilities**: `src/utils/inputSanitizer.ts` (sanitization, validation, CSV escaping, password policy), `src/utils/rateLimiter.ts` (path-aware rate limiting), `src/utils/rbacMiddleware.ts` (RBAC enforcement)

## Key Secrets
- `DATABASE_URL` - PostgreSQL connection string
- `GOOGLE_CLIENT_ID` - Google OAuth 2.0 client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth 2.0 client secret
- `SESSION_SECRET` - Session cookie signing
- `ADMIN_API_KEY` - Admin panel access
- `RESEND_API_KEY` - Email sending via Resend
- `RESEND_FROM_EMAIL` - From address for emails
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` - Zoho CRM integration

## Database Setup
- Tables are auto-initialized by utility modules on first use (auditDatabase.ts, complianceDatabase.ts, kpiDatabase.ts, riskDatabase.ts, policyDatabase.ts, vendorDatabase.ts)
- Additional QMS tables created via `npx tsx scripts/createQMSTables.ts`
- Core tables: quality_scorecards, quality_audit_results, quality_trends, governance_documents + 30+ others
- Data populates through platform usage (call evaluations, audits, governance document uploads)

## Recent Changes
- Pentest v3.0 remediation (Task #3): Error message sanitization, password policy, invitation dedup, CSV formula prevention, ROI validation, rate limit tightening, CSP hardening, auth added to checklist/calendar POST endpoints (Mar 2026)
- Pentest v3.0 remediation (Task #2): Centralized RBAC middleware with ROUTE_PERMISSION_MAP, enforceRoutePermission globally applied, status change blocking, invitation token masking (Mar 2026)
- Security hardening: Fixed all 19 VAPT findings — API auth, CORS, CSP, input sanitization, rate limiting, OAuth state validation (Mar 2026)
- Added Google OAuth 2.0 login with login page, session cookies, and route protection (Feb 2026)
- Fixed audit API schema (VARCHAR foreign keys) and route ordering issues
- All 49 API endpoints verified passing
- Migrated from template scaffold to full WalaPlus QMS codebase (Feb 2026)
- Mastra + Hono + Inngest stack replacing Express + React + Vite

## Security Documentation
- `docs/VAPT_Remediation_Report.md` - VAPT remediation report (19 findings, all resolved)
- `docs/SCOPE_OF_WORK.md` - Full technical scope including Section 8 (Security) and Section 12 (Hosting/Migration)
