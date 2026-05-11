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
- **Session cookies and admin-key headers to server authorization** — the server derives identity and privilege from the signed `walaplus_session` cookie and, for selected server-to-server/admin routes, the `X-Admin-Key` header. Any mistake here directly affects access control.
- **Application to PostgreSQL** — application code has broad database access. Injection or over-broad queries at this boundary can expose large portions of enterprise data.
- **Application to external services** — server-side calls to Zoho, Slack, Resend, OpenAI/OpenRouter, Google Calendar, and webhook endpoints carry secrets and can expose data if abused.
- **Public vs authenticated vs privileged surfaces** — login, invitation acceptance, some webhooks, and selected health/smoke routes are public; most APIs are authenticated; admin and RBAC functions are privileged and must not be reachable via weaker trust paths.
- **User-generated content to browser DOM** — database-backed records and AI output are rendered into dashboard pages. Unsafely injecting that content into HTML would convert stored data into active script.

## Scan Anchors

- **Production entry points:** `src/mastra/index.ts`, `src/mastra/routes/*.ts`, `dashboard/*.html`, `dashboard/js/*.js`
- **Highest-risk code areas:** `src/utils/rbacMiddleware.ts`, `src/mastra/routes/authRoutes.ts`, `src/utils/fileUpload.ts`, consultant/AI routes, onboarding and team routes, trigger/notification routes, report and event-log routes, pages with heavy `innerHTML` usage
- **Surface split:** public (`/api/login`, `/api/callback`, invitation validation/acceptance, selected webhook/health paths), authenticated (`/api/*` broadly), privileged/admin (`/api/admin/*`, RBAC/user-management flows, X-Admin-Key trust paths)
- **Usually dev-only / ignore unless proven reachable:** `attached_assets/**`, tests, docs, scripts

## Current Scan Notes

