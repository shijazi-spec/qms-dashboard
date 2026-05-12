import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COPC_PATH = join(__dirname, "../config/copc-scorecard-checkpoints.json");
const CWD_FALLBACK_COPC_PATH = join(process.cwd(), "src/config/copc-scorecard-checkpoints.json");

export type CopcScore = 0 | 1 | 2;

export interface CopcCheckpointDef {
  id: string;
  name: string;
  metric?: string;
  target?: string;
  evaluator: string;
  data_source?: string;
  rubric?: any;
}

export interface CopcSectionDef {
  id: string;
  title: string;
  weight_pct: number;
  checkpoints: CopcCheckpointDef[];
}

export interface CopcScorecardDef {
  scorecard_version: string;
  source_artifacts?: string[];
  scoring: { min: number; max: number; labels: Record<string, string> };
  sections: CopcSectionDef[];
}

export interface CopcCheckpointResult {
  id: string;
  section_id: string;
  name: string;
  evaluator: string;
  sourced: boolean;
  score: CopcScore | null;
  max: number;
  evidence: string | null;
  data_source?: string;
  target?: string;
}

export interface CopcSectionResult {
  id: string;
  title: string;
  weight_pct: number;
  evaluable_count: number;
  sourced_count: number;
  max_possible: number;
  achieved: number;
  percentage: number | null;
}

export interface CopcScorecardResult {
  scorecard_version: string;
  call_record_id: number | null;
  evaluated_at: string;
  per_section: CopcSectionResult[];
  per_checkpoint: CopcCheckpointResult[];
  overall: {
    weighted_total_pct: number | null;
    coverage_pct: number;
    not_yet_sourced_count: number;
    sourced_count: number;
    total_checkpoints: number;
  };
  load_error: string | null;
  source_artifacts: string[];
}

export interface CopcEvalInputs {
  call_record_id?: number | null;
  transcript_text?: string | null;
  sentiment_label?: string | null;
}

let cachedDef: CopcScorecardDef | null | undefined;

export function loadCopcScorecardDefFromPath(
  absolutePath: string,
): { ok: true; def: CopcScorecardDef } | { ok: false; error: string } {
  try {
    const raw = readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "invalid_json" };
    if (typeof parsed.scorecard_version !== "string" || !Array.isArray(parsed.sections)) {
      return { ok: false, error: "invalid_shape" };
    }
    return { ok: true, def: parsed as CopcScorecardDef };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "read_failed" };
  }
}

export function getCopcScorecardDef(): CopcScorecardDef | null {
  if (cachedDef !== undefined) return cachedDef;
  const envPath = process.env.COPC_SCORECARD_PATH;
  const candidates = envPath ? [envPath] : [DEFAULT_COPC_PATH, CWD_FALLBACK_COPC_PATH];
  for (const p of candidates) {
    const res = loadCopcScorecardDefFromPath(p);
    if (res.ok) {
      cachedDef = res.def;
      return cachedDef;
    }
  }
  cachedDef = null;
  return null;
}

