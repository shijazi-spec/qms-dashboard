/**
 * CI gate: chunkText() must never silently lose document text.
 *
 * Run:    npx tsx src/utils/documentChunkEmbeddings.test.ts
 *
 * This is the failure mode worth a test. A chunker that drops the tail of a
 * document produces a system that looks like it works: searches return hits,
 * the judge returns verdicts, coverage percentages render — and the last
 * section of every policy is simply invisible, so every clause it satisfies is
 * reported as a gap. Nothing about that is distinguishable from "the document
 * genuinely does not cover it" without a test that asserts total coverage.
 *
 * Also pins the infinite-loop guard: overlap >= size makes the window stand
 * still, and `while (start < len)` would never terminate.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Stub pg before importing: this module opens a pool at import time, and the
// unit under test is pure.
type QuerySource = string | { text: string; values?: unknown[] };
const mockQuery = (
  _sql: QuerySource,
  _params?: unknown[],
): Promise<QueryResult<QueryResultRow>> =>
  Promise.resolve({ rows: [], rowCount: 0, command: "", oid: 0, fields: [] });
(Pool.prototype as unknown as { query: typeof mockQuery }).query = mockQuery;

const { chunkText, CHUNK_CHARS } = await import("./documentChunkEmbeddings");

// ── 1. no text is lost ───────────────────────────────────────────────────────
// Build a document with uniquely identifiable tokens so we can prove every one
// survives chunking - including the ones at the very end.
const words: string[] = [];
for (let i = 0; i < 4000; i++) words.push(`tok${i}`);
const doc = words.join(" ");

const chunks = chunkText(doc);
const joined = chunks.join(" ");

assert(chunks.length > 1, `long document splits into multiple chunks (${chunks.length})`);

const missing = words.filter((w) => !new RegExp(`\\b${w}\\b`).test(joined));
assert(missing.length === 0, `every token survives chunking (${missing.length} missing)`);

assert(
  new RegExp(`\\btok3999\\b`).test(joined),
  "the FINAL token is present - the tail is not dropped",
);
assert(
  new RegExp(`\\btok0\\b`).test(joined),
  "the FIRST token is present",
);

// ── 2. chunks stay near the requested size ───────────────────────────────────
const oversized = chunks.filter((c) => c.length > CHUNK_CHARS * 1.5);
assert(oversized.length === 0, `no chunk wildly exceeds the target size (${oversized.length})`);

const tinyMiddles = chunks.slice(0, -1).filter((c) => c.length < CHUNK_CHARS * 0.4);
assert(
  tinyMiddles.length === 0,
  `no non-final chunk collapses to a sliver (${tinyMiddles.length})`,
);

// ── 3. overlap actually overlaps ─────────────────────────────────────────────
// A control sentence straddling a boundary must appear whole in at least one
// chunk; that is the entire point of the overlap.
const twoChunks = chunkText(doc, 500, 150);
let sharedSomething = false;
for (let i = 0; i + 1 < twoChunks.length; i++) {
  const tailWords = twoChunks[i].split(/\s+/).slice(-5);
  if (tailWords.some((w) => twoChunks[i + 1].includes(w))) sharedSomething = true;
}
assert(sharedSomething, "consecutive chunks share text (overlap is real)");

// ── 4. termination guards ────────────────────────────────────────────────────
// overlap >= size would freeze `start`; the step floor must prevent that.
const pathological = chunkText(doc, 300, 300);
assert(pathological.length > 0, "overlap == size still terminates and returns chunks");
const pathological2 = chunkText(doc, 300, 9999);
assert(pathological2.length > 0, "overlap > size still terminates and returns chunks");

// ── 5. degenerate inputs ─────────────────────────────────────────────────────
assert(chunkText("").length === 0, "empty string yields no chunks");
assert(chunkText("   \n  ").length === 0, "whitespace-only yields no chunks");
assert(
  chunkText("a short policy statement").length === 1,
  "text shorter than one chunk yields exactly one chunk",
);
assert(
  chunkText(null as unknown as string).length === 0,
  "null input is handled without throwing",
);

// ── 6. Arabic text survives ──────────────────────────────────────────────────
// Half the controlled library is Arabic; a chunker that mangles non-Latin text
// would make those documents unsearchable.
const arabic = "سياسة أمن المعلومات لشركة ولاء بلس ".repeat(200);
const arabicChunks = chunkText(arabic);
assert(arabicChunks.length > 1, "Arabic text chunks into multiple pieces");
assert(
  arabicChunks.join("").includes("المعلومات"),
  "Arabic characters survive chunking intact",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
