/**
 * E2E tests for the remaining AI Operations dashboard tabs.
 *
 * Background:
 *   tests/promptVersionTab.spec.ts already covers the "Prompt Version" tab on
 *   /ai-ops, but the four other tabs — Cost Trend, Agent Latency, Top Tools,
 *   and Recent Issues — were only validated at the API level. A future
 *   refactor of dashboard/ai-ops.html could silently break the wiring between
 *   markup, AJAX call, and renderer for any of those tabs without an
 *   automated alarm.
 *
 * What this spec does:
 *   1. Authenticates as admin via /api/admin/auth and pins `X-Admin-Key` on
 *      every browser request (so both the page load and the AJAX calls fired
 *      by ai-ops.html are admin-authorized — same pattern as
 *      tests/promptVersionTab.spec.ts).
 *   2. Seeds three cohorts under one synthetic agent name in
 *      `ai_call_metrics`:
 *        - 2 successful agent-level rows  →  drive Cost Trend + Agent Latency
 *        - 1 failed     agent-level row   →  drives Recent Issues + the
 *                                            error-rate column on Agent
 *                                            Latency + the error_count
 *                                            series on Cost Trend
 *        - 2 successful tool-level rows   →  drive Top Tools (filtered to
 *                                            our synthetic agent so the row
 *                                            isn't pushed off the top-N list
 *                                            by real production traffic)
 *   3. Loads /ai-ops and walks each tab in turn:
 *        - Cost Trend:    waits for /api/ai-ops/cost-trend, asserts the
 *                         canvas is visible, the chart.js instance was
 *                         instantiated, and the response payload contains a
 *                         "today" row whose summed cost meets our seeded
 *                         lower bound (so we know our rows actually flowed
 *                         into the aggregate).
 *        - Agent Latency: clicks the tab, waits for the table, finds the row
 *                         for our agent and asserts call_count = 3 and
 *                         error_rate ≈ 33.3% (1 of 3 failed).
 *        - Top Tools:     clicks the tab, sets the agent filter to our
 *                         synthetic agent, asserts the row keyed by our
 *                         tool name renders with call_count = 2.
 *        - Recent Issues: clicks the tab, asserts the row keyed by the
 *                         seeded failed-call id renders with our distinct
 *                         error_class so we know the right row landed.
 *   4. Cleans up every metric row it seeded on teardown — the per-agent
 *      DELETE is a belt-and-braces sweep in case the suite crashed mid-seed.
 *
 * Requirements:
 *   - The dev server must be running at BASE_URL (default
 *     http://localhost:5000) — same convention as tests/i18n.spec.ts.
 *   - ADMIN_API_KEY (or TEST_ADMIN_KEY) must be set so /api/admin/auth and
 *     subsequent X-Admin-Key requests succeed; otherwise the suite is
 *     skipped, mirroring the prompt-version spec.
 *   - DATABASE_URL must point at the same Postgres the server uses so the
 *     seed/cleanup can write directly.
 *
 * Run:
 *   npx playwright test tests/aiOpsTabs.spec.ts --reporter=line
 */

import { test, expect } from '@playwright/test';
import * as pg from 'pg';
import { warmupAiOpsTables } from './helpers/warmupAiOpsTables';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const ADMIN_KEY = process.env.TEST_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

// Unique per-run suffix so parallel/repeated runs don't collide and so the
// agent-name sweep on teardown is unambiguous.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AGENT_NAME = `e2e_ai_ops_tabs_${RUN_ID}`;
const TOOL_NAME  = `e2e_tool_${RUN_ID}`;
// Distinct error_class so the recent-issues row can be identified
// unambiguously inside the table even when other failures coexist.
const ERROR_CLASS = `E2EOpsTabsError_${RUN_ID}`;
const ERROR_MESSAGE = `E2E ai-ops-tabs seeded failure ${RUN_ID}`;

// Cost amounts used by the cost-trend lower-bound assertion. Two
// successful agent calls + one failed agent call should appear in
// today's UTC bucket; the tool rows are intentionally excluded by the
// query (tool_name IS NULL filter).
const COST_AGENT_OK_USD = 0.5;
const COST_AGENT_FAIL_USD = 0.06;
const SEEDED_AGENT_COST_TOTAL =
  COST_AGENT_OK_USD * 2 + COST_AGENT_FAIL_USD; // 1.06

