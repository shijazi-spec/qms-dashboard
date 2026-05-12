/**
 * Programmatic SDR call validation orchestrator.
 *
 * Given a call_record_id, runs the full validation flow:
 *   1. Fetch call + transcript + analysis + QA score
 *   2. Reconcile transcript vs evaluation (heuristics + SDR Governance 2.1 JSON rules)
 *   3. If no lead is linked, attempt Zoho Leads phone match (best-effort)
 *   4. Roll issues up by severity and emit suggested CRM updates
 *
 * This module is the pure-function counterpart to the upgraded sdrQualityAgent's
 * AI-driven flow — the agent uses the same building blocks via Mastra tools.
 */

import {
  getCallWithFullAnalysis,
  initCallIntelligenceTables,
} from "./callIntelligenceDb";
import {
  buildTranscriptVsEvaluationReport,
  type ReconciliationIssue,
  type TranscriptVsEvaluationReport,
} from "./callMcpReconciliation";
import { findLeadsByPhoneMatch, type LeadPhoneMatch } from "./callLeadPhoneMatch";

export interface SdrCallValidationVerdict {
  verdict: "ok" | "needs_attention" | "critical";
  critical_count: number;
  warning_count: number;
  info_count: number;
  suggested_updates: string[];
}

export interface SdrCallValidationResult {
  found: boolean;
  call_record_id: number;
  source?: string;
  agent_email?: string | null;
  contact_phone?: string | null;
  report?: TranscriptVsEvaluationReport;
  lead_match?: {
    queried: boolean;
    normalized_query: string;
    scanned: number;
    matches: LeadPhoneMatch[];
    note?: string;
  };
  verdict?: SdrCallValidationVerdict;
}

function summarizeVerdict(issues: ReconciliationIssue[]): SdrCallValidationVerdict {
  let critical_count = 0;
  let warning_count = 0;
  let info_count = 0;
  for (const i of issues) {
    if (i.severity === "critical") critical_count++;
    else if (i.severity === "warning") warning_count++;
    else info_count++;
  }

  const suggested_updates: string[] = [];
  for (const i of issues) {
    if (i.suggestion) suggested_updates.push(`[${i.code}] ${i.suggestion}`);
  }

  const verdict: SdrCallValidationVerdict["verdict"] =
    critical_count > 0 ? "critical" : warning_count > 0 ? "needs_attention" : "ok";

  return { verdict, critical_count, warning_count, info_count, suggested_updates };
}

/**
 * Run the full programmatic SDR validation flow for a single call_record_id.
 * Pure programmatic — no LLM calls. Use this from the REST route or as a baseline
 * for MCP evals; the upgraded sdrQualityAgent layers AI reasoning on the same tools.
 */
export async function runSdrCallValidation(
  callRecordId: number,
): Promise<SdrCallValidationResult> {
  await initCallIntelligenceTables();
  const bundle = await getCallWithFullAnalysis(callRecordId);
  if (!bundle.record) {
    return { found: false, call_record_id: callRecordId };
  }

  const report = buildTranscriptVsEvaluationReport({
    call_record_id: callRecordId,
    lead_id: bundle.record.lead_id,
    agent_email: bundle.record.agent_email,
    transcript_text: bundle.transcript?.transcript_text ?? null,
    talk_ratio: bundle.analysis?.talk_ratio ?? null,
    sentiment_label: bundle.analysis?.sentiment_label ?? null,
    qa_score_percentage: bundle.qaScore?.score_percentage ?? null,
    improvements: bundle.qaScore?.improvements ?? null,
  });

  let lead_match: SdrCallValidationResult["lead_match"] | undefined;
  const contactPhone =
    (bundle.record.metadata as Record<string, unknown> | undefined)?.phone as
      | string
      | undefined;

  if (!bundle.record.lead_id && contactPhone) {
    try {
      const match = await findLeadsByPhoneMatch(contactPhone);
      lead_match = {
        queried: true,
        normalized_query: match.normalized_query,
        scanned: match.scanned,
        matches: match.matches,
        note:
          match.scanned === 0
            ? "Zoho credentials missing or no Leads fetched."
            : match.matches.length === 0
              ? "No Lead phone match found in scanned Leads."
              : undefined,
      };
    } catch (e) {
      lead_match = {
        queried: true,
        normalized_query: "",
        scanned: 0,
        matches: [],
        note: e instanceof Error ? e.message : "lead_match_failed",
      };
    }
  } else if (bundle.record.lead_id) {
    lead_match = {
      queried: false,
      normalized_query: "",
      scanned: 0,
      matches: [],
      note: `Call already linked to lead_id=${bundle.record.lead_id}.`,
    };
  }

  if (lead_match && !bundle.record.lead_id && lead_match.matches.length === 1) {
    report.issues.push({
      code: "lead_match_candidate",
      severity: "info",
      message: `Single phone match found in Zoho Leads (id=${lead_match.matches[0]!.id}). Consider linking.`,
      suggestion: "PATCH call_record.lead_id with the suggested Lead id after manual confirmation.",
    });
  } else if (lead_match && !bundle.record.lead_id && lead_match.matches.length > 1) {
    report.issues.push({
      code: "lead_match_ambiguous",
      severity: "warning",
      message: `Multiple phone matches (${lead_match.matches.length}) — manual disambiguation required.`,
    });
  }

  const verdict = summarizeVerdict(report.issues);

  return {
    found: true,
    call_record_id: callRecordId,
    source: bundle.record.source,
    agent_email: bundle.record.agent_email,
    contact_phone: contactPhone ?? null,
    report,
    lead_match,
    verdict,
  };
}
