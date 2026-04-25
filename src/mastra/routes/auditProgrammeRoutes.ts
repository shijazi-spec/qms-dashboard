/**
 * Audit Programme API routes.
 *
 * An "Audit Programme" is the annual plan of internal audits (ISO 19011:2018
 * §5.2). Quality Manager drafts it; Head of Operations & Quality signs it off
 * through the HITL gate (same ai_pending_actions queue already used for
 * high-risk AI actions).
 *
 * Endpoints:
 *
 *   GET    /api/audit-programme                   list (filter by year/status)
 *   GET    /api/audit-programme/:id               detail + sign-off history
 *   POST   /api/audit-programme                   create draft (QM, admin, HoOQ)
 *   PUT    /api/audit-programme/:id               edit (only while draft/revised)
 *   POST   /api/audit-programme/:id/submit        QM submits -> enqueues HITL
 *   POST   /api/audit-programme/:id/approve       HoOQ approves via HITL ticket
 *   POST   /api/audit-programme/:id/reject        HoOQ rejects with reason
 *
 * Compliance references: WP-SOP-040 (Programme Governance), WP-FORM-055
 * (Programme Plan), WP-CTL-007 (Sign-off Control), ISO 19011:2018 §5.2,
 * ISO 9001:2015 §9.2.2.
 *
 * Lifecycle:
 *
 *   draft ──(submit)──► pending_signoff ──(approve)──► approved ──► in_execution
 *                                      └─(reject)───► draft (with reason log)
 */

import {
  initAuditProgrammeTables,
  createProgramme,
  listProgrammes,
  getProgrammeById,
  updateProgramme,
  recordProgrammeSignoff,
  getProgrammeHistory,
  type ProgrammeStatus,
} from "../../utils/auditProgrammeDatabase";
import {
  enqueuePendingAction,
  getPendingActionByCode,
  claimForApproval,
  rejectAction as rejectHitl,
  recordExecutionResult,
} from "../../utils/aiApprovalDatabase";
import {
  getSessionUser,
  unauthorizedResponse,
  forbiddenResponse,
} from "../../utils/rbacMiddleware";
import { logEvent } from "../../utils/eventLogsDatabase";

import { logger } from "../../utils/logger";
/* ------------------------------------------------------------------------- *
 * Bootstrap (lazy — fires first time the table is touched)
 * ------------------------------------------------------------------------- */
let ready = false;
async function ensure() {
  if (ready) return;
  await initAuditProgrammeTables();
  ready = true;
}

/* ------------------------------------------------------------------------- *
 * Role helpers
 * ------------------------------------------------------------------------- */
const EDITOR_ROLES = new Set([
  "admin",
  "head_of_operations_quality",
  "quality_manager",
]);
const APPROVER_ROLES = new Set(["admin", "head_of_operations_quality"]);

function canEdit(role: string | null | undefined): boolean {
  return !!role && EDITOR_ROLES.has(role);
}
function canApprove(role: string | null | undefined): boolean {
  return !!role && APPROVER_ROLES.has(role);
}

