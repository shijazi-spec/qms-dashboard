/**
 * Weekly Call Evaluation Digest.
 *
 * Per DMAIC Improve phase Solution #3 / strategic report defect #4
 * ("No weekly/monthly digest"). Sends a per-agent rollup of last
 * week's calls to a Slack channel and (optionally) a stakeholder
 * email distribution list every Sunday morning Asia/Riyadh time.
 *
 * Three layers split for testability:
 *
 *   1. fetchWeeklyAgentRollup() — pure SQL aggregate over
 *      call_records ⨯ sdr_call_evaluations grouped by agent_email
 *      for a [start, end) window. No I/O outside the DB pool.
 *
 *   2. renderDigestText() / renderDigestSlackBlocks() /
 *      renderDigestHtml() — pure renderers that take a rollup and
 *      return the per-channel payload. Unit-testable without
 *      Slack/Resend credentials.
 *
 *   3. sendWeeklyDigest() — orchestrator that combines fetch +
 *      render + dispatch via existing postSlackMessage and
 *      sendResendEmail helpers. Best-effort: a failure on one
 *      channel doesn't abort the other.
 *
 * Triggered by:
 *   - Inngest cron at src/mastra/workflows/weeklyDigestCron.ts
 *     (Sunday 03:00 UTC = Sunday 06:00 Asia/Riyadh)
 *   - Manual trigger via POST /api/calls/weekly-digest/send
 *
 * Feature-flagged on WEEKLY_DIGEST. When the flag is off, sendWeekly-
 * Digest returns { sent: false, <REDACTED_TOKEN>: 'flag_disabled' }
 * without dispatching anywhere — the cron still wakes up but does
 * nothing, so flipping the flag is the only deploy-free toggle.
 */

import { logger as safeLogger } from "./logger";
import { isFlagEnabled } from "./featureFlags";

export interface DigestWindow {
  /** Inclusive start of window. */
  start: Date;
  /** Exclusive end of window. */
  end: Date;
  /** Human-readable label, e.g. "May 17 – May 23". */
  label: string;
}

export interface AgentRollupRow {
  agent_email: string;
  agent_name: string | null;
  call_count: number;
  evaluated_count: number;
  avg_overall_score: number | null;
  best_score: number | null;
  worst_score: number | null;
}

export interface WeeklyDigest {
  window: DigestWindow;
  total_calls: number;
  total_evaluated: number;
  agents_active: number;
  org_avg_score: number | null;
  agents: AgentRollupRow[];
}

type Pool = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

/**
 * Compute last-7-days window (Sunday-to-Saturday by default; pass
 * `now` to override "today" for deterministic tests).
 */
export function buildLastWeekWindow(now: Date = new Date()): DigestWindow {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "Asia/Riyadh",
    });
  const endLabel = new Date(end.getTime() - 24 * 60 * 60 * 1000); // human-readable last full day
  return { start, end, label: `${fmt(start)} – ${fmt(endLabel)}` };
}

/**
 * Fetch the per-agent rollup for a window. Pure SQL aggregate.
 */
export async function fetchWeeklyAgentRollup(
  pool: Pool,
  window: DigestWindow,
): Promise<WeeklyDigest> {
  const rows = await pool
    .query(
      `SELECT
         cr.agent_email,
         MAX(cr.agent_name) AS agent_name,
         COUNT(*)::int AS call_count,
         COUNT(sce.overall_score)::int AS evaluated_count,
         AVG(sce.overall_score)::float AS avg_overall_score,
         MAX(sce.overall_score)::float AS best_score,
         MIN(sce.overall_score)::float AS worst_score
       FROM call_records cr
       LEFT JOIN sdr_call_evaluations sce ON sce.call_record_id = cr.id
       WHERE cr.created_at >= $1
         AND cr.created_at <  $2
         AND cr.agent_email IS NOT NULL
       GROUP BY cr.agent_email
       ORDER BY avg_overall_score DESC NULLS LAST`,
      [window.start, window.end],
    )
    .catch((err: any) => {
      safeLogger.warn("[weeklyDigest] rollup query failed", {
        error: err?.message || String(err),
      });
      return { rows: [] };
    });

  const agents: AgentRollupRow[] = rows.rows.map((r: any) => ({
    agent_email: r.agent_email,
    agent_name: r.agent_name,
    call_count: r.call_count || 0,
    evaluated_count: r.evaluated_count || 0,
    avg_overall_score:
      r.avg_overall_score === null
        ? null
        : Math.round(Number(r.avg_overall_score) * 100) / 100,
    best_score: r.best_score === null ? null : Number(r.best_score),
    worst_score: r.worst_score === null ? null : Number(r.worst_score),
  }));

  const totalCalls = agents.reduce((s, a) => s + a.call_count, 0);
  const totalEvaluated = agents.reduce((s, a) => s + a.evaluated_count, 0);
  const weightedSum = agents.reduce(
    (s, a) =>
      a.avg_overall_score !== null
        ? s + a.avg_overall_score * a.evaluated_count
        : s,
    0,
  );
  const orgAvg = totalEvaluated > 0
    ? Math.round((weightedSum / totalEvaluated) * 100) / 100
    : null;

  return {
    window,
    total_calls: totalCalls,
    total_evaluated: totalEvaluated,
    agents_active: agents.length,
    org_avg_score: orgAvg,
    agents,
  };
}

