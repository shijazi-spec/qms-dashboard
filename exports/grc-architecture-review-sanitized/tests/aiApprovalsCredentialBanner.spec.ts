/**
 * E2E test — credential-warning banner on the AI Approvals dashboard
 * (Task #482, follow-up to Task #477).
 *
 * Background:
 *   Task #477 added a structural credential-leak detector that runs at the
 *   AI tool boundary (`detectCredentialLikeFields()` in
 *   src/utils/eventLogsDatabase.ts). When a write-tool submission carries
 *   credential-shaped values, the detector emits a list of structured
 *   warnings that is persisted alongside the queued approval row in
 *   `ai_pending_actions.credential_warnings` (JSONB). The operator
 *   approval dashboard renders that list as a red banner via
 *   `renderCredentialWarnings()` in dashboard/ai-approvals.html.
 *
 *   Existing coverage is strong at the unit level
 *   (`tests/aiToolPolicyBuildPreview.test.ts`, 111/111) but no Playwright
 *   spec exercises the full UI flow: persisted column → list endpoint
 *   serialiser → row renderer. A future change to either side could
 *   silently drop the column from the response or break the renderer
 *   without an automated alarm.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth and pins X-Admin-Key on
 *      every browser request (same pattern as
 *      tests/promptVersionTab.spec.ts and tests/aiOpsTabs.spec.ts) so the
 *      dashboard page load AND its AJAX call to /api/ai/approvals are
 *      admin-authorised.
 *   2. Warms up the table by hitting /api/ai/approvals/pending-count so
 *      `initAIApprovalTable()` runs and CREATE TABLE IF NOT EXISTS has
 *      fired before we INSERT directly.
 *   3. Inserts a synthetic ai_pending_actions row with three explicit
 *      credential_warnings entries (one per detector kind we want to
 *      observe in the UI: 'sensitive-key', 'regex' with a patternName,
 *      and 'password'). Direct INSERT — rather than going through
 *      `enqueuePendingAction()` — keeps the assertions deterministic and
 *      decoupled from any future tweak to the detector heuristics.
 *   4. Loads /ai-approvals, finds the seeded row by its action_code, and
 *      asserts:
 *        - the red `[data-credential-warning]` banner is visible inside
 *          the seeded row (and ONLY inside that row),
 *        - the banner shows the human-readable headline copy,
 *        - at least one chip carries each seeded field path,
 *        - the chip title attributes carry the expected kind labels
 *          ('sensitive field name', 'matches sk-key', 'looks like a
 *          password') so a future copy/serialiser regression is caught.
 *   5. Cleans up the seeded row in afterAll.
 *
 * Requirements:
 *   - The dev server must be running at BASE_URL (default
 *     <REDACTED_URL>
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set so /api/admin/auth +
 *     subsequent X-Admin-Key requests succeed; otherwise the suite is
 *     skipped, mirroring the prompt-version / ai-ops-tabs specs.
 *   - DATABASE_URL must point at the same Postgres the server uses so the
 *     seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/aiApprovalsCredentialBanner.spec.ts --reporter=line
 */

import {
  test,
  expect,
  request as pwRequest,
  type Page,
} from "@playwright/test";
import * as crypto from "crypto";
import * as pg from "pg";

const BASE_URL = process.env.BASE_URL || "<REDACTED_URL>";
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

// Per-run uniqueness so concurrent runs / repeated runs don't collide,
// and so the cleanup WHERE clause is unambiguous.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Action code follows the production format APR-YYYYMMDD-XXXXXX so the
// dashboard rendering (escapeHtml + font-mono) doesn't trip on anything
// unexpected. We just borrow the shape — the value itself is synthetic.
function buildActionCode(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  // 6 chars from a fixed alphabet so the code stays valid for the
  // VARCHAR(40) column and doesn't overflow.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[crypto.randomInt(alphabet.length)];
  }
  return `APR-${ymd}-${suffix}-E2E482`;
}

const ACTION_CODE = buildActionCode();
const TOOL_ID = `e2e_credential_banner_${RUN_ID}`;
const TOOL_LABEL = `Rotate API Key (Task 482 e2e ${RUN_ID})`;
const PAYLOAD_PREVIEW = `Rotate API key for fixture integration (Task 482 e2e ${RUN_ID})`;

// Three distinct field paths — one per kind we want to assert is rendered.
// The chips are keyed off the path text in the DOM, so unique per-run
// values make the assertions stable across reruns and against ambient
// production rows.
const PATH_API_KEY = `<REDACTED_SECRET>`;
const PATH_NOTE = `payload.fixture_${RUN_ID}.note`;
const PATH_PASSWORD_BLOB = `<REDACTED_SECRET>`;

const SEED_CREDENTIAL_WARNINGS = [
  { path: PATH_API_KEY, kind: "sensitive-key" as const },
  { path: PATH_NOTE, kind: "regex" as const, patternName: "sk-key" },
  { path: PATH_PASSWORD_BLOB, kind: "password" as const },
];

