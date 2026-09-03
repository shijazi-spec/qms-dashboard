---

# Agentic Duplicate Resolution — Design & Implementation Plan

**Date:** 2026-06-03
**Author:** Claude (planning agent), commissioned by <REDACTED_EMAIL>
**Target commit path:** `docs/Agentic_Duplicate_Resolution_Plan_2026_06_03.md`
**Status:** Plan-only. No code in this PR. Review-before-build.

**Scope:** Extend the **Duplicate Radar** so an operator presses a single button on a cluster and an agentic layer resolves it by **writing the merge/edits back to CRMProvider CRM** — covering (1) merging duplicate Accounts, (2) field-hygiene fixes on the surviving record, and (3) cross-module migration (Lead ↔ Contact ↔ Account, owner reassignment, cross-module overlap closure). Today, resolving a cluster only mutates the platform's own Postgres; CRMProvider is untouched except for the one existing `bulkCloseLeadsInClusters` flow.

**TL;DR:** The foundation is ~80% built. CRMProvider OAuth, the write primitives (`updateCRMProviderRecord` / `createCRMProviderRecord` / `deleteCRMProviderRecord` / `updateCRMProviderRecordNotes`), clustering, resolve endpoints, forensic snapshots, RBAC write-gating, rate-limit handling, and a proven write-back flow (`bulkCloseLeadsInClusters`) all exist. The gap is that `resolveCluster()` stops at Postgres. This plan adds: a **two-phase Propose → Approve → Execute** flow, one missing primitive (`mergeCRMProviderRecords`), a deterministic **merge-plan generator**, a **Duplicate Resolution Agent** that authors the plan (but never writes), two new endpoints (`/plan`, `/execute`) modelled on `bulkCloseLeadsInClusters`, and a **full-payload snapshot** for rollback. Phase 0 is a hard blocker: the documented CRMProvider token is **read-only** and must be re-authorized with write/delete/merge scopes before anything else.

**Locked decisions** (agreed 2026-06-03):
- **Autonomy:** Propose → Approve → Execute (human confirms a dry-run plan before any write).
- **Auth:** Single integration user (existing refresh token) + a CRMProvider note on every merged record naming the real operator. Internal audit already records who clicked. Per-user OAuth deferred.
- **Merge method:** ~~Both, chosen per cluster~~ → **Migrate-then-TAG** (updated 2026-06-08). The platform performs **no deletes** — the CRMProvider Admin will not grant DELETE permission. The surviving (master) record is updated with the winning field values; each duplicate is **tagged** (red `Delete` tag) and noted for the admin, who removes them manually. Native CRMProvider merge and migrate-then-delete are both dropped (they destroy records).
- **Editing scope:** Merge Accounts (via migrate-then-tag) + field hygiene + cross-module migration. Phase 1 ships Accounts-only.

---

## Section 1 — Current State

### 1.1 What already exists

