/**
 * Fraud compliance checks that run on a schedule.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * These six checks lived inline in the Inngest cron bodies, which made them
 * unreachable from anywhere else. Two problems followed:
 *
 *   1. Inngest crons do not fire on this deployment (proven: ai-approval-expiry
 *      is a one-line UPDATE scheduled every 15 minutes, and on 2026-09-07 not
 *      one row had EVER been expired while 275 sat eligible). The in-process
 *      fallback in src/mastra/index.ts is what actually runs — and it could not
 *      call logic buried inside a cron closure.
 *
 *   2. Every check delivered with `createNotification({ channel: "in_app" })`.
 *      That function delivers ONLY on the channel it is given, and the in-app
 *      feed has no reachable reader (triggerRoutes shadows the hub's GET
 *      /api/notifications). So even on a deployment where the crons DID fire,
 *      these notified nobody. A SAMA 72-hour deadline warning went nowhere.
 *
 * Extracting them here fixes both: the cron and the fallback call the same
 * function, and delivery is explicit.
 *
 * DELIVERY SPLIT (agreed with Sarah, 2026-09-07)
 * ---------------------------------------------
 *   Slack  — the four periodic reminders (rule review, country review, KPI
 *            month-end, incident-overdue). Internal operational prompts with no
 *            recipient sensitivity. Sent as ONE aggregated message per run
 *            rather than one per item: routing routine per-row traffic to Slack
 *            is what got the weekly digest switched off.
 *
 *   Email  — the two incident-specific checks (SAMA deadline, containment SLA).
 *            These name individual open incidents, which is the same territory
 *            as the escalation dispatch in fraudDatabase.ts where the AML
 *            no-tipping-off rule applies. A shared channel would widen the
 *            circle of knowledge; addressed email preserves it.
 *
 * The per-item in-app rows are still written in every case. They are the local
 * record of what was raised, carry the entity linkage the Slack/email copy
 * cannot, and become visible the moment the hub feed gets a reader.
 */

import { logger } from "./logger";

/** True when Resend is configured; false means email delivery is a no-op. */
function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * The four PERIODIC reminders are OFF by default (Sarah 2026-09-07: "stop this
 * type of notification till I prepare it finally inside the platform").
 *
 * They are calendar prompts — rule review due, country register due, month-end
 * KPI, incidents past 30 days — and their content and cadence are still being
 * settled. Shipping them enabled put a semi-annual reminder into Slack four
 * times in one morning.
 *
 * Set FRAUD_REMINDERS_ENABLED=true to turn them on. Deliberately opt-IN rather
 * than opt-out: an unfinished reminder that stays quiet costs nothing, whereas
 * one that fires teaches people to ignore the channel.
 *
 * This gate does NOT cover the two incident-specific checks — the SAMA 72-hour
 * deadline and the containment-SLA breach. Those are not calendar prompts; they
 * name real open incidents against regulatory clocks, and silencing them by
 * default would be a different and worse decision.
 */
async function remindersEnabled(): Promise<boolean> {
  try {
    const { isNotificationEnabled } = await import("./notificationSettings");
    return await isNotificationEnabled("fraud_reminders");
  } catch {
    return (
      String(process.env.FRAUD_REMINDERS_ENABLED || "").toLowerCase() === "true"
    );
  }
}

/** Shared early-exit + log for the four gated reminders. */
async function remindersDisabled(checkName: string): Promise<boolean> {
  if (await remindersEnabled()) return false;
  logger.info(
    `[FraudChecks] ${checkName} skipped — fraud reminders are off in notification settings.`,
  );
  return true;
}

/**
 * One aggregated Slack/email announcement for a whole run.
 *
 * `notifyEvent` fans out to Slack and email at critical|high and to in-app
 * only below that — so anything routed here is deliberately at least "high".
 */
async function announce(event: {
  type: string;
  title: string;
  message: string;
  priority: "critical" | "high";
  actionUrl: string;
  entityType?: string;
  entityId?: string;
}): Promise<void> {
  try {
    const { notifyEvent } = await import("./notificationHub");
    await notifyEvent({
      type: event.type,
      module: "fraud",
      title: event.title,
      message: event.message,
      priority: event.priority,
      entityType: event.entityType,
      entityId: event.entityId,
      actionUrl: event.actionUrl,
    });
  } catch (err) {
    logger.error("[FraudChecks] Slack/email announcement failed:", err);
  }
}

/** Addressed email to one named recipient, for the incident-specific checks. */
async function emailRecipient(
  recipient: string,
  fields: {
    title: string;
    message: string;
    priority: "critical" | "high";
    relatedEntityId: string;
    actionUrl: string;
  },
): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const { createNotification } = await import("./notificationHub");
    await createNotification({
      title: fields.title,
      message: fields.message,
      module: "fraud",
      priority: fields.priority,
      channel: "email",
      recipient,
      related_entity_type: "fraud_incident",
      related_entity_id: fields.relatedEntityId,
      action_url: fields.actionUrl,
    });
    return true;
  } catch (err) {
    logger.error(`[FraudChecks] Email to ${recipient} failed:`, err);
    return false;
  }
}

