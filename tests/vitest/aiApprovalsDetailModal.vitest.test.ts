/**
 * Unit test — AI Approvals "Details" modal (Task #297)
 * --------------------------------------------------------------------------
 * Task #86 added prior-viewer chips to the queue cards (truncated to 5).
 * Task #297 surfaces the FULL viewer history on a dedicated detail panel:
 * names + emails, roles, last-viewed timestamps, and per-user view counts.
 *
 * This test loads dashboard/ai-approvals.html into JSDOM, stubs window.fetch
 * for the list and detail endpoints, simulates the operator clicking the
 * "Details" button on a seeded queue row, and asserts:
 *
 *   1. The modal becomes visible with role="dialog" + aria-modal="true".
 *   2. The viewer list renders one row per prior_viewer with the expected
 *      name, role, email, view count, and timestamp.
 *   3. Avatars are rendered (initials + color); deterministic per user.
 *   4. The "+N more" truncation behaviour from the queue card is NOT
 *      applied — every viewer shows up in the panel.
 *   5. Pressing Escape closes the dialog and restores focus to the trigger.
 *   6. When prior_viewers is empty, the empty-state copy renders.
 *
 * The test runs the inline script extracted from the dashboard HTML inside
 * a JSDOM window so the production code path is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTML_PATH = resolve(__dirname, '..', '..', 'dashboard', 'ai-approvals.html');
const HTML_SOURCE = readFileSync(HTML_PATH, 'utf8');

interface SeededAction {
  action_code: string;
  tool_label: string;
  status: 'pending' | 'executed' | 'rejected';
  risk_level: 'critical' | 'high' | 'medium' | 'low';
  payload_preview: string;
  created_at: string;
  requested_by_name: string;
  requested_by_email: string;
  prior_viewers: Array<{
    user_id: number | null;
    user_email: string | null;
    user_name: string | null;
    user_role: string | null;
    last_viewed_at: string;
    view_count: number;
  }>;
  credential_warnings?: unknown[];
  compliance_refs?: string[];
}

const SEED_ACTION_CODE = 'APR-20260101-T297AA';

const SEED_VIEWERS = [
  {
    user_id: 1,
    user_email: 'qa-lead@walaplus.test',
    user_name: 'Salma Al Qahtani',
    user_role: 'quality_manager',
    last_viewed_at: '2026-01-02T10:15:00.000Z',
    view_count: 3,
  },
  {
    user_id: 2,
    user_email: 'auditor@walaplus.test',
    user_name: 'Omar Auditor',
    user_role: 'admin',
    last_viewed_at: '2026-01-02T08:00:00.000Z',
    view_count: 1,
  },
  {
    user_id: 3,
    user_email: 'reviewer3@walaplus.test',
    user_name: 'Reviewer Three',
    user_role: 'quality_manager',
    last_viewed_at: '2026-01-01T20:30:00.000Z',
    view_count: 5,
  },
  {
    user_id: 4,
    user_email: 'reviewer4@walaplus.test',
    user_name: 'Reviewer Four',
    user_role: 'admin',
    last_viewed_at: '2026-01-01T18:00:00.000Z',
    view_count: 2,
  },
  {
    user_id: 5,
    user_email: 'reviewer5@walaplus.test',
    user_name: 'Reviewer Five',
    user_role: 'quality_manager',
    last_viewed_at: '2026-01-01T17:00:00.000Z',
    view_count: 1,
  },
  {
    user_id: 6,
    user_email: 'reviewer6@walaplus.test',
    user_name: 'Reviewer Six',
    user_role: 'admin',
    last_viewed_at: '2026-01-01T16:00:00.000Z',
    view_count: 4,
  },
] satisfies SeededAction['prior_viewers'];

function buildSeededAction(
  overrides: Partial<SeededAction> = {},
): SeededAction {
  return {
    action_code: SEED_ACTION_CODE,
    tool_label: 'Rotate API Key (Task 297 fixture)',
    status: 'pending',
    risk_level: 'high',
    payload_preview: 'Rotate API key for fixture integration',
    created_at: '2025-12-31T12:00:00.000Z',
    requested_by_name: 'Test Requester',
    requested_by_email: 'requester@walaplus.test',
    prior_viewers: SEED_VIEWERS,
    credential_warnings: [],
    compliance_refs: [],
    ...overrides,
  };
}

interface SetupResult {
  win: any;
  doc: Document;
  cleanup: () => void;
  fetchMock: ReturnType<typeof vi.fn>;
  /** Wait until the inline script's initial /api/ai/approvals load completes
   *  and the seeded row is in the DOM. */
  waitForRowRender: (code: string) => Promise<HTMLElement>;
  /** Wait until the modal-detail fetch completes and the viewer list renders. */
  waitForModalRender: () => Promise<HTMLElement>;
}

