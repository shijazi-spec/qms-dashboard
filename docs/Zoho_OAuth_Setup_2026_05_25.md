# Zoho OAuth Self Client — Setup for WalaPlus QMS Dashboard

**Audience:** Zoho admin (someone with admin rights at api-console.zoho.com)
**Time required:** ~10 minutes
**One-time only** — once the 3 secrets land in Replit, every Zoho-dependent feature in the platform (auto-link, CRM compliance, activity timeline, lead history, duplicate radar, Zoho Calls import) starts working.

---

## What this fixes

Today every Zoho-touching feature returns `no_zoho` because these env vars are absent from the deployment:

- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`

Without them the platform cannot:
- Auto-link calls to Leads/Deals
- Run CRM compliance checks (Notes / Calls / Tasks / Events)
- Load the Activity Timeline
- Query Zoho from any other module in the same Replit project

---

## Step 1 — Create a Zoho Self Client (~3 min)

1. Open **[https://api-console.zoho.com](https://api-console.zoho.com)** in a new tab. Sign in with a Zoho admin account.
2. Click **GET STARTED** (or **Add Client** if you already have apps).
3. Choose **"Self Client"**. This is a server-to-server credential type with no UI redirect, ideal for a backend dashboard.

   > ⚠️ Don't pick "Server-based Applications" — that's for apps with a web redirect flow, which the Replit deployment doesn't have.

4. Click **CREATE NOW** → on the confirmation, click **OK**. You'll land on a page with two values:
   - **Client ID** (looks like `1000.ABC123XYZ456...`)
   - **Client Secret** (looks like `a1b2c3d4e5f6...`)

5. Click the small **"copy"** icon next to each and save them somewhere safe (password manager). You'll paste them into Replit in Step 4.

---

## Step 2 — Generate an authorisation code (~2 min)

Still inside your new Self Client app:

1. Switch to the **"Generate Code"** tab (next to "Client Secret").
2. **Scope** — paste this exactly (read-only access, no write permissions):
   ```
   ZohoCRM.modules.READ,ZohoCRM.users.READ,ZohoCRM.notifications.READ,ZohoCRM.settings.READ
   ```
3. **Time Duration**: pick **10 minutes** (Zoho's max for Self Client).
4. **Scope Description**: type *"WalaPlus QMS Dashboard read-only access"* (free-text, just for audit log).
5. Click **CREATE**.
6. A modal pops up showing a code (long string starting with `1000.`). **Copy it immediately** — you have ~10 min before it expires, and Zoho will never show it again.

---

## Step 3 — Exchange the code for a refresh_token (~1 min)

Open a terminal (any machine, including the Replit Shell) and run this. **Replace the three values** with what you copied in Steps 1 + 2:

```bash
curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=PASTE_YOUR_REAL_CLIENT_ID_HERE" \
  -d "client_secret=PASTE_YOUR_REAL_CLIENT_SECRET_HERE" \
  -d "code=PASTE_THE_CODE_FROM_STEP_2_HERE"
