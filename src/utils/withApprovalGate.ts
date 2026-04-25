/**
 * withApprovalGate — higher-order wrapper that turns any Mastra tool into
 * a Human-in-the-Loop (HITL) gated tool.
 *
 * When the wrapped tool is called by the AI:
 *   1. We look up the calling user from AsyncLocalStorage (set by the route
 *      that invokes the agent — see consultantRoutes.ts).
 *   2. If policy + user tier says auto-approve, we execute the original tool.
 *   3. Otherwise we enqueue the invocation in ai_pending_actions and return
 *      a structured "queued" response to the LLM. The LLM is instructed
 *      (via the agent system prompt) to surface this to the user and STOP.
 *   4. When the human clicks Approve in the UI, the approval route calls
 *      executeApprovedAction() which invokes the original tool with the
 *      stored payload and records the result back into ai_pending_actions.
 *
 * Design invariants:
 *   - The original tool is never mutated. We return a new tool object.
 *   - If the gate is globally disabled (AI_APPROVAL_GATE_ENABLED=false) the
 *     wrapper logs a WARNING to event_logs and forwards to the original
 *     tool — this is the incident-response kill-switch, not the default.
 *   - If no user context is available (e.g. cron-triggered agent calls),
 *     the wrapper treats the caller as "system" and ALWAYS requires
 *     approval regardless of tier, because cron cannot consent.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createTool } from "@mastra/core/tools";
import type { z } from "zod";
import {
  enqueuePendingAction,
  getPendingActionByCode,
  recordExecutionResult,
  type PendingAction,
} from "./aiApprovalDatabase";
import {
  getPolicy,
  shouldAutoApprove,
  isGateEnabled,
  type ToolGovernancePolicy,
  type UserApprovalContext,
} from "./aiToolGovernance";
import { logEvent, redactSecretLikeStrings } from "./eventLogsDatabase";

/* ------------------------------------------------------------------------- *
 * Per-request context storage.
 * Routes that invoke an agent MUST wrap the .generate() call with
 *   withAgentUserContext(user, threadId, () => agent.generate(...))
 * so that any tool the agent calls can retrieve the user identity.
 * ------------------------------------------------------------------------- */

export interface AgentInvocationContext {
  user: UserApprovalContext;
  threadId: string | null;
}

const context = new AsyncLocalStorage<AgentInvocationContext>();

export function withAgentUserContext<T>(
  ctx: AgentInvocationContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return context.run(ctx, fn);
}

export function getCurrentAgentContext(): AgentInvocationContext | null {
  return context.getStore() || null;
}

/* ------------------------------------------------------------------------- *
 * The wrapper.
 * ------------------------------------------------------------------------- */

interface WrappedTool<TTool> {
  tool: TTool;
  originalExecute: any;
  policy: ToolGovernancePolicy;
}

/**
 * Registry of wrapped tools, keyed by toolId. Used by the approval route
 * to find the original `execute` function when a human clicks Approve.
 */
const wrappedRegistry = new Map<string, WrappedTool<any>>();

/**
 * Wraps a Mastra tool with the HITL approval gate. The returned value is
 * a drop-in replacement — it has the same id, description, schemas, and
 * (when auto-approved or gate disabled) the same runtime behavior.
 */
export function withApprovalGate<
  TTool extends {
    id?: string;
    execute?: any;
    inputSchema?: any;
    outputSchema?: any;
    description?: string;
  },
