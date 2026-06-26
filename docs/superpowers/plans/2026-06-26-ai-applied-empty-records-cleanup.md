# AI-Applied Empty-Records Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-click-per-module "AI-Apply" that tags genuinely-empty Contacts/Accounts/Deals as `Empty-Delete` (after verifying each is still live in Zoho and pruning already-deleted ghosts), plus a "Tagged · pending delete" sub-section that reconciles when the Zoho admin actually deletes them.

**Architecture:** Pure classifiers decide "empty"; a bulk action verifies each candidate against Zoho (attachment fetch doubles as the existence check for Accounts/Deals), prunes deleted ghosts from the local mirror, tags the rest, and records them in `empty_delete_ledger` with a `status`. A reconcile pass (auto on sync + manual button) flips `pending_delete → deleted` when the record vanishes from Zoho. The platform never deletes — it only tags; the admin is the final gate.

**Tech Stack:** TypeScript (Hono routes, node-postgres), vanilla browser JS (`dashboard/js/duplicates-app.js`), Zoho CRM v2 API helpers in `src/utils/zohoCRM.ts`.

## Global Constraints

- **Platform never deletes Zoho records** — only tags `Empty-Delete` / `Duplicate-Delete` for the admin. Verify-live before any tag.
- **Schema-parity is STRICT:** every `ALTER TABLE ... ADD COLUMN` MUST also be added to the canonical `CREATE TABLE` in the same file, or `check-schema-parity.mjs --strict` fails.
- **Deal protected stages:** `Agreement Signed`, `Paid` (case-insensitive) are existing-client stages — never tag a deal in these.
- **Empty-Delete tag name:** `process.env.EMPTY_DELETE_TAG || "Empty-Delete"`.
- **Attribution:** tags performed by the agent use the existing `AGENT_PERFORMED_BY` string ("Adam — GRQ Assistant (on behalf of Sarah Hijazi)").
- **Admin gating:** all write/trigger endpoints use `requireAdminOrKey`.
- **Verification gates (run locally before each commit):** `node node_modules/typescript/bin/tsc --noEmit`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit`; `node scripts/check-schema-parity.mjs --strict`; `node scripts/check-dashboard-html-js.mjs`; `node --check dashboard/js/duplicates-app.js`. Co-located `src/utils/*.test.ts` run on Replit via `npx tsx <file>`; verify locally by compiling with `tsc --noCheck` to `/tmp` and running with `node` (see Task 1 Step 2).
- **Frontend cache:** bump `duplicates-app.js?v=N` in `dashboard/duplicates.html` whenever `dashboard/js/duplicates-app.js` changes.
- **Pacing cap:** `EMPTY_AI_APPLY_BATCH` env, default `150`.

---

### Task 1: Refine the empty classifiers

**Files:**
- Modify: `src/utils/emptyRecordsDetection.ts` (the `classifyDeal`, `classifyAccount`, `classifyContact` functions)
- Test: `src/utils/emptyRecordsDetection.test.ts` (existing plain-assert harness)

**Interfaces:**
- Produces: `classifyDeal(input: { hasAccount, hasContact, amount, name, hasAttachments?, stage? })`, `classifyAccount(input: { hasDeals, hasContacts, hasEmail?, name, hasAttachments? })`, `classifyContact(input: { hasEmail, hasPhone, hasAccount, hasDeals, name })` — each returns `{ reason: "orphaned"|"empty"|"test"|null, deleteEligible, linkEligible? }`.
- New exported constant: `DEAL_PROTECTED_STAGES = new Set(["agreement signed","paid"])`.
- New exported helper: `isProtectedDealStage(stage: string | null | undefined): boolean`.

- [ ] **Step 1: Read the current classifiers** in `src/utils/emptyRecordsDetection.ts` to learn the exact existing shapes/returns before editing. Confirm `classifyContact` already encodes name-only (no email/phone/account/deal) — keep it unchanged.

- [ ] **Step 2: Write failing tests** appended to `src/utils/emptyRecordsDetection.test.ts`:

```ts
import { isProtectedDealStage, DEAL_PROTECTED_STAGES } from "./emptyRecordsDetection";
// (classifyDeal/Account already imported at top of file)

// Deal stage protection
assert(isProtectedDealStage("Agreement Signed") === true, "Agreement Signed protected");
assert(isProtectedDealStage("paid") === true, "paid protected (case-insensitive)");
assert(isProtectedDealStage("Proposal") === false, "Proposal not protected");
assert(isProtectedDealStage(null) === false, "null stage not protected");

// A deal in a protected stage is NOT empty even with no account/contact/docs
assert(
  classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: false, stage: "Paid" }).reason !== "empty",
  "protected-stage deal is never tagged empty",
);
// A deal with no account/contact/docs in a non-protected stage IS empty
assert(
  classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: false, stage: "Proposal" }).reason === "empty",
  "bare non-protected deal is empty",
);
// A deal WITH attachments is NOT empty
assert(
  classifyDeal({ hasAccount: false, hasContact: false, amount: 0, name: "X", hasAttachments: true, stage: "Proposal" }).reason !== "empty",
  "deal with documents is not empty",
);
// Account with email is NOT empty
assert(
  classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: true, name: "X", hasAttachments: false }).reason !== "empty",
  "account with email is not empty",
);
// Account with attachments is NOT empty
assert(
  classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: false, name: "X", hasAttachments: true }).reason !== "empty",
  "account with documents is not empty",
);
// Bare account IS empty
assert(
  classifyAccount({ hasDeals: false, hasContacts: false, hasEmail: false, name: "X", hasAttachments: false }).reason === "empty",
  "bare account is empty",
);
```

- [ ] **Step 3: Run the test, expect FAIL** (new params/exports not defined yet):

```
rm -rf /tmp/erd && node node_modules/typescript/bin/tsc src/utils/emptyRecordsDetection.ts src/utils/emptyRecordsDetection.test.ts --outDir /tmp/erd --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --noCheck && node /tmp/erd/emptyRecordsDetection.test.js
```
Expected: a failing assertion or a missing-export error.

- [ ] **Step 4: Implement.** In `emptyRecordsDetection.ts`:
  - Add `export const DEAL_PROTECTED_STAGES = new Set(["agreement signed", "paid"]);`
  - Add `export function isProtectedDealStage(stage?: string | null): boolean { return DEAL_PROTECTED_STAGES.has(String(stage || "").trim().toLowerCase()); }`
  - Extend `classifyDeal` to accept optional `hasAttachments` and `stage`: a deal is `empty` only when `!hasAccount && !hasContact && !hasAttachments && !isProtectedDealStage(stage)` (keep the existing test-name and orphaned logic; the `amount` rule stays as-is unless it conflicts — the agreed criteria don't require no-amount, so do NOT add an amount gate). Preserve `reason: "orphaned"` for has-data-but-no-account.
  - Extend `classifyAccount` to accept optional `hasEmail` and `hasAttachments`: `empty` only when `!hasDeals && !hasContacts && !hasEmail && !hasAttachments`. (Today's classifier may not know attachments at classify time — keep `needsAttachmentCheck` semantics; `hasAttachments` defaults `false` so list-time classification still flags candidates, and the live attachment check in Task 4 is the authority before tagging.)

- [ ] **Step 5: Run the test, expect PASS** (same command as Step 3).

- [ ] **Step 6: Run gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit
git add src/utils/emptyRecordsDetection.ts src/utils/emptyRecordsDetection.test.ts
git commit -m "feat(empty-records): classifier rules — deal stage protection, account email/documents"
```

---

### Task 2: Extend `empty_delete_ledger` with deletion-status columns

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (the `CREATE TABLE IF NOT EXISTS empty_delete_ledger` block in `initDuplicateRadarTables`)
- Modify: `src/utils/emptyRecordsDatabase.ts` (`markEmptyDeleteTagged` sets `status='pending_delete'`)

**Interfaces:**
- Produces: `empty_delete_ledger` now has `status` (`'pending_delete'|'deleted'`), `deleted_at`, `last_checked_at`.

- [ ] **Step 1: Read** the existing `CREATE TABLE IF NOT EXISTS empty_delete_ledger (...)` block (search `empty_delete_ledger` in `duplicateRadarDatabase.ts`).

- [ ] **Step 2: Edit the canonical CREATE TABLE** to include the new columns (so schema-parity is satisfied):
```sql
CREATE TABLE IF NOT EXISTS empty_delete_ledger (
  id SERIAL PRIMARY KEY,
  zoho_record_id VARCHAR(255) NOT NULL,
  module VARCHAR(16) NOT NULL,
  tagged_by VARCHAR(255),
  status VARCHAR(16) NOT NULL DEFAULT 'pending_delete',
  deleted_at TIMESTAMP,
  last_checked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (zoho_record_id)
)
```
- [ ] **Step 3: Add idempotent ALTERs** right after the CREATE (for existing deployments where the table predates these columns):
```ts
await pool.query(`ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'pending_delete'`);
await pool.query(`ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`);
await pool.query(`ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP`);
```

- [ ] **Step 4:** In `emptyRecordsDatabase.ts`, `markEmptyDeleteTagged` — set status explicitly on insert and reset to pending on conflict:
```ts
await pool.query(
  `INSERT INTO empty_delete_ledger (zoho_record_id, module, tagged_by, status)
     SELECT UNNEST($1::text[]), $2, $3, 'pending_delete'
     ON CONFLICT (zoho_record_id) DO UPDATE SET status='pending_delete', deleted_at=NULL`,
  [ids, module, by],
);
```

- [ ] **Step 5: Run gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit && node scripts/check-schema-parity.mjs --strict
git add src/utils/duplicateRadarDatabase.ts src/utils/emptyRecordsDatabase.ts
git commit -m "feat(empty-records): ledger gains status/deleted_at/last_checked_at for the delete lifecycle"
```

---

### Task 3: Ghost detection + prune helper

**Files:**
- Modify: `src/utils/emptyRecordsDatabase.ts` (add helpers)
- Test: `src/utils/emptyRecordsDatabase.test.ts` (create if absent — plain-assert harness; only the pure `isZohoGhostError` is unit-tested, DB calls are integration-tested on Replit)

**Interfaces:**
- Produces: `export function isZohoGhostError(msgOrErr: unknown): boolean` — TRUE when the message contains `record not found`, `INVALID_DATA`, or `the related id given seems to be invalid` (case-insensitive). `export async function pruneGhostRecords(zohoIds: string[]): Promise<void>` — removes the ids from `duplicate_records` + `empty_delete_ledger`.

- [ ] **Step 1: Write failing test** in `src/utils/emptyRecordsDatabase.test.ts`:
```ts
import { isZohoGhostError } from "./emptyRecordsDatabase";
import assert from "node:assert";
assert(isZohoGhostError('Zoho Attachments API error: 400 - {"code":"INVALID_DATA","message":"the related id given seems to be invalid"}') === true);
assert(isZohoGhostError("record not found") === true);
assert(isZohoGhostError(new Error("The related id given seems to be invalid")) === true);
assert(isZohoGhostError("0 attachments") === false);
console.log("isZohoGhostError ok");
```
- [ ] **Step 2: Run, expect FAIL** (compile via the `tsc --noCheck` /tmp trick as in Task 1, then `node`). Expected: missing export.

- [ ] **Step 3: Implement** in `emptyRecordsDatabase.ts`:
```ts
export function isZohoGhostError(x: unknown): boolean {
  const s = (x instanceof Error ? x.message : String(x ?? "")).toLowerCase();
  return s.includes("record not found")
    || s.includes("invalid_data")
    || s.includes("the related id given seems to be invalid");
}

export async function pruneGhostRecords(zohoIds: string[]): Promise<void> {
  const ids = (zohoIds || []).map(String).filter(Boolean);
  if (!ids.length) return;
  await pool.query(`DELETE FROM duplicate_records WHERE zoho_record_id = ANY($1::text[])`, [ids]);
  await pool.query(`DELETE FROM empty_delete_ledger WHERE zoho_record_id = ANY($1::text[])`, [ids]);
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Run gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit
git add src/utils/emptyRecordsDatabase.ts src/utils/emptyRecordsDatabase.test.ts
git commit -m "feat(empty-records): ghost detection (INVALID_DATA/not-found) + prune helper"
```

---

### Task 4: `aiApplyEmptyDelete` + the `/ai-apply` endpoint

**Files:**
- Modify: `src/utils/emptyRecordsDatabase.ts` (add `aiApplyEmptyDelete`)
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (add `POST /api/duplicates/empty-records/ai-apply`)

**Interfaces:**
- Consumes: `getEmptyDeals/Accounts/Contacts`, `fetchRecordAttachments(module, id)`, `fetchZohoRecordById(module, id)`, `addZohoTags`, `markEmptyDeleteTagged`, `isZohoGhostError`, `pruneGhostRecords`, `isProtectedDealStage` — confirm exact signatures by reading `zohoCRM.ts` + `emptyRecordsDatabase.ts`.
- Produces: `export async function aiApplyEmptyDelete(module: "Deals"|"Accounts"|"Contacts", opts: { limit?: number; by: string | null }): Promise<{ tagged: number; prunedGhosts: number; skippedWithDocs: number; remaining: number }>`.

- [ ] **Step 1: Read** `fetchRecordAttachments` and `fetchZohoRecordById` in `src/utils/zohoCRM.ts` to confirm their exact signatures + how they signal "not found" (return value vs throw). Read `getEmptyAccounts/Deals/Contacts` to confirm the row shape (`zohoId`, `reason`, `extra`).

- [ ] **Step 2: Implement `aiApplyEmptyDelete`** in `emptyRecordsDatabase.ts`. Logic:
  - Pull the module's candidate list (`getEmpty{Module}()`), keep only `reason !== "orphaned"` and `reason !== "test"` is allowed (test is delete-eligible too) — i.e. candidates eligible to tag. Slice to `limit` (default `Number(process.env.EMPTY_AI_APPLY_BATCH) || 150`).
  - For each candidate, in a bounded loop:
    - **Contacts:** no Zoho call needed (no attachments) — they're already verified empty by the classifier from synced data; still do a light `fetchZohoRecordById("Contacts", id)` to confirm existence; ghost → `pruneGhostRecords([id])`, `prunedGhosts++`, continue.
    - **Accounts/Deals:** `await fetchRecordAttachments(module, id)` in try/catch. On error → if `isZohoGhostError(err)` → prune + `prunedGhosts++` + continue; else rethrow/skip-and-log. On success: if attachments length > 0 → `skippedWithDocs++`, continue. (For Deals, also re-confirm the live `Stage` is not protected via the fetched record or the synced `stage`; if protected, skip.)
    - Collect surviving ids into `toTag`.
  - Batch-tag `toTag` (chunks of 100) via `addZohoTags(module, chunk, [EMPTY_DELETE_TAG])`, check each result's per-record status (reuse the existing per-record status pattern); on a per-record ghost error during tagging → prune that id instead.
  - `await markEmptyDeleteTagged(module, taggedOk, opts.by)`; `tagged = taggedOk.length`.
  - Return counts + `remaining` (candidates beyond the limit).

- [ ] **Step 3: Add the endpoint** in `duplicateRadarRoutes.ts` (mirror the existing `empty-records/tag` handler — admin-gated):
```ts
{
  path: "/api/duplicates/empty-records/ai-apply",
  method: "POST" as const,
  createHandler: async () => async (c: any) => {
    try {
      const { requireAdminOrKey, unauthorizedResponse: unauth } = await import("../../utils/rbacMiddleware");
      const su = await requireAdminOrKey(c);
      if (!su) return unauth(c);
      const body = await c.req.json().catch(() => ({}));
      const module = String(body?.module || "");
      if (!["Deals", "Accounts", "Contacts"].includes(module))
        return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
      const limit = Number.isFinite(body?.limit) && body.limit > 0 ? Math.floor(body.limit) : undefined;
      const { aiApplyEmptyDelete } = await import("../../utils/emptyRecordsDatabase");
      const AGENT = "Adam — GRQ Assistant (on behalf of " + (su?.email || "operator") + ")";
      const r = await aiApplyEmptyDelete(module as any, { limit, by: AGENT });
      return c.json({ success: true, ...r });
    } catch (e: any) {
      logger.error("empty-records/ai-apply failed", e);
      return c.json({ error: "An internal error occurred" }, 500);
    }
  },
},
```

- [ ] **Step 4: Gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit
git add src/utils/emptyRecordsDatabase.ts src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(empty-records): aiApplyEmptyDelete (verify-live -> prune ghosts -> attachment-check -> tag) + endpoint"
```

---

### Task 5: Tagged-status + reconcile (deletion lifecycle)

**Files:**
- Modify: `src/utils/emptyRecordsDatabase.ts` (`getTaggedStatus`, `reconcileEmptyDeleteDeletions`)
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (GET `tagged-status`, POST `recheck-deletions`)
- Modify: the scan/sync entry that already calls reconcile helpers (search `reconcileAutoMergedContactDeletions` callsite) — add a `reconcileEmptyDeleteDeletions()` call there.

**Interfaces:**
- Produces: `getTaggedStatus(module?: string): Promise<{ rows: Array<{ zohoId: string; module: string; status: string; taggedBy: string|null; createdAt: string; deletedAt: string|null }>; counts: { tagged: number; deleted: number; pending: number } }>`; `reconcileEmptyDeleteDeletions(module?: string): Promise<{ checked: number; nowDeleted: number }>`.

- [ ] **Step 1: Implement `getTaggedStatus`** — `SELECT ... FROM empty_delete_ledger WHERE ($1::text IS NULL OR module=$1) ORDER BY created_at DESC LIMIT 1000`, plus a counts query (`COUNT(*) FILTER (WHERE status='deleted')`, etc.).

- [ ] **Step 2: Implement `reconcileEmptyDeleteDeletions`** — select `pending_delete` ids (capped, e.g. 300/run); for each, `fetchZohoRecordById(module, id)` in try/catch: ghost/not-found → `UPDATE empty_delete_ledger SET status='deleted', deleted_at=NOW(), last_checked_at=NOW() WHERE zoho_record_id=$1` AND `pruneGhostRecords([id])`; still present → `UPDATE ... SET last_checked_at=NOW()`. Best-effort, swallow individual errors.

- [ ] **Step 3: Add endpoints** (GET tagged-status — `requireDuplicateRadarAccess`; POST recheck-deletions — `requireAdminOrKey`), mirroring existing handler style.

- [ ] **Step 4: Hook reconcile into sync** — at the existing post-sync reconcile callsite (where `reconcileAutoMergedContactDeletions` runs), add `await reconcileEmptyDeleteDeletions().catch(() => {})`.

- [ ] **Step 5: Gates + commit:**
```
node node_modules/typescript/bin/tsc --noEmit
git add src/utils/emptyRecordsDatabase.ts src/mastra/routes/duplicateRadarRoutes.ts
git commit -m "feat(empty-records): tagged-status + reconcile (auto on sync + manual), mark deleted when gone from Zoho"
```

---

### Task 6: Frontend — AI-Apply button + per-row ghost-prune

**Files:**
- Modify: `dashboard/duplicates.html` (section headers: add an AI-Apply button per module; bump `?v=`)
- Modify: `dashboard/js/duplicates-app.js` (`erAiApply(kind)` handler; make `erCheckAccountAttachments` prune on ghost error)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json` (labels)

**Interfaces:**
- Consumes: `POST /api/duplicates/empty-records/ai-apply`, the existing `erAdminPost`, `_erRemoveLocal`, `erReload`.

- [ ] **Step 1:** Add a button to each section header in `duplicates.html`, e.g. for deals: `<button data-on-click="erAiApply" data-args='["deals"]' ...>🤖 <span data-i18n="duplicates.er_ai_apply">AI-Apply empty → Empty-Delete</span></button>`. Repeat for accounts/contacts.

- [ ] **Step 2:** Add `erAiApply(kind)` in `duplicates-app.js`:
```js
async function erAiApply(kind) {
    const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
    const n = (window['_er_' + kind] || []).length;
    if (!n) return;
    if (!confirm('AI-Apply: verify each of the ' + n + ' empty ' + module + ' against Zoho, prune any already deleted, and tag the genuinely-empty ones Empty-Delete (Adam, pending admin delete)?\n\nThe platform never deletes — the admin removes the tagged records.')) return;
    const result = document.getElementById('erBulkResult');
    if (result) result.textContent = 'AI-Applying ' + module + '… (verifying live records)';
    const j = await erAdminPost('/api/duplicates/empty-records/ai-apply', { module: module });
    if (!j) { if (result) result.textContent = 'Cancelled.'; return; }
    if (!j.success) { if (result) result.textContent = 'Error: ' + (j.error || 'failed'); return; }
    if (result) result.textContent = '✓ Tagged ' + (j.tagged||0) + ' · pruned ' + (j.prunedGhosts||0) + ' ghosts · skipped ' + (j.skippedWithDocs||0) + ' with documents' + ((j.remaining||0) > 0 ? ' · ' + j.remaining + ' remaining — click again' : '');
    erReload(kind); // re-fetch so tagged/pruned drop off and the count updates
}
```

- [ ] **Step 3:** In `erCheckAccountAttachments`, on the catch branch detect ghost and prune instead of showing the red error:
```js
} catch (e) {
    var msg = String(e && e.message || e);
    if (/invalid_data|related id given seems to be invalid|record not found/i.test(msg)) {
        _erRemoveLocal('accounts', [String(id)]); // ghost → disappears
        return;
    }
    if (cell) cell.innerHTML = '<span class="text-xs text-amber-700">err: ' + escapeHtml(msg) + '</span>';
    return;
}
```
(Note: the server attachment endpoint returns the Zoho error string in `data.error`; ensure the ghost check also runs on the `!res.ok` path that throws that message.)

- [ ] **Step 4:** Add i18n keys `er_ai_apply` (en: "AI-Apply empty → Empty-Delete"; ar: "تطبيق الذكاء: وسم الفارغة Empty-Delete"). Bump `duplicates-app.js?v=` in `duplicates.html`.

- [ ] **Step 5: Gates + commit:**
```
node --check dashboard/js/duplicates-app.js && node scripts/check-dashboard-html-js.mjs && node -e "JSON.parse(require('fs').readFileSync('dashboard/i18n/en.json','utf8'));JSON.parse(require('fs').readFileSync('dashboard/i18n/ar.json','utf8'))"
git add dashboard/duplicates.html dashboard/js/duplicates-app.js dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(empty-records): AI-Apply button per module + per-row ghost auto-prune"
```

---

### Task 7: Frontend — "Tagged · pending delete" sub-section

**Files:**
- Modify: `dashboard/duplicates.html` (markup for the sub-section + Re-check button; bump `?v=`)
- Modify: `dashboard/js/duplicates-app.js` (`erLoadTaggedStatus()`, `erRecheckDeletions()`, render)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`

**Interfaces:**
- Consumes: `GET /api/duplicates/empty-records/tagged-status`, `POST /api/duplicates/empty-records/recheck-deletions`.

- [ ] **Step 1:** Add a sub-section in the Empty/Orphaned tab markup: a header with a progress count span (`id="erTaggedProgress"`), a `🔄 Re-check CRM` button (`data-on-click="erRecheckDeletions"`), and a `<tbody id="erTaggedBody">`.

- [ ] **Step 2:** Add `erLoadTaggedStatus()` — `fetch('/api/duplicates/empty-records/tagged-status')`, render each row (record id link to Zoho via `erZohoUrl`, status chip Pending/Deleted ✓), set `erTaggedProgress` to `"{tagged} tagged · {deleted} deleted · {pending} pending"`. Call it from `loadEmptyRecords()`.

- [ ] **Step 3:** Add `erRecheckDeletions()` — `erAdminPost('/api/duplicates/empty-records/recheck-deletions', {})` then `erLoadTaggedStatus()`.

- [ ] **Step 4:** i18n keys (`er_tagged_pending`, `er_recheck`, `er_status_pending`, `er_status_deleted`). Bump `duplicates-app.js?v=`.

- [ ] **Step 5: Gates + commit:**
```
node --check dashboard/js/duplicates-app.js && node scripts/check-dashboard-html-js.mjs
git add dashboard/duplicates.html dashboard/js/duplicates-app.js dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(empty-records): Tagged-pending-delete sub-section with status + re-check"
```

---

### Task 8: Teach Adam + final verification

**Files:**
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (extend the empty-records tool note #40 — NO backticks in the template literal)

- [ ] **Step 1:** In `qmsConsultantAgent.ts`, append to the empty-records note: that the operator can now bulk **AI-Apply** empty Contacts/Accounts/Deals (verify-live, prune ghosts, tag Empty-Delete) and track admin deletion in the "Tagged · pending delete" sub-section; per-module empty rules (Contacts name-only; Accounts no deals/contacts/email/documents; Deals no account/contact/documents and stage not Agreement Signed/Paid). No backticks.

- [ ] **Step 2: Full gate run + commit:**
```
node node_modules/typescript/bin/tsc --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit && node scripts/check-schema-parity.mjs --strict && node scripts/check-dashboard-html-js.mjs && node --check dashboard/js/duplicates-app.js
git add src/mastra/agents/qmsConsultantAgent.ts
git commit -m "docs(adam): teach the empty-records AI-Apply + deletion-lifecycle"
git push
```

- [ ] **Step 3: Manual smoke (post-republish):** Sync Now → Empty/Orphaned → click 🤖 AI-Apply on Accounts → confirm result line (tagged/pruned/skipped), the `INVALID_DATA` rows vanish, and the "Tagged · pending delete" sub-section shows the count. After the admin deletes some in Zoho, click "Re-check CRM" → they flip to Deleted ✓.

---

## Self-Review

**Spec coverage:** Criteria (Task 1) ✓ · AI-Apply verify→prune→attachment→tag (Task 4) ✓ · ghost auto-prune everywhere (Task 3 + Task 6 Step 3) ✓ · tagged-status sub-section + reconcile C (Task 5 + 7) ✓ · ledger status columns (Task 2) ✓ · pacing/cap (Task 4 limit) ✓ · safety/never-delete (global constraints + Task 4) ✓ · Adam teaching (Task 8) ✓.

**Type consistency:** `aiApplyEmptyDelete` return `{ tagged, prunedGhosts, skippedWithDocs, remaining }` used identically in Task 4 endpoint + Task 6 UI. `isZohoGhostError` / `pruneGhostRecords` defined Task 3, used Task 4/5. `isProtectedDealStage` defined Task 1, used Task 1/4.

**Open confirmations for the implementer (resolve by reading code, not guessing):** exact signatures of `fetchRecordAttachments`, `fetchZohoRecordById`, `getEmpty*` row shape, and the post-sync reconcile callsite. These are reads, not design decisions.
