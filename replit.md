# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. It provides HTML dashboards, supports autoscale deployment, and offers comprehensive solutions for quality, risk, and compliance. Key capabilities include AI-powered quality audits, robust duplicate detection, and page-view telemetry for user engagement. The platform aims to be a holistic solution for modern enterprise quality and compliance needs.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## Recent Changes

### April 24, 2026 — God-file refactor: thin composition root
`src/mastra/index.ts` was a 4,433-line god file. It has been refactored into a 251-line thin composition root. All inline route handlers and middleware were extracted:

**New files created:**
- `src/mastra/middleware/index.ts` — `globalMiddleware` array (CORS, auth, RBAC, rate-limit, sanitizer, CSP, error handler)
- `src/mastra/routes/dashboardApiRoutes.ts` — `/api/dashboard/*`, `/api/audit/*`, `/api/agents/performance`, `/api/inngest`, `/api/scorecard`, `/api/governance`, `/api/crm/*`, `/api/integrations/*`
- `src/mastra/routes/adminApiRoutes.ts` — `/api/admin/*`, `/api/workflow/*`, `/api/system/*`, `/api/activity/*`
- `src/mastra/routes/qmsApiRoutes.ts` — `/api/qms/*` (dashboard, evaluations, CAPA, NC, training, framework)
- `src/mastra/routes/sandboxApiRoutes.ts` — `/api/sandbox/*`
- `src/mastra/routes/tablefApiRoutes.ts` — `/api/tablef/*` (departments, KPIs, performance, users)
- `src/mastra/routes/staticPageRoutes.ts` — all HTML page shells
- `src/mastra/routes/staticAssetRoutes.ts` — CSS/JS assets
- `src/mastra/routes/feedbackApiRoutes.ts` — `/api/feedback/*`
- `src/mastra/routes/sopRoutes.ts` — `/api/sop`, `/api/sop/download`
- `src/mastra/routeManifest.ts` — full route inventory with guidance on where to add new routes
- SOP §12.4 "Engineering SOP: Where to Add New Routes and Middleware" added to `docs/WalaPlus_Platform_SOP.md`

All 66 platform tests green.

### April 24, 2026 — AI Observability (token, cost, latency, error telemetry)
Added `ai_call_metrics` PostgreSQL table (append-only, auto-bootstrapped, 90-day pruning) that records every LLM call: agent name, tool name, model, prompt/completion token counts, latency ms, estimated USD cost, success/error flag, error class, and hashed user/session IDs. A per-model price table lives in `src/utils/aiTelemetry.ts → MODEL_PRICE_TABLE` (update when OpenAI changes pricing). `withAiTelemetry()` wraps all four agent's `generateLegacy` calls (QMS Consultant chat + scan, SDR Quality, Sales Quality, Quality Specialist in the audit workflow); streaming calls use `recordStreamTelemetry()` which resolves the AI SDK's `stream.usage` promise after the stream closes. An "AI Operations" panel at `/ai-ops` (Admin & Tools nav group) shows: 24h KPI summary cards, weekly cost + error trend chart, p50/p95/avg latency per agent, top tools by cost, and a recent slow/failed-call table. A daily Inngest cron `ai-cost-summary` (06:00 UTC) posts a platform notification and optional Slack webhook alert when trailing-24h cost exceeds `AI_DAILY_COST_ALERT_USD` (default $10); same job prunes rows older than 90 days.

