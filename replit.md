# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. It provides HTML dashboards, supports autoscale deployment, and offers comprehensive solutions for quality, risk, and compliance. Key capabilities include AI-powered quality audits, robust duplicate detection, and page-view telemetry for user engagement. The platform aims to be a holistic solution for modern enterprise quality and compliance needs, providing a unified solution for GRC and quality management.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## Recent Changes

### April 24, 2026 — Streaming exports for Firefox & Safari (service-worker shim)
Extended `dashboard/js/streaming-download.js` so multi-hundred-MB exports stream straight to disk in Firefox and Safari, not just Chromium. Vendored a same-origin service worker (`dashboard/streaming-download-sw.js`, served at `/streaming-download-sw.js` with `Service-Worker-Allowed: /` and `Cache-Control: no-cache`) that intercepts a synthetic `/_stream-download/<id>` URL pattern. The page-side helper now tries (1) File System Access API → (2) the SW shim → (3) the legacy in-memory `Blob` accumulator, in that order. The SW path uses transferable `ReadableStream` (Firefox 114+, Safari 16.4+, Chromium 87+): the helper builds a `TransformStream` for byte-progress accounting, transfers the readable side to the SW via `postMessage([readable, port])`, waits for an ack on the `MessageChannel`, then triggers the download by navigating a hidden iframe to `/_stream-download/<id>`. The SW responds with `new Response(transferredStream, { headers: 'Content-Disposition: attachment' })` and the browser pulls bytes through to disk — so memory stays flat regardless of export size. Critically, `streamResponseViaServiceWorker()` returns `null` *without* consuming `response.body` whenever the SW can't be reached (no `serviceWorker` API, no transferable streams, registration failure, or a non-`ok` ack), so the Blob fallback below it still works. Same button label / progress text / cancel UX as the FSA path; user cancellations surface as `AbortError` and are silenced. New `useServiceWorker: false` opt-out for callers that need to force the legacy path. Added `/streaming-download-sw.js` and `/_stream-download/` to the middleware `PUBLIC_PATHS` allowlist so the SW loads without an auth redirect (browsers fetch SW files independently of cookies). Cache-bust version on the script tags bumped from `?v=2.0.0` to `?v=2.1.0` across all six dashboards (`vendors.html`, `risks.html`, `policies.html`, `logs.html`, `duplicates.html`, `audits.html`). Test coverage: `tests/vitest/streamingDownload.vitest.test.ts` grew from 6 to 9 tests — added cases for the SW happy path (verifies `register` postMessage with transferred readable + iframe trigger), Blob fallback when the SW rejects the register ack, and the `useServiceWorker: false` opt-out.

### April 24, 2026 — True streaming exports to disk
Reworked `dashboard/js/streaming-download.js` so large exports flow directly to the user's filesystem instead of accumulating in a `Blob` in memory. When the browser supports the File System Access API (`window.showSaveFilePicker` + `WritableStream` + `TransformStream`) — i.e. modern Chromium — and the response either has no `Content-Length` or one ≥ 10 MB, the helper now opens a save-as picker and pipes `response.body` straight to `handle.createWritable()` via a progress-tracking `TransformStream`. Browser memory stays flat regardless of export size. The threshold is configurable per-call (`options.streamToDiskThreshold`) or globally (`window.STREAMING_DOWNLOAD_THRESHOLD`), and callers can force the path with `streamToDisk: 'always' | 'never' | 'auto'` (default `'auto'`). For small responses with a known small `Content-Length`, for browsers without File System Access (Firefox/Safari), or when the picker fails with a non-cancel error (e.g. lost user activation `SecurityError`), the helper transparently falls back to the legacy chunked-Blob path so existing UX (button label, progress text, error alert) is preserved. User-cancel `AbortError` is propagated quietly without the noisy alert. Cache-bust version on the script tags bumped from `?v=1.0.0` to `?v=2.0.0` across all six dashboards that load the helper (`vendors.html`, `risks.html`, `policies.html`, `logs.html`, `duplicates.html`, `audits.html`). Coverage: `tests/vitest/streamingDownload.vitest.test.ts` (6 tests) exercises the streaming-to-disk path, the small-response Blob fallback, the no-API fallback, the lost-activation fallback, AbortError propagation, and button progress UX inside a jsdom environment.

