/**
 * Weekly Digest Cron
 *
 * Fires every Sunday at 06:00 Asia/Riyadh (= 03:00 UTC). Calls
 * sendWeeklyDigest() which is flag-gated on WEEKLY_DIGEST, so this
 * cron wakes up but does nothing until the flag is flipped — that's
 * the deploy-free toggle for go-live.
 *
 * The actual digest data + rendering + dispatch logic lives in
 * src/utils/weeklyDigest.ts. This file is just the schedule wiring.
 *
 * To wire into the Mastra inngest function set, add:
 *   import { weeklyDigestCronWorkflow } from "../workflows/weeklyDigestCron";
 *   registerCronWorkflow("0 3 * * 0", weeklyDigestCronWorkflow);
 * to src/mastra/inngest/index.ts.
 *
 * Cron expression: "0 3 * * 0"
 *   minute=0, hour=3 (UTC), any day of month, any month, day=0 (Sunday)
 *   → Sunday 03:00 UTC = Sunday 06:00 Asia/Riyadh
 */

import { logger } from "../../utils/logger";
import { sendWeeklyDigest } from "../../utils/weeklyDigest";

/** Cron expression: every Sunday 03:00 UTC = 06:00 Asia/Riyadh. */
export const WEEKLY_DIGEST_CRON = "0 3 * * 0";

/**
 * Workflow callable expected by registerCronWorkflow. Returns a
 * structured result for logging / dead-letter recording, never throws.
 */
export async function weeklyDigestCronWorkflow(): Promise<{
  ok: boolean;
  sent?: boolean;
  <REDACTED_TOKEN>?: string;
  slack_ok?: boolean;
  email_ok?: boolean;
  error?: string;
}> {
  try {
    // Dynamic import so the cron file doesn't pull in pg at module-load.
    const { callIntelligencePool, initCallIntelligenceTables } = await import(
      "../../utils/callIntelligenceDb"
    );
    await initCallIntelligenceTables();

    const result = await sendWeeklyDigest(callIntelligencePool, {
      // identity=null so the flag check uses ONLY the global toggle —
      // a per-user override doesn't make sense for an org-wide digest.
      identity: null,
    });

    logger.info("[weeklyDigestCron] fired", {
      sent: result.sent,
      skipped: result.<REDACTED_TOKEN>,
      slack_ok: result.slack.ok,
      email_ok: result.email.ok,
      window: result.digest_summary?.window_label,
      agents: result.digest_summary?.agents_active,
    });

    return {
      ok: true,
      sent: result.sent,
      <REDACTED_TOKEN>: result.<REDACTED_TOKEN>,
      slack_ok: result.slack.ok,
      email_ok: result.email.ok,
    };
  } catch (err: any) {
    logger.error("[weeklyDigestCron] threw", {
      error: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
  }
}
