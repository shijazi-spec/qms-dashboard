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
  getClusterById,
  captureClusterSnapshot,
  updateClusterStatus,
  pool,
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
import { fetchRecordAttachments, removeZohoTags } from "./zohoCRM";
import { logger } from "./logger";

/**
 * Inspect the to-be-tagged duplicates for Zoho attachments. Returns one entry
 * per duplicate that carries evidence (count = -1 means "couldn't verify" — a
 * Zoho error, treated conservatively as evidence-present so a hiccup never
 * green-lights a merge that might drop a contract). Bounded: called ONLY for
 * clusters the agent would otherwise auto-apply. `module` is the Zoho module
 * name (Accounts/Leads/Deals/Contacts).
 */
async function attachmentsOnDuplicates(
  module: CrmModule,
  duplicateZohoIds: string[],
): Promise<Array<{ zohoId: string; count: number }>> {
  const found: Array<{ zohoId: string; count: number }> = [];
  for (const id of duplicateZohoIds) {
    if (!id) continue;
    try {
      const atts = await fetchRecordAttachments(module, id);
      if (atts && atts.length > 0) found.push({ zohoId: id, count: atts.length });
    } catch (e) {
      found.push({ zohoId: id, count: -1 }); // unknown → conservative
      logger.warn("[dup-resolution-runner] attachment check failed (treating as has-files)", {
        module,
        recordId: id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return found;
}

export type ResolutionMode = "shadow" | "assisted" | "autonomous";

/**
 * The private resolution channel: #grq-platform-assistant (Sarah + the agent +
 * her manager). Overridable via env if the channel ever moves. The QMS Slack
 * bot must be a member of this channel and SLACK_BOT_TOKEN must be set.
 */
export const RESOLUTION_SLACK_CHANNEL_DEFAULT = "C0B93BCJFFV";
export function getResolutionSlackChannel(): string {
  return process.env.AUTONOMOUS_RESOLUTION_SLACK_CHANNEL || RESOLUTION_SLACK_CHANNEL_DEFAULT;
}
export function isResolutionSlackConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN && !!getResolutionSlackChannel();
}

/**
 * Per-tick ping to the private resolution Slack channel. No-op unless
 * SLACK_BOT_TOKEN is set (the bot must be a member of the channel). Stays quiet
 * on empty ticks to avoid 6-hourly noise.
 */
async function pingResolutionSlack(summary: ResolutionRunSummary): Promise<void> {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = getResolutionSlackChannel();
    if (!token || !channel) return;
    if (summary.clustersScanned === 0) return;
    if (summary.applied === 0 && summary.queued === 0 && summary.errors === 0) return;

    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const link = `${base}/autonomous-resolution`;
    const icon = summary.errors > 0 ? "🔴" : summary.queued > 0 ? "🟡" : "🟢";
    const text =
      `${icon} *Autonomous Resolution — ${summary.mode} run* ` +
      (summary.enabled ? "" : "(shadow: no Zoho writes) ") +
      `\nScanned ${summary.clustersScanned} · applied ${summary.applied} · ` +
      `queued ${summary.queued} · errors ${summary.errors}` +
      (summary.queued > 0 ? `\n${summary.queued} item(s) need your call.` : "") +
      `\n<${link}|Open the Autonomous Resolution screen>`;

    const { WebClient } = await import("@slack/web-api");
    await new WebClient(token).chat.postMessage({ channel, text });
  } catch (e) {
    logger.warn("[dup-resolution-runner] slack ping failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Post a one-off test message to the resolution channel — powers the
 * "Send test ping" button so the channel wiring can be confirmed on demand.
 * Surfaces the exact Slack error (e.g. not_in_channel, invalid_auth) so the
 * operator knows precisely what to fix.
 */
export async function sendResolutionSlackTest(
  triggeredBy = "operator",
): Promise<{ ok: boolean; channel: string | null; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = getResolutionSlackChannel();
  if (!token) return { ok: false, channel, error: "SLACK_BOT_TOKEN is not set." };
  if (!channel) return { ok: false, channel: null, error: "No resolution Slack channel configured." };
  try {
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    const link = `${base}/autonomous-resolution`;
    const { WebClient } = await import("@slack/web-api");
    await new WebClient(token).chat.postMessage({
      channel,
      text:
        `✅ *Autonomous Resolution — test ping*\n` +
        `Channel wiring confirmed by ${triggeredBy}. You'll get a summary here after each 6h run.` +
        `\n<${link}|Open the Autonomous Resolution screen>`,
    });
    return { ok: true, channel };
  } catch (e) {
    return { ok: false, channel, error: e instanceof Error ? e.message : String(e) };
  }
}

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
  /** Count of to-be-tagged duplicates carrying Zoho attachments (default 0). */
  duplicatesWithAttachments?: number;
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
    duplicatesWithAttachments: args.duplicatesWithAttachments ?? 0,
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
      await processCluster({ cluster, nowMs, mode, writesAllowed, policyCfg, summary });
    }

    // Learning-curve snapshot every tick (best-effort).
    await snapshotGrades().catch(() => {});
  } catch (e) {
    summary.errors++;
    logger.error("[dup-resolution-runner] tick failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  await pingResolutionSlack(summary).catch(() => {});

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

/**
 * Re-do: re-run the resolution for ONE cluster now (Agent Activity log action).
 * Honours the same mode/kill-switch as the scheduled tick.
 */
export async function runResolutionForCluster(
  clusterId: number,
  opts: { now?: number; modeOverride?: ResolutionMode } = {},
): Promise<ResolutionRunSummary> {
  const startedAt = new Date().toISOString();
  const nowMs = opts.now ?? Date.now();
  const cfg = getResolutionRunConfig();
  const mode = opts.modeOverride ?? cfg.mode;
  const policyCfg = getResolutionPolicyConfig();
  const writesAllowed = cfg.enabled && (mode === "assisted" || mode === "autonomous");

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
  try {
    await initAIApprovalTable().catch(() => {});
    const cluster = await getClusterById(clusterId);
    if (!cluster) {
      summary.errors++;
      summary.items.push({
        clusterId,
        module: "Accounts",
        verdict: "escalate",
        ruleOverride: null,
        reasons: ["cluster not found"],
        action: "error",
      });
    } else {
      await processCluster({ cluster, nowMs, mode, writesAllowed, policyCfg, summary });
    }
  } catch (e) {
    summary.errors++;
    logger.error("[dup-resolution-runner] run-cluster failed", {
      clusterId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

/**
 * Undo the agent's last apply on a cluster: remove the Duplicate-Delete tags it
 * placed and reopen the cluster for review. Field gap-fills onto the survivor
 * are left in place — they only filled blanks (non-destructive). Reverses the
 * one consequential, irreversible-by-others signal (the admin delete-tag).
 */
export async function undoClusterResolution(
  clusterId: number,
  performedBy = AGENT_PERFORMED_BY,
): Promise<{ ok: boolean; untagged: number; module: string | null; message: string }> {
  try {
    const r = await pool.query(
      `SELECT plan_json, report_json
         FROM duplicate_resolution_feedback
        WHERE cluster_id = $1 AND event_type = 'applied'
        ORDER BY created_at DESC LIMIT 1`,
      [clusterId],
    );
    if (!r.rows.length) {
      return { ok: false, untagged: 0, module: null, message: "No applied action found for this cluster." };
    }
    const plan = r.rows[0].plan_json
      ? typeof r.rows[0].plan_json === "string"
        ? JSON.parse(r.rows[0].plan_json)
        : r.rows[0].plan_json
      : {};
    const report = r.rows[0].report_json
      ? typeof r.rows[0].report_json === "string"
        ? JSON.parse(r.rows[0].report_json)
        : r.rows[0].report_json
      : {};
    const module: string = plan.module || "Accounts";
    const taggedIds: string[] = (report.taggedRecordIds || plan.duplicateZohoIds || []).filter(
      Boolean,
    );
    let untagged = 0;
    if (taggedIds.length) {
      await removeZohoTags(module, taggedIds, ["Duplicate-Delete"]);
      untagged = taggedIds.length;
    }
    await updateClusterStatus(clusterId, "active").catch(() => {});
    await recordResolutionEvent({
      clusterId,
      eventType: "dry_run", // closest available type; performedBy marks it an UNDO
      plan,
      performedBy: `UNDO by ${performedBy}`,
    }).catch(() => {});
    logger.info("[dup-resolution-runner] undo complete", { clusterId, module, untagged });
    return {
      ok: true,
      untagged,
      module,
      message: `Removed the Duplicate-Delete tag from ${untagged} record(s) and reopened cluster #${clusterId}. Survivor gap-fills were kept (they only filled blanks).`,
    };
  } catch (e) {
    return {
      ok: false,
      untagged: 0,
      module: null,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Process every module-present in one cluster. Shared by the full tick and
 *  the single-cluster Re-do path. Mutates `summary` in place. */
async function processCluster(ctx: {
  cluster: DuplicateCluster;
  nowMs: number;
  mode: ResolutionMode;
  writesAllowed: boolean;
  policyCfg: ReturnType<typeof getResolutionPolicyConfig>;
  summary: ResolutionRunSummary;
}): Promise<void> {
  const { cluster, nowMs, mode, writesAllowed, policyCfg, summary } = ctx;
  const clusterId = cluster.id;
  if (clusterId == null) return;
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
    return;
  }

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

  let riskInput = buildResolutionRiskInput({
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

  // Evidence-protection check is a Zoho call, so run it ONLY for clusters that
  // would otherwise auto-apply (and aren't already rule-blocked). If any
  // to-be-tagged duplicate carries attachments, the gate escalates — we never
  // auto-merge away a record that might hold a signed contract/NDA. When it
  // fires, we name the evidence-holder and recommend keeping IT as the survivor
  // (escalate-with-recommendation — the operator makes the final call).
  let evidenceRecommendation: string | null = null;
  let firstPass = evaluateResolutionRisk(riskInput, policyCfg);
  if (ruleResult.override !== "escalate" && firstPass.verdict === "auto") {
    const dupAttach = await attachmentsOnDuplicates(module, plan.duplicateZohoIds);
    if (dupAttach.length > 0) {
      riskInput = { ...riskInput, duplicatesWithAttachments: dupAttach.length };
      const nameOf = (zid: string) =>
        plan.records.find((r) => r.zohoId === zid)?.name || zid;
      // Strongest evidence-holder = highest known count (unknown counts sort last).
      const strongest = [...dupAttach].sort(
        (a, b) => (b.count < 0 ? 0 : b.count) - (a.count < 0 ? 0 : a.count),
      )[0];
      const cntTxt = strongest.count < 0 ? "attachments (count unverified)" : `${strongest.count} attachment(s)`;
      evidenceRecommendation =
        `Evidence on a to-be-deleted record: "${nameOf(strongest.zohoId)}" (${strongest.zohoId}) holds ${cntTxt}. ` +
        `Recommend keeping THAT record as the survivor (or move its files first), then re-run. ` +
        (dupAttach.length > 1 ? `${dupAttach.length} duplicates carry files — attachments are split, review carefully.` : "");
    }
  }

  const gate: ResolutionRiskVerdict = evaluateResolutionRisk(riskInput, policyCfg);
  const verdict: "auto" | "escalate" = ruleResult.override ?? gate.verdict;
  const reasons =
    ruleResult.override === "auto"
      ? [`auto-approved by learned rule(s) #${ruleResult.ruleIds.join(", #")}`]
      : ruleResult.override === "escalate"
        ? [`blocked by learned rule(s) #${ruleResult.ruleIds.join(", #")}`, ...gate.reasons]
        : gate.reasons;
  if (evidenceRecommendation) reasons.push(evidenceRecommendation);

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
      // Forensic snapshot BEFORE any write so Undo / audit can reconstruct
      // the pre-merge state.
      await captureClusterSnapshot(clusterId, AGENT_PERFORMED_BY, "pre_agent_apply").catch(
        () => null,
      );
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
          evidenceRecommendation
            ? evidenceRecommendation
            : verdict === "auto"
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
