/**
 * Integration test: verifies that a wrapped tool call writes
 * `tool_input_preview` and `tool_output_preview` (PII-redacted) to
 * `ai_call_metrics`, and that `getRecentSlowFailedCalls()` reads them
 * back exactly as stored.
 *
 * Skips gracefully when DATABASE_URL is not set so it is safe to run in
 * environments without Postgres.
 *
 * Run:  npx tsx tests/aiToolPreviewRoundTrip.test.ts
 */

import pg from 'pg';
const { Pool } = pg;
import {
  wrapToolWithTelemetry,
  getRecentSlowFailedCalls,
  ensureAiMetricsTable,
} from '../src/utils/aiTelemetry';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('DATABASE_URL not set — skipping ai-tool preview round-trip test.');
    return;
  }

  await ensureAiMetricsTable();

  // Use a unique agent name so we can find our row(s) without races.
  const agentName = `roundtrip-${process.pid}-${Date.now()}`;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ── SUCCESS PATH ──────────────────────────────────────────────────
    const happyTool = {
      id: 'roundTripHappyTool',
      execute: async (args: unknown) => ({
        success: true,
        echo: args,
        contact: 'support@example.com',
      }),
    };
    const wrappedHappy = wrapToolWithTelemetry(happyTool, agentName);
    // Force a >30s "latency" by manipulating started_at after the fact would
    // require extra plumbing; instead we'll select directly by agent_name
    // (recent-issues only returns slow / failed calls). For getRecentSlowFailedCalls()
    // we trigger an explicit failure path below — the success path is verified
    // via direct SELECT.
    await wrappedHappy.execute!({
      query: 'lookup user',
      email: 'alice@example.com',
      token: 'secret=hunter2-not-stored-raw',
    });

    // Wait for the fire-and-forget INSERT to land.
    const happyArrived = await waitForCondition(async () => {
      const r = await pool.query(
        `SELECT 1 FROM ai_call_metrics WHERE agent_name = $1 AND tool_name = $2 LIMIT 1`,
        [agentName, 'roundTripHappyTool'],
      );
      return (r.rowCount ?? 0) > 0;
    });
    assert(happyArrived, 'success-path metric row arrived in ai_call_metrics');

    const happyRow = await pool.query<{
      success: boolean;
      tool_input_preview: string | null;
      tool_output_preview: string | null;
    }>(
      `SELECT success, tool_input_preview, tool_output_preview
         FROM ai_call_metrics
        WHERE agent_name = $1 AND tool_name = $2
        ORDER BY id DESC LIMIT 1`,
      [agentName, 'roundTripHappyTool'],
    );
    const hr = happyRow.rows[0];
    assert(hr?.success === true, 'success column is true on happy path');
    assert(
      typeof hr?.tool_input_preview === 'string'
        && hr.tool_input_preview.includes('[EMAIL]')
        && !hr.tool_input_preview.includes('alice@example.com'),
      'persisted tool_input_preview redacts emails',
    );
    assert(
      typeof hr?.tool_input_preview === 'string'
        && hr.tool_input_preview.includes('[REDACTED]')
        && !hr.tool_input_preview.includes('hunter2-not-stored-raw'),
      'persisted tool_input_preview redacts secret=… values',
    );
    assert(
      typeof hr?.tool_output_preview === 'string'
        && hr.tool_output_preview.includes('[EMAIL]')
        && !hr.tool_output_preview.includes('support@example.com'),
      'persisted tool_output_preview redacts emails',
    );
    assert(
      (hr?.tool_input_preview?.length ?? 0) <= 300
        && (hr?.tool_output_preview?.length ?? 0) <= 300,
      'persisted previews are at most 300 chars',
    );

    // ── FAILURE PATH (surfaced by getRecentSlowFailedCalls) ─────────────
    const sadTool = {
      id: 'roundTripSadTool',
      execute: async () => {
        throw new Error('Backend failed: token=sk_live_should_be_redacted');
      },
    };
    const wrappedSad = wrapToolWithTelemetry(sadTool, agentName);
    let threw = false;
    try {
      await wrappedSad.execute!({ ssn: '4111 1111 1111 1111' });
    } catch {
      threw = true;
    }
    assert(threw, 'wrapper rethrew the failure');

    const sadArrived = await waitForCondition(async () => {
      const r = await pool.query(
        `SELECT 1 FROM ai_call_metrics WHERE agent_name = $1 AND tool_name = $2 LIMIT 1`,
        [agentName, 'roundTripSadTool'],
      );
      return (r.rowCount ?? 0) > 0;
    });
    assert(sadArrived, 'failure-path metric row arrived in ai_call_metrics');

    const issues = await getRecentSlowFailedCalls(200);
    const ourSad = issues.find(
      (i) => i.agent_name === agentName && i.tool_name === 'roundTripSadTool',
    );
    assert(!!ourSad, 'getRecentSlowFailedCalls() returned the failed row');
    assert(
      typeof ourSad?.tool_input_preview === 'string'
        && ourSad.tool_input_preview.includes('[CARD]')
        && !ourSad.tool_input_preview.includes('4111 1111 1111 1111'),
      'recent-issues row exposes redacted tool_input_preview (card masked)',
    );
    assert(
      typeof ourSad?.tool_output_preview === 'string'
        && ourSad.tool_output_preview.includes('[REDACTED]')
        && !ourSad.tool_output_preview.includes('sk_live_should_be_redacted'),
      'recent-issues row exposes redacted tool_output_preview (token masked)',
    );
    assert(
      ourSad?.success === false,
      'recent-issues row marked success=false',
    );
  } finally {
    // Cleanup our test rows so we don't pollute the dashboard.
    try {
      await pool.query(`DELETE FROM ai_call_metrics WHERE agent_name = $1`, [agentName]);
    } catch {
      // best-effort cleanup
    }
    await pool.end();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
