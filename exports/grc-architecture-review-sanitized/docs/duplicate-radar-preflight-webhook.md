# Duplicate Radar — Preflight Webhook

**Endpoint:** `POST /api/duplicates/preflight/check`
**Auth:** `x-admin-key` header (machine-to-machine)
**Purpose:** Stop duplicate records from entering CRMProvider CRM in the first place by checking each new lead / deal / contact / account BEFORE it's created.

Industry benchmark (Plauti, 2026): tenants that enable real-time prevention at the API/import layer see a **60% drop in duplicate-creation rate within 90 days**. The Duplicate Radar already detects duplicates *after* they land — this endpoint flips the workflow to detect them *before* they land.

---

## When to use it

Wire any system that creates CRMProvider records to call this endpoint first. Common integration points:

| Integration | Where to call |
|---|---|
| **CRMProvider CRM workflow** (before-insert webhook) | On Lead / Deal / Contact / Account `before_create` |
| **Web forms** (HubSpot, Webflow, custom) | Server-side form handler, before pushing to CRMProvider via API |
| **Marketing automation** (Marketo, Pardot, etc.) | The sync job that pushes leads to CRMProvider |
| **Bulk import scripts** | Before each row in your CSV→CRMProvider importer |
| **Sales-enablement tools** (Salesloft, Outreach) | The CRMProvider create-record action |

---

## Request

```http
POST /api/duplicates/preflight/check
Content-Type: application/json
x-admin-key: <YOUR_ADMIN_KEY>

{
  "domain": "<REDACTED_HOST>",
  "email": "<REDACTED_EMAIL>",
  "company_name": "Example Organization Co",
  "phone": "<REDACTED_PHONE>",
  "ref": "web-form-submission-12345"
}
```

**Required:** at least one of `domain`, `email`, `company_name`, or `phone`. The more signals you send, the more accurate the match.

| Field | Type | Notes |
|---|---|---|
| `domain` | string | Authoritative signal. Pass `<REDACTED_HOST>` (without protocol). |
| `email` | string | Domain is extracted automatically if `domain` not supplied. |
| `company_name` | string | Used for fuzzy name match when domain is absent. |
| `phone` | string | Normalised server-side; saves you from formatting. |
| `ref` | string | Optional client-side correlation id; echoed back unchanged. |

---

## Response

```json
{
  "success": true,
  "verdict": "block",
  "should_create": false,
  "ref": "web-form-submission-12345",
  "reason": "active_cs_customer",
  "suggested_action": "Do not push as a new lead — domain is an active CS customer. Route to the existing account owner.",
  "cluster_id": 42,
  "lifecycle_state": "adoption",
  "sector": "private",
  "owners": ["Sample User Alhumoud"],
  "arr_exposure": 50000
}
```

### `verdict` ladder

| Verdict | Meaning | `should_create` |
|---|---|---|
| `block` | Domain is an active Customer Success customer. Do NOT push as a new lead — route to the existing owner. | `false` |
| `review` | Domain churned within the sector cool-off window (180d private / 365d gov). CS must confirm before sales can re-engage. | `false` |
| `warn` | Domain churned past cool-off. Sales may re-engage — notify CS as a courtesy. | `true` |
| `duplicate` | Existing leads/deals exist for this domain but there's no active CS overlap. Create with caution + flag to the operator. | `true` |
| `pass` | Genuinely new — safe to create. | `true` |

### `should_create` shortcut

The boolean is the **simple yes/no answer** your integration can wire to its create action. False means "this record should not enter CRMProvider right now"; true means "go ahead." You're free to override based on your own policy (e.g. a marketing tool may want to log `review` and `duplicate` rows for analyst review rather than block them).

---

## Auth — `x-admin-key`

The endpoint uses the same admin-key middleware as `Sync Now`, `Mark Resolved`, and the cluster-merge actions. Set the header:

```
x-admin-key: <YOUR_ADMIN_KEY>
```

Treat the key as a secret — it grants write access to the radar. Rotate it via the standard env-variable workflow if it's ever exposed.

---

## Example: CRMProvider CRM workflow (Custom Function)

CRMProvider's workflow editor can fire a Custom Function on `Lead before_create`. Add the following Deluge:

```javascript
// CRMProvider Deluge — before-create gate on Leads
preflight_url = "<REDACTED_URL_SCHEME><your-HostingPlatform-deployment>.<REDACTED_HOST>/api/duplicates/preflight/check";
admin_key = "<REDACTED_SECRET>";

payload = Map();
payload.put("domain", lead.get("Company_Domain"));
payload.put("email",  lead.get("Email"));
payload.put("company_name", lead.get("Company"));
payload.put("ref",    "CRMProvider-lead-" + lead.get("id"));

response = invokeurl
[
  url: preflight_url
  type: POST
  parameters: payload.toString()
  headers: { "Content-Type": "application/json", "x-admin-key": admin_key }
];

if (response.get("should_create") == false)
{
  // Stop the create. Add a sales-task to route the lead to the existing owner.
  cancel = Map();
  cancel.put("status", "failure");
  cancel.put("message", "Duplicate Radar verdict: " + response.get("verdict") + " — " + response.get("suggested_action"));
  return cancel;
}
```

---

## Example: curl (server-to-server)

```bash
curl -X POST <REDACTED_URL_SCHEME><your-deployment>.<REDACTED_HOST>/api/duplicates/preflight/check \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ExampleOrg_ADMIN_KEY" \
  -d '{
    "domain": "<REDACTED_HOST>",
    "email": "<REDACTED_EMAIL>",
    "ref": "marketing-batch-2026-05-22-row-42"
  }'
```

---

## Example: Node.js / TypeScript

```typescript
async function shouldCreateLead(input: {
  domain?: string;
  email?: string;
  company_name?: string;
}): Promise<boolean> {
  const res = await fetch(
    "<REDACTED_URL_SCHEME><your-deployment>.<REDACTED_HOST>/api/duplicates/preflight/check",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": process.env.ExampleOrg_ADMIN_KEY!,
      },
      body: JSON.stringify({ ...input, ref: crypto.randomUUID() }),
    }
  );
  if (!res.ok) {
    // Fail open — log the error, allow create. Decide per integration
    // whether your default-allow is the right risk tolerance.
    console.warn("Preflight unavailable; defaulting to allow.");
    return true;
  }
  const data = await res.json();
  return data.should_create === true;
}
```

---

## Failure modes

| Status | When | Caller behaviour |
|---|---|---|
| `400` | Body wasn't JSON, or no identifying field provided. | Fix the payload — there's a developer bug, not a duplicate. |
| `401` | Missing / wrong `x-admin-key`. | Check the key rotation. |
| `500` | Internal error (DB unreachable, etc.). | **Decide your default-allow vs default-block policy.** For volume-sensitive systems (marketing forms) we recommend default-allow + retry. For high-trust paths (account creation) consider default-block. |

---

## How this complements the existing Preflight tab

The dashboard's **Preflight Check** tab takes a CSV / paste-in batch and shows a per-row verdict for operator review. This webhook does the same classification but exposed as a single-record, machine-to-machine call. They share the same `runPreflight()` helper — operators and webhook callers always see the same answer for the same input. If a stakeholder questions a webhook verdict, the operator can drop the same record into the Preflight tab and reproduce it.

---

## Related

- [CS-pipeline overlap classification](./duplicate-radar-cs-overlap.md) — the verdict ladder this webhook returns
- [CS lifecycle compliance](./duplicate-radar-cs-lifecycle.md) — the rules behind `block` / `review`
- Source: `src/utils/duplicateRadarPreflight.ts` (`runPreflight`, `shouldCreateForVerdict`)