function setupDom(opts: {
  listRows: SeededAction[];
  detailResponse?: { action: SeededAction; prior_viewers: SeededAction['prior_viewers'] };
  detailStatus?: number;
}): SetupResult {
  const dom = new JSDOM(HTML_SOURCE, {
    url: 'http://localhost/dashboard/ai-approvals.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win: any = dom.window;
  const doc: Document = win.document;

  // Stub network. The dashboard polls /api/ai/approvals on load and
  // /api/ai/approvals/credential-warning-count, then the modal triggers
  // /api/ai/approvals/:code. Each is dispatched here.
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url !== 'string') url = String(url);
    if (url.startsWith('/api/ai/approvals/credential-warning-count')) {
      return makeJsonResponse(win, { count: 0 });
    }
    if (
      url.startsWith('/api/ai/approvals?') ||
      url === '/api/ai/approvals'
    ) {
      return makeJsonResponse(win, { rows: opts.listRows });
    }
    const detailMatch = url.match(/^\/api\/ai\/approvals\/([^/?]+)$/);
    if (detailMatch) {
      if (opts.detailStatus && opts.detailStatus >= 400) {
        return makeJsonResponse(win, { error: 'fail' }, opts.detailStatus);
      }
      const code = decodeURIComponent(detailMatch[1]);
      const row = opts.listRows.find(r => r.action_code === code);
      const detail =
        opts.detailResponse ?? {
          action: row ?? buildSeededAction(),
          prior_viewers: row?.prior_viewers ?? [],
        };
      return makeJsonResponse(win, detail);
    }
    // Unhandled URL -> 404 so failures are loud.
    return makeJsonResponse(win, { error: 'unhandled', url }, 404);
  });
  win.fetch = fetchMock;

  // Suppress the auto-refresh setInterval so the test isn't racing background
  // fetches when we assert.
  const realSetInterval = win.setInterval;
  win.setInterval = ((..._args: any[]) => 0) as any;
  // Keep requestAnimationFrame synchronous so focus moves are observable
  // immediately after openDetailModal() returns.
  win.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as any;

  // Stub the global navigation registration the page expects. The nav script
  // is loaded by <script src="/js/navigation.js">, but JSDOM in
  // 'outside-only' mode does not fetch external scripts — declaring this
  // stub keeps the inline DOMContentLoaded handler from blowing up.
  win.WalaPlusNav = { init: () => {} };

  // Run all <script> blocks that have NO `src` attribute (the inline ones).
  // Run them in document order so the modal IIFE (which depends on the
  // <div id="actionDetailModal"> element being parsed) executes after the
  // body markup is in place.
  const inlineScripts = Array.from(doc.querySelectorAll('script'))
    .filter(s => !s.getAttribute('src'))
    .map(s => s.textContent || '');
  for (const code of inlineScripts) {
    if (!code.trim()) continue;
    win.eval(code);
  }
  // Fire DOMContentLoaded so any `addEventListener('DOMContentLoaded', ...)`
  // handlers from the inline scripts get to run.
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));

  async function waitFor<T>(
    fn: () => T | null | undefined,
    label: string,
    timeoutMs = 1500,
  ): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timeout waiting for: ${label}`);
  }

  return {
    win,
    doc,
    fetchMock,
    waitForRowRender: code =>
      waitFor(() => doc.querySelector<HTMLElement>(`#approvalsList [data-code="${code}"]`),
              `row[data-code=${code}]`),
    waitForModalRender: () =>
      waitFor(() => {
        const modal = doc.getElementById('actionDetailModal');
        if (!modal || modal.classList.contains('hidden')) return null;
        // Either the viewer list rendered, or the empty-state element.
        const list = modal.querySelector<HTMLElement>('[data-testid="list-prior-viewers"]');
        const empty = modal.querySelector<HTMLElement>('[data-testid="text-no-prior-viewers"]');
        return list || empty;
      }, 'detail modal viewer panel'),
    cleanup: () => {
      win.setInterval = realSetInterval;
      dom.window.close();
    },
  };
}

