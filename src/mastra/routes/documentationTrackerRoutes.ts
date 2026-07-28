/**
 * documentationTrackerRoutes — collector-facing endpoints for the Documentation
 * Live Tracker.
 *
 * ⚠️ THE BASE PATH IS LOAD-BEARING. These routes MUST live under
 * `/api/documentation-tracker/*` and MUST NOT be moved under
 * `/api/compliance/*` (or /api/policies, /api/risks, /api/audits, …).
 *
 * `applyBodySanitization` runs on every `/api/*` write, including PUBLIC_PATHS
 * entries (src/mastra/middleware/index.ts). It calls `filterAllowedFields`,
 * which extracts the module prefix from the path and keeps ONLY the keys
 * whitelisted for that module. `ALLOWED_FIELDS.compliance` has no `documents`,
 * no `collectorId`, no `snapshotHash` — so a snapshot POSTed under
 * /api/compliance arrives at this handler as `{title?, description?}` with every
 * document silently deleted. No error, no log, no clue. The module prefix
 * "documentation-tracker" is absent from ALLOWED_FIELDS, so the body passes
 * through untouched. Do not "tidy" this path.
 *
 * AUTH — the caller is a Windows service on a file server, not a browser, so
 * these three paths are in PUBLIC_PATHS and do their OWN authentication with a
 * dedicated key (pattern copied from leadershipFeedRoutes). Deliberately NOT
 * ADMIN_API_KEY: that is a global admin credential and the middleware only
 * honours it on /api/admin/* and /api/inngest*. Deliberately NOT
 * requireRoleOrKey(), which despite its name does not accept API keys at all.
 *
 * The browser-facing read/SSE endpoints are session-authenticated and live
 * elsewhere; they must never be added to PUBLIC_PATHS.
 */

import { timingSafeEqual } from "crypto";
import { logger as safeLogger } from "../../utils/logger";
import {
  MAX_DOCUMENTS_PER_SNAPSHOT,
  MAX_REFS_PER_SNAPSHOT,
} from "../../utils/docTrackerIngest";

const MIN_KEY_LENGTH = 16;

/** Constant-time compare, length-checked first so unequal lengths cannot throw. */
function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Fail CLOSED. An unset or weak key disables ingest with a 503 rather than
 * leaving an unauthenticated write endpoint exposed.
 */
function authoriseCollector(c: any): { ok: true } | { ok: false; res: any } {
  const expected = process.env.DOC_TRACKER_INGEST_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH) {
    safeLogger.warn(
      "[DocTracker] DOC_TRACKER_INGEST_KEY unset or too short — ingest disabled",
    );
    return {
      ok: false,
      res: c.json({ error: "Documentation tracker ingest not configured" }, 503),
    };
  }
  const provided = c.req.header("X-Tracker-Key") || "";
  if (!keysMatch(provided, expected)) {
    return { ok: false, res: c.json({ error: "Invalid or missing X-Tracker-Key" }, 401) };
  }
  return { ok: true };
}

export const documentationTrackerRoutes = [
  {
    path: "/api/documentation-tracker/ingest",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = authoriseCollector(c);
        if (!auth.ok) return auth.res;
        try {
          const body = await c.req.json().catch(() => null);
          if (!body || typeof body !== "object") {
            return c.json({ error: "Body must be a JSON object" }, 400);
          }
          const documents = Array.isArray(body.documents) ? body.documents : null;
          if (!documents) {
            return c.json({ error: "documents[] is required" }, 400);
          }
          // Explicit caps so a runaway collector gets a clean 400 rather than a
          // slow multi-megabyte parse.
          if (documents.length > MAX_DOCUMENTS_PER_SNAPSHOT) {
            return c.json(
              { error: `Too many documents (max ${MAX_DOCUMENTS_PER_SNAPSHOT})` },
              413,
            );
          }
          const refTotal = documents.reduce(
            (n: number, d: any) => n + (Array.isArray(d?.refs) ? d.refs.length : 0),
            0,
          );
          if (refTotal > MAX_REFS_PER_SNAPSHOT) {
            return c.json(
              { error: `Too many cross-references (max ${MAX_REFS_PER_SNAPSHOT})` },
              413,
            );
          }

          const { ingestSnapshot } = await import("../../utils/docTrackerIngest");
          const result = await ingestSnapshot({
            collectorId: body.collectorId,
            collectorVersion: body.collectorVersion,
            libraryRoot: body.libraryRoot,
            mode: body.mode,
            allowMassDelete: body.allowMassDelete === true,
            documents,
          });
          // 200 even for 'partial' — the collector must not retry-loop on a
          // guard trip; the inserts/updates were applied.
          return c.json({ success: true, ...result });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] ingest failed:", err);
          return c.json({ error: "Ingest failed" }, 500);
        }
      };
    },
  },
  {
    // Liveness independent of content change. Without this, a collector whose
    // library simply has not changed is indistinguishable from one that died.
    path: "/api/documentation-tracker/heartbeat",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = authoriseCollector(c);
        if (!auth.ok) return auth.res;
        try {
          const body = await c.req.json().catch(() => ({}));
          const { touchCollector } = await import("../../utils/docTrackerDatabase");
          await touchCollector({
            collector_id: String(body.collectorId || "default").slice(0, 120),
            collector_version: body.collectorVersion ?? null,
            library_root: body.libraryRoot ?? null,
            snapshot: false,
            last_error: body.lastError ?? null,
          });
          return c.json({
            ok: true,
            serverTime: new Date().toISOString(),
            minIntervalSeconds: 300,
          });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] heartbeat failed:", err);
          return c.json({ error: "Heartbeat failed" }, 500);
        }
      };
    },
  },
  {
    // Lets the collector be retuned without redeploying the executable on the
    // file server.
    path: "/api/documentation-tracker/collector-config",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const auth = authoriseCollector(c);
        if (!auth.ok) return auth.res;
        return c.json({
          hashSpecVersion: 1,
          maxDocuments: MAX_DOCUMENTS_PER_SNAPSHOT,
          maxRefs: MAX_REFS_PER_SNAPSHOT,
          minIntervalSeconds: 300,
          debounceSeconds: 5,
          codePattern: "^WP-(POL|DOC|SOP|FORM|CTL)-\\d+$",
          allowedExtensions: [".docx", ".pdf", ".xlsx", ".pptx", ".doc", ".xls"],
          folders: [
            "Documents",
            "Policies",
            "SOPs",
            "Forms",
            "Security Controls",
          ],
        });
      };
    },
  },
];
