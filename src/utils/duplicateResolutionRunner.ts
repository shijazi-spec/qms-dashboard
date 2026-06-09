/**
 * Autonomous Duplicate Resolution — THE 6-HOURLY TICK (core orchestration).
 *
 * One `runAutonomousResolution()` call is a complete pass: for every active
 * cluster × module-present, it builds the deterministic merge plan, consults
 * learned rules, runs the "1% doubt" risk gate, and then — gated by the
 * operating mode — either AUTO-APPLIES the safe tier (on behalf of Sarah) or
 * ENQUEUES the doubtful ones to the AI Approvals screen with their reasons.
 * Finally it logs a grade snapshot for the learning curve.
 *
 * This core is intentionally framework-free so the Inngest cron, the
 * in-process fallback (scheduledJobs), and a manual "Run now" admin endpoint
 * can all share it. Every external call is guarded; a single bad cluster never
 * aborts the run.
 *
 * Modes (AUTONOMOUS_RESOLUTION_MODE):
 *   shadow     → dry-run everything, queue everything, WRITE NOTHING to Zoho.
 *   assisted   → auto-apply the safe tier; queue the rest.
 *   autonomous → same as assisted (steady state; kept distinct for clarity/telemetry).
 * Kill switch: AUTONOMOUS_RESOLUTION_ENABLED=false → the runner performs no
 * Zoho writes regardless of mode (still computes verdicts + snapshots in shadow
 * semantics so the learning curve keeps moving).
 */

import {
  getAllClusters,
  getRecordsByClusterId,
  getClusterMixedSignal,
  type DuplicateCluster,
  type DuplicateRecord,
} from "./duplicateRadarDatabase";
import { buildMergePlan, type CrmModule, type MergePlan } from "./duplicateMergePlanner";
import { executeMergePlan } from "./duplicateMergeExecutor";
import {
  evaluateResolutionRisk,
  getResolutionPolicyConfig,
  type ResolutionRiskInput,
  type ResolutionRiskVerdict,
} from "./duplicateResolutionPolicy";
import { evaluateRules } from "./duplicateResolutionRules";
import { recordResolutionEvent } from "./duplicateResolutionLearning";
import { snapshotGrades } from "./duplicateResolutionGrades";
import { enqueuePendingAction, initAIApprovalTable } from "./aiApprovalDatabase";
import { logger } from "./logger";

export type ResolutionMode = "shadow" | "assisted" | "autonomous";

export const AGENT_PERFORMED_BY =
  "QMS Autonomous Agent (on behalf of Sarah Hijazi)";

const RECORD_TYPE_TO_MODULE: Record<string, CrmModule> = {
  account: "Accounts",
  lead: "Leads",
  deal: "Deals",
  contact: "Contacts",
};

export interface ResolutionRunConfig {
  enabled: boolean;
  mode: ResolutionMode;
  /** Max clusters to process per tick (cost guard). */
  maxClusters: number;
}

export function getResolutionRunConfig(): ResolutionRunConfig {
  const mode = (process.env.AUTONOMOUS_RESOLUTION_MODE || "shadow").toLowerCase();
  const safeMode: ResolutionMode =
    mode === "assisted" || mode === "autonomous" ? (mode as ResolutionMode) : "shadow";
  const max = Number(process.env.AUTONOMOUS_RESOLUTION_MAX_CLUSTERS);
  return {
    enabled: process.env.AUTONOMOUS_RESOLUTION_ENABLED === "true",
    mode: safeMode,
    maxClusters: Number.isFinite(max) && max > 0 ? Math.floor(max) : 100,
  };
}

// ── Pure: build the risk-gate input from a cluster + its records + the plan ───

/** Stages we treat as "active" (anything not explicitly lost/dead/junk). */
function isActiveStage(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return !/lost|dead|junk|disqualif/i.test(stage);
}

export interface BuildRiskInputArgs {
  module: CrmModule;
  cluster: Pick<
    DuplicateCluster,
    | "confidence_score"
    | "cs_overlap_verdict"
    | "estimated_pipeline_value"
    | "arr_exposure"
    | "verification_state"
    | "total_leads"
    | "total_deals"
    | "total_contacts"
    | "total_accounts"
  >;
  /** The DuplicateRecords of THIS module's record type (for stage inspection). */
  moduleRecords: Pick<DuplicateRecord, "stage">[];
  plan: MergePlan;
  mixed: { domains: string[]; phones: string[] };
  /** Epoch ms — injectable for tests. */
  nowMs: number;
}

