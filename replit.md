# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System that integrates governance, risk, and compliance (GRC) with quality management. It provides HTML dashboards, supports autoscale deployment, and offers comprehensive solutions for quality, risk, and compliance. Key capabilities include AI-powered quality audits, robust duplicate detection, and page-view telemetry for user engagement. The platform aims to be a holistic solution for modern enterprise quality and compliance needs, providing a unified solution for GRC and quality management to enhance operational efficiency and regulatory adherence.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## System Architecture
The platform is built on the Mastra AI agent framework and Hono HTTP server.

-   **RTL Layout Convention**:
    The dashboard supports Arabic (RTL) via `html[dir="rtl"]`. To ensure layout details (table-header alignment, card accent borders, icon gutters) automatically mirror in RTL, CSS logical properties are used instead of physical ones. Helper classes are provided in `dashboard/css/utilities.css` for `text-start`, `border-s-4`, `ms-2`/`me-2`, `rounded-e-lg`, and `text-end`. `gap-*` is preferred over `space-x-*` for flexbox item spacing.

-   **UI/UX Decisions**:
    -   Dashboards are static HTML, styled with compiled Tailwind CSS, offering views like Executive Dashboard, GRC Control Tower, QMS Dashboard, and an AI Consultant interface. UI/UX emphasizes WCAG 2.1 AA accessibility conformance, including skip-to-main-content links, modal focus traps, ARIA live regions, and semantic HTML. A fixed left side rail navigation (256px ↔ 64px collapsible) replaces the traditional top-bar navigation, improving usability and screen real estate.
    -   A floating bottom-right progress card shows download status (filename, progress bar, bytes, percentage, Cancel button), auto-dismissing on completion or cancellation.
    -   Top-right toast container for success, cancellation, or failure alerts.

-   **Technical Implementations**:
    -   **Frontend**: Static HTML dashboards, styled with compiled Tailwind CSS.
    -   **Backend**: Mastra API routes are handled by Hono, with a refactored thin composition root for better modularity and maintainability.
    -   **Database**: PostgreSQL manages over 103 tables across 21 module groups using a shared connection pool.
    -   **AI Integration**: GPT-4o powers AI agent functionalities through Replit AI/OpenAI. AI Observability is implemented via an `ai_call_metrics` table, tracking token usage, cost, latency, and errors for every LLM call, visualized in an "AI Operations" panel.
    -   **Workflows**: Inngest orchestrates event-driven processes like background scanning, KPI calculation, and AI approval expiry.
    -   **Authentication**: Replit OIDC (Google, GitHub, Apple, email) with HMAC-SHA256 signed cookies for session management. An Admin API key provides alternative access.
    -   **Authorization**: Role-Based Access Control (RBAC) with 11 roles ensures granular access to API endpoints and dashboards via `rbacMiddleware.ts` and `ROUTE_PERMISSION_MAP`.
    -   **Security**: Features include nonce-based Content Security Policy (CSP) with strict enforcement for inline scripts and styles, distributed Postgres-backed rate limiting, input sanitization (XSS/injection prevention), UUID resource ID obfuscation, strong password policies, generic error messages, and Human-In-The-Loop (HITL) AI Approval Gate for AI-initiated write actions. CI checks enforce CSP compliance for dashboard HTML.

-   **Feature Specifications**:
    -   **AI Consultant**: GPT-4o powered QMS consultant with 23 tools for data querying, nonconformity analysis, and QMS management, featuring a chat interface and knowledge base integration. Feedback ratings are linked to AI observability for prompt-quality A/B tracking.
    -   **Duplicate Radar**: Multi-signal duplicate detection for CRM data with cross-module clustering, AI recommendations, and auto-resolution.
    -   **AI Observability**: Tracks LLM call metrics (token usage, cost, latency, errors) in an `ai_call_metrics` table. An "AI Operations" panel (`/ai-ops`) visualizes cost trends, latency percentiles, and recent failures. A daily Inngest cron alerts on high AI spend.
    -   **Evidence Management**: Structured upload and retrieval of evidence documents.
    -   **Compliance Checklist Engine**: Create and run structured compliance checklists with automated data verification.
    -   **Executive Digest**: Weekly quality digest emails summarizing QMS metrics.
    -   **Infographic Generator**: In-platform tool for generating and sharing visual snapshots with Slack and email integration.
    -   **Native XLSX Exports**: Multi-sheet Excel exports for various modules.
    -   **True Streaming Exports**: Large exports flow directly to disk via File System Access API where supported, bypassing memory Blobs for stability. This includes resumable streaming exports via temporary file staging.

## External Dependencies
-   **PostgreSQL**: Primary data store.
-   **Replit AI Integrations / OpenAI**: For GPT-4o AI capabilities.
-   **Inngest**: Event-driven workflow orchestration.
-   **Resend**: For outgoing email services.
-   **Zoho CRM**: Integrated for live CRM data.
-   **Slack**: For notifications and infographic sharing.
-   **exceljs**: Library for generating XLSX data exports.
-   **ImageMagick**: Used for converting SVG infographics to PNG.
-   **Chart.js**: For rendering charts within dashboards.