/** In-app record row. Never the delivery mechanism — see the module header. */
async function record(fields: {
  title: string;
  message: string;
  priority: "critical" | "high" | "medium" | "low";
  recipient: string;
  relatedEntityType: string;
  relatedEntityId: string;
  actionUrl: string;
}): Promise<boolean> {
  try {
    const { createNotification } = await import("./notificationHub");
    await createNotification({
      title: fields.title,
      message: fields.message,
      module: "fraud",
      priority: fields.priority,
      channel: "in_app",
      recipient: fields.recipient,
      related_entity_type: fields.relatedEntityType,
      related_entity_id: fields.relatedEntityId,
      action_url: fields.actionUrl,
    });
    return true;
  } catch (err) {
    logger.error("[FraudChecks] In-app record failed:", err);
    return false;
  }
}

/**
 * Has this check already been announced recently?
 *
 * The in-process throttles in scheduledJobs.ts reset on every restart, so a
 * semi-annual reminder fired three times in thirty minutes across three
 * republishes on 2026-09-07. Anything that runs less often than the deploy
 * cadence needs a check that OUTLIVES the process, so this asks the
 * notifications table — the same rows these checks already write — whether an
 * announcement for this entity exists inside the window.
 *
 * Fails OPEN (returns false) on error: a dedup lookup failing must not silence
 * a compliance reminder.
 */
