# Empty / Orphaned Records Cleanup Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Duplicate Radar tab that surfaces empty/orphaned and test/placeholder CRM records (Deals, Accounts, Contacts) and lets an admin tag them `Empty-Delete` (HITL) or, for orphaned deals, link them to an Account — so the team can clean Zoho without the platform ever auto-deleting.

**Architecture:** Pure detection logic (`emptyRecordsDetection.ts`) + DB query layer (`emptyRecordsDatabase.ts`) feed read-only GET endpoints; write endpoints (tag / untag / link-deal) reuse the existing Zoho helpers (`addZohoTags`, `removeZohoTags`, `updateZohoRecord`) behind the admin gate. The frontend is a new tab in `dashboard/duplicates.html` mirroring the Deal Compliance tab (lazy per-row attachment fetch, paced bulk loop, admin-password write). No new DB tables — the `Empty-Delete` tag in Zoho is the durable record; undo = remove the tag.

**Tech Stack:** TypeScript, Hono-style route objects, Postgres (`pg` `pool`), vitest, vanilla JS dashboard (CSP-safe `data-on-click`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-25-empty-orphaned-records-cleanup-design.md`.
- Tag name is exactly **`Empty-Delete`** (env `EMPTY_DELETE_TAG`, default `Empty-Delete`).
- **Never auto-delete and never delete in Zoho** — the platform only tags; admin deletes. All Zoho writes are admin-gated + reviewed (HITL).
- Test detection = **moderate**: a standalone whole-word test keyword OR an exact placeholder. Keyword set env-extendable via `EMPTY_DELETE_TEST_KEYWORDS`.
- Detection runs off local `duplicate_records`; the **only** live Zoho call is the lazy per-account attachment check.
- Schema-parity is STRICT: if any `ALTER ADD COLUMN`/new table is introduced it must also be in the canonical `CREATE TABLE` — this plan adds **no** tables/columns, so `check:schema-parity` must stay green.
- No backticks added to `qmsConsultantAgent.ts` (not touched in this plan).
- Gates after each backend task: `npm run check` (tsc) + `npm run check:tests`. After frontend: `npm run check:html-js`. Pure-logic tasks: `npx vitest run <file>`.
- Relationship JSON paths in `raw_data`: `Account_Name.id`, `Contact_Name.id` (shape `{ id, name }`). Columns available: `record_type` ('deal'|'account'|'contact'), `zoho_record_id`, `record_name`, `company_name`, `account_name`, `email`, `phone_normalized`, `mobile_normalized`, `deal_value`, `owner_name`, `stage`, `raw_data`.

---

## File Structure

- **Create** `src/utils/emptyRecordsDetection.ts` — pure functions + keyword set + per-module classifiers. No I/O.
- **Create** `src/utils/emptyRecordsDetection.test.ts` — vitest unit tests for the pure logic.
- **Create** `src/utils/emptyRecordsDatabase.ts` — DB query layer (orphaned/empty/test candidates per module) using the pure classifiers.
- **Modify** `src/mastra/routes/duplicateRadarRoutes.ts` — add 7 routes under `/api/duplicates/empty-records/*`.
- **Modify** `dashboard/duplicates.html` — new "Empty / Orphaned Records" tab (button, loader, 3 sub-tables, per-row + bulk actions, admin-gate modal).
- **Create** `scripts/smokeEmptyRecords.ts` — read-only smoke check the operator runs on Replit to eyeball detection counts before publish.

---

## Task 1: Pure detection module + tests

**Files:**
- Create: `src/utils/emptyRecordsDetection.ts`
- Test: `src/utils/emptyRecordsDetection.test.ts`

**Interfaces:**
- Consumes: `isPlaceholderName` from `./duplicateRadarDatabase`.
- Produces:
  - `EMPTY_DELETE_TEST_KEYWORDS: string[]`
  - `isTestOrPlaceholderName(name: string | null | undefined): boolean`
  - `testKeywordLikePatterns(): string[]` → SQL ILIKE patterns (e.g. `['%test%','%demo%',…]`) for the coarse SQL prefilter.
  - `classifyDeal(input: { hasAccount: boolean; hasContact: boolean; amount: number; name: string }): { reason: 'orphaned' | 'empty' | 'test' | null; deleteEligible: boolean; linkEligible: boolean }`
  - `classifyAccount(input: { hasDeals: boolean; hasContacts: boolean; name: string }): { reason: 'empty' | 'test' | null; structurallyEmpty: boolean }` (attachment check applied later, in the endpoint/UI)
  - `classifyContact(input: { hasEmail: boolean; hasPhone: boolean; hasAccount: boolean; hasDeals: boolean; name: string }): { reason: 'empty' | 'test' | null; deleteEligible: boolean }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/utils/emptyRecordsDetection.test.ts
import { describe, it, expect } from "vitest";
import {
  isTestOrPlaceholderName,
  classifyDeal,
  classifyAccount,
  classifyContact,
} from "./emptyRecordsDetection";

describe("isTestOrPlaceholderName", () => {
  it("flags exact placeholders", () => {
    expect(isTestOrPlaceholderName("test")).toBe(true);
    expect(isTestOrPlaceholderName("N/A")).toBe(true);
  });
  it("flags standalone test keywords (whole word, EN+AR)", () => {
    expect(isTestOrPlaceholderName("Test Account")).toBe(true);
    expect(isTestOrPlaceholderName("Ahmed Test")).toBe(true);
    expect(isTestOrPlaceholderName("demo deal")).toBe(true);
    expect(isTestOrPlaceholderName("شركة تجريبي")).toBe(true);
  });
  it("does NOT flag a keyword embedded in a real word", () => {
    expect(isTestOrPlaceholderName("Latest Holdings")).toBe(false);
    expect(isTestOrPlaceholderName("Testbed Robotics")).toBe(false);
  });
  it("does NOT flag a real company that merely contains a keyword as a word", () => {
    // Intertek Testing IS flagged (the word 'Testing' stands alone) — accepted,
    // unchecked in review. But a name with no standalone keyword is clean:
    expect(isTestOrPlaceholderName("Saudi Aramco")).toBe(false);
  });
});

describe("classifyDeal", () => {
  it("empty when no account, no contact, no amount", () => {
    const r = classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X" });
    expect(r.reason).toBe("empty");
    expect(r.deleteEligible).toBe(true);
    expect(r.linkEligible).toBe(true);
  });
  it("orphaned (not empty) when no account but has a contact — link only", () => {
    const r = classifyDeal({ hasAccount: false, hasContact: true, amount: 0, name: "X" });
    expect(r.reason).toBe("orphaned");
    expect(r.deleteEligible).toBe(false);
    expect(r.linkEligible).toBe(true);
  });
  it("test name → delete-eligible even with an account and amount", () => {
    const r = classifyDeal({ hasAccount: true, hasContact: true, amount: 5000, name: "demo deal" });
    expect(r.reason).toBe("test");
    expect(r.deleteEligible).toBe(true);
  });
  it("a normal deal with an account is not flagged", () => {
    const r = classifyDeal({ hasAccount: true, hasContact: false, amount: 100, name: "Aramco Renewal" });
    expect(r.reason).toBe(null);
    expect(r.deleteEligible).toBe(false);
    expect(r.linkEligible).toBe(false);
  });
});

describe("classifyAccount", () => {
  it("structurally empty when no deals and no contacts", () => {
    const r = classifyAccount({ hasDeals: false, hasContacts: false, name: "X" });
    expect(r.reason).toBe("empty");
    expect(r.structurallyEmpty).toBe(true);
  });
  it("test name flagged regardless of links", () => {
    const r = classifyAccount({ hasDeals: true, hasContacts: true, name: "Test Co" });
    expect(r.reason).toBe("test");
  });
  it("normal account with links not flagged", () => {
    const r = classifyAccount({ hasDeals: true, hasContacts: false, name: "Riyad Bank" });
    expect(r.reason).toBe(null);
  });
});

describe("classifyContact", () => {
  it("name-only → delete eligible", () => {
    const r = classifyContact({ hasEmail: false, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
    expect(r.reason).toBe("empty");
    expect(r.deleteEligible).toBe(true);
  });
  it("has an email → not empty", () => {
    const r = classifyContact({ hasEmail: true, hasPhone: false, hasAccount: false, hasDeals: false, name: "John" });
    expect(r.reason).toBe(null);
  });
  it("test name → flagged", () => {
    const r = classifyContact({ hasEmail: true, hasPhone: true, hasAccount: true, hasDeals: true, name: "test contact" });
    expect(r.reason).toBe("test");
    expect(r.deleteEligible).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/utils/emptyRecordsDetection.test.ts`
Expected: FAIL — "Failed to resolve import './emptyRecordsDetection'".

- [ ] **Step 3: Implement the module**

```typescript
// src/utils/emptyRecordsDetection.ts
import { isPlaceholderName } from "./duplicateRadarDatabase";

// Moderate test-record detection: a standalone whole-word keyword (EN+AR) OR an
// exact placeholder. Env-extendable.
const BASE_TEST_KEYWORDS = [
  "test", "testing", "tester", "demo", "dummy", "sample", "trial", "sandbox",
  "asdf", "qwerty", "xxx", "zzz", "deleteme", "donotuse", "placeholder",
  "تجربة", "تجريبي", "اختبار", "تست",
];
export const EMPTY_DELETE_TEST_KEYWORDS: string[] = Array.from(
  new Set(
    [
      ...BASE_TEST_KEYWORDS,
      ...(process.env.EMPTY_DELETE_TEST_KEYWORDS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ],
  ),
);
const _TEST_KW_SET = new Set(EMPTY_DELETE_TEST_KEYWORDS);

// Tokenize on anything that isn't a Latin/Arabic letter or digit.
function _tokens(name: string): string[] {
  return (name || "")
    .toLowerCase()
    .split(/[^a-z0-9؀-ۿ]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function isTestOrPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return false;
  if (isPlaceholderName(name)) return true;
  for (const tok of _tokens(name)) {
    if (_TEST_KW_SET.has(tok)) return true;
  }
  return false;
}

/** Coarse SQL ILIKE patterns to PREFILTER candidate rows; JS refines with the
 *  whole-word check above. */
export function testKeywordLikePatterns(): string[] {
  return EMPTY_DELETE_TEST_KEYWORDS.map((k) => `%${k}%`);
}

export function classifyDeal(input: {
  hasAccount: boolean;
  hasContact: boolean;
  amount: number;
  name: string;
}): { reason: "orphaned" | "empty" | "test" | null; deleteEligible: boolean; linkEligible: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const empty = !input.hasAccount && !input.hasContact && !(input.amount > 0);
  const orphaned = !input.hasAccount;
  let reason: "orphaned" | "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (empty) reason = "empty";
  else if (orphaned) reason = "orphaned";
  return {
    reason,
    deleteEligible: isTest || empty,
    linkEligible: orphaned,
  };
}

export function classifyAccount(input: {
  hasDeals: boolean;
  hasContacts: boolean;
  name: string;
}): { reason: "empty" | "test" | null; structurallyEmpty: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const structurallyEmpty = !input.hasDeals && !input.hasContacts;
  let reason: "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (structurallyEmpty) reason = "empty";
  return { reason, structurallyEmpty };
}

export function classifyContact(input: {
  hasEmail: boolean;
  hasPhone: boolean;
  hasAccount: boolean;
  hasDeals: boolean;
  name: string;
}): { reason: "empty" | "test" | null; deleteEligible: boolean } {
  const isTest = isTestOrPlaceholderName(input.name);
  const nameOnly = !input.hasEmail && !input.hasPhone && !input.hasAccount && !input.hasDeals;
  let reason: "empty" | "test" | null = null;
  if (isTest) reason = "test";
  else if (nameOnly) reason = "empty";
  return { reason, deleteEligible: isTest || nameOnly };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/utils/emptyRecordsDetection.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run check && npm run check:tests`
Expected: no errors.
```bash
git add src/utils/emptyRecordsDetection.ts src/utils/emptyRecordsDetection.test.ts
git commit -m "feat(empty-records): pure detection + test/placeholder classifier"
```

---

## Task 2: DB query layer

**Files:**
- Create: `src/utils/emptyRecordsDatabase.ts`

**Interfaces:**
- Consumes: `pool` from `./duplicateRadarDatabase`; `classifyDeal/Account/Contact`, `testKeywordLikePatterns`, `isTestOrPlaceholderName` from `./emptyRecordsDetection`.
- Produces (all return `Promise<EmptyRecordRow[]>`, capped at 500 each, newest first):
  - `getEmptyDeals(): Promise<EmptyRecordRow[]>`
  - `getEmptyAccounts(): Promise<EmptyRecordRow[]>`
  - `getEmptyContacts(): Promise<EmptyRecordRow[]>`
  - type `EmptyRecordRow = { zohoId: string; name: string; owner: string | null; reason: "orphaned" | "empty" | "test"; deleteEligible: boolean; linkEligible?: boolean; extra?: Record<string, any> }`

- [ ] **Step 1: Implement the query module**

```typescript
// src/utils/emptyRecordsDatabase.ts
import { pool } from "./duplicateRadarDatabase";
import {
  classifyDeal,
  classifyAccount,
  classifyContact,
  testKeywordLikePatterns,
} from "./emptyRecordsDetection";

export interface EmptyRecordRow {
  zohoId: string;
  name: string;
  owner: string | null;
  reason: "orphaned" | "empty" | "test";
  deleteEligible: boolean;
  linkEligible?: boolean;
  extra?: Record<string, any>;
}

const CAP = 500;
const LIKES = testKeywordLikePatterns();

// Deals: orphaned (no Account) OR a coarse test-name match. JS classifier refines.
export async function getEmptyDeals(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `SELECT zoho_record_id, record_name, owner_name,
            COALESCE(deal_value, 0) AS amount,
            raw_data->'Account_Name'->>'id' AS account_id,
            raw_data->'Contact_Name'->>'id' AS contact_id
       FROM duplicate_records
      WHERE record_type='deal'
        AND ( COALESCE(NULLIF(raw_data->'Account_Name'->>'id',''), NULL) IS NULL
              OR record_name ILIKE ANY($1::text[]) )
      ORDER BY modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyDeal({
      hasAccount: !!(r.account_id && String(r.account_id).trim()),
      hasContact: !!(r.contact_id && String(r.contact_id).trim()),
      amount: Number(r.amount) || 0,
      name: r.record_name || "",
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      deleteEligible: c.deleteEligible,
      linkEligible: c.linkEligible,
      extra: { amount: Number(r.amount) || 0, hasContact: !!r.contact_id },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// Accounts: structurally empty (no deal/contact references it) OR test-name.
export async function getEmptyAccounts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH linked AS (
        SELECT DISTINCT raw_data->'Account_Name'->>'id' AS aid
          FROM duplicate_records
         WHERE record_type IN ('deal','contact')
           AND raw_data->'Account_Name'->>'id' IS NOT NULL
           AND raw_data->'Account_Name'->>'id' <> ''
     )
     SELECT a.zoho_record_id, a.record_name, a.account_name, a.owner_name,
            (a.zoho_record_id NOT IN (SELECT aid FROM linked)) AS structurally_empty
       FROM duplicate_records a
      WHERE a.record_type='account'
        AND ( a.zoho_record_id NOT IN (SELECT aid FROM linked)
              OR a.record_name ILIKE ANY($1::text[])
              OR a.account_name ILIKE ANY($1::text[]) )
      ORDER BY a.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const name = r.record_name || r.account_name || "";
    const c = classifyAccount({
      hasDeals: !r.structurally_empty, // structurally_empty=false means it HAS a link
      hasContacts: !r.structurally_empty,
      name,
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name,
      owner: r.owner_name || null,
      reason: c.reason,
      // Structurally-empty accounts need the lazy attachment check before delete;
      // test-named accounts are delete-eligible directly.
      deleteEligible: c.reason === "test",
      extra: { structurallyEmpty: c.structurallyEmpty, needsAttachmentCheck: c.reason === "empty" },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// Contacts: name-only (no email/phone/account/deal) OR test-name.
export async function getEmptyContacts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH deal_contacts AS (
        SELECT DISTINCT raw_data->'Contact_Name'->>'id' AS cid
          FROM duplicate_records
         WHERE record_type='deal'
           AND raw_data->'Contact_Name'->>'id' IS NOT NULL
           AND raw_data->'Contact_Name'->>'id' <> ''
     )
     SELECT c.zoho_record_id, c.record_name, c.owner_name,
            (c.email IS NOT NULL AND c.email <> '') AS has_email,
            ((c.phone_normalized IS NOT NULL AND c.phone_normalized <> '')
             OR (c.mobile_normalized IS NOT NULL AND c.mobile_normalized <> '')) AS has_phone,
            (c.raw_data->'Account_Name'->>'id' IS NOT NULL AND c.raw_data->'Account_Name'->>'id' <> '') AS has_account,
            (c.zoho_record_id IN (SELECT cid FROM deal_contacts)) AS has_deals
       FROM duplicate_records c
      WHERE c.record_type='contact'
        AND ( ( (c.email IS NULL OR c.email='')
                AND (c.phone_normalized IS NULL OR c.phone_normalized='')
                AND (c.mobile_normalized IS NULL OR c.mobile_normalized='')
                AND (c.raw_data->'Account_Name'->>'id' IS NULL OR c.raw_data->'Account_Name'->>'id'='')
                AND c.zoho_record_id NOT IN (SELECT cid FROM deal_contacts) )
              OR c.record_name ILIKE ANY($1::text[]) )
      ORDER BY c.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyContact({
      hasEmail: !!r.has_email,
      hasPhone: !!r.has_phone,
      hasAccount: !!r.has_account,
      hasDeals: !!r.has_deals,
      name: r.record_name || "",
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      deleteEligible: c.deleteEligible,
    });
    if (out.length >= CAP) break;
  }
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run check`
Expected: no errors.
```bash
git add src/utils/emptyRecordsDatabase.ts
git commit -m "feat(empty-records): DB query layer for orphaned/empty/test candidates"
```

---

## Task 3: API endpoints

**Files:**
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (append 7 route objects to the `duplicateRadarRoutes` array, before its closing `]`).

**Interfaces:**
- Consumes: `getEmptyDeals/Accounts/Contacts` (Task 2); `addZohoTags`, `removeZohoTags`, `updateZohoRecord`, `fetchZohoAttachments` from `../../utils/zohoCRM`; `inferAccountForDeal` from `../../utils/accountInference`; `requireDuplicateRadarAccess`, `unauthorizedResponse` (in-file); `requireAdminOrKey` from `../../utils/rbacMiddleware` (dynamic import, per existing pattern at the contact-merge route).
- Produces routes:
  - `GET /api/duplicates/empty-records/deals|accounts|contacts` → `{ success, rows }`
  - `GET /api/duplicates/empty-records/accounts/:id/attachments` → `{ count }`
  - `GET /api/duplicates/empty-records/deals/:id/account-suggestion` → `{ suggestion: { accountId, accountName, confidence } | null }`
  - `POST /api/duplicates/empty-records/tag` `{ module, zohoIds }` → `{ success, tagged }` (admin)
  - `POST /api/duplicates/empty-records/untag` `{ module, zohoIds }` → `{ success, untagged }` (admin)
  - `POST /api/duplicates/empty-records/link-deal` `{ dealId, accountId }` → `{ success }` (admin)

- [ ] **Step 1: Add the three GET list endpoints**

Insert into the `duplicateRadarRoutes` array (each follows the exact object shape used at `duplicateRadarRoutes.ts:3025`):

```typescript
{
  path: "/api/duplicates/empty-records/deals",
  method: "GET" as const,
  createHandler: async () => async (c: any) => {
    try {
      const user = await requireDuplicateRadarAccess(c);
      if (!user) return unauthorizedResponse(c);
      const { getEmptyDeals } = await import("../../utils/emptyRecordsDatabase");
      return c.json({ success: true, rows: await getEmptyDeals() });
    } catch (e: any) {
      logger.error("empty-records/deals failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
{
  path: "/api/duplicates/empty-records/accounts",
  method: "GET" as const,
  createHandler: async () => async (c: any) => {
    try {
      const user = await requireDuplicateRadarAccess(c);
      if (!user) return unauthorizedResponse(c);
      const { getEmptyAccounts } = await import("../../utils/emptyRecordsDatabase");
      return c.json({ success: true, rows: await getEmptyAccounts() });
    } catch (e: any) {
      logger.error("empty-records/accounts failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
{
  path: "/api/duplicates/empty-records/contacts",
  method: "GET" as const,
  createHandler: async () => async (c: any) => {
    try {
      const user = await requireDuplicateRadarAccess(c);
      if (!user) return unauthorizedResponse(c);
      const { getEmptyContacts } = await import("../../utils/emptyRecordsDatabase");
      return c.json({ success: true, rows: await getEmptyContacts() });
    } catch (e: any) {
      logger.error("empty-records/contacts failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
```

- [ ] **Step 2: Add the lazy attachment-count + account-suggestion GETs**

```typescript
{
  path: "/api/duplicates/empty-records/accounts/:id/attachments",
  method: "GET" as const,
  createHandler: async () => async (c: any) => {
    try {
      const user = await requireDuplicateRadarAccess(c);
      if (!user) return unauthorizedResponse(c);
      const id = c.req.param("id");
      if (!id) return c.json({ error: "account id required" }, 400);
      const { fetchZohoAttachments } = await import("../../utils/zohoCRM");
      let atts: any[] = [];
      try { atts = await fetchZohoAttachments("Accounts", id); } catch { atts = []; }
      return c.json({ count: Array.isArray(atts) ? atts.length : 0 });
    } catch (e: any) {
      logger.error("empty-records attachment check failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
{
  path: "/api/duplicates/empty-records/deals/:id/account-suggestion",
  method: "GET" as const,
  createHandler: async () => async (c: any) => {
    try {
      const user = await requireDuplicateRadarAccess(c);
      if (!user) return unauthorizedResponse(c);
      const id = c.req.param("id");
      if (!id) return c.json({ error: "deal id required" }, 400);
      const { pool } = await import("../../utils/duplicateRadarDatabase");
      const dr = await pool.query(
        `SELECT zoho_record_id, raw_data FROM duplicate_records
          WHERE record_type='deal' AND zoho_record_id=$1 LIMIT 1`,
        [id],
      );
      if (!dr.rows.length) return c.json({ suggestion: null });
      const { inferAccountForDeal } = await import("../../utils/accountInference");
      const inf = await inferAccountForDeal(dr.rows[0] as any);
      return c.json({
        suggestion: inf
          ? { accountId: inf.account.zoho_record_id, accountName: inf.account.name, confidence: inf.confidence }
          : null,
      });
    } catch (e: any) {
      logger.error("empty-records account-suggestion failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
```

> NOTE: confirm `inferAccountForDeal`'s returned `account` exposes `zoho_record_id` + `name` (per `accountInference.ts:194` `CandidateAccount`). If the field names differ, map them here — do not invent names.

- [ ] **Step 3: Add the admin-gated write endpoints (tag / untag / link-deal)**

```typescript
{
  path: "/api/duplicates/empty-records/tag",
  method: "POST" as const,
  createHandler: async () => async (c: any) => {
    try {
      const { requireAdminOrKey, unauthorizedResponse: unauth } =
        await import("../../utils/rbacMiddleware");
      const su = await requireAdminOrKey(c);
      if (!su) return unauth(c);
      const body = await c.req.json().catch(() => ({}));
      const module = String(body?.module || "");
      const zohoIds: string[] = Array.isArray(body?.zohoIds)
        ? body.zohoIds.map((x: any) => String(x)).filter(Boolean) : [];
      if (!["Deals", "Accounts", "Contacts"].includes(module))
        return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
      if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
      const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
      const { addZohoTags } = await import("../../utils/zohoCRM");
      // Batch in chunks of 100 (Zoho add_tags id cap).
      let tagged = 0;
      for (let i = 0; i < zohoIds.length; i += 100) {
        const batch = zohoIds.slice(i, i + 100);
        await addZohoTags(module, batch, [tag]);
        tagged += batch.length;
      }
      return c.json({ success: true, tagged, tag });
    } catch (e: any) {
      logger.error("empty-records/tag failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
{
  path: "/api/duplicates/empty-records/untag",
  method: "POST" as const,
  createHandler: async () => async (c: any) => {
    try {
      const { requireAdminOrKey, unauthorizedResponse: unauth } =
        await import("../../utils/rbacMiddleware");
      const su = await requireAdminOrKey(c);
      if (!su) return unauth(c);
      const body = await c.req.json().catch(() => ({}));
      const module = String(body?.module || "");
      const zohoIds: string[] = Array.isArray(body?.zohoIds)
        ? body.zohoIds.map((x: any) => String(x)).filter(Boolean) : [];
      if (!["Deals", "Accounts", "Contacts"].includes(module))
        return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
      if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
      const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
      const { removeZohoTags } = await import("../../utils/zohoCRM");
      let untagged = 0;
      for (let i = 0; i < zohoIds.length; i += 100) {
        const batch = zohoIds.slice(i, i + 100);
        await removeZohoTags(module, batch, [tag]);
        untagged += batch.length;
      }
      return c.json({ success: true, untagged });
    } catch (e: any) {
      logger.error("empty-records/untag failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
{
  path: "/api/duplicates/empty-records/link-deal",
  method: "POST" as const,
  createHandler: async () => async (c: any) => {
    try {
      const { requireAdminOrKey, unauthorizedResponse: unauth } =
        await import("../../utils/rbacMiddleware");
      const su = await requireAdminOrKey(c);
      if (!su) return unauth(c);
      const body = await c.req.json().catch(() => ({}));
      const dealId = String(body?.dealId || "");
      const accountId = String(body?.accountId || "");
      if (!dealId || !accountId) return c.json({ error: "dealId and accountId required" }, 400);
      const { updateZohoRecord } = await import("../../utils/zohoCRM");
      await updateZohoRecord("Deals", dealId, { Account_Name: { id: accountId } });
      return c.json({ success: true });
    } catch (e: any) {
      logger.error("empty-records/link-deal failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
```

> NOTE: verify `removeZohoTags` exists in `zohoCRM.ts` (the undo path at `duplicateResolutionRunner.ts:1378` calls it). If it's named differently, use that name. Confirm `updateZohoRecord` returns per-record status (memory: Zoho v2 returns 200 even on REJECTED — check `data[0].code` if you want strict success); for the link write, surface a failure if `code !== "SUCCESS"`.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run check`
Expected: no errors.
```bash
git add src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(empty-records): list/attachment/suggestion GETs + admin tag/untag/link POSTs"
```

---

## Task 4: Frontend tab

**Files:**
- Modify: `dashboard/duplicates.html`

**Interfaces:**
- Consumes: the Task 3 endpoints. Mirrors the Deal Compliance tab patterns (recon refs: tab button `:153`, `showTab` `:8360`, row render `:8661`, per-row lazy fetch `checkDealDocs` `:8702`, paced bulk `checkAllDealDocs` `:8683`, modal `:1032`).

- [ ] **Step 1: Add the tab button** — beside the existing radar tab buttons (copy the `:153` pattern), id `tab-empty-records`, label "🧹 Empty / Orphaned", title explaining it tags `Empty-Delete` for admin deletion.

- [ ] **Step 2: Add the tab panel markup** — a hidden `<div id="content-empty-records">` containing three sub-sections (Deals / Accounts / Contacts), each: a count chip, a "🔍 Run scan" / refresh button, a `<table>` with `<tbody id="erDealsBody|erAccountsBody|erContactsBody">`, and a reason-badge legend (Orphaned / Empty / Test). Add a shared bulk bar `#erBulkBar` (hidden until ≥1 row checked) with "🏷 Tag selected Empty-Delete" and "↩ Undo last batch". Reuse the admin-password modal pattern (`:1032`) for the write confirm.

- [ ] **Step 3: Wire `showTab`** — in `showTab` (`:8360`), add: `if (tab === 'empty-records' && !window._loadedTabs.has('empty-records')) loadEmptyRecords();` and add `'empty-records'` to the tab-id list used for class toggling (match how `deal-compliance` is registered).

- [ ] **Step 4: Implement the loader + renderers** — add a script block:

```javascript
async function loadEmptyRecords() {
  window._loadedTabs.add('empty-records');
  await Promise.all([erLoad('deals','erDealsBody'), erLoad('accounts','erAccountsBody'), erLoad('contacts','erContactsBody')]);
}
async function erLoad(kind, bodyId) {
  const body = document.getElementById(bodyId);
  body.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-gray-400">Loading…</td></tr>';
  let data;
  try {
    const res = await fetch('/api/duplicates/empty-records/' + kind, { credentials: 'same-origin' });
    data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || ('HTTP ' + res.status));
  } catch (e) {
    body.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-amber-700">Error: ' + escapeHtml(String(e.message || e)) + '</td></tr>';
    return;
  }
  window['_er_' + kind] = data.rows || [];
  erRender(kind, bodyId);
  const chip = document.getElementById('erCount-' + kind);
  if (chip) chip.textContent = (data.rows || []).length.toLocaleString();
}
function erReasonBadge(reason) {
  const m = { orphaned: ['bg-amber-100','text-amber-800','ORPHANED'], empty: ['bg-gray-200','text-gray-700','EMPTY'], test: ['bg-rose-100','text-rose-700','TEST'] };
  const x = m[reason] || m.empty;
  return '<span class="px-2 py-0.5 rounded text-[10px] font-bold ' + x[0] + ' ' + x[1] + '">' + x[2] + '</span>';
}
```

Then per-kind render functions that build rows with:
- a checkbox `class="er-cb" data-kind data-zoho-id` (only on `deleteEligible` rows),
- the reason badge,
- a Zoho deep-link on the name (Deals→`tab/Potentials/`, Accounts→`tab/Accounts/`, Contacts→`tab/Contacts/`),
- **Accounts:** a `📎 Check attachments` button (per-row lazy fetch to `…/accounts/:id/attachments`) that, on `count===0`, enables that row's checkbox; on `count>0` shows "📎 N — keep" and leaves the checkbox disabled (mirror `checkDealDocs` + the 350ms paced bulk loop from `:8683` for a "Check all attachments" button),
- **Deals:** a `🔗 Link to Account` button that GETs `…/deals/:id/account-suggestion`, shows the suggestion (one-click link) plus a manual Zoho-account-ID input, and POSTs `…/link-deal`; the `🏷` checkbox is enabled only when `deleteEligible`.

- [ ] **Step 5: Implement the tag/untag actions (admin-gated)** — selecting rows shows `#erBulkBar`; "Tag selected" triggers the write.

  **FIRST confirm the existing admin-write UX** (do not invent one): inspect how the merge-apply path authenticates — search `dashboard/duplicates.html` for `applyAllSafeMerges` / `executeMergePlan` / the admin-password prompt used before a Zoho write, and how that credential reaches the server (a password field in the POST body that `requireAdminOrKey` validates, vs. session-role only). **Replicate that exact mechanism** here — same prompt/field, same header/body key. `requireAdminOrKey` (server) is already wired in Task 3; the client must match what it expects.

  Then POST `…/empty-records/tag` `{ module, zohoIds, <admin-auth field as used by the existing flow> }` in one call (server batches by 100); on success, remove tagged rows from the table, stash the ids in `window._erLastTagged = { module, zohoIds }`, and enable "↩ Undo last batch" which POSTs `…/untag` with that payload (+ the same admin-auth). Show a result summary in the modal body (`:1043` pattern).

- [ ] **Step 6: i18n + verify** — add any new visible strings to `en.json`/`ar.json` if the page uses i18n keys for tabs (match how `deal-compliance` strings are keyed); otherwise inline text is fine.

Run: `npm run check:html-js`
Expected: "✓ check-dashboard-html-js: … parsed cleanly."

- [ ] **Step 7: Commit**

```bash
git add dashboard/duplicates.html dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(empty-records): Empty/Orphaned Records cleanup tab (UI + actions)"
```

---

## Task 5: Read-only smoke script

**Files:**
- Create: `scripts/smokeEmptyRecords.ts`

- [ ] **Step 1: Implement** — calls `getEmptyDeals/Accounts/Contacts`, prints counts by reason (orphaned/empty/test) and the first ~15 of each, so the operator can eyeball detection on the live DB before publishing. No writes.

```typescript
import { getEmptyDeals, getEmptyAccounts, getEmptyContacts } from "../src/utils/emptyRecordsDatabase";
async function main() {
  for (const [label, fn] of [["DEALS", getEmptyDeals], ["ACCOUNTS", getEmptyAccounts], ["CONTACTS", getEmptyContacts]] as const) {
    const rows = await fn();
    const by = rows.reduce((m: any, r) => ((m[r.reason] = (m[r.reason] || 0) + 1), m), {});
    console.log(`\n===== ${label}: ${rows.length} (${JSON.stringify(by)}) =====`);
    for (const r of rows.slice(0, 15)) console.log(`  [${r.reason}] ${r.zohoId} "${r.name}" deleteEligible=${r.deleteEligible}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run check`
```bash
git add scripts/smokeEmptyRecords.ts
git commit -m "chore(empty-records): read-only smoke script for detection counts"
```

---

## Final verification (whole feature)

- [ ] `npm run check:all` (tsc + tsc-tests + html-js + schema-parity) — all green; schema-parity confirms no stray schema (this plan adds none).
- [ ] `npx vitest run src/utils/emptyRecordsDetection.test.ts` — green.
- [ ] On Replit: `npx tsx scripts/smokeEmptyRecords.ts` — counts look sane (spot-check a few flagged records in Zoho).
- [ ] Manual: open the tab, scan each section, run an account attachment check, link a deal to a suggested account, and tag a small batch `Empty-Delete` (then undo) — all behind the admin password.

## Follow-on (separate task, not this plan)

- Add a read-only Adam tool for this tab (per the "rules into Adam's brain" standing rule) + a hygiene-catalog entry.
