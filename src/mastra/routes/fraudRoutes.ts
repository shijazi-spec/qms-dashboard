/**
 * Fraud Management Module — HTTP routes
 *
 * Implements PRD-FRD-001 §5 endpoints. Mirrors the structural pattern of
 * complianceRoutes.ts and riskRoutes.ts:
 *   - Each route exports `{ path, method, createHandler }`.
 *   - Auth is checked inline with rbacMiddleware helpers.
 *   - All ID parameters that can come from the wire as UUIDs are resolved
 *     via the public_id column to avoid leaking sequential IDs.
 *   - Mutation routes are also gated by ROUTE_PERMISSION_MAP in
 *     src/utils/rbacMiddleware.ts.
 *
 * This commit (Feature 1) wires only `/api/fraud/rules*`. Subsequent
 * commits append /incidents, /escalation, /countries, /kpis routes.
 */

import { logger as safeLogger } from "../../utils/logger";
import type { UserRole } from "../../utils/rbacDatabase";

const FRAUD_READ_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
];

const FRAUD_WRITE_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
];

async function requireFraudReadAuth(
  c: any,
): Promise<{ ok: boolean; res?: any }> {
  const {
    getSessionUser,
    requireRoleOrKey,
    unauthorizedResponse,
    forbiddenResponse,
  } = await import("../../utils/rbacMiddleware");
  const session = getSessionUser(c);
  if (!session) return { ok: false, res: unauthorizedResponse(c) };
  const allowed = await requireRoleOrKey(c, FRAUD_READ_ROLES);
  if (!allowed) return { ok: false, res: forbiddenResponse(c) };
  return { ok: true };
}

async function requireFraudWriteAuth(
  c: any,
): Promise<{ ok: boolean; res?: any; user?: any }> {
  const {
    getSessionUser,
    requireRoleOrKey,
    unauthorizedResponse,
    forbiddenResponse,
  } = await import("../../utils/rbacMiddleware");
  const session = getSessionUser(c);
  if (!session) return { ok: false, res: unauthorizedResponse(c) };
  const allowed = await requireRoleOrKey(c, FRAUD_WRITE_ROLES);
  if (!allowed) return { ok: false, res: forbiddenResponse(c) };
  return { ok: true, user: session };
}

/**
 * Resolve a route ID parameter that may be a numeric internal ID or a UUID
 * public_id. Returns the internal numeric ID, or null if not found.
 *
 * Cannot reuse riskDatabase.resolveGenericId because its allowlist does
 * not include fraud_rules. Local resolver keeps the dependency minimal.
 */
async function resolveFraudRuleId(raw: string | undefined): Promise<number | null> {
  if (!raw) return null;
  const { getFraudRuleById, getFraudRuleByPublicId } = await import(
    "../../utils/fraudDatabase"
  );
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    const found = await getFraudRuleById(n);
    return found ? n : null;
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
  ) {
    const found = await getFraudRuleByPublicId(raw);
    return found?.id ?? null;
  }
  return null;
}

function obfuscateRule(row: any): any {
  if (!row) return row;
  const { id: _internalId, ...rest } = row;
  return rest;
}

function obfuscateRuleList(rows: any[]): any[] {
  return rows.map(obfuscateRule);
}

