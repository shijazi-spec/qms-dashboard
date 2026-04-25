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
  type ApprovalStatus,
  type RiskLevel,
} from '../../utils/aiApprovalDatabase';
import {
  executeApprovedAction,
  isToolGated,
} from '../../utils/withApprovalGate';
import {
  isAllowedApprover,
  getApproverRolesFor,
  getPolicy,
} from '../../utils/aiToolGovernance';
import { resolveControlledDocuments } from '../../utils/controlledDocumentRegistry';
import { getSessionUser, unauthorizedResponse, forbiddenResponse } from '../../utils/rbacMiddleware';
import {
  logEvent,
  redactSensitiveDeep,
  redactSecretLikeStrings,
} from '../../utils/eventLogsDatabase';

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
    const { initPolicyTables } = await import('../../utils/policyDatabase');
    const { seedControlledDocumentRegistry } = await import('../../utils/controlledDocumentRegistry');
    await initPolicyTables();
    await seedControlledDocumentRegistry();
    await initAIApprovalTable();
    tableReady = true;
    console.log('[AI-Approval] Bootstrap complete (policies + ai_pending_actions + controlled-doc seed)');
  } catch (err) {
    console.error('[AI-Approval] Bootstrap failed:', err);
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
  return role === 'admin' || role === 'quality_manager';
}

