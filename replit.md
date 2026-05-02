# WalaPlus Enterprise GRC & Quality Management Platform

## Overview
WalaPlus is an AI-powered enterprise Quality Management System integrating governance, risk, and compliance (GRC) with quality management. It provides a unified solution for modern enterprise quality and compliance, enhancing operational efficiency and regulatory adherence through HTML dashboards, autoscale deployment, AI-powered quality audits, robust duplicate detection, page-view telemetry, and resumable streaming exports.

## User Preferences
I prefer clear and concise communication. For development, I favor iterative progress with regular updates. Before implementing major architectural changes or introducing new external dependencies, please ask for my approval. I expect the agent to prioritize security best practices and ensure all changes are thoroughly tested.

## System Architecture
The platform is built around a robust GRC and quality management framework, leveraging AI for key functionalities such as quality audits.

**UI/UX Decisions:**
- HTML dashboards provide comprehensive data visualization.
- Status indicators and alert banners (e.g., storage health, rate limit spikes) include interactive triage actions.
- Consistent application of CSP-safe practices for UI elements and event delegation.
- Tailored empty states for filtered tables and consistent RTL layout conventions.

**Technical Implementations & Feature Specifications:**
- **AI-Powered GRC**: Core AI capabilities for audits and compliance checks.
- **Telemetry and Monitoring**: Extensive logging (`logger.info/error/warn/debug`), `ai_call_metrics` retention with configurable windows and admin UI, prompt version purging, and page-view telemetry.
- **Alerting System**: Comprehensive alert management for storage health, tool health breaches, and rate limit spikes with severity-tiered notifications, dead-letter logging, and configurable email/Slack recipients via an admin UI.
- **Security & Data Privacy**:
    - **Credential Redaction**: Proactive redaction of sensitive information (passwords, tokens) in logs, database entries, and user-facing error responses using regex-based matching, key-name deny-lists, and heuristic detection.
    - **Approval Gates**: Static analysis and runtime enforcement for AI tool usage, ensuring every tool has a defined governance policy with compliance references and a build preview function.
- **Database Management**: Utilizes various tables (`ai_call_metrics`, `ai_pending_actions`, `event_logs`, `ai_alerts`, `alert_email_recipients`, `ai_metrics_retention_config`, `ai_metrics_retention_audit`, `prompt_version_purge_runs`) for data storage and auditing.
- **Asynchronous Processing**: Leverages Inngest for cron jobs and background tasks (e.g., daily metric pruning, cost summaries, tool health checks, rate limit spike monitoring).
- **API Endpoints**: RESTful APIs for accessing system configurations, audit logs, and operational data.
- **Error Handling**: Standardized error wrapping and redaction of sensitive data in error messages.
- **Deployment**: Supports autoscale deployment.
- **Metrics Retention**: Configurable retention for `ai_call_metrics` via environmental variables or an admin UI, with live-preview of prune impact.
- **Prompt Version Purging**: Tracking and display of prompt-version purge cleanup counts in the AI Ops dashboard.
- **Historical Data Redaction**: `ai_call_metrics` historical sweep stamps rows with `previews_redacted_at` to indicate retroactive redaction.

## External Dependencies
- **Inngest**: For scheduling and executing cron jobs and workflows.
- **Postgres**: Primary database for storing application data, configurations, and audit logs.
- **Slack**: For sending alerts and notifications.
- **Email Services**: For sending alerts and notifications.
- **Playwright**: For end-to-end testing of UI flows.
- **Hono**: Web framework for defining routes and middleware.
- **Zod**: For schema validation.