/**
 * Resolve LLMProvider credentials with a length-guard precedence rule.
 *
 * Background
 * ----------
 * Every agent / tool / route in the platform reads
 * `process.env.AI_INTEGRATIONS_LLMProvider_API_KEY || process.env.LLMProvider_API_KEY`.
 * The first variable is supposed to be the org-managed integration secret;
 * the second is the developer-installed fallback. The naive `||` precedence
 * means *any* truthy value in the first slot wins — including obviously
 * invalid stubs.
 *
 * Observed failure: AI_INTEGRATIONS_LLMProvider_API_KEY was set to a 15-char
 * placeholder while LLMProvider_API_KEY held the real 164-char key. The naive
 * precedence picked the placeholder; every LLMProvider call 401'd with no
 * obvious root cause from the dashboard. The Mastra adapter incompatibility
 * masked the underlying auth issue until that was fixed.
 *
 * Fix: ignore AI_INTEGRATIONS when it's too short to be a real key. Real
 * LLMProvider API keys are 51+ chars (legacy `sk-…`) or 100+ chars (`<REDACTED_TOKEN>`),
 * so 40 is a conservative floor that rejects any plausible stub or
 * truncation without flagging a real key.
 *
 * All call sites should use these helpers instead of reading the env vars
 * directly so the guard can't be bypassed by drift.
 */

import { logger } from "./logger";

const MIN_VALID_KEY_LENGTH = 40;

let warnedShortKey = false;
let warnedFallbackBypassesProxy = false;

/**
 * True when the AI_INTEGRATIONS_LLMProvider_API_KEY env var holds a value that
 * looks like a real LLMProvider key (length >= MIN_VALID_KEY_LENGTH). Used by
 * `getLLMProviderBaseUrl()` to gate whether the integrations gateway URL is
 * honoured. Sending a real `LLMProvider_API_KEY` to the modelfarm proxy yields
 * a 401 with no useful root-cause signal; pairing them is the Russian-doll
 * bug we hit in the prior session, so refuse to expose that combination.
 */
function aiIntegrationsKeyIsValid(): boolean {
  const ai = process.env.AI_INTEGRATIONS_LLMProvider_API_KEY;
  return !!(ai && ai.length >= MIN_VALID_KEY_LENGTH);
}

/**
 * Resolved LLMProvider API key, or undefined if neither env var is set or both
 * are too short. Logs once per process if AI_INTEGRATIONS key is present
 * but rejected for being too short, so the fallback is visible in logs.
 */
/** One-line masked view of a key: first 3 + last 4 + length. Never the value. */
function maskKey(k?: string): string {
  return k ? `${k.slice(0, 3)}…${k.slice(-4)} (len ${k.length})` : "(unset)";
}

/**
 * Force the DIRECT LLMProvider key (Sample User 2026-07-28). When LLMProvider_FORCE_DIRECT is
 * truthy, ignore AI_INTEGRATIONS_LLMProvider_API_KEY entirely and use LLMProvider_API_KEY
 * against <REDACTED_HOST>. This is the reliable way to make a personal Tier-4
 * key take effect without having to delete the AI_INTEGRATIONS secret (which the
 * HostingPlatform integration can re-populate). Default off = existing behaviour.
 */
export function forceDirectLLMProvider(): boolean {
  const v = (process.env.LLMProvider_FORCE_DIRECT || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

let loggedActiveSource = false;
function logActiveSourceOnce(source: string, key?: string): void {
  if (loggedActiveSource) return;
  loggedActiveSource = true;
  logger.info(
    `[LLMProviderCredentials] active LLMProvider key source = ${source} · ${maskKey(key)}` +
      (forceDirectLLMProvider() ? " · LLMProvider_FORCE_DIRECT=on" : ""),
  );
}

export function getLLMProviderApiKey(): string | undefined {
  const ai = process.env.AI_INTEGRATIONS_LLMProvider_API_KEY;
  const fallback = process.env.LLMProvider_API_KEY;

  // Explicit override: use the direct LLMProvider_API_KEY, skip the gateway key.
  if (forceDirectLLMProvider() && fallback) {
    logActiveSourceOnce("LLMProvider_API_KEY (forced direct)", fallback);
    return fallback;
  }

  if (ai && ai.length >= MIN_VALID_KEY_LENGTH) {
    logActiveSourceOnce("AI_INTEGRATIONS_LLMProvider_API_KEY", ai);
    return ai;
  }

  if (ai && ai.length > 0 && ai.length < MIN_VALID_KEY_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true;
      logger.warn(
        `[LLMProviderCredentials] AI_INTEGRATIONS_LLMProvider_API_KEY is only ${ai.length} ` +
          `chars (need >=${MIN_VALID_KEY_LENGTH}) — ignoring it and falling back ` +
          `to LLMProvider_API_KEY${fallback ? "" : " (which is also not set)"}.`,
      );
    }
  }

  if (fallback) logActiveSourceOnce("LLMProvider_API_KEY (fallback)", fallback);
  return fallback || undefined;
}

/**
 * Resolved LLMProvider base URL for routing through the AI integrations gateway.
 * Returns undefined when unset so callers can use the LLMProvider default.
 *
 * Russian-doll guard: when the AI_INTEGRATIONS key is missing or too short
 * to be real, `getLLMProviderApiKey()` falls back to LLMProvider_API_KEY. Returning
 * the gateway base URL in that case would route a real `sk-…` key through
 * the gateway, which rejects it. Force-undefined the base URL when the
 * gateway key isn't usable so callers default to <REDACTED_HOST>.
 */
export function getLLMProviderBaseUrl(): string | undefined {
  // Forced direct → never route through the gateway; use <REDACTED_HOST>.
  if (forceDirectLLMProvider()) return undefined;
  const v = process.env.AI_INTEGRATIONS_LLMProvider_BASE_URL;
  if (!v || !v.trim()) return undefined;
  if (!aiIntegrationsKeyIsValid()) {
    if (!warnedFallbackBypassesProxy) {
      warnedFallbackBypassesProxy = true;
      logger.warn(
        "[LLMProviderCredentials] AI_INTEGRATIONS_LLMProvider_BASE_URL is set but " +
          "AI_INTEGRATIONS_LLMProvider_API_KEY is missing or too short — " +
          "ignoring the gateway URL so the LLMProvider_API_KEY fallback isn't " +
          "routed through the wrong endpoint.",
      );
    }
    return undefined;
  }
  return v;
}

/**
 * True when at least one valid LLMProvider credential is configured. Replaces
 * the common `!!(AI_INTEGRATIONS_LLMProvider_API_KEY || LLMProvider_API_KEY)` check,
 * which incorrectly reported "configured" when AI_INTEGRATIONS held an
 * invalid stub.
 */
export function hasLLMProviderApiKey(): boolean {
  return !!getLLMProviderApiKey();
}
