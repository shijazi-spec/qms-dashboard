/**
 * Vitest coverage for the Health Pulse category-chip filter (Task #569).
 *
 * The category-chip filter on the Health Pulse dashboard lives entirely
 * in the inline <script> block of `dashboard/health.html`
 * (renderLatest → renderChecksWithFilter → renderFilterChips). Until
 * this task it had no automated coverage, so a future refactor of the
 * rendering pipeline could quietly regress one of its load-bearing
 * guarantees:
 *
 *   1. One chip per category present in the latest run, plus an "All"
 *      chip, each with a correct count.
 *   2. Clicking a category chip filters the per-check breakdown down to
 *      that category only.
 *   3. The alert banner stays unfiltered — failing/warning checks from
 *      other categories must still be surfaced above the breakdown.
 *   4. The selection round-trips through `sessionStorage` and the
 *      `?category=` query param (write side: chip click; read side:
 *      page reload with either signal honoured on first render).
 *   5. A persisted category that no longer exists in the latest run
 *      falls back to "All" instead of leaving the operator staring at
 *      an empty breakdown.
 *
 * The test extracts the inline scripts from `dashboard/health.html`
 * and runs them inside a JSDOM window, then drives `renderLatest()`
 * directly with synthetic pulse payloads. No server / fetch / login is
 * required — the contract under test is pure DOM behaviour.
 */

import { describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";

const HTML_PATH = path.resolve(__dirname, "../../dashboard/health.html");

function extractInlineScripts(html: string): string {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1] ?? "");
  }
  return out.join("\n;\n");
}

// Mirrors the ids + data-testids that renderLatest / renderAlertBanner /
// renderChecksWithFilter / renderFilterChips read or write. Kept in sync
// with the live page shell in `dashboard/health.html`; if the live page
// renames any of these ids, these tests will fail loudly — which is
// exactly the regression signal Task #569 asked for.
const PAGE_SHELL = `
  <div id="loading-state"></div>
  <div id="empty-state" class="hidden"></div>
  <div id="error-state" class="hidden"><div id="error-message"></div></div>
  <div id="alert-banner" class="hidden" role="alert" aria-live="polite"
       data-testid="banner-health-alert">
    <div id="alert-banner-inner">
      <span id="alert-banner-icon"></span>
      <div id="alert-banner-title" data-testid="text-alert-banner-title"></div>
      <ul id="alert-banner-list" data-testid="list-alert-banner"></ul>
    </div>
  </div>
  <div id="main-content" class="hidden">
    <div id="overall-card">
      <div id="overall-status"></div>
      <div id="overall-time"></div>
    </div>
    <div id="count-pass"></div>
    <div id="count-warn"></div>
    <div id="count-fail"></div>
    <div id="count-skipped"></div>
    <canvas id="historyChart"></canvas>
    <div id="history-meta"></div>
    <div id="checks-filter" class="hidden" role="group"
         data-testid="group-checks-filter"></div>
    <div id="checks-list" data-testid="list-checks"></div>
  </div>
  <button id="btn-refresh"></button>
  <button id="btn-run"></button>
`;

interface SetUpOpts {
  url?: string;
  storedCategory?: string;
  storedStatus?: string;
}

