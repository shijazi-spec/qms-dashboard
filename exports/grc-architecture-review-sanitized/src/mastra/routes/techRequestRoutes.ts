/**
 * Tech Requests Tracker routes.
 *
 * Internal board = RBAC-gated. The assignee's response path is PUBLIC but gated
 * by a 256-bit token, because assignees are usually outside the org and have no
 * platform login.
 *
 * SAFETY: the emailed link is a GET that only RENDERS a confirmation page — it
 * never mutates. The actual status change is a POST from that page. Corporate
 * mail scanners and link-prefetchers follow links automatically, so a mutating
 * GET would silently mark requests accepted/done without a human ever clicking.
 */
import { join } from "path";
import { readFileSync } from "fs";
import { logger as safeLogger } from "../../utils/logger";
import {
  initTechRequestTables,
  listRequests,
  createRequest,
  getByToken,
  recordResponse,
  setStatus,
} from "../../utils/techRequestsDatabase";

initTechRequestTables().catch((err) =>
  safeLogger.error("[TechRequests] table init failed", err),
);

const TR_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "quality_specialist",
] as const;

const APP_URL = process.env.APP_BASE_URL || "<REDACTED_URL_SCHEME><REDACTED_HOST>";

function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#0f172a}
.card{max-width:620px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h1{font-size:19px;margin:0 0 12px} .meta{color:#475569;font-size:14px;margin:6px 0}
.req{background:#f1f5f9;border-radius:8px;padding:12px;margin:14px 0;white-space:pre-wrap}
button{border:0;border-radius:8px;padding:10px 16px;font-size:14px;cursor:pointer;margin-inline-end:8px}
.p{background:#4f46e5;color:#fff}.s{background:#059669;color:#fff}.w{background:#fff;color:#b91c1c;border:1px solid #fecaca}
textarea{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font:inherit;margin-top:8px}
.ok{color:#047857;font-size:15px}</style></head><body><div class="card">${body}</div></body></html>`;
}

export const techRequestRoutes = [
  {
    path: "/tech-requests",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const paths = [
          join(process.cwd(), "dashboard", "tech-requests.html"),
          "/home/runner/workspace/dashboard/tech-requests.html",
        ];
        for (const p of paths) {
          try {
            return c.html(readFileSync(p, "utf-8"));
          } catch {}
        }
        return c.text("Tech Requests page not found", 404);
      };
    },
  },
  {
    path: "/api/tech-requests",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...TR_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const requests = await listRequests();
          // Never leak the action tokens to the board — they are bearer secrets.
          return c.json({
            requests: requests.map(({ action_token, ...safe }) => safe),
          });
        } catch (error) {
          safeLogger.error("Error listing tech requests:", error);
          return c.json({ error: "Failed to list requests" }, 500);
        }
      };
    },
  },
  {
    path: "/api/tech-requests",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...TR_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const b = await c.req.json();
          const request_text = (b?.request_text || "").trim();
          const assignee_email = (b?.assignee_email || "").trim();
          if (!request_text) return c.json({ error: "request_text is required" }, 400);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(assignee_email))
            return c.json({ error: "A valid assignee email is required" }, 400);

          const req = await createRequest({
            product: b?.product,
            client_name: b?.client_name,
            contact_email: b?.contact_email,
            request_text,
            assignee_name: b?.assignee_name,
            assignee_email,
            due_date: b?.due_date || null,
            created_by: user?.email || "system",
          });

          // Send the FULL request so the assignee can act without opening anything.
          try {
            const { sendEmailProviderEmail } = await import("../../utils/EmailProviderMail");
            const link = `${APP_URL}/r/${req.action_token}`;
            await sendEmailProviderEmail({
              to: assignee_email,
              subject: `Request${req.client_name ? ` — ${req.client_name}` : ""}: ${request_text.slice(0, 60)}`,
              html:
                `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a">` +
                `<p>You have a new request from the ExampleOrg GRQ team.</p>` +
                (req.product ? `<p><strong>Product:</strong> ${esc(req.product)}</p>` : "") +
                (req.client_name ? `<p><strong>Client:</strong> ${esc(req.client_name)}</p>` : "") +
                `<p><strong>Request:</strong></p>` +
                `<div style="background:#f1f5f9;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(request_text)}</div>` +
                (req.due_date ? `<p><strong>Needed by:</strong> ${esc(String(req.due_date).slice(0, 10))}</p>` : "") +
                `<p style="margin-top:18px">Please respond with one click — no login needed:</p>` +
                `<p><a href="${link}" style="background:#4f46e5;color:#fff;padding:10px 18px;` +
                `border-radius:8px;text-decoration:none">Respond to this request</a></p>` +
                `<p style="color:#64748b;font-size:12px">Your response updates the GRQ team's tracker automatically.</p>` +
                `</div>`,
            });
          } catch (e) {
            safeLogger.error("[TechRequests] email failed (request still saved):", e);
          }
          const { action_token, ...safe } = req as any;
          return c.json({ success: true, request: safe });
        } catch (error) {
          safeLogger.error("Error creating tech request:", error);
          return c.json({ error: "Failed to create request" }, 500);
        }
      };
    },
  },
  {
    // Internal status change from the board.
    path: "/api/tech-requests/:id{[0-9]+}/status",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireRole(c, [...TR_ROLES]);
          if (!user) return forbiddenResponse(c, "Insufficient permissions");
          const id = parseInt(c.req.param("id"));
          const b = await c.req.json().catch(() => ({}));
          const allowed = ["sent", "accepted", "info_needed", "done"];
          if (!allowed.includes(b?.status))
            return c.json({ error: "Invalid status" }, 400);
          const req = await setStatus(id, b.status, b?.note);
          if (!req) return c.json({ error: "Request not found" }, 404);
          const { action_token, ...safe } = req as any;
          return c.json({ success: true, request: safe });
        } catch (error) {
          safeLogger.error("Error updating tech request:", error);
          return c.json({ error: "Failed to update request" }, 500);
        }
      };
    },
  },
  {
    // PUBLIC (token-gated) — renders only; never mutates. See file header.
    path: "/r/:token",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const token = c.req.param("token");
          const req = await getByToken(token);
          if (!req) return c.html(page("Not found", `<h1>This link is not valid.</h1>
            <p class="meta">It may have been mistyped or the request was removed.</p>`), 404);
          const done = req.status === "done";
          return c.html(
            page(
              "Respond to request",
              `<h1>Request from the ExampleOrg GRQ team</h1>` +
                (req.product ? `<div class="meta"><strong>Product:</strong> ${esc(req.product)}</div>` : "") +
                (req.client_name ? `<div class="meta"><strong>Client:</strong> ${esc(req.client_name)}</div>` : "") +
                (req.due_date ? `<div class="meta"><strong>Needed by:</strong> ${esc(String(req.due_date).slice(0, 10))}</div>` : "") +
                `<div class="req">${esc(req.request_text)}</div>` +
                `<div class="meta">Current status: <strong>${esc(req.status)}</strong></div>` +
                (done
                  ? `<p class="ok">This request is already marked complete. Thank you.</p>`
                  : `<form method="POST" action="/api/tech-requests/respond/${esc(token)}">
                       <textarea name="note" rows="3" placeholder="Add a note (optional)"></textarea>
                       <p style="margin-top:14px">
                         <button class="p" name="action" value="accept" type="submit">Accept &amp; working on it</button>
                         <button class="s" name="action" value="done" type="submit">Completed</button>
                         <button class="w" name="action" value="info" type="submit">Need more info</button>
                       </p>
                     </form>`),
            ),
          );
        } catch (error) {
          safeLogger.error("Error rendering response page:", error);
          return c.text("Failed to load", 500);
        }
      };
    },
  },
  {
    // PUBLIC (token-gated) — the actual mutation, POST only.
    path: "/api/tech-requests/respond/:token",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const token = c.req.param("token");
          let action = "";
          let note = "";
          // The confirmation page posts a normal HTML form.
          try {
            const form = await c.req.parseBody();
            action = String(form?.action || "");
            note = String(form?.note || "");
          } catch {
            const b = await c.req.json().catch(() => ({}));
            action = String(b?.action || "");
            note = String(b?.note || "");
          }
          if (!["accept", "done", "info"].includes(action))
            return c.html(page("Invalid", `<h1>That action isn't recognised.</h1>`), 400);
          const req = await recordResponse(token, action as any, note);
          if (!req)
            return c.html(page("Not found", `<h1>This link is not valid.</h1>`), 404);
          const msg =
            action === "done"
              ? "Thank you — marked as completed."
              : action === "accept"
                ? "Thank you — marked as accepted."
                : "Thank you — we'll send more information.";
          return c.html(
            page("Response recorded", `<h1>Response recorded</h1><p class="ok">${esc(msg)}</p>
              <p class="meta">The GRQ team's tracker has been updated. You can close this page.</p>`),
          );
        } catch (error) {
          safeLogger.error("Error recording response:", error);
          return c.text("Failed to record response", 500);
        }
      };
    },
  },
];
