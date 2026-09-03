/**
 * Persisted, runtime-editable lists of email recipients for opt-in
 * operator alerts (Task #573).
 *
 * Why a DB row?
 *   The post-restore redaction sweep alert (Task #555) and the daily
 *   AI cost summary cron (`AI_COST_ALERT_EMAIL`) both read recipients
 *   from environment variables, which means adding or removing someone
 *   from the page list requires a redeploy/restart. That is friction
 *   during an incident handover or when a team member leaves. This
 *   table backs an in-product settings panel so admins can update the
 *   list without ops involvement; the dispatchers re-read the row on
 *   every send so a save takes effect on the next sweep — no restart.
 *
 * Schema
 *   alert_email_recipients      — append-only table of (channel,email)
 *                                  pairs. UNIQUE(channel, email_lower)
 *                                  so duplicates are silently no-op'd
 *                                  rather than thrown back at the UI.
 *   alert_email_recipients_audit — append-only history of add/remove
 *                                  operations. Surfaced on the dashboard
 *                                  so future-you knows who removed the
 *                                  outgoing on-call before last week's
 *                                  incident.
 *
 * Resolution precedence (used by `resolveEffectiveRecipients()`):
 *   1. Trimmed, deduped DB list (this table) — when non-empty.
 *   2. Trimmed, deduped env-var list — fallback.
 * The env var continues to work as-is for deployments that haven't
 * adopted the dashboard. Once an admin adds even one row to the DB
 * list, the env var stops being consulted (matches operator
 * expectation: "the page list I see in the UI is the page list that
 * goes out").
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

/**
 * The two opt-in recipient lists this module manages. Kept narrow on
 * purpose so the admin UI / API can validate the channel server-side
 * against a closed set rather than accepting any free-form string.
 *
 * Add a new channel by:
 *   1. Adding it to this union (and {@link ALERT_CHANNELS} below).
 *   2. Wiring `resolveEffectiveRecipients(channel, envValue)` into the
 *      dispatcher that previously read the env var directly.
 *   3. Surfacing it in the admin UI's channel dropdown.
 */
export type AlertChannel = "post_restore_sweep" | "ai_cost";

/**
 * Closed set of valid channels — used by the admin API for input
 * validation and by tests for round-trip coverage. Keep in sync with
 * the {@link AlertChannel} union.
 */
export const ALERT_CHANNELS = [
  "post_restore_sweep",
  "ai_cost",
] as const satisfies ReadonlyArray<AlertChannel>;

export interface AlertRecipientRow {
  email: string;
  added_by: string | null;
  added_at: Date | null;
}

export interface AlertRecipientAuditEntry {
  id: number;
  changed_at: Date;
  changed_by: string;
  channel: AlertChannel;
  action: "add" | "remove";
  email: string;
  note: string | null;
}

/**
 * RFC-5322 is too forgiving for sane operator UX (it allows quoted
 * local-parts with embedded `@` etc). Mirror what every real-world
 * form does: `user@example.invalid`, no whitespace, ≤ 254 chars
 * (the SMTP envelope limit). The dispatcher itself will pass anything
 * we accept here through to Resend, so this is also our last line of
 * defence against typo'd entries that would silently break the page.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const EMAIL_MAX_LEN = 254;

/**
 * Validate + normalise a candidate email. Returns the trimmed,
 * lower-cased form when valid, or `null` otherwise. Lower-casing here
 * is what makes the UNIQUE(channel, email_lower) constraint do the
 * right thing for case-only collisions ("user@example.invalid" vs
 * "user@example.invalid").
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LEN) return null;
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Validate that `value` is one of the closed-set channels. Returns the
 * narrowed channel or `null`.
 */
export function parseChannel(value: unknown): AlertChannel | null {
  if (typeof value !== "string") return null;
  return (ALERT_CHANNELS as ReadonlyArray<string>).includes(value)
    ? (value as AlertChannel)
    : null;
}

let initPromise: Promise<void> | null = null;

