/**
 * IdentityProvider Drive call-source helper.
 *
 * Auth resolution order (first available wins):
 *   1. HostingPlatform Connector (HostingPlatform_CONNECTORS_HOSTNAME + repl identity)  — same pattern as IdentityProviderCalendar.ts
 *   2. Service Account JWT (IdentityProvider_DRIVE_CLIENT_EMAIL + IdentityProvider_DRIVE_PRIVATE_KEY)
 *   3. OAuth refresh token (IdentityProvider_OAUTH_CLIENT_ID + IdentityProvider_OAUTH_CLIENT_SECRET + IdentityProvider_OAUTH_REFRESH_TOKEN)
 *
 * No new dependencies — talks to Drive v3 over `fetch`, mints SA JWTs with Node `crypto`.
 */
import { createSign } from "node:crypto";

const DRIVE_API_BASE = "<REDACTED_URL>";
const DRIVE_TOKEN_URL = "<REDACTED_URL>";
const SCOPE_DRIVE_READONLY = "<REDACTED_URL>";

export type DriveAuthMode = "HostingPlatform_connector" | "service_account" | "oauth_refresh" | "none";

export interface DriveAuthResult {
  mode: DriveAuthMode;
  access_token: string;
}

interface CachedToken {
  mode: DriveAuthMode;
  access_token: string;
  expires_at: number;
}

let cachedToken: CachedToken | null = null;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function base64UrlEncode(input: Buffer | string): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizePrivateKey(raw: string): string {
  if (raw.includes("\\n")) return raw.replace(/\\n/g, "\n");
  return raw;
}

async function getHostingPlatformConnectorToken(): Promise<string | null> {
  const hostname = process.env.HostingPlatform_CONNECTORS_HOSTNAME;
  if (!hostname) return null;
  const xHostingPlatformToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xHostingPlatformToken) return null;

  try {
    const res = await fetch(
      `<REDACTED_URL>`,
      {
        headers: { Accept: "application/json", X_HostingPlatform_TOKEN: xHostingPlatformToken },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: Array<{ settings?: any }> };
    const settings = data.items?.[0]?.settings;
    const accessToken =
      settings?.access_token || settings?.oauth?.credentials?.access_token;
    return accessToken ?? null;
  } catch {
    return null;
  }
}