### April 24, 2026 — WCAG 2.1 AA Accessibility Pass
Implemented a full accessibility pass across all WalaPlus dashboards targeting WCAG 2.1 AA conformance:
- **`dashboard/js/a11y.js`** (new): Shared accessibility helper injected on every page. Provides: skip-to-main-content link injection, modal focus trap (Tab cycling + Escape-to-close + return focus to trigger), openModal/closeModal helpers, ARIA live region announcer, focus-visible CSS ring, and `patchLegacyModals()` which auto-patches all `.modal` elements with `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and icon-only close button labels.
- **`dashboard/js/navigation.js`**: Added `aria-label="Notifications"`, `aria-haspopup`, `aria-expanded`, `aria-controls` to the notifications button; `aria-label="Refresh dashboard"` to the refresh button; `aria-label="User menu"` to the user dropdown; notification items converted from `<div onclick>` to `<button type="button">` with `aria-label`; SVG icons marked `aria-hidden="true"`; Accessibility Statement footer link (`/a11y`) added to the sidebar rail.
- **`dashboard/js/ai-consultant-widget.js`**: Quick-action `<span onclick>` elements converted to `<button type="button">`; widget toggle button has `aria-label`, `aria-expanded`, `aria-controls`; close button has `aria-label="Close AI Consultant chat"` and returns focus to trigger; messages container has `role="log" aria-live="polite"`; send button has `aria-label="Send message"`; textarea has `aria-label="Type your question"`.
- **All 33 dashboard HTML files**: `<script src="/js/a11y.js" defer>` injected before `navigation.js` via automated sed pass.
- **`dashboard/a11y.html`** (new): Public accessibility statement page at `/a11y` documenting WCAG 2.1 AA conformance status, what has been done, known limitations, supported AT, and contact info.
- **`src/mastra/routes/a11yRoutes.ts`** (new): Hono route serving `dashboard/a11y.html` at `/a11y`.
- **`src/mastra/index.ts`**: Added `/js/a11y.js` route with correct `application/javascript` MIME type; added `/a11y` to the public paths whitelist (no auth required); imported and registered `a11yRoutes`.

### April 21, 2026 — Side rail navigation
Replaced the horizontal top-bar nav (`dashboard/js/navigation.js`) with a fixed left side rail (256px ↔ 64px collapsible, persisted in `localStorage['walaplus-nav-collapsed']`) plus a 48px top strip that retains the WalaPlus logo, refresh button, notification bell, and user menu. Single-file change picked up by all 36 dashboards via the existing `<div id="walaplus-nav">` mount point. Includes a menu search filter, mobile off-canvas rail with backdrop + Esc-to-close + focus management, and `aria-expanded`/`aria-controls` on toggles. Layout offsets injected via `#walaplus-nav-layout-style` style block; responsive visibility uses custom CSS classes (`.wp-rail-toggle-btn`, `.wp-mobile-menu-btn`, `.wp-desktop-only`, `.wp-tagline`) because the precompiled `dashboard/tailwind.css` does not ship `sm:`/`md:` variants. All preserved IDs/contracts: `#nav-alert-badge`, `#nav-notifications-list`, `#nav-user-info`, `#lastUpdated`, `navigationGroups`, `getColorClasses`, `getItemIcon`. e2e verified: auth → policies → toggle collapse/expand → search "audit" filter → click Health Pulse → navigate with active highlight.

## System Architecture
The platform is built on the Mastra AI agent framework and Hono HTTP server.
-   **Frontend**: Static HTML dashboards, styled with compiled Tailwind CSS, offer views like Executive Dashboard, GRC Control Tower, QMS Dashboard, and an AI Consultant interface.
-   **Backend**: Mastra API routes are handled by Hono.
-   **Database**: PostgreSQL manages over 103 tables across 21 module groups using a shared connection pool.
-   **AI**: GPT-4o integration via Replit AI/OpenAI powers AI agent functionalities.
-   **Workflows**: Inngest orchestrates event-driven processes, including background scanning, KPI auto-calculation, and AI approval expiry.
-   **Authentication**: Replit OIDC supports Google, GitHub, Apple, and email login, with HMAC-SHA256 signed cookies for session management. An Admin API key provides alternative access.
-   **Authorization**: Role-Based Access Control (RBAC) with 11 roles ensures granular access to API endpoints and dashboards through `rbacMiddleware.ts` and `ROUTE_PERMISSION_MAP`.
-   **Security**: Features include nonce-based Content Security Policy (CSP), distributed Postgres-backed rate limiting (rate_limit_buckets table shared across all instances, fail-open with Pino telemetry), input sanitization (XSS/injection prevention), UUID resource ID obfuscation, strong password policies, generic error messages, and a Human-In-The-Loop (HITL) AI Approval Gate for AI-initiated write actions.
-   **Key Features**:
    -   **AI Consultant**: A GPT-4o powered QMS consultant with 23 tools for data querying, nonconformity analysis, and QMS management, featuring a chat interface and knowledge base integration.
    -   **Duplicate Radar**: A multi-signal duplicate detection system for CRM data with cross-module clustering, AI recommendations, and auto-resolution.
    -   **Evidence Management**: Structured upload and retrieval of evidence documents.
    -   **Compliance Checklist Engine**: Create and run structured compliance checklists with automated data verification.
    -   **Executive Digest**: Weekly quality digest emails summarizing QMS metrics.
    -   **Infographic Generator**: In-platform tool for generating and sharing visual snapshots with Slack and email integration.
    -   **Native XLSX Exports**: Multi-sheet Excel exports for various modules.
    -   **AI Observability**: `ai_call_metrics` table captures every LLM call's token usage, cost, latency, and errors. The "AI Operations" panel (`/ai-ops`) visualises cost trends, latency percentiles, and recent failures. A daily Inngest cron alerts when 24h spend exceeds a configurable threshold.

## External Dependencies
-   **PostgreSQL**: Primary data store.
-   **Replit AI Integrations / OpenAI**: For GPT-4o AI capabilities.
-   **Inngest**: Event-driven workflow orchestration.
-   **Resend**: For outgoing email services.
-   **Zoho CRM**: Integrated for live CRM data, enrichment, and duplicate detection.
-   **Slack**: For notifications and infographic sharing.
-   **exceljs**: Library for generating XLSX data exports.
-   **ImageMagick**: Used for converting SVG infographics to PNG.
-   **Chart.js**: For rendering charts within dashboards.