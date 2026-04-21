# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. It provides HTML dashboards, supports autoscale deployment, and offers comprehensive solutions for quality, risk, and compliance. Key capabilities include AI-powered quality audits, robust duplicate detection, and page-view telemetry for user engagement. The platform aims to be a holistic solution for modern enterprise quality and compliance needs.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## Recent Changes

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
-   **Security**: Features include nonce-based Content Security Policy (CSP), tiered rate limiting, input sanitization (XSS/injection prevention), UUID resource ID obfuscation, strong password policies, generic error messages, and a Human-In-The-Loop (HITL) AI Approval Gate for AI-initiated write actions.
-   **Key Features**:
    -   **AI Consultant**: A GPT-4o powered QMS consultant with 23 tools for data querying, nonconformity analysis, and QMS management, featuring a chat interface and knowledge base integration.
    -   **Duplicate Radar**: A multi-signal duplicate detection system for CRM data with cross-module clustering, AI recommendations, and auto-resolution.
    -   **Evidence Management**: Structured upload and retrieval of evidence documents.
    -   **Compliance Checklist Engine**: Create and run structured compliance checklists with automated data verification.
    -   **Executive Digest**: Weekly quality digest emails summarizing QMS metrics.
    -   **Infographic Generator**: In-platform tool for generating and sharing visual snapshots with Slack and email integration.
    -   **Native XLSX Exports**: Multi-sheet Excel exports for various modules.

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