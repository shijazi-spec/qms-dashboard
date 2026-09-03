# ExampleOrg Platform — Integration Setup Guide
# CRMProvider CRM, ContactCenterProvider Contact Center & IdentityProvider Calendar

**Document Version:** 1.0
**Date:** March 24, 2026
**Classification:** INTERNAL — Share with Integration Administrators
**Platform:** ExampleOrg QMS (<REDACTED_URL_SCHEME><REDACTED_HOST>)

---

## Purpose

This document provides everything your **CRMProvider CRM Admin**, **ContactCenterProvider Admin**, and **IdentityProvider Workspace Admin** need to configure and connect their systems to the ExampleOrg QMS platform. Each section is self-contained — share the relevant section with the corresponding admin.

---

## Table of Contents

- [Section 1: CRMProvider CRM Integration](#section-1-CRMProvider-crm-integration)
- [Section 2: ContactCenterProvider Contact Center Integration](#section-2-ContactCenterProvider-contact-center-integration)
- [Section 3: IdentityProvider Calendar Integration](#section-3-IdentityProvider-calendar-integration)
- [Section 4: IdentityProvider OAuth (User Login)](#section-4-IdentityProvider-oauth-user-login)
- [Section 5: Environment Variables Summary](#section-5-environment-variables-summary)
- [Section 6: Testing & Verification](#section-6-testing--verification)

---

## Section 1: CRMProvider CRM Integration

### What ExampleOrg Does with CRMProvider CRM

ExampleOrg connects to CRMProvider CRM to perform **read-only data quality audits** and **duplicate detection**. It reads records from the following modules:

| CRMProvider Module | Access Level | Purpose |
|-------------|-------------|---------|
| **Leads** | Read | Data hygiene audit (email, phone, lead source, lead status) |
| **Deals** | Read | Pipeline quality audit (deal name, stage, amount, closing date) |
| **Contacts** | Read | Contact completeness audit (email, last name) |
| **Tasks** | Read | Activity audit (subject, due date, owner) |
| **Accounts** | Read | Duplicate detection & relationship validation |

**ExampleOrg does NOT write, update, or delete any CRMProvider CRM records.**

### What the CRMProvider Admin Needs to Do

#### Step 1: Create a Server-Side OAuth Client (Self Client)

1. Go to **CRMProvider API Console**: <REDACTED_URL>
2. Click **Add Client** → select **Self Client** (server-to-server, no user interaction)
3. Note down the generated:
   - **Client ID** (e.g., `1000.XXXXXXXXXXXXXXXXXXXX`)
   - **Client Secret** (e.g., `abcdef1234567890abcdef1234567890`)

#### Step 2: Generate a Refresh Token

1. In the Self Client page, click **Generate Code**
2. Enter the following **scope** (copy exactly):
   ```
   CRMProviderCRM.modules.READ,CRMProviderCRM.settings.READ,CRMProviderCRM.users.READ
   ```
3. Set **Time Duration** to **10 minutes**
4. Set **Scope Description** to: `ExampleOrg QMS Data Quality Audit - Read Only`
5. Click **Create** — you will receive a **Grant Token** (valid for 10 minutes)
6. Use the grant token to generate a refresh token by calling:

   ```
   POST <REDACTED_URL>
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code
   &client_id=YOUR_CLIENT_ID
   &client_secret=YOUR_CLIENT_SECRET
   &code=YOUR_GRANT_TOKEN
   ```

7. The response will contain a **refresh_token** — this is what ExampleOrg needs. It does not expire unless revoked.

#### Step 3: Provide These Values to the ExampleOrg Team

| Value | Example | Where to Set |
|-------|---------|-------------|
| **Client ID** | `1000.ABCDEFGHIJKLMNOP` | `CRMProvider_CLIENT_ID` secret |
| **Client Secret** | `abcdef1234567890abcdef` | `CRMProvider_CLIENT_SECRET` secret |
| **Refresh Token** | `1000.xxxxxxxxxxxx.yyyyyyyyyyyy` | `CRMProvider_REFRESH_TOKEN` secret |
| **Accounts URL** | `<REDACTED_URL>` (default) | `CRMProvider_ACCOUNTS_URL` secret (optional) |
| **API Domain** | `<REDACTED_URL>` (default) | `CRMProvider_API_DOMAIN` secret (optional) |

**For CRMProvider EU/IN/AU data centers**, the URLs differ:

| Data Center | Accounts URL | API Domain |
|-------------|-------------|------------|
| US (default) | `<REDACTED_URL>` | `<REDACTED_URL>` |
| EU | `<REDACTED_URL>` | `<REDACTED_URL>` |
| India | `<REDACTED_URL>` | `<REDACTED_URL>` |
| Australia | `<REDACTED_URL>` | `<REDACTED_URL>` |

#### Step 4: Required CRMProvider CRM Permissions

The CRMProvider user account associated with the OAuth client must have:

- **Profile:** At least **Standard** or **Custom** with read access
- **Module Access:** Read permission on Leads, Deals, Contacts, Tasks, Accounts
- **No Write permissions required** — ExampleOrg only reads data

#### How Token Refresh Works (Automatic)

ExampleOrg automatically refreshes the access token using the refresh token. The platform:
1. Caches the access token in memory
2. Auto-refreshes 5 minutes before expiry
3. Retries once on 401 errors (in case of token expiry during a request)
4. No manual token rotation is needed

#### Alternative: Static Access Token (Not Recommended)

If OAuth is not possible, you can provide a static access token:
- Set `CRMProvider_ACCESS_TOKEN` with a valid access token
- **Warning:** Static tokens expire after 1 hour and cannot auto-refresh
- This is only suitable for testing, not production

---

## Section 2: ContactCenterProvider Contact Center Integration

### What ExampleOrg Does with ContactCenterProvider

ExampleOrg ingests call recordings and metadata from ContactCenterProvider for **SDR call quality evaluation**. The AI agents analyze calls for:

- Sales methodology compliance (SPIN, Challenger, etc.)
- Arabic/English language quality
- CRM logging completeness (cross-referenced with CRMProvider)
- Customer objection handling

### What the ContactCenterProvider Admin Needs to Do

#### Step 1: Create a ContactCenterProvider API User

1. Go to **ContactCenterProvider Admin Console** → **User Management**
2. Create a new user (or designate an existing one) for API access
3. Assign the **Reporting** role (minimum) — needed for call data access
4. Note down:
   - **Domain** (your ContactCenterProvider domain, e.g., `<REDACTED_HOST>` or your custom domain)
   - **Username** (API user's email/login)
   - **Password** (API user's password)

#### Step 2: Required ContactCenterProvider Permissions

The API user needs these permissions at minimum:

| Permission | Required | Purpose |
|-----------|----------|---------|
| **VCC** | Yes | Access to Virtual Contact Center data |
| **Reporting** | Yes | Access to call statistics and recordings |
| **Recording Access** | Yes | Download and stream call recordings |
| **Agent Statistics** | Yes | View agent performance data |

#### Step 3: Configure in ExampleOrg

The ContactCenterProvider integration is configured through the ExampleOrg admin panel:

1. Log in to ExampleOrg as admin
2. Navigate to **Call Intelligence** → **Settings** (or use the API)
3. Enter the ContactCenterProvider credentials

**Or via API:**

```
POST /api/calls/ContactCenterProvider/configure
X-Admin-Key: YOUR_ADMIN_KEY
Content-Type: application/json

{
  "domain": "<REDACTED_HOST>",
  "username": "user@example.invalid",
  "password": "<REDACTED_SECRET>"
}
```

#### Step 4: Test the Connection

```
POST /api/calls/ContactCenterProvider/test
Content-Type: application/json

{
  "domain": "<REDACTED_HOST>",
  "username": "user@example.invalid",
  "password": "<REDACTED_SECRET>"
}
```

Expected response:
```json
{
  "success": true,
  "message": "ContactCenterProvider connection test successful. API is reachable.",
  "domain": "<REDACTED_HOST>"
}
```

#### Step 5: Sync Calls

Once configured, sync calls on demand:

```
POST /api/calls/ContactCenterProvider/sync
X-Admin-Key: YOUR_ADMIN_KEY
```

### Supported Call Sources

ExampleOrg can ingest calls from multiple sources, not just ContactCenterProvider:

| Source | Method | Notes |
|--------|--------|-------|
| **ContactCenterProvider** | API sync | Primary integration via `/api/calls/ContactCenterProvider/sync` |
| **TelephonyProvider** | API ingest | Via `/api/calls/ingest` with `source: "TelephonyProvider"` |
| **Mobile** | Manual upload | Via `/api/calls/ingest` with `source: "mobile"` |
| **IdentityProvider Meet** | Calendar integration | Via `/api/calls/ingest` with `source: "IdentityProvider_meet"` |

### Call Ingest API (All Sources)

For manual or custom integrations, use the call ingest endpoint:

```
POST /api/calls/ingest
X-Admin-Key: YOUR_ADMIN_KEY
Content-Type: application/json

{
  "call_id": "unique-call-id",
  "source": "ContactCenterProvider",
  "agent_email": "user@example.invalid",
  "agent_name": "Agent Name",
  "contact_name": "Customer Name",
  "direction": "outbound",
  "duration_seconds": 360,
  "recording_url": "<REDACTED_URL>",
  "lead_id": "CRMProvider-lead-id",
  "call_date": "2026-03-24T10:30:00Z"
}
```

---

## Section 3: IdentityProvider Calendar Integration

### What ExampleOrg Does with IdentityProvider Calendar

ExampleOrg reads calendar events to **audit meeting activity** and cross-reference with CRM logged activities. It checks:

- Whether client meetings are logged in CRMProvider CRM
- Meeting attendance and follow-up completeness
- Agent activity gaps (meetings without CRM entries)

**ExampleOrg does NOT create, modify, or delete calendar events.**

### What the IdentityProvider Workspace Admin Needs to Do

#### Option A: HostingPlatform Connectors (Recommended)

If the platform is hosted on HostingPlatform, IdentityProvider Calendar uses the built-in HostingPlatform Connectors system:

1. In the HostingPlatform workspace, go to **Tools** → **Integrations**
2. Search for **IdentityProvider Calendar**
3. Click **Connect** and authenticate with a IdentityProvider Workspace account
4. Grant **read-only** calendar access
5. The connection is managed automatically — no manual token handling needed

#### Option B: IdentityProvider Cloud Service Account (For Self-Hosted)

If deploying outside HostingPlatform:

1. Go to **IdentityProvider Cloud Console** → **APIs & Services** → **Credentials**
2. Create a **Service Account**
3. Enable the **IdentityProvider Calendar API**
4. Download the service account JSON key file
5. **Share the calendars** you want ExampleOrg to audit with the service account email (e.g., `user@example.invalid`) — grant **"See all event details"** permission
6. Set the following environment variable:
   - `IdentityProvider_CLIENT_EMAIL` — the service account email
   - Store the private key securely

#### Required IdentityProvider Calendar API Scopes

```
<REDACTED_URL>
<REDACTED_URL>
```

**No write scopes are needed.**

#### Which Calendars to Share

Share calendars for all team members whose meeting activity should be audited:

- SDR team calendars
- Sales manager calendars
- Any shared team calendars used for client meetings

### API Endpoints Used

| IdentityProvider Calendar API Endpoint | Purpose |
|------------------------------|---------|
| `GET /calendar/v3/users/me/calendarList` | List accessible calendars |
| `GET /calendar/v3/calendars/{id}/events` | Fetch events for a date range |

---

## Section 4: IdentityProvider OAuth (User Login)

### What This Is For

ExampleOrg supports **IdentityProvider OAuth login** so team members can sign in with their IdentityProvider Workspace accounts instead of username/password.

### What the IdentityProvider Workspace Admin Needs to Do

#### Step 1: Create an OAuth 2.0 Client

1. Go to **IdentityProvider Cloud Console** → **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `ExampleOrg QMS`
5. Set **Authorized JavaScript origins**:
   ```
   <REDACTED_URL_SCHEME><REDACTED_HOST>
   ```
6. Set **Authorized redirect URIs**:
   ```
   <REDACTED_URL_SCHEME><REDACTED_HOST>/api/auth/IdentityProvider/callback
   ```
7. Click **Create** and note:
   - **Client ID**
   - **Client Secret**

#### Step 2: Configure the OAuth Consent Screen

1. Go to **OAuth consent screen**
2. User Type: **Internal** (if using IdentityProvider Workspace)
3. App name: `ExampleOrg QMS`
4. User support email: your IT email
5. Scopes: Add `openid`, `email`, `profile`
6. Click **Save**

#### Step 3: Provide These Values

| Value | Where to Set |
|-------|-------------|
| **Client ID** | `IdentityProvider_CLIENT_ID` secret |
| **Client Secret** | `IdentityProvider_CLIENT_SECRET` secret |

### Required OAuth Scopes

```
openid
email
profile
```

ExampleOrg only reads the user's name, email, and profile picture for authentication. No Gmail, Drive, or other data is accessed.

---

## Section 5: Environment Variables Summary

All secrets should be set as environment variables (never hardcoded). Here is the complete list:

### CRMProvider CRM (Required for CRM Audits)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `CRMProvider_CLIENT_ID` | Yes | OAuth Client ID from CRMProvider API Console | `1000.ABCDEFGHIJKLMNOP` |
| `CRMProvider_CLIENT_SECRET` | Yes | OAuth Client Secret | `abcdef1234567890...` |
| `CRMProvider_REFRESH_TOKEN` | Yes | OAuth Refresh Token (permanent) | `1000.xxxx.yyyy` |
| `CRMProvider_ACCOUNTS_URL` | No | CRMProvider accounts URL (defaults to US) | `<REDACTED_URL>` |
| `CRMProvider_API_DOMAIN` | No | CRMProvider API domain (defaults to US) | `<REDACTED_URL>` |

### ContactCenterProvider (Required for Call Intelligence)

ContactCenterProvider credentials are stored in the platform database (via `/api/calls/ContactCenterProvider/configure`), not as environment variables.

| Configuration | Required | Description |
|--------------|----------|-------------|
| `domain` | Yes | ContactCenterProvider domain | 
| `username` | Yes | ContactCenterProvider API username |
| `password` | Yes | ContactCenterProvider API password |

### IdentityProvider Calendar (Required for Meeting Audits)

Configured via HostingPlatform Connectors (recommended) or:

| Variable | Required | Description |
|----------|----------|-------------|
| `IdentityProvider_CLIENT_EMAIL` | If self-hosted | Service account email |

### IdentityProvider OAuth Login (Required for SSO)

| Variable | Required | Description |
|----------|----------|-------------|
| `IdentityProvider_CLIENT_ID` | Yes | OAuth 2.0 Client ID |
| `IdentityProvider_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret |

### Platform (Already Configured)

| Variable | Description |
|----------|-------------|
| `ADMIN_API_KEY` | Admin access key for platform management |
| `DATABASE_URL` | PostgreSQL connection string (DatabaseProvider) |
| `SESSION_SECRET` | Session encryption key |

---

## Section 6: Testing & Verification

### Verify CRMProvider CRM Connection

```
GET /api/integrations/status
X-Admin-Key: YOUR_ADMIN_KEY
```

Response when configured:
```json
{
  "CRMProvider": {
    "configured": true,
    "autoRefresh": true,
    "tokenCached": true,
    "tokenExpired": false,
    "message": "CRMProvider CRM configured with OAuth auto-refresh"
  }
}
```

### Verify CRMProvider Data Access

```
GET /api/CRMProvider/records?module=Leads&page=1&per_page=5
X-Admin-Key: YOUR_ADMIN_KEY
```

This should return Leads from your CRMProvider CRM.

### Verify ContactCenterProvider Connection

```
POST /api/calls/ContactCenterProvider/test
Content-Type: application/json

{
  "domain": "<REDACTED_HOST>",
  "username": "your-api-user",
  "password": "<REDACTED_SECRET>"
}
```

### Verify IdentityProvider Calendar

After connecting via HostingPlatform Connectors or service account:

The calendar integration is automatically used during quality audits. You can trigger a test audit from the admin dashboard to verify calendar events are being fetched.

### Run a Full Integration Test

Trigger a quality audit that exercises all integrations:

```
POST /api/audit/trigger
X-Admin-Key: YOUR_ADMIN_KEY
Content-Type: application/json

{
  "modules": ["leads", "deals", "contacts", "activities"],
  "dateRange": {
    "start": "2026-03-01",
    "end": "2026-03-24"
  }
}
```

The audit report will show which integrations were successful and which need attention.

---

## Troubleshooting

### CRMProvider CRM

| Issue | Cause | Solution |
|-------|-------|----------|
| `CRM integration not configured` | Missing env vars | Set `CRMProvider_CLIENT_ID`, `CRMProvider_CLIENT_SECRET`, `CRMProvider_REFRESH_TOKEN` |
| `Failed to refresh CRMProvider access token: 401` | Invalid refresh token | Re-generate refresh token (Step 2) |
| `Failed to refresh CRMProvider access token: 400` | Wrong client ID/secret | Verify credentials in CRMProvider API Console |
| Empty records returned | No module access | Check CRMProvider user profile has read access to modules |
| `INVALID_TOKEN` error | Refresh token revoked | Re-generate from CRMProvider API Console |

### ContactCenterProvider

| Issue | Cause | Solution |
|-------|-------|----------|
| `ContactCenterProvider not configured` | Configuration not saved | Run `/api/calls/ContactCenterProvider/configure` with credentials |
| Connection test fails | Wrong credentials/domain | Verify ContactCenterProvider API user has Reporting permissions |
| No calls synced | API user lacks permissions | Ensure Recording Access and VCC permissions |

### IdentityProvider Calendar

| Issue | Cause | Solution |
|-------|-------|----------|
| `IdentityProvider Calendar not connected` | HostingPlatform Connector not set up | Connect via HostingPlatform Integrations panel |
| No events returned | Calendar not shared | Share calendars with service account email |
| `Calendar API error: 403` | API not enabled | Enable IdentityProvider Calendar API in Cloud Console |

### IdentityProvider OAuth Login

| Issue | Cause | Solution |
|-------|-------|----------|
| `IdentityProvider OAuth not configured` | Missing env vars | Set `IdentityProvider_CLIENT_ID` and `IdentityProvider_CLIENT_SECRET` |
| `redirect_uri_mismatch` | Wrong redirect URI | Add exact URI to IdentityProvider Cloud Console |
| `invalid_client` | Wrong client ID/secret | Verify credentials |
| Login works but no access | User not in platform | Admin must approve the user's access request |

---

## Security Notes

1. **All credentials are stored as encrypted environment variables** — never in code or configuration files
2. **CRMProvider access is read-only** — ExampleOrg cannot modify CRM data
3. **IdentityProvider Calendar access is read-only** — ExampleOrg cannot modify calendar events
4. **ContactCenterProvider credentials are stored in encrypted database columns** — accessible only to admin-role users
5. **All API calls are made server-side** — no credentials are exposed to the browser
6. **OAuth tokens auto-refresh** — no manual token rotation needed for CRMProvider or IdentityProvider
7. **Rate limiting is applied** — API calls to third-party services are throttled to prevent abuse

---

## Document Control

| Version | Date | Author | Description |
|---------|------|--------|-------------|
| 1.0 | March 24, 2026 | ExampleOrg Platform Team | Initial integration setup guide |

**Distribution:** CRMProvider CRM Admin, ContactCenterProvider Admin, IdentityProvider Workspace Admin, ExampleOrg Platform Team
