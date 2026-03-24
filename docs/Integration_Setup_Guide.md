# WalaPlus Platform — Integration Setup Guide
# Zoho CRM, Five9 Contact Center & Google Calendar

**Document Version:** 1.0
**Date:** March 24, 2026
**Classification:** INTERNAL — Share with Integration Administrators
**Platform:** WalaPlus QMS (https://qms-dashboard.replit.app)

---

## Purpose

This document provides everything your **Zoho CRM Admin**, **Five9 Admin**, and **Google Workspace Admin** need to configure and connect their systems to the WalaPlus QMS platform. Each section is self-contained — share the relevant section with the corresponding admin.

---

## Table of Contents

- [Section 1: Zoho CRM Integration](#section-1-zoho-crm-integration)
- [Section 2: Five9 Contact Center Integration](#section-2-five9-contact-center-integration)
- [Section 3: Google Calendar Integration](#section-3-google-calendar-integration)
- [Section 4: Google OAuth (User Login)](#section-4-google-oauth-user-login)
- [Section 5: Environment Variables Summary](#section-5-environment-variables-summary)
- [Section 6: Testing & Verification](#section-6-testing--verification)

---

## Section 1: Zoho CRM Integration

### What WalaPlus Does with Zoho CRM

WalaPlus connects to Zoho CRM to perform **read-only data quality audits** and **duplicate detection**. It reads records from the following modules:

| Zoho Module | Access Level | Purpose |
|-------------|-------------|---------|
| **Leads** | Read | Data hygiene audit (email, phone, lead source, lead status) |
| **Deals** | Read | Pipeline quality audit (deal name, stage, amount, closing date) |
| **Contacts** | Read | Contact completeness audit (email, last name) |
| **Tasks** | Read | Activity audit (subject, due date, owner) |
| **Accounts** | Read | Duplicate detection & relationship validation |

**WalaPlus does NOT write, update, or delete any Zoho CRM records.**

### What the Zoho Admin Needs to Do

#### Step 1: Create a Server-Side OAuth Client (Self Client)

1. Go to **Zoho API Console**: https://api-console.zoho.com/
2. Click **Add Client** → select **Self Client** (server-to-server, no user interaction)
3. Note down the generated:
   - **Client ID** (e.g., `1000.XXXXXXXXXXXXXXXXXXXX`)
   - **Client Secret** (e.g., `abcdef1234567890abcdef1234567890`)

#### Step 2: Generate a Refresh Token

1. In the Self Client page, click **Generate Code**
2. Enter the following **scope** (copy exactly):
   ```
   ZohoCRM.modules.READ,ZohoCRM.settings.READ,ZohoCRM.users.READ
   ```
3. Set **Time Duration** to **10 minutes**
4. Set **Scope Description** to: `WalaPlus QMS Data Quality Audit - Read Only`
5. Click **Create** — you will receive a **Grant Token** (valid for 10 minutes)
6. Use the grant token to generate a refresh token by calling:

   ```
   POST https://accounts.zoho.com/oauth/v2/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code
   &client_id=YOUR_CLIENT_ID
   &client_secret=YOUR_CLIENT_SECRET
   &code=YOUR_GRANT_TOKEN
   ```

7. The response will contain a **refresh_token** — this is what WalaPlus needs. It does not expire unless revoked.

#### Step 3: Provide These Values to the WalaPlus Team

| Value | Example | Where to Set |
|-------|---------|-------------|
| **Client ID** | `1000.ABCDEFGHIJKLMNOP` | `ZOHO_CLIENT_ID` secret |
| **Client Secret** | `abcdef1234567890abcdef` | `ZOHO_CLIENT_SECRET` secret |
| **Refresh Token** | `1000.xxxxxxxxxxxx.yyyyyyyyyyyy` | `ZOHO_REFRESH_TOKEN` secret |
| **Accounts URL** | `https://accounts.zoho.com` (default) | `ZOHO_ACCOUNTS_URL` secret (optional) |
| **API Domain** | `https://www.zohoapis.com` (default) | `ZOHO_API_DOMAIN` secret (optional) |

**For Zoho EU/IN/AU data centers**, the URLs differ:

| Data Center | Accounts URL | API Domain |
|-------------|-------------|------------|
| US (default) | `https://accounts.zoho.com` | `https://www.zohoapis.com` |
| EU | `https://accounts.zoho.eu` | `https://www.zohoapis.eu` |
| India | `https://accounts.zoho.in` | `https://www.zohoapis.in` |
| Australia | `https://accounts.zoho.com.au` | `https://www.zohoapis.com.au` |

#### Step 4: Required Zoho CRM Permissions

The Zoho user account associated with the OAuth client must have:

- **Profile:** At least **Standard** or **Custom** with read access
- **Module Access:** Read permission on Leads, Deals, Contacts, Tasks, Accounts
- **No Write permissions required** — WalaPlus only reads data

#### How Token Refresh Works (Automatic)

WalaPlus automatically refreshes the access token using the refresh token. The platform:
1. Caches the access token in memory
2. Auto-refreshes 5 minutes before expiry
3. Retries once on 401 errors (in case of token expiry during a request)
4. No manual token rotation is needed

#### Alternative: Static Access Token (Not Recommended)

If OAuth is not possible, you can provide a static access token:
- Set `ZOHO_ACCESS_TOKEN` with a valid access token
- **Warning:** Static tokens expire after 1 hour and cannot auto-refresh
- This is only suitable for testing, not production

---

## Section 2: Five9 Contact Center Integration

### What WalaPlus Does with Five9

WalaPlus ingests call recordings and metadata from Five9 for **SDR call quality evaluation**. The AI agents analyze calls for:

- Sales methodology compliance (SPIN, Challenger, etc.)
- Arabic/English language quality
- CRM logging completeness (cross-referenced with Zoho)
- Customer objection handling

### What the Five9 Admin Needs to Do

#### Step 1: Create a Five9 API User

1. Go to **Five9 Admin Console** → **User Management**
2. Create a new user (or designate an existing one) for API access
3. Assign the **Reporting** role (minimum) — needed for call data access
4. Note down:
   - **Domain** (your Five9 domain, e.g., `app.five9.com` or your custom domain)
   - **Username** (API user's email/login)
   - **Password** (API user's password)

#### Step 2: Required Five9 Permissions

The API user needs these permissions at minimum:

| Permission | Required | Purpose |
|-----------|----------|---------|
| **VCC** | Yes | Access to Virtual Contact Center data |
| **Reporting** | Yes | Access to call statistics and recordings |
| **Recording Access** | Yes | Download and stream call recordings |
| **Agent Statistics** | Yes | View agent performance data |

#### Step 3: Configure in WalaPlus

The Five9 integration is configured through the WalaPlus admin panel:

1. Log in to WalaPlus as admin
2. Navigate to **Call Intelligence** → **Settings** (or use the API)
3. Enter the Five9 credentials

**Or via API:**

```
POST /api/calls/five9/configure
X-Admin-Key: YOUR_ADMIN_KEY
Content-Type: application/json

{
  "domain": "app.five9.com",
  "username": "api-user@yourcompany.com",
  "password": "secure-password-here"
}
```

#### Step 4: Test the Connection

```
POST /api/calls/five9/test
Content-Type: application/json

{
  "domain": "app.five9.com",
  "username": "api-user@yourcompany.com",
  "password": "secure-password-here"
}
```

Expected response:
```json
{
  "success": true,
  "message": "Five9 connection test successful. API is reachable.",
  "domain": "app.five9.com"
}
```

#### Step 5: Sync Calls

Once configured, sync calls on demand:

```
POST /api/calls/five9/sync
X-Admin-Key: YOUR_ADMIN_KEY
```

### Supported Call Sources

WalaPlus can ingest calls from multiple sources, not just Five9:

| Source | Method | Notes |
|--------|--------|-------|
| **Five9** | API sync | Primary integration via `/api/calls/five9/sync` |
| **Twilio** | API ingest | Via `/api/calls/ingest` with `source: "twilio"` |
| **Mobile** | Manual upload | Via `/api/calls/ingest` with `source: "mobile"` |
| **Google Meet** | Calendar integration | Via `/api/calls/ingest` with `source: "google_meet"` |

### Call Ingest API (All Sources)

For manual or custom integrations, use the call ingest endpoint:

```
POST /api/calls/ingest
X-Admin-Key: YOUR_ADMIN_KEY
Content-Type: application/json

{
  "call_id": "unique-call-id",
  "source": "five9",
  "agent_email": "sdr@yourcompany.com",
  "agent_name": "Agent Name",
  "contact_name": "Customer Name",
  "direction": "outbound",
  "duration_seconds": 360,
  "recording_url": "https://recordings.five9.com/...",
  "lead_id": "zoho-lead-id",
  "call_date": "2026-03-24T10:30:00Z"
}
```

---

## Section 3: Google Calendar Integration

### What WalaPlus Does with Google Calendar

WalaPlus reads calendar events to **audit meeting activity** and cross-reference with CRM logged activities. It checks:

- Whether client meetings are logged in Zoho CRM
- Meeting attendance and follow-up completeness
- Agent activity gaps (meetings without CRM entries)

**WalaPlus does NOT create, modify, or delete calendar events.**

### What the Google Workspace Admin Needs to Do

#### Option A: Replit Connectors (Recommended)

If the platform is hosted on Replit, Google Calendar uses the built-in Replit Connectors system:

1. In the Replit workspace, go to **Tools** → **Integrations**
2. Search for **Google Calendar**
3. Click **Connect** and authenticate with a Google Workspace account
4. Grant **read-only** calendar access
5. The connection is managed automatically — no manual token handling needed

#### Option B: Google Cloud Service Account (For Self-Hosted)

If deploying outside Replit:

1. Go to **Google Cloud Console** → **APIs & Services** → **Credentials**
2. Create a **Service Account**
3. Enable the **Google Calendar API**
4. Download the service account JSON key file
5. **Share the calendars** you want WalaPlus to audit with the service account email (e.g., `walaplus@project-id.iam.gserviceaccount.com`) — grant **"See all event details"** permission
6. Set the following environment variable:
   - `GOOGLE_CLIENT_EMAIL` — the service account email
   - Store the private key securely

#### Required Google Calendar API Scopes

```
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/calendar.events.readonly
```

**No write scopes are needed.**

#### Which Calendars to Share

Share calendars for all team members whose meeting activity should be audited:

- SDR team calendars
- Sales manager calendars
- Any shared team calendars used for client meetings

### API Endpoints Used

| Google Calendar API Endpoint | Purpose |
|------------------------------|---------|
| `GET /calendar/v3/users/me/calendarList` | List accessible calendars |
| `GET /calendar/v3/calendars/{id}/events` | Fetch events for a date range |

---

## Section 4: Google OAuth (User Login)

### What This Is For

WalaPlus supports **Google OAuth login** so team members can sign in with their Google Workspace accounts instead of username/password.

### What the Google Workspace Admin Needs to Do

#### Step 1: Create an OAuth 2.0 Client

1. Go to **Google Cloud Console** → **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `WalaPlus QMS`
5. Set **Authorized JavaScript origins**:
   ```
   https://qms-dashboard.replit.app
   ```
6. Set **Authorized redirect URIs**:
   ```
   https://qms-dashboard.replit.app/api/auth/google/callback
   ```
7. Click **Create** and note:
   - **Client ID**
   - **Client Secret**

#### Step 2: Configure the OAuth Consent Screen

1. Go to **OAuth consent screen**
2. User Type: **Internal** (if using Google Workspace)
3. App name: `WalaPlus QMS`
4. User support email: your IT email
5. Scopes: Add `openid`, `email`, `profile`
6. Click **Save**

#### Step 3: Provide These Values

| Value | Where to Set |
|-------|-------------|
| **Client ID** | `GOOGLE_CLIENT_ID` secret |
| **Client Secret** | `GOOGLE_CLIENT_SECRET` secret |

### Required OAuth Scopes

```
openid
email
profile
```

WalaPlus only reads the user's name, email, and profile picture for authentication. No Gmail, Drive, or other data is accessed.

---

## Section 5: Environment Variables Summary

All secrets should be set as environment variables (never hardcoded). Here is the complete list:

### Zoho CRM (Required for CRM Audits)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `ZOHO_CLIENT_ID` | Yes | OAuth Client ID from Zoho API Console | `1000.ABCDEFGHIJKLMNOP` |
| `ZOHO_CLIENT_SECRET` | Yes | OAuth Client Secret | `abcdef1234567890...` |
| `ZOHO_REFRESH_TOKEN` | Yes | OAuth Refresh Token (permanent) | `1000.xxxx.yyyy` |
| `ZOHO_ACCOUNTS_URL` | No | Zoho accounts URL (defaults to US) | `https://accounts.zoho.com` |
| `ZOHO_API_DOMAIN` | No | Zoho API domain (defaults to US) | `https://www.zohoapis.com` |

### Five9 (Required for Call Intelligence)

Five9 credentials are stored in the platform database (via `/api/calls/five9/configure`), not as environment variables.

| Configuration | Required | Description |
|--------------|----------|-------------|
| `domain` | Yes | Five9 domain | 
| `username` | Yes | Five9 API username |
| `password` | Yes | Five9 API password |

### Google Calendar (Required for Meeting Audits)

Configured via Replit Connectors (recommended) or:

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_EMAIL` | If self-hosted | Service account email |

### Google OAuth Login (Required for SSO)

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret |

### Platform (Already Configured)

| Variable | Description |
|----------|-------------|
| `ADMIN_API_KEY` | Admin access key for platform management |
| `DATABASE_URL` | PostgreSQL connection string (Neon) |
| `SESSION_SECRET` | Session encryption key |

---

## Section 6: Testing & Verification

### Verify Zoho CRM Connection

```
GET /api/integrations/status
X-Admin-Key: YOUR_ADMIN_KEY
```

Response when configured:
```json
{
  "zoho": {
    "configured": true,
    "autoRefresh": true,
    "tokenCached": true,
    "tokenExpired": false,
    "message": "Zoho CRM configured with OAuth auto-refresh"
  }
}
```

### Verify Zoho Data Access

```
GET /api/zoho/records?module=Leads&page=1&per_page=5
X-Admin-Key: YOUR_ADMIN_KEY
```

This should return Leads from your Zoho CRM.

### Verify Five9 Connection

```
POST /api/calls/five9/test
Content-Type: application/json

{
  "domain": "app.five9.com",
  "username": "your-api-user",
  "password": "your-password"
}
```

### Verify Google Calendar

After connecting via Replit Connectors or service account:

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

### Zoho CRM

| Issue | Cause | Solution |
|-------|-------|----------|
| `CRM integration not configured` | Missing env vars | Set `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| `Failed to refresh Zoho access token: 401` | Invalid refresh token | Re-generate refresh token (Step 2) |
| `Failed to refresh Zoho access token: 400` | Wrong client ID/secret | Verify credentials in Zoho API Console |
| Empty records returned | No module access | Check Zoho user profile has read access to modules |
| `INVALID_TOKEN` error | Refresh token revoked | Re-generate from Zoho API Console |

### Five9

| Issue | Cause | Solution |
|-------|-------|----------|
| `Five9 not configured` | Configuration not saved | Run `/api/calls/five9/configure` with credentials |
| Connection test fails | Wrong credentials/domain | Verify Five9 API user has Reporting permissions |
| No calls synced | API user lacks permissions | Ensure Recording Access and VCC permissions |

### Google Calendar

| Issue | Cause | Solution |
|-------|-------|----------|
| `Google Calendar not connected` | Replit Connector not set up | Connect via Replit Integrations panel |
| No events returned | Calendar not shared | Share calendars with service account email |
| `Calendar API error: 403` | API not enabled | Enable Google Calendar API in Cloud Console |

### Google OAuth Login

| Issue | Cause | Solution |
|-------|-------|----------|
| `Google OAuth not configured` | Missing env vars | Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |
| `redirect_uri_mismatch` | Wrong redirect URI | Add exact URI to Google Cloud Console |
| `invalid_client` | Wrong client ID/secret | Verify credentials |
| Login works but no access | User not in platform | Admin must approve the user's access request |

---

## Security Notes

1. **All credentials are stored as encrypted environment variables** — never in code or configuration files
2. **Zoho access is read-only** — WalaPlus cannot modify CRM data
3. **Google Calendar access is read-only** — WalaPlus cannot modify calendar events
4. **Five9 credentials are stored in encrypted database columns** — accessible only to admin-role users
5. **All API calls are made server-side** — no credentials are exposed to the browser
6. **OAuth tokens auto-refresh** — no manual token rotation needed for Zoho or Google
7. **Rate limiting is applied** — API calls to third-party services are throttled to prevent abuse

---

## Document Control

| Version | Date | Author | Description |
|---------|------|--------|-------------|
| 1.0 | March 24, 2026 | WalaPlus Platform Team | Initial integration setup guide |

**Distribution:** Zoho CRM Admin, Five9 Admin, Google Workspace Admin, WalaPlus Platform Team
