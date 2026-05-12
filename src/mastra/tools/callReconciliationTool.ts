import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  initCallIntelligenceTables,
  getCallWithFullAnalysis,
} from "../../utils/callIntelligenceDb";
import { buildTranscriptVsEvaluationReport } from "../../utils/callMcpReconciliation";

export const reconcileCallTool = createTool({
  id: "reconcile-call",
  description:
    "Run the full transcript-vs-evaluation reconciliation report for an ingested call. Fetches the call record, transcript, QA score, and analysis; runs heuristics (lead link, QA-vs-talk-time, coaching themes) and SDR Governance 2.1 JSON rules; returns the merged report including a governance block. Returns null if the call_record_id does not exist.",
  inputSchema: z.object({
    call_record_id: z
      .number()
      .int()
      .positive()
      .describe("Primary key of the row in call_records to reconcile."),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    report: z
      .object({
        call_record_id: z.number(),
        lead_id: z.string().nullable(),
        agent_email: z.string().nullable(),
        transcript_chars: z.number(),
        qa_score_percentage: z.number().nullable(),
        talk_ratio: z.number().nullable(),
        sentiment_label: z.string().nullable(),
        issues: z.array(
          z.object({
            code: z.string(),
            severity: z.enum(["info", "warning", "critical"]),
            message: z.string(),
            suggestion: z.string().optional(),
          }),
        ),
        checks: z.object({
          transcript_present: z.boolean(),
          qa_present: z.boolean(),
          analysis_present: z.boolean(),
          lead_linked: z.boolean(),
        }),
        governance: z
          .object({
            ruleset_version: z.string().nullable(),
            rules_evaluated: z.number(),
            load_error: z.string().nullable(),
            source_artifacts: z.array(z.string()),
            governance_issue_count: z.number(),
          })
          .optional(),
      })
      .nullable(),
  }),
  execute: async ({ context }) => {
    await initCallIntelligenceTables();
    const bundle = await getCallWithFullAnalysis(context.call_record_id);
    if (!bundle.record) {
      return { found: false, report: null };
    }

    const report = buildTranscriptVsEvaluationReport({
      call_record_id: context.call_record_id,
      lead_id: bundle.record.lead_id,
      agent_email: bundle.record.agent_email,
      transcript_text: bundle.transcript?.transcript_text ?? null,
      talk_ratio: bundle.analysis?.talk_ratio ?? null,
      sentiment_label: bundle.analysis?.sentiment_label ?? null,
      qa_score_percentage: bundle.qaScore?.score_percentage ?? null,
      improvements: bundle.qaScore?.improvements ?? null,
    });

    return { found: true, report };
  },
});
