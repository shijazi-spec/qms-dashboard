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

/** Env var holding each audience's channel id. */
export const AUDIENCE_ENV_VAR: Record<SlackAudience, string> = {
  platform: "SLACK_CHANNEL_PLATFORM",
  sales_sdr: "SLACK_CHANNEL_SALES_SDR",
  cs: "SLACK_CHANNEL_CS",
  marketplace: "SLACK_CHANNEL_MARKETPLACE",
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

  // ── SDR (B2B) and Sales (B2B) ────────────────────────────────────────────
  calls: "sales_sdr",
  sdr: "sales_sdr",
  sales: "sales_sdr",
  crm: "sales_sdr",
  roi: "sales_sdr",
  // Duplicate Radar. Sarah had no preference; these sit with Sales/SDR because
  // the records being merged are theirs. NOTE: radar traffic spans segments —
  // a marketplace cluster should really go to `marketplace`, but the
  // notification does not currently carry the segment. Routing that correctly
  // needs the segment plumbed through notifyEvent; until then everything lands
  // here. See resolveSlackAudience's `segment` argument.
  duplicates: "sales_sdr",
  "duplicate-radar": "sales_sdr",
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
  const specific = (env[AUDIENCE_ENV_VAR[audience]] || "").trim();
  const fallback =
    (env.SLACK_CHANNEL_ID || "").trim() ||
    (env.SLACK_DEFAULT_CHANNEL || "").trim();
  return { channel: specific || fallback || null, audience };
}
