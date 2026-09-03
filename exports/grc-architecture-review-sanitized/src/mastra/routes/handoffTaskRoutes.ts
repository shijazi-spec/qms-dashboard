/**
 * Quality ↔ GRC Handoff Tracker routes.
 *
 * Access is deliberately narrow (Quality + GRC managers, plus admin) so the
 * GRQ-KPI-02 measurement can never be polluted by unrelated work — see
 * docs/superpowers/specs/2026-07-20-handoff-tracker-design.md.
 *
 * Every state change fires a best-effort email; a mail failure is logged but
 * NEVER fails the write, so the task record is always the source of truth.
 */
import { join } from "path";
import { readFileSync } from "fs";
import { logger as safeLogger } from "../../utils/logger";
import {
  initHandoffTaskTables,
  listTasksForUser,
  createTask,
  getTask,
  transitionTask,
} from "../../utils/handoffTasksDatabase";

initHandoffTaskTables().catch((err) =>
  safeLogger.error("[HandoffTasks] table init failed", err),
);

const HANDOFF_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
] as const;

const APP_URL = process.env.APP_BASE_URL || "<REDACTED_URL_SCHEME><REDACTED_HOST>";

function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Best-effort notification — never throws into the request path. */
async function notify(to: string, subject: string, bodyHtml: string): Promise<void> {
  try {
    if (!to) return;
    const { sendEmailProviderEmail } = await import("../../utils/EmailProviderMail");
    await sendEmailProviderEmail({
      to,
      subject,
      html:
        `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">` +
        bodyHtml +
        `<p style="margin-top:16px"><a href="${APP_URL}/handoff-tracker" ` +
        `style="background:#4f46e5;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">` +
        `Open the Handoff Tracker</a></p></div>`,
    });
  } catch (e) {
    safeLogger.error("[HandoffTasks] email failed (task still saved):", e);
  }
}

function taskHtml(t: any, lead: string): string {
  return (
    `<p>${esc(lead)}</p>` +
    `<p><strong>${esc(t.title)}</strong></p>` +
    (t.description ? `<p>${esc(t.description)}</p>` : "") +
    (t.due_date ? `<p>Due: <strong>${esc(String(t.due_date).slice(0, 10))}</strong></p>` : "")
  );
}

export const handoffTaskRoutes = [
  {
    path: "/handoff-tracker",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const paths = [
            join(process.cwd(), "dashboard", "handoff-tracker.html"),
            "/home/runner/workspace/dashboard/handoff-tracker.html",
          ];
          for (const p of paths) {
            try {
              return c.html(readFileSync(p, "utf-8"));
            } catch {}
          }
          return c.text("Handoff Tracker page not found", 404);
        } catch (error) {
          safeLogger.error("Error serving handoff tracker:", error);
          return c.text("Failed to load page", 500);
        }
      };
    },
  },
  {
    path: "/api/handoff-tasks",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...HANDOFF_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const me = user?.email || "";
          const tasks = await listTasksForUser(me);
          return c.json({ me, tasks });
        } catch (error) {
          safeLogger.error("Error listing handoff tasks:", error);
          return c.json({ error: "Failed to list tasks" }, 500);
        }
      };
    },
  },
  {
    path: "/api/handoff-tasks",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...HANDOFF_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const body = await c.req.json();
          const title = (body?.title || "").trim();
          const assigned_to = (body?.assigned_to || "").trim();
          if (!title) return c.json({ error: "title is required" }, 400);
          if (!assigned_to) return c.json({ error: "assigned_to is required" }, 400);
          const task = await createTask({
            title,
            description: body?.description,
            created_by: user?.email || "system",
            assigned_to,
            due_date: body?.due_date || null,
          });
          await notify(
            assigned_to,
            `New handoff assigned to you: ${title}`,
            taskHtml(task, `${user?.email || "A colleague"} assigned you a Quality ↔ GRC handoff.`),
          );
          return c.json({ success: true, task });
        } catch (error) {
          safeLogger.error("Error creating handoff task:", error);
          return c.json({ error: "Failed to create task" }, 500);
        }
      };
    },
  },
  {
    // accept | reject | done | EmailProvider
    path: "/api/handoff-tasks/:id{[0-9]+}/:action{(accept|reject|done|EmailProvider)}",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...HANDOFF_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const id = parseInt(c.req.param("id"));
          const action = c.req.param("action") as
            | "accept"
            | "reject"
            | "done"
            | "EmailProvider";
          const body = await c.req.json().catch(() => ({}));
          const before = await getTask(id);
          if (!before) return c.json({ error: "Task not found" }, 404);

          const task = await transitionTask(id, action, { reason: body?.reason });
          if (!task)
            return c.json(
              { error: `Cannot ${action} a task that is '${before.status}'` },
              409,
            );

          // Route the email to whoever needs to know next.
          if (action === "reject") {
            await notify(
              task.created_by,
              `Handoff returned: ${task.title}`,
              taskHtml(
                task,
                `${user?.email || "The assignee"} returned this handoff for rework.` +
                  (body?.reason ? ` Reason: ${esc(body.reason)}` : ""),
              ),
            );
          } else if (action === "done") {
            await notify(
              task.created_by,
              `Handoff completed: ${task.title}`,
              taskHtml(task, `${user?.email || "The assignee"} marked this handoff complete.`),
            );
          } else if (action === "EmailProvider") {
            await notify(
              task.assigned_to,
              `Handoff re-sent to you: ${task.title}`,
              taskHtml(task, `This handoff was updated and sent back to you.`),
            );
          }
          return c.json({ success: true, task });
        } catch (error) {
          safeLogger.error("Error updating handoff task:", error);
          return c.json({ error: "Failed to update task" }, 500);
        }
      };
    },
  },
];
