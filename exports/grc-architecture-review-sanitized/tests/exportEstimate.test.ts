/**
 * Unit tests for src/utils/exportEstimate.ts — the size-estimate helpers
 * shared by every streaming export route. These are pure functions over
 * row counts and format keys, so the tests stay in-process (no DB, no HTTP).
 *
 * Run with:  npx tsx tests/exportEstimate.test.ts
 */

import { TestSuite } from "./_helpers/runner.js";
import {
  estimateBytesFromRows,
  estimateFromCount,
  estimateResponse,
} from "../src/utils/exportEstimate.js";

const suite = new TestSuite("exportEstimate");

await suite.test("estimateBytesFromRows: zero rows returns the fixed overhead", () => {
  suite.expectEqual(estimateBytesFromRows(0, "csv"), 256, "csv overhead");
  suite.expectEqual(estimateBytesFromRows(0, "xlsx"), 8 * 1024, "xlsx overhead");
});

await suite.test("estimateBytesFromRows: scales linearly with row count using format default", () => {
  // CSV default = 200 b/row, overhead 256
  suite.expectEqual(estimateBytesFromRows(100, "csv"), 100 * 200 + 256, "csv 100 rows");
  // XLSX default = 120 b/row, overhead 8 KiB
  suite.expectEqual(estimateBytesFromRows(50, "xlsx"), 50 * 120 + 8 * 1024, "xlsx 50 rows");
});

await suite.test("estimateBytesFromRows: caller-supplied bytes/row hint takes precedence", () => {
  // event logs use a custom 600 b/row hint — make sure it threads through
  suite.expectEqual(estimateBytesFromRows(10, "csv", 600), 10 * 600 + 256, "csv hinted");
});

await suite.test("estimateBytesFromRows: rejects negative or non-finite row counts", () => {
  suite.expectEqual(estimateBytesFromRows(-5, "csv"), 256, "negative falls back to overhead");
  suite.expectEqual(estimateBytesFromRows(NaN, "xlsx"), 8 * 1024, "NaN falls back to overhead");
});

await suite.test("estimateFromCount: parses string totals (Postgres COUNT comes back as text)", () => {
  const est = estimateFromCount("42", "csv");
  suite.expectEqual(est.rows, 42, "rows parsed from string");
  suite.expectEqual(est.format, "csv", "format echoed");
  suite.expectEqual(est.bytes, 42 * 200 + 256, "bytes computed");
});

await suite.test("estimateFromCount: nullish total clamps to zero rows + overhead", () => {
  const est = estimateFromCount(null, "xlsx");
  suite.expectEqual(est.rows, 0, "rows clamped");
  suite.expectEqual(est.bytes, 8 * 1024, "bytes = overhead only");
});

interface EstimateBody {
  rows: number;
  bytes: number;
  format: string;
}

await suite.test("estimateResponse: emits JSON body and X-Estimated-* headers", async () => {
  const res = estimateResponse({ rows: 1234, bytes: 567890, format: "xlsx" });
  suite.expectEqual(res.status, 200, "status");
  suite.expectEqual(res.headers.get("X-Estimated-Rows"), "1234", "rows header");
  suite.expectEqual(res.headers.get("X-Estimated-Bytes"), "567890", "bytes header");
  suite.expectEqual(res.headers.get("X-Export-Format"), "xlsx", "format header");
  const json = (await res.json()) as EstimateBody;
  suite.expectEqual(json.rows, 1234, "json rows");
  suite.expectEqual(json.bytes, 567890, "json bytes");
  suite.expectEqual(json.format, "xlsx", "json format");
});

await suite.test("estimateResponse: floors fractional inputs and clamps negatives", () => {
  const res = estimateResponse({ rows: 9.9, bytes: -1, format: "csv" });
  suite.expectEqual(res.headers.get("X-Estimated-Rows"), "9", "fractional floored");
  suite.expectEqual(res.headers.get("X-Estimated-Bytes"), "0", "negative clamped");
});

suite.finishOrExit();
