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
 *   - agent-activity       : audit-trail of every preview/dry-run/apply the autonomous resolver performed
 *   - owner-accountability : who owns the most duplicate records
 *   - preflight-check      : "should we create a record for <X>?" verdict
 */

// ── Manual Actions (Logs tab · operator-driven audit trail) ───────────────
export const manualActionAuditTool = createTool({
  id: "manual-action-audit",
  description:
    "Operator-driven audit trail (duplicate_merge_actions): every Mark Resolved, Mark Dismissed, cross-module partial apply, bulk-split and manual merge, with per-operator totals and recent events. Use for who marked what resolved, what manual actions happened, or an operators recent dispositions. Read-only.",
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .describe(
        "How many recent actions to scan (default 100, max 500). Aggregates are computed over this window.",
      ),
    actionType: z
      .enum(["resolve", "ignore", "module_resolved", "split", "merge"])
      .optional()
      .describe("Filter to one action type. Omit to see all."),
    performedByLike: z
      .string()
      .optional()
      .describe(
        "Substring match on the performed_by field. Useful for 'all actions Sarah took this week' (pass her email or display name).",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    inspected: z.number().optional(),
    byActionType: z
      .object({
        resolve: z.number(),
        ignore: z.number(),
        module_resolved: z.number(),
        split: z.number(),
        merge: z.number(),
      })
      .optional(),
    totalRecordsAffected: z.number().optional(),
    topPerformers: z
      .array(
        z.object({
          performedBy: z.string(),
          actionCount: z.number(),
        }),
      )
      .optional(),
    recentEvents: z
      .array(
        z.object({
          clusterId: z.number().nullable(),
          clusterCompanyName: z.string().nullable(),
          clusterDomain: z.string().nullable(),
          actionType: z.string(),
          recordsAffected: z.number(),
          performedBy: z.string().nullable(),
          notes: z.string().nullable(),
          at: z.string().nullable(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const ctx = (context as any) || {};
      const limit = Math.max(1, Math.min(Number(ctx.limit) || 100, 500));
      const actionTypes = ctx.actionType ? [ctx.actionType] : undefined;
      const performedByLike = ctx.performedByLike || undefined;
      const { getMergeHistoryEnriched } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const rows: any[] = await getMergeHistoryEnriched({
        limit,
        actionTypes,
        performedByLike,
      });
      const byActionType = {
        resolve: 0,
        ignore: 0,
        module_resolved: 0,
        split: 0,
        merge: 0,
      };
      let totalRecordsAffected = 0;
      const performerCounts: Record<string, number> = {};
      const recentEvents: Array<{
        clusterId: number | null;
        clusterCompanyName: string | null;
        clusterDomain: string | null;
        actionType: string;
        recordsAffected: number;
        performedBy: string | null;
        notes: string | null;
        at: string | null;
      }> = [];
      for (const r of rows) {
        const at = String(r.action_type || "") as keyof typeof byActionType;
        if (at in byActionType) byActionType[at]++;
        const ids = Array.isArray(r.merged_record_ids)
          ? r.merged_record_ids
          : typeof r.merged_record_ids === "string"
            ? (() => {
                try {
                  return JSON.parse(r.merged_record_ids);
                } catch {
                  return [];
                }
              })()
            : [];
        const recCount = Array.isArray(ids) ? ids.length : 0;
        totalRecordsAffected += recCount;
        const pb = String(r.performed_by || "").trim();
        if (pb) performerCounts[pb] = (performerCounts[pb] || 0) + 1;
        if (recentEvents.length < 20) {
          recentEvents.push({
            clusterId: r.cluster_id ?? null,
            clusterCompanyName: r.cluster_company_name ?? null,
            clusterDomain: r.cluster_domain ?? null,
            actionType: String(r.action_type || ""),
            recordsAffected: recCount,
            performedBy: pb || null,
            notes: r.notes ?? null,
            at: r.created_at ? new Date(r.created_at).toISOString() : null,
          });
        }
      }
      const topPerformers = Object.entries(performerCounts)
        .map(([performedBy, actionCount]) => ({ performedBy, actionCount }))
        .sort((a, b) => b.actionCount - a.actionCount)
        .slice(0, 5);
      return {
        success: true,
        inspected: rows.length,
        byActionType,
        totalRecordsAffected,
        topPerformers,
        recentEvents,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Agent Activity (Logs tab) ─────────────────────────────────────────────
export const agentActivityTool = createTool({
  id: "agent-activity",
  description:
    "Audit trail of every duplicate-cluster preview / dry-run / apply, by the autonomous agent or an operator, including the agent-vs-human split, survivor-override rate and error totals. Use for what did the AI do, how many applies this week, or the last cluster resolutions. Read-only.",
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .describe(
        "How many recent events to scan (default 100, max 500). Aggregates are computed over this window.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    inspected: z.number().optional(),
    byEventType: z
      .object({
        preview: z.number(),
        dryRun: z.number(),
        applied: z.number(),
      })
      .optional(),
    appliedByAgent: z.number().optional(), // performed_by contains "GRQ Assistant" / "Autonomous Agent"
    appliedByHuman: z.number().optional(),
    overrideRatePct: z.number().optional(), // master_overridden share across applies
    totals: z
      .object({
        fieldsMigrated: z.number(),
        duplicatesTagged: z.number(),
        reparented: z.number(),
        errors: z.number(),
      })
      .optional(),
    recentEvents: z
      .array(
        z.object({
          clusterId: z.number().nullable(),
          eventType: z.string(),
          chosenMaster: z.string().nullable(),
          masterOverridden: z.boolean(),
          fieldsMigrated: z.number(),
          duplicatesTagged: z.number(),
          reparented: z.number(),
          errors: z.number(),
          performedBy: z.string().nullable(),
          at: z.string().nullable(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const limit = Math.max(
        1,
        Math.min(((context as any)?.limit as number) ?? 100, 500),
      );
      const { getResolutionActivity } = await import(
        "../../utils/duplicateResolutionLearning"
      );
      const rows = await getResolutionActivity(limit);
      const byEventType = { preview: 0, dryRun: 0, applied: 0 };
      let appliedByAgent = 0;
      let appliedByHuman = 0;
      let appliedOverrideCount = 0;
      let totalApplied = 0;
      const totals = {
        fieldsMigrated: 0,
        duplicatesTagged: 0,
        reparented: 0,
        errors: 0,
      };
      const recentEvents: Array<{
        clusterId: number | null;
        eventType: string;
        chosenMaster: string | null;
        masterOverridden: boolean;
        fieldsMigrated: number;
        duplicatesTagged: number;
        reparented: number;
        errors: number;
        performedBy: string | null;
        at: string | null;
      }> = [];
      for (const r of rows) {
        const et = String(r.eventType || "").toLowerCase();
        if (et === "preview") byEventType.preview++;
        else if (et === "dry_run" || et === "dryrun") byEventType.dryRun++;
        else if (et === "applied") byEventType.applied++;

        totals.fieldsMigrated += Number(r.fieldsMigrated || 0);
        totals.duplicatesTagged += Number(r.duplicatesTagged || 0);
        totals.reparented += Number(r.reparented || 0);
        totals.errors += Number(r.errors || 0);

        if (et === "applied") {
          totalApplied++;
          if (r.masterOverridden) appliedOverrideCount++;
          const pb = String(r.performedBy || "");
          if (/GRQ Assistant|Autonomous Agent/i.test(pb)) appliedByAgent++;
          else appliedByHuman++;
        }

        if (recentEvents.length < 20) {
          recentEvents.push({
            clusterId: r.clusterId ?? null,
            eventType: r.eventType,
            chosenMaster: r.chosenMaster ?? null,
            masterOverridden: !!r.masterOverridden,
            fieldsMigrated: Number(r.fieldsMigrated || 0),
            duplicatesTagged: Number(r.duplicatesTagged || 0),
            reparented: Number(r.reparented || 0),
            errors: Number(r.errors || 0),
            performedBy: r.performedBy ?? null,
            at: r.at ?? null,
          });
        }
      }
      const overrideRatePct =
        totalApplied > 0
          ? Math.round((appliedOverrideCount / totalApplied) * 1000) / 10
          : 0;
      return {
        success: true,
        inspected: rows.length,
        byEventType,
        appliedByAgent,
        appliedByHuman,
        overrideRatePct,
        totals,
        recentEvents,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Deal Compliance ───────────────────────────────────────────────────────
export const dealComplianceStatusTool = createTool({
  id: "deal-compliance-status",
  description:
    "Sales SOP 7.5.10 ATTACHMENT compliance on Deals in closing stages (Proposal / Agreement Signed / Paid): compliant vs missing-docs counts, per-stage breakdown, and the most-missing document types. Read-only; reports on scans already run from the dashboard.",
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
    "Account Hints triage queue: Deals with a missing or placeholder Account_Name plus the inferred Account and a confidence score (AI auto-resolve gate 70 percent). Use for how many hints are pending or AI-resolve-ready, or how the confidence is scored.",
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

// ── Record Hints (Contact→Account, Deal→Contact) ──────────────────────────
export const recordHintsStatusTool = createTool({
  id: "record-hints-status",
  description:
    "Record Hint queue — cross-module LINK suggestions: contact_account (set Account_Name) and deal_contact (set Contact_Name), with pending / applied / dismissed counts and AI-resolve readiness. Use for any Record Hint question, and whenever someone wants to LINK a stray Contact or Deal.",
  inputSchema: z.object({
    type: z
      .enum(["contact_account", "deal_contact"])
      .optional()
      .describe(
        "Narrow to one hint kind. contact_account = Contact missing Account_Name, deal_contact = Deal missing Contact_Name. Omit to cover both.",
      ),
    status: z
      .enum(["pending", "applied", "dismissed"])
      .optional()
      .describe(
        "Which slice to count. pending = open queue (default), applied = AI or operator wrote the link field, dismissed = operator rejected.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    type: z.string().optional(),
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
      const type = (context as any)?.type as
        | "contact_account"
        | "deal_contact"
        | undefined;
      const status = ((context as any)?.status as string) || "pending";
      const { listRecordLinkHints } = await import(
        "../../utils/recordLinkHints"
      );
      // Pull a wide slice so the distribution is meaningful even on
      // large tenants — the list is capped server-side at 2000.
      const r: any = await listRecordLinkHints({
        type,
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
        type: type || "both",
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
    "Platform-wide duplicate health: active clusters, per-module duplicate counts, confidence tiers, SAR pipeline inflation, duplicate rate vs the 2 percent KPI, resolution rate and last sync. Use for top-level or executive questions.",
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
    "Cross-Module Overlap counts: clusters where an ACTIVE lead and an ACTIVE deal coexist for one company (close the redundant lead), plus the 3-plus-module and CS-owned buckets and ARR exposure. Pass status active | resolved | ignored | all.",
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
    byPairing: z.record(z.number()).optional(), // back-compat: lead_contact / lead_account always 0
    byAction: z.record(z.number()).optional(),  // refined-rule headline counts
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
      // The engine already aggregates by_pairing / by_action and
      // arr_exposure_total; Adam just needs the headline numbers (not
      // the full cluster list).
      return {
        success: true,
        status,
        totalClusters: Number(r?.total ?? 0),
        byPairing: r?.by_pairing ?? {},
        byAction: r?.by_action ?? {},
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
    "CS Pipeline Overlap: clusters where an OPEN sales deal coexists with a Paid or Agreement-Signed handoff deal on the same customer, graded BLOCK / WARN / REVIEW by the churn cool-off. Use for sales-vs-CS cannibalisation or BLOCK/WARN counts.",
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

// ── Cluster merge candidates (Sarah 2026-06-17) ───────────────────────────
// Surfaces same-domain duplicate clusters so Adam can answer
// "how many account clusters are split right now" / "which domains have
// two clusters" / "what should I merge first". Read-only — operator
// runs the merge from the Cluster Merge tab.
export const clusterMergeCandidatesTool = createTool({
  id: "cluster-merge-candidates",
  description:
    "Domains split across 2 or more clusters (a sync race), with the recommended master cluster. Use for I found a second cluster for the same account, or split-cluster questions. Read-only — the operator merges from the Cluster Merge tab.",
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .describe("Max number of domain groups to return (default 50, max 200)."),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    totalGroups: z.number().optional(),
    truncated: z.boolean().optional(),
    groups: z.array(z.record(z.any())).optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const limit = Math.max(1, Math.min((context as any)?.limit ?? 50, 200));
      const { findSameDomainClusterDuplicates } = await import(
        "../../utils/duplicateRadarDatabase"
      );
      const r = await findSameDomainClusterDuplicates({ limit });
      return {
        success: true,
        totalGroups: r.total_groups,
        truncated: r.truncated,
        groups: r.groups as any,
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});

// ── Owner Accountability ──────────────────────────────────────────────────
export const ownerAccountabilityTool = createTool({
  id: "owner-accountability",
  description:
    "Per-owner duplicate scorecard: duplicates owned, duplicate rate, RAG status (green under 2 percent, amber 2-5, red over 5), clusters involved and estimated SAR waste. Use for who is RED, worst offenders, or duplicates by owner.",
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
    "Pre-create verdict for a domain / email / company / phone: duplicate | block | review | pass. BASIC mode runs the contact-duplicate rule then the existing-client check; protected and DOAM accounts and the mandatory-KSA-phone gate run first. Use to vet a new lead or import before creating it.",
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
