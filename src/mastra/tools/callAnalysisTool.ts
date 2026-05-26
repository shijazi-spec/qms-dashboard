import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getOpenAIApiKey, getOpenAIBaseUrl } from "../../utils/openaiCredentials";

export const callAnalysisTool = createTool({
  id: "call-analysis-tool",
  description: "Analyzes a call transcript to extract sentiment, objections, voice of customer, key topics, and action items. Uses AI to generate insights and recommendations.",
  inputSchema: z.object({
    call_record_id: z.number().describe("ID of the call record to analyze"),
    transcript: z.string().describe("Full transcript text of the call"),
    agent_type: z.enum(["sdr", "sales"]).default("sdr").describe("Type of agent for QA scoring context"),
    include_qa_scoring: z.boolean().default(true).describe("Whether to also generate QA scores")
  }),
  outputSchema: z.object({
    success: z.boolean(),
    call_record_id: z.number(),
    analysis: z.object({
      sentiment_score: z.number(),
      sentiment_label: z.string(),
      voice_of_customer: z.string().optional(),
      objections_detected: z.array(z.object({
        objection: z.string(),
        response: z.string().optional(),
        handled_well: z.boolean().optional()
      })).optional(),
      key_topics: z.array(z.string()).optional(),
      action_items: z.array(z.string()).optional(),
      next_steps: z.array(z.string()).optional(),
      call_summary: z.string(),
      ai_insights: z.string().optional()
    }).optional(),
    qa_score: z.object({
      total_score: z.number(),
      max_score: z.number(),
      score_percentage: z.number(),
      criteria_scores: z.record(z.number()).optional(),
      strengths: z.array(z.string()).optional(),
      improvements: z.array(z.string()).optional(),
      coaching_notes: z.string().optional()
    }).optional(),
    message: z.string()
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔬 [CallAnalysis] Starting call analysis", { 
      call_record_id: context.call_record_id,
      agent_type: context.agent_type
    });

    try {
      const { 
        saveTranscript, 
        saveCallAnalysis, 
        saveQAScore, 
        updateCallRecord,
        getCallRecordById 
      } = await import("../../utils/callIntelligenceDb");

      const callRecord = await getCallRecordById(context.call_record_id);
      if (!callRecord) {
        throw new Error(`Call record not found: ${context.call_record_id}`);
      }

      await updateCallRecord(context.call_record_id, { status: "transcribing" });

      await saveTranscript({
        call_record_id: context.call_record_id,
        transcript_text: context.transcript,
        language: "en",
        confidence_score: 95
      });

      logger?.info("📝 [CallAnalysis] Transcript saved, starting AI analysis");

      const analysisPrompt = `Analyze the following sales/SDR call transcript and provide a comprehensive analysis.

TRANSCRIPT:
${context.transcript}

Please provide your analysis in the following JSON format:
{
  "sentiment_score": <number 0-100, where 0 is very negative, 50 is neutral, 100 is very positive>,
  "sentiment_label": "<positive|neutral|negative>",
  "voice_of_customer": "<summary of customer's key concerns, needs, and feedback>",
  "objections_detected": [
    {
      "objection": "<the objection raised>",
      "response": "<how the agent responded>",
      "handled_well": <true/false>
    }
  ],
  "key_topics": ["<topic1>", "<topic2>"],
  "action_items": ["<action1>", "<action2>"],
  "next_steps": ["<step1>", "<step2>"],
  "call_summary": "<2-3 sentence summary of the call>",
  "ai_insights": "<key insights and recommendations for the agent>"
}

Respond ONLY with the JSON, no additional text.`;

      const qaPrompt = context.include_qa_scoring ? `
Based on the same transcript, score the ${context.agent_type.toUpperCase()} agent on these criteria (0-10 each):

${context.agent_type === 'sdr' ? `
1. Opening & Introduction (professionalism, energy, clarity)
2. Discovery Questions (quality, relevance, depth)
3. Active Listening (acknowledgment, follow-up questions)
4. Value Proposition (clarity, relevance to customer needs)
5. Objection Handling (confidence, accuracy, persuasiveness)
6. Call Control (pace, direction, time management)
7. Next Steps & Close (clear action items, commitment secured)
8. CRM Compliance Language (mentioning notes, follow-ups)
` : `
1. Rapport Building (connection, trust establishment)
2. Needs Discovery (comprehensive, consultative approach)
3. Solution Presentation (tailored, value-focused)
4. Competitive Positioning (differentiation, confidence)
5. Pricing & Negotiation (confidence, value justification)
6. Objection Resolution (thorough, professional)
7. Closing Techniques (appropriate urgency, clear asks)
8. Follow-up Commitments (specific, time-bound)
`}

Provide in JSON format:
{
  "criteria_scores": {
    "criterion_name": <score 0-10>
  },
  "total_score": <sum of all scores>,
  "max_score": 80,
  "score_percentage": <percentage>,
  "strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>"],
  "coaching_notes": "<specific coaching recommendation>"
}

Respond ONLY with the JSON.` : '';

      const { createOpenAI } = await import("@ai-sdk/openai");
      const { generateText } = await import("ai");

      const openai = createOpenAI({
        baseURL: getOpenAIBaseUrl(),
        apiKey: getOpenAIApiKey()
      });

      // Raw-fetch /chat/completions — `.chat()` now also returns v3-spec
      // models under @ai-sdk/openai 3.x, broken under ai@5 (needs v2).
      // Helper drops the SDK dependency for this hot path entirely.
      const { generateChatText } = await import("../../utils/openaiChatHelper");
      const analysisResult = await generateChatText({
        model: "gpt-4o",
        prompt: analysisPrompt,
        maxTokens: 2000,
      });

      let analysisData;
      try {
        const cleanedText = analysisResult.text.replace(/```json\n?|\n?```/g, '').trim();
        analysisData = JSON.parse(cleanedText);
      } catch (parseError) {
        logger?.warn("⚠️ [CallAnalysis] Failed to parse analysis JSON, using defaults");
        analysisData = {
          sentiment_score: 50,
          sentiment_label: "neutral",
          call_summary: "Unable to parse AI analysis",
          voice_of_customer: "",
          objections_detected: [],
          key_topics: [],
          action_items: [],
          next_steps: [],
          ai_insights: ""
        };
      }

      const savedAnalysis = await saveCallAnalysis({
        call_record_id: context.call_record_id,
        sentiment_score: analysisData.sentiment_score,
        sentiment_label: analysisData.sentiment_label,
        voice_of_customer: analysisData.voice_of_customer,
        objections_detected: analysisData.objections_detected,
        key_topics: analysisData.key_topics,
        action_items: analysisData.action_items,
        next_steps: analysisData.next_steps,
        call_summary: analysisData.call_summary,
        ai_insights: analysisData.ai_insights
      });

      logger?.info("✅ [CallAnalysis] Analysis saved", { id: savedAnalysis.id });

      let qaScoreData = null;
      if (context.include_qa_scoring && qaPrompt) {
        // Reuse the same helper imported above for the QA scoring call.
        const qaResult = await generateChatText({
          model: "gpt-4o",
          prompt: qaPrompt,
          maxTokens: 1000,
        });

        try {
          const cleanedQA = qaResult.text.replace(/```json\n?|\n?```/g, '').trim();
          qaScoreData = JSON.parse(cleanedQA);

          const savedQAScore = await saveQAScore({
            call_record_id: context.call_record_id,
            scorecard_type: context.agent_type,
            total_score: qaScoreData.total_score,
            max_score: qaScoreData.max_score,
            score_percentage: qaScoreData.score_percentage,
            criteria_scores: qaScoreData.criteria_scores,
            strengths: qaScoreData.strengths,
            improvements: qaScoreData.improvements,
            coaching_notes: qaScoreData.coaching_notes,
            evaluator: "AI"
          });

          logger?.info("✅ [CallAnalysis] QA score saved", { id: savedQAScore.id });
        } catch (qaParseError) {
          logger?.warn("⚠️ [CallAnalysis] Failed to parse QA score JSON");
        }
      }

      await updateCallRecord(context.call_record_id, { status: "evaluated" });

      logger?.info("✅ [CallAnalysis] Call analysis completed", { 
        call_record_id: context.call_record_id 
      });

      return {
        success: true,
        call_record_id: context.call_record_id,
        analysis: {
          sentiment_score: analysisData.sentiment_score,
          sentiment_label: analysisData.sentiment_label,
          voice_of_customer: analysisData.voice_of_customer,
          objections_detected: analysisData.objections_detected,
          key_topics: analysisData.key_topics,
          action_items: analysisData.action_items,
          next_steps: analysisData.next_steps,
          call_summary: analysisData.call_summary,
          ai_insights: analysisData.ai_insights
        },
        qa_score: qaScoreData ? {
          total_score: qaScoreData.total_score,
          max_score: qaScoreData.max_score,
          score_percentage: qaScoreData.score_percentage,
          criteria_scores: qaScoreData.criteria_scores,
          strengths: qaScoreData.strengths,
          improvements: qaScoreData.improvements,
          coaching_notes: qaScoreData.coaching_notes
        } : undefined,
        message: "Call analysis completed successfully"
      };
    } catch (error) {
      logger?.error("❌ [CallAnalysis] Analysis failed", { 
        error: error instanceof Error ? error.message : String(error) 
      });

      const { updateCallRecord } = await import("../../utils/callIntelligenceDb");
      await updateCallRecord(context.call_record_id, { status: "failed" });

      return {
        success: false,
        call_record_id: context.call_record_id,
        message: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
});