export const aiApprovalRoutes = [
  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals                                                */
  /* -------------------------------------------------------------------- */
  {
    path: '/api/ai/approvals',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const statusParam = url.searchParams.get('status');
          const riskLevel = url.searchParams.get('risk_level') as RiskLevel | null;
          const mine = url.searchParams.get('mine') === 'true';
          const limit = parseInt(url.searchParams.get('limit') || '50', 10);
          const offset = parseInt(url.searchParams.get('offset') || '0', 10);

          const status = statusParam
            ? (statusParam.split(',').map(s => s.trim()) as ApprovalStatus[])
            : (['pending'] as ApprovalStatus[]);

          // Non-privileged users can only see their own rows. Privileged users
          // ("admin", "quality_manager") see everything unless mine=true.
          const requestedByUserId = (canSeeAll(user.role) && !mine) ? undefined : user.userId;

          const { rows, total } = await listPendingActions({
            status,
            riskLevel: riskLevel || undefined,
            requestedByUserId,
            limit,
            offset,
          });

          return c.json({ success: true, total, rows });
        } catch (error: any) {
          console.error('[AI-Approval] list error:', error);
          return c.json({ error: 'Failed to list approvals', details: error.message }, 500);
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/pending-count                                  */
  /* -------------------------------------------------------------------- */
  {
    path: '/api/ai/approvals/pending-count',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          // Pass 0 for privileged users -> unfiltered; otherwise scope to own
          const targetUserId = canSeeAll(user.role) ? 0 : user.userId;
          const n = await countPendingForUser(targetUserId);
          return c.json({ success: true, count: n });
        } catch (error: any) {
          console.error('[AI-Approval] count error:', error);
          return c.json({ error: 'Failed to fetch count', details: error.message }, 500);
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /api/ai/approvals/:code                                          */
  /* -------------------------------------------------------------------- */
  {
    path: '/api/ai/approvals/:code',
    method: 'GET' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const code = c.req.param('code');
          const action = await getPendingActionByCode(code);
          if (!action) return c.json({ error: 'Approval action not found' }, 404);

          // Authorization: requester OR privileged role can view.
          const isRequester = action.requested_by_user_id === user.userId;
          if (!isRequester && !canSeeAll(user.role)) {
            return forbiddenResponse(c, 'Not authorized to view this approval');
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
            const statusLabel = action.status === 'pending' ? 'pending' : action.status;
            await logEvent({
              userId: user.userId,
              userEmail: user.email,
              userRole: user.role,
              actionType: 'AI_ACTION',
              entityType: 'SYSTEM',
              entityId: action.action_code,
              entityName: action.tool_label,
              description: `Viewed ${statusLabel} AI action ${action.action_code} (${action.tool_label})`,
              aiInvolved: true,
              severity: 'INFO',
              module: 'ai-governance',
              correlationId: action.action_code,
            }).catch(err => {
              console.error('[AI-Approval] view-audit logEvent failed (non-fatal):', err);
            });
          }

          // Enrich compliance_refs with clickable links to the controlled documents.
          const wpCodes = extractWpCodes(action.compliance_refs || []);
          const docLinks = await resolveControlledDocuments(wpCodes);

          // Indicate to the UI whether the current user is ALLOWED to approve
          // (role matches) AND is NOT the requester (segregation of duties).
          const canApprove =
            isAllowedApprover(action.risk_level, user.role) &&
            action.requested_by_user_id !== user.userId;
          const canApproveReason = !isAllowedApprover(action.risk_level, user.role)
            ? `Your role (${user.role}) is not in the approver list for ${action.risk_level} risk. Required: ${getApproverRolesFor(action.risk_level).join(', ')}.`
            : action.requested_by_user_id === user.userId
              ? 'You cannot approve your own AI proposal (WP-DOC-005 Segregation of Duties).'
              : null;

          return c.json({
            success: true,
            action,
            compliance_doc_links: docLinks,
            can_approve: canApprove,
            can_approve_blocker: canApproveReason,
            approver_roles: getApproverRolesFor(action.risk_level),
          });
        } catch (error: any) {
          console.error('[AI-Approval] detail error:', error);
          return c.json({ error: 'Failed to fetch approval', details: error.message }, 500);
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* POST /api/ai/approvals/:code/approve                                 */
  /* -------------------------------------------------------------------- */
  {
    path: '/api/ai/approvals/:code/approve',
    method: 'POST' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const code = c.req.param('code');
          const action = await getPendingActionByCode(code);
          if (!action) return c.json({ error: 'Approval action not found' }, 404);
          if (action.status !== 'pending') {
            return c.json({ error: `Action is ${action.status}, cannot approve` }, 409);
          }

          // Role gate
          if (!isAllowedApprover(action.risk_level, user.role)) {
            return forbiddenResponse(
              c,
              `Role "${user.role}" is not permitted to approve ${action.risk_level}-risk AI actions. ` +
              `Required roles: ${getApproverRolesFor(action.risk_level).join(', ')}.`
            );
          }

          // Segregation of duties (WP-DOC-005). Admins are exempt as break-glass.
          if (
            user.role !== 'admin' &&
            action.requested_by_user_id != null &&
            action.requested_by_user_id === user.userId
          ) {
            return forbiddenResponse(
              c,
              'Segregation of duties: you cannot approve your own AI proposal. See WP-DOC-005.'
            );
          }

          // Defense in depth: confirm the tool is actually registered as gated.
          if (!isToolGated(action.tool_id)) {
            return c.json({
              error: `Tool "${action.tool_id}" is no longer registered as gated. Approval blocked.`,
            }, 409);
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
            return c.json({
              error: 'Could not claim approval — it may have been handled by another reviewer or expired.',
              currentStatus: current?.status,
            }, 409);
          }

          await logEvent({
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            actionType: 'AI_ACTION',
            entityType: 'SYSTEM',
            entityId: claimed.action_code,
            entityName: claimed.tool_label,
            description: `Approved AI action ${claimed.action_code} (${claimed.tool_label})`,
            aiInvolved: true,
            severity: claimed.risk_level === 'critical' || claimed.risk_level === 'high' ? 'WARNING' : 'INFO',
            module: 'ai-governance',
            correlationId: claimed.action_code,
          }).catch(() => { /* non-fatal */ });

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
            typeof outcome.error === 'string'
              ? (redactSecretLikeStrings(outcome.error) as string)
              : outcome.error;

          // Return everything the UI needs to update the inline chat card.
          return c.json({
            success: outcome.ok,
            actionCode: claimed.action_code,
            entityType: outcome.entityType,
            entityId: outcome.entityId,
            result: safeResult,
            error: safeError,
          }, outcome.ok ? 200 : 500);
        } catch (error: any) {
          console.error('[AI-Approval] approve error:', error);
          // Same redaction guarantee as the success path: a thrown error
          // message can carry the freshly-minted credential the failing
          // tool was trying to handle.
          const safeDetails =
            typeof error?.message === 'string'
              ? (redactSecretLikeStrings(error.message) as string)
              : undefined;
          return c.json({ error: 'Failed to approve', details: safeDetails }, 500);
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* POST /api/ai/approvals/:code/reject                                  */
  /* -------------------------------------------------------------------- */
  {
    path: '/api/ai/approvals/:code/reject',
    method: 'POST' as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureTable();
          const user = getSessionUser(c);
          if (!user) return unauthorizedResponse(c);

          const code = c.req.param('code');
          const body = await c.req.json().catch(() => ({}));
          const reason = (body?.reason || '').toString().trim();
          if (!reason || reason.length < 3) {
            return c.json({ error: 'A rejection reason (>=3 chars) is required for audit purposes.' }, 400);
          }

          const action = await getPendingActionByCode(code);
          if (!action) return c.json({ error: 'Approval action not found' }, 404);
          if (action.status !== 'pending') {
            return c.json({ error: `Action is ${action.status}, cannot reject` }, 409);
          }

          // Requester may reject their own draft (cancel); approvers may reject any.
          const isRequester = action.requested_by_user_id === user.userId;
          const isApprover = isAllowedApprover(action.risk_level, user.role);
          if (!isRequester && !isApprover) {
            return forbiddenResponse(c, 'Not authorized to reject this approval.');
          }

          const rejected = await rejectAction(
            action.action_code,
            { userId: user.userId, email: user.email, name: user.name },
            reason
          );
          if (!rejected) {
            return c.json({ error: 'Could not reject — state may have changed.' }, 409);
          }

          await logEvent({
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            actionType: 'AI_ACTION',
            entityType: 'SYSTEM',
            entityId: rejected.action_code,
            entityName: rejected.tool_label,
            description: `Rejected AI action ${rejected.action_code}: ${rejected.rejection_reason}`,
            aiInvolved: true,
            severity: 'INFO',
            module: 'ai-governance',
            correlationId: rejected.action_code,
          }).catch(() => { /* non-fatal */ });

          return c.json({ success: true, action: rejected });
        } catch (error: any) {
          console.error('[AI-Approval] reject error:', error);
          return c.json({ error: 'Failed to reject', details: error.message }, 500);
        }
      };
    },
  },

  /* -------------------------------------------------------------------- */
  /* GET /ai-approvals — admin dashboard HTML page                        */
  /* -------------------------------------------------------------------- */
  {
    path: '/ai-approvals',
    method: 'GET' as const,
    createHandler: async () => {
      const { join } = await import('path');
      const { readFileSync, existsSync } = await import('fs');
      return async (c: any) => {
        const candidates = [
          join(process.cwd(), 'dashboard', 'ai-approvals.html'),
          '/home/runner/workspace/dashboard/ai-approvals.html',
        ];
        for (const p of candidates) {
          if (existsSync(p)) return c.html(readFileSync(p, 'utf-8'));
        }
        return c.text('AI Approvals dashboard not found', 404);
      };
    },
  },
];