| Capability | Location | Notes |
|---|---|---|
| CRMProvider OAuth (refresh-token, auto-refresh, rate-limit cooldown) | `src/utils/CRMProviderCRM.ts` | `getValidAccessToken`, `getCRMProviderConnectionStatus` |
| Write primitives | `src/utils/CRMProviderCRM.ts:1379–1558` | `updateCRMProviderRecordNotes` (POST Notes), `updateCRMProviderRecord` (PUT), `createCRMProviderRecord` (POST), `deleteCRMProviderRecord` (DELETE) |
| Read primitives | `src/utils/CRMProviderCRM.ts` | `fetchCRMProviderRecordById`, `fetchCRMProviderRelatedRecords`, `fetchAllCRMProviderRecords`, `searchCRMProviderRecords`, `fetchDeletedCRMProviderRecords` |
| Hygiene auditing + governance rules | `src/mastra/tools/CRMProviderCRMTool.ts:16`, `src/utils/CRMProviderCRM.ts` (`analyzeRecordHygiene`, `DEFAULT_GOVERNANCE_RULES`) | Produces per-field issues + `suggestedFix` |
| Duplicate detection / clustering | `src/mastra/routes/duplicateRadarRoutes.ts`, `src/utils/duplicateRadarDatabase.ts` | `scanCRMProviderCRMForDuplicates`, cross-module overlaps |
| Resolve / set-primary / bulk-resolve | `duplicateRadarRoutes.ts`, `duplicateRadarDatabase.ts:2539` (`resolveCluster`), `:2593` (`bulkResolve`) | **Postgres-only — no CRMProvider write** |
| Proven CRMProvider write-back flow | `duplicateRadarDatabase.ts:3445` (`bulkCloseLeadsInClusters`) | PUTs `Lead_Status='Lost Lead'`; has dry-run, per-cluster reporting, admin-gating — **the template to reuse** |
| Forensic pre-resolve snapshot | `captureClusterSnapshot` (R10) | Snapshots cluster+records before mutation; **does not yet store full CRMProvider field payloads** |
| Manual-merge detection | `runDeletionDetection` in `duplicateRadarRoutes.ts` | Picks up duplicates a human merged in CRMProvider and purges them from the radar |
| Internal audit trail | `duplicate_merge_actions` table | Records `performed_by`, `primary_record_id`, `merged_record_ids`, `action_type`, `notes` |
| RBAC write-gating, rate limiting | `src/utils/rbacMiddleware.ts`, middleware | `requireAdminOrKey`, `requireDuplicateRadarAccess` |

### 1.2 The precise gap

`resolveCluster()` ([`duplicateRadarDatabase.ts:2539`](../src/utils/duplicateRadarDatabase.ts)) captures a snapshot, optionally marks a primary, inserts a `duplicate_merge_actions` row, and flips `duplicate_clusters.status` to `resolved`/`ignored`. **It never calls CRMProvider.** So "resolve" today means "resolve in the radar" — a human still fixes the records in CRMProvider by hand. This plan closes that gap.

---

## Section 2 — Target Architecture

```
[Duplicate Radar UI] ──"Resolve with AI"──▶ POST /api/duplicates/:clusterId/plan   (read-level role)
                                                     │
                              ┌──────────────────────▼───────────────────────┐
                              │ Duplicate Resolution Agent (Mastra)            │
                              │  tools: getClusterDetail · getCRMProviderRecordSnapshot│
                              │         proposeMergePlan · runHygieneCheck      │
                              │  output: MergePlan (NO writes)                  │
                              └──────────────────────┬───────────────────────┘
                                                     │  dry-run plan
                       [UI diff panel: master highlighted, per-field provenance,
                        records to delete/migrate, hygiene fixes, chosen method]
                                                     │
                                       operator clicks "Confirm"
                                                     │
                              POST /api/duplicates/:clusterId/execute            (requireAdminOrKey)
                              body: { plan, dry_run? }
                                                     │
                  ┌──────────────────────────────────▼───────────────────────────┐
                  │ Executor (mirrors bulkCloseLeadsInClusters)                    │
                  │  1. captureClusterSnapshot(..., 'pre_CRMProvider_write', fullPayload) │
                  │  2. per plan.method:                                           │
                  │       native_merge   → mergeCRMProviderRecords(master, [secondary…])  │
                  │       migrate_delete → updateCRMProviderRecord(master, winningFields) │
                  │                        + reparent related records             │
                  │                        + deleteCRMProviderRecord(duplicate)           │
                  │  3. apply hygieneFixes via updateCRMProviderRecord(master, …)         │
                  │  4. updateCRMProviderRecordNotes(master, "Merged on behalf of <op>")  │
                  │  5. resolveCluster(clusterId, 'resolve', operator, masterId)   │
                  │  6. return per-record { ok | skipped | failed, reason }        │
                  └────────────────────────────────────────────────────────────────┘
```

**Design principle:** the LLM authors the *plan*; it is never in the destructive write path. The executor is deterministic TypeScript operating on an approved, validated `MergePlan`.

