/**
 * Vitest coverage for the post-restore sweep "copy event-log link"
 * round-trip (Task #656).
 *
 * Verifies that when an operator pastes a URL written by
 * `copyPostRestoreSweepEventLogLink()` (in dashboard/logs.html),
 * the target page hydrates the filter inputs, narrows the date
 * window to the alert's sweep_timestamp, and auto-expands the
 * targeted event_logs row. Without this round-trip the "copy
 * link" button would silently no-op and the copied link would
 * land on the unfiltered first page of the audit log.
 *
 * The test extracts the inline scripts from `dashboard/logs.html`
 * and runs them inside a JSDOM window so we never need to start
 * a real server or sign in — the pure DOM interaction is enough
 * to cover the "deep-link → row expansion" contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";

const HTML_PATH = path.resolve(__dirname, "../../dashboard/logs.html");

function extractInlineScripts(html: string): string {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? "");
  }
  return out.join("\n;\n");
}

interface SetUpDomOptions {
  search: string;
  rows?: Array<{ id: string; timestampText: string }>;
}

async function setUpDom(opts: SetUpDomOptions): Promise<{
  window: any;
  document: Document;
  toggleCalls: any[];
  loadLogsCalls: number[];
}> {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  // Strip the body so we can install a known table structure that mirrors
  // the live `loadLogs` rendering (id-as-data-args, timestamp text in the
  // first cell). Keep <head> so URLSearchParams etc. are wired up.
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "http://localhost:5000/dashboard/logs.html" + opts.search,
      runScripts: "outside-only",
    },
  );
  const { window } = dom;
  const document = window.document;

  // Install the exact DOM nodes the deep-link helpers read by id, plus the
  // post-restore alerts panel ids the loaders expect (so loadPostRestoreAlerts
  // / loadAlertRecipients / loadStats / loadRedactionSweepStatus do not
  // throw before the deep-link path runs).
  document.body.innerHTML = `
    <select id="filterModule">
      <option value=""></option>
      <option value="security/redaction-sweep">security/redaction-sweep</option>
    </select>
    <input id="filterFromDate" />
    <input id="filterToDate" />
    <select id="filterSeverity"><option value=""></option></select>
    <select id="filterAI"><option value=""></option></select>
    <select id="filterActionType"><option value=""></option></select>
    <select id="filterEntityType"><option value=""></option></select>
    <input id="filterSearch" />
    <table>
      <tbody id="logsTable"></tbody>
    </table>
    <div id="postRestoreAlertsCard">
      <span id="postRestoreAlertsBadge"></span>
      <div id="postRestoreAlertsBody"></div>
    </div>
    <div id="alertRecipientsBody"></div>
    <span id="redactionSweepStatusBadge"></span>
    <div id="redactionSweepStatusBody"></div>
    <div id="statsBar"></div>
    <span id="logsExportHint"></span>
  `;

  const toggleCalls: any[] = [];
  const loadLogsCalls: number[] = [];

  // Pre-install the stubs that the inline scripts will call. Because the
  // inline page declares these with `function name(){…}`, our stubs would
  // normally be clobbered when the script evaluates. We work around that
  // by stubbing only AFTER eval, then re-running the deep-link entry
  // point (`applyPostRestoreSweepDeepLink`) explicitly so it picks up
  // our stubbed `loadLogs` / `toggleLogDetails`.
  // Stub the bootstrap helpers BEFORE eval so the page's
  // `DOMContentLoaded` listener (which calls loadStats / loadLogs /
  // loadPostRestoreAlerts / loadAlertRecipients / loadRedactionSweepStatus
  // / refreshLogsExportHint) becomes a no-op. We can't predict whether
  // JSDOM has already fired DOMContentLoaded by the time we call
  // `window.eval`, so it's safer to neutralise the global handlers
  // entirely.
  (window as any).loadStats = () => undefined;
  (window as any).loadRedactionSweepStatus = () => undefined;
  (window as any).loadPostRestoreAlerts = () => undefined;
  (window as any).loadAlertRecipients = () => undefined;
  // Stub auxiliary globals the page references but ships from
  // separate <script src> bundles we are deliberately NOT loading
  // (e.g. nav.js, ai-consultant-widget.js). Without these stubs the
  // bootstrap callback throws, polluting test output even though the
  // throws are caught.
  (window as any).WalaPlusNav = { init: () => undefined };
  (window as any).WalaPlusI18n = { init: () => Promise.resolve(), applyToDOM: () => undefined };
  // `function name(){…}` declarations at top level become non-writable
  // bindings in some engines, but in JSDOM/Node V8 they're plain
  // assignable globals — installing a `var name = …` shim before eval
  // would be overwritten by the function declaration during hoisting,
  // so we re-install the stubs immediately AFTER eval too.
  const scripts = extractInlineScripts(html);
  window.eval(scripts);

  // Replace the dynamic helpers with deterministic stubs (post-eval, so
  // the function declarations from the page don't shadow them).
  (window as any).loadStats = () => undefined;
  (window as any).loadRedactionSweepStatus = () => undefined;
  (window as any).loadPostRestoreAlerts = () => undefined;
  (window as any).loadAlertRecipients = () => undefined;
  (window as any).loadLogs = (page: number) => {
    loadLogsCalls.push(page);
    // Render the rows the test asked for so expandPostRestoreSweepLogRow
    // has something to walk.
    const tbody = document.getElementById("logsTable");
    if (tbody) {
      tbody.innerHTML = (opts.rows ?? [])
        .map(
          (r) =>
            `<tr class="log-row" data-args='[${JSON.stringify(r.id)}]'><td>${r.timestampText}</td><td>x</td></tr>`,
        )
        .join("");
    }
    return Promise.resolve();
  };
  (window as any).toggleLogDetails = (id: any) => {
    toggleCalls.push(id);
    // Mirror the real implementation's bookkeeping so the helper's
    // `expandedRows.has(id)` guard does not double-toggle.
    if ((window as any).expandedRows && typeof (window as any).expandedRows.add === "function") {
      (window as any).expandedRows.add(id);
    }
  };
  (window as any).refreshLogsExportHint = () => undefined;

  // Force the page's own `DOMContentLoaded` listener to run NOW so its
  // side-effects (loadLogs, loadStats, etc) hit the stub buffers in a
  // deterministic order. We then drain the buffers so each test only
  // observes the side-effects produced by its own
  // `applyPostRestoreSweepDeepLink()` call. Without this step JSDOM
  // sometimes defers the listener to a later microtask, which would
  // race the assertions.
  const evt = new window.Event("DOMContentLoaded", { bubbles: false, cancelable: false });
  document.dispatchEvent(evt);
  await new Promise((r) => setTimeout(r, 0));
  loadLogsCalls.length = 0;
  toggleCalls.length = 0;
  // Reset the filter inputs the bootstrap may have hydrated so each
  // test starts from the same blank slate.
  ["filterModule", "filterFromDate", "filterToDate", "filterSeverity",
    "filterAI", "filterActionType", "filterEntityType", "filterSearch",
  ].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) (el as HTMLInputElement).value = "";
  });
  const tbody = document.getElementById("logsTable");
  if (tbody) tbody.innerHTML = "";

  return { window, document, toggleCalls, loadLogsCalls };
}

describe("post-restore sweep deep-link hydration (Task #656)", () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("applyPostRestoreSweepDeepLink() filters the table and expands the row whose id matches event_log_id", async () => {
    const sweepTs = "2026-04-25T10:15:00.000Z";
    const { window, document, toggleCalls, loadLogsCalls } = await setUpDom({
      search:
        "?module=security%2Fredaction-sweep&entity_id=boot_redaction_sweep" +
        "&event_log_id=9001&sweep_timestamp=" +
        encodeURIComponent(sweepTs),
      rows: [
        { id: "8000", timestampText: "2026-04-24T10:15:00.000Z" },
        { id: "9001", timestampText: sweepTs },
        { id: "9500", timestampText: "2026-04-25T11:00:00.000Z" },
      ],
    });

    const handled = (window as any).applyPostRestoreSweepDeepLink();
    expect(handled).toBe(true);

    // Filters were hydrated.
    expect((document.getElementById("filterModule") as HTMLSelectElement).value)
      .toBe("security/redaction-sweep");
    const fromVal = (document.getElementById("filterFromDate") as HTMLInputElement).value;
    const toVal = (document.getElementById("filterToDate") as HTMLInputElement).value;
    expect(fromVal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(toVal).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The window should bracket the sweep date (24h on either side).
    expect(new Date(fromVal).getTime()).toBeLessThan(new Date(sweepTs).getTime());
    expect(new Date(toVal).getTime()).toBeGreaterThan(new Date(sweepTs).getTime());

    // loadLogs was invoked by the deep-link path; wait for the chained
    // .then() that auto-expands the row.
    expect(loadLogsCalls).toEqual([1]);
    await new Promise((r) => setTimeout(r, 0));

    // The exact event_log_id row must be expanded — NOT the closest
    // by-timestamp neighbour. Stringify both sides so '9001' === 9001
    // is treated as a match regardless of whether the data-args carries
    // a string or a number.
    expect(toggleCalls.map(String)).toEqual(["9001"]);
  });

  test("falls back to closest-timestamp row when only sweep_timestamp is provided", async () => {
    const sweepTs = "2026-04-25T10:15:00.000Z";
    const { window, toggleCalls } = await setUpDom({
      search:
        "?module=security%2Fredaction-sweep&entity_id=boot_redaction_sweep" +
        "&sweep_timestamp=" +
        encodeURIComponent(sweepTs),
      rows: [
        { id: "8000", timestampText: "2026-04-24T10:15:00.000Z" },
        { id: "9100", timestampText: "2026-04-25T10:14:30.000Z" }, // closest
        { id: "9500", timestampText: "2026-04-26T10:15:00.000Z" },
      ],
    });

    const handled = (window as any).applyPostRestoreSweepDeepLink();
    expect(handled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(toggleCalls.map(String)).toEqual(["9100"]);
  });

  test("returns false (no-ops) when the URL does not target the post-restore module", async () => {
    const { window, toggleCalls, loadLogsCalls } = await setUpDom({
      search: "?event_log_id=9001",
      rows: [],
    });

    const handled = (window as any).applyPostRestoreSweepDeepLink();
    expect(handled).toBe(false);
    expect(loadLogsCalls).toEqual([]);
    expect(toggleCalls).toEqual([]);
  });

  test("returns false when the targeted module matches but no event_log_id or sweep_timestamp is supplied", async () => {
    const { window, loadLogsCalls } = await setUpDom({
      search: "?module=security%2Fredaction-sweep",
      rows: [],
    });

    const handled = (window as any).applyPostRestoreSweepDeepLink();
    expect(handled).toBe(false);
    expect(loadLogsCalls).toEqual([]);
  });
});
