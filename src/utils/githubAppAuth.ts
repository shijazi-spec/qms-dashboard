/**
 * githubAppAuth — GitHub App authentication for the evidence connector.
 *
 * GitHub Apps do not hand you a bearer token. The flow is:
 *   1. Sign a short-lived JWT with the App's PRIVATE KEY (RS256).
 *   2. Exchange that JWT for an INSTALLATION access token.
 *   3. Call the API with the installation token (valid ~1 hour).
 *
 * Implemented with node's built-in `crypto` rather than a JWT library: the
 * signature is one RSA-SHA256 over two base64url segments, and this repo already
 * carries enough dependency surface. No new package, nothing to keep patched.
 *
 * Chosen over a personal access token because a PAT is tied to one person's
 * account and dies when they leave or it expires — which, for evidence an
 * auditor may re-request months later, is the wrong failure mode.
 *
 * CREDENTIALS
 *   GITHUB_APP_ID           - numeric App ID
 *   GITHUB_APP_PRIVATE_KEY  - the PEM. Literal \n escapes are accepted, because
 *                             most secret stores cannot hold real newlines.
 *   GITHUB_APP_INSTALLATION_ID - optional; discovered and logged if omitted.
 *
 * The private key is read from the environment, never logged, and never stored.
 * Every call in this module is read-only against the GitHub API.
 */

import { createSign } from "crypto";
import { logger } from "./logger";

const GITHUB_API = "https://api.github.com";

/** Installation tokens last ~1h; refresh early so a long run cannot straddle expiry. */
const TOKEN_TTL_SAFETY_MS = 50 * 60 * 1000;

let cached: { token: string; fetchedAt: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalise the PEM. Secret stores commonly flatten newlines to the two
 * characters \ and n; an unmodified PEM also has to keep working, so only
 * escaped sequences are rewritten.
 */
export function normalisePrivateKey(raw: string): string {
  const s = String(raw || "").trim();
  return s.includes("\\n") ? s.replace(/\\n/g, "\n") : s;
}

export function githubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY,
  );
}

/**
 * Sign the App JWT. `iat` is backdated 60s because GitHub rejects tokens whose
 * issued-at is in the future, and a small clock skew between us and them is
 * normal; `exp` is 9 minutes, inside GitHub's 10-minute ceiling.
 */
export function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const sig = b64url(signer.sign(privateKeyPem));
  return `${header}.${payload}.${sig}`;
}

async function ghFetch(url: string, token: string, tokenType: "Bearer" | "token") {
  return fetch(url, {
    headers: {
      Authorization: `${tokenType} ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "WalaPlus-QMS-Evidence-Connector",
    },
  });
}

/** Resolve the installation id, so the operator does not have to hunt for it. */
async function discoverInstallationId(jwt: string): Promise<string | null> {
  const res = await ghFetch(`${GITHUB_API}/app/installations`, jwt, "Bearer");
  if (!res.ok) {
    logger.warn(
      `[GitHubApp] could not list installations: ${res.status} ${res.statusText}`,
    );
    return null;
  }
  const list = (await res.json()) as any[];
  if (!Array.isArray(list) || list.length === 0) {
    logger.warn("[GitHubApp] the App is not installed anywhere yet");
    return null;
  }
  if (list.length > 1) {
    logger.warn(
      `[GitHubApp] ${list.length} installations found; using the first. Set GITHUB_APP_INSTALLATION_ID to pin one.`,
    );
  }
  return String(list[0].id);
}

/**
 * An installation access token, cached until shortly before it expires.
 *
 * Returns null rather than throwing when the App is unconfigured: a missing
 * connector should leave the rest of the platform working, and the caller
 * reports "not configured" instead of failing a collection run.
 */
export async function getInstallationToken(): Promise<string | null> {
  if (!githubAppConfigured()) return null;

  if (cached && Date.now() - cached.fetchedAt < TOKEN_TTL_SAFETY_MS) {
    return cached.token;
  }

  const appId = String(process.env.GITHUB_APP_ID);
  const key = normalisePrivateKey(String(process.env.GITHUB_APP_PRIVATE_KEY));

  let jwt: string;
  try {
    jwt = createAppJwt(appId, key);
  } catch (err) {
    // Almost always a malformed PEM. Say so without echoing the key.
    logger.error(
      `[GitHubApp] could not sign the App JWT — check GITHUB_APP_PRIVATE_KEY is a full PEM: ${(err as Error).message}`,
    );
    return null;
  }

  const installationId =
    process.env.GITHUB_APP_INSTALLATION_ID ||
    (await discoverInstallationId(jwt));
  if (!installationId) return null;

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "WalaPlus-QMS-Evidence-Connector",
      },
    },
  );
  if (!res.ok) {
    logger.error(
      `[GitHubApp] installation token request failed: ${res.status} ${res.statusText}`,
    );
    return null;
  }
  const body = (await res.json()) as any;
  if (!body?.token) {
    logger.error("[GitHubApp] installation token response had no token");
    return null;
  }
  cached = { token: body.token, fetchedAt: Date.now() };
  return body.token;
}

/**
 * Read-only GitHub API call with the installation token.
 *
 * Returns { ok, status, data } rather than throwing, because a connector run
 * should record a per-check 'error' observation and carry on rather than abort
 * the whole collection on one 404.
 */
export async function githubGet(
  path: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const token = await getInstallationToken();
  if (!token) return { ok: false, status: 0, data: { error: "not_configured" } };
  const res = await ghFetch(`${GITHUB_API}${path}`, token, "token");
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Test-only: drop the cached installation token. */
export function _resetTokenCacheForTests(): void {
  cached = null;
}