---

## Section 3 — Phase 0: OAuth Scopes — RESOLVED (2026-06-08)

**Status: cleared.** Root cause of the long-standing "CRMProvider down" state was a mismatched `CRMProvider_CLIENT_SECRET` in HostingPlatform Secrets (refresh returned `{"error":"invalid_client_secret"}`), compounded by the old token being read-only. Re-minted via the existing Self Client; verified scope is now `CRMProviderCRM.modules.READ CREATE UPDATE` and a write probe (PUT to a fake Account id) returned `INVALID_DATA` — confirming UPDATE works through **both** the scope gate and the integration user's profile-permission gate.

**No further token work is required for this feature.** Because the platform performs no deletes (migrate-then-tag design, §7), `READ + CREATE + UPDATE` is sufficient — tag application (`add_tags`) runs under module write/update, which is already present. The earlier plan to re-mint with `CRMProviderCRM.modules.ALL` (to add DELETE) is **no longer needed**.

> Historical note (kept for the runbook): the original read-only scope below is what shipped first. `docs/CRMProvider_OAuth_Setup_2026_05_25.md` still documents this read-only flow and should be updated.

`docs/CRMProvider_OAuth_Setup_2026_05_25.md` provisions the Self-Client token with **read-only** scope:

```
CRMProviderCRM.modules.READ,CRMProviderCRM.users.READ,CRMProviderCRM.notifications.READ,CRMProviderCRM.settings.READ
```

A read-only token **cannot** update, delete, or merge. (`bulkCloseLeadsInClusters` PUTs to CRMProvider — so either the production token was already widened beyond the documented scope, or that flow currently fails in production. **This must be confirmed.**)

**Required scopes for this feature:**
```
CRMProviderCRM.modules.accounts.{READ,WRITE,DELETE}
CRMProviderCRM.modules.leads.{READ,WRITE,DELETE}
CRMProviderCRM.modules.contacts.{READ,WRITE,DELETE}
CRMProviderCRM.modules.deals.{READ,WRITE}
CRMProviderCRM.modules.notes.{CREATE}
CRMProviderCRM.users.READ
CRMProviderCRM.settings.READ
```
(The native **merge** action is authorized by the module WRITE scope. Confirm against the CRMProvider API edition in use.)

**Action items:**
1. Probe the *current production* token's real scopes (script: attempt a no-op `updateCRMProviderRecord` on a throwaway sandbox record, or inspect the token grant).
2. If write scopes are absent, re-run the Self-Client flow in `CRMProvider_OAuth_Setup_2026_05_25.md` with the scope list above and rotate `CRMProvider_REFRESH_TOKEN`.
3. Update `CRMProvider_OAuth_Setup_2026_05_25.md` to document the write scopes and the *reason* (this feature).

---

## Section 4 — Data Model

### 4.1 `MergePlan` (TypeScript / Zod — no LLM in the write path)

```ts
type MergeMethod = "migrate_tag";   // only mode: migrate fields to master, tag duplicates for admin deletion

interface FieldDecision {
  field: string;              // CRMProvider API field name, e.g. "Phone"
  chosenValue: unknown;
  fromRecordId: string;       // provenance: which duplicate the value came from
  reason: string;             // "non-empty" | "most-recent" | "governed-format" | "longest" | ...
  conflictingValues: { recordId: string; value: unknown }[];
}

interface HygieneFix {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  rule: string;               // governance rule id from DEFAULT_GOVERNANCE_RULES
  severity: "critical" | "high" | "medium" | "low";
}

interface CrossModuleAction {
  type: "convert_lead" | "reassign_owner" | "close_overlap_lead" | "reparent";
  recordId: string;
  module: string;
  detail: Record<string, unknown>;
}

interface MergePlan {
  clusterId: number;
  module: "Accounts" | "Leads" | "Contacts" | "Deals";
  method: MergeMethod;
  masterRecordId: string;
  masterReason: string;       // "most-complete" | "most-activities" | "oldest" | "correct-owner"
  recordsToTag: string[];     // duplicate CRMProvider ids to flag with the Delete tag (admin removes later)
  tagName: string;            // e.g. "Duplicate-Delete" (must pre-exist in CRMProvider as a red tag)
  fieldDecisions: FieldDecision[];
  hygieneFixes: HygieneFix[];
  crossModuleActions: CrossModuleAction[];
  relatedRecordCounts: {       // surfaced to operator so deletes aren't blind
    notes: number; activities: number; deals: number; attachments: number;
  };
  warnings: string[];          // e.g. "secondary owns 3 open deals", "native merge is irreversible"
  generatedBy: string;         // agent id + prompt version
  generatedAt: string;         // stamped by caller (Date.now unavailable in some contexts)
}
```

