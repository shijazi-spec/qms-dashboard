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
    "Check the CS Pipeline Overlap tab — how many active duplicate clusters overlap a LIVE Customer Success customer, by verdict: BLOCK (active customer — do not touch), REVIEW (needs a human look), WARN (caution). Use when asked about CS pipeline overlap, duplicates on existing customers, or block/review counts.",
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
    "Check the Owner Accountability tab — which record owners have the most duplicate records in the CRM (leads + deals). Use when asked who is creating/holding the most duplicates, the worst offenders, or duplicates by owner. Returns the top owners ranked by duplicate count.",
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
      const { getDuplicatesByOwner } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const cap = Math.max(1, Math.min((context as any)?.limit ?? 10, 50));
      const rows = await getDuplicatesByOwner();
      const owners = rows.slice(0, cap).map((o) => ({
        owner: o.owner_name,
        email: o.owner_email,
        leads: Number(o.lead_count) || 0,
        deals: Number(o.deal_count) || 0,
        totalDuplicates: Number(o.total_duplicates) || 0,
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
    "Run the Preflight Check — given a company domain / email / company name / phone, return the verdict on whether a NEW record should be created or it would duplicate / hit a live CS customer: pass (safe to create), duplicate (already exists), warn, review, or block (active customer). Use when asked 'should we create / add <X>?', 'is <X> already in the CRM?', or to vet a new lead/deal before creation.",
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
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});