let pool: pg.Pool | null = null;
const seededCallIds: number[] = [];
let seededFailedCallId: number | null = null;

async function insertMetric(args: {
  toolName: string | null;
  success: boolean;
  latencyMs: number;
  costUsd: number;
  errorClass?: string;
  errorMessage?: string;
}): Promise<number> {
  if (!pool) throw new Error('pool not initialized');
  const res = await pool.query(
    `INSERT INTO ai_call_metrics
       (agent_name, tool_name, model, latency_ms, estimated_cost_usd,
        success, error_class, error_message, started_at)
     VALUES ($1, $2, 'gpt-4o', $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [
      AGENT_NAME,
      args.toolName,
      args.latencyMs,
      args.costUsd,
      args.success,
      args.errorClass ?? null,
      args.errorMessage ?? null,
    ],
  );
  const id = Number(res.rows[0].id);
  seededCallIds.push(id);
  return id;
}

async function seedAiOpsRows(): Promise<void> {
  // Cohort A — agent-level successes. Two rows so call_count = 2 (+1 fail = 3
  // total) and the cost-trend bucket has a clear seeded contribution.
  await insertMetric({ toolName: null, success: true, latencyMs: 1000, costUsd: COST_AGENT_OK_USD });
  await insertMetric({ toolName: null, success: true, latencyMs: 2000, costUsd: COST_AGENT_OK_USD });

  // Cohort B — single agent-level failure. Lands in Recent Issues (NOT
  // success), bumps Cost Trend's error_count series, and gives Agent
  // Latency a 1/3 = 33.3% error rate cell to assert against.
  seededFailedCallId = await insertMetric({
    toolName: null,
    success: false,
    latencyMs: 5000,
    costUsd: COST_AGENT_FAIL_USD,
    errorClass: ERROR_CLASS,
    errorMessage: ERROR_MESSAGE,
  });

  // Cohort C — tool-level successes. Drives the Top Tools tab; we filter the
  // table by AGENT_NAME at assert time so the row can't be pushed off the
  // top-15 list by unrelated production traffic.
  await insertMetric({ toolName: TOOL_NAME, success: true, latencyMs: 400, costUsd: 0.0007 });
  await insertMetric({ toolName: TOOL_NAME, success: true, latencyMs: 600, costUsd: 0.0007 });
}

async function cleanupAiOpsRows(): Promise<void> {
  if (!pool) return;
  if (seededCallIds.length > 0) {
    await pool.query(
      `DELETE FROM ai_call_metrics WHERE id = ANY($1::bigint[])`,
      [seededCallIds],
    );
    seededCallIds.length = 0;
  }
  // Belt-and-braces sweep — covers any partial-seed state if a row insert
  // failed before its id made it onto seededCallIds.
  await pool.query(
    `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
    [AGENT_NAME],
  );
}

// We intentionally skip a per-test POST /api/admin/auth login here. The
// X-Admin-Key header (set via test.use({ extraHTTPHeaders }) below) is what
// actually authorizes every request — both the page load AND the AJAX calls
// fired by ai-ops.html. Calling the login route once per test would also
// trip the /api/admin/auth rate limiter (5 attempts / minute) and turn this
// 4-test suite into a flaky ratchet on repeated runs.

