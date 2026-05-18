/**
 * Resolve OpenAI credentials with a length-guard precedence rule.
 *
 * Background
 * ----------
 * Every agent / tool / route in the platform reads
 * `process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY`.
 * The first variable is supposed to be the org-managed integration secret;
 * the second is the developer-installed fallback. The naive `||` precedence
 * means *any* truthy value in the first slot wins — including obviously
 * invalid stubs.
 *
 * Observed failure: AI_INTEGRATIONS_OPENAI_API_KEY was set to a 15-char
 * placeholder while OPENAI_API_KEY held the real 164-char key. The naive
 * precedence picked the placeholder; every OpenAI call 401'd with no
 * obvious root cause from the dashboard. The Mastra adapter incompatibility
 * masked the underlying auth issue until that was fixed.
 *
 * Fix: ignore AI_INTEGRATIONS when it's too short to be a real key. Real
 * OpenAI API keys are 51+ chars (legacy `sk-…`) or 100+ chars (`sk-proj-…`),
 * so 40 is a conservative floor that rejects any plausible stub or
 * truncation without flagging a real key.
 *
 * All call sites should use these helpers instead of reading the env vars
 * directly so the guard can't be bypassed by drift.
 */

const MIN_VALID_KEY_LENGTH = 40;

let warnedShortKey = false;

/**
 * Resolved OpenAI API key, or undefined if neither env var is set or both
 * are too short. Logs once per process if AI_INTEGRATIONS key is present
 * but rejected for being too short, so the fallback is visible in logs.
 */
export function getOpenAIApiKey(): string | undefined {
  const ai = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const fallback = process.env.OPENAI_API_KEY;

  if (ai && ai.length >= MIN_VALID_KEY_LENGTH) return ai;

  if (ai && ai.length > 0 && ai.length < MIN_VALID_KEY_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[openaiCredentials] AI_INTEGRATIONS_OPENAI_API_KEY is only ${ai.length} ` +
          `chars (need >=${MIN_VALID_KEY_LENGTH}) — ignoring it and falling back ` +
          `to OPENAI_API_KEY${fallback ? "" : " (which is also not set)"}.`,
      );
    }
  }

  return fallback || undefined;
}

/**
 * Resolved OpenAI base URL for routing through the AI integrations gateway.
 * Returns undefined when unset so callers can use the OpenAI default.
 */
export function getOpenAIBaseUrl(): string | undefined {
  const v = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  return v && v.trim() ? v : undefined;
}

/**
 * True when at least one valid OpenAI credential is configured. Replaces
 * the common `!!(AI_INTEGRATIONS_OPENAI_API_KEY || OPENAI_API_KEY)` check,
 * which incorrectly reported "configured" when AI_INTEGRATIONS held an
 * invalid stub.
 */
export function hasOpenAIApiKey(): boolean {
  return !!getOpenAIApiKey();
}