export function resetCopcScorecardCache(): void {
  cachedDef = undefined;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function countMatchingPhrases(text: string, phrases: string[]): number {
  const tl = lower(text);
  let n = 0;
  for (const p of phrases) {
    if (p && tl.includes(lower(p))) n++;
  }
  return n;
}

/**
 * Score a Communication Skills checkpoint.
 *  2 = greeting present AND closing present
 *  1 = either greeting OR closing present
 *  0 = neither present (only when transcript long enough to evaluate)
 */
function evaluateCommunication(
  transcript: string,
  rubric: { min_transcript_chars?: number; greetings: string[]; closings: string[] },
): { score: CopcScore | null; evidence: string } {
  const minLen = rubric.min_transcript_chars ?? 0;
  if (transcript.length < minLen) {
    return { score: null, evidence: `transcript shorter than ${minLen} chars; not evaluated` };
  }
  const g = countMatchingPhrases(transcript, rubric.greetings || []);
  const c = countMatchingPhrases(transcript, rubric.closings || []);
  const score: CopcScore = g > 0 && c > 0 ? 2 : g > 0 || c > 0 ? 1 : 0;
  return { score, evidence: `greeting markers=${g}, closing markers=${c}` };
}

/**
 * Score Objection Handling.
 *  No objections detected → null (not_applicable, but reported as sourced=true with evidence).
 *  2 = objection markers present AND response phrases present.
 *  1 = objection markers present but no response phrases.
 *  0 = response phrases absent and a clear "not interested"/"غير مهتم" present.
 */
function evaluateObjection(
  transcript: string,
  rubric: { min_transcript_chars?: number; objection_markers: string[]; response_phrases: string[] },
): { score: CopcScore | null; evidence: string } {
  const minLen = rubric.min_transcript_chars ?? 0;
  if (transcript.length < minLen) {
    return { score: null, evidence: `transcript shorter than ${minLen} chars; not evaluated` };
  }
  const objCount = countMatchingPhrases(transcript, rubric.objection_markers || []);
  const respCount = countMatchingPhrases(transcript, rubric.response_phrases || []);
  if (objCount === 0) {
    return { score: null, evidence: "no objections detected; not applicable" };
  }
  const score: CopcScore = respCount > 0 ? 2 : 1;
  return { score, evidence: `objection markers=${objCount}, response phrases=${respCount}` };
}

/**
 * Score Call Flow.
 *  2 = all 3 stages present (intro, discovery, next_steps).
 *  1 = exactly 2 stages present.
 *  0 = 0 or 1 stage present.
 */
function evaluateCallFlow(
  transcript: string,
  rubric: { min_transcript_chars?: number; stages: Record<string, string[]> },
): { score: CopcScore | null; evidence: string } {
  const minLen = rubric.min_transcript_chars ?? 0;
  if (transcript.length < minLen) {
    return { score: null, evidence: `transcript shorter than ${minLen} chars; not evaluated` };
  }
  const stagePresence: string[] = [];
  for (const [name, phrases] of Object.entries(rubric.stages || {})) {
    if (countMatchingPhrases(transcript, phrases) > 0) stagePresence.push(name);
  }
  const n = stagePresence.length;
  const score: CopcScore = n === 3 ? 2 : n === 2 ? 1 : 0;
  return { score, evidence: `stages present (${n}/3): ${stagePresence.join(", ") || "none"}` };
}

function evaluateSentiment(
  sentimentLabel: string | null | undefined,
  rubric: { positive_labels: string[]; neutral_labels: string[]; negative_labels: string[] },
): { score: CopcScore | null; evidence: string } {
  if (!sentimentLabel) {
    return { score: null, evidence: "no sentiment_label available; not evaluated" };
  }
  const lbl = lower(String(sentimentLabel).trim());
  const pos = (rubric.positive_labels || []).map(lower);
  const neu = (rubric.neutral_labels || []).map(lower);
  const neg = (rubric.negative_labels || []).map(lower);
  if (pos.includes(lbl)) return { score: 2, evidence: `sentiment="${sentimentLabel}" (positive)` };
  if (neu.includes(lbl)) return { score: 1, evidence: `sentiment="${sentimentLabel}" (neutral)` };
  if (neg.includes(lbl)) return { score: 0, evidence: `sentiment="${sentimentLabel}" (negative)` };
  return { score: null, evidence: `sentiment="${sentimentLabel}" did not match any rubric label` };
}

export function evaluateCopcScorecard(
  inputs: CopcEvalInputs,
  def: CopcScorecardDef,
): CopcScorecardResult {
  const transcript = (inputs.transcript_text || "").trim();
  const checkpointResults: CopcCheckpointResult[] = [];
  const sectionResults: CopcSectionResult[] = [];
  let totalCheckpoints = 0;
  let sourcedCount = 0;
  let notSourcedCount = 0;
  let weightedAchievedSum = 0;
  let weightedMaxSum = 0;

  for (const section of def.sections) {
    let evaluableCount = 0;
    let sectionMax = 0;
    let sectionAchieved = 0;
    let sectionSourced = 0;

    for (const cp of section.checkpoints) {
      totalCheckpoints++;
      let score: CopcScore | null = null;
      let evidence: string | null = null;
      let sourced = false;

      switch (cp.evaluator) {
        case "transcript_communication": {
          if (!transcript) {
            evidence = "transcript not present";
          } else {
            const r = evaluateCommunication(transcript, cp.rubric || {});
            score = r.score;
            evidence = r.evidence;
            sourced = score !== null;
          }
          break;
        }
        case "transcript_objection": {
          if (!transcript) {
            evidence = "transcript not present";
          } else {
            const r = evaluateObjection(transcript, cp.rubric || {});
            score = r.score;
            evidence = r.evidence;
            sourced = score !== null || /not applicable/i.test(r.evidence);
          }
          break;
        }
        case "transcript_call_flow": {
          if (!transcript) {
            evidence = "transcript not present";
          } else {
            const r = evaluateCallFlow(transcript, cp.rubric || {});
            score = r.score;
            evidence = r.evidence;
            sourced = score !== null;
          }
          break;
        }
        case "sentiment_label": {
          const r = evaluateSentiment(inputs.sentiment_label, cp.rubric || {});
          score = r.score;
          evidence = r.evidence;
          sourced = score !== null;
          break;
        }
        case "not_yet_sourced":
        default: {
          score = null;
          evidence = `data not yet sourced (${cp.data_source || "external system"})`;
          sourced = false;
          break;
        }
      }

      if (sourced) sourcedCount++;
      else notSourcedCount++;

      if (score !== null) {
        evaluableCount++;
        sectionMax += def.scoring.max;
        sectionAchieved += score;
      }

      checkpointResults.push({
        id: cp.id,
        section_id: section.id,
        name: cp.name,
        evaluator: cp.evaluator,
        sourced,
        score,
        max: def.scoring.max,
        evidence,
        data_source: cp.data_source,
        target: cp.target,
      });

      if (sourced) sectionSourced++;
    }

    const sectionPct = sectionMax > 0 ? (sectionAchieved / sectionMax) * 100 : null;
    sectionResults.push({
      id: section.id,
      title: section.title,
      weight_pct: section.weight_pct,
      evaluable_count: evaluableCount,
      sourced_count: sectionSourced,
      max_possible: sectionMax,
      achieved: sectionAchieved,
      percentage: sectionPct === null ? null : Number(sectionPct.toFixed(2)),
    });

    if (sectionPct !== null) {
      weightedAchievedSum += (sectionPct / 100) * section.weight_pct;
      weightedMaxSum += section.weight_pct;
    }
  }

  const weightedTotalPct =
    weightedMaxSum > 0 ? Number(((weightedAchievedSum / weightedMaxSum) * 100).toFixed(2)) : null;
  const coveragePct = totalCheckpoints > 0 ? Number(((sourcedCount / totalCheckpoints) * 100).toFixed(2)) : 0;

  return {
    scorecard_version: def.scorecard_version,
    call_record_id: inputs.call_record_id ?? null,
    evaluated_at: new Date().toISOString(),
    per_section: sectionResults,
    per_checkpoint: checkpointResults,
    overall: {
      weighted_total_pct: weightedTotalPct,
      coverage_pct: coveragePct,
      not_yet_sourced_count: notSourcedCount,
      sourced_count: sourcedCount,
      total_checkpoints: totalCheckpoints,
    },
    load_error: null,
    source_artifacts: def.source_artifacts ?? [],
  };
}

export function evaluateLoadedCopcScorecard(inputs: CopcEvalInputs): CopcScorecardResult {
  const def = getCopcScorecardDef();
  if (!def) {
    return {
      scorecard_version: "unknown",
      call_record_id: inputs.call_record_id ?? null,
      evaluated_at: new Date().toISOString(),
      per_section: [],
      per_checkpoint: [],
      overall: {
        weighted_total_pct: null,
        coverage_pct: 0,
        not_yet_sourced_count: 0,
        sourced_count: 0,
        total_checkpoints: 0,
      },
      load_error: "missing_or_invalid_copc_scorecard",
      source_artifacts: [],
    };
  }
  return evaluateCopcScorecard(inputs, def);
}