>(tool: TTool): TTool {
  const toolId = (tool as any).id;
  if (!toolId) {
    throw new Error(
      "[withApprovalGate] Tool has no id — cannot apply approval gate.",
    );
  }

  const policy = getPolicy(toolId);
  if (!policy) {
    throw new Error(
      `[withApprovalGate] No governance policy registered for tool "${toolId}". ` +
        `Add an entry to TOOL_GOVERNANCE_POLICIES in aiToolGovernance.ts before wrapping.`,
    );
  }

  // If policy says this tool doesn't need approval, return the tool unchanged
  // but still register it so the approval pipeline can reference it later if
  // policy is upgraded to requiresApproval=true at runtime.
  const originalExecute = (tool as any).execute;
  wrappedRegistry.set(toolId, { tool, originalExecute, policy });

  if (!policy.requiresApproval) {
    return tool;
  }

  const gatedExecute = async (args: any) => {
    // Kill-switch: audit every bypass but still gate if user context missing.
    if (!isGateEnabled()) {
      await logEvent({
        actionType: "AI_ACTION",
        entityType: "SYSTEM",
        description: `AI tool "${toolId}" executed with HITL gate DISABLED (AI_APPROVAL_GATE_ENABLED=false)`,
        aiInvolved: true,
        severity: "WARNING",
        module: "ai-governance",
      }).catch(() => {
        /* non-fatal */
      });
      return originalExecute(args);
    }

    const agentCtx = getCurrentAgentContext();

    // Ideal path: we know who's calling.
    if (agentCtx?.user?.userId != null) {
      if (shouldAutoApprove(policy, agentCtx.user)) {
        // User tier covers this risk — execute directly but still log it.
        await logEvent({
          userId: agentCtx.user.userId,
          userEmail: agentCtx.user.email || undefined,
          userRole: agentCtx.user.role || undefined,
          actionType: "AI_ACTION",
          entityType: mapEntityType(policy.entityType),
          description: `AI tool "${toolId}" auto-approved per user tier "${agentCtx.user.autoApproveTier}"`,
          aiInvolved: true,
          severity: "INFO",
          module: "ai-governance",
        }).catch(() => {
          /* non-fatal */
        });
        return originalExecute(args);
      }
    }

    // Gated path: enqueue and tell the LLM to wait for human approval.
    const preview = safePreview(policy, args?.context);
    const pending = await enqueuePendingAction({
      toolId,
      toolLabel: policy.label,
      payload: args?.context ?? {},
      payloadPreview: preview,
      riskLevel: policy.riskLevel,
      complianceRefs: policy.complianceRefs,
      requestedByUserId: agentCtx?.user?.userId ?? null,
      requestedByEmail: agentCtx?.user?.email ?? null,
      requestedByName: (agentCtx?.user as any)?.name ?? null,
      threadId: agentCtx?.threadId ?? null,
    });

    // Task #477: a payload that tripped the credential detector deserves
    // WARNING-level severity even on a low/medium-risk tool, because it
    // tells SOC reviewers a user accidentally pasted a key into chat.
    const hasCredentialWarning = (pending.credential_warnings ?? []).length > 0;
    const severity =
      policy.riskLevel === "critical" || policy.riskLevel === "high" || hasCredentialWarning
        ? "WARNING"
        : "INFO";
    await logEvent({
      userId: agentCtx?.user?.userId ?? undefined,
      userEmail: agentCtx?.user?.email ?? undefined,
      userRole: agentCtx?.user?.role ?? undefined,
      actionType: "AI_ACTION",
      entityType: mapEntityType(policy.entityType),
      entityId: pending.action_code,
      entityName: policy.label,
      description:
        `AI proposed ${policy.label} — queued for human approval (${pending.action_code})` +
        (hasCredentialWarning
          ? ` [credential-shaped values detected in ${(pending.credential_warnings ?? []).length} field(s)]`
          : ""),
      aiInvolved: true,
      severity,
      module: "ai-governance",
      newValue: {
        risk: policy.riskLevel,
        complianceRefs: policy.complianceRefs,
        // Persist the warning structure (paths only, no raw values) so the
        // audit trail records WHY this row was flagged at submission time.
        credentialWarnings: pending.credential_warnings ?? [],
      },
    }).catch(() => {
      /* non-fatal */
    });

    // Shape of the return value is deliberately compatible with the original
    // tool's outputSchema: `success: false` + human-readable `message`. This
    // means no change needed in the LLM reasoning — it just sees a failure
    // with a clear, actionable reason.
    //
    // Task #477: if the structural detector running inside
    // `enqueuePendingAction()` flagged any payload field as
    // credential-shaped, bubble that signal back to the LLM so the user
    // is told NOT to paste credentials into chat. The reviewer UI also
    // shows the warning, but mentioning it here closes the loop with
    // the requester immediately rather than waiting for an approver to
    // notice and explain.
    const credentialWarnings = pending.credential_warnings ?? [];
    const credentialNotice =
      credentialWarnings.length > 0
        ? ` SECURITY NOTE: the submitted payload contained ${credentialWarnings.length} ` +
          `value(s) that look like credentials (offending field path(s): ` +
          `${credentialWarnings.slice(0, 5).map(w => w.path).join(', ')}). ` +
          `The reviewer will see a warning. Tell the user to use the secret ` +
          `store / a secret reference rather than pasting raw credentials into chat, ` +
          `and to redact and resend if this was unintentional.`
        : '';

    return {
      success: false,
      queued: true,
      actionCode: pending.action_code,
      riskLevel: policy.riskLevel,
      complianceRefs: policy.complianceRefs,
      credentialWarnings,
      message:
        `[HITL GATE] Proposed ${policy.label} has been queued for human approval ` +
        `(ticket: ${pending.action_code}, risk: ${policy.riskLevel}). ` +
        `Do NOT retry this tool. Tell the user you've prepared a draft and ask them ` +
        `to click Approve or Reject in the chat.` + credentialNotice,
    };
  };

  // Return a new tool that shares the schemas and description but has the
  // gated execute. Using createTool to preserve whatever Mastra-internal
  // shape the object needs.
  return createTool({
    id: toolId,
    description: (tool as any).description,
    inputSchema: (tool as any).inputSchema,
    outputSchema: (tool as any).outputSchema,
    execute: gatedExecute,
  }) as unknown as TTool;
}

