/**
 * Phase B — Auto SDR scorecard evaluation after analysis completes.
 *
 * When a call's analysis pipeline (transcribe → analyze sentiment/QA)
 * finishes successfully, this helper applies the active SDR scorecard to
 * the call automatically. The result is persisted to `sdr_call_evaluations`
 * so the SDR Evaluation tab list, the per-agent Avg QA Score in Analytics,
 * and any downstream coaching workflow have real data to render.
 *
 * Designed to be called in a fire-and-forget pattern from the analyze
 * success path: failures are caught, logged, and swallowed so a scorecard
 * miss never breaks the underlying analysis. The standalone
 * `POST /api/calls/:id/sdr-evaluate` endpoint is still available for
 * manual re-runs and for backfilling calls that predate this hook.
 */
import {
  getCallRecordById,
  getTranscriptByCallId,
  getActiveSDRScorecard,
  buildSDREvaluationPrompt,
  saveSDREvaluation,
  updateCallStatus,
} from "./callIntelligenceDb";
import { getOpenAIApiKey, getOpenAIBaseUrl } from "./openaiCredentials";
import { logger } from "./logger";
import { logEvent } from "./eventLogsDatabase";

// Retry transient OpenAI failures (429 / 5xx) with exponential backoff.
// Permanent errors (auth, quota, bad request, parse) throw immediately so
// we don't spin on a doomed request.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BACKOFF_MS = [1500, 4000];