// ===================================================================
//   Renderers — pure functions, no I/O
// ===================================================================

export function renderDigestText(d: WeeklyDigest): string {
  const lines: string[] = [];
  lines.push(`ExampleOrg QMS — Weekly Call Evaluation Digest`);
  lines.push(`Window: ${d.window.label}`);
  lines.push("");
  lines.push(
    `Org snapshot: ${d.total_calls} calls · ${d.total_evaluated} evaluated · ${d.agents_active} active agents · org avg ${d.org_avg_score ?? "—"}`,
  );
  lines.push("");
  lines.push(`Per-agent leaderboard (sorted by avg score, NULLs last):`);
  if (d.agents.length === 0) {
    lines.push("  (no calls in this window)");
  } else {
    for (const a of d.agents) {
      const name = a.agent_name || a.agent_email;
      const avg = a.avg_overall_score === null ? "—" : String(a.avg_overall_score);
      lines.push(
        `  • ${name}: ${a.call_count} calls, ${a.evaluated_count} evaluated, avg ${avg}, best ${a.best_score ?? "—"}, worst ${a.worst_score ?? "—"}`,
      );
    }
  }
  return lines.join("\n");
}

export function renderDigestSlackBlocks(d: WeeklyDigest): any[] {
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Weekly Call Evaluation Digest" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Window:* ${d.window.label}\n*Snapshot:* ${d.total_calls} calls · ${d.total_evaluated} evaluated · ${d.agents_active} active agents · *org avg ${d.org_avg_score ?? "—"}*`,
      },
    },
    { type: "divider" },
  ];

  if (d.agents.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No calls in this window._" },
    });
    return blocks;
  }

  // Up to 10 agent rows. Slack block limit is 50; one row each keeps us safe.
  const top = d.agents.slice(0, 10);
  for (const a of top) {
    const name = a.agent_name || a.agent_email;
    const avg = a.avg_overall_score === null ? "—" : String(a.avg_overall_score);
    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*${name}*\n${a.evaluated_count} of ${a.call_count} evaluated` },
        {
          type: "mrkdwn",
          text: `Avg *${avg}* · best ${a.best_score ?? "—"} · worst ${a.worst_score ?? "—"}`,
        },
      ],
    });
  }
  if (d.agents.length > 10) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `_…and ${d.agents.length - 10} more agents — full list in the email digest._` },
      ],
    });
  }
  return blocks;
}

export function renderDigestHtml(d: WeeklyDigest): string {
  const rows = d.agents
    .map((a) => {
      const name = a.agent_name || a.agent_email;
      const avg = a.avg_overall_score === null ? "—" : String(a.avg_overall_score);
      return `<tr>
        <td>${escapeHtml(name)}</td>
        <td style="text-align:right">${a.call_count}</td>
        <td style="text-align:right">${a.evaluated_count}</td>
        <td style="text-align:right">${avg}</td>
        <td style="text-align:right">${a.best_score ?? "—"}</td>
        <td style="text-align:right">${a.worst_score ?? "—"}</td>
      </tr>`;
    })
    .join("");
  return `<div style="font-family:Calibri,Arial,sans-serif;color:#222;max-width:700px">
    <h2 style="color:#047857">ExampleOrg QMS — Weekly Call Evaluation Digest</h2>
    <p><strong>Window:</strong> ${escapeHtml(d.window.label)}</p>
    <p>${d.total_calls} calls · ${d.total_evaluated} evaluated · ${d.agents_active} active agents · <strong>org avg ${d.org_avg_score ?? "—"}</strong></p>
    <table style="border-collapse:collapse;width:100%;font-size:13px" border="1" cellpadding="6">
      <thead style="background:#047857;color:white">
        <tr>
          <th align="left">Agent</th>
          <th align="right">Calls</th>
          <th align="right">Evaluated</th>
          <th align="right">Avg</th>
          <th align="right">Best</th>
          <th align="right">Worst</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="6" align="center">No calls in this window</td></tr>`}</tbody>
    </table>
  </div>`;
}

function escapeHtml(s: string): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===================================================================
//   Orchestrator
// ===================================================================

export interface SendDigestOptions {
  /** Override the window (default: last 7 days from now). */
  window?: DigestWindow;
  /** Override the Slack channel id; falls back to SLACK_DIGEST_CHANNEL_ID or SLACK_CHANNEL_ID. */
  slackChannel?: string;
  /** Override the email recipients; falls back to WEEKLY_DIGEST_RECIPIENTS (comma-separated). */
  emailRecipients?: string[];
  /** Identity for flag check. */
  identity?: string | null;
  /** Skip the flag check (used by the manual trigger when called by admin). */
  forceSend?: boolean;
}

