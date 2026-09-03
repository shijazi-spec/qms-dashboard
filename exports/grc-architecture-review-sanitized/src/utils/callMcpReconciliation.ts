/**
 * MCP-oriented call reconciliation: normalize identifiers, compare transcript vs
 * stored evaluation signals, and surface actionable gaps (no LLM calls here).
 *
 * Product note: **SDR Governance 2.1** rules load from `src/config/sdr-governance-2.1.rules.json`
 * (see `sdrGovernanceRulesEngine.ts`). Extend that JSON from your governance PDFs/XLSX. Generic
 * heuristics still apply when rules file is missing.
 */

export interface ReconciliationIssue {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
  suggestion?: string;
}

export interface TranscriptVsEvaluationReport {
  call_record_id: number;
  lead_id: string | null;
  agent_email: string | null;
  transcript_chars: number;
  qa_score_percentage: number | null;
  talk_ratio: number | null;
  sentiment_label: string | null;
  issues: ReconciliationIssue[];
  checks: {
    transcript_present: boolean;
    qa_present: boolean;
    analysis_present: boolean;
    lead_linked: boolean;
  };
  /** SDR 2.1 JSON rules engine (subset of `issues` are governance-coded). */
  governance?: {
    ruleset_version: string | null;
    rules_evaluated: number;
    load_error: string | null;
    source_artifacts: string[];
    governance_issue_count: number;
  };
}

import { evaluateLoadedGovernanceRules } from "./sdrGovernanceRulesEngine";

/** Normalize phone for loose matching (digits only, strip leading zeros after country code heuristic). */
export function normalizePhoneDigits(raw: string | undefined | null): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  // E.164 Saudi: 12+ digits starting with 966 → keep last 9 subscriber digits
  if (digits.length >= 12 && digits.startsWith("966")) return digits.slice(-9);
  // Local Saudi with leading 0: 10 digits → strip leading 0 to get subscriber
  if (digits.length >= 10 && digits.startsWith("0")) return digits.replace(/^0+/, "");
  // Salvage: 11-digit starting with "96" — almost always a "+966" that
  // lost a digit during data entry / dialer export. We have a real case:
  // Sample User's lead, phone "<REDACTED_PHONE>" (Screenshot 464,
  // call-eval bug report 2026-05-24, where auto-link failed despite the
  // lead being in Zoho). Take the last 9 digits so it matches a Zoho
  // record stored in any of the canonical formats above.
  if (digits.length === 11 && digits.startsWith("96")) return digits.slice(-9);
  return digits;
}

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return new Set(words);
}

/** Cheap overlap heuristic: do QA "improvements" themes appear weakly in transcript? */
export function compareTranscriptToQaThemes(
  transcript: string,
  improvements: unknown,
): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  if (!transcript?.trim()) {
    issues.push({
      code: "missing_transcript",
      severity: "critical",
      message: "No transcript text to validate against evaluation.",
      suggestion: "Run transcription pipeline or attach transcript before reconciliation.",
    });
    return issues;
  }
  const tokens = tokenize(transcript);
  const list = Array.isArray(improvements)
    ? improvements.map((x) => String(x))
    : improvements &&
        typeof improvements === "object" &&
        Array.isArray((improvements as { items?: unknown }).items)
      ? (improvements as { items: unknown[] }).items.map((x) => String(x))
      : typeof improvements === "string"
        ? [improvements]
        : [];
  if (list.length === 0) return issues;

  for (const imp of list.slice(0, 8)) {
    const impTokens = tokenize(imp);
    let overlap = 0;
    for (const t of impTokens) {
      if (tokens.has(t)) overlap++;
    }
    if (impTokens.size > 0 && overlap === 0) {
      issues.push({
        code: "qa_theme_not_reflected",
        severity: "warning",
        message: `Coaching theme may not be grounded in transcript: "${imp.slice(0, 120)}${imp.length > 120 ? "…" : ""}"`,
        suggestion: "Re-run evaluation with full transcript or verify transcript source.",
      });
    }
  }
  return issues;
}

export function buildTranscriptVsEvaluationReport(input: {
  call_record_id: number;
  lead_id?: string | null;
  agent_email?: string | null;
  transcript_text: string | null;
  talk_ratio?: number | null;
  sentiment_label?: string | null;
  qa_score_percentage?: number | null;
  improvements?: unknown;
}): TranscriptVsEvaluationReport {
  const issues: ReconciliationIssue[] = [];
  const transcript_present = !!input.transcript_text?.trim();
  const qa_present = input.qa_score_percentage != null;
  const analysis_present = !!input.sentiment_label;
  const lead_linked = !!input.lead_id?.trim();

  if (!lead_linked) {
    issues.push({
      code: "no_lead_link",
      severity: "warning",
      message: "Call is not linked to a Zoho Lead.",
      suggestion: "Match by phone or CRM activity, then PATCH metadata / ingest with lead_id.",
    });
  }

  if (transcript_present && qa_present && input.qa_score_percentage != null) {
    if (input.qa_score_percentage >= 75 && input.talk_ratio != null && input.talk_ratio < 0.25) {
      issues.push({
        code: "high_score_low_talk_ratio",
        severity: "info",
        message: "QA score is high but talk ratio is very low — confirm evaluation used same audio window.",
      });
    }
    if (input.qa_score_percentage < 50 && input.transcript_text!.length > 500) {
      issues.push({
        code: "low_score_rich_transcript",
        severity: "warning",
        message: "Long transcript but low QA score — review rubric vs transcript alignment.",
      });
    }
  }

  if (transcript_present && input.improvements != null) {
    issues.push(...compareTranscriptToQaThemes(input.transcript_text!, input.improvements));
  }

  const gov = evaluateLoadedGovernanceRules(input.transcript_text);
  issues.push(...gov.issues);

  return {
    call_record_id: input.call_record_id,
    lead_id: input.lead_id ?? null,
    agent_email: input.agent_email ?? null,
    transcript_chars: input.transcript_text?.length ?? 0,
    qa_score_percentage: input.qa_score_percentage ?? null,
    talk_ratio: input.talk_ratio ?? null,
    sentiment_label: input.sentiment_label ?? null,
    issues,
    checks: {
      transcript_present,
      qa_present,
      analysis_present,
      lead_linked,
    },
    governance: {
      ruleset_version: gov.ruleset_version,
      rules_evaluated: gov.rules_evaluated,
      load_error: gov.load_error,
      source_artifacts: gov.source_artifacts,
      governance_issue_count: gov.issues.length,
    },
  };
}
