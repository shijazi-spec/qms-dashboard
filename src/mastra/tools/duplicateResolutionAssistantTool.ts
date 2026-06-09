/**
 * duplicate-resolution-assistant — lets the AI Consultant chat talk to the
 * autonomous duplicate-resolution agent directly (Sarah's "communicate with
 * each other" requirement).
 *
 * Read + teach actions only — it NEVER writes to Zoho (the gated
 * "duplicate-resolution" tool does that, behind approval). Supported actions:
 *   - status         → current mode / kill-switch / config + latest grades
 *   - list_rules     → the learned routing rules
 *   - make_rule      → teach a durable rule ("don't re-ask this case")
 *   - preview_cluster→ deterministic merge-plan summary for a cluster (no writes)
 *
 * Returned text is meant for the LLM to narrate back to Sarah.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getResolutionRunConfig,
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
import { getRecordsByClusterId } from "../../utils/duplicateRadarDatabase";

const MODULES: CrmModule[] = ["Accounts", "Leads", "Deals", "Contacts"];
function asModule(m: unknown): CrmModule {
  return MODULES.includes(m as CrmModule) ? (m as CrmModule) : "Accounts";
}

export const duplicateResolutionAssistantTool = createTool({
  id: "duplicate-resolution-assistant",
  description:
    "Talk to the autonomous duplicate-resolution agent. Use this when Sarah asks about duplicate resolution: its current status/mode, what it would do for a cluster, the learning rules, or to teach it a new rule (e.g. 'never auto-merge mixed-domain clusters', 'always link contacts to their account'). Read + teach only — it never writes to Zoho.",
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
      .record(z.any())
      .optional()
      .describe(
        'For make_rule: the case pattern to match, e.g. {"mixedDomains":true} or {"layoutSplit":true} or {"module":"Contacts"}.',
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
        return {
          success: true,
          summary:
            `Autonomous resolution is in ${cfg.mode.toUpperCase()} mode, ` +
            `writes ${cfg.enabled ? "ENABLED" : "DISABLED (kill-switch off)"}, ` +
            `up to ${cfg.maxClusters} clusters per 6h tick. Grades — ${gradeLine}.`,
          data: { config: cfg, grades: latest },
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
        const caseSignature = (context as any)?.caseSignature || {};
        const id = await recordResolutionRule({
          module,
          caseSignature,
          decision,
          scope: "pattern",
          createdBy: "GRQ Assistant (on behalf of Sarah Hijazi)",
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
