/**
 * Daily overdue reminders for the Handoff Tracker and Tech Requests.
 *
 * Deliberately NOT a new cron workflow: registering extra workflows has crashed
 * this app at boot before. Instead this hangs off the existing 45-minute
 * housekeeping loop and self-gates, which is the same pattern the other
 * `run*IfStale/IfDue` helpers use.
 *
 * Anti-spam gate is per ROW (`last_reminder_at`), not global: a row is only
 * reminded again after ~20h. That survives restarts and means adding a new
 * overdue item never re-nags everything else.
 */
import { pool } from "./kpiDatabase";
import { logger } from "./logger";

const APP_URL = process.env.APP_BASE_URL || "https://qms-dashboard.replit.app";
const REMIND_EVERY_HOURS = 20;

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function mail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    if (!to) return false;
    const { sendResendEmail } = await import("./resendMail");
    const r = await sendResendEmail({
      to,
      subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">${html}</div>`,
    });
    return Boolean(r?.success);
  } catch (e) {
    logger.error(`[OverdueReminders] send failed: ${(e as Error).message}`);
    return false;
  }
}

const days = (d: any) =>
  Math.max(
    0,
    Math.round(
      (Date.now() - new Date(String(d).slice(0, 10)).getTime()) / 86400000,
    ),
  );

/**
 * Send one reminder per overdue item. Returns how many were sent.
 * Each row is stamped BEFORE/AFTER sending so a mail failure doesn't cause an
 * endless retry loop every 45 minutes.
 */
export async function sendOverdueReminders(): Promise<{ sent: number }> {
  let sent = 0;

  // ---- Handoff tasks (internal: remind assignee, copy the sender) ----
  try {
    const res = await pool.query(
      `SELECT * FROM handoff_tasks
        WHERE status IN ('sent','accepted')
          AND due_date IS NOT NULL AND due_date < CURRENT_DATE
          AND (last_reminder_at IS NULL
               OR last_reminder_at < NOW() - INTERVAL '${REMIND_EVERY_HOURS} hours')
        ORDER BY due_date ASC LIMIT 50`,
    );
    for (const t of res.rows) {
      const n = days(t.due_date);
      const body =
        `<p>This Quality &harr; GRC handoff is <strong>${n} day${n === 1 ? "" : "s"} overdue</strong>.</p>` +
        `<p><strong>${esc(t.title)}</strong></p>` +
        (t.description ? `<p>${esc(t.description)}</p>` : "") +
        `<p>Due: <strong>${esc(String(t.due_date).slice(0, 10))}</strong> &middot; Status: ${esc(t.status)}</p>` +
        `<p><a href="${APP_URL}/handoff-tracker" style="background:#4f46e5;color:#fff;` +
        `padding:8px 14px;border-radius:6px;text-decoration:none">Open the Handoff Tracker</a></p>`;
      await mail(t.assigned_to, `Overdue handoff (${n}d): ${t.title}`, body);
      // Copy the sender so nothing rots unnoticed on their side either.
      if (t.created_by && t.created_by !== t.assigned_to) {
        await mail(
          t.created_by,
          `Still open (${n}d overdue): ${t.title}`,
          body + `<p style="color:#64748b;font-size:12px">You raised this handoff.</p>`,
        );
      }
      await pool.query(
        `UPDATE handoff_tasks SET last_reminder_at = NOW() WHERE id = $1`,
        [t.id],
      );
      sent++;
    }
  } catch (e) {
    logger.error(`[OverdueReminders] handoff pass failed: ${(e as Error).message}`);
  }

  // ---- Tech requests (external assignee: include their one-click link) ----
  try {
    const res = await pool.query(
      `SELECT * FROM tech_requests
        WHERE status <> 'done'
          AND due_date IS NOT NULL AND due_date < CURRENT_DATE
          AND (last_reminder_at IS NULL
               OR last_reminder_at < NOW() - INTERVAL '${REMIND_EVERY_HOURS} hours')
        ORDER BY due_date ASC LIMIT 50`,
    );
    for (const r of res.rows) {
      const n = days(r.due_date);
      await mail(
        r.assignee_email,
        `Reminder (${n}d overdue): ${String(r.request_text).slice(0, 60)}`,
        `<p>A reminder that this request is <strong>${n} day${n === 1 ? "" : "s"} past the date it was needed</strong>.</p>` +
          (r.product ? `<p><strong>Product:</strong> ${esc(r.product)}</p>` : "") +
          (r.client_name ? `<p><strong>Client:</strong> ${esc(r.client_name)}</p>` : "") +
          `<div style="background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(r.request_text)}</div>` +
          `<p style="margin-top:14px"><a href="${APP_URL}/r/${esc(r.action_token)}" ` +
          `style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;` +
          `text-decoration:none">Respond to this request</a></p>`,
      );
      await pool.query(
        `UPDATE tech_requests SET last_reminder_at = NOW() WHERE id = $1`,
        [r.id],
      );
      sent++;
    }
  } catch (e) {
    logger.error(`[OverdueReminders] tech-request pass failed: ${(e as Error).message}`);
  }

  if (sent > 0) logger.info(`📧 [OverdueReminders] sent ${sent} reminder(s)`);
  return { sent };
}

/**
 * Housekeeping-loop entry point. Only fires in the 07:00–09:59 KSA window so
 * reminders land at the start of the working day rather than overnight; the
 * per-row 20h gate stops the 45-minute loop re-sending within that window.
 */
export async function runOverdueRemindersIfDue(): Promise<{
  ran: boolean;
  ageHours: number;
}> {
  const ksaHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Riyadh",
      hour: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  if (ksaHour < 7 || ksaHour > 9) return { ran: false, ageHours: 0 };
  const { sent } = await sendOverdueReminders();
  return { ran: sent > 0, ageHours: 24 };
}
