# Record Hint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single **Record Hint** tab that scans the whole CRM (from `duplicate_records`) for records missing a cross-module link and offers an inferred link + one-click apply — generalizing the existing Account Hints (Deal→Account) to also cover **Contact→Account** and **Deal→Contact**.

**Architecture:** Keep the live Account Hints *backend* (`accountInference.ts`, `account_inference_hints`, `/account-hints/*`) **untouched** — it becomes Section 1. Add ONE generic module `recordLinkHints.ts` + ONE generic table `record_link_hints` for the two NEW link types (Contact→Account, Deal→Contact), mirroring the Account Hints pattern (scan → infer → score → list → AI-resolve ≥70% → apply via `updateZohoRecord`).

**UI decision (Sarah):** *Rename* the existing **Account Hints** tab to **Record Hint** (do NOT add a new tab) and give it three sections: **Deal → Account** (the existing Account Hints, in place), **Contact → Account**, **Deal ↔ Contact**. The three linking pairings currently living as blue chips in the **Cross-Module** tab (`contact_account`, `contact_deal`, `deal_account`) are **removed from Cross-Module and represented here instead** — Record Hint is the "is the data wired together?" cycle. Cross-Module is then narrowed to its Lead-overlap / existing-client-CS / 3+-modules concerns and **re-reviewed as a whole in a separate follow-up cycle** (out of scope for this plan; flagged in Task 8).

**Tech Stack:** TypeScript (Node), Hono-style route objects, Postgres (`duplicate_records` jsonb `raw_data`), Zoho CRM v2 REST, vanilla dashboard JS (`duplicates-app.js`), tsx for pure tests.

## Global Constraints

- **Schema parity is STRICT** — every `ALTER TABLE … ADD COLUMN IF NOT EXISTS` must also appear in the canonical `CREATE TABLE IF NOT EXISTS` block in the same file. `npm run check:schema-parity` (STRICT=1 in CI) FAILS on drift. For a NEW table, define the full shape in one `CREATE TABLE` — no post-hoc ALTERs.
- **Platform NEVER deletes Zoho records.** Record Hint only *updates* a link field (`Account_Name` / `Contact_Name`) via `updateZohoRecord`. AI auto-resolve is gated at **confidence ≥ 70%** (env-overridable, matching Account Hints).
- **Zoho v2 writes return HTTP 200 even when REJECTED** — the truth is in `data[0].code/status`. `updateZohoRecord` already checks this; do not bypass it.
- **Confidence model matches Account Hints:** base **40** + evidence, **capped at 100**.
- **JS cache-bust:** bump `duplicates-app.js?v=NN` in `dashboard/duplicates.html` whenever `duplicates-app.js` changes.
- **Do not regress Account Hints** — `accountInference.ts`, `account_inference_hints`, and `/account-hints/*` stay as-is.
- **Gates for every task:** `npm run check` (tsc), the relevant pure test via `npx tsx`, `npm run check:html-js` (when HTML/JS changes), `npm run check:schema-parity` (when DDL changes). Full sweep: `npm run check:all`.

---

## File Structure

- **Create** `src/utils/recordLinkHints.ts` — generic inference + scan + list + AI-resolve for the two new link types. One responsibility: "records missing a cross-module link → suggested target + confidence + apply."
- **Create** `src/utils/recordLinkHints.test.ts` — pure unit tests (scoring + needs-help predicates + best-candidate selection) run via `npx tsx`.
- **Modify** `src/utils/duplicateRadarDatabase.ts` — add the `record_link_hints` `CREATE TABLE` in the boot-DDL block (next to `account_inference_hints`, ~line 1441).
- **Modify** `src/mastra/routes/duplicateRadarRoutes.ts` — add the `/record-hints/*` endpoints (mirror `/account-hints/*`, ~line 7866+).
- **Modify** `dashboard/duplicates.html` — RENAME the `tab-account-hints` label to "Record Hint"; add the Contact→Account and Deal↔Contact section containers under it; **remove** the `contact_account` / `contact_deal` / `deal_account` chip buttons from the Cross-Module tab; bump `?v=`.
- **Modify** `dashboard/js/duplicates-app.js` — evolve `renderAccountHints` into a 3-section `renderRecordHints` (Section 1 keeps the existing account-hints data path), add per-section scan/apply/dismiss handlers; drop the 3 removed pairings from the Cross-Module chip filter (`_cmoClusterMatchesChip`) + hide clusters classified as exactly those pairings.
- **Modify** `src/utils/duplicateRadarDatabase.ts` — in `getCrossModuleOverlaps`, exclude clusters whose pairing is `contact_account`/`contact_deal`/`deal_account` (now owned by Record Hint); keep `lead_*` and `mixed`.
- **Modify** `src/mastra/routes/duplicateRadarRoutes.ts` — drop those 3 from the cross-module pairing whitelist.
- **Modify** `src/mastra/tools/radarTabTools.ts` — extend the Adam tool to report the two new hint types (or add `recordHintsStatusTool`).

