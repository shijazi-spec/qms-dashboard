import crypto from "crypto";
import * as client from "openid-client";
import { logger } from "../../utils/logger";
// Re-exported below for back-compat — the canonical implementation now lives
// in `userAccessDatabase.ts` so all platform_users writes are colocated and
// the secret-leak coverage gate doesn't have to track this route file
// separately (Task #746).
import { upsertOidcUser as upsertOidcUserImpl } from "../../utils/userAccessDatabase";

const SESSION_COOKIE_NAME = "ExampleOrg_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

let oidcConfig: client.Configuration | null = null;

/**
 * OIDC provider configuration — provider-agnostic.
 *
 * The QMS app uses Replit Auth (OIDC) by default but supports any
 * generic OIDC issuer (Google OAuth, Auth0, Okta, etc.) via env vars.
 * Every provider-specific value is read from env vars with Replit-style
 * fallbacks so this code runs anywhere without `if (env === '…')` forks:
 *
 *   OIDC_ISSUER_URL    — defaults to ISSUER_URL → <REDACTED_URL>
 *                        For Google: <REDACTED_URL>
 *   OIDC_CLIENT_ID     — defaults to REPL_ID (Replit's auto-injected ID)
 *                        For Google: the Web-client ID from Google Cloud Console
 *   OIDC_CLIENT_SECRET — required for Google (no fallback). Replit's PKCE
 *                        flow never required a secret; Google does.
 *   PUBLIC_BASE_URL    — defaults to REPLIT_DOMAINS / REPLIT_DEV_DOMAIN.
 *                        For a custom host: the canonical https URL.
 *
 * Set the OIDC_* vars on a non-Replit host → falls through to Replit vars
 * on Replit. One codebase, multiple deploy targets.
 */
function getIssuerUrl(): string {
  return (
    process.env.OIDC_ISSUER_URL ||
    process.env.ISSUER_URL ||
    "<REDACTED_URL>"
  );
}

function getClientId(): string {
  const id = process.env.OIDC_CLIENT_ID || process.env.REPL_ID;
  if (!id) {
    throw new Error(
      "OIDC client ID missing — set OIDC_CLIENT_ID (Google/other) or REPL_ID (Replit).",
    );
  }
  return id;
}

function getClientSecret(): string | undefined {
  // Replit OIDC uses PKCE with no client secret; Google requires both.
  // Returning undefined when unset preserves the Replit flow exactly.
  return process.env.OIDC_CLIENT_SECRET || undefined;
}

async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    const secret = getClientSecret();
    // The `openid-client` library's discovery() accepts an optional client
    // secret as the third arg. For PKCE-only providers (Replit), omit it.
    oidcConfig = secret
      ? await client.discovery(new URL(getIssuerUrl()), getClientId(), secret)
      : await client.discovery(new URL(getIssuerUrl()), getClientId());
  }
  return oidcConfig;
}

function getDomain(): string {
  // PUBLIC_BASE_URL is the canonical, provider-neutral source. The
  // REPLIT_* fallbacks are kept so the Replit deploy continues to work
  // without anyone having to change Replit Secrets.
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) {
    // Accept either bare host (<REDACTED_HOST>) or full URL (<REDACTED_URL>
    return explicit.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
  return (
    process.env.REPLIT_DOMAINS?.split(",")[0] ||
    process.env.REPLIT_DEV_DOMAIN ||
    "localhost:5000"
  );
}

/**
 * Provider name for audit logs / the platform_users.auth_provider column.
 * Inferred from the issuer URL — <REDACTED_HOST> → 'google',
 * <REDACTED_HOST> → 'replit'. Used so the QMS audit trail correctly attributes
 * each login to the actual IdP, not always "replit".
 */
