/**
 * Pure-function tests for embedding cosine similarity (benchmark rec #3).
 * Run:  npx tsx tests/clauseEmbeddings.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import { cosine } from "../src/utils/clauseEmbeddings";

const suite = new TestSuite("clauseEmbeddings");
console.log("\n=== embedding cosine — pure tests ===\n");

await suite.test("identical vectors → 1", async () => {
  suite.expectEqual(Math.round(cosine([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1, "cos=1");
});
await suite.test("orthogonal vectors → 0", async () => {
  suite.expectEqual(cosine([1, 0], [0, 1]), 0, "cos=0");
});
await suite.test("opposite vectors → -1", async () => {
  suite.expectEqual(Math.round(cosine([1, 2], [-1, -2]) * 1000) / 1000, -1, "cos=-1");
});
await suite.test("length mismatch → 0 (safe)", async () => {
  suite.expectEqual(cosine([1, 2, 3], [1, 2]), 0, "mismatch");
});
await suite.test("empty/zero vectors → 0 (no NaN)", async () => {
  suite.expectEqual(cosine([], []), 0, "empty");
  suite.expectEqual(cosine([0, 0], [0, 0]), 0, "zero");
});
await suite.test("ranking is correct (closer vector scores higher)", async () => {
  const q = [1, 1, 0];
  suite.expect(cosine(q, [1, 1, 0.1]) > cosine(q, [0, 1, 1]), "near > far");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
