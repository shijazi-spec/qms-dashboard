import assert from "node:assert";
let passed = 0, failed = 0;
function eq(c: boolean, label: string){ if(c){console.log("  ✓ "+label);passed++;} else {console.error("  ✗ "+label);failed++;} }
import { mergeJobStatusFor, isMergeJobStale } from "./mergeJobsDatabase";

eq(mergeJobStatusFor({ errors: 0, finished: false }) === "running", "in-flight → running");
eq(mergeJobStatusFor({ errors: 0, finished: true }) === "done", "finished clean → done");
eq(mergeJobStatusFor({ errors: 3, finished: true }) === "partial", "finished with errors → partial");

const now = 1_000_000;
eq(isMergeJobStale({ status: "running", last_progress_at: new Date(now - 200_000).toISOString() }, now) === true, "running + cold heartbeat → stale");
eq(isMergeJobStale({ status: "running", last_progress_at: new Date(now - 5_000).toISOString() }, now) === false, "running + fresh heartbeat → not stale");
eq(isMergeJobStale({ status: "done", last_progress_at: null }, now) === false, "terminal status never stale");

console.log("mergeJobsDatabase pure logic ok");
if (failed > 0) { console.error(`\n${failed} FAILED`); process.exit(1); }