### 4.2 Postgres changes

- **New table `duplicate_merge_plans`** — persists each generated plan so Approve/Execute is decoupled from Propose, and so the executed plan is auditable:
  ```
  id PK · cluster_id FK · plan_json jsonb · status ('proposed'|'approved'|'executed'|'failed'|'discarded')
  · generated_by · approved_by · executed_by · created_at · executed_at · execution_report_json jsonb
  ```
- **Extend snapshots:** add a `CRMProvider_payload_json jsonb` column (or a new `duplicate_cluster_CRMProvider_snapshots` table) so `captureClusterSnapshot` stores the **full pre-write field payload + related-record ids** of every record. This is the rollback source of truth (native merges are not reversible via CRMProvider).
- **Reuse `duplicate_merge_actions`** unchanged for the post-execute audit row (already records `performed_by`).

---

## Section 5 — API Contracts

### 5.1 `POST /api/duplicates/:clusterId/plan`  (read-level: `requireDuplicateRadarAccess`)
Generates (or regenerates) a dry-run plan. No writes to CRMProvider.
```
Response: { success: true, plan: MergePlan, planId: number }
```

### 5.2 `POST /api/duplicates/:clusterId/execute`  (`requireAdminOrKey` — destructive)
```
Body: { planId: number, dry_run?: boolean }      // re-validates plan_json server-side
Response: {
  success: boolean,
  dryRun: boolean,
  report: {
    master: { id, action: "updated" },
    perRecord: { id, action: "tagged"|"reparented"|"skipped"|"failed", reason?: string }[],
    hygieneApplied: number,
    crossModuleApplied: number,
    noteStamped: boolean,
    clusterResolved: boolean
  }
}
```
- Mirrors `bulkCloseLeadsInClusters`: upfront validation, `dry_run` short-circuit, per-record reporting, idempotency (skip already-merged/deleted), CRMProvider rate-limit surfacing.
- Snapshot **before** any write; `resolveCluster()` only after all CRMProvider writes succeed (the existing comment at `duplicateRadarDatabase.ts:3992–4001` already articulates this ordering).

### 5.3 `POST /api/duplicates/:clusterId/restore`  (`requireAdminOrKey`)
Best-effort rollback from the stored snapshot: re-create deleted records from `CRMProvider_payload_json`, restore overwritten master fields. Surfaces what could and couldn't be restored (e.g. native-merge cases). SLA bounded by CRMProvider Recycle Bin retention — **confirm that window**.

---

## Section 6 — Agent & Planner

- **`src/utils/duplicateMergePlanner.ts`** (new, pure, deterministic) — `proposeMergePlan(cluster): MergePlan`. Master selection: most-complete → most related activities/deals → oldest → owner correctness. Field winner: non-empty > governed-format-valid > most-recent > longest. Folds in `analyzeRecordHygiene` output as `hygieneFixes`. This is testable without the LLM and is the safety backbone.
- **`src/mastra/agents/duplicateResolutionAgent.ts`** (new — clone `src/mastra/agents/salesQualityAgent.ts`). Tools: `getClusterDetail`, `getCRMProviderRecordSnapshot` (wraps `fetchCRMProviderRecordById` + `fetchCRMProviderRelatedRecords`), `proposeMergePlan` (wraps the planner), `runHygieneCheck` (wraps `auditCRMHygieneTool`). The agent narrates *why* (human-readable rationale + edge-case warnings) and may override the deterministic planner only within validated bounds; the Zod schema rejects anything malformed before it can reach the executor.
- Register in `src/mastra/index.ts` and the prompt-version registry (`promptVersionRegistry.ts`) for regression tracking.