export function buildResolutionRiskInput(args: BuildRiskInputArgs): ResolutionRiskInput {
  const { module, cluster, moduleRecords, plan, mixed, nowMs } = args;
  const included = plan.records.filter((r) => r.included);
  const master = plan.records.find((r) => r.isMaster);

  const presentTypes = [
    cluster.total_leads || 0,
    cluster.total_deals || 0,
    cluster.total_contacts || 0,
    cluster.total_accounts || 0,
  ].filter((n) => n > 0).length;

  const owners = new Set(
    included.map((r) => (r.owner || "").trim()).filter((o) => o !== ""),
  );
  const layouts = new Set(
    included.map((r) => (r.layout || "").trim()).filter((l) => l !== ""),
  );

  let minDays = Infinity;
  for (const r of included) {
    if (!r.modifiedDate) continue;
    const t = Date.parse(r.modifiedDate);
    if (Number.isNaN(t)) continue;
    const days = (nowMs - t) / 86_400_000;
    if (days < minDays) minDays = days;
  }

  return {
    module,
    confidenceScore: cluster.confidence_score ?? 0,
    mixedDomains: mixed.domains.length,
    mixedPhones: mixed.phones.length,
    csOverlapVerdict: cluster.cs_overlap_verdict ?? null,
    pipelineValue: cluster.estimated_pipeline_value ?? 0,
    arrExposure: cluster.arr_exposure ?? 0,
    verificationFailed: cluster.verification_state === "failed",
    conflictCount: plan.fieldDecisions.filter((d) => d.action === "conflict").length,
    hasCustomFieldAssumption: plan.warnings.some((w) => /custom field/i.test(w)),
    anyMissingZohoId: plan.masterZohoId == null || included.some((r) => !r.hasZohoId),
    masterCompleteness: master?.completeness ?? 0,
    distinctOwners: owners.size,
    distinctLayouts: layouts.size,
    minDaysSinceModified: minDays,
    anyActiveDealStage:
      module === "Deals" && moduleRecords.some((r) => isActiveStage(r.stage)),
    isCrossModule: presentTypes > 1,
  };
}

/** Compact, normalized features for rule-matching (what Sarah's rules key on). */
export function buildRuleFeatures(
  input: ResolutionRiskInput,
): Record<string, unknown> {
  return {
    module: input.module,
    mixedDomains: input.mixedDomains >= 2,
    mixedPhones: input.mixedPhones >= 2,
    layoutSplit: input.distinctLayouts >= 2,
    multiOwner: input.distinctOwners > 1,
    crossModule: input.isCrossModule,
    csOverlap: input.csOverlapVerdict,
    hasPipeline: input.pipelineValue > 0 || input.arrExposure > 0,
  };
}

// ── Run summary ───────────────────────────────────────────────────────────────

export interface ResolutionRunItem {
  clusterId: number;
  module: CrmModule;
  verdict: "auto" | "escalate";
  ruleOverride: "auto" | "escalate" | null;
  reasons: string[];
  action: "applied" | "queued" | "shadow_queued" | "skipped" | "error";
  detail?: string;
}

export interface ResolutionRunSummary {
  startedAt: string;
  finishedAt: string;
  mode: ResolutionMode;
  enabled: boolean;
  clustersScanned: number;
  plansBuilt: number;
  applied: number;
  queued: number;
  errors: number;
  items: ResolutionRunItem[];
}

function riskLevelFor(reasons: string[]): "low" | "medium" | "high" | "critical" {
  if (reasons.length === 0) return "low";
  const text = reasons.join(" ").toLowerCase();
  if (/pipeline|arr|active deal|cs overlap/.test(text)) return "critical";
  if (/confidence|conflict|no zoho id|verification/.test(text)) return "high";
  return "medium";
}

/**
 * Run one full autonomous-resolution tick. Safe to call from cron, the
 * in-process fallback, or a manual admin endpoint. Never throws — failures are
 * captured per-cluster and in the summary.
 */
