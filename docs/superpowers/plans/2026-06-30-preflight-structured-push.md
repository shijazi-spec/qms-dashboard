# Preflight Structured Push to Zoho — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four structured "push to Zoho" actions to the Preflight tab — re-engage churned clients as Deals under their existing Account, multi-contact companies as one Deal + contacts, brand-new companies as Account→Deal→Contact, and the rest as Leads — each dry-run-first and dedup-safe.

**Architecture:** A pure planner (`buildStructuredPushPlan`) classifies the preflight result rows into per-company groups and returns exactly what each action would create (accounts/deals/contacts or leads) plus a skipped list — fully unit-testable with no Zoho. A thin admin-gated endpoint executes the plan via batched `createZohoRecordsBulk` (Accounts → Contacts → Deals, or Leads) with id-mapping, dry-run preview, and an audit log. A Preflight-tab panel exposes the four buttons with live counts + number cells.

**Tech Stack:** TypeScript (Hono routes, node-postgres), Zoho CRM v2 helpers in `src/utils/zohoCRM.ts`, vanilla browser JS (`dashboard/js/duplicates-app.js`).

## Global Constraints

- **Deal target:** Layout `WalaPlus` id `5146753000000019023`, Pipeline `Standard (Corporates)`, Stage `New Deal`, Closing Date **blank**, Amount blank. Env-overridable: `PREFLIGHT_DEAL_LAYOUT_ID`, `PREFLIGHT_DEAL_PIPELINE`, `PREFLIGHT_DEAL_STAGE`.
- **Lead target:** Layout `WalaPlus` id `5146753000000091055`, Lead Status `New Lead`. Env-overridable: `PREFLIGHT_LEAD_LAYOUT_ID`, `PREFLIGHT_LEAD_STATUS`.
- **Contact handling:** create a real Contact, link to the Account (`Account_Name`), set the first contact as the Deal's `Contact_Name`.
- **Dedup:** one Account + one Deal per distinct (normalized) company; PASS-only for new-company actions; top-down split so a row is pushed once.
- **Safety:** admin-gated (`requireAdminOrKey`); dry-run by default; per-record Zoho write-status checked (HTTP 200 ≠ success — read `data[i].code/status`); create-only (never edit/delete); one `event_logs` audit row per real push.
- **Verification gates (run before each commit):** `node node_modules/typescript/bin/tsc --noEmit`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit`; `node scripts/check-dashboard-html-js.mjs`; `node --check dashboard/js/duplicates-app.js`; JSON parse of both i18n files. Co-located `*.test.ts` run via the `tsc --noCheck` → `/tmp` → `node` trick with `NODE_PATH` set to the repo `node_modules` (see Task 2 Step 3).
- **Frontend cache:** bump `duplicates-app.js?v=N` in `dashboard/duplicates.html` on JS change.

## Row shape (input to the planner)

Each preflight result row the frontend sends carries (with fallbacks):
- `row_index: number`
- `company` = `r.input?.company_name ?? r.company_name ?? ""`
- `domain` = `r.input?.domain ?? r.domain ?? ""`
- `email` = `r.email ?? ""`, `phone` = `r.phone ?? ""`, `contact_name` = `r.contact_name ?? r.input?.contact_name ?? ""`
- `verdict: "pass"|"block"|"review"|"duplicate"|"warn"|"no_contact"`
- `cluster_id: number|null` (matched cluster), `lifecycle_state: string|null`

## Company grouping & action pools (the rules)

Normalize a company key: `String(company||domain||"").trim().toLowerCase()`. Group rows by that key. Classify each **group**:
- **A1 (re-engage churned):** any row in the group has `lifecycle_state === "termination_old"` AND `cluster_id != null` → the company is a churned-past-cool-off existing client. Push a Deal under its existing Account.
- **A2 (multi-contact new company):** all rows unmatched (`cluster_id == null` for every row), `verdict === "pass"`, and the group has **≥2** rows that carry a contact (email OR phone OR contact_name). Push one Deal + all contacts, creating the Account.
- **A3/A4 (single-contact new company):** all rows unmatched, `verdict === "pass"`, group has exactly **1** contact row. This shared pool is ordered by `row_index`; action 3 takes the first N, action 4 the next M.
- Everything else (active-client `block`, `duplicate`, `review`, `no_contact`, protected) is **not pushable** → listed in `skipped` with a reason.

A "contact row" = a row with at least one of email/phone/contact_name.

---

### Task 1: Deal/Lead constants + matched-account resolver

**Files:**
- Create: `src/utils/preflightStructuredPush.ts`
- Modify: `src/utils/duplicateRadarDatabase.ts` (add `getAccountZohoIdByCluster`)
- Test: `src/utils/preflightStructuredPush.test.ts`

**Interfaces:**
- Produces: `PREFLIGHT_DEAL_TARGET` (`{ layoutId, pipeline, stage }`), `PREFLIGHT_LEAD_TARGET` (`{ layoutId, status }`), and `export async function getAccountZohoIdByCluster(clusterId: number): Promise<string | null>`.

- [ ] **Step 1: Write the resolver test** — append to `src/utils/preflightStructuredPush.test.ts` (create file with the plain-assert harness header copied from `src/utils/emptyRecordsDetection.test.ts` lines 1–20). The resolver is DB-backed (integration), so only assert the constants here:

```ts
import assert from "node:assert";
import { PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET } from "./preflightStructuredPush";
assert(PREFLIGHT_DEAL_TARGET.layoutId === "5146753000000019023", "deal layout id default");
assert(PREFLIGHT_DEAL_TARGET.pipeline === "Standard (Corporates)", "deal pipeline default");
assert(PREFLIGHT_DEAL_TARGET.stage === "New Deal", "deal stage default");
assert(PREFLIGHT_LEAD_TARGET.layoutId === "5146753000000091055", "lead layout id default");
assert(PREFLIGHT_LEAD_TARGET.status === "New Lead", "lead status default");
console.log("preflightStructuredPush constants ok");
```

- [ ] **Step 2: Run, expect FAIL** (module not found):
```
rm -rf /tmp/psp && node node_modules/typescript/bin/tsc src/utils/preflightStructuredPush.ts src/utils/preflightStructuredPush.test.ts --outDir /tmp/psp --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --noCheck && NODE_PATH='D:\2_QMS Platform\qms-dashboard\node_modules' node /tmp/psp/utils/preflightStructuredPush.test.js
```

- [ ] **Step 3: Add constants** to `src/utils/preflightStructuredPush.ts`:
```ts
export const PREFLIGHT_DEAL_TARGET = {
  layoutId: process.env.PREFLIGHT_DEAL_LAYOUT_ID || "5146753000000019023",
  pipeline: process.env.PREFLIGHT_DEAL_PIPELINE || "Standard (Corporates)",
  stage: process.env.PREFLIGHT_DEAL_STAGE || "New Deal",
};
export const PREFLIGHT_LEAD_TARGET = {
  layoutId: process.env.PREFLIGHT_LEAD_LAYOUT_ID || "5146753000000091055",
  status: process.env.PREFLIGHT_LEAD_STATUS || "New Lead",
};
```

- [ ] **Step 4: Add the resolver** to `src/utils/duplicateRadarDatabase.ts` (near `isPlaceholderName`):
```ts
/** The Zoho id of the (primary) Account record inside a matched cluster — used to
 * put a re-engagement Deal under the company we already have. Null if the cluster
 * has no account record. */
