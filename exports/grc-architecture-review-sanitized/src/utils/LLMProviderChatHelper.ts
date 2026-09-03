// =======================================================================
// Raw-fetch LLMProvider Chat Completions helper — bypass `@ai-sdk/LLMProvider`.
//
// Why this exists: `@ai-sdk/<REDACTED_EMAIL>` returns model objects with
// `specVersion: "v3"` from BOTH `LLMProvider.responses(...)` AND
// `LLMProvider.chat(...)`. The runtime `generateText` shipped in `<REDACTED_EMAIL>`
// only accepts `specVersion: "v2"`, so every call dies inside the JS
// layer with "Unsupported model version v3 for provider LLMProvider.chat
// and model …" before ever reaching LLMProvider. Prior hotfix (PR #35)
// swapped bare-call → `.chat()` to dodge the responses adapter; that
// fixed the older v1 / v3-via-responses issue but `.chat()` itself
// now emits v3 too, so the same class of bug came back.
//
// Same pattern proven by `sdrBatchEvaluator.ts` (PR #36): hit
// /v1/chat/completions with raw fetch, zero SDK dependency, no
// version-mismatch surprise. This helper exposes a `generateText`-
// shaped function so call sites swap in with a one-line change.
// =======================================================================

import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "./LLMProviderCredentials";

export interface GenerateChatTextOptions {
  /** LLMProvider model id, e.g. "gpt-4o" or "gpt-4o-mini". */
  model: string;
  /** User-role prompt — same shape AI SDK's `generateText({ prompt })` accepts. */
  prompt: string;
  /** Optional system prompt — matches AI SDK's `generateText({ system })`. */
  system?: string;
  /** Optional max completion tokens. */
  maxTokens?: number;
  /** Optional temperature (defaults to LLMProvider's default of 1). */
  temperature?: number;
  /** Per-call timeout in ms — defaults to 60s. */
  timeoutMs?: number;
  /**
   * When set to "json_object", instructs LLMProvider to guarantee the
   * assistant message is a valid JSON object. The prompt MUST contain
   * the substring "JSON" or the LLMProvider API rejects the request. Use
   * this for structured-extraction prompts where downstream code does
   * `JSON.parse(text)` — eliminates the "model returned prose / fenced
   * code" parse-failure branch that produces "Analysis parsing failed".
   */
  responseFormat?: "json_object";
}

export interface GenerateChatTextResult {
  /** Concatenated text from the assistant message (single choice). */
  text: string;
  /** Raw LLMProvider response body for debugging / token-usage inspection. */
  raw: any;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function chatBaseUrl(): string {
  // Mirror the batch evaluator: prefer the integrations gateway when
  // configured AND paired with a valid key (the LLMProviderCredentials guard
  // handles that), else fall back to public LLMProvider. Avoids the modelfarm
  // proxy + dummy-key Russian-doll bug from earlier sessions.
  return getLLMProviderBaseUrl() || "<REDACTED_URL>";
}

function authHeader(): Record<string, string> {
  const key = getLLMProviderApiKey();
  if (!key) {
    throw new Error("LLMProvider_API_KEY is not configured");
  }
  return { Authorization: `Bearer ${key}` };
}

/**
 * Call LLMProvider Chat Completions and return the assistant's text. Drop-in
 * replacement for `generateText({ model: LLMProvider.chat(name), ... })` —
 * same return shape, zero `@ai-sdk/LLMProvider` dependency. Throws on HTTP
 * failure with the LLMProvider error body in the message so existing error
 * surfacing in callers stays informative.
 */
export async function generateChatText(
  opts: GenerateChatTextOptions,
): Promise<GenerateChatTextResult> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system && opts.system.trim()) {
    messages.push({ role: "system", content: opts.system });
  }
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, any> = {
    model: opts.model,
    messages,
  };
  if (typeof opts.maxTokens === "number") body.max_tokens = opts.maxTokens;
  if (typeof opts.temperature === "number") body.temperature = opts.temperature;
  if (opts.responseFormat === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const url = `${chatBaseUrl()}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    ...authHeader(),
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    // Slice so a giant error doesn't blow out the log. Status code stays
    // accessible via the thrown Error message for callers that branch on it.
    throw new Error(
      `LLMProvider /chat/completions ${res.status}: ${errBody.slice(0, 800)}`,
    );
  }

  const data = await res.json();
  const text =
    data?.choices?.[0]?.message?.content?.toString?.() ??
    String(data?.choices?.[0]?.message?.content ?? "");
  return { text, raw: data };
}
