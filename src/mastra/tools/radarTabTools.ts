import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Read tools for the remaining Duplicate Radar data tabs, so Adam can answer
 * questions about each one with real numbers (all read-only, reusing the same
 * engines the dashboard tabs use).
 *   - cs-pipeline-overlap : duplicate clusters overlapping live CS customers
 *   - owner-accountability: who owns the most duplicate records
 *   - preflight-check     : "should we create a record for <X>?" verdict
 */

// ── CS Pipeline Overlap ───────────────────────────────────────────────────
export const csOverlapStatusTool = createTool({
  id: "cs-pipeline-overlap-status",
  description:
    "Check the CS Pipeline Overlap tab — how many duplicate clusters have an OPEN Sales Deal coexisting with a Paid or Agreement-Signed handoff Deal on the same customer (cluster-level rule, rewritten 2026-06-11). Verdicts: BLOCK (open + handoff coexist; cool-off not elapsed yet — sales must stop), REVIEW (legacy), WARN (overlap exists but the handoff Deal's churn is past the sector cool-off — 180d Private / 365d Government — sales may re-engage after notifying CS). Use when asked about CS pipeline overlap, sales-vs-CS cannibalisation, or BLOCK/WARN counts.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    block: z.number(),
    review: z.number(),
    warn: z.number(),
    total: z.number(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const { getCsOverlapVerdictCounts } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const c = await getCsOverlapVerdictCounts();
      return { success: true, ...c };
    } catch (e: any) {
      return { success: false, block: 0, review: 0, warn: 0, total: 0, error: e?.message || String(e) };
    }
  },
});

// ── Owner Accountability ──────────────────────────────────────────────────
export const ownerAccountabilityTool = createTool({
  id: "owner-accountability",
  description:
    "Check the Owner Accountability tab — per-owner duplicate scorecard. For each rep returns: team, total records owned, duplicate records, duplicate rate %, RAG status (green ≤2% · amber 2–5% · red >5% per SDR-KPI-09), clusters involved, high-confidence duplicates, and estimated waste value (deal SAR sitting on duplicates). Reps tagged on multiple mailboxes are consolidated under their canonical email (OWNER_EMAIL_ALIASES). Use when asked who is the worst offender, who is RED on the duplicate KPI, which rep has the most waste value, or duplicates by owner. Returns the top owners ranked by duplicate count.",
  inputSchema: z.object({
    limit: z.number().optional().describe("How many top owners to return (default 10, max 50)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    totalOwners: z.number(),
    owners: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const { getOwnerAccountability } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const cap = Math.max(1, Math.min((context as any)?.limit ?? 10, 50));
      // Pull the rich scorecard so Adam can answer RAG / waste / cluster
      // questions — not just raw counts. Already consolidated by
      // OWNER_EMAIL_ALIASES inside the function, sorted dup-desc.
      const rows = await getOwnerAccountability();
      const owners = rows.slice(0, cap).map((o) => ({
        owner: o.owner_name,
        email: o.owner_email,
        team: o.team,
        totalRecords: o.total_records,
        duplicates: o.duplicate_records,
        duplicateRatePct: o.duplicate_rate,
        rag: o.rag_status, // "green" | "amber" | "red"
        clustersInvolved: o.clusters_involved,
        highConfidenceDuplicates: o.high_confidence_duplicates,
        estimatedWasteValue: o.estimated_waste_value,
      }));
      return { success: true, totalOwners: rows.length, owners };
    } catch (e: any) {
      return { success: false, totalOwners: 0, owners: [], error: e?.message || String(e) };
    }
  },
});

// ── Preflight Check ───────────────────────────────────────────────────────
export const preflightCheckTool = createTool({
  id: "preflight-check",
  description:
    "Run the Preflight Check — given a company domain / email / company name / phone, return the verdict on whether a NEW record should be created or it would duplicate / hit a live CS customer. Verdicts: pass (safe to create), duplicate (already in CRM, no active CS overlap), warn (overlap but past the sector cool-off — Sales may re-engage after notifying CS), review (legacy — within cool-off), block (active CS customer, do not push). The fallback chain (added 2026-06-11) tries domain/email-domain first, then normalized phone (≥7 digits) against duplicate_records, then fuzzy company-name (pg_trgm similarity ≥ 0.6) against active clusters — so a phone-only or company-only lookup now finds an existing match. The output `matchedVia` field tells you which path matched. Single-record calls automatically refresh the CS overlap verdict before answering so the result reflects the latest Zoho CS section, not yesterday's cron. Use when asked should we create / add this lead, is this already in the CRM, or to vet a new lead/deal before creation.",
  inputSchema: z.object({
    domain: z.string().optional(),
    email: z.string().optional(),
    company_name: z.string().optional(),
    phone: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    verdict: z.string().optional(),
    shouldCreate: z.boolean().optional(),
    reason: z.string().optional(),
    suggestedAction: z.string().optional(),
    clusterId: z.number().nullable().optional(),
    lifecycleState: z.string().nullable().optional(),
    arrExposure: z.number().nullable().optional(),
    matchedVia: z.string().nullable().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const ctx = context as any;
    const hasIdentity = !!(ctx?.domain || ctx?.email || ctx?.company_name || ctx?.phone);
    if (!hasIdentity) {
      return { success: false, error: "Provide at least one of domain / email / company_name / phone." };
    }
    try {
      const { runPreflight, shouldCreateForVerdict } = await import(
        "../../utils/duplicateRadarPreflight"
      );
      const result = await runPreflight({
        rows: [
          {
            domain: ctx.domain ?? null,
            email: ctx.email ?? null,
            company_name: ctx.company_name ?? null,
            phone: ctx.phone ?? null,
            ref: null,
          },
        ],
        // Single-record chat calls get the fresh verdict by default —
        // Adam is usually asked right when someone is about to create
        // a record, so staleness would be a confusing failure mode.
        refresh_overlap: true,
      });
      const row = result.rows[0];
      if (!row) return { success: false, error: "Preflight returned no verdict." };
      return {
        success: true,
        verdict: row.verdict,
        shouldCreate: shouldCreateForVerdict(row.verdict),
        reason: row.reason,
        suggestedAction: row.suggested_action,
        clusterId: row.cluster_id ?? null,
        lifecycleState: row.lifecycle_state ?? null,
        arrExposure: row.arr_exposure ?? null,
        matchedVia: row.matched_via ?? null,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});
