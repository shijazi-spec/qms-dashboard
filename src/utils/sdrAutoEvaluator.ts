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
      // gpt-4o-mini — ~75% cheaper than gpt-4o with comparable quality on
      // the structured 18-attribute JSON output. Keeps Phase B
      // fire-and-forget evaluation cost-friendly even at SDR-team scale.
      aiResult = await generateText({
        model: aiSdk("gpt-4o-mini"),
        prompt: evaluationPrompt,
        maxTokens: 8000,
      });
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
      await updateCallStatus(callId, "analyzed");
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