### April 24, 2026 — Auto-archive old prompt versions in AI Operations
Added an "Active vs Archived" filter to the AI Operations dashboard's "Prompt Version" tab so reviewers focus on currently-deployed versions by default. Backend exposes the live in-code `PROMPT_VERSION` constants from each agent module via a new `GET /api/ai-ops/prompt-versions/active` endpoint (returns `{ agent_name, prompt_version }[]` for the four telemetered agents: WalaPlus QMS Consultant, Quality Specialist, SDR Quality Reviewer, Sales Quality Reviewer). The Prompt Version tab now fetches this in parallel with the historical aggregation endpoint, marks the deployed row with a green "current" pill, and a `[data-testid="checkbox-show-archived"]` toggle (off by default) hides historical versions. When archived rows are hidden a small "X archived hidden" hint is shown next to each agent block. Files: `src/mastra/routes/aiOpsRoutes.ts`, `dashboard/ai-ops.html`.

### April 24, 2026 — Continuous integration for the integration test suite
Added `.github/workflows/test.yml`, a GitHub Actions workflow that runs `npm ci && npm test` on every push and pull request to any branch. The job uses Ubuntu, Node.js 20 (matching the runtime declared in `.replit`), and the built-in npm cache. `npm test` invokes `tests/runIntegrationTests.ts`, which discovers every `tests/*.test.ts` file (currently 8: admin/dashboard/QMS API routes, admin auth helpers, AI approval redaction (×2), and RBAC report/route lockdown) and exits non-zero if any file fails — so any failing test will fail the CI check and block merge. A workflow-level `concurrency` group with `cancel-in-progress: true` keeps superseded commits from queueing up. No DB is provisioned in CI; the suites are designed to gracefully skip DB-dependent paths when `DATABASE_URL` is unset, and all 8 files pass cleanly without one.

### April 24, 2026 — CSP guard: dashboard inline-handler lint check
Added a CI / pre-commit guard that fails when any `dashboard/*.html` file contains an inline event-handler attribute (`onclick=`, `onchange=`, `onsubmit=`, `oninput=`, `on*=`). These attributes are silently dropped by the dashboard CSP (`script-src` no longer allows `'unsafe-inline'`), so without this guard a contributor can reintroduce a "button does nothing in production" regression and not notice — the page still loads, only the specific handler is no-op. The check lives at `.local/scripts/check-handlers.cjs` (pure Node, no dependencies) and is wrapped by `scripts/lint-dashboard-handlers.sh` for easy invocation. Run before committing dashboard HTML changes:

```
scripts/lint-dashboard-handlers.sh                       # default — inline handlers only
scripts/lint-dashboard-handlers.sh --check-inline-scripts # also flag <script> blocks without nonce
```

The script exits 1 with `file:line:column` context for every violation and a fix-it pointer to the `data-on-{event}="fnName"` pattern handled by `dashboard/js/safe-actions.js`. The optional `--check-inline-scripts` flag is opt-in (rather than default) because the CSP middleware in `src/mastra/middleware/index.ts` auto-injects nonces into every `<script>`/`<style>` tag at request time, which would generate ~70 false positives across the existing dashboards. Known outstanding: `dashboard/ai-ops.html` and `dashboard/consultant.html` still contain 19 inline handlers from the original migration — once those are migrated to `data-on-{event}`, add `bash scripts/lint-dashboard-handlers.sh` to `scripts/post-merge.sh` so the gate runs on every merge.

