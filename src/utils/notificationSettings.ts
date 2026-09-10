/**
 * One place to see and change which alerts the platform sends.
 *
 * WHY THIS EXISTS (Sarah 2026-09-07: "why we are going to create secret for
 * each step!"). Twenty-plus on/off switches had accumulated as environment
 * variables — HEALTH_PULSE_SLACK_ALERTS, FRAUD_REMINDERS_ENABLED,
 * SALES_WEEKLY_SLACK_REPORTS, and so on. Each was added in a hurry to stop
 * something noisy, and each brought the same three costs:
 *
 *   · it has to be set in TWO places (Replit workspace AND deployment) and
 *     takes a restart, so a half-configured switch is silent and normal-looking;
 *   · it is invisible from inside the platform, so "this report never arrives"
 *     cannot be told apart from "this report is switched off" without reading
 *     the source;
 *   · nobody could answer "what alerts exist?" at all.
 *
 * That third cost is the real one. This module's REGISTRY is the answer to that
 * question, and the settings screen renders it.
 *
 * PRECEDENCE, deliberately in this order:
 *
 *   1. the database override, when a row exists with a non-null `enabled`
 *   2. the environment variable, when the registry entry names one
 *   3. the registry's own default
 *
 * The env layer is kept rather than replaced so that nothing changes on the day
 * this ships: every switch keeps resolving exactly as it does today until
 * somebody deliberately overrides it in the UI. Env then degrades into what it
 * should have been all along — a deployment default, not the control surface.
 *
 * POLARITY IS NORMALIZED HERE. `enabled: true` always means "this alert is
 * sent", for every row, so the screen can be read without a decoder. One env
 * var is inverted (PLATFORM_SLACK_MUTE=true means NOT sending), and
 * `envInverted` absorbs that here rather than leaking a double negative into
 * the UI — where it would eventually be misread and something would go quiet
 * that nobody meant to silence.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

export type NotificationSwitchKey =
  | "platform_slack_announcements"
  | "health_pulse_slack"
  | "fraud_reminders"
  | "sales_weekly_reports"
  | "direct_audit_slack"
  | "missing_docs_report"
  | "cs_overlap_alert"
  | "cs_lifecycle_alert";

export interface NotificationSwitch {
  key: NotificationSwitchKey;
  /** Shown in the UI. Say what arrives, not what the code is called. */
  label: string;
  /** Where it lands, so the screen can be grouped by channel. */
  channel: "platform" | "sales_sdr" | "cs" | "marketplace" | "email";
  /** When it fires, in words. The question every operator asks second. */
  cadence: string;
  /** What the message contains, so its value is judgeable without a test send. */
  description: string;
  /** Deployment default. Null when the switch has only ever had a hardcoded default. */
  envVar: string | null;
  /** True when the env var means the OPPOSITE of `enabled` (a mute flag). */
  envInverted?: boolean;
  /** Used when neither an override nor an env var says otherwise. */
  defaultEnabled: boolean;
  /**
   * `related_entity_type` on the notifications this switch controls, so the
   * screen can show when it last actually fired. Without this a toggle that has
   * been on for a month but never fired looks identical to a working one.
   */
  lastFiredEntityType?: string;
}

/**
 * Every alert the platform can send, and the single source of truth for what
 * exists. Adding an alert without adding it here means it is invisible again —
 * which is the whole problem this module was built to end.
 */
