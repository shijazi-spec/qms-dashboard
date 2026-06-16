/**
 * HITL Approval API routes.
 *
 * Endpoints:
 *   GET    /api/ai/approvals              list pending/recent actions (filters)
 *   GET    /api/ai/approvals/pending-count badge count
 *   GET    /api/ai/approvals/:code        detail (enriched with WP-doc links)
 *   POST   /api/ai/approvals/:code/approve execute the gated tool
 *   POST   /api/ai/approvals/:code/reject  reject with reason
 *
 * Authorization:
 *   - GET endpoints: any authenticated user can see their OWN pending actions
 *     (requested_by_user_id = self). Admins + quality_managers see everything.
 *   - POST approve/reject: only users whose role is in APPROVER_ROLES_BY_RISK
 *     for the action's risk level. Current policy = quality_manager or admin.
 *
 * Anti-fraud / integrity:
 *   - Claim step is atomic (SQL UPDATE with WHERE status='pending').
 *   - Every transition is written to event_logs with correlation_id = action_code.
 *   - A user can never approve their own request (WP-DOC-005 segregation of duties)
 *     unless they are the admin break-glass role.
 */

import {
  initAIApprovalTable,
  listPendingActions,
  getPendingActionByCode,
  claimForApproval,
  rejectAction,
  countPendingForUser,
  countPendingWithCredentialWarnings,
  countByReviewStatus,
  countByRiskLevel,
  countByStatus,
  type ApprovalStatus,
  type RiskLevel,
} from "../../utils/aiApprovalDatabase";
import {
  executeApprovedAction,
  isToolGated,
} from "../../utils/withApprovalGate";
import {
  isAllowedApprover,
  getApproverRolesFor,
  getPolicy,
} from "../../utils/aiToolGovernance";
import { resolveControlledDocuments } from "../../utils/controlledDocumentRegistry";
import {
  getSessionUser,
  requireRole,
  unauthorizedResponse,
  forbiddenResponse,
  gateApiRoute,
  hasValidAdminApiKey,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

import { logger } from "../../utils/logger";
const AI_APPROVAL_READ_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "ai_specialist",
  "bu_owner",
  "executive",
  "quality_specialist",
  "auditor",
  "team_lead",
];
const AI_APPROVAL_APPROVE_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];
// Roles exempt from the WP-DOC-005 self-approval block (break-glass): they may
// approve their OWN AI proposals. "admin" is the platform break-glass role;
// "head_of_operations_quality" (the GRQ lead who owns the SoD policy and is the
// primary operator) was added per Sarah's governance decision 2026-06-16 so the
// duplicate-cleanup workflow isn't stalled waiting for a second approver.
const SELF_APPROVE_EXEMPT_ROLES = new Set<string>([
  "admin",
  "head_of_operations_quality",
]);
const AI_APPROVAL_REJECT_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "ai_specialist",
  "bu_owner",
  "executive",
  "quality_specialist",
  "auditor",
  "team_lead",
];
import {
  logEvent,
  redactSensitiveDeep,
  redactSecretLikeStrings,
  getActionViewers,
  getActionViewersBatch,
} from "../../utils/eventLogsDatabase";

// Lazily initialize the table on first request to this route set.
let tableReady = false;
async function ensureTable() {
  if (!tableReady) {
    await initAIApprovalTable();
    tableReady = true;
  }
}

// One-shot background bootstrap (runs on module load): initialize the
// policies table then seed the controlled-document registry (WP-*). This
// keeps approval-card links resolvable from day one. Safe to re-run.
(async () => {
  try {
    const { initPolicyTables } = await import("../../utils/policyDatabase");
    const { seedControlledDocumentRegistry } =
      await import("../../utils/controlledDocumentRegistry");
    await initPolicyTables();
    await seedControlledDocumentRegistry();
    await initAIApprovalTable();
    tableReady = true;
    logger.info(
      "[AI-Approval] Bootstrap complete (policies + ai_pending_actions + controlled-doc seed)",
    );
  } catch (err) {
    logger.error("[AI-Approval] Bootstrap failed:", err);
  }
})();

