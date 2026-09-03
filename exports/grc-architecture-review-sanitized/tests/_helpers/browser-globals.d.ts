/**
 * Ambient type declarations for browser-side globals that Playwright tests
 * reach through `page.evaluate(() => window.X)`. Without these the test
 * compiler would either flag every reference to `window.WalaPlusI18n` as
 * TS2339 (or force every test author to cast through `(window as any)`),
 * which both hides typos and creates false positives in `npm run check:tests`.
 *
 * Keep this file synchronised with the runtime shape exposed by
 * `dashboard/js/i18n.js`. If a new method is added to the i18n module,
 * declare it here so tests calling it through `page.evaluate` stay
 * type-checked rather than silently passing.
 */

export {};

declare global {
  interface Window {
    /**
     * Shape exposed by dashboard/js/i18n.js. The runtime module is loaded by
     * every dashboard page that includes `<script src="/js/i18n.js">`, so
     * any test exercising those pages can rely on it being present after
     * the load completes. We declare it as non-optional (rather than `?`)
     * because callers in tests always gate their access through
     * `waitForFunction(() => window.WalaPlusI18n)` or DOMContentLoaded —
     * marking it optional would force ?. on every test line for a property
     * the test has already proven exists, which is more noise than safety.
     */
    WalaPlusI18n: {
      t(key: string): string;
      tDynamic(prefix: string, value: string): string | undefined;
      isRTL(): boolean;
      currentLang(): string;
      setLang(lang: string): Promise<void> | void;
      init(): Promise<void> | void;
      onReady(cb: () => void): void;
      applyToDOM(root?: Element | Document): void;
      formatNumber(n: number): string;
      setUseEasternNumerals(enabled: boolean): void;
      // Loose escape hatch for less-frequently used helpers — keeps the type
      // useful even if i18n.js grows a new method before this file catches up.
      [extra: string]: unknown;
    };

    /**
     * Test-only sentinels set by `addInitScript` in i18n.spec.ts to record
     * whether the page's language-preference POST was issued and what it
     * contained. Declared `unknown` so the test still has to narrow before
     * asserting — the goal is to remove `(window as any)` casts, not to
     * trust arbitrary shapes.
     */
    __langPostBody?: unknown;
    __failingPostCount?: number;
  }
}