export const NOTIFICATION_SWITCHES: NotificationSwitch[] = [
  {
    key: "platform_slack_announcements",
    label: "Platform channel announcements",
    channel: "platform",
    cadence: "continuous — carries several senders",
    description:
      "Master switch for grq-platform-status: resolution digest, merge-applied pings, the weekly leadership brief, the executive digest and the audit scorecard. Turning this off silences all of them at once.",
    envVar: "PLATFORM_SLACK_MUTE",
    envInverted: true,
    defaultEnabled: true,
  },
  {
    key: "health_pulse_slack",
    label: "Platform Health alerts",
    channel: "platform",
    cadence: "every ~45 min, on a worsening only",
    description:
      "Posts when a health check starts failing. Suppressed while the in-platform health view is being finished; the pulse still runs and records history either way.",
    envVar: "HEALTH_PULSE_SLACK_ALERTS",
    defaultEnabled: false,
  },
  {
    key: "fraud_reminders",
    label: "Fraud periodic reminders",
    channel: "platform",
    cadence: "rule review daily · country risk semi-annual · KPI monthly",
    description:
      "The four recurring fraud/AML housekeeping reminders. Does NOT cover SAMA deadline or incident-SLA escalations, which are addressed emails and are never gated here.",
    envVar: "FRAUD_REMINDERS_ENABLED",
    defaultEnabled: false,
  },
  {
    key: "sales_weekly_reports",
    label: "Sales daily audit reports",
    channel: "sales_sdr",
    cadence: "every morning from 07:00 KSA, only when there is something to report",
    description:
      "Deal compliance (deals missing documents, Paid excluded) and active deal conflicts (accounts with more than one open deal). WalaPlus/corporate only — marketplace is a different team. Silent when both are clean.",
    envVar: "SALES_WEEKLY_SLACK_REPORTS",
    // ON by default. This is the SDR/Sales team's standing daily audit, not an
    // opt-in: Sarah 2026-09-10, "the sales team solve most of them", so the
    // list is worth re-cutting every morning rather than once a week. The key
    // and envVar keep their "weekly" names so any stored override and any
    // configured secret keep resolving; only the cadence changed.
    defaultEnabled: true,
  },
  {
    key: "direct_audit_slack",
    label: "Quality audit results",
    channel: "platform",
    cadence: "weekly, after each audit run",
    description:
      "The combined scorecard for the platform channel. The per-department summaries that go to the Sales, CS and Marketplace channels are separate and not gated by this.",
    envVar: "DIRECT_AUDIT_SLACK_NOTIFY",
    defaultEnabled: true,
  },
  {
    key: "missing_docs_report",
    label: "Monthly missing-documents report",
    channel: "email",
    cadence: "monthly, on the configured send day",
    description:
      "Emailed to the configured recipients rather than posted to Slack. Needs RESEND_API_KEY to actually leave the building.",
    envVar: "MISSING_DOCS_REPORT_ENABLED",
    defaultEnabled: false,
  },
  {
    key: "cs_overlap_alert",
    label: "CS pipeline overlap BLOCKs",
    channel: "cs",
    cadence: "daily, only when something is blocking",
    description:
      "Open Sales deal coexisting with a paid CS handoff. Blocks a marketing push until resolved.",
    envVar: null,
    defaultEnabled: true,
    lastFiredEntityType: "cs_pipeline_overlap",
  },
  {
    key: "cs_lifecycle_alert",
    label: "CS lifecycle critical violations",
    channel: "cs",
    cadence: "daily, only when there are criticals",
    description:
      "The 12 CS lifecycle rules, broken down by rule, CS owner and account. One-working-day SLA on criticals.",
    envVar: null,
    defaultEnabled: true,
    lastFiredEntityType: "cs_lifecycle_violations",
  },
];

const SWITCH_BY_KEY = new Map(NOTIFICATION_SWITCHES.map((s) => [s.key, s]));

/* ── storage ─────────────────────────────────────────────────────────────── */

let initPromise: Promise<void> | null = null;

