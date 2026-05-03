import * as userDb from "../../utils/userAccessDatabase";
import { sendResendEmail } from "../../utils/resendMail";
import { logger as safeLogger } from "../../utils/logger";
import {
  requireAdminOrKey,
  requireAuthOrKey,
  getSessionUser,
  requireRole,
  unauthorizedResponse,
  forbiddenResponse,
  type SessionUser,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

async function verifyAdminKey(c: any): Promise<SessionUser | null> {
  return requireAdminOrKey(c);
}

async function verifyAdminOrQualityManager(
  c: any,
): Promise<SessionUser | null> {
  const byKey = await requireAdminOrKey(c);
  if (byKey) return byKey;
  return await requireRole(c, ["admin", "quality_manager"] as UserRole[]);
}

export const userAccessRoutes = [
  {
    path: "/api/users/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          await userDb.initUserAccessTables();
          logger?.info("📊 [UserAccess] GET /api/users/stats");
          const stats = await userDb.getUserStats();
          return c.json({ success: true, ...stats });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const caller = await verifyAdminOrQualityManager(c);
          if (!caller) {
            return c.json({ error: "Insufficient permissions" }, 403);
          }
          const logger = mastra?.getLogger();
          await userDb.initUserAccessTables();
          const url = new URL(c.req.url);
          const status = url.searchParams.get("status");

          logger?.info("👤 [UserAccess] GET /api/users", {
            status,
            by: caller.email,
          });

          let users;
          if (status === "pending") {
            users = await userDb.getPendingApprovals();
          } else if (status === "active") {
            users = await userDb.getActiveUsers();
          } else {
            users = await userDb.getAllUsers();
          }

          const isAdmin = caller.role === "admin";
          const PII_FIELDS = [
            "password_hash",
            "mfa_secret",
            "google_id",
            "invitation_id",
            "access_reason",
            "denied_by",
            "denial_reason",
          ];
          const filtered = users.map((u: any) => {
            const copy = { ...u };
            if (!isAdmin) {
              for (const f of PII_FIELDS) delete copy[f];
            } else {
              delete copy.password_hash;
              delete copy.mfa_secret;
            }
            return copy;
          });
          return c.json({
            success: true,
            users: filtered,
            count: filtered.length,
          });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id",
    method: "PATCH" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return c.json({ error: "Authentication required" }, 401);
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          const patch: { full_name?: string; team?: string; role?: any } = {};
          if (typeof body.full_name === "string")
            patch.full_name = body.full_name.trim();
          if (typeof body.team === "string") patch.team = body.team.trim();
          if (typeof body.role === "string") patch.role = body.role;

          if (Object.keys(patch).length === 0) {
            return c.json({ error: "Nothing to update" }, 400);
          }

          logger?.info("✏️ [UserAccess] PATCH /api/users/:id", {
            id,
            fields: Object.keys(patch),
          });

          const user = await userDb.updateUserProfile(
            id,
            patch,
            admin.email || "unknown",
          );
          if (!user) return c.json({ error: "User not found" }, 404);
          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return c.json({ error: "Authentication required" }, 401);
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));

          const confirmHeader = c.req.header("x-confirm-delete");
          if (confirmHeader !== "true") {
            return c.json(
              {
                error:
                  "Hard delete requires 'x-confirm-delete: true' header.",
              },
              400,
            );
          }

          if (admin.id === id) {
            return c.json(
              { error: "You cannot delete your own account." },
              400,
            );
          }

          logger?.info("🗑️ [UserAccess] DELETE /api/users/:id", { id });
          const result = await userDb.deleteUser(
            id,
            admin.email || "unknown",
          );
          if (!result.deleted) return c.json({ error: "User not found" }, 404);
          return c.json({ success: true, deleted_email: result.email });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("👤 [UserAccess] GET /api/users/:id", { id });

          const user = await userDb.getUserById(id);
          if (!user) return c.json({ error: "User not found" }, 404);

          const [permissions, dataScope] = await Promise.all([
            userDb.getUserPermissions(id),
            userDb.getUserDataScope(id),
          ]);

          return c.json({ success: true, user, permissions, dataScope });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/invitations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          await userDb.initUserAccessTables();
          logger?.info("📧 [UserAccess] GET /api/invitations");
          const invitations = await userDb.getInvitations();
          const masked = invitations.map((inv: any) => ({
            ...inv,
            token: inv.token ? `${inv.token.substring(0, 8)}...` : undefined,
          }));
          return c.json({
            success: true,
            invitations: masked,
            count: masked.length,
          });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/invitations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const sessionUser = await verifyAdminOrQualityManager(c);
          if (!sessionUser) {
            return c.json(
              { error: "Admin or Quality Manager access required" },
              403,
            );
          }
          const logger = mastra?.getLogger();
          await userDb.initUserAccessTables();
          const body = await c.req.json();

          logger?.info("📧 [UserAccess] POST /api/invitations", {
            email: body.email,
            invitedBy: sessionUser.email,
          });

          if (!body.email || !body.team || !body.role) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const existingUser = await userDb.getUserByEmail(body.email);
          if (existingUser) {
            return c.json({ error: "Unable to process this request" }, 400);
          }

          const existingInvitations = await userDb.getInvitations();
          const pendingInvite = existingInvitations.find(
            (inv: any) =>
              inv.email === body.email &&
              !inv.used &&
              new Date(inv.token_expires_at) > new Date(),
          );
          if (pendingInvite) {
            return c.json(
              {
                error:
                  "A pending invitation already exists for this email address",
              },
              409,
            );
          }

          const expiryDays = body.expiry_days || 7;
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + expiryDays);

          const invitation = await userDb.createInvitation({
            email: body.email,
            full_name: body.full_name,
            team: body.team,
            role: body.role,
            token_expires_at: expiresAt,
            require_mfa: body.require_mfa || false,
            invited_by: sessionUser.email,
            used: false,
          });

          const domain = process.env.REPLIT_DEV_DOMAIN
            ? `https://${process.env.REPLIT_DEV_DOMAIN}`
            : "https://walaplus.com";
          const inviteLink = `${domain}/accept-invite?token=${invitation.token}`;

          let emailStatus = { sent: false, error: "" };
          try {
            const emailResult = await sendResendEmail({
              to: body.email,
              subject: "You are invited to WalaPlus QMS Platform",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <div style="background: linear-gradient(135deg, #1E3A8A 0%, #2563EB 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin: 0;">Welcome to WalaPlus</h1>
                    <p style="margin: 10px 0 0; opacity: 0.9;">Quality Management System</p>
                  </div>
                  <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                    <p>Hello${body.full_name ? " " + body.full_name : ""},</p>
                    <p>You have been invited to join the WalaPlus QMS Platform as a <strong>${body.role}</strong> in the <strong>${body.team}</strong> team.</p>
                    <p style="margin: 20px 0;">
                      <a href="${inviteLink}" style="background: #2563EB; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                        Accept Invitation
                      </a>
                    </p>
                    <p style="color: #666; font-size: 14px;">This invitation expires in ${expiryDays} days.</p>
                    <p style="color: #666; font-size: 14px;">If you did not expect this invitation, please ignore this email.</p>
                  </div>
                </div>
              `,
              text: `You have been invited to WalaPlus QMS Platform as a ${body.role}. Accept your invitation here: ${inviteLink}`,
            });

            if (emailResult.success) {
              emailStatus.sent = true;
              logger?.info(
                "✅ [UserAccess] Invitation email sent to",
                body.email,
              );
            } else {
              emailStatus.error = emailResult.error || "Email sending failed";
              logger?.warn(
                "⚠️ [UserAccess] Could not send invitation email:",
                emailResult.error,
              );
            }
          } catch (emailError: any) {
            emailStatus.error = emailError.message || "Email sending failed";
            logger?.warn(
              "⚠️ [UserAccess] Could not send invitation email:",
              emailError,
            );
          }

          const maskedInvitation = {
            ...invitation,
            token: invitation.token
              ? `${invitation.token.substring(0, 8)}...`
              : undefined,
          };
          return c.json(
            {
              success: true,
              invitation: maskedInvitation,
              email_sent: emailStatus.sent,
              message: emailStatus.sent
                ? `Invitation created and email sent to ${body.email}`
                : `Invitation created but email could not be sent. The invite link has been generated for manual sharing.`,
            },
            201,
          );
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error creating invitation", {
            error,
          });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // INTENTIONALLY PUBLIC: invitees follow the email link before they have an
  // account/session. The opaque, single-use invitation token is itself the
  // authentication credential — see PUBLIC_PATHS in src/mastra/middleware
  // and the matching skip in tests/userAccessRoutes.test.ts.
  {
    path: "/api/invitations/validate/:token",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const token = c.req.param("token");
          logger?.info("🔑 [UserAccess] Validating invitation token");

          const invitation = await userDb.validateInvitationToken(token);
          if (!invitation) {
            return c.json(
              { valid: false, error: "Invalid or expired invitation" },
              400,
            );
          }

          return c.json({
            valid: true,
            invitation: {
              email: invitation.email,
              full_name: invitation.full_name,
              team: invitation.team,
              role: invitation.role,
            },
          });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/invitations/accept",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();

          if (!body.token) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          if (!body.password || typeof body.password !== "string") {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const { validatePassword } =
            await import("../../utils/inputSanitizer");
          const passwordError = validatePassword(body.password);
          if (passwordError) {
            return c.json({ error: passwordError }, 400);
          }

          const bcrypt = await import("bcryptjs");
          const passwordHash = await bcrypt.hash(body.password, 12);

          logger?.info("✅ [UserAccess] Accepting invitation");

          const user = await userDb.acceptInvitation(body.token, {
            full_name: body.full_name,
            password_hash: passwordHash,
            access_reason: body.access_reason,
          });

          if (!user) {
            return c.json({ error: "Invalid or expired invitation" }, 400);
          }

          return c.json({
            success: true,
            message:
              "Access request submitted. Please wait for admin approval.",
            user: { id: user.id, email: user.email, status: user.status },
          });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error accepting invitation", {
            error,
          });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/approve",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("✅ [UserAccess] Approving user", { id });

          const approver = await verifyAdminKey(c);
          const user = await userDb.approveAccessRequest(
            id,
            approver?.email || "unknown",
            body.permission_overrides,
          );

          if (!user) {
            return c.json(
              { error: "User not found or not pending approval" },
              404,
            );
          }

          try {
            await sendResendEmail({
              to: user.email,
              subject: "Your WalaPlus Access Has Been Approved",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <div style="background: linear-gradient(135deg, #047857 0%, #22C55E 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin: 0;">Access Approved</h1>
                  </div>
                  <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                    <p>Hello ${user.full_name},</p>
                    <p>Your access to the WalaPlus QMS Platform has been approved. You can now log in and start using the platform.</p>
                    <p style="margin: 20px 0;">
                      <a href="${process.env.REPLIT_DEV_DOMAIN ? "https://" + process.env.REPLIT_DEV_DOMAIN : "https://walaplus.com"}" style="background: #047857; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                        Go to Platform
                      </a>
                    </p>
                  </div>
                </div>
              `,
              text: `Your WalaPlus access has been approved. You can now log in at ${process.env.REPLIT_DEV_DOMAIN ? "https://" + process.env.REPLIT_DEV_DOMAIN : "https://walaplus.com"}`,
            });
          } catch (emailError) {
            logger?.warn("⚠️ Could not send approval email");
          }

          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error approving user", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/deny",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("❌ [UserAccess] Denying user", { id });

          const denier = await verifyAdminKey(c);
          const user = await userDb.denyAccessRequest(
            id,
            denier?.email || "unknown",
            body.reason,
          );

          if (!user) {
            return c.json(
              { error: "User not found or not pending approval" },
              404,
            );
          }

          try {
            await sendResendEmail({
              to: user.email,
              subject: "WalaPlus Access Request Update",
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <div style="background: #374151; color: white; padding: 30px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin: 0;">Access Request Update</h1>
                  </div>
                  <div style="background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px;">
                    <p>Hello ${user.full_name},</p>
                    <p>Your access request to the WalaPlus QMS Platform could not be approved at this time.</p>
                    <p>If you believe this is an error, please contact your administrator.</p>
                  </div>
                </div>
              `,
              text: `Your WalaPlus access request could not be approved at this time. Please contact your administrator.`,
            });
          } catch (emailError) {
            logger?.warn("⚠️ Could not send denial email");
          }

          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error denying user", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/disable",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("🚫 [UserAccess] Disabling user", { id });
          const disabler = await verifyAdminKey(c);
          const user = await userDb.disableUser(
            id,
            disabler?.email || "unknown",
          );

          if (!user) {
            return c.json({ error: "User not found" }, 404);
          }

          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/enable",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("✅ [UserAccess] Enabling user", { id });
          const enabler = await verifyAdminKey(c);
          const user = await userDb.enableUser(id, enabler?.email || "unknown");

          if (!user) {
            return c.json({ error: "User not found or not disabled" }, 404);
          }

          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/role",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          if (!body.role) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const VALID_ROLES = [
            "admin",
            "quality_manager",
            "grc_manager",
            "team_lead",
            "auditor",
            "quality_specialist",
            "department_viewer",
            "ai_specialist",
            "bu_owner",
            "executive",
          ];
          if (!VALID_ROLES.includes(body.role)) {
            return c.json({ error: "Invalid role specified" }, 400);
          }

          const adminUser = await verifyAdminKey(c);
          if (adminUser && adminUser.userId === id) {
            return c.json({ error: "Cannot change your own role" }, 403);
          }

          logger?.info("🔄 [UserAccess] Updating user role", {
            id,
            role: body.role,
            changedBy: adminUser?.email,
          });
          const user = await userDb.updateUserRole(
            id,
            body.role,
            adminUser?.email || "unknown",
          );

          if (!user) {
            return c.json({ error: "User not found" }, 404);
          }

          return c.json({ success: true, user });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/users/:id/permissions",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();

          if (!body.permissions || !Array.isArray(body.permissions)) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          logger?.info("🔐 [UserAccess] Updating user permissions", { id });
          const permAdmin = await verifyAdminKey(c);
          await userDb.updateUserPermissions(
            id,
            body.permissions,
            permAdmin?.email || "unknown",
          );

          const permissions = await userDb.getUserPermissions(id);
          return c.json({ success: true, permissions });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/access-audit",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          await userDb.initUserAccessTables();
          const url = new URL(c.req.url);
          const event_type = url.searchParams.get("event_type") || undefined;
          const target_email =
            url.searchParams.get("target_email") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "100");

          logger?.info("📋 [UserAccess] GET /api/access-audit");
          const logs = await userDb.getAccessAuditLog({
            event_type,
            target_email,
            limit,
          });
          return c.json({ success: true, logs, count: logs.length });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/screens",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          logger?.info("📺 [UserAccess] GET /api/screens");
          return c.json({ success: true, screens: userDb.SCREEN_LIST });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/roles/defaults",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }
          const logger = mastra?.getLogger();
          logger?.info("🔐 [UserAccess] GET /api/roles/defaults");
          return c.json({
            success: true,
            roles: userDb.DEFAULT_ROLE_PERMISSIONS,
          });
        } catch (error: any) {
          safeLogger.error("❌ [UserAccess] Error", { error });
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
];