```

> 🛑 The strings `PASTE_YOUR_REAL_CLIENT_ID_HERE` etc. are placeholders. Substitute them with the actual values. If you run it verbatim you'll get `{"error":"invalid_client"}`.

**Expected response (success):**
```json
{
  "access_token": "1000.aaa.bbb",
  "refresh_token": "1000.ccc.ddd",
  "scope": "ZohoCRM.modules.READ ZohoCRM.users.READ ...",
  "api_domain": "https://www.zohoapis.com",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

**The value you want is `refresh_token`.** It does not expire — store it like a password.

**Common errors and fixes:**

| Error JSON | Cause | Fix |
|---|---|---|
| `{"error":"invalid_client"}` | Wrong client_id or client_secret | Double-check both, no leading/trailing spaces |
| `{"error":"invalid_code"}` | Code expired (>10 min) or already used (one-shot) | Repeat Step 2 to generate a fresh code |
| `{"error":"invalid_grant"}` | Wrong `grant_type` | Must be exactly `authorization_code`, not `refresh_token` |
| HTML response instead of JSON | Wrong region URL | If your Zoho is `.eu`/`.in`/`.sa`, change `accounts.zoho.com` to `accounts.zoho.eu` etc. |

---

## Step 4 — Add the 3 secrets to Replit (~2 min)

1. In Replit, with **qms-dashboard** open, click **Tools → Secrets** in the left sidebar (lock-icon).
2. Click **+ New Secret** three times, adding each of these:

   | Key | Value (from earlier) |
   |---|---|
   | `ZOHO_CLIENT_ID` | The Client ID from Step 1 |
   | `ZOHO_CLIENT_SECRET` | The Client Secret from Step 1 |
   | `ZOHO_REFRESH_TOKEN` | The `refresh_token` from Step 3 response |

3. **Optional** — only if your Zoho org is in a non-US region:
   - `ZOHO_ACCOUNTS_URL` = `https://accounts.zoho.eu` (or `.in`, `.sa`, etc.)
   - `ZOHO_API_DOMAIN` = `https://www.zohoapis.eu` (or matching region)

   The default is `.com` (US data centre). For `org766568398` the platform is currently configured for `.com` — leave these blank unless you know your org migrated to another region.

4. **Republish** (top-right button). Replit reads secrets at deployment time, so a republish is mandatory — restarting the dev server is not enough.

---

## Step 5 — Verify (~1 min)

After the republish completes:

1. Open `https://qms-dashboard.replit.app/calls` in an **incognito window** (avoids cached state).
2. **Check the Overview tab.** The red banner *"Zoho CRM not connected"* should be **gone**.
3. **Open Replit → Tools → Shell** and run:
   ```bash
   curl -s https://qms-dashboard.replit.app/api/integrations/status | jq
   ```
   Expected:
   ```json
   {"zoho":{"connected":true,"message":"Connected"}, ...}
   ```
4. On the **CRM Compliance Breakdown** card, click **Backfill CRM Compliance**.
   - Watch the button label change to *"Backfilling… N checked, M newly linked"*.
   - At the end, the alert should show real numbers (e.g. *"45 newly linked, 23 compliance checks ran, 131 skipped (unlinkable)"*).
   - The 5 metric cards (Notes Updated / Call Logged / Task Created / Stage Updated / Fully Compliant) should populate with non-zero counts where applicable.

If any of these fail, paste the error from the dashboard or Replit logs and we'll debug.

---

## Security notes

- **Read-only scope** — the platform never writes back to Zoho. If the refresh_token ever leaks, an attacker can only read, not modify.
- **Treat `ZOHO_REFRESH_TOKEN` like a password.** Never commit it, never paste it in chat/screenshots/logs, never share via email.
- **Revoke if leaked.** Log into the Self Client app at api-console.zoho.com → "Generate Code" → repeat Step 2-3 to mint a fresh refresh_token, then update Replit Secrets and Republish. The old token stops working as soon as you regenerate.
- **Audit log.** Zoho logs every API call made with this credential under your admin account, traceable to `qms-dashboard.replit.app`.

---

## What happens after Zoho is connected

The dashboard will gain access to:

| Feature | How Zoho is used |
|---|---|
| Auto-link calls | Phone match across Leads + Deals modules to set `lead_id`/`deal_id` |
| CRM Compliance check | For each linked call, reads recent Notes / Calls / Tasks / Events on the Lead/Deal to verify SLA actions |
| Activity Timeline | Inside Call Details, lists everything the SDR did in Zoho after the call (notes, follow-up tasks, status changes) |
| Lead History | Per-Lead timeline of status transitions and ownership changes |
| Duplicate Radar | Flags overlapping Leads on the same phone/email across SDRs |
| Zoho Calls Import | Pulls Zoho's own Call module records into the dashboard for cross-reference |

All of these read from the same `getValidAccessToken()` helper, so once the 3 secrets are present every feature activates simultaneously.
