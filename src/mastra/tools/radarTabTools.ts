import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Read tools for the remaining Duplicate Radar data tabs, so Adam can answer
 * questions about each one with real numbers (all read-only, reusing the same
 * engines the dashboard tabs use).
 *   - executive-summary    : platform-wide KPI tiles (clusters, dup rate, pipeline inflation, resolution rate)
 *   - cs-pipeline-overlap  : duplicate clusters overlapping live CS customers
 *   - cross-module-overlap : same company across ≥2 Zoho modules (Lead+Contact, Lead+Account, …)
 *   - account-hints        : deals missing Account_Name + the inferred-Account verdict (pending/applied/dismissed)
 *   - deal-compliance      : Sales SOP 7.5.10 attachments check on Proposal / Agreement Signed / Paid deals
 *   - owner-accountability : who owns the most duplicate records
 *   - preflight-check      : "should we create a record for <X>?" verdict
 */

// ── Deal Compliance ───────────────────────────────────────────────────────
export const dealComplianceStatusTool = createTool({
  id: "deal-compliance-status",
  description:
    "Check the Deal Compliance tab — Sales SOP 7.5.10 attachments-verification on Deals in the closing stages. The matcher reads Zoho attachment file names and looks for: financial offer (Arabic عرض مالي) for Proposal stage; proposal + contract/PO + VAT certificate + Commercial Registration + National Address for Agreement Signed and Paid (Paid is the Agreement-Signed stage re-labelled for backdated/migrated deals — same five docs). Default stages in scope: Proposal, Agreement Signed, Paid. Returns counts of compliant vs missing-docs deals across the cached scans, plus the breakdown by stage so the user knows which closing stage is the biggest gap. Read-only. Use when asked how many deals are missing documents, which closing stage has the worst compliance, what the Sales SOP attachment gap looks like, or for a Deal Compliance snapshot. Field-level data-entry compliance is on the Quality Dashboard audit (a separate engine) — this tool only covers ATTACHMENTS.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    totalChecked: z.number().optional(),
    compliant: z.number().optional(),
    missingDocs: z.number().optional(),
    byStage: z.record(
      z.object({
        total: z.number(),
        compliant: z.number(),
        missing: z.number(),
      }),
    ).optional(),
    topMissingDocs: z.array(
      z.object({
        label: z.string(),
        count: z.number(),
      }),
    ).optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const { getDealDocCompliance } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      // Pull the latest 5000 persisted scans (the table's natural cap).
      // Each row is one deal's most recent attachment verdict.
      const rows: any[] = await getDealDocCompliance();
      const totalChecked = rows.length;
      const compliant = rows.filter((r) => r.compliant === true).length;
      const missingDocs = totalChecked - compliant;

      // Per-stage breakdown so Adam can say "Proposal: 12 of 30 missing docs"
      const byStage: Record<string, { total: number; compliant: number; missing: number }> = {};
      for (const r of rows) {
        const stage = String(r.stage || "unknown");
        if (!byStage[stage]) byStage[stage] = { total: 0, compliant: 0, missing: 0 };
        byStage[stage].total++;
        if (r.compliant) byStage[stage].compliant++;
        else byStage[stage].missing++;
      }

      // Top-5 missing-document types so Adam can tell the operator which
      // doc is the biggest gap across the corpus.
      const missingCounts: Record<string, number> = {};
      for (const r of rows) {
        if (r.compliant) continue;
        const missing: any[] = Array.isArray(r.missing_docs)
          ? r.missing_docs
          : typeof r.missing_docs === "string"
            ? JSON.parse(r.missing_docs || "[]")
            : [];
        for (const m of missing) {
          const label = String(m?.label ?? m?.key ?? "unknown");
          missingCounts[label] = (missingCounts[label] || 0) + 1;
        }
      }
      const topMissingDocs = Object.entries(missingCounts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      return {
        success: true,
        totalChecked,
        compliant,
        missingDocs,
        byStage,
        topMissingDocs,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Account Hints ─────────────────────────────────────────────────────────
export const accountHintsStatusTool = createTool({
  id: "account-hints-status",
  description:
    "Check the Account Hints tab — Deals in Zoho with missing or placeholder Account_Name where the platform has walked Deal → linked Contact → Contact's email domain → matching Account and inferred which Account to set. Returns the triage queue size, the confidence distribution, and the AI-resolve readiness. Confidence formula (40 base + 25 if two-plus contacts agree + 10 if one contact agrees + 25 if the Account has an explicit domain field + 10 if the Account has any related records, capped at 100). AI auto-resolve gate is 70 percent by default — below that the row stays pending for manual Applied or Dismiss. Every AI write is attributed to GRQ Assistant on behalf of the calling user and writes Account_Name on the Deal in Zoho. Use when asked how many account hints are pending, how many high-confidence hints are ready for one-click resolve, what the inference algorithm does, or any Account Hints status question.",
  inputSchema: z.object({
    status: z
      .enum(["pending", "applied", "dismissed"])
      .optional()
      .describe(
        "Which slice to count. pending = open queue (default), applied = AI or operator wrote Account_Name, dismissed = operator rejected.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string().optional(),
    summary: z
      .object({
        pending: z.number(),
        applied: z.number(),
        dismissed: z.number(),
      })
      .optional(),
    aiResolveReady: z.number().optional(), // pending AND confidence >= 70
    confidenceDistribution: z
      .object({
        high: z.number(), // >= 80
        medium: z.number(), // 60-79
        low: z.number(), // < 60
      })
      .optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const status = ((context as any)?.status as string) || "pending";
      const { listAccountInferenceHints } = await import(
        "../../utils/accountInference"
      );
      // Pull a wide slice so the distribution is meaningful even on
      // large tenants — the list is capped server-side at 2000.
      const r: any = await listAccountInferenceHints({
        status,
        limit: 2000,
      });
      const hints: Array<{ confidence: number; status: string }> = Array.isArray(r?.hints)
        ? r.hints
        : [];
      const aiResolveReady = hints.filter(
        (h) => h.status === "pending" && Number(h.confidence || 0) >= 70,
      ).length;
      const high = hints.filter((h) => Number(h.confidence || 0) >= 80).length;
      const medium = hints.filter((h) => {
        const c = Number(h.confidence || 0);
        return c >= 60 && c < 80;
      }).length;
      const low = hints.filter((h) => Number(h.confidence || 0) < 60).length;
      return {
        success: true,
        status,
        summary: {
          pending: Number(r?.summary?.pending ?? 0),
          applied: Number(r?.summary?.applied ?? 0),
          dismissed: Number(r?.summary?.dismissed ?? 0),
        },
        aiResolveReady,
        confidenceDistribution: { high, medium, low },
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Executive Summary ─────────────────────────────────────────────────────
export const executiveSummaryTool = createTool({
  id: "executive-summary",
  description:
    "Return the platform-wide Duplicate Radar KPIs Sarah's leadership team watches on the Executive Summary tab. Covers total active clusters, per-module duplicate counts (leads/deals/contacts/accounts), strong vs moderate confidence tiers, pipeline inflation in SAR, the SDR-KPI-09 duplicate-lead rate vs the 2% target, resolution rate (resolved+ignored over total), and the last sync info. Use when asked 'what's the current duplicate rate', 'how many active clusters do we have', 'what's the pipeline inflation', 'are we hitting the 2% KPI target', or for a top-level health snapshot. Read-only, reuses the dashboard's /api/duplicates/summary engine.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    trueDuplicateClusters: z.number().optional(),
    totalDuplicateLeads: z.number().optional(),
    totalDuplicateDeals: z.number().optional(),
    totalDuplicateContacts: z.number().optional(),
    totalDuplicateAccounts: z.number().optional(),
    highConfidence: z.number().optional(),
    mediumConfidence: z.number().optional(),
    estimatedPipelineInflationSar: z.number().optional(),
    activeCount: z.number().optional(),
    resolvedCount: z.number().optional(),
    ignoredCount: z.number().optional(),
    resolutionRatePct: z.number().optional(),
    duplicateLeadRatePct: z.number().optional(),
    duplicateDealRatePct: z.number().optional(),
    sdrKpi09Status: z.string().optional(), // "green" | "amber" | "red"
    lastSyncAt: z.string().nullable().optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const { getEnhancedSummary } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const s: any = await getEnhancedSummary();
      const leadRate = Number(
        s?.duplicateLeadRate ?? s?.kpis?.duplicateLeadRate ?? 0,
      );
      // RAG matches the gauge on the dashboard + SDR-KPI-09 bands.
      const sdrKpi09Status =
        leadRate <= 2 ? "green" : leadRate <= 5 ? "amber" : "red";
      const lastSyncAt =
        s?.lastScanInfo?.completed_at
          ? String(s.lastScanInfo.completed_at)
          : null;
      return {
        success: true,
        trueDuplicateClusters: Number(s?.trueDuplicateClusters ?? 0),
        totalDuplicateLeads: Number(s?.totalDuplicateLeads ?? 0),
        totalDuplicateDeals: Number(s?.totalDuplicateDeals ?? 0),
        totalDuplicateContacts: Number(s?.totalDuplicateContacts ?? 0),
        totalDuplicateAccounts: Number(s?.totalDuplicateAccounts ?? 0),
        highConfidence: Number(s?.highConfidence ?? 0),
        mediumConfidence: Number(s?.mediumConfidence ?? 0),
        estimatedPipelineInflationSar: Number(
          s?.estimatedPipelineInflation ?? 0,
        ),
        activeCount: Number(s?.activeCount ?? 0),
        resolvedCount: Number(s?.resolvedCount ?? 0),
        ignoredCount: Number(s?.ignoredCount ?? 0),
        resolutionRatePct: Number(s?.resolutionRate ?? 0),
        duplicateLeadRatePct: leadRate,
        duplicateDealRatePct: Number(
          s?.duplicateDealRate ?? s?.kpis?.duplicateDealRate ?? 0,
        ),
        sdrKpi09Status,
        lastSyncAt,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Cross-Module Overlap ──────────────────────────────────────────────────
export const crossModuleOverlapTool = createTool({
  id: "cross-module-overlap-status",
  description:
    "Check the Cross-Module Overlap tab — duplicate clusters where the same company shows up in 2+ Zoho modules at once (Lead + Contact, Lead + Account, Contact + Account, Lead + Deal, etc.). Returns counts by pairing type, total ARR exposure across the open overlaps, and totals by triage status (open / handled / dismissed). Use when asked how many cross-module overlaps are open, how many Lead-vs-Account conflicts exist, what the cross-module ARR exposure is, or for a snapshot of the cross-module triage queue. The remediation in Zoho for Lead-vs-anything-else is usually CLOSE the duplicate Lead (Zoho doesn't allow cross-module merges); for Contact↔Account / Deal↔Account it's LINK (set Account_Name); for Contact↔Deal it's LINK (set Contact_Name).",
  inputSchema: z.object({
    status: z
      .enum(["active", "resolved", "ignored", "all"])
      .optional()
      .describe(
        "Triage status filter. active=open queue (default), resolved=marked handled, ignored=dismissed, all=every row.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.string().optional(),
    totalClusters: z.number().optional(),
    byPairing: z.record(z.number()).optional(), // { lead_contact: N, lead_account: N, ... }
    arrExposureTotalSar: z.number().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const status =
        ((context as any)?.status as string) || "active";
      const { getCrossModuleOverlaps } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const r: any = await getCrossModuleOverlaps({
        status: status as "active" | "resolved" | "ignored" | "all",
      });
      // The engine already aggregates by_pairing and arr_exposure_total;
      // Adam just needs the headline numbers (not the full cluster list).
      return {
        success: true,
        status,
        totalClusters: Number(r?.total ?? 0),
        byPairing: r?.by_pairing ?? {},
        arrExposureTotalSar: Number(r?.arr_exposure_total ?? 0),
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

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