async function setUpDom(opts: SetUpOpts = {}): Promise<{
  window: any;
  document: Document;
}> {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${PAGE_SHELL}</body></html>`,
    {
      url: opts.url ?? "<REDACTED_URL>",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const { window } = dom;

  // Pre-seed sessionStorage so readInitialFilter() / readInitialStatusFilter()
  // observe the requested state at module-eval time.
  if (opts.storedCategory !== undefined) {
    window.sessionStorage.setItem("health.filterCategory", opts.storedCategory);
  }
  if (opts.storedStatus !== undefined) {
    window.sessionStorage.setItem("health.filterStatus", opts.storedStatus);
  }

  // Stubs the inline scripts depend on but which ship from separate
  // <script src> bundles we are deliberately not loading.
  (window as any).ExampleOrgNav = { init: () => undefined };
  (window as any).ExampleOrgI18n = {
    init: () => Promise.resolve(),
    applyToDOM: () => undefined,
    // Lightweight passthrough — every assertion in this file targets
    // structural attributes (chip presence, counts, group ids) rather
    // than localised copy, so a deterministic key fallback is safest.
    t: (k: string) => k,
  };
  (window as any).Chart = class {
    destroy() { /* noop */ }
  };
  // Block the network: loadPulse() runs from the page's own
  // DOMContentLoaded hook. A pending Promise lets the bootstrap path
  // finish without resolving so it never overwrites the deterministic
  // pulse payloads our tests inject via renderLatest().
  (window as any).fetch = () => new Promise(() => {});

  const scripts = extractInlineScripts(html);
  window.eval(scripts);

  return { window, document: window.document };
}

function makePulse(checks: any[]) {
  return {
    id: 1,
    run_at: new Date().toISOString(),
    duration_ms: 50,
    overall_status: "critical",
    pass_count: checks.filter((c) => c.status === "pass").length,
    warn_count: checks.filter((c) => c.status === "warn").length,
    fail_count: checks.filter((c) => c.status === "fail").length,
    skipped_count: checks.filter((c) => c.status === "skipped").length,
    checks,
  };
}

// Three categories so we can prove that filtering to one hides the
// other two AND that the unfiltered alert banner still picks up the
// failing/warning rows from the hidden categories.
const SAMPLE_CHECKS = [
  { id: "a.fail", label: "A fail", category: "infrastructure", status: "fail", duration_ms: 1, message: "a-broken", details: null },
  { id: "a.pass", label: "A pass", category: "infrastructure", status: "pass", duration_ms: 1, message: null, details: null },
  { id: "b.warn", label: "B warn", category: "ai", status: "warn", duration_ms: 1, message: "b-warning", details: null },
  { id: "b.pass", label: "B pass", category: "ai", status: "pass", duration_ms: 1, message: null, details: null },
  { id: "c.pass", label: "C pass", category: "data", status: "pass", duration_ms: 1, message: null, details: null },
];

function chipCount(el: Element | null): string | null {
  return el?.querySelector(".filter-chip-count")?.textContent ?? null;
}

describe("Health Pulse category-chip filter (Task #569)", () => {
  test("renders one chip per category present plus an All chip with correct counts", async () => {
    const { window, document } = await setUpDom();
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    const allChip = document.querySelector('[data-testid="chip-filter-all"]');
    const infraChip = document.querySelector('[data-testid="chip-filter-infrastructure"]');
    const aiChip = document.querySelector('[data-testid="chip-filter-ai"]');
    const dataChip = document.querySelector('[data-testid="chip-filter-data"]');

    expect(allChip).toBeTruthy();
    expect(infraChip).toBeTruthy();
    expect(aiChip).toBeTruthy();
    expect(dataChip).toBeTruthy();

    // Counts reflect the unfiltered (status=all) view.
    expect(chipCount(allChip)).toBe("5");
    expect(chipCount(infraChip)).toBe("2");
    expect(chipCount(aiChip)).toBe("2");
    expect(chipCount(dataChip)).toBe("1");

    // No phantom chips for categories absent from this run.
    expect(document.querySelector('[data-testid="chip-filter-scheduler"]')).toBeNull();
    expect(document.querySelector('[data-testid="chip-filter-endpoints"]')).toBeNull();

    // "All" is the active chip on first render.
    expect(allChip!.getAttribute("aria-pressed")).toBe("true");
    expect(infraChip!.getAttribute("aria-pressed")).toBe("false");
  });

  test("clicking a category chip filters the per-check breakdown to that category only", async () => {
    const { window, document } = await setUpDom();
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    const aiChip = document.querySelector('[data-testid="chip-filter-ai"]') as HTMLButtonElement;
    aiChip.click();

    // Only the ai group should be present in the breakdown.
    expect(document.querySelector('[data-testid="group-category-ai"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="group-category-infrastructure"]')).toBeNull();
    expect(document.querySelector('[data-testid="group-category-data"]')).toBeNull();

    // Only ai's two rows are rendered.
    expect(document.querySelector('[data-testid="row-check-b.warn"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="row-check-b.pass"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="row-check-a.fail"]')).toBeNull();
    expect(document.querySelector('[data-testid="row-check-a.pass"]')).toBeNull();
    expect(document.querySelector('[data-testid="row-check-c.pass"]')).toBeNull();

    // The selected chip flips its aria-pressed state. Re-query the chips
    // because renderFilterChips() replaces the toolbar's innerHTML on
    // every re-render, which would orphan the pre-click handles.
    expect(
      document.querySelector('[data-testid="chip-filter-ai"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="chip-filter-all"]')!.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("alert banner still lists every failing/warning check after a category filter is applied", async () => {
    const { window, document } = await setUpDom();
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    // Filter to a category that contains NEITHER the failing nor warning
    // check — this is the harshest test of the "alert banner ignores the
    // filter" guarantee.
    const dataChip = document.querySelector('[data-testid="chip-filter-data"]') as HTMLButtonElement;
    dataChip.click();

    // Sanity: the breakdown is now narrowed to the `data` category only.
    expect(document.querySelector('[data-testid="row-check-c.pass"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="row-check-a.fail"]')).toBeNull();
    expect(document.querySelector('[data-testid="row-check-b.warn"]')).toBeNull();

    // The banner is visible and still surfaces a.fail (infrastructure) and
    // b.warn (ai) — neither of which is in the filtered category.
    const banner = document.querySelector('[data-testid="banner-health-alert"]')!;
    expect(banner.classList.contains("hidden")).toBe(false);
    expect(document.querySelector('[data-testid="item-alert-a.fail"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="item-alert-b.warn"]')).toBeTruthy();
  });

  test("selection round-trips through sessionStorage and the ?category= query param (write side)", async () => {
    const { window, document } = await setUpDom();
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    const infraChip = document.querySelector('[data-testid="chip-filter-infrastructure"]') as HTMLButtonElement;
    infraChip.click();

    expect(window.sessionStorage.getItem("health.filterCategory")).toBe("infrastructure");
    expect(new window.URL(window.location.href).searchParams.get("category")).toBe("infrastructure");

    // Switching back to "All" clears the query param but still records
    // the explicit "all" choice in sessionStorage.
    const allChip = document.querySelector('[data-testid="chip-filter-all"]') as HTMLButtonElement;
    allChip.click();

    expect(window.sessionStorage.getItem("health.filterCategory")).toBe("all");
    expect(new window.URL(window.location.href).searchParams.get("category")).toBeNull();
  });

  test("?category= query param is honoured on first render (read side)", async () => {
    const { window, document } = await setUpDom({
      url: "<REDACTED_URL>",
    });
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    const aiChip = document.querySelector('[data-testid="chip-filter-ai"]')!;
    expect(aiChip.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-testid="group-category-ai"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="group-category-infrastructure"]')).toBeNull();
    expect(document.querySelector('[data-testid="group-category-data"]')).toBeNull();
  });

  test("sessionStorage-persisted category is honoured on first render when no query param is present", async () => {
    const { window, document } = await setUpDom({ storedCategory: "ai" });
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    expect(
      document.querySelector('[data-testid="chip-filter-ai"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.querySelector('[data-testid="group-category-ai"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="group-category-infrastructure"]')).toBeNull();
  });

  test("a persisted category that no longer exists in the latest run falls back to All", async () => {
    // Persist a category we deliberately do NOT include in the next pulse.
    const { window, document } = await setUpDom({ storedCategory: "scheduler" });
    (window as any).renderLatest(makePulse(SAMPLE_CHECKS), {});

    // Every category present in the run is rendered (i.e. the breakdown
    // is NOT empty — that's the bug this guard exists to prevent).
    expect(document.querySelector('[data-testid="group-category-infrastructure"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="group-category-ai"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="group-category-data"]')).toBeTruthy();

    // The fallback rewrites the persisted value back to 'all' so the
    // next pageview doesn't re-trigger the same bail-out path.
    expect(window.sessionStorage.getItem("health.filterCategory")).toBe("all");

    // And the "All" chip is the visibly-active one.
    expect(
      document.querySelector('[data-testid="chip-filter-all"]')!.getAttribute("aria-pressed"),
    ).toBe("true");
    // No chip for the missing category was synthesised.
    expect(document.querySelector('[data-testid="chip-filter-scheduler"]')).toBeNull();
  });
});
