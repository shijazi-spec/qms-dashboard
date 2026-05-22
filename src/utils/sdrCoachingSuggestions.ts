// =======================================================================
// Medium #7 — Coaching Loop Integration
//
// Given a stored SDR call evaluation, compute prioritised coaching
// suggestions: for every attribute the agent scored below the threshold
// matrix, surface a priority band (Urgent / High / Medium) and match
// the attribute against the training catalog (training_courses) via
// curated keyword tags from src/config/sdr-coaching-map.json.
//
// On-demand (no new schema) — managers always see suggestions against
// the current state of the course catalog rather than a stale snapshot.
// =======================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactedPool } from "./redactedPool";
import type { SDRCallEvaluation, SDREvaluationResult } from "./callIntelligenceDb";
import type { TrainingCourse } from "./teamDatabase";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const COACHING_MAP_PATH = join(__dirname, "../config/sdr-coaching-map.json");
const COACHING_MAP_CWD_FALLBACK = join(
  process.cwd(),
  "src/config/sdr-coaching-map.json",
);

interface CoachingMap {
  priority_thresholds: Record<
    "urgent" | "high" | "medium" | "low",
    { max_pct: number; label: string; label_ar: string }
  >;
  attributes: Record<
    string,
    { name: string; keywords: string[]; course_ids: string[] }
  >;
}

let cachedMap: CoachingMap | null = null;

function loadCoachingMap(): CoachingMap {
  if (cachedMap) return cachedMap;
  let raw: string;
  try {
    raw = readFileSync(COACHING_MAP_PATH, "utf-8");
  } catch {
    raw = readFileSync(COACHING_MAP_CWD_FALLBACK, "utf-8");
  }
  cachedMap = JSON.parse(raw) as CoachingMap;
  return cachedMap;
}

export type CoachingPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface CoachingSuggestion {
  attribute_id: string;
  attribute_name: string;
  dimension: string;
  status: SDREvaluationResult["status"];
  severity: string;
  score_pct: number | null;
  priority: CoachingPriority;
  priority_label: string;
  priority_label_ar: string;
  improvement_tip: string;
  matched_courses: Array<{
    course_id: string;
    name: string;
    description?: string;
    department?: string;
    duration_hours: number;
    match_reason: "pinned" | "keyword";
  }>;
}

export interface CoachingPlan {
  call_record_id: number;
  overall_score: number;
  highest_priority: CoachingPriority;
  suggestions: CoachingSuggestion[];
  rollup_message_en: string;
  rollup_message_ar: string;
}

function attributeMap() {
  return loadCoachingMap().attributes;
}

function thresholds() {
  return loadCoachingMap().priority_thresholds;
}

// Convert any raw attribute score into 0-100. AI emits 1-10 per attribute
// but older evaluations may have score=null — in that case fall back to
// status (FAIL=0, PASS=100, NA=null so it skips the priority bands).
function normaliseScorePct(attr: SDREvaluationResult): number | null {
  if (typeof attr.score === "number" && !Number.isNaN(attr.score)) {
    if (attr.score <= 10) return Math.round(attr.score * 10);
    return Math.round(attr.score);
  }
  if (attr.status === "FAIL") return 0;
  if (attr.status === "PASS") return 100;
  return null;
}

function pickPriority(scorePct: number | null, severity?: string): CoachingPriority {
  if (scorePct === null) return "none";
  const t = thresholds();
  // Critical-severity FAIL is always urgent regardless of numeric score.
  if (scorePct <= t.urgent.max_pct) return "urgent";
  if (severity === "critical" && scorePct < 90) return "urgent";
  if (scorePct <= t.high.max_pct) return "high";
  if (scorePct <= t.medium.max_pct) return "medium";
  return "low";
}

function priorityRank(p: CoachingPriority): number {
  return { urgent: 0, high: 1, medium: 2, low: 3, none: 4 }[p];
}

async function fetchPinnedCourses(courseIds: string[]): Promise<TrainingCourse[]> {
  if (courseIds.length === 0) return [];
  const result = await pool.query(
    `SELECT * FROM training_courses
     WHERE course_id = ANY($1::text[]) AND is_active = true`,
    [courseIds],
  );
  return result.rows;
}