export async function getAccountZohoIdByCluster(clusterId: number): Promise<string | null> {
  if (!Number.isFinite(clusterId)) return null;
  const r = await pool.query(
    `SELECT zoho_record_id FROM duplicate_records
       WHERE cluster_id = $1 AND record_type = 'account'
         AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
       ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
       LIMIT 1`,
    [clusterId],
  );
  return r.rows[0]?.zoho_record_id ? String(r.rows[0].zoho_record_id) : null;
}
```

- [ ] **Step 5: Run, expect PASS** (same command as Step 2). Then gates + commit:
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit
git add src/utils/preflightStructuredPush.ts src/utils/preflightStructuredPush.test.ts src/utils/duplicateRadarDatabase.ts
git commit -m "feat(preflight): deal/lead targets + getAccountZohoIdByCluster resolver"
```

---

### Task 2: The pure planner `buildStructuredPushPlan`

**Files:**
- Modify: `src/utils/preflightStructuredPush.ts`
- Test: `src/utils/preflightStructuredPush.test.ts`

**Interfaces:**
- Consumes: `PREFLIGHT_DEAL_TARGET`, `PREFLIGHT_LEAD_TARGET`.
- Produces:
```ts
export interface SPRow { row_index: number; company: string; domain: string; email: string; phone: string; contact_name: string; verdict: string; cluster_id: number | null; lifecycle_state: string | null; }
export interface SPCompany { companyKey: string; companyName: string; domain: string; clusterId: number | null; contacts: SPRow[]; }
export interface StructuredPushPlan {
  action: 1 | 2 | 3 | 4;
  companies: SPCompany[];   // for 1/2/3 — one entry per company (one Account+Deal)
  leads: SPRow[];           // for 4 — one entry per row
  eligible_count: number;   // companies (1/2/3) or leads (4)
  contact_count: number;    // total contacts across companies (1/2/3) or = leads.length (4)
  skipped: Array<{ row_index: number; reason: string }>;
}
export function normalizeCompanyKey(company: string, domain: string): string;
export function buildStructuredPushPlan(action: 1|2|3|4, rows: SPRow[], opts: { count?: number }): StructuredPushPlan;
```
The planner is PURE (no Zoho/DB). `getAccountZohoIdByCluster` is called by the endpoint (Task 3), NOT here — the planner only carries `clusterId` through.

