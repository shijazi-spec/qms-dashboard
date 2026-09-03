/**
 * Unit test — Redaction-sweep dashboard panel: flagged approval IDs (Task #625)
 * --------------------------------------------------------------------------
 * Task #488 added a `flagged_action_codes` list (capped at 50, plus a
 * `flagged_action_codes_truncated` counter) to
 * `audit-evidence/last-sweep.json` so auditors can see WHICH legacy
 * approval rows the credential sweep retroactively flagged. Task #625
 * surfaces that list in the dashboard's "Last redaction sweep" panel
 * (dashboard/logs.html → renderRedactionSweep) so operators can jump
 * straight from "the boot sweep flagged 7 legacy rows" to the AI
 * approvals detail modal for those exact rows.
 *
 * This test loads dashboard/logs.html into JSDOM, runs the inline
 * scripts, stubs window.fetch for /api/admin/redaction-sweep/status, and
 * asserts:
 *
 *   1. When `flagged_action_codes` has entries, the panel renders one
 *      link per code pointing at /ai-approvals?code=APR-... (the same
 *      deep link that ai-approvals.html's handleDeepLink() consumes).
 *   2. When `flagged_action_codes_truncated > 0`, the "+N more (see
 *      audit-evidence/last-sweep.json)" suffix appears.
 *   3. When the list is empty (clean sweep), the panel renders nothing
 *      extra — no flagged-approvals row, no truncation suffix.
 *   4. When the credential-warnings result is `{ skipped: ... }` (e.g.
 *      table missing), no flagged-approvals row appears.
 *   5. Codes are URL-encoded in the href (defense-in-depth — codes are
 *      validated upstream but the link must not be a generic XSS sink).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTML_PATH = resolve(__dirname, '..', '..', 'dashboard', 'logs.html');
const HTML_SOURCE = readFileSync(HTML_PATH, 'utf8');

interface CredentialWarningsSnapshot {
  scanned: number;
  rows_updated: number;
  warnings_added: number;
  flagged_action_codes: string[];
  flagged_action_codes_truncated: number;
}

interface SweepPayload {
  recorded: boolean;
  sweep: {
    sweep_timestamp: string;
    event_logs_updated: number;
    nc_change_history_updated: number;
    nc_change_history_change_reason_updated: number;
    capa_change_history_updated: number;
    capa_change_history_change_reason_updated: number;
    ai_pending_actions: { scanned: number; rows_updated: number };
    ai_pending_actions_credential_warnings:
      | CredentialWarningsSnapshot
      | { skipped: string };
    ai_call_metrics: { scanned: number; rows_updated: number };
    total_rows_updated: number;
  };
}

function basePayload(
  credWarn: CredentialWarningsSnapshot | { skipped: string },
  totalRowsUpdated = 0,
): SweepPayload {
  return {
    recorded: true,
    sweep: {
      sweep_timestamp: '2026-04-25T13:27:58.055Z',
      event_logs_updated: 0,
      nc_change_history_updated: 0,
      nc_change_history_change_reason_updated: 0,
      capa_change_history_updated: 0,
      capa_change_history_change_reason_updated: 0,
      ai_pending_actions: { scanned: 0, rows_updated: 0 },
      ai_pending_actions_credential_warnings: credWarn,
      ai_call_metrics: { scanned: 294, rows_updated: 0 },
      total_rows_updated: totalRowsUpdated,
    },
  };
}

interface SetupResult {
  win: any;
  doc: Document;
  cleanup: () => void;
  fetchMock: ReturnType<typeof vi.fn>;
  waitForSweepRender: () => Promise<HTMLElement>;
}

function setupDom(payload: SweepPayload): SetupResult {
  const dom = new JSDOM(HTML_SOURCE, {
    url: '<REDACTED_URL>',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win: any = dom.window;
  const doc: Document = win.document;

  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url !== 'string') url = String(url);
    if (url.startsWith('/api/admin/redaction-sweep/status')) {
      return makeJsonResponse(win, payload);
    }
    // Anything else: 200 with empty payload so the page's other
    // background fetches don't blow up. The test only cares about the
    // sweep panel.
    return makeJsonResponse(win, {});
  });
  win.fetch = fetchMock;

  // Suppress setInterval polling so the test doesn't race background work.
  win.setInterval = ((..._args: any[]) => 0) as any;
  win.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as any;

  // Stub globals that the inline scripts reference but that come from
  // external <script src> tags JSDOM in 'outside-only' mode does not
  // load.
  win.ExampleOrgNav = { init: () => {} };
  win.ExampleOrgI18n = {
    init: () => Promise.resolve(),
    applyToDOM: () => {},
    t: (k: string) => k,
    tDynamic: (_p: string, v: string) => v,
  };
  win.streamingDownload = {
    fetchEstimate: () => Promise.resolve(null),
    applySizeHint: () => {},
  };

  const inlineScripts = Array.from(doc.querySelectorAll('script'))
    .filter(s => !s.getAttribute('src'))
    .map(s => s.textContent || '');
  for (const code of inlineScripts) {
    if (!code.trim()) continue;
    try {
      win.eval(code);
    } catch (_err) {
      // Some inline scripts kick off side-effect bootstrapping that
      // depends on auth / data we haven't stubbed; ignore those — the
      // panel rendering path we care about is reached either via the
      // initial loadRedactionSweepStatus() call or our manual trigger
      // below.
    }
  }
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));

  // The page's own DOMContentLoaded handler invokes
  // loadRedactionSweepStatus(); call it directly too to make the test
  // resilient to ordering changes.
  if (typeof win.loadRedactionSweepStatus === 'function') {
    void win.loadRedactionSweepStatus();
  }

  async function waitFor<T>(
    fn: () => T | null | undefined,
    label: string,
    timeoutMs = 1500,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`Timeout waiting for: ${label}`);
  }

  return {
    win,
    doc,
    fetchMock,
    waitForSweepRender: () =>
      waitFor(() => {
        const body = doc.getElementById('sweepBody');
        if (!body) return null;
        // The breakdown table only appears once renderRedactionSweep()
        // has populated #sweepBody.
        return body.querySelector<HTMLElement>('[data-testid="table-sweep-breakdown"]');
      }, 'sweep breakdown table'),
    cleanup: () => {
      dom.window.close();
    },
  };
}

function makeJsonResponse(win: any, body: any, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => JSON.stringify(body),
  };
}

describe('Last redaction sweep panel — flagged_action_codes (Task #625)', () => {
  let ctx: SetupResult | null = null;

  afterEach(() => {
    if (ctx) {
      ctx.cleanup();
      ctx = null;
    }
    vi.restoreAllMocks();
  });

  it('renders one link per flagged action code, pointing at /ai-approvals?code=...', async () => {
    ctx = setupDom(
      basePayload(
        {
          scanned: 12,
          rows_updated: 7,
          warnings_added: 7,
          flagged_action_codes: [
            'APR-20260101-AAAAAA',
            'APR-20260102-BBBBBB',
            'APR-20260103-CCCCCC',
          ],
          flagged_action_codes_truncated: 0,
        },
        7,
      ),
    );
    await ctx.waitForSweepRender();

    const row = ctx.doc.querySelector<HTMLElement>(
      '[data-testid="row-flagged-action-codes"]',
    );
    expect(row, 'flagged-codes row should render').not.toBeNull();

    const links = Array.from(
      row!.querySelectorAll<HTMLAnchorElement>('a[data-testid^="link-flagged-action-code-"]'),
    );
    expect(links.length).toBe(3);

    const hrefs = links.map(a => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/ai-approvals?code=APR-20260101-AAAAAA',
      '/ai-approvals?code=APR-20260102-BBBBBB',
      '/ai-approvals?code=APR-20260103-CCCCCC',
    ]);

    const codeLabels = links.map(a => a.textContent?.trim());
    expect(codeLabels).toEqual([
      'APR-20260101-AAAAAA',
      'APR-20260102-BBBBBB',
      'APR-20260103-CCCCCC',
    ]);

    // No truncation suffix when flagged_action_codes_truncated === 0.
    expect(
      ctx.doc.querySelector('[data-testid="text-flagged-action-codes-truncated"]'),
    ).toBeNull();
  });

  it('appends "+N more (see audit-evidence/last-sweep.json)" suffix when truncation count > 0', async () => {
    ctx = setupDom(
      basePayload(
        {
          scanned: 120,
          rows_updated: 73,
          warnings_added: 73,
          flagged_action_codes: ['APR-20260101-AAAAAA', 'APR-20260102-BBBBBB'],
          flagged_action_codes_truncated: 23,
        },
        73,
      ),
    );
    await ctx.waitForSweepRender();

    const truncated = ctx.doc.querySelector<HTMLElement>(
      '[data-testid="text-flagged-action-codes-truncated"]',
    );
    expect(truncated, 'truncation suffix should render').not.toBeNull();
    expect(truncated!.textContent).toContain('+23 more');
    expect(truncated!.textContent).toContain('audit-evidence/last-sweep.json');
  });

  it('renders nothing extra for the clean-sweep case (empty flagged_action_codes)', async () => {
    ctx = setupDom(
      basePayload({
        scanned: 0,
        rows_updated: 0,
        warnings_added: 0,
        flagged_action_codes: [],
        flagged_action_codes_truncated: 0,
      }),
    );
    await ctx.waitForSweepRender();

    expect(
      ctx.doc.querySelector('[data-testid="row-flagged-action-codes"]'),
      'no flagged-codes row on a clean sweep',
    ).toBeNull();
    expect(
      ctx.doc.querySelector('[data-testid="text-flagged-action-codes-truncated"]'),
      'no truncation suffix on a clean sweep',
    ).toBeNull();

    // The credential-warnings row itself still renders (with 0 / scanned 0).
    const breakdown = ctx.doc.querySelector<HTMLElement>(
      '[data-testid="table-sweep-breakdown"]',
    );
    expect(breakdown!.textContent).toContain('ai_pending_actions credential warnings');
  });

  it('renders nothing extra when the credential-warnings step was skipped', async () => {
    ctx = setupDom(basePayload({ skipped: 'table missing' }));
    await ctx.waitForSweepRender();

    expect(
      ctx.doc.querySelector('[data-testid="row-flagged-action-codes"]'),
      'no flagged-codes row when the step was skipped',
    ).toBeNull();

    // Skipped row is still rendered by renderSweepBreakdownRow.
    const breakdown = ctx.doc.querySelector<HTMLElement>(
      '[data-testid="table-sweep-breakdown"]',
    );
    expect(breakdown!.textContent).toContain('skipped (table missing)');
  });

  it('URL-encodes action codes defensively in the href', async () => {
    // Real action codes match /^APR-\d{8}-[A-Z0-9]+$/ but the renderer
    // should not assume that — defense-in-depth keeps the link from
    // becoming a generic injection sink if the upstream cap ever drifts.
    ctx = setupDom(
      basePayload(
        {
          scanned: 1,
          rows_updated: 1,
          warnings_added: 1,
          flagged_action_codes: ['APR-2026 0101&x=1'],
          flagged_action_codes_truncated: 0,
        },
        1,
      ),
    );
    await ctx.waitForSweepRender();

    const link = ctx.doc.querySelector<HTMLAnchorElement>(
      'a[data-testid^="link-flagged-action-code-"]',
    );
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      '/ai-approvals?code=APR-2026%200101%26x%3D1',
    );
    // The visible text is HTML-escaped by the existing escapeHtml() helper
    // — the ampersand round-trips back to '&' in textContent because the
    // browser decodes it for us.
    expect(link!.textContent).toBe('APR-2026 0101&x=1');
  });
});
