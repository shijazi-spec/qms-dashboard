/**
 * Which Slack channel a notification belongs in.
 *
 * Everything sent through notifyEvent/createNotification used to land in one
 * channel (SLACK_CHANNEL_ID), so a platform-health failure and a fraud
 * reminder arrived side by side in #automatic-audits with different owners and
 * different urgency. Splitting by AUDIENCE — who has to act — gives each
 * channel a single owner and lets people mute what is not theirs without
 * missing what is.
 *
 * Four audiences, per Sarah 2026-09-07:
 *
 *   platform     The QMS platform itself: health pulse, reports, AI governance,
 *                infrastructure, security. Nothing business-unit specific.
 *   sales_sdr    SDR (B2B) and Sales (B2B).
 *   cs           Customer Success (B2B).
 *   marketplace  Marketplace / merchants.
 *
 * Notifications carry a technical `module` string, not a business unit, so the
 * mapping lives here. Anything unmapped goes to `platform` deliberately: the
 * platform channel is the operational one, so an unrouted alert lands
 * somewhere staffed rather than somewhere silent.
 *
 * Every channel falls back to SLACK_CHANNEL_ID when its own env var is unset,
 * so partial configuration degrades to today's behaviour instead of dropping
 * messages.
 */

export type SlackAudience = "platform" | "sales_sdr" | "cs" | "marketplace";

/**
 * Env var(s) holding each audience's channel id, in priority order.
 *
 * sales_sdr accepts two spellings. SLACK_CHANNEL_SDR_SALES is the one actually
 * configured in production (it reads in the same order as the team name and the
 * channel wp-sdr-sales-audits); SLACK_CHANNEL_SALES_SDR was this file's original
 * name and is kept so a deployment set up against it keeps working. Getting this
 * wrong is invisible — a mismatched name silently falls through to
 * SLACK_CHANNEL_ID and the messages land in the old shared channel.
 */
export const AUDIENCE_ENV_VARS: Record<SlackAudience, string[]> = {
  platform: ["SLACK_CHANNEL_PLATFORM"],
  sales_sdr: ["SLACK_CHANNEL_SDR_SALES", "SLACK_CHANNEL_SALES_SDR"],
  cs: ["SLACK_CHANNEL_CS"],
  marketplace: ["SLACK_CHANNEL_MARKETPLACE"],
};

/** Primary env var name per audience — the one to document and set. */
export const AUDIENCE_ENV_VAR: Record<SlackAudience, string> = {
  platform: AUDIENCE_ENV_VARS.platform[0],
  sales_sdr: AUDIENCE_ENV_VARS.sales_sdr[0],
  cs: AUDIENCE_ENV_VARS.cs[0],
  marketplace: AUDIENCE_ENV_VARS.marketplace[0],
};

/**
 * module → audience.
 *
 * Keys are matched case-insensitively against the `module` field. Edit this map
 * to re-route a module; no other change is needed.
 */
const MODULE_AUDIENCE: Record<string, SlackAudience> = {
  // ── The platform and its governance content ──────────────────────────────
  platform: "platform",
  qms: "platform",
  audits: "platform",
  audit: "platform",
  compliance: "platform",
  compliance_tracker: "platform",
  policy_governance: "platform",
  pdpl: "platform",
  risks: "platform",
  risk_management: "platform",
  kpis: "platform",
  training: "platform",
  project: "platform",
  integrations: "platform",
  "ai-governance": "platform",
  ai_ops: "platform",
  ai_governance: "platform",
  "security/redaction-sweep": "platform",
  security: "platform",
  // Fraud is a platform-level compliance function (SAMA/AML), not a business
  // unit's queue — its recipients are GRQ, not a sales team.
  fraud: "platform",

  // Duplicate Radar OPERATIONS — the resolution digest, "merge applied",
  // cluster progress. These are the platform DOING something, and the platform
  // channel is where Sarah works through and improves that behaviour, so they
  // belong with platform status rather than in a team's audit channel
  // (Sarah 2026-09-07; this reverses an earlier reading that put them with
  // Sales). The autonomous runner posts via AUTONOMOUS_RESOLUTION_SLACK_CHANNEL,
  // whose default already targets that channel — leaving it unset is correct.
  duplicates: "platform",
  "duplicate-radar": "platform",

  // ── SDR (B2B) and Sales (B2B) ────────────────────────────────────────────
  // AUDIT FINDINGS on the team's own records — the weekly data-quality audit
  // over corporate/WalaPlus Leads, Deals, Accounts and Contacts. NOTE: the
  // audit spans segments; marketplace findings should go to `marketplace`, but
  // the notification does not yet carry the segment, so everything lands here
  // for now. See resolveSlackAudience's `segment` argument.
  calls: "sales_sdr",
  sdr: "sales_sdr",
  sales: "sales_sdr",
  crm: "sales_sdr",
  roi: "sales_sdr",
  leads: "sales_sdr",
  deals: "sales_sdr",
  accounts: "sales_sdr",
  contacts: "sales_sdr",

  // ── Customer Success (B2B) ───────────────────────────────────────────────
  cs: "cs",
  cs_lifecycle: "cs",
  customer_success: "cs",
  handoff: "cs",
  handoff_tasks: "cs",

  // ── Marketplace / merchants ──────────────────────────────────────────────
  marketplace: "marketplace",
  merchants: "marketplace",
};

/**
 * Decide the audience for a notification.
 *
 * `segment` wins when present: the Duplicate Radar already classifies records
 * as marketplace vs corporate, so a caller that knows the segment can route a
 * marketplace cluster to the marketplace channel even though its module says
 * `duplicates`. Values match the radar's own vocabulary.
 */
export function resolveSlackAudience(
  module?: string | null,
  segment?: string | null,
): SlackAudience {
  const seg = (segment || "").trim().toLowerCase();
  if (seg === "marketplace" || seg === "partner accounts") return "marketplace";

  const key = (module || "").trim().toLowerCase();
  return MODULE_AUDIENCE[key] ?? "platform";
}

/**
 * Resolve the channel id to post to, or null when Slack is unconfigured.
 *
 * Falls back to SLACK_CHANNEL_ID / SLACK_DEFAULT_CHANNEL so that configuring
 * none of the new variables leaves behaviour exactly as it was.
 */
export function resolveSlackChannel(
  module?: string | null,
  segment?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { channel: string | null; audience: SlackAudience } {
  const audience = resolveSlackAudience(module, segment);
  const specific = AUDIENCE_ENV_VARS[audience]
    .map((name) => (env[name] || "").trim())
    .find((v) => v.length > 0);
  const fallback =
    (env.SLACK_CHANNEL_ID || "").trim() ||
    (env.SLACK_DEFAULT_CHANNEL || "").trim();
  return { channel: specific || fallback || null, audience };
}