---

## Section 7 — Merge Mechanics (Migrate-then-Tag — no deletes)

The platform never deletes. Resolution = migrate winning fields onto the master, then flag the duplicates for the CRMProvider Admin to remove manually.

### 7.1 New primitive: `addCRMProviderTags(module, recordIds[], tagNames[])` in `CRMProviderCRM.ts`
Wraps CRMProvider's add-tags action, following the existing `makeCRMProviderRequest` + error-handling pattern:
```
POST {apiDomain}/crm/v2/{module}/actions/add_tags?ids={id1,id2,...}&tag_names={tag}
```
Runs under module **write/update** scope (already granted — no new scope). Pair with `removeCRMProviderTags(...)` (`remove_tags` action) for rollback. **The tag's red color is a one-time admin setup on the tag definition (CRMProvider Setup → Tags); the API only applies an existing tag by name.** Confirm the tag exists before first run.

### 7.2 Execution path (the only path)
1. `updateCRMProviderRecord(master, winningFields)` — apply `fieldDecisions` (and `hygieneFixes`).
2. **Reparent ALL related records** of each duplicate onto the master *before* tagging — full fidelity (decided 2026-06-08). Per-type handlers (CRMProvider v2 behaviour differs):
   - **Deals** → `updateCRMProviderRecord(Deals, dealId, { Account_Name: { id: masterId } })` (clean lookup move). *modules.UPDATE ✅*
   - **Contacts** → same, update `Account_Name` lookup. *modules.UPDATE ✅*
   - **Notes** → COPY: `createCRMProviderRecord(Notes, …Parent_Id=master)` (v2 can't repoint a note; original is removed when admin deletes). *modules.CREATE ✅*
   - **Activities** (Tasks/Calls/Events) → update `What_Id` to master; support is inconsistent — on failure, leave in place and add a `warnings` entry.
   - **Attachments** → `fetchRecordAttachments` (exists) → download → re-upload to master; on failure, warn.
   Report per-record reparent counts + any per-type failures in the execution report. This is the highest-effort step.
3. `addCRMProviderTags(module, [duplicateIds], ["Duplicate-Delete"])` — flag the duplicates.
4. `updateCRMProviderRecordNotes(duplicate, ...)` — stamp admin context: *"Marked for deletion — merged into <master> by QMS Duplicate Radar on behalf of <operator>, plan #N. Migrated: …"*
5. `resolveCluster(...)` — mark resolved internally.

### 7.3 Admin hand-off
The CRMProvider Admin filters the module by **Tag = Delete** and deletes the flagged records on their own schedule. Optional platform surface: a "Pending admin deletion" list (sourced from `duplicate_merge_actions.merged_record_ids`) so the queue is visible inside the dashboard too.

> Decisions locked (2026-06-08): tag name = `Duplicate-Delete`; reparenting (step 2) runs in **Phase 1**. The red `Duplicate-Delete` tag must be pre-created by the admin in CRMProvider Setup → Tags before first run.

---

## Section 8 — Safety, Rollback, Audit

- **Two-phase gate:** Propose (read) → operator review of field-level diff → Execute (admin). No single-click destructive path.
- **Dry-run** on both endpoints.
- **Full-payload snapshot** before every write (Section 4.2) → `/restore`.
- **CRMProvider note stamping** on the master: `"Merged by QMS Duplicate Radar on behalf of <operator-email>, plan #<id>"` via `updateCRMProviderRecordNotes` — restores human attribution inside CRMProvider under the single-integration-user model.
- **Internal audit:** `duplicate_merge_actions.performed_by` + `duplicate_merge_plans` (proposed/approved/executed-by, full plan + report).
- **RBAC:** `/plan` read-level, `/execute` + `/restore` `requireAdminOrKey`.
- **Idempotency & rate limits:** reuse `bulkCloseLeadsInClusters` patterns; skip already-resolved records; surface CRMProvider cooldowns.

---

## Section 9 — Phasing

| Phase | Deliverable | Risk |
|---|---|---|
| **0** | ✅ DONE — OAuth restored & verified (READ/CREATE/UPDATE). No DELETE needed. | Cleared |
| **1** | Accounts only · migrate-then-tag (`Duplicate-Delete`) · **related-record reparenting** · `addCRMProviderTags`/`removeCRMProviderTags` primitive · `/plan` + `/execute` (dry-run) · planner · agent · note-stamping · field-value snapshot + `/restore` (restore fields + remove tags) · UI diff panel | Medium — non-destructive but reparenting adds multi-record writes |
| **2** | "Pending admin deletion" dashboard list (queue of tagged records, from `duplicate_merge_actions.merged_record_ids`) | Low |
| **3** | Hygiene fixes folded into plan · cross-module migration (Lead↔Contact↔Account, owner reassign, overlap closure) reusing `cross-module-overlaps` + `bulk-close-leads` machinery | Higher — multi-module writes |

---

## Section 10 — Open Questions & Risks to Validate Early

1. ~~Real scopes of the production token~~ — RESOLVED (§3): READ/CREATE/UPDATE verified; no DELETE needed.
2. **Tag name + pre-existence** — confirm the red `Delete`/`Duplicate-Delete` tag is created in CRMProvider Setup → Tags before first run (API only applies existing tags by name); decide final name.
3. **`add_tags` scope behaviour** — confirm tag application succeeds under the current UPDATE scope (quick probe: `add_tags` on a test Account id → want a data/permission result, not `OAUTH_SCOPE_MISMATCH`).
4. ~~Related-record reparenting~~ — DECIDED (2026-06-08): reparent ALL types in Phase 1 (§7.2). Open sub-risk: Activities `What_Id` and Attachment re-upload reliability → fallback-and-warn.
5. **Open deals / won revenue** on a record flagged for tagging — surface in the plan `warnings` so the admin doesn't blind-delete a record with live pipeline.
6. **Owner/permission edge cases** — under the single integration user, the app can edit records the human operator could not; rely on platform RBAC to gate the button.
7. **Master selection** — DECIDED: agent proposes master with a reason; **operator can override** it in the review/diff panel before confirming (§2, §6).

### Admin prerequisites before first run (only the CRMProvider admin can do/confirm these)
- Create the red **`Duplicate-Delete`** tag in CRMProvider **Setup → Tags** (API applies an existing tag only).
- Confirm the integration user's **profile** can EDIT **Deals** and **Contacts** (reparenting writes to those modules), not just Accounts.
- Probe that **`add_tags`** succeeds under the current token (apply to a test Account id → want a data/permission result, not `OAUTH_SCOPE_MISMATCH`).

---

## Appendix — Files to add / touch

**New:** `src/utils/duplicateMergePlanner.ts` · `src/mastra/agents/duplicateResolutionAgent.ts` · migration for `duplicate_merge_plans` + snapshot payload column.
**Touch:** `src/utils/CRMProviderCRM.ts` (`mergeCRMProviderRecords`) · `src/utils/duplicateRadarDatabase.ts` (executor, snapshot extension, `resolveCluster` wiring) · `src/mastra/routes/duplicateRadarRoutes.ts` (`/plan`, `/execute`, `/restore`) · `src/mastra/index.ts` + `promptVersionRegistry.ts` (register agent) · `dashboard/` (UI button + diff panel) · `docs/CRMProvider_OAuth_Setup_2026_05_25.md` (write scopes).
