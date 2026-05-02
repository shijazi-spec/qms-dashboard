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
];
