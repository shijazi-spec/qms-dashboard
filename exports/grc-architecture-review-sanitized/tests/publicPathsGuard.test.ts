/**
 * Guard test against accidental public-API exposure.
 *
 * Background — task #447 (cross-referenced throughout this file):
 * `/api/health` was registered in `PUBLIC_PATHS` as a `startsWith` prefix,
 * which silently exposed `/api/health-index` (an aggregator over
 * NC/CAPA/audit data) and `/api/health/pulse*` to unauthenticated callers.
 * The middleware now distinguishes EXACT entries from PREFIX entries (the
 * trailing `/` convention), but that convention is fragile: a future engineer
 * can re-introduce the same class of bug by adding a new path to
 * `PUBLIC_PATHS` or a new route to `routeManifest.ts` that the existing
 * allow-list happens to match.
 *
 * This test enforces two invariants:
 *   1. Every entry in `PUBLIC_PATHS` is acknowledged in the in-test
 *      allow-list with a one-line justification.  Adding a new entry to
 *      `PUBLIC_PATHS` without a justification fails the test.
 *   2. For every route documented in `routeManifest.ts`, if `isPublicPath()`
 *      classifies that route as public, the route's path is also in the
 *      in-test allow-list.  Adding a new route in `routeManifest.ts` that
 *      accidentally matches an existing prefix (the task #447 foot-gun)
 *      fails the test with a message that names the offending route and
 *      points at this file.
 *
 * Run:  npx tsx tests/publicPathsGuard.test.ts
 */

import { PUBLIC_PATHS, isPublicPath } from "../src/mastra/middleware/index";
import { ROUTE_MANIFEST } from "../src/mastra/routeManifest";
import { TestSuite } from "./_helpers/runner";

/**
 * Allow-list of paths that are intentionally publicly reachable.  Each entry
 * MUST carry a one-line justification — adding a path here is a privilege-
 * escalation review checkpoint.  See task #447 for the original audit.
 *
 * Two kinds of paths live here:
 *   - Literal `PUBLIC_PATHS` entries (ground truth).
 *   - Concrete route-manifest paths that fall under one of those entries
 *     by prefix match (e.g. `/api/auth/*` is reachable because `/api/auth/`
 *     is registered as a subtree).  These are listed explicitly so that a
 *     future engineer adding a new route under one of those subtrees has to
 *     come look at THIS file and explicitly acknowledge the bypass.
 */