async function getServiceAccountToken(): Promise<string | null> {
  const email = process.env.IdentityProvider_DRIVE_CLIENT_EMAIL;
  const rawKey = process.env.IdentityProvider_DRIVE_PRIVATE_KEY;
  if (!email || !rawKey) return null;

  const privateKey = normalizePrivateKey(rawKey);
  const iat = nowSec();
  const exp = iat + 3600;

  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: email,
      scope: SCOPE_DRIVE_READONLY,
      aud: DRIVE_TOKEN_URL,
      iat,
      exp,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(privateKey));
  const assertion = `${signingInput}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(DRIVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

async function getOAuthRefreshToken(): Promise<string | null> {
  const clientId = process.env.IdentityProvider_OAUTH_CLIENT_ID;
  const clientSecret = process.env.IdentityProvider_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.IdentityProvider_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(DRIVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/**
 * Resolve a Drive access token using whichever auth path is configured.
 * Cached for 50 minutes (tokens are valid ~60 min).
 */
export async function resolveDriveAuth(): Promise<DriveAuthResult> {
  if (cachedToken && cachedToken.expires_at > nowSec() + 60) {
    return { mode: cachedToken.mode, access_token: cachedToken.access_token };
  }

  const attempts: Array<{ mode: DriveAuthMode; fn: () => Promise<string | null> }> = [
    { mode: "HostingPlatform_connector", fn: getHostingPlatformConnectorToken },
    { mode: "service_account", fn: getServiceAccountToken },
    { mode: "oauth_refresh", fn: getOAuthRefreshToken },
  ];

  for (const a of attempts) {
    const token = await a.fn();
    if (token) {
      cachedToken = { mode: a.mode, access_token: token, expires_at: nowSec() + 50 * 60 };
      return { mode: a.mode, access_token: token };
    }
  }
  return { mode: "none", access_token: "<REDACTED_SECRET>" };
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DriveListResult {
  files: DriveFile[];
  auth_mode: DriveAuthMode;
  scope: "folder" | "query";
  next_page_token?: string;
}

const AUDIO_MIME_PREFIXES = ["audio/", "video/"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".webm", ".mp4"];

function looksLikeAudio(file: DriveFile): boolean {
  if (AUDIO_MIME_PREFIXES.some((p) => file.mimeType.startsWith(p))) return true;
  const lower = file.name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * List audio files in a Drive folder (or use a custom query).
 * Returns up to `pageSize` results; pass `pageToken` from a previous call to paginate.
 */
export async function listDriveAudioFiles(opts: {
  folder_id?: string;
  query?: string;
  page_size?: number;
  page_token?: string;
  audio_only?: boolean;
}): Promise<DriveListResult> {
  const auth = await resolveDriveAuth();
  if (auth.mode === "none") {
    return { files: [], auth_mode: "none", scope: opts.folder_id ? "folder" : "query" };
  }

  const folderId = opts.folder_id || process.env.IdentityProvider_DRIVE_CALLS_FOLDER_ID;
  const parts: string[] = ["trashed = false"];
  if (folderId) parts.push(`'${folderId}' in parents`);
  if (opts.query) parts.push(`(${opts.query})`);
  const q = parts.join(" and ");

  const params = new URLSearchParams({
    q,
    pageSize: String(opts.page_size ?? 50),
    fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (opts.page_token) params.set("pageToken", opts.page_token);

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${auth.access_token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`drive_list_failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
  let files = data.files ?? [];
  if (opts.audio_only !== false) files = files.filter(looksLikeAudio);

  return {
    files,
    auth_mode: auth.mode,
    scope: folderId ? "folder" : "query",
    next_page_token: data.nextPageToken,
  };
}

/**
 * Get metadata for a single file (used when you only have an ID).
 */
export async function getDriveFileMetadata(file_id: string): Promise<DriveFile | null> {
  const auth = await resolveDriveAuth();
  if (auth.mode === "none") return null;
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size,modifiedTime,webViewLink",
    supportsAllDrives: "true",
  });
  const res = await fetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(file_id)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${auth.access_token}` } },
  );
  if (!res.ok) return null;
  return (await res.json()) as DriveFile;
}

/**
 * Return a temporary direct-download URL token (the Drive `alt=media` URL plus a bearer token).
 * Caller can pass these to the existing transcription pipeline, or use `downloadDriveFile` to
 * pull the bytes server-side.
 */
export async function getDriveDownloadUrl(file_id: string): Promise<{
  download_url: string;
  authorization: string;
  auth_mode: DriveAuthMode;
} | null> {
  const auth = await resolveDriveAuth();
  if (auth.mode === "none") return null;
  return {
    download_url: `${DRIVE_API_BASE}/files/${encodeURIComponent(file_id)}?alt=media&supportsAllDrives=true`,
    authorization: `Bearer ${auth.access_token}`,
    auth_mode: auth.mode,
  };
}

/** Download bytes of a Drive file. Caller can write to disk or pipe to Whisper. */
export async function downloadDriveFile(file_id: string): Promise<Buffer | null> {
  const dl = await getDriveDownloadUrl(file_id);
  if (!dl) return null;
  const res = await fetch(dl.download_url, {
    headers: { Authorization: dl.authorization },
  });
  if (!res.ok) {
    throw new Error(`drive_download_failed: ${res.status} ${res.statusText}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/** Test helper: clear the token cache between tests. */
export function resetDriveAuthCacheForTests(): void {
  cachedToken = null;
}