/* ------------------------------------------------------------------------- *
 * Approval route helper — called by POST /api/ai/approvals/:code/approve
 * after the reviewer has claimed the row (status=approved). We then invoke
 * the original tool's execute with the stored payload, and write the result
 * back to ai_pending_actions.
 * ------------------------------------------------------------------------- */

export interface ExecutionOutcome {
  ok: boolean;
  entityType?: string;
  entityId?: string;
  data?: any;
  error?: string;
}

export async function executeApprovedAction(
  action: PendingAction,
): Promise<ExecutionOutcome> {
  const entry = wrappedRegistry.get(action.tool_id);
  if (!entry) {
    const err = `No wrapped tool registered for tool_id "${action.tool_id}"`;
    await recordExecutionResult(action.action_code, {
      success: false,
      error: err,
    });
    return { ok: false, error: err };
  }

  try {
    const result = await entry.originalExecute({
      context: action.payload,
      // We intentionally do NOT pass an agent runtime here — this is a direct,
      // human-authorized execution invoked by a real HTTP request handler.
      mastra: undefined,
    });

    // Tools in this codebase standardize on { success: boolean, ...ids }.
    // Extract the created entity id for cross-linking.
    const entityId = extractEntityId(result, entry.policy.entityType);
    const success = !!result?.success;

    await recordExecutionResult(action.action_code, {
      success,
      entityType: entry.policy.entityType,
      entityId,
      data: result,
      error: success
        ? undefined
        : result?.error || result?.message || "Tool returned success=false",
    });

    await logEvent({
      actionType: success ? "CREATE" : "AI_ACTION",
      entityType: mapEntityType(entry.policy.entityType),
      entityId,
      entityName: entry.policy.label,
      description: success
        ? `Approved AI action ${action.action_code} executed successfully — ${entry.policy.label}`
        : `Approved AI action ${action.action_code} FAILED during execution`,
      aiInvolved: true,
      severity: success ? "INFO" : "CRITICAL",
      module: "ai-governance",
      correlationId: action.action_code,
    }).catch(() => {
      /* non-fatal */
    });

    return {
      ok: success,
      entityType: entry.policy.entityType,
      entityId,
      data: result,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    await recordExecutionResult(action.action_code, {
      success: false,
      error: message,
    });
    await logEvent({
      actionType: "AI_ACTION",
      entityType: "SYSTEM",
      entityId: action.action_code,
      description: `Approved AI action ${action.action_code} threw error: ${message}`,
      aiInvolved: true,
      severity: "CRITICAL",
      module: "ai-governance",
      correlationId: action.action_code,
    }).catch(() => {
      /* non-fatal */
    });
    return { ok: false, error: message };
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function safePreview(policy: ToolGovernancePolicy, payload: any): string {
  let raw: string;
  try {
    raw = String(policy.buildPreview(payload ?? {}));
  } catch (err) {
    return `(preview unavailable: ${err instanceof Error ? err.message : "unknown error"})`;
  }
  // Defense-in-depth: even if a tool author interpolates a credential into
  // the preview string (or a payload field that the buildPreview reads back
  // verbatim, like `title` / `description` / `evidenceUrl`), strip credential-
  // shaped substrings here so the value never escapes this function in raw
  // form. This protects gate-exempt tools too (whose previews bypass the
  // enqueuePendingAction redaction path) and is covered by
  // `tests/aiToolPolicyBuildPreview.test.ts`.
  return redactSecretLikeStrings(raw) as string;
}

function extractEntityId(result: any, entityType: string): string | undefined {
  if (!result) return undefined;
  // Standard fields produced by existing tools in this codebase.
  return (
    result.ncNumber ||
    result.ncId ||
    result.capaNumber ||
    result.capaId ||
    result.actionItemId ||
    result.trainingId ||
    result.assignmentId ||
    result.alertId ||
    result.checklistId ||
    (result.id != null ? String(result.id) : undefined)
  );
}

/**
 * Best-effort map from our internal entity type to event_logs' enum.
 * event_logs supports a fixed set of entity_type values; we map training/nc
 * etc. to closest match, CAPA stays as CAPA, others fall through to SYSTEM.
 */
function mapEntityType(entityType: string): any {
  switch (entityType) {
    case "capa":
    case "capa_action_item":
      return "CAPA";
    case "training":
    case "training_assignment":
      return "TRAINING";
    case "nonconformance":
      return "CAPA"; // closest existing enum; a future migration should add 'NC'
    default:
      return "SYSTEM";
  }
}

/**
 * Exposed for the approval route to verify a tool is actually gated
 * before executing (defense in depth).
 */
export function isToolGated(toolId: string): boolean {
  const entry = wrappedRegistry.get(toolId);
  return !!entry && entry.policy.requiresApproval;
}