---

### Task 1: `record_link_hints` table (boot DDL)

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (add CREATE TABLE next to `account_inference_hints`, ~line 1455)
- Test: `scripts/check-schema-parity.mjs` (run, no new test file)

**Interfaces:**
- Produces: table `record_link_hints` with columns used by Task 2–4.

- [ ] **Step 1: Add the canonical CREATE TABLE** in the boot-DDL function that already creates `account_inference_hints`:

```sql
CREATE TABLE IF NOT EXISTS record_link_hints (
  id SERIAL PRIMARY KEY,
  source_record_id INT NOT NULL REFERENCES duplicate_records(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL,               -- 'contact' | 'deal'
  link_field VARCHAR(40) NOT NULL,                -- 'Account_Name' | 'Contact_Name'
  suggested_target_record_id INT REFERENCES duplicate_records(id) ON DELETE SET NULL,
  suggested_target_zoho_id VARCHAR(100),
  suggested_target_name TEXT,
  suggested_domain TEXT,
  evidence_record_id INT,
  evidence_detail TEXT,
  confidence INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',  -- 'pending' | 'dismissed' | 'applied'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_record_id, link_field, suggested_target_record_id)
);
CREATE INDEX IF NOT EXISTS idx_record_link_hints_status ON record_link_hints (status);
CREATE INDEX IF NOT EXISTS idx_record_link_hints_type ON record_link_hints (source_type, link_field);
```

- [ ] **Step 2: Verify schema parity**

Run: `npm run check:schema-parity`
Expected: PASS (no ALTER without matching CREATE; the whole shape is in one CREATE TABLE).

- [ ] **Step 3: Verify tsc**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts
git commit -m "feat(record-hint): add record_link_hints table (contact→account, deal→contact)"
```

---

### Task 2: Pure helpers — needs-help predicates + confidence scoring

**Files:**
- Create: `src/utils/recordLinkHints.ts`
- Test: `src/utils/recordLinkHints.test.ts`

**Interfaces:**
- Produces:
  - `contactNeedsAccount(raw: any): boolean`
  - `dealNeedsContact(raw: any): boolean`
  - `scoreLinkConfidence(a: { agreeing: number; explicitDomain: boolean; relatedRecords: number }): number`
  - `PLACEHOLDER_ACCOUNTS: Set<string>` (mirror the Account Hints placeholder set — empty / "-" / test names)

- [ ] **Step 1: Write the failing test** (`src/utils/recordLinkHints.test.ts`):

```ts
import { contactNeedsAccount, dealNeedsContact, scoreLinkConfidence } from "./recordLinkHints";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

// A Contact with no Account_Name needs an account hint.
ok(contactNeedsAccount({ Account_Name: null }) === true, "contact with null Account_Name needs account");
ok(contactNeedsAccount({ Account_Name: { id: "1", name: "Acme" } }) === false, "contact with an account does not");
ok(contactNeedsAccount({ Account_Name: { name: "-" } }) === true, "contact with placeholder account needs account");

// A Deal with no Contact_Name needs a contact hint.
ok(dealNeedsContact({ Contact_Name: null }) === true, "deal with null Contact_Name needs contact");
ok(dealNeedsContact({ Contact_Name: { id: "9", name: "Sara" } }) === false, "deal with a contact does not");