async function fetchKeywordMatches(
  keywords: string[],
  excludeIds: string[],
  limit = 3,
): Promise<TrainingCourse[]> {
  if (keywords.length === 0) return [];
  // Build OR'd ILIKE predicates against name + description + department.
  // Caller already trusts the keyword list (it's static config) but we
  // still bind every value as a parameter — no string interpolation.
  const params: any[] = [];
  const orClauses: string[] = [];
  for (const kw of keywords) {
    params.push(`%${kw}%`);
    const idx = params.length;
    orClauses.push(`(name ILIKE $${idx} OR description ILIKE $${idx} OR department ILIKE $${idx})`);
  }
  let excludeClause = "";
  if (excludeIds.length > 0) {
    params.push(excludeIds);
    excludeClause = `AND course_id <> ALL($${params.length}::text[])`;
  }
  params.push(limit);
  const limitIdx = params.length;

  const sql = `
    SELECT * FROM training_courses
    WHERE is_active = true
      AND (${orClauses.join(" OR ")})
      ${excludeClause}
    ORDER BY created_at DESC
    LIMIT $${limitIdx}
  `;
  const result = await pool.query(sql, params);
  return result.rows;
}

function buildRollupMessages(suggestions: CoachingSuggestion[]): {
  rollup_message_en: string;
  rollup_message_ar: string;
} {
  const urgent = suggestions.filter((s) => s.priority === "urgent");
  const high = suggestions.filter((s) => s.priority === "high");
  const medium = suggestions.filter((s) => s.priority === "medium");

  if (urgent.length === 0 && high.length === 0 && medium.length === 0) {
    return {
      rollup_message_en:
        "No coaching gaps above the 80% threshold — agent performed well across all attributes.",
      rollup_message_ar:
        "لا توجد فجوات تدريبية تتجاوز عتبة 80% — أداء الوكيل جيد عبر جميع السمات.",
    };
  }

  const fmt = (list: CoachingSuggestion[]) => list.map((s) => s.attribute_name).join(", ");
  const parts: string[] = [];
  const partsAr: string[] = [];
  if (urgent.length > 0) {
    parts.push(`Urgent (${urgent.length}): ${fmt(urgent)}`);
    partsAr.push(`عاجل (${urgent.length}): ${fmt(urgent)}`);
  }
  if (high.length > 0) {
    parts.push(`High (${high.length}): ${fmt(high)}`);
    partsAr.push(`عالي (${high.length}): ${fmt(high)}`);
  }
  if (medium.length > 0) {
    parts.push(`Medium (${medium.length}): ${fmt(medium)}`);
    partsAr.push(`متوسط (${medium.length}): ${fmt(medium)}`);
  }
  return {
    rollup_message_en: parts.join(" | "),
    rollup_message_ar: partsAr.join(" | "),
  };
}

export async function buildCoachingPlan(
  evaluation: SDRCallEvaluation,
): Promise<CoachingPlan> {
  const attributes = Array.isArray(evaluation.attribute_evaluations)
    ? evaluation.attribute_evaluations
    : [];

  const suggestions: CoachingSuggestion[] = [];

  for (const attr of attributes) {
    const scorePct = normaliseScorePct(attr);
    const priority = pickPriority(scorePct, attr.severity);
    // Skip attributes with low/none priority — they're not actionable.
    if (priority === "low" || priority === "none") continue;

    const config = attributeMap()[attr.attribute_id];
    const pinnedIds = config?.course_ids || [];
    const keywords = config?.keywords || [];

    const pinned = await fetchPinnedCourses(pinnedIds);
    const matched = await fetchKeywordMatches(
      keywords,
      pinned.map((c) => c.course_id),
    );

    const matched_courses = [
      ...pinned.map((c) => ({
        course_id: c.course_id,
        name: c.name,
        description: c.description,
        department: c.department,
        duration_hours: Number(c.duration_hours),
        match_reason: "pinned" as const,
      })),
      ...matched.map((c) => ({
        course_id: c.course_id,
        name: c.name,
        description: c.description,
        department: c.department,
        duration_hours: Number(c.duration_hours),
        match_reason: "keyword" as const,
      })),
    ];

    suggestions.push({
      attribute_id: attr.attribute_id,
      attribute_name: attr.attribute_name,
      dimension: attr.dimension,
      status: attr.status,
      severity: attr.severity,
      score_pct: scorePct,
      priority,
      priority_label: thresholds()[priority as "urgent" | "high" | "medium" | "low"].label,
      priority_label_ar: thresholds()[priority as "urgent" | "high" | "medium" | "low"].label_ar,
      improvement_tip: attr.improvement_tip || "",
      matched_courses,
    });
  }

  suggestions.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

  const highest_priority: CoachingPriority =
    suggestions[0]?.priority ?? "none";

  const { rollup_message_en, rollup_message_ar } = buildRollupMessages(suggestions);

  return {
    call_record_id: evaluation.call_record_id,
    overall_score: Number(evaluation.overall_score) || 0,
    highest_priority,
    suggestions,
    rollup_message_en,
    rollup_message_ar,
  };
}