export async function runAutonomousResolution(
  opts: { now?: number; modeOverride?: ResolutionMode } = {},
): Promise<ResolutionRunSummary> {
  const startedAt = new Date().toISOString();
  const nowMs = opts.now ?? Date.now();
  const cfg = getResolutionRunConfig();
  const mode = opts.modeOverride ?? cfg.mode;
  const policyCfg = getResolutionPolicyConfig();

  const summary: ResolutionRunSummary = {
    startedAt,
    finishedAt: startedAt,
    mode,
    enabled: cfg.enabled,
    clustersScanned: 0,
    plansBuilt: 0,
    applied: 0,
    queued: 0,
    errors: 0,
    items: [],
  };

  // Writes only happen in assisted/autonomous AND when the kill switch is on.
  const writesAllowed = cfg.enabled && (mode === "assisted" || mode === "autonomous");

  try {
    await initAIApprovalTable().catch(() => {});

    const clusters = await getAllClusters({ status: "active", limit: cfg.maxClusters });
    logger.info("[dup-resolution-runner] tick start", {
      mode,
      enabled: cfg.enabled,
      writesAllowed,
      clusters: clusters.length,
    });

    for (const cluster of clusters) {
      const clusterId = cluster.id;
      if (clusterId == null) continue;
      summary.clustersScanned++;

      let records: DuplicateRecord[];
      try {
        records = await getRecordsByClusterId(clusterId);
      } catch (e) {
        summary.errors++;
        summary.items.push({
          clusterId,
          module: "Accounts",
          verdict: "escalate",
          ruleOverride: null,
          reasons: ["could not load cluster records"],
          action: "error",
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }

      // Which modules have ≥2 records of their record type?
      const byType = new Map<string, DuplicateRecord[]>();
      for (const r of records) {
        const arr = byType.get(r.record_type) || [];
        arr.push(r);
        byType.set(r.record_type, arr);
      }

      let mixed = { domains: [] as string[], phones: [] as string[] };
      try {
        const m = await getClusterMixedSignal(clusterId);
        mixed = { domains: m.domains, phones: m.phones };
      } catch {
        /* non-fatal */
      }

      for (const [recordType, moduleRecords] of byType.entries()) {
        const module = RECORD_TYPE_TO_MODULE[recordType];
        if (!module || moduleRecords.length < 2) continue;

        await processModule({
          cluster,
          clusterId,
          module,
          allRecords: records,
          moduleRecords,
          mixed,
          nowMs,
          mode,
          writesAllowed,
          policyCfg,
          summary,
        });
      }
    }

    // Learning-curve snapshot every tick (best-effort).
    await snapshotGrades().catch(() => {});
  } catch (e) {
    summary.errors++;
    logger.error("[dup-resolution-runner] tick failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  summary.finishedAt = new Date().toISOString();
  logger.info("[dup-resolution-runner] tick done", {
    scanned: summary.clustersScanned,
    plans: summary.plansBuilt,
    applied: summary.applied,
    queued: summary.queued,
    errors: summary.errors,
  });
  return summary;
}

async function processModule(ctx: {
  cluster: DuplicateCluster;
  clusterId: number;
  module: CrmModule;
  allRecords: DuplicateRecord[];
  moduleRecords: DuplicateRecord[];
  mixed: { domains: string[]; phones: string[] };
  nowMs: number;
  mode: ResolutionMode;
  writesAllowed: boolean;
  policyCfg: ReturnType<typeof getResolutionPolicyConfig>;
  summary: ResolutionRunSummary;
}): Promise<void> {
  const {
    cluster,
    clusterId,
    module,
    allRecords,
    moduleRecords,
    mixed,
    nowMs,
    mode,
    writesAllowed,
    policyCfg,
    summary,
  } = ctx;

  let plan: MergePlan;
  try {
    plan = buildMergePlan(module, clusterId, allRecords, {
      generatedBy: AGENT_PERFORMED_BY,
      generatedAt: new Date(nowMs).toISOString(),
    });
    summary.plansBuilt++;
  } catch (e) {
    summary.errors++;
    summary.items.push({
      clusterId,
      module,
      verdict: "escalate",
      ruleOverride: null,
      reasons: ["plan build failed"],
      action: "error",
      detail: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const riskInput = buildResolutionRiskInput({
    module,
    cluster,
    moduleRecords,
    plan,
    mixed,
    nowMs,
  });
  const features = buildRuleFeatures(riskInput);

  // Rules consulted BEFORE the gate — they may flip the verdict ("don't re-ask").
  const ruleResult = await evaluateRules(module, features, clusterId).catch(() => ({
    override: null as "auto" | "escalate" | null,
    alwaysLink: false,
    ruleIds: [] as number[],
  }));

  const gate: ResolutionRiskVerdict = evaluateResolutionRisk(riskInput, policyCfg);
  const verdict: "auto" | "escalate" = ruleResult.override ?? gate.verdict;
  const reasons =
    ruleResult.override === "auto"
      ? [`auto-approved by learned rule(s) #${ruleResult.ruleIds.join(", #")}`]
      : ruleResult.override === "escalate"
        ? [`blocked by learned rule(s) #${ruleResult.ruleIds.join(", #")}`, ...gate.reasons]
        : gate.reasons;

  // Apply the always-link rule hint to the plan if present and unset.
  if (ruleResult.alwaysLink && !plan.linkAccountZohoId && plan.accountCandidates.length) {
    plan.linkAccountZohoId = plan.accountCandidates[0].zohoId;
  }

  const item: ResolutionRunItem = {
    clusterId,
    module,
    verdict,
    ruleOverride: ruleResult.override,
    reasons,
    action: "skipped",
  };

  // AUTO + writes allowed → apply for real (on behalf of Sarah).
  if (verdict === "auto" && writesAllowed) {
    try {
      const report = await executeMergePlan(plan, {
        performedBy: AGENT_PERFORMED_BY,
        dryRun: false,
        closeCluster: !riskInput.isCrossModule,
      });
      item.action = report.errors.length ? "error" : "applied";
      item.detail = report.errors.length
        ? report.errors.map((e) => e.message).join("; ")
        : `tagged ${report.taggedRecordIds.length}, fields ${report.fieldsMigrated.length}`;
      if (report.errors.length) summary.errors++;
      else summary.applied++;
      await recordResolutionEvent({
        clusterId,
        eventType: "applied",
        plan,
        report,
        fieldsMigrated: report.fieldsMigrated.length,
        duplicatesTagged: report.taggedRecordIds.length,
        reparented:
          report.reparented.deals + report.reparented.contacts + report.reparented.notes,
        errors: report.errors.length,
        performedBy: AGENT_PERFORMED_BY,
      }).catch(() => {});
    } catch (e) {
      item.action = "error";
      item.detail = e instanceof Error ? e.message : String(e);
      summary.errors++;
    }
    summary.items.push(item);
    return;
  }

  // Otherwise → dry-run for the record, then queue to the approval screen.
  try {
    await executeMergePlan(plan, { performedBy: AGENT_PERFORMED_BY, dryRun: true }).catch(
      () => {},
    );
    await recordResolutionEvent({
      clusterId,
      eventType: "dry_run",
      plan,
      performedBy: AGENT_PERFORMED_BY,
    }).catch(() => {});

    await enqueuePendingAction({
      toolId: "duplicate-resolution",
      toolLabel: `Resolve duplicates — ${module} cluster #${clusterId}`,
      payload: {
        clusterId,
        module,
        plan,
        verdict,
        ruleOverride: ruleResult.override,
        reasons,
        recommendation:
          verdict === "auto"
            ? "Safe to apply — agent would auto-apply once autonomy is enabled."
            : "Needs your call — escalated on the reasons listed.",
        features,
      },
      payloadPreview:
        `${module} cluster #${clusterId}: survivor "${plan.masterName}", ` +
        `${plan.duplicateZohoIds.length} duplicate(s) to tag. ` +
        (reasons.length ? `Escalated: ${reasons.slice(0, 3).join("; ")}.` : "Safe-tier (shadow)."),
      riskLevel: riskLevelFor(reasons),
      complianceRefs: [
        "ISO 9001:2015 §8.5.1",
        "ISO 9001:2015 §7.5",
        ...(module === "Contacts" || module === "Leads" ? ["PDPL"] : []),
        "ISO 27001 A.8.3 (non-repudiation)",
      ],
      requestedByUserId: null,
      requestedByEmail: null,
      requestedByName: AGENT_PERFORMED_BY,
      threadId: null,
      ttlHours: 24 * 14,
    });
    item.action = mode === "shadow" ? "shadow_queued" : "queued";
    summary.queued++;
  } catch (e) {
    item.action = "error";
    item.detail = e instanceof Error ? e.message : String(e);
    summary.errors++;
  }
  summary.items.push(item);
}