export interface SendDigestResult {
  sent: boolean;
  slack: { attempted: boolean; ok: boolean; reason?: string };
  email: { attempted: boolean; ok: boolean; reason?: string };
  <REDACTED_TOKEN>?: string;
  digest_summary?: {
    window_label: string;
    total_calls: number;
    agents_active: number;
    org_avg_score: number | null;
  };
}

export async function sendWeeklyDigest(
  pool: Pool,
  options: SendDigestOptions = {},
): Promise<SendDigestResult> {
  const { identity, forceSend = false } = options;

  // HARD-DISABLED — permanent no-op. The Weekly Report lives in the
  // dashboard (/calls, opened Monday morning); Slack + email push channels
  // were dropped in the 3rd + 4th scope amendments (2026-05-25).
  //
  // 2026-09-03: the previous `DIGEST_DECOMMISSIONED_OVERRIDE` env escape
  // hatch was REMOVED at the Quality HOD's request ("stop these
  // notifications till we finish the API integration") after "0 calls"
  // digests reappeared in #automatic-audits. Removing it means NO secret,
  // feature flag, or Replit-Agent action can re-enable the Slack/email
  // digest while call-evaluation API work is in flight — the code is now
  // the single source of truth. This runs BEFORE the flag check and BEFORE
  // forceSend, so every entry point (cron, manual POST, direct import in
  // tests) is a no-op. To re-enable later, delete this block in a
  // deliberate PR.
  //
  // NOTE: everything below this return is intentionally unreachable while
  // the digest is decommissioned; it is retained (not deleted) so a future
  // re-enable is a one-line change rather than a rewrite. The pure
  // renderers (renderDigestText / renderDigestSlackBlocks / renderDigestHtml)
  // remain exported and unit-tested independently of this orchestrator.
  //
  // The flag is a `boolean`, not the literal `true`, ON PURPOSE: an
  // unconditional `return` makes the retained code unreachable, and
  // TypeScript neither narrows types nor reports errors inside unreachable
  // code. That is how `postSlackMessage(slackChannel)` below came to fail
  // `tsc` with "string | null" — the guard above it stopped narrowing — and
  // it is the same blind spot that would let this retained block rot into
  // something that no longer compiles when someone finally re-enables it.
  // Widening the type keeps the whole function type-checked while the
  // runtime behaviour is identical: this still returns before the flag check
  // and before forceSend, so every entry point remains a no-op, and
  // re-enabling is still the one-line change the comment above promises.
  const DIGEST_DECOMMISSIONED: boolean = true;
  if (DIGEST_DECOMMISSIONED) {
    return {
      sent: false,
      slack: { attempted: false, ok: false },
      email: { attempted: false, ok: false },
      <REDACTED_TOKEN>: "decommissioned_per_amendments_3_and_4",
    };
  }

  if (!forceSend && !isFlagEnabled("weekly_digest", identity)) {
    return {
      sent: false,
      slack: { attempted: false, ok: false },
      email: { attempted: false, ok: false },
      <REDACTED_TOKEN>: "flag_disabled",
    };
  }

  const window = options.window ?? buildLastWeekWindow();
  const digest = await fetchWeeklyAgentRollup(pool, window);

  const slackChannel =
    options.slackChannel ||
    process.env.SLACK_DIGEST_CHANNEL_ID ||
    process.env.SLACK_CHANNEL_ID ||
    null;

  const emailRecipients =
    options.emailRecipients ??
    (process.env.WEEKLY_DIGEST_RECIPIENTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const result: SendDigestResult = {
    sent: false,
    slack: { attempted: false, ok: false },
    email: { attempted: false, ok: false },
    digest_summary: {
      window_label: window.label,
      total_calls: digest.total_calls,
      agents_active: digest.agents_active,
      org_avg_score: digest.org_avg_score,
    },
  };

  // Slack
  if (slackChannel) {
    result.slack.attempted = true;
    try {
      const { postSlackMessage } = await import("./slackNotifications");
      const blocks = renderDigestSlackBlocks(digest);
      const fallbackText = renderDigestText(digest);
      const resp = await postSlackMessage(slackChannel, fallbackText, blocks);
      result.slack.ok = resp.ok;
      if (!resp.ok) result.slack.reason = "post_failed";
    } catch (err: any) {
      result.slack.reason = err?.message || String(err);
    }
  } else {
    result.slack.reason = "no_channel_configured";
  }

  // Email
  if (emailRecipients.length > 0) {
    result.email.attempted = true;
    try {
      const { sendResendEmail } = await import("./resendMail");
      const send = await sendResendEmail({
        to: emailRecipients,
        subject: `ExampleOrg QMS — Weekly Call Eval Digest (${window.label})`,
        text: renderDigestText(digest),
        html: renderDigestHtml(digest),
      });
      result.email.ok = send.success;
      if (!send.success) result.email.reason = send.error || "send_failed";
    } catch (err: any) {
      result.email.reason = err?.message || String(err);
    }
  } else {
    result.email.reason = "no_recipients_configured";
  }

  result.sent = result.slack.ok || result.email.ok;
  if (!result.sent && !result.<REDACTED_TOKEN>) {
    result.<REDACTED_TOKEN> = "all_channels_failed_or_unconfigured";
  }
  return result;
}