- **Global API authorization is now enforced on authenticated APIs.** `src/mastra/middleware/index.ts` authenticates non-public `/api/*`, verifies active platform users, and calls `enforceRoutePermission()` for all non-admin-key API methods. Treat `/api/*` routes as fail-closed unless they are explicitly public, Mastra-internal, or reachable through an alternate route/tool path.
- **Mastra internal endpoints are a first-class alternate trust path.** `src/mastra/middleware/index.ts` still treats `/api/workflows/*`, `/api/memory/*`, and most `/api/agents/*` routes as `mastraInternal`, which means they bypass the normal `enforceRoutePermission()` flow and only require an active session or admin key. Repeated scans should always trace those internal handlers back to the product feature that owns them and verify per-user ownership on `resourceId`, `threadId`, `runId`, and `agentId`.
- **Alternate data-access paths remain high risk.** AI tools and generated reports can bypass the same module boundaries as direct APIs if they query broad tables or render records without applying route-equivalent authorization and output encoding. The consultant's live-data tool is now a demonstrated repeated-scan anchor because direct table reads can drift away from REST RBAC unless module-level checks are enforced in the tool itself.
- **Consultant conversation ownership remains a separate repeated-scan anchor even inside role-gated routes.** `src/mastra/routes/consultantRoutes.ts` uses a shared `CONSULTANT_RESOURCE_ID` and accepts caller-supplied `threadId` values on history/chat endpoints without binding them to the authenticated user. Even if the broader Mastra internal-route bypass is fixed, future scans should keep checking for cross-user transcript access or prompt-poisoning through reused thread IDs.
- **Dashboard rendering remains a primary injection sink, but CSP meaningfully changes exploitability.** `dashboard/feedback.html`, `dashboard/tablef.html`, and the AI consultant markdown/widget rendering reviewed during this scan escape the relevant stored or AI-provided text before using `innerHTML`. Other dashboards with high-volume template rendering, especially `dashboard/projects.html`, still require close review because they interpolate database-backed fields directly into HTML, but `src/mastra/middleware/index.ts` now sends a nonce-based CSP (`script-src 'self' 'nonce-...'`, `form-action 'self'`, `frame-ancestors 'none'`) that blocks many classic stored-XSS payloads. Repeated scans should only re-escalate these sinks when a concrete script-gadget or CSP-compatible execution path is found.
- **Team dashboard SafeActions handlers make stored HTML injection more dangerous than generic `innerHTML` noise.** `dashboard/team.html` renders multiple persistent Team fields into HTML and `dashboard/js/safe-actions.js` auto-registers page functions for delegated invocation via `data-on-*` attributes. Repeated scans should treat Team-rendered HTML as a CSP-compatible action-trigger surface, not just a classic script-injection sink.
- **Availability controls must account for bytes and disk, not just request counts.** Public/API write routes and upload/export flows need body-size caps, streaming parser limits, temp-file quotas, and free-space checks before expensive buffering or staging occurs.
- **Upload availability reviews should separately check blob lifecycle and unbounded multipart parsing.** `src/mastra/routes/policyRoutes.ts` can orphan old blobs on replacement in the shared `/data/documents` namespace, while `src/mastra/routes/callIntelligenceRoutes.ts` still has admin-only multipart uploads that buffer attacker-controlled files without explicit body-size caps. Repeated scans should review both free-space consumption over time and single-request memory/disk amplification.
- **Broad aggregate read endpoints can still violate intended module boundaries.** `src/mastra/routes/notificationRoutes.ts` intentionally exposes `/api/health-index` to any authenticated caller even though it aggregates audit, CAPA, KPI, and compliance data from modules whose direct reads are more restricted. Repeated scans should challenge “aggregate only” endpoints against the underlying asset sensitivity rather than assuming summaries are harmless.
- **Usually out of scope unless proven production-reachable:** `attached_assets/**`, tests, docs, scripts, mockup/sandbox code, certificate renewal, and transport-layer TLS handling. Production deployments are assumed to run with `NODE_ENV=production` and platform-managed TLS.
- **Browser admin-key login appears removed in current production code.** `src/utils/rbacMiddleware.ts` now documents the browser admin-key cookie path as removed, and `/api/admin/*` appears to rely on `X-Admin-Key` for server-to-server access rather than converting the raw secret into a browser session. Repeated scans should still review admin-key handling, but as a header-based server trust path rather than a browser cookie path unless new production code reintroduces it.
- **Repeated scans should treat stale-role handler rechecks as a first-class authz anchor.** Global middleware verifies current database roles, but any handler that later reconstructs identity from the raw session cookie can reintroduce privilege drift after role changes. `src/mastra/routes/triggerRoutes.ts` is the current known example to revisit after auth changes.
- **Shared document namespaces are a repeated-scan authorization anchor.** `src/mastra/routes/policyRoutes.ts`, `src/mastra/routes/qmsDocsRoutes.ts`, and `src/utils/fileUpload.ts` share `/data/documents`; repeated scans should check that attachment metadata cannot be rebound across modules with broader readership.
- **High-value production surfaces for repeated scans:** `src/utils/rbacMiddleware.ts`, `src/mastra/middleware/index.ts`, `src/mastra/routes/adminApiRoutes.ts`, `src/mastra/routes/policyRoutes.ts`, `src/mastra/routes/teamRoutes.ts`, `src/mastra/routes/managementReviewRoutes.ts`, `src/mastra/routes/reportRoutes.ts`, `src/mastra/routes/eventLogsRoutes.ts`, `src/mastra/routes/consultantRoutes.ts`, `src/mastra/tools/queryPlatformDataTool.ts`, `src/mastra/routes/knowledgeRoutes.ts`, `src/mastra/routes/onboardingRoutes.ts`, `src/mastra/routes/triggerRoutes.ts`, `src/mastra/routes/pmpRoutes.ts`, `src/mastra/routes/notificationRoutes.ts`, `src/mastra/routes/callIntelligenceRoutes.ts`, `src/utils/fileUpload.ts`, `src/utils/excelExport.ts`, `src/utils/reportGenerator.ts`, `dashboard/projects.html`, `dashboard/team.html`, and pages with heavy `innerHTML` usage.

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