async function announcedWithinDays(
  relatedEntityType: string,
  relatedEntityId: string,
  days: number,
): Promise<boolean> {
  try {
    const { notificationPool } = await import("./notificationHub");
    const res = await notificationPool.query(
      `SELECT 1
         FROM notifications
        WHERE related_entity_type = $1
          AND related_entity_id = $2
          AND module = 'fraud'
          AND created_at > NOW() - MAKE_INTERVAL(days => $3)
        LIMIT 1`,
      [relatedEntityType, relatedEntityId, days],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn(
      "[FraudChecks] Dedup lookup failed; announcing anyway:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

function envRecipients(varName: string, fallback: string): string[] {
  return (process.env[varName] || fallback)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/* ── SLACK-DELIVERED: periodic operational reminders ─────────────────────── */

/** Fraud rules whose next_review falls within 14 days. Daily. */
export async function runFraudRuleReviewReminder(): Promise<{
  notified: number;
  total_due: number;
}> {
  if (await remindersDisabled("rule-review")) return { notified: 0, total_due: 0 };

  const { getFraudRulesNeedingReviewSoon, initFraudTables } = await import(
    "./fraudDatabase"
  );
  await initFraudTables();
  const due = await getFraudRulesNeedingReviewSoon(14);
  if (due.length === 0) {
    logger.info("[FraudRuleReviewReminder] No rules due in the next 14 days");
    return { notified: 0, total_due: 0 };
  }

  let notified = 0;
  for (const rule of due) {
    const ok = await record({
      title: `Fraud rule review due: ${rule.rule_id}`,
      message: `Rule "${rule.rule_name}" (${rule.rule_id}) needs review by ${String(rule.next_review).slice(0, 10)}. Owner: ${rule.owner}.`,
      priority: "medium",
      recipient: rule.owner,
      relatedEntityType: "fraud_rule",
      relatedEntityId: String(rule.id ?? rule.rule_id),
      actionUrl: "/fraud-rules",
    });
    if (ok) notified++;
  }

  // ONE Slack message for the whole run, not one per rule.
  await announce({
    type: "fraud_rule_review_due",
    title: `${due.length} fraud rule(s) due for review within 14 days`,
    message: due
      .map(
        (r: any) =>
          `• ${r.rule_id} — "${r.rule_name}" by ${String(r.next_review).slice(0, 10)} (owner: ${r.owner})`,
      )
      .join("\n"),
    priority: "high",
    actionUrl: "/fraud-rules",
    entityType: "fraud_rule",
  });

  logger.info(
    `[FraudRuleReviewReminder] ${due.length} due; ${notified} recorded`,
  );
  return { notified, total_due: due.length };
}

/** Incidents open past 30 days with no resolution_date. Daily. */
export async function runFraudIncidentOverdueCheck(): Promise<{
  notified: number;
  overdue: number;
}> {
  if (await remindersDisabled("incident-overdue")) return { notified: 0, overdue: 0 };

  const { getOverdueFraudIncidents, initFraudTables } = await import(
    "./fraudDatabase"
  );
  await initFraudTables();
  const overdue = await getOverdueFraudIncidents(30);
  if (overdue.length === 0) return { notified: 0, overdue: 0 };

  const recipient =
    process.env.FRAUD_OVERDUE_NOTIFY_EMAIL || "head.grq@walaplus.com";
  let notified = 0;
  for (const inc of overdue) {
    const ok = await record({
      title: `Fraud incident overdue (>30 days): ${inc.incident_code}`,
      message: `Incident ${inc.incident_code} (${inc.severity}) detected ${String(inc.date_detected).slice(0, 10)} has no resolution_date. Status: ${inc.status}.`,
      priority: "high",
      recipient,
      relatedEntityType: "fraud_incident",
      relatedEntityId: String(inc.id),
      actionUrl: "/fraud-incidents",
    });
    if (ok) notified++;
  }

  await announce({
    type: "fraud_incident_overdue",
    title: `${overdue.length} fraud incident(s) overdue past the 30-day SAMA resolution requirement`,
    message: overdue
      .map(
        (i: any) =>
          `• ${i.incident_code} (${i.severity}) detected ${String(i.date_detected).slice(0, 10)} — status ${i.status}`,
      )
      .join("\n"),
    priority: "high",
    actionUrl: "/fraud-incidents",
    entityType: "fraud_incident",
  });

  logger.info(
    `[FraudIncidentOverdue] ${overdue.length} overdue; ${notified} recorded`,
  );
  return { notified, overdue: overdue.length };
}

/** FATF plenary refresh prompt. Semi-annual. */
export async function runFraudCountryReviewReminder(): Promise<{
  notified: number;
  blacklisted: number;
}> {
  if (await remindersDisabled("country-review")) return { notified: 0, blacklisted: 0 };

  // Semi-annual, so it must survive restarts: the in-process throttle resets on
  // every republish, which fired this three times in thirty minutes.
  // 150 days ≈ one gap in the Feb/Oct cadence, so a genuine cycle still lands.
  if (await announcedWithinDays("fraud_country_risk", "review", 150)) {
    logger.info(
      "[FraudCountryReview] Already announced within 150 days — skipping",
    );
    return { notified: 0, blacklisted: 0 };
  }

  const { initFraudTables, getBlackListedCountryCount } = await import(
    "./fraudDatabase"
  );
  await initFraudTables();
  const blacklisted = await getBlackListedCountryCount();
  const recipient =
    process.env.FRAUD_COUNTRY_NOTIFY_EMAIL || "head.grq@walaplus.com";

  const message = `FATF publishes updates 3x/year. Refresh country-risk ratings against the latest plenary outcomes. Currently ${blacklisted} country/countries are on the FATF black-list.`;
  const ok = await record({
    title: "Country Risk Register — semi-annual review due",
    message,
    priority: "medium",
    recipient,
    relatedEntityType: "fraud_country_risk",
    relatedEntityId: "review",
    actionUrl: "/fraud-country-risk",
  });

  await announce({
    type: "fraud_country_review_due",
    title: "Country Risk Register — semi-annual review due",
    message,
    priority: "high",
    actionUrl: "/fraud-country-risk",
    entityType: "fraud_country_risk",
    entityId: "review",
  });

  return { notified: ok ? 1 : 0, blacklisted };
}

/** Auto-calculate last month's fraud KPIs and prompt for the manual fields. */
export async function runFraudKpiMonthlyReminder(): Promise<{
  month: string;
  kpi_id: any;
}> {
  if (await remindersDisabled("kpi-monthly")) return { month: "", kpi_id: null };

  const { initFraudTables, autoCalculateKpisForMonth, upsertFraudKpi } =
    await import("./fraudDatabase");
  await initFraudTables();

  const today = new Date();
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01`;

  // Monthly, and keyed by the month itself — so a restart inside the same month
  // cannot re-announce it. Same restart-resets-the-throttle problem as the
  // country review above.
  if (await announcedWithinDays("fraud_kpi", prevMonth, 20)) {
    logger.info(
      `[FraudKpiMonthly] ${prevMonth} already announced — skipping`,
    );
    return { month: prevMonth, kpi_id: null };
  }

  let result: any = null;
  try {
    const calc = await autoCalculateKpisForMonth(prevMonth);
    result = await upsertFraudKpi(prevMonth, calc, "system:monthly-cron");
  } catch (err) {
    logger.error(`[FraudKpiMonthly] auto-calc failed for ${prevMonth}:`, err);
  }

  const recipient =
    process.env.FRAUD_KPI_NOTIFY_EMAIL || "head.grq@walaplus.com";
  const message =
    "Previous-month KPIs auto-calculated from incidents data. Please fill in total_transactions, total_rejections, and customer_complaints in the dashboard.";

  await record({
    title: `Fraud KPI snapshot ready: ${prevMonth.slice(0, 7)}`,
    message,
    priority: "medium",
    recipient,
    relatedEntityType: "fraud_kpi",
    relatedEntityId: prevMonth,
    actionUrl: "/fraud-dashboard",
  });

  await announce({
    type: "fraud_kpi_month_ready",
    title: `Fraud KPI snapshot ready: ${prevMonth.slice(0, 7)}`,
    message,
    priority: "high",
    actionUrl: "/fraud-dashboard",
    entityType: "fraud_kpi",
    entityId: prevMonth,
  });

  logger.info(`[FraudKpiMonthly] processed ${prevMonth}`);
  return { month: prevMonth, kpi_id: result?.id ?? null };
}

/* ── EMAIL-DELIVERED: incident-specific, addressed ───────────────────────── */

/**
 * P1 incidents approaching the SAMA 72-hour reporting deadline. Hourly.
 *
 * Email rather than Slack: this names specific open incidents, and the AML
 * no-tipping-off posture that governs escalation dispatch applies here too.
 */
export async function runFraudSamaDeadlineCheck(): Promise<{
  notified: number;
  candidates: number;
  delivered: number;
}> {
  const { getSamaDeadlineApproaching, initFraudTables } = await import(
    "./fraudDatabase"
  );
  await initFraudTables();
  const candidates = await getSamaDeadlineApproaching(60);
  if (candidates.length === 0)
    return { notified: 0, candidates: 0, delivered: 0 };

  if (!emailConfigured()) {
    logger.error(
      `[FraudSamaDeadline] RESEND_API_KEY is NOT set — ${candidates.length} P1 incident(s) are approaching the SAMA 72h deadline and NO ONE CAN BE TOLD. In-app records written only.`,
    );
  }

  const recipients = envRecipients(
    "FRAUD_SAMA_NOTIFY_EMAILS",
    "head.grq@walaplus.com,admin@walaplus.com",
  );
  let notified = 0;
  let delivered = 0;
  for (const inc of candidates) {
    const title = `URGENT — SAMA 72h deadline approaching: ${inc.incident_code}`;
    const message = `P1 incident ${inc.incident_code} detected ${String(inc.date_detected).slice(0, 10)} is not yet SAMA-reported. Take action within 12 hours.`;
    for (const recipient of recipients) {
      const ok = await record({
        title,
        message,
        priority: "critical",
        recipient,
        relatedEntityType: "fraud_incident",
        relatedEntityId: String(inc.id),
        actionUrl: "/fraud-incidents",
      });
      if (ok) notified++;
      const sent = await emailRecipient(recipient, {
        title,
        message,
        priority: "critical",
        relatedEntityId: String(inc.id),
        actionUrl: "/fraud-incidents",
      });
      if (sent) delivered++;
    }
  }
  logger.info(
    `[FraudSamaDeadline] ${candidates.length} approaching; ${notified} recorded; ${delivered} emailed`,
  );
  return { notified, candidates: candidates.length, delivered };
}

/** Open incidents past their severity-based containment SLA. Hourly. */
export async function runFraudIncidentSlaCheck(): Promise<{
  notified: number;
  breaches: number;
  open: number;
  delivered: number;
}> {
  const { getOpenFraudIncidents, initFraudTables } = await import(
    "./fraudDatabase"
  );
  await initFraudTables();
  const open = await getOpenFraudIncidents();

  // Matches the escalation-matrix Excel until Feature 4 makes it canonical.
  const SLA_HOURS: Record<string, number> = { P1: 4, P2: 24, P3: 72, P4: 168 };
  const now = Date.now();
  const breaches = open.filter((inc: any) => {
    if (inc.contained_at) return false;
    const detected = new Date(inc.created_at ?? inc.date_detected).getTime();
    const sla = SLA_HOURS[inc.severity] ?? 168;
    return now - detected > sla * 3600 * 1000;
  });

  if (breaches.length === 0)
    return { notified: 0, breaches: 0, open: open.length, delivered: 0 };

  if (!emailConfigured()) {
    logger.error(
      `[FraudSlaCheck] RESEND_API_KEY is NOT set — ${breaches.length} incident(s) are past their containment SLA and NO ONE CAN BE TOLD. In-app records written only.`,
    );
  }

  const recipient =
    process.env.FRAUD_SLA_NOTIFY_EMAIL || "head.grq@walaplus.com";
  let notified = 0;
  let delivered = 0;
  for (const inc of breaches as any[]) {
    const title = `SLA breach — ${inc.severity} incident ${inc.incident_code}`;
    const message = `Incident ${inc.incident_code} (${inc.severity}) is open past its containment SLA. Status: ${inc.status}.`;
    const priority = inc.severity === "P1" ? "critical" : "high";
    const ok = await record({
      title,
      message,
      priority,
      recipient,
      relatedEntityType: "fraud_incident",
      relatedEntityId: String(inc.id),
      actionUrl: "/fraud-incidents",
    });
    if (ok) notified++;
    const sent = await emailRecipient(recipient, {
      title,
      message,
      priority,
      relatedEntityId: String(inc.id),
      actionUrl: "/fraud-incidents",
    });
    if (sent) delivered++;
  }
  logger.info(
    `[FraudSlaCheck] ${breaches.length} breaches; ${notified} recorded; ${delivered} emailed`,
  );
  return { notified, breaches: breaches.length, open: open.length, delivered };
}
