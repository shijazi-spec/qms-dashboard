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
  getClusterSummary,
  getKPIMetrics,
  recordExecBriefSnapshot,
  getPreviousExecBriefSnapshot,
  pool,
  type DuplicateCluster,
  type DuplicateRecord,
} from "./duplicateRadarDatabase";
import { buildMergePlan, type CrmModule, type MergePlan } from "./duplicateMergePlanner";
import { executeMergePlan, zohoWritesAllowedInEnv } from "./duplicateMergeExecutor";
import {
  evaluateResolutionRisk,
  getResolutionPolicyConfig,
  type ResolutionRiskInput,
  type ResolutionRiskVerdict,
} from "./duplicateResolutionPolicy";
import { evaluateRules } from "./duplicateResolutionRules";
import { recordResolutionEvent } from "./duplicateResolutionLearning";
import { snapshotGrades, getGradeHistory } from "./duplicateResolutionGrades";
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

export interface ModuleBreakdownRow {
  module: CrmModule;
  total: number;
  solved: number;
  rest: number;
  /**
   * Clusters that carry a REAL merge action (duplicates actually tagged
   * Duplicate-Delete in Zoho via an Apply). This is the honest "data merged"
   * figure — distinct from `solved`, which also counts status='resolved'.
   */
  applied: number;
  /**
   * Clusters marked status='resolved' but with NO merge action recorded —
   * i.e. closed WITHOUT an actual Zoho merge. Includes legacy clusters from
   * the now-removed high-confidence auto-resolve, plus manual "Mark resolved".
   * These were NOT merged; do not report them as merged data.
   */
  markedOnly: number;
}

/**
 * Per-module duplicate scoreboard counted in CLUSTERS (= the decisions to make,
 * one per cluster), not raw records. total = clusters containing that module;
 * solved = resolved; rest = still active. Drives the "By module" list on the
 * screen and the Slack run summary. Best-effort → zeros on any error.
 */
