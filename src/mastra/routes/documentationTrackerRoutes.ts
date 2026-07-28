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

/** Who may READ the tracker board. Mirrors the compliance read set. */
const TRACKER_READ_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
];

/**
 * Who may WRITE. Attaching an approved file, settling a review state, and
 * adding a document to the controlled register are all judgement acts, so
 * `executive` (read-only oversight) is deliberately excluded.
 */
const TRACKER_WRITE_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
];

/**
 * Session gate for the browser-facing endpoints. These are NEVER in
 * PUBLIC_PATHS — only the three collector routes above are, and they carry a
 * key instead of a session.
 */
async function gateSession(c: any, allowed: string[]) {
  const { requireRole, getSessionUser, unauthorizedResponse, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, allowed as any);
  if (!user) {
    if (!getSessionUser(c)) return { error: unauthorizedResponse(c), user: null };
    return {
      error: forbiddenResponse(c, "Permission denied for the Documentation Tracker"),
      user: null,
    };
  }
  return { error: null, user };
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

  // ── Session-authenticated read surface ────────────────────────────────
  // Browser-facing. Never in PUBLIC_PATHS, and each needs a
  // ROUTE_PERMISSION_MAP rule because unmatched /api/* is denied by default.
  {
    // The polling floor. The page refreshes this every 60s and treats SSE
    // purely as an accelerator, because the SSE client registry is per-instance
    // and a browser on one instance never sees a broadcast from another.
    path: "/api/documentation-tracker/overview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const { getOverview } = await import("../../utils/docTrackerRead");
          return c.json({ success: true, ...(await getOverview()) });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] overview failed:", err);
          return c.json({ error: "Failed to load overview" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/documents",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const u = new URL(c.req.url).searchParams;
          const { listDocuments } = await import("../../utils/docTrackerRead");
          const data = await listDocuments({
            state: u.get("state") || undefined,
            family: u.get("family") || undefined,
            lang: u.get("lang") || undefined,
            linkStatus: u.get("link_status") || undefined,
            stale: u.get("stale") === "true",
            q: u.get("q") || undefined,
            includeDeleted: u.get("include_deleted") === "true",
            page: parseInt(u.get("page") || "0", 10) || 0,
            pageSize: parseInt(u.get("page_size") || "100", 10) || 100,
          });
          return c.json({ success: true, ...data });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] documents failed:", err);
          return c.json({ error: "Failed to load documents" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/coverage",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const raw = new URL(c.req.url).searchParams.get("regulation_id") || "";
          let regulationId: number | undefined;
          if (raw) {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && String(n) === raw) regulationId = n;
            else {
              const { sharedPool } = await import("../../utils/sharedPool");
              const rr = await sharedPool.query(
                `SELECT id FROM regulations WHERE public_id = $1 LIMIT 1`,
                [raw],
              );
              regulationId = rr.rows[0]?.id;
            }
          }
          const { getCoverage } = await import("../../utils/docTrackerRead");
          return c.json({ success: true, coverage: await getCoverage(regulationId) });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] coverage failed:", err);
          return c.json({ error: "Failed to load coverage" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/orphans",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const { getOrphans } = await import("../../utils/docTrackerRead");
          return c.json({ success: true, ...(await getOrphans()) });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] orphans failed:", err);
          return c.json({ error: "Failed to load orphans" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/refs/graph",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const { getRefGraph } = await import("../../utils/docTrackerRead");
          return c.json({ success: true, ...(await getRefGraph()) });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] ref graph failed:", err);
          return c.json({ error: "Failed to load reference graph" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/snapshots",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const limit = parseInt(
            new URL(c.req.url).searchParams.get("limit") || "50",
            10,
          );
          const { listSnapshots } = await import("../../utils/docTrackerRead");
          return c.json({ success: true, snapshots: await listSnapshots(limit) });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] snapshots failed:", err);
          return c.json({ error: "Failed to load snapshots" }, 500);
        }
      };
    },
  },
  {
    // Live updates. EventSource cannot send custom headers, so this is
    // session-authenticated (cookie) and must NEVER be added to PUBLIC_PATHS —
    // that is precisely why the collector's key-authenticated endpoints are
    // separate routes rather than one bidirectional channel.
    path: "/api/documentation-tracker/stream",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const { createStream, MAX_SSE_CLIENTS } = await import(
            "../../utils/docTrackerStream"
          );
          const { getOverview } = await import("../../utils/docTrackerRead");
          const res = createStream(await getOverview());
          if (!res) {
            return c.json(
              { error: `Too many live listeners (max ${MAX_SSE_CLIENTS})` },
              503,
            );
          }
          return res;
        } catch (err) {
          safeLogger.error("❌ [DocTracker] stream failed:", err);
          return c.json({ error: "Stream unavailable" }, 500);
        }
      };
    },
  },

  // ── Write surface (governance roles only) ─────────────────────────────
  {
    // Attach the approved file, replacing the draft in place. This is what
    // clears the placeholder state: real text is extracted, coverage and
    // "Suggest Documents" stop operating on the register's own blurb, and
    // policy_versions records the draft→approved change automatically.
    path: "/api/documentation-tracker/documents/:code/attach",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_WRITE_ROLES);
        if (g.error) return g.error;
        try {
          const rawLen = c.req.header("Content-Length");
          if (rawLen && parseInt(rawLen, 10) > 26 * 1024 * 1024) {
            return c.json({ error: "Request body too large (max 25 MB)" }, 413);
          }
          const form = await c.req.formData();
          const file = form.get("file");
          if (!file || !(file instanceof File)) {
            return c.json({ error: "No file provided" }, 400);
          }
          const { attachApprovedFile } = await import(
            "../../utils/docTrackerAttach"
          );
          const result = await attachApprovedFile({
            registerCode: String(c.req.param("code") || ""),
            buffer: Buffer.from(await file.arrayBuffer()),
            originalName: file.name,
            mimeType: file.type,
            uploadedBy: g.user?.email || "tracker",
          });
          if (result.status === "error") {
            return c.json({ error: result.reason || "Attach failed" }, 400);
          }
          if (result.status === "orphan") {
            return c.json(
              {
                error:
                  "This document is not on the master list — promote it to the register first",
                status: "orphan",
              },
              409,
            );
          }
          return c.json({ success: true, ...result });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] attach failed:", err);
          return c.json({ error: "Attach failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/documents/:code/review",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_WRITE_ROLES);
        if (g.error) return g.error;
        try {
          const body = await c.req.json().catch(() => ({}));
          const { setReviewState } = await import("../../utils/docTrackerAttach");
          const res = await setReviewState({
            registerCode: String(c.req.param("code") || ""),
            reviewState: body.reviewState ?? body.review_state,
            assigneeEmail: body.assigneeEmail ?? body.assignee_email ?? null,
            note: body.note ?? null,
            reviewedBy: g.user?.email || "tracker",
          });
          if (!res.ok) {
            return c.json(
              { error: res.reason },
              res.reason === "not_found" ? 404 : 400,
            );
          }
          return c.json({ success: true, document: res.row });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] review update failed:", err);
          return c.json({ error: "Review update failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/documents/:code/promote",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_WRITE_ROLES);
        if (g.error) return g.error;
        try {
          const { promoteOrphan } = await import("../../utils/docTrackerAttach");
          const res = await promoteOrphan(
            String(c.req.param("code") || ""),
            g.user?.email || "tracker",
          );
          const code =
            res.status === "not_found" ? 404 : res.status === "failed" ? 500 : 200;
          return c.json({ success: res.status !== "failed", ...res }, code);
        } catch (err) {
          safeLogger.error("❌ [DocTracker] promote failed:", err);
          return c.json({ error: "Promote failed" }, 500);
        }
      };
    },
  },
  {
    // Bulk promote exists because the seeded register has no "-AR" variants, so
    // roughly 150 Arabic files land as orphans on the first snapshot. Without
    // this the panel is unusable and someone "temporarily" makes ingest
    // auto-create register rows — which would end human control of the master
    // list. One summary audit event, not 200.
    path: "/api/documentation-tracker/promote-bulk",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_WRITE_ROLES);
        if (g.error) return g.error;
        try {
          const body = await c.req.json().catch(() => ({}));
          const codes = Array.isArray(body.registerCodes) ? body.registerCodes : null;
          if (!codes || codes.length === 0) {
            return c.json({ error: "registerCodes[] is required" }, 400);
          }
          const { promoteOrphansBulk, MAX_BULK_PROMOTE } = await import(
            "../../utils/docTrackerAttach"
          );
          if (codes.length > MAX_BULK_PROMOTE) {
            return c.json(
              { error: `Too many codes (max ${MAX_BULK_PROMOTE})` },
              413,
            );
          }
          const res = await promoteOrphansBulk(
            codes.map((x: any) => String(x)),
            g.user?.email || "tracker",
          );
          return c.json({ success: true, ...res });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] bulk promote failed:", err);
          return c.json({ error: "Bulk promote failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/documentation-tracker/documents/:code/project",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_WRITE_ROLES);
        if (g.error) return g.error;
        try {
          const { projectDocument } = await import("../../utils/docTrackerAttach");
          return c.json({
            success: true,
            ...(await projectDocument(String(c.req.param("code") || ""))),
          });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] project failed:", err);
          return c.json({ error: "Projection failed" }, 500);
        }
      };
    },
  },
  {
    // Declared LAST so the literal sibling paths above (/overview, /coverage,
    // /orphans, /snapshots) are matched before this parameterised one.
    path: "/api/documentation-tracker/documents/:code",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const g = await gateSession(c, TRACKER_READ_ROLES);
        if (g.error) return g.error;
        try {
          const { getDocumentDetail } = await import("../../utils/docTrackerRead");
          const doc = await getDocumentDetail(
            String(c.req.param("code") || "").toUpperCase(),
          );
          if (!doc) return c.json({ error: "Document not found" }, 404);
          return c.json({ success: true, document: doc });
        } catch (err) {
          safeLogger.error("❌ [DocTracker] document detail failed:", err);
          return c.json({ error: "Failed to load document" }, 500);
        }
      };
    },
  },
];