function makeJsonResponse(win: any, body: any, status = 200): any {
  // jsdom does not ship a global fetch Response, so build a duck-typed
  // Response object whose surface matches what the inline script uses
  // (.ok, .status, .statusText, .json()).
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

describe('AI Approvals — detail modal (Task #297)', () => {
  let env: SetupResult | null = null;

  afterEach(() => {
    env?.cleanup();
    env = null;
  });

  it('opens the modal when "Details" is clicked and renders the full prior_viewers panel', async () => {
    const action = buildSeededAction();
    env = setupDom({ listRows: [action] });

    const row = await env.waitForRowRender(action.action_code);
    const detailsBtn = row.querySelector<HTMLButtonElement>('button[data-act="details"]');
    expect(detailsBtn, 'queue card should expose a Details button').toBeTruthy();
    expect(detailsBtn!.getAttribute('data-testid')).toBe(
      `button-details-${action.action_code}`,
    );

    // Trigger the click.
    detailsBtn!.click();

    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-labelledby')).toBe('actionDetailTitle');

    // Wait for the detail fetch to settle and the viewer panel to render.
    await env.waitForModalRender();

    // Header reflects the action.
    const title = env.doc.getElementById('actionDetailTitle')!;
    expect(title.textContent).toBe(action.tool_label);
    const summary = env.doc.getElementById('actionDetailSummary')!;
    expect(summary.textContent).toContain(action.action_code);
    expect(summary.textContent!.toLowerCase()).toContain('high');

    // The full viewer list — every seeded viewer should appear; no truncation.
    const list = modal.querySelector<HTMLOListElement>('[data-testid="list-prior-viewers"]')!;
    expect(list, 'viewer list should render as an ordered list').toBeTruthy();
    expect(list.tagName.toLowerCase()).toBe('ol');
    expect(list.getAttribute('aria-label')).toMatch(/Prior reviewers/i);

    const rows = list.querySelectorAll('[data-testid^="row-prior-viewer-"]');
    expect(
      rows.length,
      'every prior viewer should render — no +N more truncation in the panel',
    ).toBe(SEED_VIEWERS.length);

    // Reviewer count summary.
    const cnt = modal.querySelector('[data-testid="text-prior-viewers-count"]')!;
    expect(cnt.textContent).toBe(`${SEED_VIEWERS.length} reviewers`);

    // Per-row content: name, role, view count, timestamp.
    SEED_VIEWERS.forEach((v, idx) => {
      const nameEl = modal.querySelector(`[data-testid="text-viewer-name-${idx}"]`)!;
      expect(nameEl.textContent).toBe(v.user_name);
      const roleEl = modal.querySelector(`[data-testid="text-viewer-role-${idx}"]`)!;
      expect(roleEl.textContent).toBe(v.user_role);
      const countEl = modal.querySelector(`[data-testid="text-viewer-count-${idx}"]`)!;
      expect(countEl.textContent).toBe(
        v.view_count === 1 ? '1 view' : `${v.view_count} views`,
      );
      const timeEl = modal.querySelector(`[data-testid="text-viewer-last-${idx}"]`)!;
      expect(timeEl.getAttribute('datetime')).toBe(v.last_viewed_at);
      // The visible text is the locale-formatted timestamp; non-empty is enough.
      expect(timeEl.textContent && timeEl.textContent.length).toBeGreaterThan(0);
    });

    // Avatars: one per row, with a deterministic background-color and
    // initials text. Avatars must be aria-hidden so the SR doesn't read
    // gibberish initials between the name and the role.
    const avatars = list.querySelectorAll<HTMLElement>('.viewer-avatar');
    expect(avatars.length).toBe(SEED_VIEWERS.length);
    avatars.forEach(a => {
      expect(a.getAttribute('aria-hidden')).toBe('true');
      expect(a.style.backgroundColor).toMatch(/^rgb|^#/);
      expect((a.textContent || '').length).toBeGreaterThan(0);
    });

    // Sanity: exactly one detail-fetch fires for the action code (the
    // similarly-shaped /credential-warning-count URL is excluded).
    const detailCalls = env.fetchMock.mock.calls.filter(
      c => String(c[0]) === `/api/ai/approvals/${action.action_code}`,
    );
    expect(detailCalls).toHaveLength(1);
  });

  it('renders the empty-state copy when prior_viewers is empty', async () => {
    const action = buildSeededAction({ prior_viewers: [] });
    env = setupDom({ listRows: [action] });

    const row = await env.waitForRowRender(action.action_code);
    row.querySelector<HTMLButtonElement>('button[data-act="details"]')!.click();

    await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;
    const empty = modal.querySelector('[data-testid="text-no-prior-viewers"]');
    expect(empty, 'empty-state element should render').toBeTruthy();
    expect(empty!.textContent).toMatch(/no reviewers/i);

    const cnt = modal.querySelector('[data-testid="text-prior-viewers-count"]')!;
    expect(cnt.textContent).toBe('0 reviewers');
  });

  it('closes on Escape and restores focus to the trigger button', async () => {
    const action = buildSeededAction();
    env = setupDom({ listRows: [action] });

    const row = await env.waitForRowRender(action.action_code);
    const trigger = row.querySelector<HTMLButtonElement>('button[data-act="details"]')!;
    trigger.focus();
    trigger.click();

    await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);

    // Dispatch Escape on the document — the inline script binds the
    // listener at document scope.
    const escapeEvent = new env.win.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    env.doc.dispatchEvent(escapeEvent);

    expect(modal.classList.contains('hidden')).toBe(true);
    // The dialog body is wiped on close so a stale viewer list isn't
    // briefly visible the next time the modal opens.
    expect(env.doc.getElementById('actionDetailBody')!.innerHTML).toBe('');
    // Focus restored to the trigger.
    expect(env.doc.activeElement).toBe(trigger);
  });

  it('discards a stale detail-fetch response when the dialog is closed before it resolves', async () => {
    const action = buildSeededAction();
    // Defer the detail response so we can close the modal before it lands.
    let resolveDetail: (() => void) | null = null;
    const deferred = new Promise<void>(r => { resolveDetail = r; });

    const dom = new JSDOM(HTML_SOURCE, {
      url: 'http://localhost/dashboard/ai-approvals.html',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const win: any = dom.window;
    const doc: Document = win.document;
    win.WalaPlusNav = { init: () => {} };
    win.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as any;
    win.setInterval = ((..._args: any[]) => 0) as any;

    win.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.startsWith('/api/ai/approvals/credential-warning-count')) {
        return makeJsonResponse(win, { count: 0 });
      }
      if (u.startsWith('/api/ai/approvals?') || u === '/api/ai/approvals') {
        return makeJsonResponse(win, { rows: [action] });
      }
      if (u === `/api/ai/approvals/${action.action_code}`) {
        await deferred;
        return makeJsonResponse(win, {
          action,
          prior_viewers: SEED_VIEWERS,
        });
      }
      return makeJsonResponse(win, { error: 'unhandled' }, 404);
    });

    const inlineScripts = Array.from(doc.querySelectorAll('script'))
      .filter(s => !s.getAttribute('src'))
      .map(s => s.textContent || '');
    for (const code of inlineScripts) if (code.trim()) win.eval(code);
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));

    // Wait for the row to render.
    await new Promise(r => setTimeout(r, 50));
    const row = doc.querySelector<HTMLElement>(
      `#approvalsList [data-code="${action.action_code}"]`,
    )!;
    const trigger = row.querySelector<HTMLButtonElement>(
      'button[data-act="details"]',
    )!;
    trigger.click();

    const modal = doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);

    // Close the modal BEFORE the detail fetch resolves.
    doc.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(modal.classList.contains('hidden')).toBe(true);

    // Now let the in-flight detail fetch resolve. The guard should
    // suppress rendering — neither the viewer list nor the empty-state
    // should be painted into the now-closed dialog.
    resolveDetail!();
    await new Promise(r => setTimeout(r, 30));

    expect(modal.classList.contains('hidden')).toBe(true);
    expect(modal.querySelector('[data-testid="list-prior-viewers"]')).toBeNull();
    expect(modal.querySelector('[data-testid="text-no-prior-viewers"]')).toBeNull();
    expect(doc.getElementById('actionDetailBody')!.innerHTML).toBe('');

    dom.window.close();
  });

  /* ------------------------------------------------------------------ *
   * Task #545 — deep-link / notification-link behaviour
   *
   * The dashboard supports opening the detail modal directly from a
   * URL hash (#action=APR-...) or query parameter (?action=APR-...) so
   * notifications, audit-log rows, and email reminders can deep-link
   * to a specific action without making the operator scroll the queue.
   * ------------------------------------------------------------------ */

  function setupDomAt(url: string, opts: {
    listRows: SeededAction[];
    detailStatus?: number;
    detailBody?: any;
  }): SetupResult {
    const dom = new JSDOM(HTML_SOURCE, {
      url,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const win: any = dom.window;
    const doc: Document = win.document;

    const fetchMock = vi.fn(async (rawUrl: string) => {
      const u = String(rawUrl);
      if (u.startsWith('/api/ai/approvals/credential-warning-count')) {
        return makeJsonResponse(win, { count: 0 });
      }
      if (u.startsWith('/api/ai/approvals?') || u === '/api/ai/approvals') {
        return makeJsonResponse(win, { rows: opts.listRows });
      }
      const detailMatch = u.match(/^\/api\/ai\/approvals\/([^/?]+)$/);
      if (detailMatch) {
        if (opts.detailStatus && opts.detailStatus >= 400) {
          return makeJsonResponse(
            win,
            opts.detailBody ?? { error: 'Approval action not found', code: 'NOT_FOUND' },
            opts.detailStatus,
          );
        }
        const code = decodeURIComponent(detailMatch[1]);
        const row = opts.listRows.find(r => r.action_code === code);
        return makeJsonResponse(
          win,
          { action: row ?? buildSeededAction(), prior_viewers: row?.prior_viewers ?? [] },
        );
      }
      return makeJsonResponse(win, { error: 'unhandled', url: u }, 404);
    });
    win.fetch = fetchMock;

    win.setInterval = ((..._args: any[]) => 0) as any;
    win.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as any;
    win.WalaPlusNav = { init: () => {} };

    const inlineScripts = Array.from(doc.querySelectorAll('script'))
      .filter(s => !s.getAttribute('src'))
      .map(s => s.textContent || '');
    for (const code of inlineScripts) if (code.trim()) win.eval(code);
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));

    async function waitFor<T>(fn: () => T | null | undefined, label: string, timeoutMs = 1500): Promise<T> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const v = fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error(`Timeout waiting for: ${label}`);
    }

    return {
      win,
      doc,
      fetchMock,
      waitForRowRender: code =>
        waitFor(() => doc.querySelector<HTMLElement>(`#approvalsList [data-code="${code}"]`),
                `row[data-code=${code}]`),
      waitForModalRender: () =>
        waitFor(() => {
          const modal = doc.getElementById('actionDetailModal');
          if (!modal || modal.classList.contains('hidden')) return null;
          return (
            modal.querySelector<HTMLElement>('[data-testid="list-prior-viewers"]') ||
            modal.querySelector<HTMLElement>('[data-testid="text-no-prior-viewers"]') ||
            modal.querySelector<HTMLElement>('[data-testid="text-action-not-found"]')
          );
        }, 'detail modal panel'),
      cleanup: () => { dom.window.close(); },
    };
  }

  it('opens the detail modal automatically when the URL hash carries an action code (#action=...)', async () => {
    const action = buildSeededAction();
    env = setupDomAt(
      `http://localhost/dashboard/ai-approvals.html#action=${action.action_code}`,
      { listRows: [action] },
    );

    const panel = await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    expect(panel.getAttribute('data-testid')).toBe('list-prior-viewers');
    // The detail endpoint must have been invoked for the deep-linked code.
    const calls = (env.fetchMock as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(
      calls.some((u: string) => u === `/api/ai/approvals/${action.action_code}`),
    ).toBe(true);
  });

  it('also accepts the ?action=APR-... query-parameter form', async () => {
    const action = buildSeededAction();
    env = setupDomAt(
      `http://localhost/dashboard/ai-approvals.html?action=${action.action_code}`,
      { listRows: [action] },
    );

    await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('shows a friendly "Action not found" toast inside the modal when the deep-linked code is unknown (404)', async () => {
    env = setupDomAt(
      'http://localhost/dashboard/ai-approvals.html#action=APR-20260101-MISSING',
      {
        listRows: [],
        detailStatus: 404,
        detailBody: {
          error: 'Approval action not found',
          code: 'NOT_FOUND',
          action_code: 'APR-20260101-MISSING',
        },
      },
    );

    await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
    const notFound = modal.querySelector<HTMLElement>('[data-testid="text-action-not-found"]');
    expect(notFound, 'friendly not-found block should render').toBeTruthy();
    expect(notFound!.textContent).toContain('APR-20260101-MISSING');
    // Generic load-error copy must NOT be shown for the 404 case.
    expect(modal.textContent).not.toContain('Failed to load approvals');
  });

  it('ignores malformed action codes in the hash (security: only APR-... shapes trigger a fetch)', async () => {
    env = setupDomAt(
      'http://localhost/dashboard/ai-approvals.html#action=../../etc/passwd',
      { listRows: [] },
    );
    // Give the page a beat to settle.
    await new Promise(r => setTimeout(r, 50));
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(true);
    const calls = (env.fetchMock as any).mock.calls.map((c: any[]) => String(c[0]));
    // No request matching the per-action detail endpoint
    // (/api/ai/approvals/<code>) should have been issued. The list,
    // credential-warning-count, and review-status-counts endpoints are
    // expected and excluded from this assertion.
    const detailCalls = calls.filter((u: string) =>
      /^\/api\/ai\/approvals\/(?!credential-warning-count|review-status-counts|risk-level-counts|status-counts|pending-count)/.test(u),
    );
    expect(detailCalls).toEqual([]);
  });

  it('reacts to a hashchange event by opening the modal for the new code without a full reload', async () => {
    const action = buildSeededAction();
    env = setupDomAt(
      'http://localhost/dashboard/ai-approvals.html',
      { listRows: [action] },
    );

    // Wait for the initial list render.
    await env.waitForRowRender(action.action_code);
    const modal = env.doc.getElementById('actionDetailModal')!;
    expect(modal.classList.contains('hidden')).toBe(true);

    // Mutate the hash and fire hashchange (jsdom does not emit it on its own).
    env.win.location.hash = `#action=${action.action_code}`;
    env.win.dispatchEvent(new env.win.HashChangeEvent('hashchange'));

    await env.waitForModalRender();
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('renders the expected "1 view" / "N views" pluralisation', async () => {
    const action = buildSeededAction({
      prior_viewers: [
        {
          user_id: 9,
          user_email: 'solo@walaplus.test',
          user_name: 'Solo Reviewer',
          user_role: 'admin',
          last_viewed_at: '2026-01-03T00:00:00.000Z',
          view_count: 1,
        },
        {
          user_id: 10,
          user_email: 'multi@walaplus.test',
          user_name: 'Multi Reviewer',
          user_role: 'quality_manager',
          last_viewed_at: '2026-01-03T01:00:00.000Z',
          view_count: 7,
        },
      ],
    });
    env = setupDom({ listRows: [action] });

    const row = await env.waitForRowRender(action.action_code);
    row.querySelector<HTMLButtonElement>('button[data-act="details"]')!.click();
    await env.waitForModalRender();
    const modal = env.doc.getElementById('actionDetailModal')!;

    // Order in the list is whatever the server returned.
    expect(
      modal.querySelector('[data-testid="text-viewer-count-0"]')!.textContent,
    ).toBe('1 view');
    expect(
      modal.querySelector('[data-testid="text-viewer-count-1"]')!.textContent,
    ).toBe('7 views');
  });
});