// dashboard/ai-approvals.html → renderCredentialWarnings() emits these
// title-attribute strings. Asserting against them guards both the
// renderer copy and the JSON keys (kind, patternName) coming back from
// the GET /api/ai/approvals serialiser.
const KIND_LABELS: Record<string, string> = {
  [PATH_API_KEY]: "sensitive field name",
  [PATH_NOTE]: "matches sk-key",
  [PATH_PASSWORD_BLOB]: "looks like a password",
};

let pool: pg.Pool | null = null;

async function seedRow(): Promise<void> {
  if (!pool) throw new Error("pool not initialised");
  // Minimal valid row: NOT NULL columns are populated explicitly,
  // everything else falls back to its column default (status=pending,
  // expires_at=NOW()+24h, compliance_refs='[]', etc.). The
  // payload_checksum value is synthetic — the route doesn't recompute or
  // re-validate it on read, it's only used by the writer.
  const payload = {
    [`fixture_${RUN_ID}`]: {
      api_key: "<REDACTED_SECRET>",
      note: "[REDACTED:STRING]",
      password_blob: "<REDACTED_SECRET>",
    },
  };
  const checksum = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  await pool.query(
    `INSERT INTO ai_pending_actions (
       action_code, tool_id, tool_label,
       payload, payload_preview, payload_checksum,
       risk_level, compliance_refs,
       requested_by_user_id, requested_by_email, requested_by_name,
       thread_id, status, credential_warnings
     ) VALUES (
       $1, $2, $3,
       $4::jsonb, $5, $6,
       'high', '[]'::jsonb,
       NULL, $7, $8,
       $9, 'pending', $10::jsonb
     )`,
    [
      ACTION_CODE,
      TOOL_ID,
      TOOL_LABEL,
      JSON.stringify(payload),
      PAYLOAD_PREVIEW,
      checksum,
      `e2e-task-482-requester-${RUN_ID}@ExampleOrg-test.invalid`,
      `Task 482 e2e Requester ${RUN_ID}`,
      `thr_task_482_e2e_${RUN_ID}`,
      JSON.stringify(SEED_CREDENTIAL_WARNINGS),
    ],
  );
}

async function cleanupRow(): Promise<void> {
  if (!pool) return;
  // Belt-and-braces: delete by action_code AND by tool_id so a crashed
  // mid-seed run still gets swept (the tool_id carries RUN_ID so this
  // can never collide with real rows).
  await pool.query("DELETE FROM ai_pending_actions WHERE action_code = $1", [
    ACTION_CODE,
  ]);
  await pool.query("DELETE FROM ai_pending_actions WHERE tool_id = $1", [
    TOOL_ID,
  ]);
}

