/**
 * RBAC route-coverage test (Task #436).
 *
 * The deny-by-default fallback in `enforceRoutePermission` blocks any
 * `/api/*` route that ships without an explicit `ROUTE_PERMISSION_MAP`
 * entry. Today this is only caught at runtime (request → 403) or by a
 * manual coverage walk. This test enumerates every live `/api/*` route
 * defined under `src/mastra/routes/**` and `src/triggers/**` and asserts
 * that each one is matched by at least one rule in the permission map.
 *
 * Detection strategy (no live server, no DB):
 *   `canAccessRoute("admin", path, method) === true` ⟺ a rule in
 *   ROUTE_PERMISSION_MAP matches `(path, method)`. The admin shortcut in
 *   `canAccessRoute` only fires inside the rule-match loop, so an
 *   unmatched `/api/*` path is denied for every role (including admin)
 *   by the deny-by-default fallback. We use that to detect missing
 *   coverage without simulating role tables.
 *
 * Public / framework-managed routes are explicitly excluded:
 *   - `PUBLIC_PATHS` from `src/mastra/middleware/index.ts` (auth flow,
 *     invitation acceptance, health/smoke probes, language preference,
 *     static assets) — these bypass `checkApiAuth` entirely.
 *   - Mastra-internal prefixes (`/api/workflows/`, `/api/memory/`,
 *     `/api/agents/` except `/api/agents/performance`) — handled by the
 *     framework's own auth.
 *   - `/api/inngest*` and `/api/admin/*` — gated by the admin-key check
 *     in `checkApiAuth` BEFORE `enforceRoutePermission` runs, so the
 *     RBAC map is intentionally unaware of them.
 *   - `/api/webhooks/slack/*` — defined in `src/triggers/slackTriggers.ts`
 *     but that module is never imported, so the routes are not actually
 *     registered (see PUBLIC_PATHS audit comment). Re-enable coverage
 *     here if/when slackTriggers is wired into the registered route set.
 *
 * Run:  npx tsx tests/rbacRouteCoverage.test.ts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canAccessRoute } from "../src/utils/rbacMiddleware";
import { PUBLIC_PATHS } from "../src/mastra/middleware/index";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const ROUTE_DIRS = [
  resolve(__dirname, "..", "src", "mastra", "routes"),
  resolve(__dirname, "..", "src", "triggers"),
];

interface RouteDef {
  file: string;
  line: number;
  path: string;
  method: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract `{ path, method }` pairs from a route module.
 *
 * The Mastra route shape is `{ path: "/api/...", method: "GET" as const, ... }`.
 * `path:` and `method:` always appear within a few lines of each other inside
 * the same object literal, so we walk the file and pair each `path: "/api/..."`
 * with the first `method: "<VERB>"` declaration that follows it (within a
 * small lookahead window so unrelated `method:` keys further down can't be
 * incorrectly paired).
 */
function extractRoutes(file: string): RouteDef[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const pathRe = /^\s*path:\s*['"](\/[^'"]*)['"]\s*,?\s*$/;
  const methodRe = /^\s*method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/;
  const out: RouteDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = pathRe.exec(lines[i]);
    if (!m) continue;
    const p = m[1];
    if (!p.startsWith("/api/")) continue;
    let method: string | null = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const mm = methodRe.exec(lines[j]);
      if (mm) {
        method = mm[1];
        break;
      }
    }
    if (method) {
      out.push({ file, line: i + 1, path: p, method });
    }
  }
  return out;
}

function isPublic(urlPath: string): boolean {
  return PUBLIC_PATHS.some((p) =>
    p.endsWith("/") ? urlPath.startsWith(p) : urlPath === p,
  );
}

function isFrameworkManaged(urlPath: string): boolean {
  // Mastra-internal prefixes are handled by the framework itself and never
  // reach `enforceRoutePermission`.
  if (urlPath.startsWith("/api/workflows/")) return true;
  if (urlPath.startsWith("/api/memory/")) return true;
  if (
    urlPath.startsWith("/api/agents/") &&
    urlPath !== "/api/agents/performance"
  ) {
    return true;
  }
  // `/api/inngest*` is gated by admin-key in `checkInngestAccess` before RBAC.
  if (urlPath === "/api/inngest" || urlPath.startsWith("/api/inngest/")) {
    return true;
  }
  // `/api/admin/*` is gated by admin-key in `checkApiAuth` before
  // `enforceRoutePermission` runs (see `urlPath.startsWith('/api/admin/')`
  // branch in src/mastra/middleware/index.ts). RBAC map intentionally
  // doesn't cover these.
  if (urlPath === "/api/admin" || urlPath.startsWith("/api/admin/")) {
    return true;
  }
  // Slack webhook trigger lives in `src/triggers/slackTriggers.ts`, but the
  // module is never imported into the registered route set (see PUBLIC_PATHS
  // audit comment in src/mastra/middleware/index.ts). Re-enable coverage if
  // the triggers module is ever wired up.
  if (urlPath.startsWith("/api/webhooks/slack")) return true;
  return false;
}

/**
 * Replace Mastra-style `:param` placeholders with concrete values that satisfy
 * the regexes used in `ROUTE_PERMISSION_MAP`. "1" matches `\d+`, `\w+`, and
 * `[^/]+`, so it is safe for every observed pattern (numeric IDs, names,
 * filenames, ISO dates, codes, sections, etc.).
 */
function concretize(routePath: string): string {
  return routePath.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "1");
}

const allRoutes: RouteDef[] = [];
for (const dir of ROUTE_DIRS) {
  for (const file of listTsFiles(dir)) {
    allRoutes.push(...extractRoutes(file));
  }
}

console.log(
  `\n=== RBAC route-coverage — scanned ${allRoutes.length} /api/* route definitions ===\n`,
);

let coveredCount = 0;
let skippedCount = 0;
const missing: RouteDef[] = [];

for (const r of allRoutes) {
  if (isPublic(r.path) || isFrameworkManaged(r.path)) {
    skippedCount++;
    continue;
  }
  const concrete = concretize(r.path);
  const covered = canAccessRoute("admin", concrete, r.method);
  assert(
    covered,
    `${r.method} ${r.path} (${r.file.replace(/^.*\/src\//, "src/")}:${r.line}) — no ROUTE_PERMISSION_MAP rule matches concrete path '${concrete}'`,
  );
  if (covered) coveredCount++;
  else missing.push(r);
}

console.log(
  `Routes covered by ROUTE_PERMISSION_MAP: ${coveredCount}\n` +
    `Routes skipped (public / framework-managed):  ${skippedCount}\n` +
    `Routes missing a rule:                        ${missing.length}\n`,
);

if (missing.length > 0) {
  console.error(
    "\n❌ The following /api/* routes have no matching ROUTE_PERMISSION_MAP rule.\n" +
      "   They will be denied by the deny-by-default fallback in `enforceRoutePermission`.\n" +
      "   Add an explicit rule to `ROUTE_PERMISSION_MAP` in `src/utils/rbacMiddleware.ts`,\n" +
      "   or — for routes that bypass RBAC by design — extend the public/framework-managed\n" +
      "   exclusion lists at the top of this test with a documented justification.\n",
  );
  for (const r of missing) {
    console.error(
      `   - ${r.method} ${r.path}   (${r.file.replace(/^.*\/src\//, "src/")}:${r.line})`,
    );
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ RBAC route-coverage test FAILED");
  process.exit(1);
}

console.log("\n✅ Every live /api/* route is covered by ROUTE_PERMISSION_MAP");