### April 24, 2026 — CSP-safe inline event handlers
Removed all inline event-handler attributes (`onclick=`, `onchange=`, `onsubmit=`, `oninput=`, etc.) from 36 dashboard HTML files so they no longer rely on `script-src 'unsafe-inline'`. Added `dashboard/js/safe-actions.js` (served at `/js/safe-actions.js`, route added in `src/mastra/routes/staticAssetRoutes.ts`) — a single delegated event-listener helper that reads `data-on-{event}="fnName"` + `data-args="[json]"` attributes and dispatches to functions on `window`. Supports comma-separated handler chains, nested args arrays, `data-pass-event="true"`, and `@this.x` / `@event.x` token resolution. Exposes globals `navigateTo`, `openInNewTab`, `addClass`, `removeClass`, `toggleClass`, `clickElement`, and `escAttr` for migrated patterns. The script tag was injected into every dashboard page (between `a11y.js` and `navigation.js`); the existing CSP nonce middleware auto-injects nonces. Migration script: `.local/scripts/migrate-handlers.cjs`. e2e verified: login → 9 dashboards (duplicates, feedback, tablef, admin, consultant, crm, risks, projects, calls) all loaded with no CSP violations and no "function not found" warnings; merge-guide dismiss + interactive controls confirmed working.

### April 24, 2026 — Inline-style CSP guardrail
Added `scripts/check-no-inline-styles.sh` which greps `dashboard/` and `src/mastra/` for ` style="` attributes and exits non-zero if any are found, guarding the strict `style-src 'self' 'nonce-${cspNonce}' …` directive documented in Security Operations SOP §5.5. The script skips `*.css` files, an explicit `ALLOWLIST_FILES` list of HTML-email / PNG generators (`userAccessRoutes.ts`, `infographicRoutes.ts`, `emailReportTool.ts`, `qualityAuditWorkflow.ts` — these emit markup that goes to email clients or PNG renders, never to a CSP-controlled browser context), and any single line annotated with the marker `csp-safe-inline-style`. The two remaining inline styles in `dashboard/ai-ops.html` (`style="max-width:20rem"` → `max-w-xs` Tailwind class) and `dashboard/js/navigation.js` (`style="flex-shrink:0;"` → `flex-shrink-0` Tailwind class) were removed so the dashboard is fully clean. The check is wired into CI via `tests/noInlineStyles.test.ts` (auto-discovered by `tests/runIntegrationTests.ts`, so it runs on every `npm test`) and is also documented in Security Operations SOP §5.5 alongside the CSP policy note. Failure output points developers to the four legitimate fix paths (move to `dashboard/css/utilities.css`, use a Tailwind utility, use the `data-style="…"` + `/js/csp-styles.js` pattern, or add an allowlist entry).

### April 24, 2026 — CSP regression-guard E2E (`tests/csp.spec.ts`)
Added a Playwright spec that walks the top dashboard pages (`/dashboard`, `/index.html`, `/sop`, `/risks`, `/projects`, `/grc`, `/consultant`) in real Chromium, attaches `page.on('console')`, `page.on('pageerror')`, and a bridged `securitypolicyviolation` listener, and asserts:
- the `Content-Security-Policy` response header carries a `style-src 'nonce-…'` token and does NOT contain `'unsafe-inline'`;
- the browser captures zero CSP-related console messages or page errors during load;
- on `/sop`, the AI Consultant widget script-injected `<style>` block (created by `dashboard/js/ai-consultant-widget.js`) exists in `<head>`, carries a non-empty `nonce` attribute, the launcher button's computed `background-image` resolves to `linear-gradient(...)` (proving the dynamic style was not blocked), and clicking the launcher opens `#ai-widget-panel.open` without producing new violations.

The spec authenticates via `POST /api/admin/auth` using `ADMIN_API_KEY` (or `TEST_ADMIN_KEY`) and skips authenticated cases when neither is set. `playwright.config.ts` `testDir` was corrected from `./scripts` (which had no specs) to `./tests` so that this spec and the existing `tests/i18n.spec.ts` are discoverable. Run locally with `npx playwright test tests/csp.spec.ts --reporter=line`.