function buildPayloadPreview(p: any): string {
  const lines: string[] = [];
  lines.push(`Audit Programme: ${p.title} (${p.programme_code})`);
  lines.push(`Year: ${p.programme_year}`);
  if (p.scope_summary)
    lines.push(`Scope: ${String(p.scope_summary).slice(0, 180)}`);
  const n = Array.isArray(p.planned_audits) ? p.planned_audits.length : 0;
  lines.push(`Planned audits: ${n}`);
  if (p.risk_based_rationale) {
    lines.push(`Rationale: ${String(p.risk_based_rationale).slice(0, 180)}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * Route definitions
 * ------------------------------------------------------------------------- */
export const auditProgrammeRoutes = [
  /* ---------------- GET /api/audit-programme ---------------------------- */
  {
    path: "/api/audit-programme",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        const year = url.searchParams.get("year");
        const status = url.searchParams.get("status") as ProgrammeStatus | null;
        const rows = await listProgrammes({
          year: year ? parseInt(year, 10) : undefined,
          status: status || undefined,
        });
        return c.json({ success: true, rows });
      } catch (err: any) {
        logger.error("[AuditProgramme] list error", err);
        return c.json(
          { error: "Failed to list programmes", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- GET /api/audit-programme/:id ------------------------ */
  {
    path: "/api/audit-programme/:id",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const id = parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
        const programme = await getProgrammeById(id);
        if (!programme) return c.json({ error: "Not found" }, 404);
        const history = await getProgrammeHistory(id);
        return c.json({
          success: true,
          programme,
          history,
          can_edit:
            canEdit(user.role) &&
            (programme.status === "draft" || programme.status === "cancelled"),
          can_submit: canEdit(user.role) && programme.status === "draft",
          can_approve:
            canApprove(user.role) && programme.status === "pending_signoff",
        });
      } catch (err: any) {
        logger.error("[AuditProgramme] detail error", err);
        return c.json(
          { error: "Failed to fetch programme", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- POST /api/audit-programme --------------------------- */
  {
    path: "/api/audit-programme",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canEdit(user.role)) {
          return forbiddenResponse(
            c,
            "Only Quality Manager or Head of Operations & Quality can draft audit programmes.",
          );
        }
        const body = await c.req.json().catch(() => ({}));
        if (!body?.title || !body?.programme_year) {
          return c.json(
            { error: "title and programme_year are required" },
            400,
          );
        }
        const programme = await createProgramme({
          title: body.title,
          programme_year: parseInt(body.programme_year, 10),
          scope_summary: body.scope_summary ?? null,
          objectives: body.objectives ?? null,
          risk_based_rationale: body.risk_based_rationale ?? null,
          planned_audits: Array.isArray(body.planned_audits)
            ? body.planned_audits
            : [],
          prepared_by_email: user.email,
          prepared_by_name: user.name,
        });
        await logEvent({
          userId: user.userId,
          userEmail: user.email,
          userRole: user.role,
          actionType: "CREATE",
          entityType: "audit_programme",
          entityId: String(programme.id),
          entityName: programme.programme_code,
          description: `Drafted audit programme ${programme.programme_code} (${programme.title})`,
          module: "audits",
          severity: "INFO",
        }).catch(() => {
          /* non-fatal */
        });
        return c.json({ success: true, programme }, 201);
      } catch (err: any) {
        logger.error("[AuditProgramme] create error", err);
        return c.json(
          { error: "Failed to create programme", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- PUT /api/audit-programme/:id ------------------------ */
  {
    path: "/api/audit-programme/:id",
    method: "PUT" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canEdit(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
        const existing = await getProgrammeById(id);
        if (!existing) return c.json({ error: "Not found" }, 404);
        if (existing.status !== "draft") {
          return c.json(
            {
              error: `Cannot edit a programme in status "${existing.status}". Reject the sign-off first to return it to draft.`,
            },
            409,
          );
        }
        const body = await c.req.json().catch(() => ({}));
        const updated = await updateProgramme(id, {
          title: body.title,
          scope_summary: body.scope_summary,
          objectives: body.objectives,
          risk_based_rationale: body.risk_based_rationale,
          planned_audits: Array.isArray(body.planned_audits)
            ? body.planned_audits
            : undefined,
        });
        return c.json({ success: true, programme: updated });
      } catch (err: any) {
        logger.error("[AuditProgramme] update error", err);
        return c.json(
          { error: "Failed to update programme", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- POST /api/audit-programme/:id/submit ---------------- *
   * Quality Manager submits the draft. This enqueues a HITL action so the
   * Head of Operations & Quality can approve in the same /ai-approvals UI
   * they already use. We DO NOT change `approved_at` or `approved_by_email`
   * until the HITL claim succeeds.
   * ------------------------------------------------------------------- */
  {
    path: "/api/audit-programme/:id/submit",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canEdit(user.role)) return forbiddenResponse(c);

        const id = parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
        const programme = await getProgrammeById(id);
        if (!programme) return c.json({ error: "Not found" }, 404);
        if (programme.status !== "draft") {
          return c.json(
            { error: `Cannot submit from status "${programme.status}"` },
            409,
          );
        }
        const planned = Array.isArray(programme.planned_audits)
          ? programme.planned_audits.length
          : 0;
        if (planned === 0) {
          return c.json(
            {
              error:
                "Programme has no planned audits. Add at least one before submitting for sign-off.",
            },
            400,
          );
        }

        // Enqueue HITL ticket — risk_level=high because this is a formal
        // management approval gating the whole audit programme.
        const ticket = await enqueuePendingAction({
          toolId: "audit_programme_signoff",
          toolLabel: `Audit Programme Sign-off — ${programme.programme_code}`,
          payload: {
            programme_id: programme.id,
            programme_code: programme.programme_code,
          },
          payloadPreview: buildPayloadPreview(programme),
          riskLevel: "high",
          complianceRefs: [
            "WP-SOP-040 (Audit Programme Governance)",
            "WP-FORM-055 (Audit Programme Plan)",
            "WP-CTL-007 (Programme Sign-off Control)",
            "ISO 19011:2018 §5.2",
            "ISO 9001:2015 §9.2.2",
          ],
          requestedByUserId: user.userId,
          requestedByEmail: user.email,
          requestedByName: user.name,
          threadId: `programme-${programme.id}`,
          ttlHours: 168, // 7 days — a programme is not an urgent AI action
        });

        await updateProgramme(id, {
          status: "pending_signoff",
          approval_action_code: ticket.action_code,
        });
        await recordProgrammeSignoff({
          programme_id: id,
          action: "submitted",
          action_code: ticket.action_code,
          actor_email: user.email,
          actor_role: user.role,
          notes: `Submitted for sign-off; HITL ticket ${ticket.action_code}`,
          snapshot: programme,
        });

        await logEvent({
          userId: user.userId,
          userEmail: user.email,
          userRole: user.role,
          actionType: "AI_ACTION",
          entityType: "audit_programme",
          entityId: String(programme.id),
          entityName: programme.programme_code,
          description: `Submitted programme ${programme.programme_code} for sign-off`,
          module: "audits",
          severity: "INFO",
          aiInvolved: false,
          correlationId: ticket.action_code,
        }).catch(() => {
          /* non-fatal */
        });

        return c.json({ success: true, action_code: ticket.action_code });
      } catch (err: any) {
        logger.error("[AuditProgramme] submit error", err);
        return c.json(
          { error: "Failed to submit programme", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- POST /api/audit-programme/:id/approve --------------- *
   * Head of Operations & Quality (or admin) approves. We claim the HITL
   * ticket atomically (pending -> approved), then mark the programme as
   * `approved`. Segregation of duties: the approver may not be the same
   * person who drafted the programme.
   * ------------------------------------------------------------------- */
  {
    path: "/api/audit-programme/:id/approve",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canApprove(user.role)) {
          return forbiddenResponse(
            c,
            "Only Head of Operations & Quality (or admin) can approve.",
          );
        }
        const id = parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
        const programme = await getProgrammeById(id);
        if (!programme) return c.json({ error: "Not found" }, 404);
        if (programme.status !== "pending_signoff") {
          return c.json(
            { error: `Cannot approve from status "${programme.status}"` },
            409,
          );
        }
        if (!programme.approval_action_code) {
          // Legacy safety: find the last submitted ticket from history.
          const hist = await getProgrammeHistory(id);
          const sub = hist
            .reverse()
            .find((h: any) => h.action === "submitted" && h.action_code);
          if (!sub?.action_code) {
            return c.json(
              {
                error: "No HITL ticket found; please re-submit the programme.",
              },
              409,
            );
          }
          programme.approval_action_code = sub.action_code;
        }

        // Segregation of duties — prevent self-approval unless admin break-glass.
        if (
          user.role !== "admin" &&
          programme.prepared_by_email &&
          programme.prepared_by_email === user.email
        ) {
          return forbiddenResponse(
            c,
            "Segregation of duties: you cannot approve a programme you drafted. See WP-DOC-005.",
          );
        }

        const ticketCode = programme.approval_action_code;
        if (!ticketCode)
          return c.json(
            { error: "No HITL ticket associated with this programme" },
            409,
          );

        const ticket = await getPendingActionByCode(ticketCode);
        if (!ticket)
          return c.json({ error: "HITL ticket missing or expired" }, 409);
        if (ticket.status !== "pending") {
          return c.json(
            { error: `HITL ticket is ${ticket.status}, cannot approve` },
            409,
          );
        }

        const claimed = await claimForApproval(ticketCode, {
          userId: user.userId,
          email: user.email,
          name: user.name,
        });
        if (!claimed) {
          return c.json(
            {
              error:
                "Could not claim ticket — may be expired or already handled.",
            },
            409,
          );
        }

        const updated = await updateProgramme(id, {
          status: "approved",
          approved_at: new Date(),
          approved_by_email: user.email,
        });

        await recordProgrammeSignoff({
          programme_id: id,
          action: "approved",
          action_code: ticketCode,
          actor_email: user.email,
          actor_role: user.role,
          notes: `Approved by ${user.name || user.email}`,
          snapshot: updated,
        });

        await recordExecutionResult(ticketCode, {
          success: true,
          entityType: "audit_programme",
          entityId: String(id),
          data: { programme_code: programme.programme_code },
        });

        await logEvent({
          userId: user.userId,
          userEmail: user.email,
          userRole: user.role,
          actionType: "AI_ACTION",
          entityType: "audit_programme",
          entityId: String(id),
          entityName: programme.programme_code,
          description: `Approved programme ${programme.programme_code}`,
          module: "audits",
          severity: "INFO",
          aiInvolved: false,
          correlationId: ticketCode,
        }).catch(() => {
          /* non-fatal */
        });

        return c.json({ success: true, programme: updated });
      } catch (err: any) {
        logger.error("[AuditProgramme] approve error", err);
        return c.json(
          { error: "Failed to approve programme", details: err.message },
          500,
        );
      }
    },
  },

  /* ---------------- POST /api/audit-programme/:id/reject ---------------- */
  {
    path: "/api/audit-programme/:id/reject",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canApprove(user.role)) return forbiddenResponse(c);

        const id = parseInt(c.req.param("id"), 10);
        if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
        const body = await c.req.json().catch(() => ({}));
        const reason =
          typeof body?.reason === "string" ? body.reason.trim() : "";
        if (reason.length < 5) {
          return c.json(
            { error: "Rejection reason (min 5 chars) is required." },
            400,
          );
        }
        const programme = await getProgrammeById(id);
        if (!programme) return c.json({ error: "Not found" }, 404);
        if (programme.status !== "pending_signoff") {
          return c.json(
            { error: `Cannot reject from status "${programme.status}"` },
            409,
          );
        }

        const ticketCode = programme.approval_action_code;
        if (ticketCode) {
          await rejectHitl(
            ticketCode,
            {
              userId: user.userId,
              email: user.email,
              name: user.name,
            },
            reason,
          );
        }

        const updated = await updateProgramme(id, { status: "draft" });
        await recordProgrammeSignoff({
          programme_id: id,
          action: "rejected",
          action_code: ticketCode || null,
          actor_email: user.email,
          actor_role: user.role,
          notes: reason,
          snapshot: updated,
        });

        await logEvent({
          userId: user.userId,
          userEmail: user.email,
          userRole: user.role,
          actionType: "AI_ACTION",
          entityType: "audit_programme",
          entityId: String(id),
          entityName: programme.programme_code,
          description: `Rejected programme ${programme.programme_code}: ${reason}`,
          module: "audits",
          severity: "WARNING",
          aiInvolved: false,
          correlationId: ticketCode || undefined,
        }).catch(() => {
          /* non-fatal */
        });

        return c.json({ success: true, programme: updated });
      } catch (err: any) {
        logger.error("[AuditProgramme] reject error", err);
        return c.json(
          { error: "Failed to reject programme", details: err.message },
          500,
        );
      }
    },
  },
];