export const fraudRoutes = [
  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/fraud/rules — list rules with filters
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;

          const { getAllFraudRules, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const url = new URL(c.req.url);
          const owner = url.searchParams.get("owner") || undefined;
          const test_status =
            (url.searchParams.get("test_status") as any) || undefined;
          const transaction_type =
            url.searchParams.get("transaction_type") || undefined;

          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/rules", {
            owner,
            test_status,
            transaction_type,
          });

          const rules = await getAllFraudRules({
            owner,
            test_status,
            transaction_type,
          });
          return c.json({ rules: obfuscateRuleList(rules) });
        } catch (error) {
          safeLogger.error("❌ [FraudAPI] GET /api/fraud/rules failed:", error);
          return c.json({ error: "Failed to fetch fraud rules" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/fraud/rules/overdue — rules past next_review date
  // (ordered before /:id so the literal segment matches first)
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules/overdue",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;

          const { getOverdueFraudRules, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/rules/overdue");

          const rules = await getOverdueFraudRules();
          return c.json({ rules: obfuscateRuleList(rules), count: rules.length });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/rules/overdue failed:",
            error,
          );
          return c.json({ error: "Failed to fetch overdue rules" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/fraud/rules/:id — get one rule by internal ID or public_id
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;

          const { initFraudTables, getFraudRuleById } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const id = await resolveFraudRuleId(c.req.param("id"));
          if (id == null) {
            return c.json({ error: "Rule not found" }, 404);
          }
          const rule = await getFraudRuleById(id);
          if (!rule) return c.json({ error: "Rule not found" }, 404);

          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/rules/:id", { id });

          return c.json({ rule: obfuscateRule(rule) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/rules/:id failed:",
            error,
          );
          return c.json({ error: "Failed to fetch fraud rule" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // POST /api/fraud/rules — create a new rule
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;

          const { createFraudRule, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const body = await c.req.json();

          const required = [
            "rule_id",
            "rule_name",
            "transaction_type",
            "owner",
            "test_status",
            "next_review",
          ];
          const missing = required.filter((k) => !body[k]);
          if (missing.length > 0) {
            return c.json(
              { error: `Missing required fields: ${missing.join(", ")}` },
              400,
            );
          }

          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] POST /api/fraud/rules", {
            rule_id: body.rule_id,
            by: auth.user?.email,
          });

          const created = await createFraudRule({
            ...body,
            created_by: auth.user?.email ?? "unknown",
          });

          return c.json({ rule: obfuscateRule(created) }, 201);
        } catch (error: any) {
          if (
            typeof error?.message === "string" &&
            error.message.includes("duplicate key")
          ) {
            return c.json({ error: "Rule with this rule_id already exists" }, 409);
          }
          safeLogger.error("❌ [FraudAPI] POST /api/fraud/rules failed:", error);
          return c.json({ error: "Failed to create fraud rule" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // PUT /api/fraud/rules/:id — update an existing rule
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;

          const { updateFraudRule, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const id = await resolveFraudRuleId(c.req.param("id"));
          if (id == null) {
            return c.json({ error: "Rule not found" }, 404);
          }

          const body = await c.req.json();
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] PUT /api/fraud/rules/:id", {
            id,
            by: auth.user?.email,
          });

          const updated = await updateFraudRule(id, {
            ...body,
            updated_by: auth.user?.email ?? "unknown",
          });
          if (!updated) return c.json({ error: "Rule not found" }, 404);
          return c.json({ rule: obfuscateRule(updated) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/rules/:id failed:",
            error,
          );
          return c.json({ error: "Failed to update fraud rule" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // DELETE /api/fraud/rules/:id — soft-delete a rule
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules/:id",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;

          const { softDeleteFraudRule, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();

          const id = await resolveFraudRuleId(c.req.param("id"));
          if (id == null) {
            return c.json({ error: "Rule not found" }, 404);
          }

          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] DELETE /api/fraud/rules/:id", {
            id,
            by: auth.user?.email,
          });

          const ok = await softDeleteFraudRule(id, auth.user?.email ?? "unknown");
          if (!ok) return c.json({ error: "Rule not found" }, 404);
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] DELETE /api/fraud/rules/:id failed:",
            error,
          );
          return c.json({ error: "Failed to delete fraud rule" }, 500);
        }
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // GET /api/fraud/rules/export/pdf — placeholder until cross-cutting commit
  // (the cross-cutting work item adds the real PDFKit implementation)
  // ───────────────────────────────────────────────────────────────────────────
  {
    path: "/api/fraud/rules/export/pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = await requireFraudReadAuth(c);
        if (!auth.ok) return auth.res;
        return c.json(
          {
            error: "Not yet implemented",
            message:
              "PDF export for fraud rules ships in the cross-cutting commit. " +
              "Use GET /api/fraud/rules to retrieve data, or wait for the PDF endpoint.",
          },
          501,
        );
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 2 — Fraud Incident Register (PRD-FRD-001 §5.2)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/fraud/incidents — list with filters
  {
    path: "/api/fraud/incidents",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getAllFraudIncidents, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const url = new URL(c.req.url);
          const status = (url.searchParams.get("status") as any) || undefined;
          const severity =
            (url.searchParams.get("severity") as any) || undefined;
          const incident_type =
            (url.searchParams.get("incident_type") as any) || undefined;
          const open_only =
            url.searchParams.get("open_only") === "true" ? true : undefined;
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/incidents", {
            status,
            severity,
            incident_type,
            open_only,
          });
          const incidents = await getAllFraudIncidents({
            status,
            severity,
            incident_type,
            open_only,
          });
          return c.json({ incidents: obfuscateRuleList(incidents) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/incidents failed:",
            error,
          );
          return c.json({ error: "Failed to fetch incidents" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/incidents/open — alias for status NOT IN (resolved,closed)
  {
    path: "/api/fraud/incidents/open",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getOpenFraudIncidents, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const incidents = await getOpenFraudIncidents();
          return c.json({
            incidents: obfuscateRuleList(incidents),
            count: incidents.length,
          });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/incidents/open failed:",
            error,
          );
          return c.json({ error: "Failed to fetch open incidents" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/incidents/sama-overdue — P1 approaching 72h deadline
  {
    path: "/api/fraud/incidents/sama-overdue",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getSamaDeadlineApproaching, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const url = new URL(c.req.url);
          const ahead = parseInt(
            url.searchParams.get("hours_ahead") || "60",
            10,
          );
          const incidents = await getSamaDeadlineApproaching(ahead);
          return c.json({
            incidents: obfuscateRuleList(incidents),
            count: incidents.length,
            window_hours_ahead: ahead,
          });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/incidents/sama-overdue failed:",
            error,
          );
          return c.json({ error: "Failed to fetch sama-overdue incidents" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/incidents/:id
  {
    path: "/api/fraud/incidents/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const {
            initFraudTables,
            getFraudIncidentById,
            getFraudIncidentByPublicId,
          } = await import("../../utils/fraudDatabase");
          await initFraudTables();
          const raw = c.req.param("id");
          let incident: any = null;
          if (/^\d+$/.test(raw)) {
            incident = await getFraudIncidentById(parseInt(raw, 10));
          } else if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              raw,
            )
          ) {
            incident = await getFraudIncidentByPublicId(raw);
          }
          if (!incident) return c.json({ error: "Incident not found" }, 404);
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/incidents/:id", {
            id: incident.id,
          });
          return c.json({ incident: obfuscateRule(incident) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/incidents/:id failed:",
            error,
          );
          return c.json({ error: "Failed to fetch incident" }, 500);
        }
      };
    },
  },

  // POST /api/fraud/incidents — create + auto-mirror to enterprise_risks for P1/P2
  // Note: notification dispatch (Feature 4 escalation matrix) is wired in
  // commit #3, after the matrix table has data.
  {
    path: "/api/fraud/incidents",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { createFraudIncident, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const body = await c.req.json();
          const required = [
            "date_detected",
            "severity",
            "incident_type",
            "detection_source",
          ];
          const missing = required.filter((k) => !body[k]);
          if (missing.length > 0) {
            return c.json(
              { error: `Missing required fields: ${missing.join(", ")}` },
              400,
            );
          }
          const validSeverity = ["P1", "P2", "P3", "P4"];
          if (!validSeverity.includes(body.severity)) {
            return c.json({ error: "severity must be P1, P2, P3 or P4" }, 400);
          }
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] POST /api/fraud/incidents", {
            severity: body.severity,
            type: body.incident_type,
            by: auth.user?.email,
          });
          const created = await createFraudIncident({
            ...body,
            created_by: auth.user?.email ?? "unknown",
          });
          return c.json({ incident: obfuscateRule(created) }, 201);
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] POST /api/fraud/incidents failed:",
            error,
          );
          return c.json({ error: "Failed to create incident" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/incidents/:id — generic update
  {
    path: "/api/fraud/incidents/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const {
            initFraudTables,
            updateFraudIncident,
            getFraudIncidentByPublicId,
          } = await import("../../utils/fraudDatabase");
          await initFraudTables();
          const raw = c.req.param("id");
          let id: number | null = null;
          if (/^\d+$/.test(raw)) id = parseInt(raw, 10);
          else if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              raw,
            )
          ) {
            const found = await getFraudIncidentByPublicId(raw);
            id = found?.id ?? null;
          }
          if (id == null) return c.json({ error: "Incident not found" }, 404);
          const body = await c.req.json();
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] PUT /api/fraud/incidents/:id", {
            id,
            by: auth.user?.email,
          });
          const updated = await updateFraudIncident(id, {
            ...body,
            updated_by: auth.user?.email ?? "unknown",
          });
          if (!updated) return c.json({ error: "Incident not found" }, 404);
          return c.json({ incident: obfuscateRule(updated) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/incidents/:id failed:",
            error,
          );
          return c.json({ error: "Failed to update incident" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/incidents/:id/close — closure with sama_reported gate
  // Per PRD §5.2 / AC-5: P1/P2 cannot close without sama_reported value.
  {
    path: "/api/fraud/incidents/:id/close",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          // PRD §5.2 specifies "Head of GRQ only" for close; we currently
          // gate to the standard fraud-write set (admin /
          // head_of_operations_quality / grc_manager). If the alignment
          // meeting tightens to "head_of_operations_quality + admin only",
          // change the auth helper invoked here.
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const {
            initFraudTables,
            closeFraudIncident,
            getFraudIncidentByPublicId,
          } = await import("../../utils/fraudDatabase");
          await initFraudTables();
          const raw = c.req.param("id");
          let id: number | null = null;
          if (/^\d+$/.test(raw)) id = parseInt(raw, 10);
          else if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              raw,
            )
          ) {
            const found = await getFraudIncidentByPublicId(raw);
            id = found?.id ?? null;
          }
          if (id == null) return c.json({ error: "Incident not found" }, 404);
          const body = await c.req.json().catch(() => ({}));
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] PUT /api/fraud/incidents/:id/close", {
            id,
            by: auth.user?.email,
          });
          const result = await closeFraudIncident(
            id,
            auth.user?.email ?? "unknown",
            {
              sama_reported: body.sama_reported,
              resolution_date: body.resolution_date,
              root_cause: body.root_cause,
            },
          );
          if (result.error) {
            return c.json({ error: result.error }, result.code ?? 400);
          }
          return c.json({ incident: obfuscateRule(result.incident) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/incidents/:id/close failed:",
            error,
          );
          return c.json({ error: "Failed to close incident" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/incidents/export/pdf — placeholder, real PDF in cross-cutting
  {
    path: "/api/fraud/incidents/export/pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = await requireFraudReadAuth(c);
        if (!auth.ok) return auth.res;
        return c.json(
          {
            error: "Not yet implemented",
            message:
              "PDF export for fraud incidents ships in the cross-cutting commit.",
          },
          501,
        );
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 4 — Escalation Matrix (PRD-FRD-001 §5.4)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/fraud/escalation — list active matrix rows
  {
    path: "/api/fraud/escalation",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getEscalationMatrix, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const rows = await getEscalationMatrix();
          return c.json({ matrix: obfuscateRuleList(rows) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/escalation failed:",
            error,
          );
          return c.json({ error: "Failed to fetch escalation matrix" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/escalation/:triggerId — single matrix row
  {
    path: "/api/fraud/escalation/:triggerId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getEscalationByTriggerId, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const row = await getEscalationByTriggerId(c.req.param("triggerId"));
          if (!row) return c.json({ error: "Trigger not found" }, 404);
          return c.json({ row: obfuscateRule(row) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/escalation/:triggerId failed:",
            error,
          );
          return c.json({ error: "Failed to fetch trigger" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/escalation/:triggerId — edit a matrix row
  {
    path: "/api/fraud/escalation/:triggerId",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { updateEscalationRow, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const triggerId = c.req.param("triggerId");
          const body = await c.req.json();
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] PUT /api/fraud/escalation/:triggerId", {
            triggerId,
            by: auth.user?.email,
          });
          const updated = await updateEscalationRow(triggerId, {
            ...body,
            updated_by: auth.user?.email ?? "unknown",
          });
          if (!updated) return c.json({ error: "Trigger not found" }, 404);
          return c.json({ row: obfuscateRule(updated) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/escalation/:triggerId failed:",
            error,
          );
          return c.json({ error: "Failed to update trigger" }, 500);
        }
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 3 — Country Risk Assessment (PRD-FRD-001 §5.3)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/fraud/countries — list with filters
  {
    path: "/api/fraud/countries",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getAllCountryRisk, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const url = new URL(c.req.url);
          const rating = (url.searchParams.get("rating") as any) || undefined;
          const fatf_status =
            (url.searchParams.get("fatf_status") as any) || undefined;
          const eddRaw = url.searchParams.get("edd_required");
          const edd_required =
            eddRaw === "true" ? true : eddRaw === "false" ? false : undefined;
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] GET /api/fraud/countries", {
            rating,
            fatf_status,
            edd_required,
          });
          const rows = await getAllCountryRisk({
            rating,
            fatf_status,
            edd_required,
          });
          return c.json({ countries: obfuscateRuleList(rows) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/countries failed:",
            error,
          );
          return c.json({ error: "Failed to fetch country risk list" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/countries/blacklisted — count + list of FATF black-list rows
  {
    path: "/api/fraud/countries/blacklisted",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { getAllCountryRisk, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const rows = await getAllCountryRisk({ fatf_status: "black_list" });
          return c.json({ countries: obfuscateRuleList(rows), count: rows.length });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/countries/blacklisted failed:",
            error,
          );
          return c.json({ error: "Failed to fetch blacklisted countries" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/countries/:iso — single country by ISO-2 code or public_id
  {
    path: "/api/fraud/countries/:iso",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const {
            initFraudTables,
            getCountryRiskByIso,
            getCountryRiskByPublicId,
          } = await import("../../utils/fraudDatabase");
          await initFraudTables();
          const raw = c.req.param("iso");
          let row: any = null;
          if (
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              raw,
            )
          ) {
            row = await getCountryRiskByPublicId(raw);
          } else {
            row = await getCountryRiskByIso(raw);
          }
          if (!row) return c.json({ error: "Country not found" }, 404);
          return c.json({ country: obfuscateRule(row) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/countries/:iso failed:",
            error,
          );
          return c.json({ error: "Failed to fetch country" }, 500);
        }
      };
    },
  },

  // POST /api/fraud/countries — create a new country row
  {
    path: "/api/fraud/countries",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { createCountryRisk, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const body = await c.req.json();
          const required = [
            "iso_code",
            "country_name",
            "fatf_status",
            "risk_rating",
            "bin_status",
          ];
          const missing = required.filter((k) => !body[k]);
          if (missing.length > 0) {
            return c.json(
              { error: `Missing required fields: ${missing.join(", ")}` },
              400,
            );
          }
          if (typeof body.iso_code !== "string" || body.iso_code.length !== 2) {
            return c.json({ error: "iso_code must be ISO-3166-1 alpha-2" }, 400);
          }
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] POST /api/fraud/countries", {
            iso: body.iso_code,
            by: auth.user?.email,
          });
          const created = await createCountryRisk({
            ...body,
            approved_by: auth.user?.email ?? "unknown",
          });
          return c.json({ country: obfuscateRule(created) }, 201);
        } catch (error: any) {
          if (
            typeof error?.message === "string" &&
            error.message.includes("duplicate key")
          ) {
            return c.json({ error: "Country with this iso_code already exists" }, 409);
          }
          safeLogger.error(
            "❌ [FraudAPI] POST /api/fraud/countries failed:",
            error,
          );
          return c.json({ error: "Failed to create country" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/countries/:iso — update; FATF black-list invariant enforced
  {
    path: "/api/fraud/countries/:iso",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { updateCountryRisk, initFraudTables } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const iso = c.req.param("iso");
          const body = await c.req.json();
          const logger = mastra?.getLogger();
          logger?.info("🛡️  [FraudAPI] PUT /api/fraud/countries/:iso", {
            iso,
            by: auth.user?.email,
          });
          const updated = await updateCountryRisk(
            iso,
            body,
            auth.user?.email ?? "unknown",
          );
          if (!updated) return c.json({ error: "Country not found" }, 404);
          return c.json({ country: obfuscateRule(updated) });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/countries/:iso failed:",
            error,
          );
          return c.json({ error: "Failed to update country" }, 500);
        }
      };
    },
  },

  // DELETE /api/fraud/countries/:iso — no-op (reference data; see helper)
  {
    path: "/api/fraud/countries/:iso",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = await requireFraudWriteAuth(c);
        if (!auth.ok) return auth.res;
        return c.json(
          {
            success: true,
            warning:
              "Country rows are reference data — DELETE is a no-op. Edit bin_status to 'not_approved' to disable a country.",
          },
          200,
        );
      };
    },
  },

  // GET /api/fraud/countries/export/pdf — placeholder
  {
    path: "/api/fraud/countries/export/pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = await requireFraudReadAuth(c);
        if (!auth.ok) return auth.res;
        return c.json(
          {
            error: "Not yet implemented",
            message:
              "PDF export for country risk ships in the cross-cutting commit.",
          },
          501,
        );
      };
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Feature 5 — KPI Dashboard (PRD-FRD-001 §5.5)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/fraud/kpis/thresholds — list all thresholds
  {
    path: "/api/fraud/kpis/thresholds",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, getAllKpiThresholds } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const rows = await getAllKpiThresholds();
          return c.json({ thresholds: rows });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/kpis/thresholds failed:",
            error,
          );
          return c.json({ error: "Failed to fetch thresholds" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/kpis/thresholds/:metric — edit threshold
  {
    path: "/api/fraud/kpis/thresholds/:metric",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, updateKpiThreshold } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const metric = c.req.param("metric");
          const body = await c.req.json();
          if (
            body.target_value == null ||
            body.alert_value == null ||
            !body.direction
          ) {
            return c.json(
              { error: "target_value, alert_value, direction are required" },
              400,
            );
          }
          const updated = await updateKpiThreshold(
            metric,
            {
              target_value: Number(body.target_value),
              alert_value: Number(body.alert_value),
              direction: body.direction,
            },
            auth.user?.email ?? "unknown",
          );
          if (!updated) return c.json({ error: "Metric not found" }, 404);
          return c.json({ threshold: updated });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] PUT /api/fraud/kpis/thresholds/:metric failed:",
            error,
          );
          return c.json({ error: "Failed to update threshold" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/kpis — list KPIs across a date range (default last 12 months)
  {
    path: "/api/fraud/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, getKpisForRange } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const url = new URL(c.req.url);
          const today = new Date();
          const from = url.searchParams.get("from") || `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          const to = url.searchParams.get("to") || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          const rows = await getKpisForRange(from, to);
          return c.json({ kpis: rows, from, to });
        } catch (error) {
          safeLogger.error("❌ [FraudAPI] GET /api/fraud/kpis failed:", error);
          return c.json({ error: "Failed to fetch KPIs" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/kpis/:month — single month KPI snapshot
  {
    path: "/api/fraud/kpis/:month",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, getKpiForMonth } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const month = c.req.param("month");
          if (!/^\d{4}-\d{2}(-\d{2})?$/.test(month)) {
            return c.json({ error: "month must be YYYY-MM or YYYY-MM-DD" }, 400);
          }
          const row = await getKpiForMonth(month);
          if (!row) return c.json({ error: "No KPI snapshot for that month" }, 404);
          return c.json({ kpi: row });
        } catch (error) {
          safeLogger.error("❌ [FraudAPI] GET /api/fraud/kpis/:month failed:", error);
          return c.json({ error: "Failed to fetch KPI" }, 500);
        }
      };
    },
  },

  // POST /api/fraud/kpis/:month/auto-calculate — recompute from incidents data
  {
    path: "/api/fraud/kpis/:month/auto-calculate",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, autoCalculateKpisForMonth, upsertFraudKpi } =
            await import("../../utils/fraudDatabase");
          await initFraudTables();
          const month = c.req.param("month");
          if (!/^\d{4}-\d{2}(-\d{2})?$/.test(month)) {
            return c.json({ error: "month must be YYYY-MM or YYYY-MM-DD" }, 400);
          }
          const calc = await autoCalculateKpisForMonth(month);
          const persisted = await upsertFraudKpi(month, calc, auth.user?.email ?? "system:auto-calc");
          return c.json({ kpi: persisted, source: "auto" });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] POST /api/fraud/kpis/:month/auto-calculate failed:",
            error,
          );
          return c.json({ error: "Failed to auto-calculate KPIs" }, 500);
        }
      };
    },
  },

  // PUT /api/fraud/kpis/:month — manual upsert (also recomputes ratios if data is sufficient)
  {
    path: "/api/fraud/kpis/:month",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudWriteAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, upsertFraudKpi } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const month = c.req.param("month");
          const body = await c.req.json();
          const persisted = await upsertFraudKpi(
            month,
            body,
            auth.user?.email ?? "unknown",
          );
          return c.json({ kpi: persisted, source: "manual" });
        } catch (error) {
          safeLogger.error("❌ [FraudAPI] PUT /api/fraud/kpis/:month failed:", error);
          return c.json({ error: "Failed to update KPI" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/kpis/current/summary — current month with computed colors
  {
    path: "/api/fraud/kpis/current/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const {
            initFraudTables,
            getKpiForMonth,
            autoCalculateKpisForMonth,
            getAllKpiThresholds,
            evaluateKpiColor,
          } = await import("../../utils/fraudDatabase");
          await initFraudTables();
          const today = new Date();
          const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          let kpi: any = await getKpiForMonth(month);
          if (!kpi) {
            // Lazily compute if not present (no-write, just preview)
            kpi = { month, ...(await autoCalculateKpisForMonth(month)) };
          }
          const thresholds = await getAllKpiThresholds();
          const tMap = new Map(thresholds.map((t) => [t.metric_name, t]));
          const colors: Record<string, string> = {};
          for (const t of thresholds) {
            colors[t.metric_name] = evaluateKpiColor(
              kpi[t.metric_name] == null ? null : Number(kpi[t.metric_name]),
              tMap.get(t.metric_name)!,
            );
          }
          return c.json({ month, kpi, thresholds, colors });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/kpis/current/summary failed:",
            error,
          );
          return c.json({ error: "Failed to load KPI summary" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/kpis/trend/:metric — trailing 12-month series for one metric
  {
    path: "/api/fraud/kpis/trend/:metric",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const auth = await requireFraudReadAuth(c);
          if (!auth.ok) return auth.res;
          const { initFraudTables, getKpisForRange } = await import(
            "../../utils/fraudDatabase"
          );
          await initFraudTables();
          const metric = c.req.param("metric");
          const today = new Date();
          const from = `${today.getFullYear() - 1}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          const to = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
          const rows = await getKpisForRange(from, to);
          const series = rows.map((r: any) => ({
            month: r.month,
            value: r[metric] == null ? null : Number(r[metric]),
          }));
          return c.json({ metric, series });
        } catch (error) {
          safeLogger.error(
            "❌ [FraudAPI] GET /api/fraud/kpis/trend/:metric failed:",
            error,
          );
          return c.json({ error: "Failed to load trend" }, 500);
        }
      };
    },
  },

  // GET /api/fraud/kpis/export/pdf — placeholder, real PDF in cross-cutting
  {
    path: "/api/fraud/kpis/export/pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = await requireFraudReadAuth(c);
        if (!auth.ok) return auth.res;
        return c.json(
          {
            error: "Not yet implemented",
            message: "PDF export for KPIs ships in the cross-cutting commit.",
          },
          501,
        );
      };
    },
  },
];
