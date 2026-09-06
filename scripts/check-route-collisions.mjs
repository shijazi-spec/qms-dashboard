#!/usr/bin/env node
/**
 * Fail the build on route registrations that can never be reached.
 *
 * WHY THIS EXISTS
 * ---------------
 * Routes are plain objects spread into one array in src/mastra/index.ts and
 * matched in registration order. Two ways a route silently dies:
 *
 *   1. DUPLICATE — the same (path, method) declared in two modules. The one
 *      spread first wins; the other never runs. This shipped: `/api/notifications`
 *      is declared in BOTH triggerRoutes.ts and notificationRoutes.ts, so the
 *      bell listed `audit_notifications` rows while "Mark all read" wrote to the
 *      unrelated notificationHub table and appeared to do nothing.
 *
 *   2. SHADOWED — a literal path registered AFTER a parameterised route that
 *      also matches it. This shipped too: `/api/audits/evidence-packs` sat below
 *      `/api/audits/:id`, so every request became a lookup for an audit with id
 *      "evidence-packs" and returned 404 in production.
 *
 * Neither is visible to tsc, to the test suite, or to rbacRouteCoverage (which
 * only asks whether a route HAS a permission rule, never whether it is live).
 *
 * A param segment with a regex constraint — `:id{[0-9]+}` — only shadows a
 * literal the constraint actually matches, so `/api/kpis/seed-health` under
 * `/api/kpis/:id{[0-9]+}` is fine. Both were verified against production.
 *
 * Run: node scripts/check-route-collisions.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE_DIRS = [
  join(ROOT, "src", "mastra", "routes"),
  join(ROOT, "src", "triggers"),
];

/**
 * Known collisions that are accepted for now, each with a reason.
 *
 * This is a BASELINE, not an excuse list: anything not named here fails the
 * build. Entries should shrink over time — delete one as soon as its defect is
 * actually resolved.
 */
const BASELINE = new Map([
  [
    "GET /api/notifications",
    "notificationHub's list handler is shadowed by triggerRoutes. The hub feed " +
      "(29 createNotification/notifyEvent call sites, mostly Inngest jobs) has " +
      "no reachable read path as a result. Merging the two feeds is a design " +
      "decision, not a cleanup — do not 'fix' this by deleting either handler.",
  ],
  [
    "POST /api/notifications/:id/read",
    "Same pair as GET /api/notifications above; triggerRoutes serves it and " +
      "correctly marks audit_notifications read. Resolve together with the GET.",
  ],
]);

function listTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

/** Pair each `path:` with the `method:` that follows it in the same object. */
function extractRoutes(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const pathRe = /^\s*path:\s*['"](\/[^'"]*)['"]\s*,?\s*$/;
  const methodRe = /^\s*method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = pathRe.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const mm = methodRe.exec(lines[j]);
      if (mm) {
        out.push({ file, line: i + 1, path: m[1], method: mm[1] });
        break;
      }
    }
  }
  return out;
}

// Registration order = order the arrays are spread into index.ts.
const indexSrc = readFileSync(join(ROOT, "src", "mastra", "index.ts"), "utf8");
const spreadOrder = [...indexSrc.matchAll(/^\s*\.\.\.(\w+),?\s*$/gm)].map(
  (m) => m[1],
);

const exportToFile = new Map();
for (const f of ROUTE_DIRS.flatMap(listTsFiles)) {
  for (const m of readFileSync(f, "utf8").matchAll(/export const (\w+)\s*=\s*\[/g))
    exportToFile.set(m[1], f);
}

const registered = [];
for (const name of spreadOrder) {
  const file = exportToFile.get(name);
  if (!file) continue;
  for (const r of extractRoutes(file)) registered.push({ ...r, arrayName: name });
}

const rel = (f) => relative(ROOT, f).replace(/\\/g, "/");
const failures = [];
const baselined = [];

// --- duplicates ------------------------------------------------------------
const seen = new Map();
for (const r of registered) {
  const key = `${r.method} ${r.path}`;
  const winner = seen.get(key);
  if (!winner) {
    seen.set(key, r);
    continue;
  }
  const entry = {
    key,
    detail:
      `  duplicate registration — first one wins, second is dead code\n` +
      `    LIVE: ${rel(winner.file)}:${winner.line} (${winner.arrayName})\n` +
      `    DEAD: ${rel(r.file)}:${r.line} (${r.arrayName})`,
  };
  if (BASELINE.has(key)) baselined.push(entry);
  else failures.push(entry);
}

// --- literal shadowed by an earlier param route ----------------------------
/** A constrained param (`:id{[0-9]+}`) only shadows literals its regex matches. */
function segmentMatches(patternSeg, literalSeg) {
  if (!patternSeg.startsWith(":")) return patternSeg === literalSeg;
  const brace = patternSeg.indexOf("{");
  if (brace === -1) return true; // unconstrained param matches anything
  const raw = patternSeg.slice(brace + 1, patternSeg.lastIndexOf("}"));
  try {
    return new RegExp(`^(?:${raw})$`).test(literalSeg);
  } catch {
    return true; // unparseable constraint — assume it matches, stay conservative
  }
}

for (let i = 0; i < registered.length; i++) {
  const r = registered[i];
  if (r.path.includes(":")) continue;
  for (let j = 0; j < i; j++) {
    const earlier = registered[j];
    if (earlier.method !== r.method || !earlier.path.includes(":")) continue;
    const pp = earlier.path.split("/");
    const ll = r.path.split("/");
    if (pp.length !== ll.length) continue;
    if (!pp.every((seg, k) => segmentMatches(seg, ll[k]))) continue;
    const key = `${r.method} ${r.path}`;
    const entry = {
      key,
      detail:
        `  shadowed by an earlier parameterised route — never reached\n` +
        `    EARLIER: ${earlier.path}  ${rel(earlier.file)}:${earlier.line}\n` +
        `    DEAD   : ${rel(r.file)}:${r.line}\n` +
        `    fix: move this literal route ABOVE the parameterised one`,
    };
    if (BASELINE.has(key)) baselined.push(entry);
    else failures.push(entry);
  }
}

console.log(
  `check-route-collisions: scanned ${registered.length} registered route definitions.`,
);
for (const b of baselined) {
  console.log(`  ~ baselined: ${b.key}`);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} unreachable route registration(s):\n`);
  for (const f of failures) console.error(`${f.key}\n${f.detail}\n`);
  console.error(
    "Each of these is dead code: the request never reaches the handler.\n" +
      "Fix the ordering or remove the duplicate. If a collision is genuinely\n" +
      "intended, add it to BASELINE in this script WITH a reason.",
  );
  process.exit(1);
}

console.log(
  `✓ check-route-collisions: every registered route is reachable` +
    (baselined.length ? ` (${baselined.length} baselined)` : "") +
    `.`,
);