export async function getModuleResolutionBreakdown(): Promise<ModuleBreakdownRow[]> {
  const order: Array<{ col: string; module: CrmModule }> = [
    { col: "total_leads", module: "Leads" },
    { col: "total_deals", module: "Deals" },
    { col: "total_contacts", module: "Contacts" },
    { col: "total_accounts", module: "Accounts" },
  ];
  const rows: ModuleBreakdownRow[] = order.map((o) => ({
    module: o.module,
    total: 0,
    solved: 0,
    rest: 0,
    applied: 0,
    markedOnly: 0,
  }));
  try {
    // "solved" = the agent ACTED on the cluster — either it's fully resolved,
    // OR it carries a merge action (duplicates tagged Duplicate-Delete, pending
    // the Zoho admin's hard-delete: the "AI-Applied · pending Zoho delete"
    // state shown in the radar tabs). Two bugs this fixes:
    //   1) Counting only status='resolved' made every cross-module/partial
    //      apply show as "remaining" even though the agent had done the work
    //      (Accounts showed ~10 AI-applied but "2 solved").
    //   2) rest was status='active' only, so clusters in any OTHER status
    //      (ignored/dismissed/…) fell into a gap → total ≠ solved + rest.
    // rest is now derived as total − solved, so the three ALWAYS add up.
    // "solved" now has a THIRD, DURABLE source: the resolution ledger (keyed by
    // stable Zoho identity, NOT cluster_id). dc.status + duplicate_merge_actions
    // are both reset/cascade-deleted by "Rebuild Clusters", so before the ledger
    // every rebuild collapsed solved → 0. The ledger persists, and because the
    // survivor's zoho id reappears in whatever cluster it lands in after the
    // rescan, a per-module ledger match re-credits the cluster as solved.
    const lgCol: Record<string, string> = {
      total_leads: "lg_leads",
      total_deals: "lg_deals",
      total_contacts: "lg_contacts",
      total_accounts: "lg_accounts",
    };
    // Merge-action attribution must be MODULE-SCOPED, not cluster-scoped: a
    // whole-cluster 'resolve' credits every module present (ma.r_all), but a
    // per-module 'module_resolved' must credit ONLY its own module, derived
    // from the primary record's record_type (same mapping the backfill uses).
    // Cluster-scoping here would over-credit untouched modules in a mixed
    // cross-module cluster.
    const maCol: Record<string, string> = {
      total_leads: "mr_leads",
      total_deals: "mr_deals",
      total_contacts: "mr_contacts",
      total_accounts: "mr_accounts",
    };
    const selects = order
      .map((o) => {
        // MERGED (the honest "data merged" figure): a recorded merge action for
        // this module OR a durable ledger entry — i.e. duplicates were actually
        // tagged Duplicate-Delete in Zoho. A bare dc.status='resolved' does NOT
        // count here (it can be a legacy auto-resolve / manual close with no
        // merge). This is the figure to report when asked "how much was merged".
        const merged = `(COALESCE(ma.r_all, 0) > 0 OR COALESCE(ma.${maCol[o.col]}, 0) > 0 OR COALESCE(lg.${lgCol[o.col]}, 0) > 0)`;
        // SOLVED = the agent acted at all — also counts a bare resolved status.
        const solved = `(dc.status = 'resolved' OR ${merged})`;
        return `COUNT(*) FILTER (WHERE dc.${o.col} > 0)::int AS ${o.col}_t,
           COUNT(*) FILTER (WHERE dc.${o.col} > 0 AND ${solved})::int AS ${o.col}_s,
           COUNT(*) FILTER (WHERE dc.${o.col} > 0 AND ${merged})::int AS ${o.col}_a`;
      })
      .join(",\n");
    const r = await pool.query(
      `SELECT ${selects}
         FROM duplicate_clusters dc
         LEFT JOIN (
           SELECT ma.cluster_id,
                  COUNT(*) FILTER (WHERE ma.action_type = 'resolve') AS r_all,
                  COUNT(*) FILTER (WHERE ma.action_type = 'module_resolved' AND pr.record_type = 'lead')    AS mr_leads,
                  COUNT(*) FILTER (WHERE ma.action_type = 'module_resolved' AND pr.record_type = 'deal')    AS mr_deals,
                  COUNT(*) FILTER (WHERE ma.action_type = 'module_resolved' AND pr.record_type = 'contact') AS mr_contacts,
                  COUNT(*) FILTER (WHERE ma.action_type = 'module_resolved' AND pr.record_type = 'account') AS mr_accounts
             FROM duplicate_merge_actions ma
             LEFT JOIN duplicate_records pr ON pr.id = ma.primary_record_id
            WHERE ma.action_type IN ('resolve','module_resolved')
            GROUP BY ma.cluster_id
         ) ma ON ma.cluster_id = dc.id
         LEFT JOIN (
           SELECT dr.cluster_id,
                  COUNT(*) FILTER (WHERE lg.module = 'Leads')    AS lg_leads,
                  COUNT(*) FILTER (WHERE lg.module = 'Deals')    AS lg_deals,
                  COUNT(*) FILTER (WHERE lg.module = 'Contacts') AS lg_contacts,
                  COUNT(*) FILTER (WHERE lg.module = 'Accounts') AS lg_accounts
             FROM duplicate_records dr
             JOIN duplicate_resolution_ledger lg
               ON lg.master_zoho_id = dr.zoho_record_id
            WHERE dr.zoho_record_id IS NOT NULL
            GROUP BY dr.cluster_id
         ) lg ON lg.cluster_id = dc.id`,
    );
    const row = r.rows[0] || {};
    order.forEach((o, i) => {
      const t = Number(row[`${o.col}_t`] || 0);
      const s = Number(row[`${o.col}_s`] || 0);
      const a = Number(row[`${o.col}_a`] || 0);
      rows[i].total = t;
      rows[i].solved = s;
      rows[i].rest = Math.max(0, t - s); // invariant: total = solved + rest
      rows[i].applied = a; // real Zoho merges
      rows[i].markedOnly = Math.max(0, s - a); // resolved but never merged
    });
  } catch (e) {
    logger.warn("[dup-resolution-runner] module breakdown failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return rows;
}

/**
 * REAL merge activity over a recent window, sourced from the append-only
 * resolution feedback log — NOT cluster status (which a "Rebuild Clusters" wipes
 * back to 'active'). This is the HONEST "is there progress?" figure: how many
 * Applies actually happened, who did them, how many duplicates were tagged. In
 * shadow mode this is typically 0 (the agent makes no Zoho writes). Use this to
 * answer progress/comparison questions — never cluster resolved-count deltas,
 * which swing to 0 on a rebuild without anything actually being un-merged.
 */
export async function getRecentApplyStats(sinceHours: number): Promise<{
  sinceHours: number;
  applies: number;
  agentApplies: number;
  humanApplies: number;
  duplicatesTagged: number;
  undos: number;
}> {
  const out = {
    sinceHours,
    applies: 0,
    agentApplies: 0,
    humanApplies: 0,
    duplicatesTagged: 0,
    undos: 0,
  };
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type='applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%')::int AS applies,
         COUNT(*) FILTER (WHERE event_type='applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%'
                          AND (COALESCE(performed_by,'') ILIKE '%GRQ Assistant%' OR COALESCE(performed_by,'') ILIKE '%Autonomous Agent%'))::int AS agent_applies,
         COALESCE(SUM(duplicates_tagged) FILTER (WHERE event_type='applied'),0)::int AS tagged,
         COUNT(*) FILTER (WHERE COALESCE(performed_by,'') ILIKE 'UNDO%')::int AS undos
       FROM duplicate_resolution_feedback
      WHERE created_at > NOW() - ($1 || ' hours')::interval`,
      [String(sinceHours)],
    );
    const row = r.rows[0] || {};
    out.applies = Number(row.applies || 0);
    out.agentApplies = Number(row.agent_applies || 0);
    out.humanApplies = Math.max(0, out.applies - out.agentApplies);
    out.duplicatesTagged = Number(row.tagged || 0);
    out.undos = Number(row.undos || 0);
  } catch (e) {
    logger.warn("[dup-resolution-runner] recent apply stats failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

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

/** Resolve the public base URL: explicit env first, else Replit's domain. */
function publicBaseUrl(): string {
  const explicit = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const replit = (process.env.REPLIT_DOMAINS || "").split(",")[0]?.trim();
  return replit ? `https://${replit}` : "";
}

/**
 * Slack mrkdwn for the screen link. Only emits a `<url|text>` hyperlink when we
 * have a real https base — otherwise plain text, so we never render a broken
 * `</autonomous-resolution|…>` when no base URL is configured.
 */
function resolutionScreenLink(): string {
  const base = publicBaseUrl();
  return base
    ? `<${base}/autonomous-resolution|Open the Autonomous Resolution screen>`
    : "Open it: Quality → Autonomous Resolution.";
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

    const icon = summary.errors > 0 ? "🔴" : summary.queued > 0 ? "🟡" : "🟢";
    let breakdownText = "";
    try {
      const rows = await getModuleResolutionBreakdown();
      const lines = rows
        .filter((b) => b.total > 0)
        .map((b) => `›  *${b.module} Duplicates* — ${b.total} clusters · ${b.solved} solved · ${b.rest} left`);
      if (lines.length) breakdownText = `\n\n*By module:*\n${lines.join("\n")}`;
    } catch {
      /* breakdown is best-effort */
    }
    const text =
      `${icon} *Autonomous Resolution — ${summary.mode} run* ` +
      (summary.writesAllowed ? "" : "(shadow: no Zoho writes) ") +
      `\nScanned ${summary.clustersScanned} · applied ${summary.applied} · ` +
      `queued ${summary.queued} · errors ${summary.errors}` +
      (summary.queued > 0 ? `\n${summary.queued} item(s) need your call.` : "") +
      breakdownText +
      `\n${resolutionScreenLink()}`;

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
    const { WebClient } = await import("@slack/web-api");
    await new WebClient(token).chat.postMessage({
      channel,
      text:
        `✅ *Autonomous Resolution — test ping*\n` +
        `Channel wiring confirmed by ${triggeredBy}. You'll get a summary here after each 6h run.` +
        `\n${resolutionScreenLink()}`,
    });
    return { ok: true, channel };
  } catch (e) {
    return { ok: false, channel, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Post an arbitrary message to the resolution Slack channel (e.g. a
 *  manually-triggered executive brief). Best-effort. */
export async function postResolutionMessage(
  text: string,
): Promise<{ ok: boolean; channel: string | null; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = getResolutionSlackChannel();
  if (!token) return { ok: false, channel, error: "SLACK_BOT_TOKEN is not set." };
  if (!channel) return { ok: false, channel: null, error: "No resolution Slack channel configured." };
  try {
    const { WebClient } = await import("@slack/web-api");
    await new WebClient(token).chat.postMessage({ channel, text });
    return { ok: true, channel };
  } catch (e) {
    return { ok: false, channel, error: e instanceof Error ? e.message : String(e) };
  }
}

// Channels the WEEKLY leadership brief posts to. Defaults: #grq-assistant
// (resolution channel) + #automatic-audits. Override via env (comma-separated
// channel ids). The bot must be a MEMBER of each channel to post.
const WEEKLY_BRIEF_CHANNELS_DEFAULT = ["C0B93BCJFFV", "C0AS5G4UN91"];
function getWeeklyBriefChannels(): string[] {
  const env = (process.env.AUTONOMOUS_WEEKLY_BRIEF_CHANNELS || "").trim();
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(WEEKLY_BRIEF_CHANNELS_DEFAULT));
}

/**
 * Build the board-ready executive brief text DETERMINISTICALLY from real
 * aggregate figures (no LLM). Shared by the on-demand button and the weekly
 * leadership digest. With `withTrend`, prepends a week-over-week line vs the
 * last recorded snapshot.
 */
export async function buildExecutiveBriefText(
  opts: { withTrend?: boolean } = {},
): Promise<{ brief: string; metrics: any }> {
  const cfg = await resolveResolutionRunConfig();
  const agg = await getClusterSummary().catch(() => null);
  const breakdown = await getModuleResolutionBreakdown().catch(() => [] as any[]);
  const kpi = await getKPIMetrics().catch(() => null);
  const grades = await getGradeHistory(undefined, 4 * 8).catch(() => []);
  const latestByModule: Record<string, any> = {};
  for (const g of grades) if (!latestByModule[g.module]) latestByModule[g.module] = g;

  const sar = (n: number) => "SAR " + Math.round(n || 0).toLocaleString();
  const totalClusters = agg?.totalClusters || 0;
  const resolved = agg?.resolvedCount || 0;
  const open = agg?.activeCount || 0;
  const exposure = agg?.estimatedPipelineInflation || 0;
  const dupRate = kpi ? Math.max(kpi.duplicateLeadRate || 0, kpi.duplicateDealRate || 0) : null;
  const clearedPct = totalClusters > 0 ? (resolved / totalClusters) * 100 : 0;

  const modePlain =
    cfg.mode === "shadow"
      ? "observing only — making no changes to the CRM yet"
      : cfg.mode === "assisted"
        ? "assisting — auto-clearing safe cases, queuing the rest for review"
        : "autonomous — clearing safe cases on its own";
  const maturity = ["Accounts", "Leads", "Deals", "Contacts"]
    .map((m) => {
      const lvl = latestByModule[m]?.grade ?? 1;
      const plain = lvl >= 4 ? "trusted" : lvl >= 3 ? "reliable" : lvl >= 2 ? "developing" : "still learning";
      return `${m}: ${plain}`;
    })
    .join(" · ");
  const moduleLines = breakdown
    .map((b: any) => `   • ${b.module}: ${b.total.toLocaleString()} clusters · ${b.solved.toLocaleString()} cleared · ${b.rest.toLocaleString()} remaining`)
    .join("\n");

  let trendLine = "";
  if (opts.withTrend) {
    const prev = await getPreviousExecBriefSnapshot().catch(() => null);
    if (prev) {
      const dResolved = resolved - (prev.resolved_count || 0);
      const dExposure = exposure - Number(prev.exposure || 0);
      const dRate = dupRate != null && prev.dup_rate != null ? dupRate - prev.dup_rate : null;
      trendLine =
        `\n*This week:* ${dResolved >= 0 ? "+" : ""}${dResolved.toLocaleString()} clusters cleared · ` +
        `exposure ${dExposure <= 0 ? "down" : "up"} ${sar(Math.abs(dExposure))}` +
        (dRate != null ? ` · duplicate rate ${dRate <= 0 ? "down" : "up"} ${Math.abs(dRate)} pts` : "") +
        ".\n";
    } else {
      trendLine = `\n_First weekly baseline — week-over-week trend starts next week._\n`;
    }
  }

  const brief =
    `*GRQ — CRM Duplicate Health (Executive Brief)*\n\n` +
    `*Bottom line:* ~${sar(exposure)} of pipeline value is inflated across ${totalClusters.toLocaleString()} duplicate clusters; ${clearedPct < 1 ? "under 1%" : clearedPct.toFixed(0) + "%"} cleared so far.\n` +
    trendLine +
    `\n` +
    (dupRate != null ? `• *Duplicate rate:* ~${dupRate}% vs the 2% target — our biggest data-quality gap.\n` : "") +
    `• *Financial exposure:* ${sar(exposure)} of estimated inflated pipeline in duplicates.\n` +
    `• *Progress:* ${resolved.toLocaleString()} clusters resolved · ${open.toLocaleString()} still open.\n` +
    `• *Clean-up AI:* ${modePlain}.\n` +
    `• *AI maturity by module:* ${maturity}.\n\n` +
    `*By module:*\n${moduleLines}\n\n` +
    `*Recommendation:* ${cfg.mode === "shadow"
      ? "validate the AI's judgement in observe-only mode; once agreement holds, approve moving the strongest module to assisted (auto-clear safe cases, human-review the rest)."
      : "continue assisted clean-up; review the override rate weekly and tighten thresholds as agreement improves."}`;

  return {
    brief,
    metrics: { totalClusters, resolvedCount: resolved, activeCount: open, exposure, dupRate },
  };
}

/**
 * Weekly leadership digest — posts the executive brief (with week-over-week
 * trend) to the configured channels, then records this week's snapshot so the
 * NEXT week can show the delta. Scheduled Sunday 06:00 KSA (03:00 UTC).
 */
export async function postWeeklyExecBrief(
  opts: { recordSnapshot?: boolean } = {},
): Promise<{
  ok: boolean;
  posted: string[];
  errors: string[];
}> {
  // The scheduled Sunday run records a snapshot (= next week's trend baseline).
  // A MANUAL "send now" passes recordSnapshot:false so ad-hoc sends (e.g. for a
  // meeting) don't pollute the week-over-week math, which must stay Sunday-anchored.
  const recordSnapshot = opts.recordSnapshot !== false;
  const { brief, metrics } = await buildExecutiveBriefText({ withTrend: true });
  if (recordSnapshot) {
    // Snapshot AFTER building (build reads the PRIOR snapshot for the delta).
    try {
      await recordExecBriefSnapshot({
        totalClusters: metrics.totalClusters,
        resolvedCount: metrics.resolvedCount,
        activeCount: metrics.activeCount,
        exposure: metrics.exposure,
        dupRate: metrics.dupRate,
        metricsJson: metrics,
      });
    } catch (e) {
      logger.warn("[exec-brief] snapshot record failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const token = process.env.SLACK_BOT_TOKEN;
  const posted: string[] = [];
  const errors: string[] = [];
  if (!token) return { ok: false, posted, errors: ["SLACK_BOT_TOKEN not set"] };
  const text = `📊 *Weekly Leadership Brief*\n\n${brief}\n${resolutionScreenLink()}`;
  const { WebClient } = await import("@slack/web-api");
  const slack = new WebClient(token);
  for (const ch of getWeeklyBriefChannels()) {
    try {
      await slack.chat.postMessage({ channel: ch, text });
      posted.push(ch);
    } catch (e) {
      errors.push(`${ch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  logger.info(`📊 [exec-brief] weekly brief posted to ${posted.length} channel(s)`, { posted, errors });
  return { ok: posted.length > 0, posted, errors };
}

/**
 * SINGLE SOURCE OF TRUTH for Adam's scheduled notifications. Drives the
 * platform "Notification Schedule" card, the monthly review post, and what
 * Adam tells people about his own cadence. To change a timing, edit the
 * matching env var (envKey) — review this monthly. Times are KSA (UTC+3).
 */
export interface NotificationScheduleEntry {
  time: string;
  cron: string;
  envKey?: string;
  channel: string;
  what: string;
  postsToSlack: boolean;
}
// Chronological — mirrors the "daily rhythm" table Sarah approved.
export const ADAM_NOTIFICATION_SCHEDULE: NotificationScheduleEntry[] = [
  { time: "03:00 / 09:00 / 15:00 / 21:00 KSA", cron: "0 */6 * * *", envKey: "DUPLICATE_SCAN_CRON", channel: "— (background)", what: "Every-6h incremental CRM sync — keeps data fresh round the clock", postsToSlack: false },
  { time: "07:00 KSA · daily", cron: "0 4 * * *", envKey: "DUPLICATE_MORNING_SYNC_CRON", channel: "— (background)", what: "Pre-shift incremental sync — radar current before your shift", postsToSlack: false },
  { time: "09:00 & 17:00 KSA · daily", cron: "0 6,14 * * *", envKey: "AUTONOMOUS_RESOLUTION_DIGEST_CRON", channel: "#grq-assistant", what: "Operational apply digest — what the agent applied/queued this shift", postsToSlack: true },
  { time: "Sunday 06:00 KSA · weekly", cron: "0 3 * * 0", envKey: "AUTONOMOUS_EXEC_BRIEF_CRON", channel: "#grq-assistant + #automatic-audits", what: "Weekly leadership brief — exposure, dup-rate vs 2%, week-over-week trend, recommendation", postsToSlack: true },
  { time: "Every 6h (:30)", cron: "30 */6 * * *", channel: "#grq-assistant", what: "Autonomous resolution tick (shadow) — per-tick summary, quiet when nothing changed", postsToSlack: true },
  { time: "1st of month · 09:00 KSA", cron: "0 6 1 * *", envKey: "AUTONOMOUS_SCHEDULE_REVIEW_CRON", channel: "#grq-assistant", what: "Monthly review of THIS notification schedule — edit timings if needed", postsToSlack: true },
];

/** Render the schedule as a Slack-friendly list. */
export function buildNotificationScheduleText(): string {
  const lines = ADAM_NOTIFICATION_SCHEDULE.map(
    (e) => `• *${e.time}* — ${e.what}` + (e.postsToSlack ? ` → ${e.channel}` : ` _(background)_`),
  ).join("\n");
  return `*Adam — Notification Schedule (KSA)*\n${lines}`;
}

/** Monthly review post: shows the schedule and invites timing changes. */
export async function postMonthlyScheduleReview(): Promise<{ ok: boolean; channel: string | null; error?: string }> {
  const text =
    `🗓️ *Monthly notification-schedule review*\n\n` +
    buildNotificationScheduleText() +
    `\n\nReply here if any timing should change and we'll update it. ${resolutionScreenLink()}`;
  return postResolutionMessage(text);
}

export const AGENT_PERFORMED_BY =
  "Adam — GRQ Assistant (on behalf of Sarah Hijazi)";

/**
 * Twice-daily APPLY DIGEST posted to the resolution Slack channel — at 09:00
 * (start of day) and 17:00 (end of day) KSA. Replaces the per-apply ping:
 * instead of one message per merge, it batches all AI solves/migrations in the
 * window into a single morning/evening summary. Best-effort; always posts (a
 * "nothing applied" line is a useful heartbeat). `sinceHours` covers back to the
 * previous digest (16h for the 9AM run, 8h for the 5PM run).
 */
/**
 * Per-tab status board for the Duplicate Radar — appended to the twice-daily
 * digest so each shift sees the health of every key tab, not just the agent's
 * applies. Each line best-effort; a failing query just drops its line.
 */
export async function buildRadarTabStatus(): Promise<string> {
  const parts: string[] = [];
  const n = (x: number) => Math.round(x || 0).toLocaleString();
  // Pull the durable per-module breakdown ONCE — used for both the Overview
  // "merged" total and the per-module line. `applied` = real Zoho merges that
  // survive a Rebuild (ledger-backed); `solved` also counts a bare resolved
  // status (rebuild-fragile). We report the DURABLE figure so the digest never
  // falsely shows "0 done" just because a Rebuild reset cluster statuses.
  let bd: ModuleBreakdownRow[] = [];
  try {
    bd = await getModuleResolutionBreakdown();
  } catch { /* skip */ }
  const totalMerged = bd.reduce((a, b) => a + (b.applied || 0), 0);
  // Executive Summary / Cross-Module — overall clusters + SAR exposure.
  try {
    const agg = await getClusterSummary();
    if (agg) {
      parts.push(
        `›  *Overview:* ${n(agg.totalClusters)} clusters · ~SAR ${n(agg.estimatedPipelineInflation)} exposure · ${n(totalMerged)} merged · ${n(agg.activeCount)} open`,
      );
    }
  } catch { /* skip */ }
  // Real merge activity in the last 24h, from the append-only feedback log
  // (survives rebuilds). The honest "is anything actually happening?" line —
  // 0 in shadow mode, which is the truth, not an error.
  try {
    const recent = await getRecentApplyStats(24);
    parts.push(
      `›  *Merges applied (real, last 24h):* ${n(recent.applies)}` +
        (recent.applies > 0
          ? ` (${n(recent.agentApplies)} agent · ${n(recent.humanApplies)} people · ${n(recent.duplicatesTagged)} duplicates tagged)`
          : " — nothing merged in this window"),
    );
  } catch { /* skip */ }
  // Lead / Deal / Contact / Account Duplicates — remaining vs MERGED (durable).
  try {
    const ml = bd
      .filter((b) => b.total > 0)
      .map((b) => `${b.module} ${n(b.rest)} left/${n(b.applied)} merged`)
      .join(" · ");
    if (ml) parts.push(`›  *Duplicates:* ${ml}`);
  } catch { /* skip */ }
  // Account Hints — pending / applied / dismissed.
  try {
    const { listAccountInferenceHints } = await import("./accountInference");
    const h = await listAccountInferenceHints({ status: "pending", limit: 1 });
    parts.push(
      `›  *Account Hints:* ${n(h.summary.pending)} pending · ${n(h.summary.applied)} applied · ${n(h.summary.dismissed)} dismissed`,
    );
  } catch { /* skip */ }
  // Deal Compliance — compliant vs missing docs (of deals scanned).
  try {
    const { getDealDocCompliance } = await import("./duplicateRadarDatabase");
    const rows = await getDealDocCompliance();
    const checked = rows.length;
    if (checked) {
      const compliant = rows.filter((r: any) => r.compliant).length;
      parts.push(
        `›  *Deal Compliance:* ${n(compliant)} compliant · ${n(checked - compliant)} missing docs (of ${n(checked)} checked)`,
      );
    }
  } catch { /* skip */ }
  return parts.length ? `\n*Radar status by tab:*\n${parts.join("\n")}` : "";
}

export async function postResolutionDigest(opts: {
  label: string;
  sinceHours: number;
}): Promise<void> {
  try {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = getResolutionSlackChannel();
    if (!token || !channel) return;

    let agentApplies = 0;
    let humanApplies = 0;
    let tagged = 0;
    let fields = 0;
    let undos = 0;
    const perModule: Record<string, number> = {};
    try {
      const r = await pool.query(
        `SELECT plan_json->>'module' AS module,
                COUNT(*) FILTER (WHERE event_type='applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%')::int AS applies,
                COUNT(*) FILTER (WHERE event_type='applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%'
                                 AND (COALESCE(performed_by,'') ILIKE '%GRQ Assistant%' OR COALESCE(performed_by,'') ILIKE '%Autonomous Agent%'))::int AS agent_applies,
                COALESCE(SUM(duplicates_tagged) FILTER (WHERE event_type='applied'),0)::int AS tagged,
                COALESCE(SUM(fields_migrated) FILTER (WHERE event_type='applied'),0)::int AS fields,
                COUNT(*) FILTER (WHERE COALESCE(performed_by,'') ILIKE 'UNDO%')::int AS undos
           FROM duplicate_resolution_feedback
          WHERE created_at > NOW() - ($1 || ' hours')::interval
          GROUP BY plan_json->>'module'`,
        [String(opts.sinceHours)],
      );
      for (const row of r.rows) {
        const a = Number(row.applies || 0);
        agentApplies += Number(row.agent_applies || 0);
        humanApplies += a - Number(row.agent_applies || 0);
        tagged += Number(row.tagged || 0);
        fields += Number(row.fields || 0);
        undos += Number(row.undos || 0);
        if (row.module && a > 0) perModule[row.module] = (perModule[row.module] || 0) + a;
      }
    } catch {
      /* digest aggregation best-effort */
    }
    const totalApplies = agentApplies + humanApplies;

    // Per-tab status of the whole Duplicate Radar (overview + duplicates +
    // account hints + deal compliance) — so each shift sees every tab's health.
    let scoreboard = "";
    try {
      scoreboard = await buildRadarTabStatus();
    } catch {
      /* non-fatal */
    }

    const byModule = Object.keys(perModule).length
      ? "\nBy module: " +
        Object.entries(perModule)
          .map(([m, n]) => `${m} ${n}`)
          .join(" · ")
      : "";

    const head =
      totalApplies > 0
        ? `📋 *Resolution digest — ${opts.label}* (last ${opts.sinceHours}h)\n` +
          `${totalApplies} merge(s) applied · ${tagged} tagged · ${fields} field(s) migrated` +
          (undos ? ` · ${undos} undone` : "") +
          `\n  by Adam (the agent): ${agentApplies} · by people: ${humanApplies}` +
          byModule
        : `📋 *Resolution digest — ${opts.label}* (last ${opts.sinceHours}h)\n` +
          `No merges applied in this window.`;

    const text = head + scoreboard + `\n${resolutionScreenLink()}`;
    const { WebClient } = await import("@slack/web-api");
    await new WebClient(token).chat.postMessage({ channel, text });
  } catch (e) {
    logger.warn("[dup-resolution-runner] digest failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

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

/** Env-only baseline (the deploy default). */
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

// ── In-platform mode override (DB-backed; overlays the env baseline) ───────────
// Lets an admin promote shadow → assisted → autonomous (and the kill switch)
// from the dashboard WITHOUT editing Replit env / republishing — it takes effect
// on the next tick. The agent never changes its own mode (segregation of duties).

let _settingsReady = false;
async function ensureResolutionSettingsTable(): Promise<void> {
  if (_settingsReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autonomous_resolution_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN,
      mode VARCHAR(16),
      updated_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT autonomous_resolution_settings_singleton CHECK (id = 1)
    );
  `);
  _settingsReady = true;
}

export interface ResolutionSettingOverride {
  enabled: boolean | null;
  mode: ResolutionMode | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function getResolutionSettingOverride(): Promise<ResolutionSettingOverride | null> {
  try {
    await ensureResolutionSettingsTable();
    const r = await pool.query(
      `SELECT enabled, mode, updated_by, updated_at FROM autonomous_resolution_settings WHERE id = 1`,
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const mode =
      row.mode === "shadow" || row.mode === "assisted" || row.mode === "autonomous"
        ? (row.mode as ResolutionMode)
        : null;
    return {
      enabled: row.enabled === null || row.enabled === undefined ? null : !!row.enabled,
      mode,
      updatedBy: row.updated_by ?? null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  } catch (e) {
    logger.warn("[dup-resolution-runner] getResolutionSettingOverride failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Persist an in-platform mode / kill-switch change. */
export async function setResolutionSetting(
  patch: { enabled?: boolean; mode?: ResolutionMode },
  updatedBy: string,
): Promise<ResolutionSettingOverride | null> {
  await ensureResolutionSettingsTable();
  const current = (await getResolutionSettingOverride()) || {
    enabled: null,
    mode: null,
    updatedBy: null,
    updatedAt: null,
  };
  const nextEnabled = patch.enabled === undefined ? current.enabled : patch.enabled;
  const nextMode = patch.mode === undefined ? current.mode : patch.mode;
  await pool.query(
    `INSERT INTO autonomous_resolution_settings (id, enabled, mode, updated_by, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled, mode = EXCLUDED.mode,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [nextEnabled, nextMode, updatedBy],
  );
  return getResolutionSettingOverride();
}

/** Effective config = env baseline with the DB override applied per-field. */
export async function resolveResolutionRunConfig(): Promise<
  ResolutionRunConfig & { source: "env" | "override"; updatedBy: string | null; updatedAt: string | null }
> {
  const base = getResolutionRunConfig();
  const ov = await getResolutionSettingOverride();
  if (!ov || (ov.enabled === null && ov.mode === null)) {
    return { ...base, source: "env", updatedBy: null, updatedAt: null };
  }
  return {
    enabled: ov.enabled === null ? base.enabled : ov.enabled,
    mode: ov.mode === null ? base.mode : ov.mode,
    maxClusters: base.maxClusters,
    source: "override",
    updatedBy: ov.updatedBy,
    updatedAt: ov.updatedAt,
  };
}

/**
 * Hard environment guardrail. The agent must NEVER mutate the SHARED live Zoho
 * org from a non-production environment, even when the kill switch is on and the
 * mode is assisted/autonomous. Dev and prod share the same Zoho credentials but
 * run on SEPARATE databases, so a dev tick (or a dev operator flipping the
 * toggle) could otherwise tag/merge real CRM records. Live writes therefore
 * require BOTH `NODE_ENV=production` AND the operator's explicit kill-switch +
 * mode. Set `RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD=true` only for a dedicated
 * non-prod org that does NOT share production's Zoho creds.
 */
export function liveWritesPermitted(
  cfg: { enabled: boolean },
  mode: ResolutionMode,
): boolean {
  return (
    zohoWritesAllowedInEnv() &&
    cfg.enabled &&
    (mode === "assisted" || mode === "autonomous")
  );
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
  /** Effective write permission AFTER the environment guardrail (dev = false even when enabled). */
  writesAllowed: boolean;
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
  const cfg = await resolveResolutionRunConfig();
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
    writesAllowed: false,
    items: [],
  };

  // Writes only happen in assisted/autonomous AND when the kill switch is on
  // AND we are in production (the dev environment shares prod's live Zoho creds).
  const writesAllowed = liveWritesPermitted(cfg, mode);
  summary.writesAllowed = writesAllowed;

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
  const cfg = await resolveResolutionRunConfig();
  const mode = opts.modeOverride ?? cfg.mode;
  const policyCfg = getResolutionPolicyConfig();
  const writesAllowed = liveWritesPermitted(cfg, mode);

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
    writesAllowed,
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
    // Undo is ALSO a live Zoho mutation (it removes the Duplicate-Delete tag),
    // so it must obey the same environment guardrail as executeMergePlan — dev
    // shares prod's Zoho creds and must never touch the real org.
    if (taggedIds.length && !zohoWritesAllowedInEnv()) {
      return {
        ok: false,
        untagged: 0,
        module,
        message:
          "Undo is blocked outside production (dev shares production's Zoho credentials). Undo from the deployed app, or set RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD=true only for a dedicated non-prod Zoho org.",
      };
    }
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
      // (Apply notifications are batched into the twice-daily digest.)
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