export async function initAlertEmailRecipientsTable(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_recipients (
        id          SERIAL PRIMARY KEY,
        channel     VARCHAR(64)  NOT NULL,
        email       VARCHAR(254) NOT NULL,
        email_lower VARCHAR(254) NOT NULL,
        added_by    VARCHAR(255),
        added_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE (channel, email_lower)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_channel
        ON alert_email_recipients(channel)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alert_email_recipients_audit (
        id         SERIAL PRIMARY KEY,
        changed_at TIMESTAMP DEFAULT NOW(),
        changed_by VARCHAR(255) NOT NULL,
        channel    VARCHAR(64)  NOT NULL,
        action     VARCHAR(16)  NOT NULL,
        email      VARCHAR(254) NOT NULL,
        note       TEXT
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_audit_changed_at
        ON alert_email_recipients_audit(changed_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_email_recipients_audit_channel
        ON alert_email_recipients_audit(channel)
    `);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

/**
 * @internal Test-only — drops the cached init promise so a subsequent
 * call to {@link initAlertEmailRecipientsTable} re-runs the schema
 * bootstrap. Used by `tests/alertEmailRecipients.test.ts`.
 */
export function __resetInitPromiseForTests(): void {
  initPromise = null;
}

/**
 * List the currently-saved recipients for `channel`, ordered by
 * `added_at ASC` so the UI shows oldest-first (mirrors a typical "page
 * list" reading order). Returns `[]` on a fresh table or on a DB read
 * error so the dispatcher can transparently fall back to the env var.
 */
export async function listAlertRecipients(
  channel: AlertChannel,
): Promise<AlertRecipientRow[]> {
  try {
    await initAlertEmailRecipientsTable();
    const result = await pool.query(
      `SELECT email, added_by, added_at
         FROM alert_email_recipients
        WHERE channel = $1
        ORDER BY added_at ASC, id ASC`,
      [channel],
    );
    return (result.rows ?? []).map((r: any) => ({
      email: String(r.email),
      added_by: r.added_by ?? null,
      added_at: r.added_at ?? null,
    }));
  } catch (err) {
    logger.error("[alertEmailRecipients] list failed", err as Error);
    return [];
  }
}

export interface AddAlertRecipientResult {
  added: boolean;
  email: string;
  reason?: "duplicate";
}

/**
 * Insert (channel, email). Returns `{ added: false, reason: 'duplicate' }`
 * when the email already exists for this channel — duplicates are silent
 * no-ops at the DB layer thanks to the UNIQUE index, and we mirror that
 * up to the API so re-saving the same form on a flaky connection isn't
 * surfaced as an error to the operator. Throws on validation failure.
 */
export async function addAlertRecipient(params: {
  channel: AlertChannel;
  email: string;
  changedBy: string;
  note?: string | null;
}): Promise<AddAlertRecipientResult> {
  const normalised = normaliseEmail(params.email);
  if (!normalised) {
    throw new Error(`Invalid email address: ${params.email}`);
  }
  await initAlertEmailRecipientsTable();
  const note =
    params.note != null && params.note !== ""
      ? String(params.note).slice(0, 500)
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO alert_email_recipients
         (channel, email, email_lower, added_by, added_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (channel, email_lower) DO NOTHING
       RETURNING id`,
      [params.channel, normalised, normalised, params.changedBy],
    );
    if ((ins.rows ?? []).length === 0) {
      await client.query("COMMIT");
      return { added: false, email: normalised, reason: "duplicate" };
    }
    await client.query(
      `INSERT INTO alert_email_recipients_audit
         (changed_by, channel, action, email, note)
       VALUES ($1, $2, 'add', $3, $4)`,
      [params.changedBy, params.channel, normalised, note],
    );
    await client.query("COMMIT");
    return { added: true, email: normalised };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface RemoveAlertRecipientResult {
  removed: boolean;
  email: string;
}

/**
 * Remove (channel, email). Returns `{ removed: false }` when no row
 * matched — mirrors the UNIQUE-constraint-driven semantics of
 * {@link addAlertRecipient} so the API can return 200 with an
 * informational payload rather than 404 when an admin double-clicks
 * the trash icon during a slow round-trip.
 */
export async function removeAlertRecipient(params: {
  channel: AlertChannel;
  email: string;
  changedBy: string;
  note?: string | null;
}): Promise<RemoveAlertRecipientResult> {
  const normalised = normaliseEmail(params.email);
  if (!normalised) {
    throw new Error(`Invalid email address: ${params.email}`);
  }
  await initAlertEmailRecipientsTable();
  const note =
    params.note != null && params.note !== ""
      ? String(params.note).slice(0, 500)
      : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = await client.query(
      `DELETE FROM alert_email_recipients
        WHERE channel = $1 AND email_lower = $2
       RETURNING id`,
      [params.channel, normalised],
    );
    if ((del.rows ?? []).length === 0) {
      await client.query("COMMIT");
      return { removed: false, email: normalised };
    }
    await client.query(
      `INSERT INTO alert_email_recipients_audit
         (changed_by, channel, action, email, note)
       VALUES ($1, $2, 'remove', $3, $4)`,
      [params.changedBy, params.channel, normalised, note],
    );
    await client.query("COMMIT");
    return { removed: true, email: normalised };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Return the most recent audit entries for `channel` (newest first).
 * Limit defaults to 25 to match other "tuning audit" surfaces in the
 * dashboard; callers may request up to 200.
 */
export async function listAlertRecipientsAudit(
  channel: AlertChannel,
  limit = 25,
): Promise<AlertRecipientAuditEntry[]> {
  try {
    await initAlertEmailRecipientsTable();
    const safeLimit = Math.max(
      1,
      Math.min(200, Math.floor(Number(limit) || 25)),
    );
    const result = await pool.query(
      `SELECT id, changed_at, changed_by, channel, action, email, note
         FROM alert_email_recipients_audit
        WHERE channel = $1
        ORDER BY changed_at DESC, id DESC
        LIMIT $2`,
      [channel, safeLimit],
    );
    return (result.rows ?? []).map((r: any) => ({
      id: Number(r.id),
      changed_at: r.changed_at,
      changed_by: String(r.changed_by),
      channel: r.channel as AlertChannel,
      action: r.action === "remove" ? "remove" : "add",
      email: String(r.email),
      note: r.note ?? null,
    }));
  } catch (err) {
    logger.error("[alertEmailRecipients] audit read failed", err as Error);
    return [];
  }
}

/**
 * Pure helper: split a comma-separated env value into trimmed,
 * deduped, lower-cased recipient strings. Empty / whitespace-only
 * entries are dropped. Exported so the dispatcher tests can probe
 * env-fallback parsing without going through the DB.
 */
export function parseRecipientsEnvValue(
  raw: string | undefined | null,
): string[] {
  if (!raw || typeof raw !== "string") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(trimmed);
  }
  return out;
}

export interface ResolveRecipientsOptions {
  /**
   * Override the recipient lister (used by tests to avoid touching
   * the DB). Defaults to {@link listAlertRecipients}.
   */
  list?: (channel: AlertChannel) => Promise<AlertRecipientRow[]>;
}

export interface ResolvedRecipients {
  /** The recipient list the dispatcher should send to. */
  recipients: string[];
  /** Where the list came from — surfaced for telemetry / tests. */
  source: "db" | "env" | "none";
}

/**
 * Resolve the effective recipient list for `channel` using the
 * documented precedence (DB > env > nothing). The DB read is
 * fault-tolerant (returns `[]` on error) so a transient pool hiccup
 * never silently switches recipient lists; in that case we transparently
 * fall through to the env-var fallback.
 *
 * The env-fallback path preserves the exact behaviour Task #555 / the
 * AI cost-summary cron shipped, so existing deployments that haven't
 * touched the dashboard see no change.
 */
export async function resolveEffectiveRecipients(
  channel: AlertChannel,
  envValue: string | undefined | null,
  options: ResolveRecipientsOptions = {},
): Promise<ResolvedRecipients> {
  const list = options.list ?? listAlertRecipients;
  const dbRows = await list(channel);
  if (dbRows.length > 0) {
    // De-dupe defensively even though the UNIQUE constraint should
    // already have prevented dupes — protects against a future schema
    // change or a manual psql insert that bypassed the constraint.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of dbRows) {
      const lower = row.email.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(row.email);
    }
    return { recipients: out, source: "db" };
  }
  const envList = parseRecipientsEnvValue(envValue ?? undefined);
  if (envList.length > 0) {
    return { recipients: envList, source: "env" };
  }
  return { recipients: [], source: "none" };
}