// Confidence: base 40 + evidence, capped 100.
ok(scoreLinkConfidence({ agreeing: 0, explicitDomain: false, relatedRecords: 0 }) === 40, "base 40");
ok(scoreLinkConfidence({ agreeing: 2, explicitDomain: true, relatedRecords: 3 }) === 100, "strong evidence caps at 100");
ok(scoreLinkConfidence({ agreeing: 1, explicitDomain: false, relatedRecords: 0 }) === 50, "one agreeing +10");

console.log(fail === 0 ? "recordLinkHints ok" : ("FAIL " + fail));
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx tsx src/utils/recordLinkHints.test.ts`
Expected: FAIL ("Cannot find module './recordLinkHints'").

- [ ] **Step 3: Implement the pure helpers** (`src/utils/recordLinkHints.ts`):

```ts
// Placeholder / non-real account labels (mirror accountInference.ts).
export const PLACEHOLDER_ACCOUNTS = new Set(["", "-", "n/a", "na", "none", "null", "unknown", "test"]);

const linkVal = (obj: any): { id?: string; name?: string } | null =>
  obj && typeof obj === "object" ? obj : null;

/** A Contact needs an Account when it has no Account_Name, or a placeholder one. */
export function contactNeedsAccount(raw: any): boolean {
  const acc = linkVal(raw?.Account_Name);
  if (!acc) return true;
  if (acc.id) return false;                       // a real linked account
  const nm = String(acc.name || "").trim().toLowerCase();
  return !nm || PLACEHOLDER_ACCOUNTS.has(nm);
}

/** A Deal needs a Contact when it has no Contact_Name (no primary contact role). */
export function dealNeedsContact(raw: any): boolean {
  const c = linkVal(raw?.Contact_Name);
  return !(c && c.id);
}