- [ ] **Step 1: Write the failing tests** — append to `src/utils/preflightStructuredPush.test.ts`:

```ts
import { buildStructuredPushPlan, normalizeCompanyKey } from "./preflightStructuredPush";
const mk = (o: Partial<any>): any => ({ row_index: 0, company: "", domain: "", email: "", phone: "", contact_name: "", verdict: "pass", cluster_id: null, lifecycle_state: null, ...o });

// normalizeCompanyKey
assert(normalizeCompanyKey("  Acme  Co ", "") === "acme  co", "company key trims+lowercases");
assert(normalizeCompanyKey("", "Acme.com") === "acme.com", "falls back to domain");

// A1 — churned past cool-off, matched → one company entry, carries clusterId
{
  const rows = [mk({ row_index: 1, company: "Churn Co", email: "a@churn.co", verdict: "pass", cluster_id: 9, lifecycle_state: "termination_old" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assert(p.companies.length === 1 && p.companies[0].clusterId === 9, "A1 picks churned-matched company");
  assert(p.eligible_count === 1 && p.contact_count === 1, "A1 counts");
}
// A1 ignores a non-churned matched row
{
  const rows = [mk({ row_index: 1, company: "Active Co", email: "a@x.co", verdict: "block", cluster_id: 5, lifecycle_state: "onboarding" })];
  const p = buildStructuredPushPlan(1, rows, {});
  assert(p.companies.length === 0 && p.skipped.length === 1, "A1 skips active client");
}
// A2 — new company with 2 contacts → one company, 2 contacts
{
  const rows = [
    mk({ row_index: 1, company: "New Multi", email: "a@nm.co" }),
    mk({ row_index: 2, company: "New Multi", phone: "+966500000000" }),
  ];
  const p = buildStructuredPushPlan(2, rows, {});
  assert(p.companies.length === 1 && p.companies[0].contacts.length === 2, "A2 groups 2 contacts into one company");
}
// A2 ignores a single-contact company
{
  const rows = [mk({ row_index: 1, company: "Solo Co", email: "a@solo.co" })];
  const p = buildStructuredPushPlan(2, rows, {});
  assert(p.companies.length === 0, "A2 excludes single-contact company");
}
// A3/A4 — single-contact new companies, top-down split by count
{
  const rows = [
    mk({ row_index: 1, company: "S1", email: "a@s1.co" }),
    mk({ row_index: 2, company: "S2", email: "a@s2.co" }),
    mk({ row_index: 3, company: "S3", email: "a@s3.co" }),
  ];
  const a3 = buildStructuredPushPlan(3, rows, { count: 2 });
  assert(a3.companies.length === 2 && a3.companies[0].companyName === "S1" && a3.companies[1].companyName === "S2", "A3 takes first 2");
  const a4 = buildStructuredPushPlan(4, rows, { count: 2 });
  assert(a4.leads.length === 1 && a4.leads[0].company === "S3", "A4 takes the next 1 after A3's first 2");
}
console.log("buildStructuredPushPlan ok");
```