async function generateWithRetry(
  _unusedSdk: any,
  prompt: string,
  callId: number,
): Promise<{ text: string }> {
  // Raw-fetch chat completions via generateChatText — bypasses the
  // `@ai-sdk/openai` v3-spec regression that broke `aiSdk.chat(...)`
  // calls in production. Same retry + backoff behaviour, same return
  // shape, zero SDK dependency. The `_unusedSdk` parameter is kept for
  // signature stability with existing callers; remove on the next
  // refactor pass.
  const { generateChatText } = await import("./openaiChatHelper");
  let lastErr: any = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateChatText({
        model: "gpt-4o-mini",
        prompt,
        maxTokens: 8000,
        // Force structured JSON output so the downstream JSON.parse can't
        // trip on fenced code blocks or stray prose — the failure mode
        // that left every attribute showing "NA" with skipReason
        // "ai_parse_failed". The SDR prompt already contains the literal
        // word "JSON" (required by OpenAI when response_format is set).
        responseFormat: "json_object",
      });
    } catch (err: any) {
      lastErr = err;
      // Status may come back embedded in the error message string
      // (helper throws `OpenAI /chat/completions <STATUS>: ...`). Pull
      // it back out for the retry decision so 429/5xx still get the
      // exponential-backoff path that kept the original implementation
      // resilient to OpenAI hiccups.
      const fromMsg = /OpenAI \/chat\/completions (\d+):/.exec(
        err?.message || "",
      );
      const status =
        err?.statusCode ||
        err?.status ||
        err?.response?.status ||
        (fromMsg ? parseInt(fromMsg[1], 10) : null);
      const isRetryable =
        status != null && RETRYABLE_STATUS_CODES.has(status);
      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }
      const waitMs = BACKOFF_MS[attempt] ?? 5000;
      logger.warn(
        `[SDRAutoEval] Retryable error on call ${callId} (status ${status}, attempt ${attempt + 1}/${MAX_RETRIES + 1}); backing off ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export interface AutoEvalOutcome {
  ran: boolean;
  evaluationId?: number;
  scorecardId?: number;
  overallScore?: number;
  skipReason?:
    | "no_call_record"
    | "no_transcript"
    | "no_active_scorecard"
    | "ai_call_failed"
    | "ai_parse_failed"
    | "save_failed"
    | "unknown_error";
  error?: string;
}

/**
 * Apply the active SDR scorecard to one analyzed call. Idempotent in the
 * sense that re-running on the same call simply produces a new evaluation
 * row (no de-dup logic intentionally — operators reviewing the evaluation
 * history can compare runs).
 */
export async function triggerSDREvaluationForCall(
  callId: number,
  teamName: string = "SDR",
): Promise<AutoEvalOutcome> {
  try {
    const callRecord = await getCallRecordById(callId);
    if (!callRecord) {
      return { ran: false, skipReason: "no_call_record" };
    }

    const transcript = await getTranscriptByCallId(callId);
    if (!transcript?.transcript_text) {
      logger.info(
        `[SDRAutoEval] Skipping call ${callId} — no transcript yet`,
      );
      return { ran: false, skipReason: "no_transcript" };
    }

    const scorecard = await getActiveSDRScorecard(teamName);
    if (!scorecard) {
      logger.info(
        `[SDRAutoEval] Skipping call ${callId} — no active SDR scorecard for team ${teamName}`,
      );
      return { ran: false, skipReason: "no_active_scorecard" };
    }

    const evaluationPrompt = buildSDREvaluationPrompt(
      transcript.transcript_text,
      scorecard,
    );

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    const aiSdk = createOpenAI({
      baseURL: getOpenAIBaseUrl(),
      apiKey: getOpenAIApiKey(),
    });

    let aiResult;
    try {
      // gpt-4o-mini (via generateWithRetry) — 75% cheaper than gpt-4o with
      // comparable quality on structured JSON output. Retries on 429 / 5xx
      // transient OpenAI failures with exponential backoff so a brief
      // network blip never kills a scorecard evaluation.
      aiResult = await generateWithRetry(aiSdk, evaluationPrompt, callId);
    } catch (aiErr: any) {
      logger.warn(
        `[SDRAutoEval] AI call failed for call ${callId}: ${aiErr?.message || aiErr}`,
      );
      return {
        ran: false,
        skipReason: "ai_call_failed",
        error: aiErr?.message || String(aiErr),
      };
    }

    let evaluationData: any;
    try {
      const cleaned = aiResult.text.replace(/```json\n?|\n?```/g, "").trim();
      evaluationData = JSON.parse(cleaned);
    } catch (parseErr: any) {
      logger.warn(
        `[SDRAutoEval] Failed to parse AI JSON for call ${callId}: ${parseErr?.message || parseErr}`,
      );
      return {
        ran: false,
        skipReason: "ai_parse_failed",
        error: parseErr?.message || String(parseErr),
      };
    }

    const evaluation = {
      call_record_id: callId,
      scorecard_id: scorecard.id,
      scorecard_name: scorecard.name,
      overall_score: evaluationData.overall_summary?.overall_score || 0,
      dimension_scores: evaluationData.overall_summary?.dimension_scores || {
        people: 0,
        process: 0,
        governance: 0,
      },
      attribute_evaluations: evaluationData.attribute_evaluations || [],
      top_strengths: evaluationData.overall_summary?.top_strengths || [],
      top_gaps: evaluationData.overall_summary?.top_gaps || [],
      coaching_actions:
        evaluationData.overall_summary?.coaching_actions || [],
      critical_risks: evaluationData.overall_summary?.critical_risks || [],
      coaching_message_ar:
        evaluationData.coaching_recommendation?.message_ar || "",
      coaching_message_en:
        evaluationData.coaching_recommendation?.message_en || "",
      micro_training_topics:
        evaluationData.coaching_recommendation?.micro_training_topics || [],
      key_moments: evaluationData.transcript_analysis?.key_moments || {},
      evaluated_at: new Date(),
    };

    let evaluationId: number;
    try {
      evaluationId = await saveSDREvaluation(evaluation as any);
      await updateCallStatus(callId, "evaluated");
    } catch (saveErr: any) {
      logger.warn(
        `[SDRAutoEval] Save failed for call ${callId}: ${saveErr?.message || saveErr}`,
      );
      return {
        ran: false,
        skipReason: "save_failed",
        error: saveErr?.message || String(saveErr),
      };
    }

    logger.info(
      `[SDRAutoEval] Call ${callId} evaluated — score ${evaluation.overall_score}, scorecard ${scorecard.id} (${scorecard.name})`,
    );

    // Audit-trail — durable evidence that this AI evaluation happened, what
    // scorecard version was used, and what score landed. Required for
    // ISO 9001 + PDPL audit-trail compliance on AI-assisted decisions.
    // Wrapped so a logging hiccup never invalidates the evaluation itself.
    try {
      await logEvent({
        actionType: "sdr_auto_evaluation",
        entityType: "call_record",
        entityId: String(callId),
        module: "calls",
        severity: evaluation.overall_score < 60 ? "WARNING" : "INFO",
        aiInvolved: true,
        description: `AI scored call ${callId} against scorecard "${scorecard.name}" — overall ${evaluation.overall_score}/100`,
        newValue: {
          evaluation_id: evaluationId,
          scorecard_id: scorecard.id,
          scorecard_name: scorecard.name,
          overall_score: evaluation.overall_score,
          dimension_scores: evaluation.dimension_scores,
        },
      });
    } catch (logErr: any) {
      logger.warn(
        `[SDRAutoEval] event_logs audit write failed for call ${callId}: ${logErr?.message || logErr}`,
      );
    }

    // Coaching loop hook (P1, 2026-05-25). Two responsibilities:
    //   - Detection: re-scan the agent's last-14d evals for attribute
    //     failures crossing the 3-call threshold → open / refresh
    //     a coaching plan.
    //   - Verification: close any awaiting-verification plans where
    //     the just-saved eval now PASSes (or marks regression).
    // Best-effort — never blocks the evaluation response on a coaching
    // plan failure. Lives in its own module so the eval path doesn't
    // import the coaching API surface.
    try {
      const { onSdrEvaluationSaved } = await import("./coachingPlans");
      const callRow = await (await import("./callIntelligenceDb")).getCallRecordById(callId);
      await onSdrEvaluationSaved(
        callId,
        callRow?.agent_email,
        evaluation.attribute_evaluations as any,
        { logger },
      );
    } catch (coachErr: any) {
      logger.warn(
        `[SDRAutoEval] coaching plan hook threw for call ${callId}: ${coachErr?.message || coachErr}`,
      );
    }

    return {
      ran: true,
      evaluationId,
      scorecardId: scorecard.id,
      overallScore: evaluation.overall_score,
    };
  } catch (err: any) {
    logger.warn(
      `[SDRAutoEval] Unexpected error for call ${callId}: ${err?.message || err}`,
    );
    return {
      ran: false,
      skipReason: "unknown_error",
      error: err?.message || String(err),
    };
  }
}