/** Confidence = base 40 + evidence, capped 100. Matches Account Hints. */
export function scoreLinkConfidence(a: { agreeing: number; explicitDomain: boolean; relatedRecords: number }): number {
  let s = 40;
  s += a.agreeing >= 2 ? 25 : a.agreeing === 1 ? 10 : 0;
  s += a.explicitDomain ? 25 : 0;
  s += a.relatedRecords > 0 ? 10 : 0;
  return Math.min(100, s);
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx tsx src/utils/recordLinkHints.test.ts`
Expected: `recordLinkHints ok`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/recordLinkHints.ts src/utils/recordLinkHints.test.ts
git commit -m "feat(record-hint): pure needs-help predicates + confidence scoring"
```

---

### Task 3: Inference — Contact→Account and Deal→Contact

**Files:**
- Modify: `src/utils/recordLinkHints.ts`
- Test: `src/utils/recordLinkHints.test.ts` (extend with best-candidate selection)

**Interfaces:**
- Consumes: `duplicate_records` (via `getDbPool()` used elsewhere in the file's siblings), `realDomainRoot` from `preflightStructuredPush`.
- Produces:
  - `inferAccountForContact(contact): Promise<LinkHint | null>`
  - `inferContactForDeal(deal): Promise<LinkHint | null>`
  - `scanRecordLinkHints(): Promise<{ contact_account: number; deal_contact: number }>` — upserts into `record_link_hints`, preserving `dismissed`/`applied` status like `scanDealsForAccountHints`.
  - type `LinkHint = { sourceRecordId; sourceZohoId; sourceModule: "Contacts"|"Deals"; linkField: "Account_Name"|"Contact_Name"; targetRecordId; targetZohoId; targetName; domain; evidenceRecordId; evidenceDetail; confidence }`

**Inference rules (from the data already in `duplicate_records`):**
- **Contact→Account:** the contact's `domain` (or `realDomainRoot(email)`) → find the Account record with that domain (`record_type='account'`, matching `domain`). `explicitDomain=true` when the account row's own `domain` equals it. Fall back to exact `company_name` match. `agreeing` = number of the contact's signals (domain, company) that point to the same account. `relatedRecords` = other records in the same cluster.
- **Deal→Contact:** the deal's linked `account_name`/domain → the Contacts under that account/domain. If exactly ONE contact → strong (`agreeing=2`); if several → pick the one sharing the deal's domain, lower confidence; if none → null (no hint).

- [ ] **Step 1: Write failing tests** for the pure best-candidate selector (extract selection so it's testable without a DB):

```ts
import { pickAccountForContact, pickContactForDeal } from "./recordLinkHints";
// pickAccountForContact(contactDomain, candidateAccounts[]) → best or null
ok(pickAccountForContact("acme.co", [{ id: "A1", domain: "acme.co", name: "Acme" }])?.id === "A1", "contact→account by domain");
ok(pickAccountForContact("acme.co", []) === null, "no candidate → null");
// pickContactForDeal(dealDomain, candidateContacts[]) → best or null
ok(pickContactForDeal("acme.co", [{ id: "C1", domain: "acme.co", name: "Sara" }])?.id === "C1", "deal→contact single under account");
ok(pickContactForDeal("acme.co", []) === null, "no contact under account → null");
```

- [ ] **Step 2: Run — verify fail** (`npx tsx src/utils/recordLinkHints.test.ts` → module members missing).

- [ ] **Step 3: Implement** `pickAccountForContact`, `pickContactForDeal` (pure), then `inferAccountForContact`, `inferContactForDeal`, `scanRecordLinkHints` (DB — mirror `scanDealsForAccountHints` at `accountInference.ts:278`, including the status-preserving upsert). Use the `record_link_hints` UNIQUE `(source_record_id, link_field, suggested_target_record_id)` for the upsert `ON CONFLICT`.

```ts
export function pickAccountForContact(domain: string, cands: Array<{ id: string; domain?: string; name?: string }>) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  return cands.find(c => String(c.domain || "").toLowerCase() === d) || null;
}
export function pickContactForDeal(domain: string, cands: Array<{ id: string; domain?: string; name?: string }>) {
  if (cands.length === 1) return cands[0];
  const d = String(domain || "").trim().toLowerCase();
  return cands.find(c => String(c.domain || "").toLowerCase() === d) || null;
}
```

(The DB `infer*`/`scan*` functions query `duplicate_records` for the source rows via `contactNeedsAccount`/`dealNeedsContact`, gather candidate accounts/contacts by `domain`/`account_name`, call the pickers, `scoreLinkConfidence`, and upsert. Copy the connection + upsert idioms verbatim from `accountInference.ts:278-361`.)

- [ ] **Step 4: Run tests — verify pass.** `npx tsx src/utils/recordLinkHints.test.ts` → `recordLinkHints ok`.

- [ ] **Step 5: tsc.** `npm run check` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/recordLinkHints.ts src/utils/recordLinkHints.test.ts
git commit -m "feat(record-hint): infer Contact→Account and Deal→Contact + scan/upsert"
```

---

### Task 4: List + AI-resolve (apply) for record link hints

**Files:**
- Modify: `src/utils/recordLinkHints.ts`

**Interfaces:**
- Consumes: `updateZohoRecord` (`zohoCRM.ts:1820`).
- Produces:
  - `listRecordLinkHints(opts: { type?: "contact_account"|"deal_contact"; status?: string; limit?: number })`
  - `aiResolveRecordLinkHint(id: number, minConfidence = 70)` — writes `{ [linkField]: { id: targetZohoId } }` on the source module, marks `applied`.
  - `aiResolveAllRecordLinkHints(opts: { type?; minConfidence?; limit? })`

- [ ] **Step 1:** Mirror `aiResolveAccountHint` (`accountInference.ts:463`) and `aiResolveAllAccountHints` (`:569`). The ONLY differences: the module + field come from the hint row (`source_type`→module, `link_field`), and the write is `await updateZohoRecord(sourceModule, sourceZohoId, { [linkField]: { id: targetZohoId } })`. Keep the ≥70% gate and the `updateZohoRecord` per-record status check.

- [ ] **Step 2: tsc.** `npm run check` → PASS. (No new pure test — this path is DB+Zoho; covered by integration.)

- [ ] **Step 3: Commit**

```bash
git add src/utils/recordLinkHints.ts
git commit -m "feat(record-hint): list + AI-resolve (apply link) for record link hints"
```

---

### Task 5: API endpoints `/record-hints/*`

**Files:**
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (add after the account-hints endpoints, ~line 8052)

**Interfaces:**
- Produces (mirror `/account-hints/*` exactly; `?type=contact_account|deal_contact` selects the section):
  - `POST /api/duplicates/record-hints/scan` → `{ success, contact_account, deal_contact }`
  - `GET  /api/duplicates/record-hints?type=&status=&limit=` → `{ success, hints, summary }`
  - `POST /api/duplicates/record-hints/:id/resolve-with-ai` → `{ success, applied, confidence }`
  - `POST /api/duplicates/record-hints/resolve-all-with-ai` → `{ success, applied, skipped }`
  - `POST /api/duplicates/record-hints/:id/status` (`{ status: "dismissed"|"applied" }`)

- [ ] **Step 1:** Add five route objects using the standard shape (`requireDuplicateRadarAccess` for GET, `requireAdminOrKey` for writes; copy from account-hints at `:7866-8052`). Each `createHandler` calls the Task 4 functions.

- [ ] **Step 2: tsc.** `npm run check` → PASS.

- [ ] **Step 3: Smoke test (manual)** — note in the task: after deploy, `POST /record-hints/scan` then `GET /record-hints?type=contact_account&status=pending` returns hints. (No automated integration test added here; the pure logic is covered in Tasks 2–3.)

- [ ] **Step 4: Commit**

```bash
git add src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(record-hint): /record-hints scan/list/resolve/resolve-all/status endpoints"
```

---

### Task 6: Rename Account Hints tab → Record Hint, add 2 sections

**Files:**
- Modify: `dashboard/duplicates.html` (rename `tab-account-hints` label; add 2 section containers; bump `?v=`)
- Modify: `dashboard/js/duplicates-app.js` (`renderAccountHints` → `renderRecordHints` with 3 sections + handlers)

**Interfaces:**
- Consumes: `GET /account-hints` (Section 1 — unchanged data path), `GET /record-hints?type=contact_account` (Section 2), `GET /record-hints?type=deal_contact` (Section 3).

- [ ] **Step 1:** In `duplicates.html:126`, change the `tab-account-hints` button **label** to "Record Hint" (keep the id or rename to `tab-record-hints` — if renamed, update every reference). Under its panel add three sections: **Deal → Account** (the existing account-hints table, moved as-is), **Contact → Account**, **Deal ↔ Contact** — each a table (source · current · suggested · domain · evidence · confidence · actions) with its own **Scan** button and pending count.

- [ ] **Step 2:** In `duplicates-app.js`, wrap the existing `renderAccountHints` (`:8169`) as **Section 1** of a new `renderRecordHints()`, and render Sections 2–3 by reusing the same row/pagination/confidence-badge markup, fed by `GET /record-hints?type=…`. Add `runRecordHintsScan(type)`, `resolveRecordHintWithAi(id)`, `markRecordHintApplied(id)`, `dismissRecordHint(id)` (mirror `:8261`/`:8244-8247`). Keep the existing `resolveAccountHintWithAi`/`runAccountHintsScan` for Section 1.

- [ ] **Step 3: Bump the JS version** in `duplicates.html` (`?v=58` → `?v=59`).

- [ ] **Step 4: Gates.**
Run: `node --check dashboard/js/duplicates-app.js` → OK
Run: `npm run check:html-js` → PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/duplicates.html dashboard/js/duplicates-app.js
git commit -m "feat(record-hint): rename Account Hints tab to Record Hint + Contact→Account & Deal↔Contact sections (v=59)"
```

---

### Task 7: Adam tool coverage

**Files:**
- Modify: `src/mastra/tools/radarTabTools.ts` (extend near `accountHintsStatusTool`, `:382`)

**Interfaces:**
- Produces: `recordHintsStatusTool` (or extend the existing tool) reporting pending/applied counts + AI-resolve-ready (≥70%) counts for `contact_account` and `deal_contact`.

- [ ] **Step 1:** Add the tool mirroring `accountHintsStatusTool` (input `{ type?, status? }`, output summary + `aiResolveReady` + confidence distribution), calling `listRecordLinkHints`.

- [ ] **Step 2: tsc + full sweep.**
Run: `npm run check:all` → PASS (tsc, tests, html-js, schema-parity).

- [ ] **Step 3: Commit**

```bash
git add src/mastra/tools/radarTabTools.ts
git commit -m "feat(record-hint): Adam tool reports contact→account & deal→contact hints"
```

---

### Task 8: Strip the 3 linking pairings out of Cross-Module

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (`getCrossModuleOverlaps`, ~line 8743)
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (pairing whitelist, ~line 4536)
- Modify: `dashboard/duplicates.html` (remove the 3 chip buttons)
- Modify: `dashboard/js/duplicates-app.js` (chip filter `_cmoClusterMatchesChip`)

**Rationale:** `contact_account` / `contact_deal` / `deal_account` are now Record Hint's job (whole-CRM, with apply). A cluster classified as *exactly* one of those is no longer shown in Cross-Module. `lead_contact`, `lead_account`, `lead_deal`, and `mixed` (3+ modules) STAY — Cross-Module remains the Lead-overlap / existing-client-CS / compound view.

- [ ] **Step 1:** In `getCrossModuleOverlaps`, after `classifyCrossModulePairing`, drop clusters whose pairing ∈ {`contact_account`,`contact_deal`,`deal_account`} from the returned `clusters` (and from `by_pairing`/counts). A `mixed` cluster that merely *contains* those relationships stays (it also has a Lead or spans 3+ modules).

- [ ] **Step 2:** Remove those 3 from the endpoint pairing whitelist (`:4536-4554`) so `?pairing=contact_account` no longer resolves there.

- [ ] **Step 3:** Remove the 3 blue chip buttons from `duplicates.html`'s Cross-Module tab, and delete their branches in `_cmoClusterMatchesChip` in `duplicates-app.js`.

- [ ] **Step 4: Gates.** `npm run check` (tsc) → PASS · `npm run check:html-js` → PASS · `node --check dashboard/js/duplicates-app.js` → OK.

- [ ] **Step 5: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts src/mastra/routes/duplicateRadarRoutes.ts dashboard/duplicates.html dashboard/js/duplicates-app.js
git commit -m "refactor(cross-module): move contact/deal/account linking pairings to Record Hint; keep lead/mixed"
```

> **FOLLOW-UP (separate cycle, NOT in this plan):** Sarah asked that Cross-Module then be "checked again as a whole approach." Once linking moves to Record Hint, re-review what Cross-Module should be: Lead-overlap disposition (CLOSE lead), existing-client-CS, and 3+-module compound cases — its rules, chips, and recommended actions. Draft as its own plan.

---

## Self-Review

**Spec coverage:** Coverage (a) whole-CRM scan ✅ (Task 3 scans `duplicate_records`, not clusters). Rename Account Hints → Record Hint (not a new tab) ✅ (Task 6). Three sections ✅ (Tasks 3/5/6). The 3 blue cross-module pairings moved into Record Hint + removed from Cross-Module ✅ (Task 8). Cross-Module "whole re-review" flagged as a separate follow-up ✅ (Task 8 note). Reuse Account Hints confidence + apply + 70% gate ✅ (Tasks 2/4). Account Hints backend untouched ✅ (new module/table/endpoints). Adam ✅ (Task 7).

**Placeholder scan:** DDL, pure helpers, pickers, and test code are concrete. The DB `infer*`/`scan*`/`aiResolve*` bodies are specified as "copy the idioms from `accountInference.ts:<lines>`" with the exact deltas (module/field from the row) — an implementer has the reference and the signatures.

**Type consistency:** `LinkHint`, `linkField`/`link_field`, `source_type`, and the picker return shapes are used consistently across Tasks 2–6.

**Resolved decisions:** Tab name = rename **Account Hints → Record Hint** (Task 6, not a new tab). The 3 linking pairings move from Cross-Module into Record Hint and are removed from Cross-Module (Task 8). Cross-Module's own "whole re-review" is a separate follow-up plan.
