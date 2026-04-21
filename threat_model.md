# Threat Model

## Project Overview

WalaPlus is an enterprise quality, governance, risk, and compliance platform built with TypeScript on Mastra/Hono, PostgreSQL, and static dashboard pages under `dashboard/`. Users authenticate through Replit OIDC or an invitation flow, then interact with many `/api/*` routes that expose operational, compliance, audit, risk, and AI-assistant features. The application also integrates with third-party services including Zoho CRM, Slack, Resend, OpenAI/OpenRouter, and Google Calendar.

Production assumptions for this scan: only production-reachable code is in scope; `NODE_ENV` is `production`; mockup/sandbox code is out of scope unless proven reachable; TLS is provided by the deployment platform.

## Assets

- **User accounts and sessions** — signed `walaplus_session` cookies, user identities, roles, approval state, and any alternate privileged access material such as `ADMIN_API_KEY`. Compromise allows impersonation and potentially broad administrative access.
- **Governance, audit, and compliance data** — policies, findings, CAPAs, risk records, management reviews, PDPL artifacts, and evidence documents. These are business-sensitive and often compliance-relevant.
- **Operational and CRM data** — Zoho-derived records, call intelligence, dashboards, KPI data, and exports. Exposure could reveal internal business performance and personal data.
- **AI-assisted actions and alerts** — consultant conversations, AI alerts, approval workflows, and any agent-triggered write operations. Misuse could alter regulated records or leak sensitive context.
- **Application secrets and service credentials** — database connection strings, session signing secret, admin API key, Slack/Zoho/OpenAI/Resend credentials. Compromise would expand an attacker’s reach beyond the app itself.
- **Uploaded files and generated exports** — policy attachments, evidence references, SVG/PNG infographic outputs, CSV/XLSX exports. These cross trust boundaries and can become active content if mishandled.

## Trust Boundaries

- **Browser to application API** — all dashboard and client traffic crosses from an untrusted browser into `/api/*`. Every request must be authenticated and authorized server-side; client gating is not trusted.
- **Session/admin cookies to server authorization** — the server derives identity and privilege from `walaplus_session` and `admin_key`. Any mistake here directly affects access control.
- **Application to PostgreSQL** — application code has broad database access. Injection or over-broad queries at this boundary can expose large portions of enterprise data.
- **Application to external services** — server-side calls to Zoho, Slack, Resend, OpenAI/OpenRouter, Google Calendar, and webhook endpoints carry secrets and can expose data if abused.
- **Public vs authenticated vs privileged surfaces** — login, invitation acceptance, some webhooks, and selected health/smoke routes are public; most APIs are authenticated; admin and RBAC functions are privileged and must not be reachable via weaker trust paths.
- **User-generated content to browser DOM** — database-backed records and AI output are rendered into dashboard pages. Unsafely injecting that content into HTML would convert stored data into active script.

## Scan Anchors

- **Production entry points:** `src/mastra/index.ts`, `src/mastra/routes/*.ts`, `dashboard/*.html`, `dashboard/js/*.js`
- **Highest-risk code areas:** `src/utils/rbacMiddleware.ts`, `src/mastra/routes/authRoutes.ts`, `src/utils/fileUpload.ts`, consultant/AI routes, admin and user-access routes, pages with heavy `innerHTML` usage
- **Surface split:** public (`/api/login`, `/api/callback`, invitation validation/acceptance, selected webhook/health paths), authenticated (`/api/*` broadly), privileged/admin (`/api/admin/*`, RBAC/user-management flows, admin-key trust paths)
- **Usually dev-only / ignore unless proven reachable:** `attached_assets/**`, tests, docs, scripts

## Threat Categories

### Spoofing

The application trusts two identity mechanisms: the signed session cookie and the alternate admin-key path. The system must only accept authentic sessions signed with `SESSION_SECRET`, must bind OIDC callbacks to the correct state/nonce flow, and must ensure the admin-key path cannot be abused as a weaker substitute for real user authentication. Privileged cookies, headers, and webhook-like entry points must not allow an attacker to impersonate an admin, a normal user, or an internal service.

### Tampering

Many routes accept JSON bodies, form uploads, query parameters, and AI prompts that influence downstream behavior. The system must validate all attacker-controlled inputs before they affect stored compliance records, policy metadata, exports, notifications, or external-service calls. File and export features must prevent attackers from turning stored content into an unexpected active payload or altering protected records without authorization.

### Information Disclosure

The platform stores sensitive business, compliance, and user-management data. APIs and dashboards must return only data appropriate for the caller’s current role, must avoid leaking secrets or privileged metadata in responses and logs, and must not expose admin, PDPL, or AI-alert content through overly broad reads. Uploaded documents and exports must remain scoped to authorized users.

### Denial of Service

Public and authenticated endpoints include AI features, report generation, health scans, uploads, and external-service integrations that can be expensive. The system must ensure that rate limiting, body-size restrictions, and timeouts prevent untrusted callers from triggering disproportionate CPU, database, or third-party API usage.

### Elevation of Privilege

This application has a dense permission model and many privileged routes. The system must enforce current server-side authorization on every sensitive operation, not rely on stale session claims or dashboard-only gating, and must keep admin-only capabilities isolated from ordinary authenticated users. Injection, DOM XSS, path traversal, and alternate auth-path mistakes are especially relevant because they could convert lower-privilege access into administrative control.
