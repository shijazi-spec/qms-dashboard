/**
 * Static guard against duplicate Inngest function ids.
 *
 * `registerApiRoute()` (src/mastra/inngest/index.ts) registers one Inngest
 * function per Hono API route, with an id derived from the route path. If two
 * routes produce the SAME id, `inngest.serve()` throws "Duplicate function ID"
 * at boot and the process exits before the HTTP port opens — visible only as a
 * deploy healthcheck 500. This has already broken production twice: once for the
 * cron path, and once when two `/webhooks/slack/*` registrars both collapsed to
 * `api-webhooks`.
 *
 * This test scans the source for every `registerApiRoute("<literal>")` call,
 * runs each path through the real `apiRouteFunctionId()` helper, and asserts the
 * resulting ids are unique. It imports only the pure helper (no DB / no Inngest
 * client side effects), so it runs fast and fails at CI time — before deploy.
 *
 * Run:  npx tsx tests/inngestApiRouteIds.test.ts
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { apiRouteFunctionId } from "../src/mastra/inngest/apiRouteFunctionId";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "..", "src");

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// Matches registerApiRoute("<path>", ...) with a single- or double-quoted
// string-literal first argument. Dynamic (non-literal) paths are out of scope.
const CALL_RE = /\bregisterApiRoute\(\s*(["'])([^"']+)\1/g;

async function run() {
  console.log("Scanning src/ for registerApiRoute() string-literal paths...\n");

  const files = await walk(SRC_DIR);
  // path -> first file:line where it was found (for actionable error output)
  const routePaths = new Map<string, string>();

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      // Skip JSDoc / comment example lines so doc snippets don't count.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
      let m: RegExpExecArray | null;
      CALL_RE.lastIndex = 0;
      while ((m = CALL_RE.exec(line)) !== null) {
        const routePath = m[2];
        const rel = `${path.relative(SRC_DIR, file)}:${idx + 1}`;
        if (!routePaths.has(routePath)) routePaths.set(routePath, rel);
      }
    });
  }

  assert(
    routePaths.size > 0,
    "expected to find at least one registerApiRoute() call in src/",
  );

  // id -> list of "path (file:line)" that produced it
  const idToPaths = new Map<string, string[]>();
  for (const [routePath, where] of routePaths) {
    const id = apiRouteFunctionId(routePath);
    const list = idToPaths.get(id) ?? [];
    list.push(`${routePath} (${where})`);
    idToPaths.set(id, list);
  }

  console.log(`Found ${routePaths.size} route(s) -> ${idToPaths.size} id(s):`);
  for (const [id, paths] of idToPaths) {
    console.log(`  ${id}  <-  ${paths.join(", ")}`);
  }
  console.log("");

  for (const [id, paths] of idToPaths) {
    assert(
      paths.length === 1,
      `duplicate Inngest function id "${id}" produced by ${paths.length} routes: ${paths.join(
        " ; ",
      )} — give them distinct paths (this crashes inngest.serve() at boot)`,
    );
  }

  // Sanity: the two production-wired Slack webhook routes must differ.
  const slackAction = apiRouteFunctionId("/webhooks/slack/action");
  const slackRating = apiRouteFunctionId("/webhooks/slack/consultant-rating");
  assert(
    slackAction !== slackRating,
    `the two /webhooks/slack/* routes must have distinct ids (got "${slackAction}" for both)`,
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