export async function initNotificationSettings(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // `enabled` is deliberately NULLABLE. NULL means "no override — fall
    // through to env or default", which is a different state from an explicit
    // false. Without it, clearing an override would be impossible without
    // deleting the row and losing who set it and when.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_settings (
        key         VARCHAR(100) PRIMARY KEY,
        enabled     BOOLEAN,
        updated_by  VARCHAR(255),
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    // Every change is kept. These switches decide whether a compliance alert
    // reaches anyone, so "who turned this off, and when" has to be answerable
    // months later.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_settings_audit (
        id          SERIAL PRIMARY KEY,
        key         VARCHAR(100) NOT NULL,
        changed_at  TIMESTAMP DEFAULT NOW(),
        changed_by  VARCHAR(255) NOT NULL,
        before_enabled BOOLEAN,
        after_enabled  BOOLEAN,
        note        TEXT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_notification_settings_audit_changed_at
        ON notification_settings_audit(changed_at DESC)
    `);
  })().catch((err) => {
    // Reset so a transient failure at boot does not poison every later call
    // with a permanently rejected promise.
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/* ── resolution ──────────────────────────────────────────────────────────── */

/**
 * Overrides are cached briefly.
 *
 * Not an optimisation for its own sake: this deployment already runs close to
 * its Postgres connection cap, and the scheduler tick evaluates most of these
 * switches within a few seconds of each other. 30s is long enough to collapse
 * one tick into a single query and short enough that a toggle in the UI takes
 * effect while the operator is still looking at the screen.
 */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; rows: Map<string, boolean | null> } | null = null;

export function clearNotificationSettingsCache(): void {
  cache = null;
}

async function loadOverrides(): Promise<Map<string, boolean | null>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = new Map<string, boolean | null>();
  try {
    await initNotificationSettings();
    const res = await pool.query<{ key: string; enabled: boolean | null }>(
      `SELECT key, enabled FROM notification_settings`,
    );
    for (const r of res.rows) rows.set(r.key, r.enabled);
  } catch (err) {
    // Fail through to env/default rather than throwing. A settings lookup that
    // errors must not decide, by accident, that an alert is off — that would
    // turn a database hiccup into silent missed compliance alerts.
    logger.warn(
      "[NotificationSettings] Override lookup failed; using env/defaults:",
      err instanceof Error ? err.message : String(err),
    );
    return rows;
  }
  cache = { at: Date.now(), rows };
  return rows;
}

/** Parse an env var the way the rest of this codebase does. */
function envSaysTrue(raw: string | undefined): boolean {
  return String(raw || "").toLowerCase() === "true";
}

/**
 * Resolve one switch WITHOUT touching the database — env and default only.
 *
 * Exported because it is what the resolution actually falls back to, and a test
 * that cannot check the fallback in isolation cannot prove the precedence.
 */
export function resolveFromEnv(
  sw: NotificationSwitch,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; source: "env" | "default" } {
  if (sw.envVar && String(env[sw.envVar] ?? "").trim() !== "") {
    const raw = envSaysTrue(env[sw.envVar]);
    return { enabled: sw.envInverted ? !raw : raw, source: "env" };
  }
  return { enabled: sw.defaultEnabled, source: "default" };
}

export interface ResolvedSwitch extends NotificationSwitch {
  enabled: boolean;
  /** Which layer decided. The screen shows this so the answer is never a guess. */
  source: "override" | "env" | "default";
}

/** Resolve every switch, for the settings screen and the admin API. */
export async function resolveAllNotificationSettings(): Promise<
  ResolvedSwitch[]
> {
  const overrides = await loadOverrides();
  return NOTIFICATION_SWITCHES.map((sw) => {
    const ov = overrides.get(sw.key);
    if (ov === true || ov === false) {
      return { ...sw, enabled: ov, source: "override" as const };
    }
    const { enabled, source } = resolveFromEnv(sw);
    return { ...sw, enabled, source };
  });
}

/**
 * The one call every sender makes.
 *
 * An unknown key returns TRUE. A typo must not silently disable an alert — the
 * failure this whole module exists to prevent is a message nobody gets and
 * nobody knows is missing.
 */
export async function isNotificationEnabled(
  key: NotificationSwitchKey,
): Promise<boolean> {
  const sw = SWITCH_BY_KEY.get(key);
  if (!sw) {
    logger.warn(
      `[NotificationSettings] Unknown switch "${key}" — allowing the send.`,
    );
    return true;
  }
  const overrides = await loadOverrides();
  const ov = overrides.get(key);
  if (ov === true || ov === false) return ov;
  return resolveFromEnv(sw).enabled;
}

/**
 * Synchronous variant, for the one caller that cannot await.
 *
 * resolveSlackChannel is synchronous and called from a dozen places; making it
 * async to read a setting would ripple through every Slack sender for no gain.
 * This reads the same cache when it is warm and falls back to env/default when
 * it is not — so the worst case is exactly today's behaviour, never a wrong
 * silence.
 *
 * The cache is warm in practice: the scheduler tick resolves settings on every
 * pass, and setNotificationOverride re-populates it before returning, so a
 * toggle in the UI is live immediately rather than after the next tick.
 */
export function isNotificationEnabledSync(
  key: NotificationSwitchKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const sw = SWITCH_BY_KEY.get(key);
  if (!sw) return true;
  if (cache) {
    const ov = cache.rows.get(key);
    if (ov === true || ov === false) return ov;
  }
  return resolveFromEnv(sw, env).enabled;
}

/**
 * Warm the cache so the synchronous path has real data.
 *
 * Called once from the scheduler's boot tick. Never throws — a cold cache is a
 * degraded state (env-only), not a broken one.
 */
export async function primeNotificationSettings(): Promise<void> {
  try {
    await loadOverrides();
  } catch {
    /* loadOverrides already logs and degrades; nothing to add here */
  }
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/**
 * Set or clear one override. `enabled: null` clears it, returning the switch to
 * whatever env/default says — which is a real operation, not a delete: the row
 * stays so the audit trail keeps its shape.
 */
export async function setNotificationOverride(
  key: NotificationSwitchKey,
  enabled: boolean | null,
  changedBy: string,
  note?: string,
): Promise<ResolvedSwitch> {
  const sw = SWITCH_BY_KEY.get(key);
  if (!sw) throw new Error(`Unknown notification switch: ${key}`);
  await initNotificationSettings();

  const before = await pool.query<{ enabled: boolean | null }>(
    `SELECT enabled FROM notification_settings WHERE key = $1`,
    [key],
  );
  const beforeEnabled = before.rows[0]?.enabled ?? null;

  await pool.query(
    `INSERT INTO notification_settings (key, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [key, enabled, changedBy],
  );

  try {
    await pool.query(
      `INSERT INTO notification_settings_audit (key, changed_by, before_enabled, after_enabled, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, changedBy, beforeEnabled, enabled, note || null],
    );
  } catch (err) {
    // The setting is already saved. Losing the audit row is bad but silently
    // failing the save the operator just made is worse.
    logger.error("[NotificationSettings] Audit write failed:", err);
  }

  clearNotificationSettingsCache();
  const all = await resolveAllNotificationSettings();
  return all.find((s) => s.key === key)!;
}

/**
 * When each switch's notification last actually fired.
 *
 * Answers the question a list of toggles cannot: a switch that has been on for
 * a month and never fired looks exactly like a working one. Only switches that
 * declare `lastFiredEntityType` can be dated; the rest return null rather than
 * a guess.
 */
export async function getLastFiredTimes(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const keyed = NOTIFICATION_SWITCHES.filter((s) => s.lastFiredEntityType);
  for (const sw of NOTIFICATION_SWITCHES) out[sw.key] = null;
  if (keyed.length === 0) return out;
  try {
    const { notificationPool } = await import("./notificationHub");
    const res = await notificationPool.query<{
      related_entity_type: string;
      last_at: string;
    }>(
      `SELECT related_entity_type, MAX(created_at) AS last_at
         FROM notifications
        WHERE related_entity_type = ANY($1::text[])
        GROUP BY related_entity_type`,
      [keyed.map((s) => s.lastFiredEntityType)],
    );
    const byType = new Map(
      res.rows.map((r) => [r.related_entity_type, r.last_at]),
    );
    for (const sw of keyed) {
      const v = byType.get(sw.lastFiredEntityType!);
      out[sw.key] = v ? new Date(v).toISOString() : null;
    }
  } catch (err) {
    logger.warn(
      "[NotificationSettings] last-fired lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return out;
}