test.describe('AI Ops — remaining dashboard tabs', () => {
  test.beforeAll(async () => {
    if (!ADMIN_KEY || !DATABASE_URL) return;
    // Authenticate as admin and trigger the lazy CREATE TABLE IF NOT EXISTS
    // statements for the AI Ops tables before we INSERT seed rows directly
    // via the pool. See tests/helpers/warmupAiOpsTables.ts for why this is
    // needed (otherwise a cold dev DB throws
    // `relation "ai_call_metrics" does not exist` on the first INSERT).
    await warmupAiOpsTables(ADMIN_KEY, BASE_URL);
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await seedAiOpsRows();
  });

  test.afterAll(async () => {
    try {
      await cleanupAiOpsRows();
    } finally {
      await pool?.end().catch(() => {});
      pool = null;
    }
  });

  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { 'X-Admin-Key': ADMIN_KEY } : {},
  });

  test('Cost Trend tab renders chart and includes seeded agent-level cost', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }



    // Set up the wait BEFORE goto — loadCostTrend() fires from
    // DOMContentLoaded so the response can race the page-load resolution.
    const costTrendResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/cost-trend') && r.request().method() === 'GET',
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    const costTrendRes = await costTrendResPromise;
    expect(costTrendRes.status(), 'cost-trend API should succeed').toBe(200);
    const payload = await costTrendRes.json();
    const rows: Array<{ day: string; total_cost: string | number; error_count: string | number }> =
      payload?.data ?? [];

    // Verify the seeded contribution made it into today's UTC bucket. Other
    // production rows may also live in that bucket, so we assert a lower
    // bound rather than equality.
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = rows.find(r => String(r.day).slice(0, 10) === today);
    expect(todayRow, `cost-trend should contain a row for today (${today})`).toBeTruthy();
    const todayCost = parseFloat(String(todayRow!.total_cost ?? '0'));
    expect(todayCost).toBeGreaterThanOrEqual(SEEDED_AGENT_COST_TOTAL - 0.0001);
    const todayErrorCount = parseInt(String(todayRow!.error_count ?? '0'), 10);
    expect(todayErrorCount, 'today bucket should reflect the seeded failure').toBeGreaterThanOrEqual(1);

    // Cost Trend is the default tab — assert its container is visible and
    // the canvas/chart instance was actually created.
    const costContent = page.locator('#content-cost');
    await expect(costContent).toBeVisible();
    const canvas = page.locator('#cost-chart');
    await expect(canvas).toBeVisible();

    // Wait for chart.js to wire its instance to the canvas. The dashboard
    // declares `let costChart = null` at the top of an inline <script>, so
    // `window.costChart` is intentionally not exposed — go through the
    // chart.js `Chart.getChart()` registry instead.
    await page.waitForFunction(
      () => {
        const C: any = (window as any).Chart;
        if (!C || typeof C.getChart !== 'function') return false;
        const inst = C.getChart('cost-chart');
        return !!inst && Array.isArray(inst.data?.labels) && inst.data.labels.length > 0;
      },
      undefined,
      { timeout: 15000 },
    );

    // Verify the chart's first dataset (cost) sums to at least the seeded
    // contribution — proves the seeded values reached the rendered chart.
    const sumChartCost = await page.evaluate(() => {
      const C: any = (window as any).Chart;
      const inst = C?.getChart?.('cost-chart');
      if (!inst) return 0;
      const arr = inst.data?.datasets?.[0]?.data ?? [];
      return arr.reduce((acc: number, v: any) => acc + (parseFloat(v) || 0), 0);
    });
    expect(sumChartCost).toBeGreaterThanOrEqual(SEEDED_AGENT_COST_TOTAL - 0.0001);
  });

  test('Agent Latency tab renders seeded agent row with correct call_count and error rate', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }

    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Click the tab button directly — safe-actions.js wires `data-on-click`
    // via event delegation so the click triggers switchTab() without any
    // inline onclick= handler (which the CSP would block).
    const latencyResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/agent-latency'),
      { timeout: 15000 },
    );

    await page.locator('[data-testid="tab-latency"]').click();

    const latencyRes = await latencyResPromise;
    expect(latencyRes.status()).toBe(200);

    const table = page.locator('[data-testid="table-agent-latency"]');
    await expect(table).toBeVisible({ timeout: 10000 });

    // Each row's first cell carries the agent name; filter by it. Rows are
    // testid'd row-agent-${i} so we can't address ours directly by name, but
    // hasText is reliable because AGENT_NAME has a unique RUN_ID suffix.
    const seededRow = table.locator('tr[data-testid^="row-agent-"]').filter({ hasText: AGENT_NAME });
    await expect(seededRow, 'seeded agent row should appear in the latency table').toHaveCount(1);

    // Assert call_count cell == 3 (2 successes + 1 failure). The cell
    // rendering uses fmtNum which renders raw integers as "3".
    const cells = seededRow.locator('td');
    await expect(cells.nth(0)).toHaveText(AGENT_NAME);
    await expect(cells.nth(1), 'call_count cell should show 3').toHaveText('3');

    // Error rate cell — 1 of 3 failed = 33.3%. Rendered with .toFixed(1) +
    // "%" so it should be the literal "33.3%".
    await expect(cells.nth(5), 'error rate should show 33.3%').toContainText('33.3%');
  });

  test('Top Tools tab renders seeded tool row when filtered to our agent', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }


    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Click the tab button — safe-actions.js event delegation handles
    // `data-on-click="switchTab"` and triggers loadTools() for us.
    const initialToolsResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/top-tools'),
      { timeout: 15000 },
    );

    await page.locator('[data-testid="tab-tools"]').click();
    await initialToolsResPromise;

    // The agent filter is populated asynchronously inside loadTools(). Wait
    // for our synthetic agent to appear as an option before filtering.
    const agentFilter = page.locator('[data-testid="select-tools-agent-filter"]');
    await expect(agentFilter).toBeVisible();
    await expect(agentFilter.locator(`option[value="${AGENT_NAME}"]`)).toHaveCount(1, { timeout: 10000 });

    // The <select> uses data-on-change="loadTools" handled by safe-actions.js.
    // Playwright's selectOption fires a real change event, so event delegation
    // calls loadTools() automatically — no page.evaluate needed.
    const filteredToolsResPromise = page.waitForResponse(
      r =>
        r.url().includes('/api/ai-ops/top-tools') &&
        r.url().includes(`agent=${encodeURIComponent(AGENT_NAME)}`),
      { timeout: 15000 },
    );
    await agentFilter.selectOption(AGENT_NAME);
    const filteredRes = await filteredToolsResPromise;
    expect(filteredRes.status()).toBe(200);

    const toolsTable = page.locator('[data-testid="table-top-tools"]');
    await expect(toolsTable).toBeVisible({ timeout: 10000 });

    // Tool rows carry data-tool-name, which is the most stable selector
    // since row testids are positional (row-tool-${i}).
    const toolRow = toolsTable.locator(`tr[data-tool-name="${TOOL_NAME}"]`);
    await expect(toolRow, 'seeded tool row should render').toHaveCount(1);

    const cells = toolRow.locator('td');
    await expect(cells.nth(0)).toHaveText(TOOL_NAME);
    await expect(cells.nth(1)).toHaveText(AGENT_NAME);
    await expect(cells.nth(2), 'call_count cell should show 2').toHaveText('2');
  });

  test('Recent Issues tab renders the seeded failed call', async ({ page }) => {
    if (!ADMIN_KEY) {
      test.skip(true, 'ADMIN_API_KEY / TEST_ADMIN_KEY not set in environment');
      return;
    }
    if (!DATABASE_URL) {
      test.skip(true, 'DATABASE_URL not set in environment');
      return;
    }
    expect(seededFailedCallId, 'seed step should have produced a failed-call id').not.toBeNull();


    await page.goto(`${BASE_URL}/ai-ops`);
    await page.waitForLoadState('domcontentloaded');

    // Click the tab button directly — safe-actions.js handles data-on-click
    // via event delegation, so this triggers switchTab('issues') → loadIssues().
    const issuesResPromise = page.waitForResponse(
      r => r.url().includes('/api/ai-ops/recent-issues'),
      { timeout: 15000 },
    );

    await page.locator('[data-testid="tab-issues"]').click();

    const issuesRes = await issuesResPromise;
    expect(issuesRes.status()).toBe(200);

    const table = page.locator('[data-testid="table-recent-issues"]');
    await expect(table).toBeVisible({ timeout: 10000 });

    // Rows are keyed by call id — no positional-index ambiguity here.
    const seededRow = page.locator(`[data-testid="row-issue-${seededFailedCallId}"]`);
    await expect(seededRow, 'seeded failed-call row should render').toBeVisible();
    await expect(seededRow, 'row should show our distinct error_class').toContainText(ERROR_CLASS);
    await expect(seededRow, 'row should show our agent_name').toContainText(AGENT_NAME);
    // The "Status" cell renders "Error" for failed calls.
    await expect(seededRow, 'failed call should be flagged as Error').toContainText('Error');
  });
});