const PUBLIC_PATH_ALLOWLIST: Record<string, string> = {
  // ---- Auth flow ----------------------------------------------------------
  "/login": "Pre-session login page (rendered before any cookie exists).",
  "/api/login": "POST: legacy email/password login. Issues the session cookie.",
  "/api/callback": "GET: OIDC redirect target from the identity provider.",
  "/api/logout": "GET: clears auth cookies and redirects to the IDP logout.",
  "/api/auth/":
    "Subtree (/api/auth/me, /api/auth/logout). Each handler returns 401 / clears cookies on its own — bypass is harmless.",

  // ---- Admin-key bootstrap -----------------------------------------------
  "/api/admin/auth":
    "POST: exchange ADMIN_API_KEY for an admin_key cookie. Listed exact (not prefix) so /api/admin/auth-* cannot inherit the bypass.",
  "/api/admin/auth/logout":
    "POST: clears the admin_key cookie. Listed exact for the same reason as /api/admin/auth.",

  // ---- Invitation acceptance (caller has no session yet) -----------------
  "/accept-invite":
    "Landing page invitees see before they have a session cookie.",
  "/api/invitations/validate/":
    "Subtree (/api/invitations/validate/:token). The token IS the auth.",
  "/api/invitations/accept":
    "POST: completes the invite flow and issues a session cookie.",

  // ---- Static assets (cookies don't gate stylesheets / JS bundles) -------
  "/css/": "Static CSS subtree. Cookies don't gate stylesheets.",
  "/js/": "Static JS subtree. Cookies don't gate front-end bundles.",
  "/dashboard/tailwind.css":
    "Compiled tailwind stylesheet served as a static asset.",
  "/dashboard/i18n/": "Locale JSON files (UI strings only — no user data).",

  // ---- Streaming-download service worker plumbing ------------------------
  "/streaming-download-sw.js":
    "Service worker file — browsers fetch this independently of cookies.",
  "/_stream-download/":
    "Service-worker-intercepted trigger URL pattern (defensive 404 plumbing for browsers without SW support).",

  // ---- Operational health checks (uptime monitoring) ---------------------
  "/api/health":
    "EXACT entry — see task #447. Must NOT swallow /api/health-index (aggregates NC/CAPA/audit data) or /api/health/pulse* (admin-only via authorize()).",
  "/api/smoke":
    "Smoke test for the orchestrator. Returns a tiny static OK payload.",

  // ---- Anonymous language preference -------------------------------------
  "/api/user/language-preference":
    "Lets unauthenticated visitors set their UI language before signing in.",

  // ---- Accessibility statement -------------------------------------------
  "/a11y": "WCAG / regulator-facing accessibility statement. Public by design.",

  // ---- Slack interactive-component callback ------------------------------
  "/webhooks/slack/action":
    "POST: Slack interactive-component callback. Slack (not a browser) posts here and cannot carry a session cookie; the handler authenticates every request via Slack signing-secret signature verification plus dedup/bot-loop guards (src/triggers/slackTriggers.ts).",
  "/api/webhooks/slack/action":
    "POST: /api alias of the Slack interactive-component callback above — same Slack-signature-verified handler. Public so Slack's servers can reach it without a platform session.",

  // ---- Server-to-server leadership KPI feed ------------------------------
  "/api/kpis/leadership-feed":
    "GET: read-only KPI feed PULLED server-to-server by the separate Leadership Platform app (no platform session). Fail-closed — returns 503 when LEADERSHIP_FEED_KEY is unset/<16 chars and 401 on any X-Feed-Key mismatch (src/mastra/routes/leadershipFeedRoutes.ts). The in-platform /api/kpis/leadership-feed/preview variant is session + role gated.",

  // ---- Documentation Live Tracker collector (server-to-server push) ------
  "/api/documentation-tracker/ingest":
    "POST: full library snapshot PUSHED server-to-server by the Windows collector on the controlled-documentation file server (no platform session). Fail-closed — 503 when DOC_TRACKER_INGEST_KEY is unset/<16 chars, 401 on any X-Tracker-Key mismatch, constant-time compare (src/mastra/routes/documentationTrackerRoutes.ts). Rate-limited under the dedicated 'doc-tracker' category. Writes only collector-owned fact columns; human review state is never touched, and absent documents are soft-deleted behind a mass-deletion guard.",
  "/api/documentation-tracker/heartbeat":
    "POST: collector liveness ping, same X-Tracker-Key gate as /ingest. Exists so a collector whose library simply has not changed is distinguishable from one that has died — silence must never render as 'nothing changed'. Writes only doc_tracker_collectors liveness columns.",
  "/api/documentation-tracker/collector-config":
    "GET: read-only scan configuration (folder list, code pattern, caps, debounce) so the collector can be retuned without redeploying the executable on the file server. Same X-Tracker-Key gate; exposes no document or review data.",

  // ---- routeManifest paths whose declared path is matched as public -------
  // These are concrete manifest entries that fall under one of the prefix
  // bypasses above. Listing them explicitly forces a future engineer adding a
  // new sibling route to come justify it here, which is precisely what
  // would have caught the task #447 /api/health-index regression.
  "/api/auth/*":
    "Manifest wildcard for the /api/auth subtree — reachable via the /api/auth/ prefix entry above. Any NEW handler under /api/auth/* MUST self-gate (see authRoutes.ts).",

  // ---- Tech-request assignee response flow (server-to-server / email link) -
  "/r/":
    "GET: confirmation page rendered after an assignee clicks the one-click respond link from their email. The token in the URL IS the auth — no platform session exists at that point (src/mastra/routes/techRequestRoutes.ts).",
  "/api/tech-requests/respond/":
    "POST: records the assignee's response (accept/decline/info_needed). The action_token path parameter IS the auth — HMAC-verified constant-time in the handler; no platform session required (src/mastra/routes/techRequestRoutes.ts).",
};

/**
 * Pull every concrete route path out of ROUTE_MANIFEST.  We only enumerate
 * route groups whose values are arrays of `{ path }` records — `pages`,
 * `staticAssets` and `moduleRoutes` are intentionally skipped: pages and
 * assets are gated by `checkPageAuth`, not `checkApiAuth`, and `moduleRoutes`
 * is just a list of file names without paths.
 */
function collectManifestRoutePaths(): string[] {
  const out: string[] = [];
  for (const [, entries] of Object.entries(ROUTE_MANIFEST)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === "string") continue;
      const e = entry as { path?: unknown };
      if (typeof e.path === "string" && e.path.length > 0) out.push(e.path);
    }
  }
  return Array.from(new Set(out));
}

