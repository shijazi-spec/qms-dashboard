/**
 * Verifies the audits dashboard's "Export Audits CSV" button keeps its
 * data-args / data-estimate-url in sync with the active status filter so
 * the streamed CSV matches the rows shown in the schedule table.
 *
 * Loads dashboard/audits.html into JSDOM, extracts the inline
 * syncAuditsExportButton() function source, and exercises it directly
 * against the real markup — proving the contract end-to-end without
 * needing to boot the rest of the page's runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// jsdom ships without bundled .d.ts; type declarations are provided locally
// in tests/_helpers/jsdom.d.ts. The runtime API surface used here is small
// enough that the local declaration keeps the rest of the file fully typed.
import { JSDOM } from 'jsdom';

const HTML_PATH = resolve(__dirname, '..', '..', 'dashboard', 'audits.html');

type AuditsDashboardWindow = Window & typeof globalThis & {
  syncAuditsExportButton: () => void;
  eval: (src: string) => unknown;
};

function loadDashboard(): { win: AuditsDashboardWindow; cleanup: () => void } {
  const html = readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, {
    url: '<REDACTED_URL>',
    runScripts: 'outside-only',
  });
  const win = dom.window as unknown as AuditsDashboardWindow;

  const fnSource = html.match(
    /function syncAuditsExportButton\([\s\S]*?\n        \}\n/,
  );
  if (!fnSource) {
    throw new Error('syncAuditsExportButton() not found in audits.html');
  }
  win.eval(`${fnSource[0]}; window.syncAuditsExportButton = syncAuditsExportButton;`);

  return { win, cleanup: () => dom.window.close() };
}

function getStatusSelect(win: AuditsDashboardWindow): HTMLSelectElement {
  const el = win.document.getElementById('filterAuditStatus');
  if (!(el instanceof win.HTMLSelectElement)) {
    throw new Error('#filterAuditStatus is not a <select>');
  }
  return el;
}

function getExportButton(win: AuditsDashboardWindow): HTMLElement {
  const btn = win.document.querySelector('[data-testid="button-export-csv"]');
  if (!(btn instanceof win.HTMLElement)) {
    throw new Error('Export button not found');
  }
  return btn;
}

describe('audits dashboard — export button reflects active status filter', () => {
  it('points at /api/audits/export with no query string when no filter is set', () => {
    const { win, cleanup } = loadDashboard();
    try {
      win.syncAuditsExportButton();
      const btn = getExportButton(win);
      expect(btn.getAttribute('data-estimate-url')).toBe('/api/audits/export');
      expect(JSON.parse(btn.getAttribute('data-args') ?? '[]')).toEqual([
        '/api/audits/export',
        'audits.csv',
      ]);
    } finally {
      cleanup();
    }
  });

  it('appends the active ?status= filter to both data-args and data-estimate-url', () => {
    const { win, cleanup } = loadDashboard();
    try {
      getStatusSelect(win).value = 'in_progress';
      win.syncAuditsExportButton();
      const btn = getExportButton(win);
      expect(btn.getAttribute('data-estimate-url')).toBe(
        '/api/audits/export?status=in_progress',
      );
      expect(JSON.parse(btn.getAttribute('data-args') ?? '[]')).toEqual([
        '/api/audits/export?status=in_progress',
        'audits.csv',
      ]);
    } finally {
      cleanup();
    }
  });

  it('reflects every status option exposed by the schedule filter', () => {
    const { win, cleanup } = loadDashboard();
    try {
      const select = getStatusSelect(win);
      const optionValues = Array.from(
        select.querySelectorAll<HTMLOptionElement>('option'),
      )
        .map((o) => o.value)
        .filter((v) => v !== '');
      expect(optionValues.length).toBeGreaterThan(0);
      for (const value of optionValues) {
        select.value = value;
        win.syncAuditsExportButton();
        const btn = getExportButton(win);
        expect(btn.getAttribute('data-estimate-url')).toBe(
          `/api/audits/export?status=${encodeURIComponent(value)}`,
        );
      }
    } finally {
      cleanup();
    }
  });
});
