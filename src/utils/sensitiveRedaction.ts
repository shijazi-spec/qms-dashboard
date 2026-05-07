/**
 * Sensitive-data redaction primitives — extracted from `eventLogsDatabase.ts`
 * (Task #356) so the structured `logger.ts` wrapper can import them without
 * pulling in the database layer.  `eventLogsDatabase.ts` re-exports every
 * symbol from this file unchanged so existing call sites keep working.
 *
 * The functions here are pure (no I/O, no module-level side effects) and
 * therefore safe to load eagerly from `logger.ts`.
 */

/* -------------------------------------------------------------------------
 * Sensitive-field redaction
 * -------------------------------------------------------------------------
 * DENY LIST — any key that matches one of these patterns will have its value
 * replaced with REDACTED_SENTINEL before it is written to event_logs or
 * change_history.  New patterns must be added here; the allow-list is
 * "everything not on the deny list".
 *
 * Pattern rules (matched case-insensitively against the field / key name):
 *   1. Exact names listed in SENSITIVE_EXACT_FIELDS
 *   2. Suffix patterns: key ends with one of SENSITIVE_SUFFIXES
 *   3. Prefix patterns: key starts with one of SENSITIVE_PREFIXES
 * -------------------------------------------------------------------------*/

export const REDACTED_SENTINEL = "***REDACTED***";

const SENSITIVE_EXACT_FIELDS = new Set([
  "password",
  "password_hash",
  "passwordhash",
  "hashed_password",
  "mfa_secret",
  "mfa_code",
  "mfa_token",
  "mfa_backup_codes",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "bot_token",
  "api_key",
  "apikey",
  "client_secret",
  "private_key",
  "signing_key",
  "session_secret",
  "encryption_key",
  "zoho_refresh_token",
  "zoho_access_token",
  "slack_bot_token",
  "resend_api_key",
  "openai_api_key",
]);

const SENSITIVE_SUFFIXES = [
  "_token",
  "_secret",
  "_key",
  "_hash",
  "_password",
  "_credential",
  "_credentials",
];

const SENSITIVE_PREFIXES = ["password", "mfa_", "secret_", "token_"];

