import crypto from "crypto";
import * as client from "openid-client";
import pg from "pg";
import { logger } from "../../utils/logger";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SESSION_COOKIE_NAME = "walaplus_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

let oidcConfig: client.Configuration | null = null;

async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!,
    );
  }
  return oidcConfig;
}

function getDomain(): string {
  return (
    process.env.REPLIT_DOMAINS?.split(",")[0] ||
    process.env.REPLIT_DEV_DOMAIN ||
    "localhost:5000"
  );
}

function getCallbackUrl(): string {
  const domain = getDomain();
  const protocol = domain.includes("localhost") ? "http" : "https";
  return `${protocol}://${domain}/api/callback`;
}

function isSecureDomain(): boolean {
  return !getDomain().includes("localhost");
}

function signSession(payload: Record<string, any>): string {
  const secret = process.env.SESSION_SECRET!;
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function verifySession(token: string): Record<string, any> | null {
  try {
    const secret = process.env.SESSION_SECRET!;
    const [data, sig] = token.split(".");
    if (!data || !sig) return null;
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(data)
      .digest("base64url");
    if (sig !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getSessionFromCookie(
  cookieHeader: string | undefined,
): Record<string, any> | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`),
  );
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

async function initAuthTables(): Promise<void> {
  await pool
    .query(
      `
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS picture TEXT;
    ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(50) DEFAULT 'local';
  `,
    )
    .catch(async () => {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        team VARCHAR(50) NOT NULL DEFAULT 'Other',
        role VARCHAR(50) NOT NULL DEFAULT 'department_viewer',
        status VARCHAR(30) DEFAULT 'active',
        password_hash VARCHAR(255),
        mfa_enabled BOOLEAN DEFAULT FALSE,
        mfa_secret VARCHAR(255),
        invitation_id INTEGER,
        access_reason TEXT,
        approved_by VARCHAR(255),
        approved_at TIMESTAMP,
        denied_by VARCHAR(255),
        denied_at TIMESTAMP,
        denial_reason TEXT,
        last_login_at TIMESTAMP,
        login_count INTEGER DEFAULT 0,
        google_id VARCHAR(255),
        picture TEXT,
        auth_provider VARCHAR(50) DEFAULT 'local',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    });
}

/**
 * Upsert a platform_users row from an OIDC profile callback.
 *
 * Exported so the secret-leak gate test (`./authRoutes.test.ts`) can drive
 * the write paths directly instead of having to spin up an OIDC server. The
 * function still passes every persisted profile field through
 * `redactSensitiveDeep()` first so a hostile or misconfigured upstream IdP
 * cannot smuggle a `password_hash`, `access_token`, JWT, GitHub PAT or
 * `sk-…` token into `platform_users.full_name` / `picture` (the two free-form
 * columns the upsert writes).
 */
export async function upsertOidcUser(profile: {
  sub: string;
  email: string;
  name: string;
  picture: string;
}) {
  await initAuthTables();

  // Scrub deny-list keys and credential-shaped strings out of every
  // free-text field BEFORE it touches the SELECT/INSERT/UPDATE params.
  const safeProfile = redactSensitiveDeep(profile) as typeof profile;

  const existing = await pool.query(
    "SELECT * FROM platform_users WHERE email = $1",
    [safeProfile.email],
  );

  if (existing.rows.length > 0) {
    const existingUser = existing.rows[0];
    if (existingUser.status !== "active") {
      return existingUser;
    }
    const result = await pool.query(
      `UPDATE platform_users
       SET google_id = $1, full_name = $2, picture = $3, auth_provider = 'replit',
           last_login_at = NOW(), login_count = login_count + 1, updated_at = NOW()
       WHERE email = $4 AND status = 'active'
       RETURNING *`,
      [safeProfile.sub, safeProfile.name, safeProfile.picture, safeProfile.email],
    );
    return result.rows[0] || existingUser;
  } else {
    const result = await pool.query(
      `INSERT INTO platform_users (email, full_name, google_id, picture, auth_provider, team, role, status, mfa_enabled, login_count, last_login_at)
       VALUES ($1, $2, $3, $4, 'replit', 'Other', 'department_viewer', 'pending_approval', false, 0, NOW())
       RETURNING *`,
      [safeProfile.email, safeProfile.name, safeProfile.sub, safeProfile.picture],
    );
    return result.rows[0];
  }
}

export const authRoutes = [
  {
    path: "/api/login",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const config = await getOidcConfig();
          const state = crypto.randomBytes(16).toString("hex");
          const nonce = crypto.randomBytes(16).toString("hex");
          const codeVerifier = client.randomPKCECodeVerifier();
          const codeChallenge =
            await client.calculatePKCECodeChallenge(codeVerifier);

          const callbackUrl = getCallbackUrl();

          const params = new URLSearchParams({
            client_id: process.env.REPL_ID!,
            redirect_uri: callbackUrl,
            response_type: "code",
            scope: "openid email profile offline_access",
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            prompt: "login consent",
          });

          const authUrl = `${config.serverMetadata().authorization_endpoint}?${params.toString()}`;

          const secure = isSecureDomain();
          const cookieBase = `HttpOnly; Path=/; Max-Age=600; SameSite=Lax${secure ? "; Secure" : ""}`;
          const oauthData = Buffer.from(
            JSON.stringify({ state, nonce, verifier: codeVerifier }),
          ).toString("base64url");
          c.header("Set-Cookie", `oauth_data=${oauthData}; ${cookieBase}`);

          return c.redirect(authUrl);
        } catch (err) {
          logger.error("[Auth] Login redirect error:", err);
          return c.json({ error: "Authentication service unavailable" }, 500);
        }
      };
    },
  },
  {
    path: "/api/callback",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const config = await getOidcConfig();
          const url = new URL(c.req.url);
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            logger.error("[Auth] OIDC error:", error);
            return c.redirect("/login?error=auth_denied");
          }

          if (!code) {
            return c.redirect("/login?error=no_code");
          }

          const cookies = c.req.header("Cookie") || "";
          const oauthDataMatch = cookies.match(/oauth_data=([^;]+)/);
          if (!oauthDataMatch) {
            logger.error("[Auth] No oauth_data cookie");
            return c.redirect("/login?error=invalid_state");
          }

          let oauthData: { state: string; nonce: string; verifier: string };
          try {
            oauthData = JSON.parse(
              Buffer.from(oauthDataMatch[1], "base64url").toString(),
            );
          } catch {
            logger.error("[Auth] Invalid oauth_data cookie");
            return c.redirect("/login?error=invalid_state");
          }

          const returnedState = url.searchParams.get("state");
          if (!oauthData.state || oauthData.state !== returnedState) {
            logger.error("[Auth] State mismatch");
            return c.redirect("/login?error=invalid_state");
          }

          const callbackUrl = getCallbackUrl();
          const tokenEndpoint = config.serverMetadata().token_endpoint!;

          logger.info(
            "[Auth] Exchanging code for token, redirect_uri:",
            callbackUrl,
          );

          const tokenRes = await fetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: callbackUrl,
              client_id: process.env.REPL_ID!,
              code_verifier: oauthData.verifier,
            }),
          });

          const tokenData = (await tokenRes.json()) as any;

          if (tokenData.error) {
            logger.error(
              "[Auth] Token exchange error:",
              JSON.stringify(tokenData),
            );
            return c.redirect("/login?error=callback_failed");
          }

          logger.info("[Auth] Token exchange successful");

          const userInfoEndpoint = config.serverMetadata().userinfo_endpoint!;
          const userInfoRes = await fetch(userInfoEndpoint, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });

          const profile = (await userInfoRes.json()) as any;

          if (tokenData.id_token) {
            try {
              const [, payloadB64] = tokenData.id_token.split(".");
              const idTokenPayload = JSON.parse(
                Buffer.from(payloadB64, "base64url").toString(),
              );
              if (
                idTokenPayload.nonce &&
                idTokenPayload.nonce !== oauthData.nonce
              ) {
                logger.error("[Auth] Nonce mismatch - possible replay attack");
                return c.redirect("/login?error=nonce_mismatch");
              }
            } catch (nonceErr) {
              logger.warn(
                "[Auth] Could not verify nonce in id_token:",
                nonceErr,
              );
            }
          }

          if (!profile.email) {
            logger.error("[Auth] No email in profile:", profile);
            return c.redirect("/login?error=no_email");
          }

          const firstName = profile.first_name || "";
          const lastName = profile.last_name || "";
          const fullName =
            [firstName, lastName].filter(Boolean).join(" ") || profile.email;
          const picture = profile.profile_image_url || "";

          const user = await upsertOidcUser({
            sub: profile.sub,
            email: profile.email as string,
            name: fullName,
            picture,
          });

          if (!user || user.status !== "active") {
            const statusParam =
              user?.status === "pending_approval"
                ? "pending_approval"
                : user?.status === "denied"
                  ? "access_denied"
                  : user?.status === "disabled"
                    ? "account_disabled"
                    : "access_denied";
            logger.warn(
              "[Auth] Login blocked for non-active user:",
              profile.email,
              "status:",
              user?.status,
            );
            return c.redirect(`/login?error=${statusParam}`);
          }

          const sessionToken = signSession({
            userId: user.id,
            email: user.email,
            name: user.full_name,
            picture: user.picture,
            role: user.role,
            exp: Date.now() + SESSION_MAX_AGE * 1000,
          });

          const secure = isSecureDomain();
          const cookieFlags = `HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;

          logger.info(
            "[Auth] Login successful for:",
            user.email,
            "role:",
            user.role,
          );

          return new Response(null, {
            status: 302,
            headers: [
              ["Location", "/"],
              [
                "Set-Cookie",
                `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; ${cookieFlags}`,
              ],
              [
                "Set-Cookie",
                `oauth_data=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`,
              ],
            ],
          });
        } catch (err) {
          logger.error("[Auth] Callback error:", err);
          return c.redirect("/login?error=callback_failed");
        }
      };
    },
  },
  {
    path: "/api/auth/me",
    method: "GET" as const,
    createHandler: async () => {
      // Lazy-loaded so this module stays free of cycles with rbacMiddleware
      // (which itself imports `getSessionFromCookie` from this file).
      const { hasValidAdminApiKey } =
        await import("../../utils/rbacMiddleware");
      return async (c: any) => {
        const session = getSessionFromCookie(c.req.header("Cookie"));
        if (session) {
          return c.json({
            authenticated: true,
            user: {
              id: session.userId,
              email: session.email,
              name: session.name,
              picture: session.picture,
              role: session.role,
            },
          });
        }
        // Admin-key callers (X-Admin-Key header or admin_key cookie) get the
        // same shape as a session so callers don't need a separate endpoint.
        if (hasValidAdminApiKey(c)) {
          return c.json({
            authenticated: true,
            user: {
              id: "admin",
              email: "admin@walaplus.local",
              name: "Admin",
              picture: null,
              role: "admin",
            },
          });
        }
        return c.json({ authenticated: false }, 401);
      };
    },
  },
  {
    path: "/api/auth/logout",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const secure = isSecureDomain();
        const sessionCookieFlags = `HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
        // Security: admin_key must always carry HttpOnly + Secure + SameSite=Strict —
        // all three flags are unconditional regardless of protocol, to prevent XSS and CSRF.
        const adminKeyCookieFlags = `HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
        // Clear both auth cookies so the unified /api/auth/me endpoint stops
        // reporting the caller as authenticated regardless of which auth path
        // they used (OIDC session or admin API key).
        c.header(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=; ${sessionCookieFlags}`,
          { append: true },
        );
        c.header("Set-Cookie", `admin_key=; ${adminKeyCookieFlags}`, {
          append: true,
        });
        try {
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            actionType: "LOGOUT",
            entityType: "SESSION",
            entityId: "session",
            entityName: "user-session",
            description: "User logged out",
            module: "auth",
            severity: "INFO",
          });
        } catch {}
        return c.json({ success: true });
      };
    },
  },
  {
    path: "/api/logout",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const secure = isSecureDomain();
        const sessionCookieFlags = `HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
        // Security: admin_key must always carry HttpOnly + Secure + SameSite=Strict —
        // all three flags are unconditional regardless of protocol, to prevent XSS and CSRF.
        const adminKeyCookieFlags = `HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
        // Clear both auth cookies (session + admin_key) so the unified
        // /api/auth/me endpoint won't keep reporting the caller as
        // authenticated after they sign out.
        c.header(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=; ${sessionCookieFlags}`,
          { append: true },
        );
        c.header("Set-Cookie", `admin_key=; ${adminKeyCookieFlags}`, {
          append: true,
        });

        try {
          const config = await getOidcConfig();
          const domain = getDomain();
          const protocol = domain.includes("localhost") ? "http" : "https";
          const endSessionUrl = client.buildEndSessionUrl(config, {
            client_id: process.env.REPL_ID!,
            post_logout_redirect_uri: `${protocol}://${domain}`,
          });
          return c.redirect(endSessionUrl.href);
        } catch {
          return c.redirect("/login");
        }
      };
    },
  },
];