- [ ] **Step 2: Run, expect FAIL** (function not defined) — same compile+run command as Task 1 Step 2.

- [ ] **Step 3: Implement the planner** in `src/utils/preflightStructuredPush.ts`:

```ts
export interface SPRow { row_index: number; company: string; domain: string; email: string; phone: string; contact_name: string; verdict: string; cluster_id: number | null; lifecycle_state: string | null; }
export interface SPCompany { companyKey: string; companyName: string; domain: string; clusterId: number | null; contacts: SPRow[]; }
export interface StructuredPushPlan { action: 1 | 2 | 3 | 4; companies: SPCompany[]; leads: SPRow[]; eligible_count: number; contact_count: number; skipped: Array<{ row_index: number; reason: string }>; }

export function normalizeCompanyKey(company: string, domain: string): string {
  return String(company || domain || "").trim().toLowerCase();
}
function hasContact(r: SPRow): boolean {
  return !!(String(r.email || "").trim() || String(r.phone || "").trim() || String(r.contact_name || "").trim());
}
function groupByCompany(rows: SPRow[]): SPCompany[] {
  const map = new Map<string, SPCompany>();
  for (const r of rows) {
    const key = normalizeCompanyKey(r.company, r.domain);
    if (!key) continue;
    let g = map.get(key);
    if (!g) { g = { companyKey: key, companyName: r.company || r.domain || key, domain: r.domain || "", clusterId: r.cluster_id ?? null, contacts: [] }; map.set(key, g); }
    if (r.cluster_id != null && g.clusterId == null) g.clusterId = r.cluster_id;
    g.contacts.push(r);
  }
  // Stable order by the smallest row_index in each group.
  return Array.from(map.values()).sort((a, b) => Math.min(...a.contacts.map(c => c.row_index)) - Math.min(...b.contacts.map(c => c.row_index)));
}

export function buildStructuredPushPlan(action: 1 | 2 | 3 | 4, rows: SPRow[], opts: { count?: number }): StructuredPushPlan {
  const skipped: Array<{ row_index: number; reason: string }> = [];
  const groups = groupByCompany(rows);
  const isChurnedMatched = (g: SPCompany) => g.contacts.some(r => r.lifecycle_state === "termination_old" && r.cluster_id != null);
  const isNewPass = (g: SPCompany) => g.contacts.every(r => r.cluster_id == null) && g.contacts.every(r => r.verdict === "pass");
  const contactRows = (g: SPCompany) => g.contacts.filter(hasContact);

  if (action === 1) {
    const companies = groups.filter(isChurnedMatched);
    groups.filter(g => !isChurnedMatched(g)).forEach(g => g.contacts.forEach(r => skipped.push({ row_index: r.row_index, reason: "not_churned_past_cooloff" })));
    return { action, companies, leads: [], eligible_count: companies.length, contact_count: companies.reduce((n, g) => n + g.contacts.length, 0), skipped };
  }
  if (action === 2) {
    const companies = groups.filter(g => !isChurnedMatched(g) && isNewPass(g) && contactRows(g).length >= 2)
      .map(g => ({ ...g, contacts: contactRows(g) }));
    return { action, companies, leads: [], eligible_count: companies.length, contact_count: companies.reduce((n, g) => n + g.contacts.length, 0), skipped };
  }
  // A3/A4 share the single-contact-new pool, ordered by row_index.
  const singleNew = groups.filter(g => !isChurnedMatched(g) && isNewPass(g) && contactRows(g).length === 1)
    .map(g => ({ ...g, contacts: contactRows(g) }));
  const n = Math.max(0, Math.floor(opts.count ?? 0));
  if (action === 3) {
    const companies = singleNew.slice(0, n);
    return { action, companies, leads: [], eligible_count: companies.length, contact_count: companies.length, skipped };
  }
  // action === 4 — the NEXT M after action 3's slice. The caller passes count = M and
  // also passes opts via a second field? No: the frontend computes the offset and passes
  // already-sliced rows is messy; instead action 4 takes count = M and an offset.
  const offset = Math.max(0, Math.floor((opts as any).offset ?? 0));
  const leads = singleNew.slice(offset, offset + n).flatMap(g => g.contacts);
  return { action, companies: [], leads, eligible_count: leads.length, contact_count: leads.length, skipped };
}
```
Note: extend `opts` type to `{ count?: number; offset?: number }` (action 4 uses `offset` = the N already taken by action 3). Update the interface signature accordingly.