const suite = new TestSuite("publicPathsGuard");

console.log("\n=== publicPathsGuard regression tests (task #447) ===\n");

await suite.test(
  "every PUBLIC_PATHS entry is acknowledged in the in-test allow-list with a justification",
  () => {
    for (const entry of PUBLIC_PATHS) {
      const justification = PUBLIC_PATH_ALLOWLIST[entry];
      suite.expect(
        typeof justification === "string" && justification.trim().length > 0,
        `PUBLIC_PATHS entry '${entry}' has no justification in PUBLIC_PATH_ALLOWLIST ` +
          `(tests/publicPathsGuard.test.ts). See task #447 — every public path is a ` +
          `privilege-escalation review checkpoint and must be justified here. If you ` +
          `intentionally added '${entry}' to PUBLIC_PATHS, add a one-line justification ` +
          `to PUBLIC_PATH_ALLOWLIST and re-run the test.`,
      );
    }
  },
);

await suite.test(
  "every justified allow-list entry that targets a PUBLIC_PATHS path is still actually present in PUBLIC_PATHS",
  () => {
    // Catches the inverse foot-gun: a justification stays behind in the
    // allow-list after the underlying PUBLIC_PATHS entry was renamed or
    // removed. Without this, `PUBLIC_PATHS` could shrink and the allow-list
    // would silently grant `dead` justifications that no longer correspond
    // to anything — defeating the audit trail.
    //
    // We only enforce this for keys that LOOK like PUBLIC_PATHS entries
    // (i.e. they were originally one). Manifest-only entries like
    // `/api/auth/*` are exempted by the route-manifest check below.
    const publicPathSet = new Set<string>(PUBLIC_PATHS);
    const manifestRoutes = new Set<string>(collectManifestRoutePaths());
    for (const key of Object.keys(PUBLIC_PATH_ALLOWLIST)) {
      if (publicPathSet.has(key)) continue;
      if (manifestRoutes.has(key)) continue;
      suite.expect(
        false,
        `Allow-list key '${key}' is not present in PUBLIC_PATHS and is not a route ` +
          `in routeManifest.ts. Either it was renamed/removed (delete the stale ` +
          `justification from PUBLIC_PATH_ALLOWLIST in tests/publicPathsGuard.test.ts) ` +
          `or it was a typo. See task #447.`,
      );
    }
  },
);

await suite.test(
  "no /api/* route in routeManifest.ts is matched as public without an explicit allow-list entry (task #447 regression guard)",
  () => {
    for (const routePath of collectManifestRoutePaths()) {
      if (!routePath.startsWith("/api/")) continue;
      if (!isPublicPath(routePath)) continue;
      const justification = PUBLIC_PATH_ALLOWLIST[routePath];
      suite.expect(
        typeof justification === "string" && justification.trim().length > 0,
        `Route '${routePath}' (declared in src/mastra/routeManifest.ts) is matched as ` +
          `PUBLIC by isPublicPath() but has no entry in PUBLIC_PATH_ALLOWLIST ` +
          `(tests/publicPathsGuard.test.ts). This is exactly the foot-gun task #447 ` +
          `was filed for: a new /api/* route accidentally inherited the public bypass ` +
          `from a sibling entry in PUBLIC_PATHS. If '${routePath}' MUST be public, add ` +
          `a justified entry to PUBLIC_PATH_ALLOWLIST. Otherwise, tighten the matching ` +
          `entry in PUBLIC_PATHS (prefer EXACT entries; if you need a subtree, write ` +
          `it with a trailing '/' and pick a prefix that cannot swallow siblings).`,
      );
    }
  },
);

await suite.test(
  "the foot-gun routes from task #447 (/api/health-index, /api/health/pulse*) are NOT classified as public",
  () => {
    // Direct regression assertion. If a future change reintroduces the
    // startsWith-style match, these will start returning true and this test
    // will fail with a message that names the original ticket.
    const mustBePrivate = [
      "/api/health-index",
      "/api/health/pulse",
      "/api/health/pulse/recent",
      "/api/health/pulse/stream",
    ];
    for (const p of mustBePrivate) {
      suite.expect(
        !isPublicPath(p),
        `isPublicPath('${p}') must be FALSE — see task #447. A regression here means ` +
          `the matcher in src/mastra/middleware/index.ts has reverted to startsWith-style ` +
          `behaviour and is silently exposing protected routes again.`,
      );
    }
  },
);

suite.finishOrExit();
