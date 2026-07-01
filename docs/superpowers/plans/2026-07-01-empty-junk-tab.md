# Empty / Junk tab + cross-tab cleanup exclusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Recognize `walaplus`-named and junk/gibberish-named otherwise-empty records as cleanup, rename the cleanup tab "Empty / Junk", and hide every cleanup record (empty/test/junk/orphaned + already-tagged) from all other tabs so only real, actionable data shows elsewhere.

**Architecture:** Extend the pure classifier (`emptyRecordsDetection.ts`); persist a `cleanup_class` on `duplicate_records`, recomputed each scan from the synced snapshot; a read-time filter excludes cleanup records from the other tab queries (reuse the `status='active'` idiom sites); rename the tab.

**Tech Stack:** TypeScript (node-postgres), vanilla JS. Co-located `*.test.ts` via the `tsc --noCheck`→`/tmp`→`node` trick (pure files only — importing `duplicateRadarDatabase` crashes the sandbox harness on a missing dep).

## Global Constraints (from the approved spec)
- **Safety rule kept:** a record with any real data (deal/contact/email/attachment) is NEVER a cleanup candidate — `walaplus`/junk names flag ONLY otherwise-empty records (same gate as today's test keywords).
- **`walaplus` = exact name** (normalize lowercase+trim+collapse spaces → equals `walaplus`). Never substring.
- **junk = conservative + Arabic-safe:** J1 whole-name is one token repeated; J2 single Latin token len≥6 that looks machine-generated (letters+digits, or mixed-case with low vowel ratio). GUARDS never-junk: contains Arabic char; ≥2 distinct real-word tokens; len<5; pure numeric.
- **Hide from every tab EXCEPT** Empty/Junk (home) and Account Hints (keeps `orphaned` for linking).
- **Already tagged** (in `empty_delete_ledger`, or synced Empty-Delete/Duplicate-Delete tag) also counts as cleanup → hidden.
- Schema-parity STRICT; no new live-Zoho calls for classification; tag-time live re-check unchanged.
- Gates before each commit: `tsc --noEmit`; `tsc -p tsconfig.tests.json --noEmit`; schema-parity strict (Task 2+); `check-dashboard-html-js` + `node --check` + i18n JSON (Task 4).

---

### Task 1: Detection rules (pure) — `walaplus` + junk
**Files:** Modify `src/utils/emptyRecordsDetection.ts`; extend `src/utils/emptyRecordsDetection.test.ts`.
**Produces:** `export function isJunkOrTestName(name): { junk: boolean; test: boolean }` (superset of `isTestOrPlaceholderName`); `reason` union across `classifyDeal/Account/Contact` gains `"junk"`.

- [ ] **Step 1: Write failing tests** — append to `emptyRecordsDetection.test.ts` (use its existing harness):
```ts
import { isJunkOrTestName } from "./emptyRecordsDetection";
// walaplus exact
assert(isJunkOrTestName("WalaPlus").test === true, "walaplus exact → test");
assert(isJunkOrTestName("wala plus").test === true, "wala plus (collapsed) → test");
assert(isJunkOrTestName("WalaPlus Partners").test === false, "walaplus substring → NOT test");
assert(isJunkOrTestName("walaplus.com deal").test === false, "walaplus in phrase → NOT test");
// junk J1 repeated token
assert(isJunkOrTestName("JYupWMLW JYupWMLW").junk === true, "repeated token → junk");
assert(isJunkOrTestName("tsSLAueP tsSLAueP").junk === true, "repeated token 2 → junk");
// junk J2 machine string
assert(isJunkOrTestName("jJQaBOcg").junk === true, "machine string → junk");
assert(isJunkOrTestName("IxbfYeaa").junk === true, "machine string 2 → junk");
// guards: never junk
assert(isJunkOrTestName("شركة الرياض").junk === false, "arabic → not junk");
assert(isJunkOrTestName("Acme Trading Co").junk === false, "real multiword → not junk");
assert(isJunkOrTestName("SES").junk === false, "short acronym → not junk");
assert(isJunkOrTestName("12345").junk === false, "numeric → not junk");
console.log("isJunkOrTestName ok");
```
- [ ] **Step 2: Run, expect FAIL** — `rm -rf /tmp/erd && node node_modules/typescript/bin/tsc src/utils/emptyRecordsDetection.ts src/utils/emptyRecordsDetection.test.ts --outDir /tmp/erd --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --noCheck && NODE_PATH='D:\2_QMS Platform\qms-dashboard\node_modules' node /tmp/erd/emptyRecordsDetection.test.js`
  (`emptyRecordsDetection.ts` imports `isPlaceholderName` from `duplicateRadarDatabase` — if that import crashes the harness, isolate the new pure helpers into a small block that doesn't transitively load the pool, OR accept the assertions print before any crash and report. Prefer keeping `isJunkOrTestName` pure and self-contained.)
- [ ] **Step 3: Implement** in `emptyRecordsDetection.ts`:
```ts
function _normName(name: string): string { return String(name || "").trim().toLowerCase().replace(/\s+/g, " "); }
function _hasArabic(s: string): boolean { return /[؀-ۿ]/.test(s); }
function _vowelRatio(t: string): number { const m = t.match(/[aeiou]/gi); return t.length ? (m ? m.length : 0) / t.length : 0; }
function _isMachineToken(t: string): boolean {
  if (t.length < 6) return false;
  const hasLetter = /[a-z]/i.test(t), hasDigit = /\d/.test(t);
  const mixedCase = /[a-z]/.test(t) && /[A-Z]/.test(t);
  if (hasLetter && hasDigit) return true;               // letters+digits mashup
  if (mixedCase && _vowelRatio(t) < 0.25) return true;  // camel gibberish, no vowels
  return false;
}
export function isJunkOrTestName(name: string | null | undefined): { junk: boolean; test: boolean } {
  const raw = String(name || ""); const norm = _normName(raw);
  if (!norm) return { junk: false, test: false };
  const test = norm === "walaplus";
  let junk = false;
  if (!_hasArabic(raw)) {
    const toks = raw.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 2 && toks[0].toLowerCase() === toks[1].toLowerCase() && toks[0].length >= 4) junk = true; // J1
    else if (toks.length === 1 && !/^\d+$/.test(toks[0]) && _isMachineToken(toks[0])) junk = true;                 // J2
  }
  return { junk, test };
}
```
  Then extend `isTestOrPlaceholderName` to also return true when `isJunkOrTestName(name).test || .junk`, and thread a `junk` reason into `classifyDeal/classifyAccount/classifyContact`: where they currently do `isTestOrPlaceholderName(input.name) ? "test" : "empty"`, use `const jt = isJunkOrTestName(input.name); reason = jt.junk ? "junk" : (jt.test || isTestOrPlaceholderName(input.name)) ? "test" : "empty";` — keeping the "only if empty" gate exactly as-is (the classifiers already only reach this line when structurally empty).
- [ ] **Step 4: Run, expect PASS**; then `tsc --noEmit` + tests-tsc; commit `feat(empty-junk): walaplus + junk name detection (gated to empty records)`.

---

### Task 2: `cleanup_class` column + post-scan classification pass
**Files:** Modify `src/utils/duplicateRadarDatabase.ts` (schema + a `classifyCleanupRecords()` pass called after scan) and `src/mastra/routes/duplicateRadarRoutes.ts` (invoke the pass where the other post-scan passes run — near `restoreLedgerResolvedClusterStatus`/`reconcileEmptyDeleteDeletions`).
**Produces:** `duplicate_records.cleanup_class TEXT` = `'empty'|'test'|'junk'|'orphaned'|'tagged'|NULL`; `export async function classifyCleanupRecords(): Promise<number>`.

- [ ] **Step 1:** Add `cleanup_class TEXT` to the `duplicate_records` CREATE TABLE + `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS cleanup_class TEXT` + index `idx_duplicate_records_cleanup_class`. (strict parity — both.)
- [ ] **Step 2:** Implement `classifyCleanupRecords()` — a set-based UPDATE from the SYNCED snapshot only (no live Zoho). Compute per record: `tagged` if its `zoho_record_id` is in `empty_delete_ledger` OR its synced tags include `Empty-Delete`/`Duplicate-Delete`; else run the same emptiness signals the empty-records queries use (`getEmptyDeals`/`getEmptyAccounts`/`getEmptyContacts` logic — reuse their WHERE shape) to set `empty`/`orphaned`, and `isJunkOrTestName`/`isTestOrPlaceholderName` on `record_name` (gated to empty) to set `test`/`junk`; else NULL. Do it as a few UPDATE statements (one per class) ordered so `tagged` wins, then test/junk, then empty/orphaned. Return the count updated.
- [ ] **Step 3:** Call `classifyCleanupRecords()` in the post-scan sequence in the routes file (best-effort, wrapped, logged) after cluster stats are recomputed. `tsc --noEmit` + schema-parity strict; commit `feat(empty-junk): persist cleanup_class on duplicate_records (post-scan, snapshot-only)`.

---

### Task 3: Cross-tab exclusion (read-time filter)
**Files:** Modify `src/utils/duplicateRadarDatabase.ts` (the tab query functions) + `src/mastra/routes/duplicateRadarRoutes.ts` (the CS-overlap route).
**Consumes:** `cleanup_class` (Task 2).

- [ ] **Step 1:** Add a reusable predicate: a record is "real" when `cleanup_class IS NULL`. For each cluster-based tab, exclude cleanup records and drop clusters whose real-record count falls below the tab's threshold. Apply to: `getAllClusters` (Domain Clusters), `getCrossModuleOverlaps`, `findSameDomainClusterDuplicates` (Cluster Merge), `getDuplicateRecordsByType` (per-module dups), the `/cs-overlap/clusters` route, `scanCsLifecycleViolations`, `scanDealStageAgingViolations`, `analyzeRecordHygiene`/deal-compliance. Each already joins/scans `duplicate_records` (alias varies — `r`/`dr`/`duplicate_records`); add `AND <alias>.cleanup_class IS NULL` in the record-level filter, and for the cluster-list queries require the cluster to still have ≥ (its threshold) real records (mirror how the count/EXISTS is built).
- [ ] **Step 2: Exceptions (do NOT filter):** the Empty/Junk endpoints (their home), Account Hints (keep `orphaned`), Logs/Agent-Activity. For Account Hints specifically: it must still surface `orphaned` deals — so if its query joins cleanup_class, exclude only `cleanup_class IN ('empty','test','junk','tagged')`, NOT `'orphaned'`.
- [ ] **Step 3:** `tsc --noEmit`; commit `feat(empty-junk): hide cleanup records (empty/test/junk/orphaned/tagged) from all tabs except Empty-Junk + Account Hints`.
  NOTE: this is the largest task — enumerate EVERY listed function, add the filter, and in the report list each function touched + the alias + the exact clause, so the reviewer can confirm none was missed.

---

### Task 4: Rename tab → "Empty / Junk" + description + junk badge
**Files:** `dashboard/duplicates.html` (tab label `duplicates.er_tab`, the `title`, add a `junk` badge alongside empty/test), `dashboard/i18n/en.json` + `ar.json`, bump `?v=`.
- [ ] **Step 1:** Change `duplicates.er_tab` en+ar to "Empty / Junk" / the Arabic equivalent; update the tab `title` text to: "Records to clean up — empty, junk/gibberish, testing (incl. 'walaplus'), and orphaned. Tagged Empty-Delete for the Zoho admin to delete; the platform never deletes."; where the tab renders reason badges (`empty`/`test`), add a `junk` badge style.
- [ ] **Step 2:** `node --check` + `check-dashboard-html-js` + i18n JSON parse; bump `?v=`; commit `feat(empty-junk): rename Empty/Orphaned → Empty/Junk + description + junk badge`.

---

### Task 5: Final verification + push
- [ ] `tsc --noEmit` && tests-tsc && schema-parity strict && check-dashboard-html-js && node --check; re-run Task 1 co-located test; `git push`.
- [ ] Manual smoke (post-republish): a `walaplus`/junk EMPTY record shows in Empty/Junk (not the dup tabs); a walaplus record WITH a real deal is NOT flagged; an already-tagged record is gone from the cluster tabs; an orphaned deal still shows in Account Hints.

## Self-Review
Spec coverage: detection (T1) ✓ · cleanup_class persistence snapshot-only (T2) ✓ · already-tagged as cleanup (T2) ✓ · hide-from-all-tabs + Account-Hints/orphaned exception (T3) ✓ · rename+desc+badge (T4) ✓ · safety gate kept (T1) ✓ · schema-parity (T2) ✓. Types: `isJunkOrTestName` (T1) → used in T2; `cleanup_class` (T2) → filtered in T3.