- [ ] **Step 4: Run, expect PASS** (same command). Fix the A4 test to pass `offset`:
  the A4 assertion should call `buildStructuredPushPlan(4, rows, { count: 1, offset: 2 })` and expect `leads[0].company === "S3"`. Update the test in Step 1 to pass `{ count: 1, offset: 2 }` and adjust the comment.

- [ ] **Step 5: Gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit
git add src/utils/preflightStructuredPush.ts src/utils/preflightStructuredPush.test.ts
git commit -m "feat(preflight): pure buildStructuredPushPlan (company grouping, A1-A4 pools, dedup, split)"
```

---

### Task 3: The `/preflight/structured-push` endpoint (executes the plan)

**Files:**
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (add the route, near the existing `/preflight/push-to-zoho` at ~line 8296)

**Interfaces:**
- Consumes: `buildStructuredPushPlan`, `getAccountZohoIdByCluster`, `PREFLIGHT_DEAL_TARGET`, `PREFLIGHT_LEAD_TARGET`, `createZohoRecordsBulk` (`(module, records[]) => Promise<Array<{status:'success'|'error', id?, code, details}>>`), `requireAdminOrKey`, `logEvent`.

- [ ] **Step 1: Read** the existing `/api/duplicates/preflight/push-to-zoho` handler (`duplicateRadarRoutes.ts:8296-8470`) for the admin-gate, owner-mode, source, dry-run, audit, and route-object conventions. Mirror them exactly.

- [ ] **Step 2: Add the route** `POST /api/duplicates/preflight/structured-push`. Body: `{ action: 1|2|3|4, rows: SPRow[], count?: number, offset?: number, dry_run?: boolean, owner_mode?: 'self'|'custom'|'round_robin', owner_id?: string, round_robin_user_ids?: string[], source?: string }`. Logic:
  - Admin-gate; default `dryRun = body.dry_run !== false`; build the plan: `const plan = buildStructuredPushPlan(action, rows, { count, offset })`.
  - For actions 1/2: for each company, resolve the account id — A1 uses `await getAccountZohoIdByCluster(company.clusterId)`; if null for A1, move the company to `skipped` (reason `no_matched_account`). A2 has no existing account → mark for creation. A3 always creates the account.
  - **Build payloads** (deal/account/contact use `PREFLIGHT_DEAL_TARGET`; lead uses `PREFLIGHT_LEAD_TARGET`):
    - Account: `{ Account_Name: company.companyName, Layout: { id: DEAL.layoutId }, ...(domain ? { Website: domain.startsWith('http') ? domain : 'https://'+domain } : {}) }`
    - Contact: `{ Last_Name: contact_name || company.companyName, ...(email?{Email:email}:{}) , ...(phone?{Phone:phone}:{}), Account_Name: { id: accountId } }` (accountId from the matched/created account)
    - Deal: `{ Deal_Name: company.companyName + ' — ' + tag, Stage: DEAL.stage, Pipeline: DEAL.pipeline, Layout: { id: DEAL.layoutId }, Account_Name: { id: accountId }, Contact_Name: { id: firstContactId } }` where `tag` = `Re-engagement` (A1) / `Preflight import` (A2/A3). No `Closing_Date`, no `Amount`.
    - Lead (A4): same payload as the existing push PLUS `Layout: { id: LEAD.layoutId }`, `Lead_Status: LEAD.status`, `Last_Name: contact_name || company || domain`, `First_Name`? (leave unset), Email/Phone/Website/Lead_Source/Owner as today.
  - **Dry-run:** return `{ success:true, dry_run:true, action, eligible_count, contact_count, would: { accounts, contacts, deals, leads }, sample_payload, skipped_count, skipped_sample }` — NO Zoho calls.
  - **Real run (ordered, id-mapped):**
    1. A2/A3 accounts: `const accOut = await createZohoRecordsBulk('Accounts', accountPayloads)` → map `companyKey → accOut[i].id` (A1 uses the resolved existing id).
    2. Contacts: build with the right `accountId`, `const conOut = await createZohoRecordsBulk('Contacts', contactPayloads)` → map row→contactId; first contact per company → `firstContactId`.
    3. Deals: build with `accountId` + `firstContactId`, `const dealOut = await createZohoRecordsBulk('Deals', dealPayloads)`.
    4. A4: `const leadOut = await createZohoRecordsBulk('Leads', leadPayloads)`.
    - Count `created`/`failed` per type from each outcome's `status`. A per-record `error` is reported, not thrown.
  - **Audit:** `logEvent({ actionType: 'PUSH_TO_ZOHO', entityType: action===4?'Leads':'Deals', description: 'Preflight structured push (action N): created A accounts, C contacts, D deals / L leads (F failed).', module: 'duplicate-radar', ... })`.
  - Return `{ success:true, dry_run:false, action, created: { accounts, contacts, deals, leads }, failed, skipped_count, outcomes_sample }`.

- [ ] **Step 3: Gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit
git add src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(preflight): structured-push endpoint (Account->Contact->Deal / Lead, dry-run, audit)"
```

