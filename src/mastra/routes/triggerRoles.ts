import type { UserRole } from "../../utils/rbacMiddleware";

/**
 * Role sets for the audit-trigger notification feed.
 *
 * These live in their own module because notificationRoutes.ts needs them to
 * total the bell badge across both notification feeds, and importing them from
 * triggerRoutes.ts would create a route-module import cycle.
 */

/** May see and clear EVERY role's audit notifications, not just their own. */
export const TRIGGER_ADMIN_ROLES = new Set<string>([
  "admin",
  "head_of_operations_quality",
]);

/** Roles permitted to participate in trigger review workflows. */
export const TRIGGER_REVIEWER_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "auditor",
  "team_lead",
  "executive",
  "bu_owner",
  "ai_specialist",
];