### April 24, 2026 — Sanitized tool input/output previews on AI telemetry
`wrapToolWithTelemetry()` now also captures `tool_input_preview` and `tool_output_preview` (≤300 chars each, PII-redacted by the same email/phone/card/secret rules used for `prompt_preview`) and stores them on the per-tool `ai_call_metrics` row. A new `redactToolPayloadPreview()` helper in `src/utils/aiTelemetry.ts` JSON-stringifies arbitrary args/results then runs them through `redactPromptPreview()`. The two columns are added via idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` so existing prod tables auto-upgrade. `getRecentSlowFailedCalls()` returns the new fields and the AI Operations panel's Recent Issues table (`/ai-ops` → Recent Issues tab) renders them as `in: …` / `out: …` lines beneath the existing error/prompt preview, giving ops teams a reproduction payload for failed/slow tool calls without ever persisting raw secrets. Covered by `tests/aiToolPayloadRedaction.test.ts` (17 assertions: redaction rules, length cap, wrapper contract preservation).

### April 24, 2026 — Feedback ratings linked to AI observability
Documented the contract that ties inline thumbs-up/down ratings on AI Consultant responses back to the originating `ai_call_metrics` row for prompt-quality A/B tracking. The plumbing already exists: `withAiTelemetry()` returns `{ result, callId }`, the QMS Consultant chat route surfaces `callId` on its JSON response, `/api/ai-ops/feedback` stores ratings in `ai_call_feedback` (FK to `ai_call_metrics.id`), and the AI Operations panel's Agent Latency tab joins them via `getFeedbackRateByAgent()` to show a per-agent "Feedback Rate %" column. This task added an explicit downstream-linking section to the price-table doc block at the top of `src/utils/aiTelemetry.ts` so future contributors know that `callId` is the contract for any feedback / evaluation pipelines built on top of AI telemetry.

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

-   **UI/UX Decisions**:
    -   Dashboards are static HTML, styled with compiled Tailwind CSS, offering views like Executive Dashboard, GRC Control Tower, QMS Dashboard, and an AI Consultant interface.
    -   Accessibility (WCAG 2.1 AA) is a core design principle, implemented with a shared accessibility helper (`a11y.js`) for focus management, ARIA attributes, and semantic HTML.
    -   Navigation uses a fixed left side rail (collapsible) with a top strip for essential elements.
-   **Technical Implementations**:
    -   **Frontend**: Static HTML dashboards, styled with compiled Tailwind CSS.
    -   **Backend**: Mastra API routes are handled by Hono.
    -   **Database**: PostgreSQL manages over 103 tables across 21 module groups using a shared connection pool.
    -   **AI Integration**: GPT-4o powers AI agent functionalities through Replit AI/OpenAI.
    -   **Workflows**: Inngest orchestrates event-driven processes like background scanning, KPI calculation, and AI approval expiry.
    -   **Authentication**: Replit OIDC (Google, GitHub, Apple, email) with HMAC-SHA256 signed cookies for session management. An Admin API key provides alternative access.
    -   **Authorization**: Role-Based Access Control (RBAC) with 11 roles ensures granular access to API endpoints and dashboards via `rbacMiddleware.ts` and `ROUTE_PERMISSION_MAP`.
    -   **Security**: Features include nonce-based Content Security Policy (CSP), distributed Postgres-backed rate limiting, input sanitization (XSS/injection prevention), UUID resource ID obfuscation, strong password policies, generic error messages, and Human-In-The-Loop (HITL) AI Approval Gate for AI-initiated write actions.
-   **Feature Specifications**:
    -   **AI Consultant**: GPT-4o powered QMS consultant with 23 tools for data querying, nonconformity analysis, and QMS management, featuring a chat interface and knowledge base integration.
    -   **Duplicate Radar**: Multi-signal duplicate detection for CRM data with cross-module clustering, AI recommendations, and auto-resolution.
    -   **Evidence Management**: Structured upload and retrieval of evidence documents.
    -   **Compliance Checklist Engine**: Create and run structured compliance checklists with automated data verification.
    -   **Executive Digest**: Weekly quality digest emails summarizing QMS metrics.
    -   **Infographic Generator**: In-platform tool for generating and sharing visual snapshots with Slack and email integration.
    -   **Native XLSX Exports**: Multi-sheet Excel exports for various modules.
    -   **AI Observability**: Tracks LLM call metrics (token usage, cost, latency, errors) in an `ai_call_metrics` table. An "AI Operations" panel (`/ai-ops`) visualizes cost trends, latency percentiles, and recent failures. A daily Inngest cron alerts on high AI spend.

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