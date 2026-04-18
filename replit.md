# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System designed to integrate governance, risk, and compliance (GRC) with quality management. It leverages the Mastra AI agent framework, Hono for HTTP services, PostgreSQL for data storage, and Inngest for workflow orchestration. The platform provides HTML dashboards and is built for Autoscale deployment, aiming to offer a comprehensive solution for quality, risk, and compliance management. Key features include page-view telemetry for user engagement analysis, role-based landing pages, AI-powered quality audits, and a robust duplicate detection system.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## System Architecture
The platform is built on the Mastra AI agent framework with a Hono HTTP server.
-   **Frontend**: Static HTML dashboards are served from the `dashboard/` directory, utilizing a compiled local `tailwind.css` for styling. Dashboards include an Executive Dashboard with a Quality Health Index, GRC Control Tower, QMS Dashboard with CAPA management, Audit Readiness, Compliance Tracking, Risk Register, and an AI Consultant interface.
-   **Backend**: Mastra API routes are handled by Hono.
-   **Database**: PostgreSQL is used for persistence, with over 103 tables organized across 21 module groups. A shared `pg.Pool` (`sharedPool.ts`) is used for efficient database connections.
-   **AI**: GPT-4o is integrated via Replit AI Integrations/OpenAI for AI agent capabilities.
-   **Workflows**: Inngest orchestrates event-driven workflows, including a 14-check background scanner, KPI auto-calculation, and AI approval expiry.
-   **Authentication**: Replit OIDC is the primary authentication method, supporting Google, GitHub, Apple, and email login. Session management uses HMAC-SHA256 signed cookies. An Admin API key (`X-Admin-Key`) provides alternative API access.
-   **Authorization**: Role-Based Access Control (RBAC) with 11 unified roles is enforced via `rbacMiddleware.ts` and `ROUTE_PERMISSION_MAP`, ensuring granular access to API endpoints and dashboards.
-   **Security**: The system implements nonce-based Content Security Policy (CSP), tiered rate limiting, input sanitization (XSS/injection prevention, CSV formula injection prevention), UUID resource ID obfuscation, strong password policies, and generic error messages to prevent information leakage. A human-in-the-loop (HITL) AI Approval Gate enforces human review for AI-initiated write actions, aligned with controlled documents and PDPL.
-   **Key Features**:
    -   **AI Consultant**: A GPT-4o powered QMS consultant with 23 tools for querying platform data, analyzing nonconformities, suggesting improvements, and managing various QMS aspects. It includes a chat interface, streaming SSE, and integrates with a knowledge base and compliance checklist engine.
    -   **Duplicate Radar**: A multi-signal duplicate detection system for CRM data with cross-module clustering, RAG owner accountability, AI recommendations, and an auto-resolve engine.
    -   **Evidence Management**: Structured upload and retrieval of evidence documents across QMS modules.
    -   **Compliance Checklist Engine**: Create and run structured compliance checklists with automated data verification.
    -   **Executive Digest**: Weekly quality digest emails summarizing key QMS metrics.
    -   **Infographic Generator**: In-platform tool for generating shareable visual snapshots of platform areas, with Slack and email sharing capabilities.
    -   **Native XLSX Exports**: Multi-sheet Excel exports for various modules (Audits, Duplicates, KPIs, NCs, CAPAs, Vendors, Risks).

## External Dependencies
-   **PostgreSQL**: Primary database for all application data.
-   **Replit AI Integrations / OpenAI**: Provides access to GPT-4o for AI functionalities.
-   **Inngest**: Event-driven workflow orchestration.
-   **Resend**: Used for sending outgoing emails.
-   **Zoho CRM**: Integrated for live CRM data, including enrichment and duplicate detection. Read-only production access is configured.
-   **Slack**: Used for notifications and sharing infographics, utilizing `@slack/web-api`.
-   **exceljs**: Library for generating native XLSX files for data exports.
-   **ImageMagick**: Utilized for converting SVG infographics to PNG format.
-   **Chart.js**: Used for rendering charts in dashboards.