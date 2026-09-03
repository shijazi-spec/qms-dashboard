# ExampleOrg Enterprise GRC & Quality Management Platform
# Security Assessment Questionnaire — Response Document

**Document Version:** 1.0
**Response Date:** March 15, 2026
**Classification:** CONFIDENTIAL
**Prepared by:** ExampleOrg Platform Engineering & Security Team
**Application:** ExampleOrg QMS Platform (https://<REDACTED_HOST>)
**Technology Stack:** Mastra (TypeScript), Hono HTTP Server, PostgreSQL (Neon), Node.js 20+

---

## Assessment Metadata

| Field | Value |
|-------|-------|
| Assessment Date | March 15, 2026 |
| Application Owner | ExampleOrg |
| Contact Email | *(To be completed by business)* |
| Phone | *(To be completed by business)* |
| Last VAPT Assessment | April 2, 2026 (Pentest v4 retest, OWASP v4.2 methodology) |
| VAPT Findings | 37 identified (across v1–v3), 37 remediated (post-retest), 0 remaining |

---

## 1. Cloud Infrastructure & Hosting

### 1.1 Where are Replit's data centers physically located?

**Response:**
Replit's production infrastructure runs on **Google Cloud Platform (GCP)**, primarily in **US-based data centers**. The PostgreSQL database is hosted on **Neon**, which also operates on GCP infrastructure. Replit's deployment platform (Autoscale) provisions containers on GCP for serving the application.

> **Note:** Specific data center locations and availability zones should be confirmed with Replit and Neon vendor documentation. Replit does not currently offer customer-selectable data residency regions. If specific data residency requirements apply (e.g., GCC/Middle East data sovereignty), this should be discussed with Replit's enterprise sales team regarding regional hosting options.

**Evidence:**
- Platform deployed via Replit Autoscale: `https://<REDACTED_HOST>`
- Database connection via Neon PostgreSQL (GCP-backed): configured in `DATABASE_URL` environment variable
- Replit infrastructure documentation: <REDACTED_URL>

---

### 1.2 Does ExampleOrg have a signed Data Processing Agreement (DPA) with Replit?

> **⚠️ ACTION REQUIRED — Business/Legal Confirmation Needed**

**Response:**
Replit offers Data Processing Agreements for Teams and Enterprise plan subscribers. Whether a DPA has been executed as part of ExampleOrg's current subscription agreement must be verified by the procurement/legal team.

**Recommendation:** If a DPA is not yet in place, request one from Replit's enterprise team. Replit's standard DPA covers data processing obligations, sub-processor disclosure, breach notification, and data deletion commitments.

---

### 1.3 Does Replit use any sub-processors for the QMS platform?

**Response:**
Yes. The following sub-processors are involved in hosting and operating the QMS platform:

| Sub-Processor | Role | Data Handled |
|---------------|------|-------------|
| **Google Cloud Platform (GCP)** | Compute, networking, container orchestration | Application code, runtime data |
| **Neon** | Managed PostgreSQL database hosting | All application data (97+ tables across 19 module groups) |
| **Cloudflare** | CDN, edge routing, DDoS mitigation | HTTP traffic (proxied) |

Additionally, the QMS application itself integrates with the following third-party services:

| Service | Purpose | Data Exchanged |
|---------|---------|---------------|
| **OpenAI (GPT-4o)** | AI-powered quality analysis, call scoring, audit recommendations | Business data (quality metrics, call transcripts, CRM records) |
| **Zoho CRM** | CRM data synchronization (Leads, Deals, Contacts) | Lead/deal records, contact information |
| **Replit OIDC** | User authentication (OpenID Connect) | Email, name, profile picture |
| **Resend** | Outbound email notifications | Email addresses, report content |

Replit publishes a sub-processor list on their website which should be reviewed periodically. *(Note: The sub-processor details above are based on publicly available information and should be confirmed against Replit's official sub-processor list.)*

**Evidence:**
- Integration configurations: `src/utils/zohoCRM.ts`, `src/utils/resendMail.ts`, `src/utils/googleCalendar.ts`
- AI agent definitions: `src/mastra/agents/qualitySpecialistAgent.ts`, `src/mastra/agents/sdrQualityAgent.ts`

---

### 1.4 How are backups handled for the QMS platform?

**Response:**
Backups are handled at multiple levels:

1. **Database (Neon PostgreSQL):** Neon provides **continuous automated backups** with point-in-time recovery (PITR). Data is replicated across GCP storage with automated snapshots. Recovery to any point within the retention window is supported.

2. **Application Code (Replit):** Replit provides automatic **checkpoint versioning** that captures the codebase and chat sessions — enabling rollback to any prior checkpoint via the Replit interface. *(Note: Checkpoint scope for Neon-hosted databases should be confirmed with Replit — database backups are primarily managed by Neon's own PITR system.)*

3. **Event Log Durability:** The event logging system uses **monthly table partitioning** (`event_logs_y2026m03`, etc.) for data durability and efficient archival.

**Recommendation (from VAPT Report):** Implement periodic backup verification and restore testing to validate recoverability.

**Evidence:**
- Event log partitioning: `src/utils/eventLogsDatabase.ts` (lines 82–111, `createMonthlyPartition` function)
- VAPT Recommendation #7: "Backup Verification — Regular database backup and restore testing"
- Reference: `docs/VAPT_Remediation_Report.md` (Section 5, Item 7)

---

## 2. Data Encryption

### 2.1 Is the PostgreSQL database encrypted at rest?

**Response:**
Yes. The PostgreSQL database is hosted on **Neon**, which encrypts all data at rest using **AES-256 encryption** provided by GCP's underlying storage layer. This includes all database files, WAL logs, and automated backups.

The PDPL compliance module (`src/utils/pdplDatabase.ts`) maintains a data inventory that tracks which fields are marked as encrypted. Sensitive fields such as Email and Phone are flagged with `is_encrypted: true` in the `data_inventory` table.

**Future Enhancement (from VAPT Report):** Column-level encryption (e.g., using `pgcrypto`) for specific PII fields is identified as a recommended improvement for defense-in-depth.

**Evidence:**
- Data inventory with encryption flags: `src/utils/pdplDatabase.ts` (lines 230–241, `seedDefaultData`)
- VAPT Recommendation #6: "Database Encryption — Consider column-level encryption for sensitive employee data"
- Reference: `docs/VAPT_Remediation_Report.md` (Section 5, Item 6)

---

### 2.2 How is data encrypted when transmitted between components?

**Response:**
All data in transit is encrypted via **TLS/HTTPS**:

| Communication Path | Encryption | Details |
|-------------------|-----------|---------|
| Client ↔ Application | HTTPS/TLS 1.2+ | Managed by Replit's deployment infrastructure and Cloudflare edge |
| Application ↔ Database | SSL/TLS | Neon connection string enforces `sslmode=require` |
| Application ↔ OpenAI API | HTTPS/TLS | API calls over encrypted channel |
| Application ↔ Zoho CRM | HTTPS/TLS | OAuth 2.0 token exchange and API calls over encrypted channel |
| Application ↔ Replit OIDC | HTTPS/TLS | OIDC authorization code flow over encrypted channel |

CORS is restricted to the application's own domain only (no wildcard `*`). Cross-origin requests from unauthorized domains are rejected.

**Evidence:**
- CORS configuration: `src/mastra/index.ts` (lines 128–148)
- VAPT Finding VULN-05 (Wildcard CORS): Remediated — explicit origin allowlist derived from `REPLIT_DOMAINS`
- Reference: `docs/VAPT_Remediation_Report.md` (VULN-05)

---

### 2.3 How are encryption keys managed and protected?

**Response:**
Encryption keys are managed at multiple layers:

| Key Type | Management | Details |
|----------|-----------|---------|
| **TLS certificates** | Managed by Replit/Cloudflare | Automatic certificate provisioning and renewal |
| **Database encryption keys** | Managed by GCP/Neon | AES-256 keys managed by cloud provider KMS *(confirm specifics with Neon vendor documentation)* |
| **Session signing key** (`SESSION_SECRET`) | Replit Secrets vault | HMAC-SHA256 signing key, stored encrypted, never in source code |
| **API keys** (OpenAI, Zoho, Resend, Admin) | Replit Secrets vault | Injected as environment variables at runtime |

All application-level secrets are stored in **Replit's encrypted Secrets vault** and injected as environment variables (`process.env.*`). They are **never hardcoded** in source code and **never exposed** in error messages (VAPT Finding VULN-06, remediated).

**Evidence:**
- Session signing: `src/mastra/routes/authRoutes.ts` (lines 18–23, `signSession` function using `crypto.createHmac('sha256', secret)`)
- Secret scrubbing from errors: `docs/VAPT_Remediation_Report.md` (VULN-06, VULN-16)
- VAPT Recommendation #3: "Key Rotation — Rotate SESSION_SECRET and ADMIN_API_KEY annually"

---

## 3. Access Control & Authentication

### 3.1 What authentication method is used for the QMS platform?

**Response:**
The QMS platform uses a **dual-layer authentication** approach:

| Method | Type | Usage |
|--------|------|-------|
| **Replit OIDC** | Primary | Interactive user login via "Log in with Replit" (supports Google, GitHub, Apple, email) |
| **Admin API Key** | Secondary | Programmatic/administrative API access via `X-Admin-Key` header |

**OIDC Flow Details:**
1. User clicks "Log in with Replit" on `/login`
2. Redirected to Replit's OIDC authorization server (discovery URL: `<REDACTED_URL>`)
3. OIDC callback at `/api/callback` handles token exchange
4. User profile synced via `upsertOidcUser()` into `platform_users` table
5. HMAC-SHA256 signed session cookie (`walaplus_session`) issued with 7-day expiry
6. POST-only `/api/logout` clears session cookie (CSRF-safe)

**Session Token Security:**
- Signed with `SESSION_SECRET` using HMAC-SHA256
- Cookie flags: `HttpOnly`, `Secure` (production), `SameSite=Lax`, `Path=/`
- 7-day maximum expiry enforced in token payload (`exp` field)
- Tampering returns 401 (signature mismatch detected)

**Evidence:**
- Full OAuth implementation: `src/mastra/routes/authRoutes.ts` (lines 109–277)
- Session signing/verification: `src/mastra/routes/authRoutes.ts` (lines 18–38)
- Authentication middleware: `src/mastra/index.ts` (lines 172–188)
- VAPT Findings: VULN-07 (session cookies), VULN-08 (token signing), VULN-14 (OAuth state validation) — all remediated/mitigated

---

### 3.2 Is there a documented access control framework (RBAC)?

**Response:**
Yes. A comprehensive **Role-Based Access Control (RBAC)** system is implemented:

**Defined Roles:**

| Role | Description |
|------|------------|
| `admin` | Full system access, user management |
| `quality_manager` | Quality operations, CAPA, findings |
| `grc_manager` | GRC operations, risk acceptance, policy approval |
| `ai_specialist` | AI/analytics view access |
| `bu_owner` | Business unit operations, evidence submission |
| `executive` | Executive dashboard view access |
| `quality_specialist` | Quality dashboards, call analysis, CRM hygiene |
| `team_lead` | Team performance, call intelligence, audits |
| `auditor` | Audit readiness, compliance tracking, findings management |
| `department_viewer` | Default role assigned to new users (least privilege) |
| `custom` | Per-screen permissions assigned by admin |

**Permission Matrix:**

| Permission | admin | grc_manager | quality_manager | ai_specialist | bu_owner | executive |
|-----------|-------|-------------|-----------------|---------------|----------|-----------|
| `can_manage_users` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `can_accept_risk` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `can_approve_policy` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `can_close_finding` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `can_edit_controls` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `can_create_capa` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `can_submit_evidence` | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| `can_view_executive` | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ |

**Additional RBAC Features:**
- **Dual Ownership** for policies: requires both an operational owner and a compliance owner
- **Permission checking API**: `checkPermission(email, permission)` validates user capabilities at runtime
- **BU Process mapping**: business unit processes linked to control mappings for readiness tracking

**Evidence:**
- RBAC schema and permissions: `src/utils/rbacDatabase.ts` (lines 8–55, 48–54 for permission matrix)
- Permission check function: `src/utils/rbacDatabase.ts` (lines 318–335)
- RBAC API routes: `src/mastra/routes/rbacRoutes.ts`
- Dual ownership fields: `src/utils/rbacDatabase.ts` (lines 131–152, `addPolicyDualOwnership`)

---

### 3.3 How are administrative accounts protected?

**Response:**
Administrative accounts are protected through multiple mechanisms:

1. **Role Restriction:** Only the `admin` role has `can_manage_users = true`. No other role can create, modify, or delete user accounts.

2. **Admin API Key Protection:**
   - Stored as an encrypted environment secret (`ADMIN_API_KEY`)
   - Never exposed in error messages (changed from "Unauthorized - Admin API key required" to generic "Authentication required" per VAPT Finding VULN-12)
   - Used only as a secondary/fallback authentication mechanism

3. **Session Security:**
   - Admin sessions use the same HMAC-SHA256 signed cookies as all users
   - Token tampering is detected and rejected (401 response)
   - 7-day session expiry with automatic invalidation

4. **Audit Trail:**
   - All administrative actions are logged in the `event_logs` table with user identity, timestamp, action type, and SHA-256 checksum
   - Login events tracked with `LOGIN` action type

5. **Default Admin Seeding:**
   - A single admin account (`user@example.invalid`) is seeded on first initialization
   - New users authenticated via Replit OIDC receive the `department_viewer` role by default (least privilege)

**Evidence:**
- Admin role permission: `src/utils/rbacDatabase.ts` (line 54)
- Admin key authentication: `src/mastra/index.ts` (lines 179–188)
- Generic error messages: `docs/VAPT_Remediation_Report.md` (VULN-12)
- Default role assignment: `src/mastra/routes/authRoutes.ts` (line 101, `'department_viewer'`)

---

### 3.4 How are user sessions managed?

**Response:**
Sessions are managed using **cryptographically signed, stateless tokens** stored in HTTP cookies:

| Property | Value |
|----------|-------|
| **Token Format** | `base64url(payload).hmac_sha256_signature` |
| **Signing Algorithm** | HMAC-SHA256 |
| **Signing Key** | `SESSION_SECRET` (Replit encrypted secret) |
| **Cookie Name** | `walaplus_session` |
| **Max Age** | 7 days (604,800 seconds) |
| **HttpOnly** | Yes (prevents JavaScript access) |
| **Secure** | Yes (HTTPS only, conditional on non-localhost) |
| **SameSite** | Lax (CSRF protection) |
| **Path** | `/` (application-wide) |

**Session Lifecycle:**
1. **Creation:** On successful Replit OIDC callback, a signed token is issued containing `userId`, `email`, `name`, `picture`, `role`, and `exp` (expiry timestamp)
2. **Verification:** On every request, the middleware extracts the cookie, splits the payload and signature, recomputes the HMAC, and compares. If the signature doesn't match or the token is expired, the request is rejected (401 or redirect to `/login`)
3. **Revocation:** Logout sets the cookie's `Max-Age` to 0, immediately invalidating it
4. **CSRF Protection:** OAuth flow uses a `state` parameter validated against an `oauth_state` cookie (HttpOnly, SameSite=Lax)

**Evidence:**
- Session signing/verification: `src/mastra/routes/authRoutes.ts` (lines 18–38)
- Cookie flags: `src/mastra/routes/authRoutes.ts` (lines 219–222)
- OAuth state validation: `src/mastra/routes/authRoutes.ts` (lines 161–167)
- VAPT Findings: VULN-07 (cookie flags), VULN-14 (OAuth state) — all remediated

---

## 4. Logging & Monitoring

### 4.1 Is audit logging implemented for the QMS platform?

**Response:**
Yes. A comprehensive, enterprise-grade **event logging system** is implemented with the following characteristics:

**Log Schema:**
Each event captures: `timestamp`, `user_id`, `user_name`, `user_email`, `user_role`, `action_type`, `entity_type`, `entity_id`, `entity_name`, `description`, `old_value`, `new_value`, `ai_involved`, `severity`, `correlation_id`, `ip_address`, `user_agent`, `module`, and `checksum`.

**Action Types:** `CREATE`, `UPDATE`, `DELETE`, `STATUS_CHANGE`, `ASSIGN`, `AI_ACTION`, `LOGIN`, `LOGOUT`, `VIEW`, `EXPORT`, `CALCULATE`

**Entity Types:** `PROJECT`, `TRAINING`, `ROI`, `USER`, `ROLE`, `CALL`, `KPI`, `CAPA`, `DOCUMENT`, `SYSTEM`

**Severity Levels:** `INFO`, `WARNING`, `CRITICAL`

**Integrity Protection:**
- Each log entry is assigned a **SHA-256 checksum** computed from the event data and timestamp, enabling tamper detection
- Checksum generation: `crypto.createHash('sha256').update(checksumData).digest('hex')`

**Scalability:**
- The `event_logs` table is **partitioned by month** (e.g., `event_logs_y2026m03`) for performance and efficient archival
- Partitions are automatically created for the current, previous, and next months
- Comprehensive indexes on `timestamp`, `user_id`, `action_type`, `entity_type`, `module`, `severity`, and `correlation_id`

**PDPL Audit Log:**
- A separate `pdpl_audit_log` table tracks all data privacy-related actions with its own SHA-256 checksums

**Dashboard:**
- A dedicated log viewer is available at `/logs` with filtering by date, severity, action type, entity type, module, and free-text search
- Log statistics API: `/api/logs/stats`
- CSV export for compliance audits

**Evidence:**
- Event log implementation: `src/utils/eventLogsDatabase.ts` (679 lines)
- Checksum generation: `src/utils/eventLogsDatabase.ts` (lines 68–80)
- Partitioning: `src/utils/eventLogsDatabase.ts` (lines 82–111)
- PDPL audit log: `src/utils/pdplDatabase.ts` (lines 205–219)
- Log API routes: `src/mastra/routes/eventLogsRoutes.ts`
- Log dashboard: `dashboard/logs.html`

---

### 4.2 Is there active security monitoring in place?

**Response:**
The following monitoring capabilities are in place:

1. **Application Logging:** A **Pino-based structured logger** (`ProductionPinoLogger`) provides real-time JSON logging of all API requests, errors, and AI operations with severity levels.

2. **Rate Limit Monitoring:** The rate limiter generates `429 Too Many Requests` responses when limits are exceeded. Tiered limits: authenticated (100 reads/10 writes per min per IP), unauthenticated (10 reads/3 writes per min per IP), auth endpoints (5/min), export endpoints (10/min).

3. **Authentication Monitoring:** Failed authentication attempts result in `401` responses that are logged. OAuth errors (invalid state, denied access) are logged with specific error codes.

4. **Event Log Dashboard:** The `/logs` dashboard provides real-time visibility into system events with severity filtering and critical event highlighting.

5. **Global Request Logging:** Every API request is logged at the debug level with method and URL via the global middleware.

**Current Limitation:** There is no external SIEM integration or automated alerting on security-relevant events (e.g., repeated 401/429 responses). This is identified as a recommended enhancement.

**Evidence:**
- Pino logger: `src/mastra/index.ts` (lines 50–89, `ProductionPinoLogger`)
- Rate limiter: `src/utils/rateLimiter.ts` (40 lines)
- Request logging middleware: `src/mastra/index.ts` (lines 120–123)
- VAPT Recommendation #5: "Security Monitoring — Implement alerting on repeated 401/429 responses"

---

### 4.3 Is there a SIEM (Security Information and Event Management) system integration?

**Response:**
**Not currently implemented.** Event logs are stored in PostgreSQL with the following capabilities that support future SIEM integration:

- Structured event data with consistent schema (action type, entity type, severity, correlation ID)
- SHA-256 checksums for log integrity verification
- CSV export capability for offline analysis
- Monthly partitioned tables for efficient bulk export
- API endpoints for programmatic log retrieval (`/api/logs`)

**Recommendation:** Integrate with a SIEM solution (e.g., Splunk, Elastic SIEM, or Azure Sentinel) by forwarding structured log events. The existing log schema is compatible with standard SIEM ingestion formats.

**Evidence:**
- Log export API: `src/mastra/routes/eventLogsRoutes.ts`
- VAPT Recommendation #5: "Security Monitoring — Implement alerting on repeated 401/429 responses"

---

## 5. Data Protection & Privacy

### 5.1 Is there a data classification scheme for QMS data?

**Response:**
Yes. The PDPL (Saudi Personal Data Protection Law) compliance module implements a formal **data classification scheme** with the following categories:

| Classification | Description | Example Fields |
|---------------|-------------|---------------|
| `personal` | Personally identifiable information | Email, Phone, First_Name, Last_Name |
| `sensitive` | Sensitive personal data requiring enhanced protection | National ID, financial data |
| `business` | Business operational data | Company name, Lead Owner, Deal Stage |
| `public` | Non-sensitive, publicly available data | Company website, industry |

**Data Inventory:**
The `data_inventory` table maintains a registry of all data fields with:
- Field name and description
- Data category classification
- Module and table association
- Purpose of processing
- Legal basis for processing
- Authorized access roles
- Retention period (days)
- Encryption status (`is_encrypted`)
- Masking status (`is_masked`)
- PII type identifier

**AI Guardrails:**
Regex-based masking patterns are configured for sensitive data types (email, phone, national ID, credit card) in the `ai_guardrails` table, with replacement tokens like `[EMAIL_REDACTED]`.

**Evidence:**
- Data inventory schema: `src/utils/pdplDatabase.ts` (lines 100–122)
- Default data classification seed: `src/utils/pdplDatabase.ts` (lines 230–241)
- AI guardrails: `src/utils/pdplDatabase.ts` (lines 253–270)
- PDPL dashboard: `dashboard/pdpl.html`

---

### 5.2 Is there a documented data retention schedule?

**Response:**
Yes. The `retention_policies` table defines formal retention schedules per module and data category:

| Policy Name | Module | Table | Retention Period | Action on Expiry |
|------------|--------|-------|-----------------|-----------------|
| CRM Leads Retention | CRM | leads | 730 days (2 years) | Anonymize |
| CRM Deals Retention | CRM | deals | 1,095 days (3 years) | Archive |
| Audit Logs Retention | System | event_logs | 2,555 days (~7 years) | Archive |
| Quality Audits Retention | QMS | quality_audit_results | 1,825 days (~5 years) | Archive |

Each retention policy specifies:
- `retention_days`: Number of days data is retained
- `action_on_expiry`: Action when retention period expires — `delete`, `anonymize`, or `archive`
- `is_active`: Whether the policy is currently enforced
- `last_run` and `records_processed`: Tracking of policy execution

**Evidence:**
- Retention policy schema: `src/utils/pdplDatabase.ts` (lines 148–164)
- Default retention policies: `src/utils/pdplDatabase.ts` (lines 276–291)

---

### 5.3 How is data deleted or anonymized?

**Response:**
The system supports data deletion and anonymization through the **DSAR (Data Subject Access Request)** workflow, compliant with Saudi PDPL requirements:

**Supported Request Types:**
- `access` — Subject can request a copy of their data
- `correction` — Subject can request data corrections
- `deletion` — Right to be forgotten / data erasure
- `restriction` — Restrict processing of data
- `portability` — Data portability request

**DSAR Workflow:**
1. Request created with auto-generated ID (`DSAR-xxxx`), 30-day SLA
2. Status tracking: `received` → `in_progress` → `pending_approval` → `completed`
3. Assignment to responsible staff member
4. Response summary and evidence documentation
5. All DSAR actions logged in `pdpl_audit_log` with SHA-256 checksums

**Retention Policy Enforcement:**
- Policies define automated actions (`delete`, `anonymize`, `archive`) when data exceeds its retention period
- Execution is tracked via `last_run` and `records_processed` fields

**Evidence:**
- DSAR implementation: `src/utils/pdplDatabase.ts` (lines 30–47, 385–431)
- DSAR request types: `src/utils/pdplDatabase.ts` (line 6)
- PDPL audit logging: `src/utils/pdplDatabase.ts` (lines 294–305)

---

## 6. Third-Party Integrations

### 6.1 For the OpenAI GPT-4o integration — is data protected before sending?

**Response:**
The following data protection measures are applied to data processed by the OpenAI GPT-4o integration:

**Input Protection:**
1. **Input Sanitization Middleware:** All incoming API data passes through server-side sanitization (`sanitizeRequestBody`) that strips HTML tags, script injection patterns, event handlers, and prototype pollution keys before data reaches any AI agent
2. **AI Guardrails:** The PDPL module maintains configurable regex-based masking patterns for sensitive field types:
   - Email addresses → `[EMAIL_REDACTED]`
   - Phone numbers → `[PHONE_REDACTED]`
   - National IDs → `[ID_REDACTED]`
   - Credit card numbers → `[CARD_REDACTED]`

**API Security:**
3. **Authentication Required:** All API endpoints that invoke AI agents require valid authentication (Google session or Admin API key)
4. **API Key Protection:** The OpenAI API key is stored in Replit's encrypted Secrets vault and never exposed in responses or error messages
5. **Transport Encryption:** All API calls to OpenAI are made over HTTPS/TLS

**Data Processing Terms:**
6. OpenAI's API data usage policy states that data sent via the API is **not used for model training** by default. OpenAI offers a Data Processing Addendum (DPA) for enterprise compliance.

**Recommendation:** For environments handling highly sensitive PII, consider implementing explicit PII stripping/anonymization before AI agent invocation as an additional layer beyond the existing guardrails.

**Evidence:**
- Input sanitization: `src/utils/inputSanitizer.ts` (47 lines)
- Sanitization middleware: `src/mastra/index.ts` (lines 190–208)
- AI guardrail patterns: `src/utils/pdplDatabase.ts` (lines 253–270)
- AI agent definitions: `src/mastra/agents/qualitySpecialistAgent.ts`, `src/mastra/agents/sdrQualityAgent.ts`

---

## 7. Secrets Management

### 7.1 How are credentials and API keys managed?

**Response:**
All credentials and API keys are managed through **Replit's encrypted Secrets vault**:

| Secret | Purpose | Access Method |
|--------|---------|--------------|
| `DATABASE_URL` | PostgreSQL connection string | `process.env.DATABASE_URL` |
| `SESSION_SECRET` | Session cookie HMAC signing | `process.env.SESSION_SECRET` |
| `ADMIN_API_KEY` | Administrative API access | `process.env.ADMIN_API_KEY` |
| `REPL_ID` | Replit OIDC client identifier (auto-provided by Replit) | `process.env.REPL_ID` |
| `ISSUER_URL` | Replit OIDC issuer URL (defaults to <REDACTED_URL> | `process.env.ISSUER_URL` |
| `ZOHO_CLIENT_ID` | Zoho CRM OAuth client ID | `process.env.ZOHO_CLIENT_ID` |
| `ZOHO_CLIENT_SECRET` | Zoho CRM OAuth client secret | `process.env.ZOHO_CLIENT_SECRET` |
| `ZOHO_REFRESH_TOKEN` | Zoho CRM OAuth refresh token | `process.env.ZOHO_REFRESH_TOKEN` |
| `RESEND_API_KEY` | Resend email service API key | `process.env.RESEND_API_KEY` |
| `RESEND_FROM_EMAIL` | Sender email address | `process.env.RESEND_FROM_EMAIL` |

**Security Controls:**
- Secrets are **encrypted at rest** in Replit's vault
- Secrets are injected as **environment variables** at runtime — never hardcoded in source code
- Error messages are **scrubbed** of all environment variable names and secret references (VAPT Finding VULN-06)
- The `SESSION_SECRET` has a fallback value only for development environments (`'fallback-dev-secret'`)

**Evidence:**
- Secret usage in auth: `src/mastra/routes/authRoutes.ts` (lines 19, 27)
- Secret scrubbing: `docs/VAPT_Remediation_Report.md` (VULN-06)
- VAPT Recommendation #3: "Key Rotation — Rotate SESSION_SECRET and ADMIN_API_KEY annually"

---

### 7.2 Are API keys for external services properly secured?

**Response:**
Yes. All external API keys are secured as follows:

1. **Storage:** All keys stored in Replit's encrypted Secrets vault (not in source code, `.env` files, or configuration files)
2. **Error Handling:** Generic error messages returned for integration failures (e.g., "CRM integration not configured. Please contact your administrator." instead of exposing key names)
3. **Transport:** All API calls to external services use HTTPS/TLS
4. **Access Scope:**
   - Replit OIDC: Callback URI restricted to production domain; client ID is the REPL_ID (auto-managed by Replit)
   - Zoho CRM: OAuth 2.0 with auto-refreshing tokens (refresh token rotated automatically)
   - OpenAI: API key scope limited to the specific organization

**Recommendation:** Implement annual key rotation for all secrets, particularly `SESSION_SECRET` and `ADMIN_API_KEY`.

**Evidence:**
- Zoho OAuth token refresh: `src/utils/zohoCRM.ts`
- Error message scrubbing: `docs/VAPT_Remediation_Report.md` (VULN-06, VULN-16)

---

## 8. Application Security

### 8.1 Is input validation implemented for all user inputs?

**Response:**
Yes. **Server-side input validation and sanitization** is implemented globally via middleware:

**Sanitization Layer (`src/utils/inputSanitizer.ts`):**
- **HTML Tag Stripping:** All HTML tags removed from string values using regex (`/<[^>]*>/g`)
- **Script Pattern Blocking:** Patterns including `javascript:`, `on\w+=` (event handlers), `eval()`, and `expression()` are stripped
- **Prototype Pollution Protection:** Dangerous keys (`__proto__`, `constructor`, `prototype`) are recursively removed from all JSON request bodies
- **Recursive Processing:** Sanitization traverses nested objects and arrays

**Middleware Application (`src/mastra/index.ts`):**
- Applied to **all** `POST`, `PUT`, and `PATCH` requests with `Content-Type: application/json`
- Executes **before** any route handler processes the request
- The raw request body is replaced with the sanitized version

**Additional Validation:**
- Rate limiting on all API endpoints (100 read/min, 20 write/min per IP)
- Authentication required on all non-public endpoints
- Specific route handlers perform field-level validation (e.g., required fields, date formats)

**VAPT Findings Addressed:**
- VULN-04: Stored XSS — Remediated
- VULN-09: Missing Input Validation — Remediated
- VULN-10: Mass Assignment / Prototype Pollution — Remediated
- VULN-19: Prototype Pollution via JSON — Remediated

**Evidence:**
- Sanitizer implementation: `src/utils/inputSanitizer.ts` (47 lines, complete file)
- Global middleware: `src/mastra/index.ts` (lines 190–208)
- Rate limiter: `src/utils/rateLimiter.ts` (40 lines, complete file)

---

### 8.2 How are application errors handled?

**Response:**
Application errors are handled with a **defense-in-depth** approach that prevents information leakage:

1. **Try-Catch Pattern:** All API route handlers are wrapped in `try...catch` blocks
2. **Generic Error Messages:** Error responses use generic messages (e.g., "Failed to fetch audits", "Authentication required") without exposing:
   - Stack traces
   - Environment variable names
   - Database connection details
   - Internal file paths
   - Framework-identifying information
3. **HTTP Status Codes:** Appropriate status codes are used consistently:
   - `400` — Bad request (validation errors)
   - `401` — Authentication required
   - `404` — Resource not found
   - `429` — Rate limit exceeded (with `Retry-After` header)
   - `500` — Internal server error (generic message)
4. **Server-Side Logging:** Detailed error information (including stack traces) is logged server-side via the Pino logger for debugging, but **never sent to the client**
5. **Database Error Handling:** Specific PostgreSQL error codes (e.g., `23505` for unique constraint violations) are caught and returned as user-friendly messages
6. **Global Error Handler:** The middleware includes a final catch block for unhandled errors, logging the request context and wrapping framework-specific errors (`MastraError`, `ZodError`) as `NonRetriableError` for Inngest compatibility

**Evidence:**
- Global error handler: `src/mastra/index.ts` (lines 210–226)
- Generic error responses: `docs/VAPT_Remediation_Report.md` (VULN-06, VULN-16)
- Route-level error handling: `src/mastra/index.ts` (e.g., lines 252–256, try-catch pattern)

---

## 9. Vendor & Third-Party Risk Management

### 9.1 Has Replit been assessed for security compliance?

**Response:**
Replit maintains **SOC 2 Type II** compliance certification. Additionally:

**Platform VAPT Assessment (March 2026):**
- A formal Vulnerability Assessment and Penetration Testing was conducted on March 11–12, 2026
- Methodology: **OWASP Testing Guide v4.2**
- 19 vulnerabilities identified (6 Critical, 5 High, 5 Medium, 3 Low)
- **All 19 vulnerabilities remediated**
- Quarterly reassessments recommended (next: June 2026)

**Compliance Alignment:**

| Framework | Requirement | Status |
|-----------|-------------|--------|
| OWASP Top 10 2021 | A01: Broken Access Control | Remediated |
| OWASP Top 10 2021 | A02: Cryptographic Failures | Remediated |
| OWASP Top 10 2021 | A03: Injection | Remediated |
| OWASP Top 10 2021 | A04: Insecure Design | Remediated |
| OWASP Top 10 2021 | A05: Security Misconfiguration | Remediated |
| OWASP Top 10 2021 | A07: Identification & Auth Failures | Remediated |
| NCA-ECC | Authentication & Access Control | Aligned |
| NCA-DCC | Data Protection & Privacy | Aligned |
| ISO 27001 | A.9 Access Control | Aligned |
| ISO 27001 | A.14 System Acquisition, Development | Aligned |

**Evidence:**
- Full VAPT report: `docs/VAPT_Remediation_Report.md` (240 lines)
- Compliance alignment table: `docs/VAPT_Remediation_Report.md` (Section 4)

---

### 9.2 Do all vendor contracts include security and compliance requirements?

> **⚠️ ACTION REQUIRED — Business/Legal Confirmation Needed**

**Response:**
The QMS platform includes a dedicated **Vendor Risk Management (VRM) module** (`/vendors`) that provides:

1. **Vendor Registration:** Tracking vendor code, category, criticality level (Critical/High/Medium/Low), data access level, and contract details
2. **Risk Assessments:** Formal assessments covering security, financial, operational, and compliance scoring with overall risk level calculation
3. **Remediation Tracking:** Priority-based remediation tasks with assignment, due dates, evidence, and waiver workflows
4. **Contract Monitoring:** Expiring contract alerts (90-day window) and overdue assessment tracking
5. **Audit Logging:** All vendor-related changes logged in the event logging system

Whether specific vendor contracts (with Replit, OpenAI, Neon, Zoho, Resend) include formal security and compliance clauses is a **business/legal matter** that should be verified by the procurement team.

**Evidence:**
- Vendor database schema: `src/utils/vendorDatabase.ts` (436 lines)
- Vendor API routes: `src/mastra/routes/vendorRoutes.ts`
- Vendor dashboard: `dashboard/vendors.html`

---

## 10. Compliance Certifications

### 10.1 Have compliance audits been conducted for the QMS?

**Response:**
Yes. The following compliance-related audits and assessments have been conducted:

**1. VAPT Assessment (March 2026):**
- Full penetration testing following OWASP Testing Guide v4.2
- 19 vulnerabilities identified across 4 severity levels
- All 19 vulnerabilities remediated
- Alignment verified with OWASP Top 10 2021, NCA-ECC, NCA-DCC, and ISO 27001
- Quarterly reassessments scheduled (next: June 2026)

**2. Built-in Compliance Capabilities:**
The platform includes dedicated modules for ongoing compliance management:

| Module | Dashboard | Purpose |
|--------|-----------|---------|
| Compliance Tracker | `/compliance` | Regulatory compliance monitoring (ISO 9001, COPC, Six Sigma) |
| Audit Readiness | `/audits` | Internal/external audit management with evidence packs |
| PDPL Privacy | `/pdpl` | Saudi PDPL compliance (data inventory, DSAR, retention, incidents) |
| Event Logs | `/logs` | Immutable audit trail with SHA-256 integrity checksums |
| Vendor Risk | `/vendors` | Third-party vendor compliance and risk assessments |
| GRC Control Tower | `/grc` | Governance, Risk & Compliance oversight |

**3. Security Hardening Documentation:**
- VAPT Remediation Report: `docs/VAPT_Remediation_Report.md`
- Technical Scope of Work (Section 8 — Security & Compliance): `docs/SCOPE_OF_WORK.md`

**Evidence:**
- VAPT report: `docs/VAPT_Remediation_Report.md`
- Scope of work: `docs/SCOPE_OF_WORK.md`
- Compliance routes: `src/mastra/routes/complianceRoutes.ts`
- Audit routes: `src/mastra/routes/auditRoutes.ts`
- PDPL routes: `src/mastra/routes/pdplRoutes.ts`

---

## Summary of Items Requiring Business Action

| # | Question | Action Required |
|---|----------|----------------|
| 1.1 | Data center locations | Confirm exact data center regions with Replit and Neon vendor documentation |
| 1.2 | DPA with Replit | Verify if a Data Processing Agreement is signed with Replit |
| 1.3 | Sub-processors | Confirm sub-processor list against Replit's official published list |
| 2.3 | Encryption key management | Confirm database encryption key management details with Neon |
| 9.2 | Vendor contract clauses | Verify that vendor contracts with Replit, OpenAI, Neon, Zoho, Resend include security requirements |

## Summary of Recommended Enhancements

| # | Enhancement | Priority | Reference |
|---|------------|----------|-----------|
| 1 | Periodic VAPT reassessments | High | VAPT Report §5, Item 1 |
| 2 | Automated dependency scanning (npm audit, Snyk) | High | VAPT Report §5, Item 2 |
| 3 | Annual key rotation (SESSION_SECRET, ADMIN_API_KEY) | Medium | VAPT Report §5, Item 3 |
| 4 | Web Application Firewall (Cloudflare WAF) | Medium | VAPT Report §5, Item 4 |
| 5 | SIEM integration and security alerting | Medium | VAPT Report §5, Item 5 |
| 6 | Column-level database encryption for PII | Medium | VAPT Report §5, Item 6 |
| 7 | Backup verification and restore testing | Medium | VAPT Report §5, Item 7 |
| 8 | PII anonymization before AI agent invocation | Low | Section 6.1 recommendation |

---

**Document End**
**Prepared by:** ExampleOrg Platform Engineering & Security Team
**Response Date:** March 15, 2026
**Next Review:** June 2026 (Quarterly)
