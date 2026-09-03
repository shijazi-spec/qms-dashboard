import assert from "node:assert/strict";
import {
  evaluateLoadedCopcScorecard,
  resetCopcScorecardCache,
  evaluateCopcScorecard,
  loadCopcScorecardDefFromPath,
} from "../src/utils/copcScorecardEngine";
import { join } from "node:path";

function header(title: string) {
  console.log(`\n— ${title} —`);
}

(async function main() {
  resetCopcScorecardCache();

  header("definition loads from default path with 19 checkpoints across 4 sections");
  const defRes = loadCopcScorecardDefFromPath(
    join(process.cwd(), "src/config/copc-scorecard-checkpoints.json"),
  );
  assert.equal(defRes.ok, true);
  if (!defRes.ok) throw new Error("def did not load");
  assert.equal(defRes.def.sections.length, 4);
  const totalCps = defRes.def.sections.reduce((n, s) => n + s.checkpoints.length, 0);
  assert.equal(totalCps, 19, "expected 19 total checkpoints");
  const transcriptEvaluators = defRes.def.sections
    .flatMap((s) => s.checkpoints)
    .filter((c) => c.evaluator !== "not_yet_sourced");
  assert.equal(
    transcriptEvaluators.length,
    4,
    "expected 4 actually-evaluable §2 checkpoints",
  );
  const totalWeight = defRes.def.sections.reduce((w, s) => w + s.weight_pct, 0);
  assert.equal(totalWeight, 100, "section weights should sum to 100");

  header("empty inputs → all checkpoints not_yet_sourced or transcript-missing");
  const emptyResult = evaluateLoadedCopcScorecard({
    call_record_id: 1,
    transcript_text: null,
    sentiment_label: null,
  });
  assert.equal(emptyResult.load_error, null);
  assert.equal(emptyResult.overall.total_checkpoints, 19);
  // sentiment_label evaluator returns sourced=false when no label given;
  // 13 §1/§3/§4 already not_sourced + 3 transcript checkpoints + 1 sentiment = 17 not_sourced... but transcript ones return sourced=false too.
  assert.equal(emptyResult.overall.sourced_count, 0);
  assert.equal(emptyResult.overall.weighted_total_pct, null);

  header("rich Arabic transcript scores §2 checkpoints + sentiment_label");
  const transcript = [
    "السلام عليكم، معك أحمد من شركة Sample User.",
    "هل لديك دقيقة لمناقشة احتياجاتك الحالية؟",
    "ما هو نظام إدارة الجودة الذي تستخدمونه حاليا؟",
    "كم عدد المراجعات السنوية التي تقومون بها؟",
    "أفهم أن السعر قد يبدو غاليا، اسمح لي أن أوضح القيمة.",
    "ربما يمكننا مناقشة خطة تناسب ميزانيتكم.",
    "ممتاز، أقترح موعدًا الأسبوع القادم لتقديم عرض كامل.",
    "سأرسل لك تقويم الاجتماع، شكرا جزيلا على وقتك.",
  ].join(" ");
  const richResult = evaluateLoadedCopcScorecard({
    call_record_id: 42,
    transcript_text: transcript,
    sentiment_label: "positive",
  });
  assert.equal(richResult.load_error, null);

  const cpById = new Map(richResult.per_checkpoint.map((c) => [c.id, c]));
  // §2.1 communication: greeting (السلام) + closing (شكرا) → 2
  assert.equal(cpById.get("S2.1")?.score, 2, "communication should be 2");
  // §2.2 objection: "غاليا" + "اسمح" / "ربما" → 2
  assert.equal(cpById.get("S2.2")?.score, 2, "objection should be 2");
  // §2.3 call flow: intro+discovery+next_steps all present → 2
  assert.equal(cpById.get("S2.3")?.score, 2, "call flow should be 2");
  // §2.4 sentiment positive → 2
  assert.equal(cpById.get("S2.4")?.score, 2, "sentiment positive → 2");

  // S2 percentage = 8/8 = 100
  const s2 = richResult.per_section.find((s) => s.id === "S2");
  assert.equal(s2?.percentage, 100);

  // Weighted total uses ONLY S2 (only section with sourced checkpoints)
  // → 100% normalized to its own weight (30/30) = 100
  assert.equal(richResult.overall.weighted_total_pct, 100);
  assert.equal(richResult.overall.sourced_count, 4);
  assert.equal(richResult.overall.not_yet_sourced_count, 15);
  assert.equal(richResult.overall.coverage_pct, Number(((4 / 19) * 100).toFixed(2)));

  header("negative sentiment + bare transcript scores 0 on sentiment");
  const minimal = "Hello there. ".repeat(40); // > 200 chars but no closings/objections/discovery
  const negResult = evaluateLoadedCopcScorecard({
    call_record_id: 7,
    transcript_text: minimal,
    sentiment_label: "negative",
  });
  const negCp = new Map(negResult.per_checkpoint.map((c) => [c.id, c]));
  assert.equal(negCp.get("S2.4")?.score, 0, "negative sentiment → 0");
  // Communication: greeting "hello" present, no closing → 1
  assert.equal(negCp.get("S2.1")?.score, 1);
  // Objection: no markers → null (sourced)
  assert.equal(negCp.get("S2.2")?.score, null);
  // Call flow: only intro-ish via "this is" (no), discovery missing, next_steps missing → likely 0
  assert.ok((negCp.get("S2.3")?.score ?? -1) <= 1);

  header("missing scorecard JSON → load_error path");
  process.env.COPC_SCORECARD_PATH = "/tmp/nonexistent-copc-file.json";
  resetCopcScorecardCache();
  const missing = evaluateLoadedCopcScorecard({
    call_record_id: 1,
    transcript_text: "x",
    sentiment_label: null,
  });
  assert.equal(missing.load_error, "missing_or_invalid_copc_scorecard");
  assert.equal(missing.per_section.length, 0);
  delete process.env.COPC_SCORECARD_PATH;
  resetCopcScorecardCache();

  console.log("\n✓ COPC scorecard engine tests passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