/**
 * Extracts WP-* document codes from a compliance-refs string list.
 * Input:  ["WP-SOP-009 (Nonconformity, ...)", "ISO 9001:2015 §10.2"]
 * Output: ["WP-SOP-009"]
 */
function extractWpCodes(refs: string[]): string[] {
  const codes = new Set<string>();
  for (const r of refs || []) {
    const m = /^WP-[A-Z]+-\d+/.exec(r);
    if (m) codes.add(m[0]);
  }
  return [...codes];
}

function canSeeAll(role: string | null | undefined): boolean {
  return role === "admin" || role === "quality_manager";
}

/**
 * Task #349: prefixes whose `tool_id` rows must never appear in the
 * approvals dashboard outside of the dedicated `test` NODE_ENV.
 *
 * Task #116 permanently registered two synthetic redaction-canary tools
 * (`integration-test-redaction-canary__ok` /
 *  `integration-test-redaction-canary__throws`) so the live-HTTP
 * integration test (`tests/aiApprovalRoutesRedaction.integration.ts`)
 * can exercise the POST /approve redaction path. If a developer or QA
 * operator ever pointed that test at production — or otherwise seeded
 * a row for those IDs — those rows would otherwise appear alongside
 * real approval requests in the live dashboard.
 *
 * We exclude any tool_id starting with `integration-test-` from the
 * list, badge count, and credential-warning count whenever NODE_ENV is
 * not `test`. The integration test still works because:
 *   - It seeds the rows it asserts on with a real tool_id
 *     (`rotate_api_key`), not an `integration-test-*` ID.
 *   - The canary rows it does seed are only driven via POST /approve
 *     (lookup-by-action_code), which does not apply this filter.
 */
function getExcludedToolIdPrefixes(): string[] {
  return process.env.NODE_ENV === "test" ? [] : ["integration-test-"];
}

function aiApprovalGate<
  T extends { path: string; method: string; createHandler: (deps: any) => any },
>(route: T): T {
  if (!route.path.startsWith("/api/")) return route;
  let roles: UserRole[];
  if (route.path.endsWith("/approve")) {
    roles = AI_APPROVAL_APPROVE_ROLES;
  } else if (route.path.endsWith("/reject")) {
    roles = AI_APPROVAL_REJECT_ROLES;
  } else {
    roles = AI_APPROVAL_READ_ROLES;
  }
  const originalCreate = route.createHandler;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        const user = await requireRole(c, roles);
        if (!user)
          return forbiddenResponse(
            c,
            "Insufficient permissions for AI approval data",
          );
        return inner(c);
      };
    },
  };
}