async function authenticateAsAdmin(page: Page): Promise<void> {
  // The X-Admin-Key extraHTTPHeaders below is what actually authorises the
  // page load AND the dashboard's AJAX calls. Calling /api/admin/auth too
  // is a courtesy: it drops the admin_key cookie on the browser context so
  // a human watching headed mode is signed in as well.
  const res = await page.request.post(`${BASE_URL}/api/admin/auth`, {
    data: { key: ADMIN_KEY },
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status(), "admin /api/admin/auth login should succeed").toBe(200);
}

// Set when /api/admin/auth rejects ADMIN_KEY (e.g. local dev without
// ADMIN_API_KEY exported on the server) so the per-test guard can skip
// loudly with a useful reason instead of spending the seed budget and
// then failing on the dashboard assertions.
let serverAdminAuthFailed: { status: number } | null = null;

test.describe("AI Approvals — credential-warning banner", () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;

    // Warm up the table via an admin-authenticated read so the lazy
    // `ensureTable()` / `initAIApprovalTable()` CREATE TABLE has fired
    // before we INSERT directly. Without this, a fresh CI Postgres throws
    // `relation "ai_pending_actions" does not exist` on the seed INSERT.
    const apiCtx = await pwRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { "X-Admin-Key": ADMIN_KEY },
    });
    try {
      const authRes = await apiCtx.post("/api/admin/auth", {
        data: { key: ADMIN_KEY },
        headers: { "Content-Type": "application/json" },
      });
      if (authRes.status() === 401 || authRes.status() === 403) {
        // Server's ADMIN_API_KEY env doesn't match (or isn't set) — defer
        // a clean skip to the test body; do NOT seed since we couldn't
        // authenticate and the row would only get orphaned in the DB.
        serverAdminAuthFailed = { status: authRes.status() };
        return;
      }
      if (authRes.status() !== 200) {
        throw new Error(
          `/api/admin/auth login returned HTTP ${authRes.status()}`,
        );
      }
      const warmupRes = await apiCtx.get("/api/ai/approvals/pending-count");
      if (warmupRes.status() !== 200) {
        throw new Error(
          `/api/ai/approvals/pending-count warmup returned HTTP ${warmupRes.status()}`,
        );
      }
    } finally {
      await apiCtx.dispose();
    }

    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await seedRow();
  });

  test.afterAll(async () => {
    try {
      await cleanupRow();
    } finally {
      await pool?.end().catch(() => {});
      pool = null;
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { "X-Admin-Key": ADMIN_KEY } : {},
  });

  test("renders the red credential-warning banner with kind labels and field-path chips", async ({
    page,
  }) => {
    if (!ADMIN_KEY) {
      test.skip(true, "ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment");
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, "DATABASE_URL not set in environment");
      return;
    }
    if (serverAdminAuthFailed) {
      test.skip(
        true,
        `Server rejected ADMIN_KEY (HTTP ${serverAdminAuthFailed.status}); ` +
          `set ADMIN_API_KEY on the server to a value matching TEST_ADMIN_KEY ` +
          `(min length 32, ≥10 distinct chars per src/utils/rbacMiddleware.ts).`,
      );
      return;
    }

    await authenticateAsAdmin(page);

    // Wait for the dashboard's primary list-fetch to complete so we don't
    // race the renderer. The page polls /api/ai/approvals once on load
    // (status=pending is the default filter, which matches our seed row).
    const listResPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/ai/approvals?") &&
        r.request().method() === "GET",
      { timeout: 15000 },
    );
    await page.goto(`${BASE_URL}/ai-approvals`);
    await page.waitForLoadState("domcontentloaded");
    const listRes = await listResPromise;
    expect(
      listRes.status(),
      "list endpoint should serve approvals to the dashboard",
    ).toBe(200);

    // Sanity guard on the JSON serialiser: confirm the credential_warnings
    // column round-trips through the read endpoint untouched. If a future
    // change to the route silently drops the field, this assertion fails
    // with a clear "serialiser dropped credential_warnings" message before
    // we ever look at the DOM.
    interface ApprovalRowJson {
      action_code: string;
      credential_warnings?: unknown;
    }
    interface ApprovalListResponse {
      rows?: ApprovalRowJson[];
    }
    const listBody: ApprovalListResponse = await listRes.json();
    const seededRowJson = (listBody.rows ?? []).find(
      (r) => r.action_code === ACTION_CODE,
    );
    expect(
      seededRowJson,
      "seeded row should be returned by the list endpoint",
    ).toBeDefined();
    const warnings = seededRowJson?.credential_warnings;
    expect(
      Array.isArray(warnings),
      "serialiser must carry credential_warnings as an array",
    ).toBe(true);
    expect(
      warnings as unknown[],
      "serialiser must preserve all three seeded warnings",
    ).toHaveLength(SEED_CREDENTIAL_WARNINGS.length);

    // Locate the seeded row in the DOM. The renderer keys each card by
    // data-code="${action_code}", which is the most stable selector.
    const row = page.locator(`[data-code="${ACTION_CODE}"]`).first();
    await expect(row, "seeded approval row should render").toBeVisible({
      timeout: 10000,
    });

    // The banner sits *inside* the row and carries the data-credential-warning
    // marker added by renderCredentialWarnings(). Scoping the locator to the
    // row guards against false positives from any other approval card on
    // the page that may legitimately carry its own banner.
    const banner = row.locator("[data-credential-warning]");
    await expect(
      banner,
      "red credential-warning banner should be visible inside the seeded row",
    ).toBeVisible();

    // Headline copy — the operator-facing summary. Asserting on it pins
    // the renderer text so a future copy change is at least a deliberate
    // edit rather than a silent regression.
    await expect(
      banner,
      "banner should explain that credential-shaped values were detected",
    ).toContainText("This payload contains values that look like credentials.");
    await expect(
      banner,
      "banner should advise routing real secrets through the secret store",
    ).toContainText("secret store");

    // Red colour treatment — the visual signal operators key off. If a
    // future restyle drops the red palette, this assertion catches it.
    await expect(banner).toHaveClass(/border-red-300/);
    await expect(banner).toHaveClass(/bg-red-50/);

    // One chip per seeded warning — assert each path appears AND its
    // title attribute carries the expected kind label. Using getAttribute
    // (rather than toHaveAttribute) keeps the failure message readable
    // when the renderer mis-maps a kind to its label.
    for (const seeded of SEED_CREDENTIAL_WARNINGS) {
      const chip = banner
        .locator(`span[title]:has-text("${seeded.path}")`)
        .first();
      await expect(
        chip,
        `chip for ${seeded.kind} warning at ${seeded.path} should render`,
      ).toBeVisible();
      const title = await chip.getAttribute("title");
      expect(
        title,
        `chip for ${seeded.path} should carry the expected kind label`,
      ).toBe(KIND_LABELS[seeded.path]);
    }
  });
});
