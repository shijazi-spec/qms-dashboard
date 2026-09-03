/**
 * duplicate-resolution-assistant — lets the AI Consultant chat talk to the
 * autonomous duplicate-resolution agent directly (Sample User's "communicate with
 * each other" requirement).
 *
 * Read + teach actions only — it NEVER writes to Zoho (the gated
 * "duplicate-resolution" tool does that, behind approval). Supported actions:
 *   - status         → current mode / kill-switch / config + latest grades
 *   - list_rules     → the learned routing rules
 *   - make_rule      → teach a durable rule ("don't re-ask this case")
 *   - preview_cluster→ deterministic merge-plan summary for a cluster (no writes)
 *
 * Returned text is meant for the LLM to narrate back to Sample User.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getResolutionRunConfig,
  getModuleResolutionBreakdown,
  getRecentApplyStats,
} from "../../utils/duplicateResolutionRunner";
import {
  listResolutionRules,
  recordResolutionRule,
  type RuleDecision,
} from "../../utils/duplicateResolutionRules";
import { getGradeHistory } from "../../utils/duplicateResolutionGrades";
import {
  buildMergePlan,
  MODULE_RECORD_TYPE,
  type CrmModule,
} from "../../utils/duplicateMergePlanner";
import {
  getRecordsByClusterId,
  getClusterSummary,
  getPreviousExecBriefSnapshot,
} from "../../utils/duplicateRadarDatabase";

const MODULES: CrmModule[] = ["Accounts", "Leads", "Deals", "Contacts"];
function asModule(m: unknown): CrmModule {
  return MODULES.includes(m as CrmModule) ? (m as CrmModule) : "Accounts";
}

export const duplicateResolutionAssistantTool = createTool({
  id: "duplicate-resolution-assistant",
  description:
    "Talk to the autonomous duplicate-resolution agent. Use this when Sample User duplicate resolution: its current status/mode, what it would do for a cluster, the learning rules, or to teach it a new rule (e.g. 'never auto-merge mixed-domain clusters', 'always link contacts to their account'). Read + teach only — it never writes to Zoho.",
  inputSchema: z.object({
    action: z
      .enum(["status", "list_rules", "make_rule", "preview_cluster"])
      .describe("Which operation to perform."),
    module: z
      .enum(["Accounts", "Leads", "Deals", "Contacts"])
      .optional()
      .describe("CRM module (for make_rule / preview_cluster)."),
    clusterId: z.number().optional().describe("Cluster id (for preview_cluster)."),
    decision: z
      .enum(["auto_approve", "never_merge", "always_link"])
      .optional()
      .describe("Rule decision (for make_rule)."),
    caseSignature: z
      .string()
      .optional()
      .describe(
        'For make_rule: the case pattern to match, as a JSON object string, e.g. {"mixedDomains":true} or {"layoutSplit":true} or {"module":"Contacts"}.',
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string(),
    data: z.any().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const action = (context as any)?.action as string;
    try {
      if (action === "status") {
        const cfg = getResolutionRunConfig();
        const grades = await getGradeHistory(undefined, 16).catch(() => []);
        const latest: Record<string, any> = {};
        for (const g of grades) if (!latest[g.module]) latest[g.module] = g;
        const gradeLine = MODULES.map((m) => {
          const g = latest[m];
          return `${m}: G${g?.grade ?? 1} ${g?.label ?? "Trainee"}`;
        }).join(", ");
        // Aggregate figures so the agent can produce an EXECUTIVE summary
        // (totals + SAR exposure + resolved-vs-remaining), not just grades.
        const summaryStats = await getClusterSummary().catch(() => null);
        const breakdown = await getModuleResolutionBreakdown().catch(() => []);
        const totalSolved = breakdown.reduce((a, b) => a + (b.solved || 0), 0);
        // HONEST "merged" accounting: `applied` = clusters with a REAL merge
        // action (duplicates actually tagged Duplicate-Delete in Zoho); a
        // status='resolved' cluster with NO merge action was NEVER merged. Never
        // report status='resolved' as "merged data" — that conflation is the
        // exact bug the high-confidence auto-resolve caused.
        const totalApplied = breakdown.reduce((a, b) => a + (b.applied || 0), 0);
        const totalMarkedOnly = breakdown.reduce((a, b) => a + (b.markedOnly || 0), 0);
        const totalActive = summaryStats?.activeCount ?? 0;
        const exposure = summaryStats?.estimatedPipelineInflation ?? 0;
        const perModuleMerged = breakdown
          .filter((b) => b.total > 0)
          .map((b) => `${b.module}: ${b.applied} merged / ${b.total} clusters`)
          .join(", ");
        // REAL progress, honestly sourced. recentApplies = actual merges in the
        // last 7d from the append-only feedback log (survives rebuilds). prevSnap
        // = the last recorded weekly exec-brief snapshot, for a true before/after.
        // Use THESE for any "is there progress / previous vs current" question —
        // never invent a number or reuse one from earlier in the chat.
        const recentApplies = await getRecentApplyStats(24 * 7).catch(() => null);
        const prevSnap = await getPreviousExecBriefSnapshot().catch(() => null);
        return {
          success: true,
          summary:
            `Autonomous resolution is in ${cfg.mode.toUpperCase()} mode, ` +
            `writes ${cfg.enabled ? "ENABLED" : "DISABLED (kill-switch off)"}, ` +
            `up to ${cfg.maxClusters} clusters per 6h tick. ` +
            (cfg.mode === "shadow"
              ? "In SHADOW mode the agent makes NO automatic Zoho writes, so any merges are operator-driven Applies only. "
              : "") +
            (summaryStats
              ? `Duplicate exposure: ${summaryStats.totalClusters} clusters, ` +
                `~SAR ${Math.round(exposure).toLocaleString()} estimated pipeline inflation. ` +
                `ACTUALLY MERGED (real Apply / Duplicate-Delete tags): ${totalApplied} clusters` +
                (perModuleMerged ? ` (${perModuleMerged}). ` : ". ") +
                `${totalActive} still open. ` +
                (totalMarkedOnly > 0
                  ? `NOTE: ${totalMarkedOnly} cluster(s) are marked 'resolved' WITHOUT any merge action — these were closed but NOT actually merged (legacy auto-resolve or manual Mark-Resolved); do not count them as merged data. They can be re-opened. `
                  : "")
              : "") +
            (recentApplies
              ? `PROGRESS (real merges, last 7 days, survives rebuilds): ${recentApplies.applies} apply(ies)` +
                (recentApplies.applies > 0
                  ? ` (${recentApplies.agentApplies} agent · ${recentApplies.humanApplies} people · ${recentApplies.duplicatesTagged} duplicates tagged). `
                  : " — nothing was merged in the last week. ")
              : "") +
            `Agent maturity — ${gradeLine}.`,
          data: {
            config: cfg,
            grades: latest,
            aggregate: summaryStats,
            byModule: breakdown,
            totalSolved,
            totalApplied,
            totalMarkedOnly,
            recentApplies,
            previousSnapshot: prevSnap,
          },
        };
      }

      if (action === "list_rules") {
        const rules = await listResolutionRules(true);
        const summary = rules.length
          ? `${rules.length} learning rule(s): ` +
            rules
              .slice(0, 20)
              .map(
                (r) =>
                  `#${r.id} ${r.module} ${r.decision} ${JSON.stringify(r.caseSignature)}${r.enabled ? "" : " (disabled)"}`,
              )
              .join("; ")
          : "No learning rules yet.";
        return { success: true, summary, data: { rules } };
      }

      if (action === "make_rule") {
        const decision = (context as any)?.decision as RuleDecision;
        if (!["auto_approve", "never_merge", "always_link"].includes(decision)) {
          return {
            success: false,
            summary: "",
            error: "decision must be auto_approve, never_merge, or always_link",
          };
        }
        const module = asModule((context as any)?.module);
        let caseSignature: Record<string, unknown> = {};
        const rawSig = (context as any)?.caseSignature;
        if (rawSig && typeof rawSig === "object") {
          caseSignature = rawSig as Record<string, unknown>;
        } else if (typeof rawSig === "string" && rawSig.trim()) {
          try {
            caseSignature = JSON.parse(rawSig);
          } catch {
            return { success: false, summary: "", error: "caseSignature must be a valid JSON object string." };
          }
        }
        const id = await recordResolutionRule({
          module,
          caseSignature,
          decision,
          scope: "pattern",
          createdBy: "Sample User",
        });
        if (id == null) {
          return { success: false, summary: "", error: "Could not save the rule." };
        }
        return {
          success: true,
          summary: `Learned rule #${id}: for ${module}, ${decision} when the case matches ${JSON.stringify(caseSignature)}. I won't re-ask similar cases.`,
          data: { id },
        };
      }

      if (action === "preview_cluster") {
        const clusterId = Number((context as any)?.clusterId);
        if (!Number.isFinite(clusterId)) {
          return { success: false, summary: "", error: "clusterId is required for preview_cluster." };
        }
        const module = asModule((context as any)?.module);
        const records = await getRecordsByClusterId(clusterId);
        const moduleCount = records.filter(
          (r) => r.record_type === MODULE_RECORD_TYPE[module],
        ).length;
        if (moduleCount < 2) {
          return {
            success: false,
            summary: "",
            error: `Cluster #${clusterId} has fewer than 2 ${module} records to merge.`,
          };
        }
        const plan = buildMergePlan(module, clusterId, records, {
          generatedBy: "ai-consultant",
          generatedAt: new Date().toISOString(),
        });
        return {
          success: true,
          summary:
            `Plan for ${module} cluster #${clusterId}: survivor "${plan.masterName}" (${plan.masterReason}). ` +
            `Would tag ${plan.duplicateZohoIds.length} duplicate(s), migrate ${plan.fieldDecisions.length} field(s). ` +
            (plan.warnings.length ? `Warnings: ${plan.warnings.join("; ")}.` : "No warnings."),
          data: { plan },
        };
      }

      return { success: false, summary: "", error: `Unknown action "${action}".` };
    } catch (e) {
      return {
        success: false,
        summary: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