const _aiApprovalRoutesRaw = [
  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals                                                */
  /* -------------------------------------------------------------------- */
  {
    path: "/api/ai/approvals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const statusParam = url.searchParams.get("status");
          const riskLevel = url.searchParams.get(
            "risk_level",
          ) as RiskLevel | null;
          const mine = url.searchParams.get("mine") === "true";
          const limit = parseInt(url.searchParams.get("limit") || "50", 10);
          const offset = parseInt(url.searchParams.get("offset") || "0", 10);

          // Task #298: optional review-status filter. Accepted values:
          //   'unreviewed_by_me' — actions the current user has never opened
          //                        the detail page for
          //   'no_reviewers'     — actions nobody has opened yet
          // Anything else (including absent) leaves the queue unfiltered.
          const reviewFilterParam = url.searchParams.get("review_filter");
          const reviewFilter =
            reviewFilterParam === "unreviewed_by_me" ||
            reviewFilterParam === "no_reviewers"
              ? reviewFilterParam
              : undefined;

          const status = statusParam
            ? (statusParam.split(",").map((s) => s.trim()) as ApprovalStatus[])
            : (["pending"] as ApprovalStatus[]);

          // Non-privileged users can only see their own rows. Privileged users
          // ("admin", "quality_manager") see everything unless mine=true.
          const requestedByUserId =
            canSeeAll(user.role) && !mine ? undefined : user.userId;

          const { rows, total } = await listPendingActions({
            status,
            riskLevel: riskLevel || undefined,
            requestedByUserId,
            reviewFilter,
            // Only meaningful for 'unreviewed_by_me'; harmless otherwise.
            reviewerUserId: user.userId ?? undefined,
            limit,
            offset,
            excludeToolIdPrefixes: getExcludedToolIdPrefixes(),
          });

          // Attach prior-viewer summaries so the list cards can show
          // "Recently viewed by" without a separate per-card request.
          const actionCodes = rows.map((r: any) => r.action_code as string);
          const viewersMap = await getActionViewersBatch(actionCodes);
          const rowsWithViewers = rows.map((r: any) => ({
            ...r,
            prior_viewers: viewersMap[r.action_code] ?? [],
          }));

          return c.json({ success: true, total, rows: rowsWithViewers });
        } catch (error: any) {
          logger.error("[AI-Approval] list error:", error);
          return c.json(
            { error: "Failed to list approvals", details: error.message },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/pending-count                                  */
  /* -------------------------------------------------------------------- */
  {
    path: "/api/ai/approvals/pending-count",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          // Pass 0 for privileged users -> unfiltered; otherwise scope to own
          const targetUserId = canSeeAll(user.role) ? 0 : user.userId;
          const n = await countPendingForUser(
            targetUserId,
            getExcludedToolIdPrefixes(),
          );
          return c.json({ success: true, count: n });
        } catch (error: any) {
          logger.error("[AI-Approval] count error:", error);
          return c.json(
            { error: "Failed to fetch count", details: error.message },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/credential-warning-count                       */
  /* -------------------------------------------------------------------- */
  /* Task #481: drives the "credential warnings" badge on the approval    */
  /* queue header. Returns the count of pending rows whose payload was    */
  /* flagged with credential-shaped values, scoped to what the caller is  */
  /* allowed to see (admins/QMs see all; everyone else sees their own).   */
  {
    path: "/api/ai/approvals/credential-warning-count",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const targetUserId = canSeeAll(user.role) ? 0 : user.userId;
          const n = await countPendingWithCredentialWarnings(
            targetUserId,
            getExcludedToolIdPrefixes(),
          );
          return c.json({ success: true, count: n });
        } catch (error: any) {
          logger.error("[AI-Approval] credential-warning count error:", error);
          return c.json(
            {
              error: "Failed to fetch credential-warning count",
              details: error.message,
            },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/review-status-counts                           */
  /* -------------------------------------------------------------------- */
  /* Task #513: drives the inline counts next to each option of the      */
  /* "Review" filter on the approval queue UI. Returns                    */
  /*   { unreviewed_by_me, no_reviewers }                                 */
  /* scoped to the same Status / Risk / "Only my proposals" filters the   */
  /* operator currently has selected on the list, so the numbers stay     */
  /* coherent with the visible rows. Visibility scoping mirrors the LIST  */
  /* endpoint: admins / quality_managers see the global counts (unless    */
  /* mine=true); everyone else sees only their own pending rows.          */
  {
    path: "/api/ai/approvals/review-status-counts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const statusParam = url.searchParams.get("status");
          const riskLevel = url.searchParams.get(
            "risk_level",
          ) as RiskLevel | null;
          const mine = url.searchParams.get("mine") === "true";

          const status = statusParam
            ? (statusParam.split(",").map((s) => s.trim()) as ApprovalStatus[])
            : (["pending"] as ApprovalStatus[]);

          const requestedByUserId =
            canSeeAll(user.role) && !mine
              ? undefined
              : (user.userId ?? undefined);

          // user.userId may be null in dev sessions; fall back to 0 so the
          // SQL still binds a parameter (no rows will match user_id=0, which
          // simply means "every row counts as unreviewed_by_me", matching
          // the operator expectation that an unauthenticated viewer has
          // never opened any detail page).
          const reviewerUserId = user.userId ?? 0;

          const counts = await countByReviewStatus({
            status,
            riskLevel: riskLevel || undefined,
            requestedByUserId,
            reviewerUserId,
          });

          return c.json({ success: true, ...counts });
        } catch (error: any) {
          logger.error("[AI-Approval] review-status-counts error:", error);
          return c.json(
            {
              error: "Failed to fetch review-status counts",
              details: error.message,
            },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/risk-level-counts                              */
  /* -------------------------------------------------------------------- */
  /* Task #536: drives the inline counts next to each option of the      */
  /* "Risk" filter on the approval queue UI. Returns                      */
  /*   { critical, high, medium, low }                                    */
  /* scoped to the same Status / "Only my proposals" / Review filters     */
  /* the operator currently has selected on the list, so the numbers      */
  /* stay coherent with the visible rows. Visibility scoping mirrors the  */
  /* LIST endpoint: admins / quality_managers see the global counts       */
  /* (unless mine=true); everyone else sees only their own pending rows.  */
  {
    path: '/api/ai/approvals/risk-level-counts',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const statusParam = url.searchParams.get('status');
          const mine = url.searchParams.get('mine') === 'true';

          // Mirror the LIST endpoint's review-filter parsing exactly so
          // that an unknown / absent value silently degrades to "no
          // review filter" rather than throwing.
          const reviewFilterParam = url.searchParams.get('review_filter');
          const reviewFilter =
            reviewFilterParam === 'unreviewed_by_me' || reviewFilterParam === 'no_reviewers'
              ? reviewFilterParam
              : undefined;

          const status = statusParam
            ? (statusParam.split(',').map(s => s.trim()) as ApprovalStatus[])
            : (['pending'] as ApprovalStatus[]);

          const requestedByUserId =
            (canSeeAll(user.role) && !mine) ? undefined : (user.userId ?? undefined);

          // Only meaningful when reviewFilter='unreviewed_by_me'; we
          // still pass it for 'no_reviewers' so the helper signature
          // is symmetric with countByReviewStatus / listPendingActions.
          const reviewerUserId = user.userId ?? 0;

          const counts = await countByRiskLevel({
            status,
            requestedByUserId,
            reviewFilter,
            reviewerUserId,
          });

          return c.json({ success: true, ...counts });
        } catch (error: any) {
          logger.error('[AI-Approval] risk-level-counts error:', error);
          return c.json(
            { error: 'Failed to fetch risk-level counts', details: error.message },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/status-counts                                  */
  /* -------------------------------------------------------------------- */
  /* Task #618: drives the inline counts next to each option of the      */
  /* "Status" filter on the approval queue UI. Returns                    */
  /*   { pending, executed, rejected, failed, expired }                   */
  /* scoped to the same Risk / "Only my proposals" / Review filters       */
  /* the operator currently has selected on the list, so the numbers      */
  /* stay coherent with the visible rows. We deliberately ignore the      */
  /* incoming `status` query param: the whole point of these counts is    */
  /* to surface every status bucket regardless of which one is selected,  */
  /* otherwise four of the five labels would always read "(0)" and the    */
  /* operator could never see a backlog or failure spike at a glance.     */
  /* Visibility scoping mirrors the LIST endpoint: admins / quality_      */
  /* managers see the global counts (unless mine=true); everyone else     */
  /* sees only their own pending rows.                                    */
  {
    path: '/api/ai/approvals/status-counts',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const riskLevel = url.searchParams.get('risk_level') as RiskLevel | null;
          const mine = url.searchParams.get('mine') === 'true';

          // Mirror the LIST endpoint's review-filter parsing exactly so
          // that an unknown / absent value silently degrades to "no
          // review filter" rather than throwing.
          const reviewFilterParam = url.searchParams.get('review_filter');
          const reviewFilter =
            reviewFilterParam === 'unreviewed_by_me' || reviewFilterParam === 'no_reviewers'
              ? reviewFilterParam
              : undefined;

          const requestedByUserId =
            (canSeeAll(user.role) && !mine) ? undefined : (user.userId ?? undefined);

          // Only meaningful when reviewFilter='unreviewed_by_me'; we
          // still pass it for 'no_reviewers' so the helper signature
          // is symmetric with countByRiskLevel / listPendingActions.
          const reviewerUserId = user.userId ?? 0;

          const counts = await countByStatus({
            riskLevel: riskLevel || undefined,
            requestedByUserId,
            reviewFilter,
            reviewerUserId,
          });

          return c.json({ success: true, ...counts });
        } catch (error: any) {
          logger.error('[AI-Approval] status-counts error:', error);
          return c.json(
            { error: 'Failed to fetch status counts', details: error.message },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/:code                                          */
  /* -------------------------------------------------------------------- */
  {
    path: "/api/ai/approvals/:code",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const code = c.req.param("code");
          const action = await getPendingActionByCode(code);
          if (!action) {
            // Task #545: include a stable machine-readable `code` so the
            // dashboard's deep-link handler can show a friendly
            // "Action not found" toast (rather than the generic
            // "failed to load") when an operator follows a stale
            // notification link. Echo the requested action_code back so
            // the client can render it without re-parsing the URL.
            return c.json({
              error: 'Approval action not found',
              code: 'NOT_FOUND',
              action_code: code,
            }, 404);
          }

          // Authorization: requester OR privileged role can view.
          const isRequester = action.requested_by_user_id === user.userId;
          if (!isRequester && !canSeeAll(user.role)) {
            return forbiddenResponse(c, "Not authorized to view this approval");
          }

          // PDPL Art. 16 / ISO 27001 A.5.37 evidence trail:
          // record an AI_ACTION event whenever a non-requester reviewer
          // inspects the (potentially sensitive) detail payload. We
          // intentionally skip the requester's own self-views to avoid
          // log noise — the request itself is already audited at enqueue
          // time. The event carries no payload values; correlation_id =
          // action_code so it lines up with the eventual approve/reject
          // entries on the same trail.
          if (!isRequester) {
            // Status-aware wording so the audit row stays accurate when the
            // detail page is reopened after the action has already been
            // approved/executed/rejected/etc. (we still record those views —
            // the redacted execution_result is itself sensitive evidence).
            const statusLabel =
              action.status === "pending" ? "pending" : action.status;
            await logEvent({
              userId: user.userId,
              userEmail: user.email,
              userRole: user.role,
              actionType: "AI_ACTION",
              entityType: "SYSTEM",
              entityId: action.action_code,
              entityName: action.tool_label,
              description: `Viewed ${statusLabel} AI action ${action.action_code} (${action.tool_label})`,
              aiInvolved: true,
              severity: "INFO",
              module: "ai-governance",
              correlationId: action.action_code,
            }).catch((err) => {
              logger.error(
                "[AI-Approval] view-audit logEvent failed (non-fatal):",
                err,
              );
            });
          }

          // Enrich compliance_refs with clickable links to the controlled documents.
          const wpCodes = extractWpCodes(action.compliance_refs || []);
          const [docLinks, priorViewers] = await Promise.all([
            resolveControlledDocuments(wpCodes),
            getActionViewers(code),
          ]);

          // Indicate to the UI whether the current user is ALLOWED to approve
          // (role matches) AND is NOT the requester (segregation of duties).
          const isSelfRequest = action.requested_by_user_id === user.userId;
          const selfApproveExempt = SELF_APPROVE_EXEMPT_ROLES.has(user.role);
          const canApprove =
            isAllowedApprover(action.risk_level, user.role) &&
            (!isSelfRequest || selfApproveExempt);
          const canApproveReason = !isAllowedApprover(
            action.risk_level,
            user.role,
          )
            ? `Your role (${user.role}) is not in the approver list for ${action.risk_level} risk. Required: ${getApproverRolesFor(action.risk_level).join(", ")}.`
            : isSelfRequest && !selfApproveExempt
              ? "You cannot approve your own AI proposal (WP-DOC-005 Segregation of Duties)."
              : null;

          return c.json({
            success: true,
            action,
            compliance_doc_links: docLinks,
            can_approve: canApprove,
            can_approve_blocker: canApproveReason,
            approver_roles: getApproverRolesFor(action.risk_level),
            prior_viewers: priorViewers,
          });
        } catch (error: any) {
          logger.error("[AI-Approval] detail error:", error);
          return c.json(
            { error: "Failed to fetch approval", details: error.message },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* POST /api/ai/approvals/:code/approve                                 */
  /* -------------------------------------------------------------------- */
  {
    path: "/api/ai/approvals/:code/approve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          // Admin-password fast-path: a valid x-admin-key (the same shared admin
          // key used by Split / Rebuild in the Duplicate Radar) grants admin
          // authority — so the approver gets the role gate + segregation-of-duties
          // exemption and can apply the action immediately, without the
          // /ai-approvals queue or a second person. Keeps the session user's
          // identity for the audit trail when present.
          const viaAdminKey = hasValidAdminApiKey(c);
          const sessionUser = getSessionUser(c);
          if (!sessionUser && !viaAdminKey) return unauthorizedResponse(c);
          const user = viaAdminKey
            ? {
                ...(sessionUser || {
                  userId: 0,
                  email: "api-key@system",
                  name: "Admin Key",
                }),
                role: "admin" as UserRole,
              }
            : sessionUser!;

          const code = c.req.param("code");
          const action = await getPendingActionByCode(code);
          if (!action)
            return c.json({ error: "Approval action not found" }, 404);
          if (action.status !== "pending") {
            return c.json(
              { error: `Action is ${action.status}, cannot approve` },
              409,
            );
          }

          // Role gate
          if (!isAllowedApprover(action.risk_level, user.role)) {
            return forbiddenResponse(
              c,
              `Role "${user.role}" is not permitted to approve ${action.risk_level}-risk AI actions. ` +
                `Required roles: ${getApproverRolesFor(action.risk_level).join(", ")}.`,
            );
          }

          // Segregation of duties (WP-DOC-005). Break-glass roles
          // (SELF_APPROVE_EXEMPT_ROLES) may approve their own proposals.
          if (
            !SELF_APPROVE_EXEMPT_ROLES.has(user.role) &&
            action.requested_by_user_id != null &&
            action.requested_by_user_id === user.userId
          ) {
            return forbiddenResponse(
              c,
              "Segregation of duties: you cannot approve your own AI proposal. See WP-DOC-005.",
            );
          }

          // Defense in depth: confirm the tool is actually registered as gated.
          if (!isToolGated(action.tool_id)) {
            return c.json(
              {
                error: `Tool "${action.tool_id}" is no longer registered as gated. Approval blocked.`,
              },
              409,
            );
          }

          // Atomic claim (pending -> approved)
          const claimed = await claimForApproval(action.action_code, {
            userId: user.userId,
            email: user.email,
            name: user.name,
          });
          if (!claimed) {
            // Someone else approved/rejected it between GET and POST, or it expired.
            const current = await getPendingActionByCode(code);
            return c.json(
              {
                error:
                  "Could not claim approval — it may have been handled by another reviewer or expired.",
                currentStatus: current?.status,
              },
              409,
            );
          }

          await logEvent({
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            actionType: "AI_ACTION",
            entityType: "SYSTEM",
            entityId: claimed.action_code,
            entityName: claimed.tool_label,
            description: `Approved AI action ${claimed.action_code} (${claimed.tool_label})`,
            aiInvolved: true,
            severity:
              claimed.risk_level === "critical" || claimed.risk_level === "high"
                ? "WARNING"
                : "INFO",
            module: "ai-governance",
            correlationId: claimed.action_code,
          }).catch(() => {
            /* non-fatal */
          });

          // Execute the underlying tool with the stored payload. On failure,
          // ai_pending_actions.status becomes 'failed' (recorded inside).
          const outcome = await executeApprovedAction(claimed);

          // SECURITY (PDPL Art. 16 / PCI DSS §3.5 / ISO 27001 A.5.34):
          // The synchronous response is the freshest possible exposure of a
          // rotation/refresh tool's output — it goes straight back to the
          // browser even though the JSONB row is masked on the way to
          // ai_pending_actions.execution_result. Run the data graph through
          // the same combined deny-list (key-based + regex-based) used for
          // the stored row, and scrub any free-form error string the same
          // way so that a thrown exception cannot echo a key either. This
          // is the only path where the secret is most fresh and most
          // dangerous, so it must NEVER be returned in plaintext.
          const safeResult = redactSensitiveDeep(outcome.data);
          const safeError =
            typeof outcome.error === "string"
              ? (redactSecretLikeStrings(outcome.error) as string)
              : outcome.error;

          // Return everything the UI needs to update the inline chat card.
          return c.json(
            {
              success: outcome.ok,
              actionCode: claimed.action_code,
              entityType: outcome.entityType,
              entityId: outcome.entityId,
              result: safeResult,
              error: safeError,
            },
            outcome.ok ? 200 : 500,
          );
        } catch (error: any) {
          logger.error("[AI-Approval] approve error:", error);
          // Same redaction guarantee as the success path: a thrown error
          // message can carry the freshly-minted credential the failing
          // tool was trying to handle.
          const safeDetails =
            typeof error?.message === "string"
              ? (redactSecretLikeStrings(error.message) as string)
              : undefined;
          return c.json(
            { error: "Failed to approve", details: safeDetails },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* POST /api/ai/approvals/:code/reject                                  */
  /* -------------------------------------------------------------------- */
  {
    path: "/api/ai/approvals/:code/reject",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const code = c.req.param("code");
          const body = await c.req.json().catch(() => ({}));
          const reason = (body?.reason || "").toString().trim();
          if (!reason || reason.length < 3) {
            return c.json(
              {
                error:
                  "A rejection reason (>=3 chars) is required for audit purposes.",
              },
              400,
            );
          }

          const action = await getPendingActionByCode(code);
          if (!action)
            return c.json({ error: "Approval action not found" }, 404);
          if (action.status !== "pending") {
            return c.json(
              { error: `Action is ${action.status}, cannot reject` },
              409,
            );
          }

          // Requester may reject their own draft (cancel); approvers may reject any.
          const isRequester = action.requested_by_user_id === user.userId;
          const isApprover = isAllowedApprover(action.risk_level, user.role);
          if (!isRequester && !isApprover) {
            return forbiddenResponse(
              c,
              "Not authorized to reject this approval.",
            );
          }

          const rejected = await rejectAction(
            action.action_code,
            { userId: user.userId, email: user.email, name: user.name },
            reason,
          );
          if (!rejected) {
            return c.json(
              { error: "Could not reject — state may have changed." },
              409,
            );
          }

          await logEvent({
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            actionType: "AI_ACTION",
            entityType: "SYSTEM",
            entityId: rejected.action_code,
            entityName: rejected.tool_label,
            description: `Rejected AI action ${rejected.action_code}: ${rejected.rejection_reason}`,
            aiInvolved: true,
            severity: "INFO",
            module: "ai-governance",
            correlationId: rejected.action_code,
          }).catch(() => {
            /* non-fatal */
          });

          return c.json({ success: true, action: rejected });
        } catch (error: any) {
          logger.error("[AI-Approval] reject error:", error);
          // Same redaction guarantee as the approve handler: a thrown
          // error message can carry a credential-shaped substring (e.g.
          // a DB connection string or a key embedded in a third-party
          // error message). Scrub it before echoing back to the browser.
          const safeDetails =
            typeof error?.message === "string"
              ? (redactSecretLikeStrings(error.message) as string)
              : undefined;
          return c.json(
            { error: "Failed to reject", details: safeDetails },
            500,
          );
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /ai-approvals — admin dashboard HTML page                        */
  /* -------------------------------------------------------------------- */
  {
    path: "/ai-approvals",
    method: "GET" as const,
    createHandler: async () => {
      const { join } = await import("path");
      const { readFileSync, existsSync } = await import("fs");
      return async (c: any) => {
        const candidates = [
          join(process.cwd(), "dashboard", "ai-approvals.html"),
          "/home/runner/workspace/dashboard/ai-approvals.html",
        ];
        for (const p of candidates) {
          if (existsSync(p)) return c.html(readFileSync(p, "utf-8"));
        }
        return c.text("AI Approvals dashboard not found", 404);
      };
    },
  },
];

export const aiApprovalRoutes = _aiApprovalRoutesRaw
  .map(aiApprovalGate)
  .map(gateApiRoute);
