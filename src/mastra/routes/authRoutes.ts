import crypto from "crypto";
import * as client from "openid-client";
import { logger } from "../../utils/logger";
// Re-exported below for back-compat — the canonical implementation now lives
// in `userAccessDatabase.ts` so all platform_users writes are colocated and
// the secret-leak coverage gate doesn't have to track this route file
// separately (Task #746).
import { upsertOidcUser as upsertOidcUserImpl } from "../../utils/userAccessDatabase";

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

/**
 * Returns true when the request's `Origin` or `Referer` header points at
 * this app's own host — used by GET `/api/logout` to mitigate a low-grade
 * CSRF where a cross-origin link could log the victim out.
 *
 * Decision matrix:
 *   - Origin matches host  → same-origin (allow)
 *   - Referer matches host → same-origin (allow)
 *   - Neither matches BUT both absent → likely a typed-URL / bookmark
 *     navigation; treat as same-origin so the legitimate fallback still
 *     works. The attack vector we're closing (attacker.com link) sets
 *     Origin/Referer to attacker.com, which never reaches this branch.
 *   - Either present but not matching → cross-origin (block)
 *
 * SameSite=Lax already blocks the subresource-image-tag variant (cookies
 * aren't attached to cross-site subresource GETs). This guard adds
 * defence-in-depth for the user-clicked link variant.
 */
function isSameOriginNavigation(c: any): boolean {
  const origin = c.req.header("Origin") || "";
  const referer = c.req.header("Referer") || "";
  const expectedHost = getDomain();

  const matches = (headerValue: string): boolean => {
    if (!headerValue) return false;
    try {
      return new URL(headerValue).host === expectedHost;
    } catch {
      return false;
    }
  };

  if (matches(origin) || matches(referer)) return true;
  // Both headers absent → typed URL / bookmark / non-browser caller.
  // Allow to preserve the legitimate fallback. Cross-origin requests
  // always carry at least one of these headers in modern browsers.
  if (!origin && !referer) return true;
  return false;
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

/**
 * Upsert a platform_users row from an OIDC profile callback.
 *
 * Re-exported for back-compat — the canonical implementation lives in
 * `userAccessDatabase.upsertOidcUser` so the secret-leak coverage gate only
 * has to track the DB-module file (Task #746). The companion secret-leak test
 * (`./authRoutes.test.ts`) imports this name and continues to drive the same
 * write paths via the global `Pool.prototype.query` mock.
 */
export const upsertOidcUser = upsertOidcUserImpl;

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
        // Admin-key callers (X-Admin-Key header or signed admin_session cookie)
        // get the same shape as a session so callers don't need a separate endpoint.
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
        // Security: admin cookie flags must always carry HttpOnly + Secure + SameSite=Strict —
        // all three flags are unconditional regardless of protocol, to prevent XSS and CSRF.
        const adminKeyCookieFlags = `HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
        // Clear all auth cookies so the unified /api/auth/me endpoint stops
        // reporting the caller as authenticated regardless of which auth path
        // they used (OIDC session, admin_session token, or legacy admin_key).
        c.header(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=; ${sessionCookieFlags}`,
          { append: true },
        );
        c.header("Set-Cookie", `admin_session=; ${adminKeyCookieFlags}`, {
          append: true,
        });
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
        // CSRF defence-in-depth: GET endpoints that clear session cookies
        // are the textbook annoyance-grade CSRF target — an attacker can
        // put `<a href="https://app/api/logout">free pizza</a>` on any page
        // and force-logout any victim who clicks. SameSite=Lax already
        // blocks the subresource (`<img>`) variant, but does NOT block
        // user-initiated link clicks. We close that gap by validating
        // Origin / Referer points back at our own host before clearing
        // cookies. Cross-origin GETs still get the OIDC end-session
        // redirect (so the IDP logout still works on legitimate
        // direct-navigation flows that strip headers), but the app's
        // session survives a CSRF attempt.
        const sameOrigin = isSameOriginNavigation(c);

        if (sameOrigin) {
          const secure = isSecureDomain();
          const sessionCookieFlags = `HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
          // Security: admin cookie flags must always carry HttpOnly + Secure + SameSite=Strict —
          // all three flags are unconditional regardless of protocol, to prevent XSS and CSRF.
          const adminKeyCookieFlags = `HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Strict`;
          // Clear all auth cookies (session + admin_session token + legacy admin_key)
          // so the unified /api/auth/me endpoint won't keep reporting the caller
          // as authenticated after they sign out.
          c.header(
            "Set-Cookie",
            `${SESSION_COOKIE_NAME}=; ${sessionCookieFlags}`,
            { append: true },
          );
          c.header("Set-Cookie", `admin_session=; ${adminKeyCookieFlags}`, {
            append: true,
          });
          c.header("Set-Cookie", `admin_key=; ${adminKeyCookieFlags}`, {
            append: true,
          });
        }

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