function getAuthProviderName(): "google" | "replit" | "other" {
  const issuer = getIssuerUrl().toLowerCase();
  if (issuer.includes("google")) return "google";
  if (issuer.includes("replit")) return "replit";
  return "other";
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
 *   - Either present but not matching → cross-origin (block)
 *   - Both absent → consult Sec-Fetch-Site (a browser-enforced "forbidden
 *     header" that web pages cannot suppress or forge):
 *       - "none"        → direct navigation (typed URL / bookmark) → allow
 *       - "same-origin" → same-origin navigation → allow
 *       - "cross-site" or "same-site" → cross-origin navigation → block
 *       - header absent → non-browser caller (curl / API); no browser
 *         means no SameSite=Lax cookie is attached, so allow (nothing
 *         to protect against)
 *
 * This closes the rel="noreferrer" / Referrer-Policy:no-referrer bypass
 * where both Origin and Referer can be absent on a cross-site top-level
 * GET while the session cookie is still attached under SameSite=Lax.
 * Sec-Fetch-Site is always "cross-site" in that scenario even when the
 * legacy headers are stripped, so the guard correctly rejects it.
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
  if (origin || referer) return false; // at least one present but non-matching

  // Both Origin and Referer are absent. Use Sec-Fetch-Site to distinguish
  // legitimate direct navigation from a cross-site link that stripped the
  // legacy headers via rel="noreferrer" or Referrer-Policy: no-referrer.
  // Sec-Fetch-Site is a browser-enforced forbidden header — it cannot be
  // suppressed or spoofed by web pages. Non-browser callers (curl, server-
  // to-server) do not send it, but they also cannot attach SameSite=Lax
  // cookies, so there is nothing to protect against in that case.
  const secFetchSite = c.req.header("Sec-Fetch-Site") || "";
  if (!secFetchSite) return true; // non-browser caller — no cookie risk
  if (secFetchSite === "none" || secFetchSite === "same-origin") return true;
  return false; // "cross-site" or "same-site" (different subdomain) → block
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

          // Scope differs by provider:
          //   - Replit OIDC accepts (and quietly ignores when absent) the
          //     `offline_access` scope for refresh tokens.
          //   - Google REJECTS the bare `offline_access` scope as
          //     invalid_scope (Error 400). To get a refresh token from
          //     Google you use the `access_type=offline` parameter
          //     instead. The QMS app doesn't currently rely on the
          //     refresh token (sessions are 7-day JWTs in HttpOnly
          //     cookies), so the simplest correct fix is to omit
          //     `offline_access` on Google and skip `access_type` too.
          const providerName = getAuthProviderName();
          const scope =
            providerName === "google"
              ? "openid email profile"
              : "openid email profile offline_access";
          const params = new URLSearchParams({
            client_id: getClientId(),
            redirect_uri: callbackUrl,
            response_type: "code",
            scope,
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            prompt: "login consent",
          });
          // Google Workspace lock-down: hd=<REDACTED_HOST> tells Google to
          // only present accounts from this domain. Combined with the
          // OAuth consent screen's "User type: Internal" setting, this
          // makes it impossible for a personal @<REDACTED_HOST> account to
          // even start the sign-in flow. Skipped for non-Google providers.
          if (providerName === "google") {
            const allowedHd = process.env.OAUTH_HD || "<REDACTED_HOST>";
            params.set("hd", allowedHd);
          }

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

          // Token exchange body. PKCE (code_verifier) is always sent.
          // Google additionally requires client_secret; Replit doesn't.
          const tokenBody: Record<string, string> = {
            grant_type: "authorization_code",
            code,
            redirect_uri: callbackUrl,
            client_id: getClientId(),
            code_verifier: oauthData.verifier,
          };
          const clientSecret = getClientSecret();
          if (clientSecret) tokenBody.client_secret = clientSecret;

          const tokenRes = await fetch(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(tokenBody),
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

          // Belt + suspenders email-domain check for Google. The OAuth
          // consent screen's "User type: Internal" + the hd= param on the
          // auth URL already enforce <REDACTED_HOST> membership at the IdP
          // layer, but if either is ever misconfigured this catches it
          // server-side so a stray Gmail account can't slip through.
          const authProvider = getAuthProviderName();
          if (authProvider === "google") {
            const allowedDomain = (process.env.OAUTH_HD || "<REDACTED_HOST>").toLowerCase();
            const emailDomain = String(profile.email).split("@")[1]?.toLowerCase() || "";
            if (emailDomain !== allowedDomain) {
              logger.warn(
                "[Auth] Rejecting non-allowed email domain:",
                profile.email,
                "(expected @" + allowedDomain + ")",
              );
              return c.redirect("/login?error=domain_not_allowed");
            }
          }

          // Field-name fallbacks: Google uses given_name/family_name/picture,
          // Replit uses first_name/last_name/profile_image_url. Some IdPs
          // only emit `name` — that's the final fallback.
          const firstName =
            profile.given_name || profile.first_name || "";
          const lastName =
            profile.family_name || profile.last_name || "";
          const composedName = [firstName, lastName].filter(Boolean).join(" ");
          const fullName = composedName || profile.name || profile.email;
          const picture =
            profile.picture || profile.profile_image_url || "";

          const user = await upsertOidcUser({
            sub: profile.sub,
            email: profile.email as string,
            name: fullName,
            picture,
            authProvider,
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
              email: "user@example.invalid",
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
        // put `<a href="<REDACTED_URL>">free pizza</a>` on any page
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
          // buildEndSessionUrl requires the IdP to advertise an
          // end_session_endpoint in its discovery doc. Google does NOT —
          // when omitted, openid-client throws. Catch and fall back to a
          // local-only logout so the user still gets logged out of our app
          // even if the IdP refuses to participate. The cleared cookies
          // above are the real logout; the redirect is just UX.
          const endSessionUrl = client.buildEndSessionUrl(config, {
            client_id: getClientId(),
            post_logout_redirect_uri: `${protocol}://${domain}`,
          });
          return c.redirect(endSessionUrl.href);
        } catch (logoutErr) {
          logger.info(
            "[Auth] IdP end-session not available, redirecting to local /login:",
            logoutErr instanceof Error ? logoutErr.message : String(logoutErr),
          );
          return c.redirect("/login");
        }
      };
    },
  },
];