---

### Task 4: Frontend — the "Structured push to Zoho" panel

**Files:**
- Modify: `dashboard/duplicates.html` (panel markup under the preflight push controls; bump `?v=`)
- Modify: `dashboard/js/duplicates-app.js` (store ALL preflight rows; `erStructuredPush(action)` handler)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json` (labels)

**Interfaces:**
- Consumes: `POST /api/duplicates/empty-records` admin-post helper pattern (reuse the preflight push's `fetch` + admin handling at `duplicates-app.js:10759`).

- [ ] **Step 1: Store all rows.** At `duplicates-app.js:10677` (where `window._preflightPushPassRows = passRows`), also set `window._preflightAllRows = <the full result rows array>` (the variable holding every classified row, including its `cluster_id`, `lifecycle_state`, `contact_name`, `email`, `phone`). Confirm the merge includes `contact_name` from the original input (merge input rows by `row_index` if the result doesn't echo it).

- [ ] **Step 2: Panel markup** in `dashboard/duplicates.html`, directly after the existing push buttons block. Four rows; each: a label (`data-i18n`), a live count span (`id="spCount-1..4"`), for rows 3 & 4 a `<input type="number" id="spNum-3/4" min="0" class="w-20 ...">`, a dry-run checkbox (`id="spDry-1..4"` checked), a button `data-on-click="erStructuredPush" data-args="[1]"` … `[4]`, and a result span (`id="spResult-1..4"`). Add i18n keys `pf_sp_title`, `pf_sp_a1`, `pf_sp_a2`, `pf_sp_a3`, `pf_sp_a4`, `pf_sp_push`, `pf_sp_dry` to en + ar.

- [ ] **Step 3: Counts + handler** in `duplicates-app.js`. On preflight result render, compute each action's eligible count client-side by calling a tiny mirror of the pool rules (or call the endpoint in dry-run on demand). Simplest: `erStructuredPush(action)`:
  - Map `window._preflightAllRows` → `SPRow[]` (the field fallbacks from the plan's "Row shape").
  - For action 4, `offset` = the number entered in `spNum-3` (so 4 starts after 3's slice); `count` = `spNum-4`. For action 3, `count` = `spNum-3`.
  - POST `/api/duplicates/preflight/structured-push` with `{ action, rows, count, offset, dry_run: spDry checked, owner_mode:'self', source }` via the same admin-aware fetch the existing push uses.
  - Render the dry-run preview (would-create counts + skipped) or the real-run result (created/failed) into `spResult-<action>`; disable the button + spinner while running.
- Bump `duplicates-app.js?v=` in `dashboard/duplicates.html`.

- [ ] **Step 4: Gates + commit:**
```
node --check dashboard/js/duplicates-app.js && node scripts/check-dashboard-html-js.mjs && node -e "JSON.parse(require('fs').readFileSync('dashboard/i18n/en.json','utf8'));JSON.parse(require('fs').readFileSync('dashboard/i18n/ar.json','utf8'))"
git add dashboard/duplicates.html dashboard/js/duplicates-app.js dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(preflight): Structured push panel (4 actions, counts, number cells, dry-run)"
```

---

### Task 5: Teach Adam + final verification

**Files:**
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (extend the preflight tool note #30 — NO backticks in the template literal)

- [ ] **Step 1:** Append to note #30 that the Preflight tab can now structured-push cleared rows into Zoho four ways — re-engage churned-past-cool-off clients as Deals under their existing Account; multi-contact companies as one Deal + contacts; new companies as Account→Deal→Contact (WalaPlus / Standard Corporates / New Deal); and the rest as Leads (WalaPlus / New Lead) — each dry-run-first, dedup-safe, admin-gated, create-only. No backticks.

- [ ] **Step 2: Full gate run + commit + push:**
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit && node scripts/check-dashboard-html-js.mjs && node --check dashboard/js/duplicates-app.js
git add src/mastra/agents/qmsConsultantAgent.ts
git commit -m "docs(adam): teach the preflight structured push actions"
git push
```