/* -------------------------------------------------------------------------
 * String-aware secret redaction
 * -------------------------------------------------------------------------
 * The deny-list above operates on object KEYS — it only protects payloads
 * whose author thought to name a field `password`, `api_key`, etc.  Several
 * of our write paths (notably `ai_pending_actions.payload_preview`, which is
 * a free-form human-readable description built by each tool's `buildPreview`
 * callback in `withApprovalGate.ts`) persist arbitrary STRINGS.  If a tool
 * author ever interpolates a credential into that preview string, the
 * key-based helper above is blind to it.
 *
 * `redactSecretLikeStrings()` runs a regex deny-list against the raw text to
 * catch credential-shaped substrings before they reach the database.  The
 * patterns are conservative — they target token formats with distinctive
 * structure (vendor prefix + length + alphabet) so they should not match
 * ordinary prose, IDs, or UUIDs.
 *
 * New patterns must be added here AND covered by a test in
 * `redactSensitiveFields.test.ts` / `aiApprovalRedaction.test.ts`.
 * -------------------------------------------------------------------------*/

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const SECRET_LIKE_PATTERNS: SecretPattern[] = [
  // bcrypt hash:  $2a$ / $2b$ / $2y$  + cost + 53-char salt+hash (base64-ish)
  // Match this BEFORE the generic patterns because the literal `$` chars are
  // distinctive and we don't want some other rule to consume part of it.
  { name: "bcrypt", regex: /\$2[aby]\$\d{1,2}\$[./A-Za-z0-9]{53}/g },
  // JSON Web Token:  three base64url segments separated by dots, header
  // always starts `eyJ` (base64 of `{"`).
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.+/=-]{8,}/g,
  },
  // Stripe / OpenAI / Anthropic style:  sk-…, sk_live_…, sk_test_…
  // Also covers `sk-ant-…` (Anthropic) and `sk-proj-…` (OpenAI project keys).
  {
    name: "sk-key",
    regex: /\bsk[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/g,
  },
  // Stripe publishable / restricted keys
  { name: "stripe-pk", regex: /\b(?:pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  // GitHub tokens:  ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh)
  { name: "github", regex: /\bgh[porsu]_[A-Za-z0-9]{30,}\b/g },
  // GitLab personal access token
  { name: "gitlab", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens (bot, user, app, workspace, refresh)
  { name: "slack", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  // Google API key
  { name: "google-api", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Google OAuth token
  { name: "google-oauth", regex: /\bya29\.[0-9A-Za-z_-]{20,}\b/g },
  // AWS Access Key ID (also matches the temporary ASIA prefix)
  { name: "aws-akid", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // HTTP "Authorization: Bearer …" header style
  { name: "bearer", regex: /\bBearer\s+[A-Za-z0-9_\-.=+/]{20,}/gi },
];

/* -------------------------------------------------------------------------
 * Heuristic detectors: password-shaped and high-entropy substrings
 * -------------------------------------------------------------------------
 * The vendor-prefix regexes above only catch credentials with a distinctive
 * shape (`sk-…`, `ghp_…`, AKIA…, JWT, bcrypt, etc.). They are blind to a
 * secret that looks like ordinary prose — most importantly, a free-form
 * password buried in an innocuously-named field like `assignedTo`,
 * `description`, or `note` (e.g. 'P@ssw0rd!_plaintext'). The key-name
 * deny-list is also blind to these because the surrounding key name is not
 * on the sensitive list.
 *
 * Two heuristics close that gap (Task #463):
 *
 *   1. Password-strength tokens — a non-whitespace token of 12-80 chars
 *      that contains uppercase, lowercase, digit, and at least one
 *      "strong" special char from `!@#$%^&*()+={}[]|\:;"'<>?~``. The
 *      "strong" set deliberately excludes `,` `.` `-` `_` because those
 *      appear constantly in prose, slugs ("Test-Project-2026"), filenames,
 *      and acronym lists — including them would generate false positives.
 *
 *   2. High-entropy tokens — a non-whitespace token of 24-80 chars drawn
 *      from the base64/base64url alphabet `[A-Za-z0-9+/=_-]` that contains
 *      AT LEAST 3 of {upper, lower, digit} and has Shannon entropy
 *      >= 4.5 bits/char. This catches random session IDs and base64
 *      tokens without a vendor prefix. The "3 classes" floor filters out
 *      hex hashes (lowercase + digit only) and UUIDs (same), and the 4.5
 *      threshold is comfortably below random-base64 (~5.5+) but above the
 *      ceiling of mixed slugs like "Test-Project-2026-Final-v3" (~4.05).
 *
 * False-positive scope (verified against existing test fixtures):
 *   - English prose, emails, URLs, ISO dates, UUIDs, SHA hashes, slug
 *     identifiers, and ordinary alphanumeric IDs do NOT match either rule.
 *
 * New patterns must be covered by additions in `aiApprovalRedaction.test.ts`
 * and `aiToolPolicyBuildPreview.test.ts`.
 * -------------------------------------------------------------------------*/

const STRONG_SPECIAL_CHAR_RE = /[!@#$%^&*()+={}\[\]|\\:;"'<>?~`]/;
const TRIM_LEAD_RE = /^[("'`\[{<,]+/;
const TRIM_TAIL_RE = /[)"'`\]}>,.]+$/;
const ENTROPY_ALPHABET_RE = /^[A-Za-z0-9+/=_\-]+$/;

function isPasswordLikeToken(token: string): boolean {
  const len = token.length;
  if (len < 12 || len > 80) return false;
  if (!/[A-Z]/.test(token)) return false;
  if (!/[a-z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (!STRONG_SPECIAL_CHAR_RE.test(token)) return false;
  return true;
}

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  const len = s.length;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropyToken(token: string): boolean {
  const len = token.length;
  if (len < 24 || len > 80) return false;
  if (!ENTROPY_ALPHABET_RE.test(token)) return false;
  let classes = 0;
  if (/[A-Z]/.test(token)) classes++;
  if (/[a-z]/.test(token)) classes++;
  if (/\d/.test(token)) classes++;
  if (classes < 3) return false;
  return shannonEntropy(token) >= 4.5;
}

/**
 * Scans a string for non-whitespace tokens that match the password-strength
 * or high-entropy heuristic and replaces them with REDACTED_SENTINEL. Trims
 * one run of common surrounding punctuation (quotes, parens, commas) so a
 * credential wrapped in prose-quoting like `"P@ssw0rd!"` is still caught.
 *
 * Exported for direct unit testing; production code reaches it indirectly
 * through `redactSecretLikeStrings()`.
 */
export function redactCredentialLikeTokens(input: unknown): unknown {
  if (typeof input !== "string" || input.length === 0) return input;
  return input.replace(/\S+/g, (token) => {
    if (token.length < 12 || token.length > 80) return token;
    if (isPasswordLikeToken(token) || isHighEntropyToken(token)) {
      return REDACTED_SENTINEL;
    }
    const lead = TRIM_LEAD_RE.exec(token)?.[0] ?? "";
    const tail = TRIM_TAIL_RE.exec(token)?.[0] ?? "";
    if (lead.length > 0 || tail.length > 0) {
      const core = token.slice(lead.length, token.length - tail.length);
      if (
        core.length >= 12 &&
        core.length <= 80 &&
        (isPasswordLikeToken(core) || isHighEntropyToken(core))
      ) {
        return lead + REDACTED_SENTINEL + tail;
      }
    }
    return token;
  });
}

/* -------------------------------------------------------------------------
 * Credential-leak DETECTION (read-only, structural)
 * -------------------------------------------------------------------------
 * `redactSecretLikeStrings()` and friends mutate the value graph to scrub
 * secrets out of strings before they hit storage. That defends the
 * persisted row but says nothing about the original payload — the raw
 * value still passed through the AI tool call, was visible to model
 * context, and may surface in operator-facing previews assembled outside
 * the redaction path.
 *
 * `detectCredentialLikeFields()` runs the SAME three-layer check
 * (key-name deny-list + vendor-prefix regex + heuristic token scanner)
 * NON-DESTRUCTIVELY against an input value graph and returns a structured
 * list of offending field paths.  Callers (notably the AI approval-gate
 * boundary in `withApprovalGate.ts` / `enqueuePendingAction()`) attach
 * the warnings to the pending row so the operator approval UI can show
 * "this payload contains values that look like credentials — route the
 * real secret through the secret store, not through chat" alongside the
 * usual redaction (Task #477).
 *
 * Path notation matches the JSON pointer convention used in our other
 * audit messages — e.g. `payload.note`, `payload.items[2].secret`,
 * `payload_preview` for the free-form preview string.
 * -------------------------------------------------------------------------*/

export type CredentialWarningKind =
  | "sensitive-key" // value sits under a deny-listed key (api_key, password, …)
  | "regex" // value contains a substring matching a SECRET_LIKE_PATTERN
  | "password" // a token in the value matches the password-strength heuristic
  | "entropy"; // a token in the value matches the high-entropy heuristic

export interface CredentialWarning {
  /** JSON-pointer-ish path from the supplied root, e.g. `payload.items[2].note`. */
  path: string;
  /** Which detector fired — used by the UI to colour-code / explain the hit. */
  kind: CredentialWarningKind;
  /** When kind === 'regex', the SECRET_LIKE_PATTERNS entry name (jwt / sk-key / …). */
  patternName?: string;
}

function detectInString(
  value: string,
  parentKey: string | undefined,
  path: string,
  out: CredentialWarning[],
): void {
  if (value.length === 0) return;

  // 1) Key-name deny-list — only meaningful when the string is the value
  //    of a sensitive-named field (we cannot detect "the user named this
  //    field `apiKey`" purely from the string itself).
  if (parentKey && isSensitiveField(parentKey)) {
    out.push({ path, kind: "sensitive-key" });
    return;
  }

  // 2) Vendor-prefix regex deny-list (sk-…, ghp_…, JWT, bcrypt, AKIA, …).
  //    Use `String#match` rather than `RegExp#test` so the global flag's
  //    `lastIndex` cursor is not mutated across calls (would otherwise
  //    cause spurious misses on the second invocation of the same regex).
  for (const { name, regex } of SECRET_LIKE_PATTERNS) {
    if (value.match(regex)) {
      out.push({ path, kind: "regex", patternName: name });
      return;
    }
  }

  // 3) Heuristic token scanner — split the string on whitespace and check
  //    each non-trivial token. This catches credentials interpolated into
  //    prose like `note: "rotated to P@ssw0rd!_PlainText"`. Surrounding
  //    quoting punctuation is stripped exactly the way the redactor does
  //    so the two stay consistent.
  for (const token of value.split(/\s+/)) {
    if (token.length < 12 || token.length > 80) continue;
    if (isPasswordLikeToken(token)) {
      out.push({ path, kind: "password" });
      return;
    }
    if (isHighEntropyToken(token)) {
      out.push({ path, kind: "entropy" });
      return;
    }
    const lead = TRIM_LEAD_RE.exec(token)?.[0] ?? "";
    const tail = TRIM_TAIL_RE.exec(token)?.[0] ?? "";
    if (lead.length > 0 || tail.length > 0) {
      const core = token.slice(lead.length, token.length - tail.length);
      if (core.length >= 12 && core.length <= 80) {
        if (isPasswordLikeToken(core)) {
          out.push({ path, kind: "password" });
          return;
        }
        if (isHighEntropyToken(core)) {
          out.push({ path, kind: "entropy" });
          return;
        }
      }
    }
  }
}

function detectWalk(
  value: unknown,
  path: string,
  parentKey: string | undefined,
  out: CredentialWarning[],
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    detectInString(value, parentKey, path, out);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      detectWalk(value[i], `${path}[${i}]`, undefined, out);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      detectWalk(child, `${path}.${key}`, key, out);
    }
  }
}

/**
 * Non-destructively scans a payload (and optional preview string) for
 * credential-shaped values. Returns one warning per offending leaf so the
 * operator UI can render an "offending fields" list. Used by the AI
 * approval gate at submission time — see Task #477.
 *
 * The returned array is intentionally bounded (`maxWarnings` defaults to
 * 32) so a pathologically large payload cannot DoS the approval list view.
 */
export function detectCredentialLikeFields(
  payload: unknown,
  preview?: string | null,
  options: {
    rootPath?: string;
    previewPath?: string;
    maxWarnings?: number;
  } = {},
): CredentialWarning[] {
  const rootPath = options.rootPath ?? "payload";
  const previewPath = options.previewPath ?? "payload_preview";
  const maxWarnings = options.maxWarnings ?? 32;

  const collected: CredentialWarning[] = [];
  detectWalk(payload, rootPath, undefined, collected);
  if (typeof preview === "string" && preview.length > 0) {
    detectInString(preview, undefined, previewPath, collected);
  }

  // Deduplicate identical {path,kind,patternName} entries — a payload that
  // recursively embeds the same value (cyclic-ish refs serialised twice)
  // should not flood the warning list.
  const seen = new Set<string>();
  const deduped: CredentialWarning[] = [];
  for (const w of collected) {
    const key = `${w.path}|${w.kind}|${w.patternName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
    if (deduped.length >= maxWarnings) break;
  }
  return deduped;
}

/** Re-exported for unit tests and any caller that needs the raw heuristic. */
export { isPasswordLikeToken, isHighEntropyToken };

/**
 * Replaces credential-shaped substrings inside a free-form string with
 * REDACTED_SENTINEL.  Non-string inputs (and null/undefined) are returned
 * unchanged so callers can pipe optional values through unconditionally.
 *
 * Layered defense:
 *   1. Vendor-prefix regexes  — sk-…, ghp_…, JWT, bcrypt, AKIA, …
 *   2. Heuristic token scanner — password-strength + high-entropy tokens
 *      that the regex layer cannot match because they have no distinctive
 *      shape (Task #463).
 */
export function redactSecretLikeStrings(input: unknown): unknown {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const { regex } of SECRET_LIKE_PATTERNS) {
    out = out.replace(regex, REDACTED_SENTINEL);
  }
  out = redactCredentialLikeTokens(out) as string;
  return out;
}

/**
 * Recursively walks a JSON-serialisable payload and applies
 * `redactSecretLikeStrings` to every string leaf.  Object keys are NOT
 * altered (they are field names, not user data); only values are scrubbed.
 *
 * Used by `logEvent()` to defend against callers that build human-readable
 * audit summaries via string interpolation and accidentally embed a
 * credential in a value that the key-based deny-list cannot catch (because
 * the surrounding key is something innocuous like `summary` or `note`).
 */
export function deepRedactSecretLikeStrings(payload: any): any {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") return redactSecretLikeStrings(payload);
  if (Array.isArray(payload))
    return payload.map((item) => deepRedactSecretLikeStrings(item));
  if (typeof payload === "object") {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      out[key] = deepRedactSecretLikeStrings(value);
    }
    return out;
  }
  return payload;
}

export function isSensitiveField(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT_FIELDS.has(lower)) return true;
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  for (const prefix of SENSITIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Recursively walks a payload object and replaces the *values* of any keys
 * that match the deny list with REDACTED_SENTINEL.  Non-object primitives are
 * returned unchanged.  Arrays are walked element-by-element.
 *
 * @param payload   - The value to sanitize (may be any JSON-serialisable type)
 * @param fieldName - When the payload IS the secret (e.g. a plain string
 *                    stored under a sensitive column name in change_history),
 *                    pass the column name here and the whole value is redacted.
 */
export function redactSensitiveFields(payload: any, fieldName?: string): any {
  if (payload === null || payload === undefined) return payload;

  if (fieldName && isSensitiveField(fieldName)) {
    return REDACTED_SENTINEL;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => redactSensitiveFields(item));
  }

  if (typeof payload === "object") {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isSensitiveField(key)) {
        redacted[key] = REDACTED_SENTINEL;
      } else if (value !== null && typeof value === "object") {
        redacted[key] = redactSensitiveFields(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  return payload;
}

/**
 * Deep redaction that combines BOTH defenses in a single pass:
 *   1. Key-based deny list (`isSensitiveField`)        — values under
 *      sensitive field names are replaced with REDACTED_SENTINEL.
 *   2. Regex deny list (`SECRET_LIKE_PATTERNS`)        — every string leaf
 *      is scrubbed of credential-shaped substrings.
 *
 * Use this whenever a value leaves the server in a context where BOTH
 * a tool/library author may have named a field carelessly (e.g. `apiKey`
 * vs `api_key`) AND free-form strings may contain interpolated secrets
 * (e.g. an error message that includes the new token, or a `notes` field
 * that pasted the credential into prose).
 *
 * Invariant: this function returns a NEW value graph; the input is never
 * mutated, so it is safe to apply to objects shared with other callers.
 */
export function redactSensitiveDeep(payload: any, fieldName?: string): any {
  if (payload === null || payload === undefined) return payload;

  if (fieldName && isSensitiveField(fieldName)) {
    return REDACTED_SENTINEL;
  }

  if (typeof payload === "string") {
    // Detect string values that are themselves JSON (e.g. an audit row's
    // `description` whose author serialised an object into prose like
    // `{"mfa_secret":"..."}`). Without this branch the string is treated as
    // an opaque leaf and only the regex/heuristic pass runs against it,
    // missing key-name-based deny-list hits like `mfa_secret` whose VALUE is
    // a plain UUID with no distinctive shape (Task #741).
    //
    // Length guards keep us from spending time on multi-MB blobs that almost
    // certainly aren't JSON; the JSON.parse branch is also wrapped so a
    // value that merely happens to start with `{`/`[` (e.g. an interpolated
    // template literal) falls through unchanged to the regex pass.
    const trimmed = payload.length > 0 && payload.length < 1_000_000 ? payload.trimStart() : "";
    if (trimmed.length > 0 && (trimmed.charCodeAt(0) === 0x7b /* { */ || trimmed.charCodeAt(0) === 0x5b /* [ */)) {
      try {
        const parsed = JSON.parse(payload);
        if (parsed !== null && typeof parsed === "object") {
          // Recurse — `redactSensitiveDeep` will itself re-detect any
          // further JSON-string leaves, so JSON-of-JSON-of-… nests collapse
          // in a single top-level call.
          return JSON.stringify(redactSensitiveDeep(parsed));
        }
      } catch {
        /* not valid JSON — fall through to the regex pass */
      }
    }
    return redactSecretLikeStrings(payload);
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => redactSensitiveDeep(item));
  }

  if (typeof payload === "object") {
    const redacted: Record<string, any> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (isSensitiveField(key)) {
        redacted[key] = REDACTED_SENTINEL;
      } else {
        redacted[key] = redactSensitiveDeep(value);
      }
    }
    return redacted;
  }

  return payload;
}