- [ ] **Step 3: Manual smoke (post-republish):** On the Preflight tab, paste a small list, Check, then for EACH action run **dry-run first** (confirm the would-create counts + sample payload), then a single real test record, and verify in Zoho the Account/Deal/Contact (or Lead) appear on the right layout/pipeline/stage with the contact linked.

---

## Self-Review

**Spec coverage:** deal target (Global Constraints + Task 1) ✓ · lead target (Task 1/3) ✓ · clean Account→Deal→Contact (Task 3) ✓ · A1 re-engage under existing account (Task 2/3, `getAccountZohoIdByCluster`) ✓ · A2 multi-contact (Task 2) ✓ · A3/A4 top-down split (Task 2, count+offset) ✓ · dedup by company + PASS-only (Task 2) ✓ · dry-run-first + per-record status + audit + admin (Task 3) ✓ · UI counts + number cells (Task 4) ✓ · blank closing date (Task 3 omits Closing_Date) ✓ · Adam (Task 5) ✓.

**Type consistency:** `SPRow`/`SPCompany`/`StructuredPushPlan` defined in Task 2, consumed in Task 3/4. `getAccountZohoIdByCluster` defined Task 1, used Task 3. `buildStructuredPushPlan(action, rows, {count, offset})` signature consistent Task 2↔3↔4. Deal/Lead target object shapes consistent.

**Open confirmation for the implementer (resolve by reading code, not guessing):** the exact frontend variable holding the full preflight result rows (Task 4 Step 1) and whether it echoes `contact_name`/`email`/`phone` — read `duplicates-app.js` around the preflight render (~line 10600-10680) before wiring.
