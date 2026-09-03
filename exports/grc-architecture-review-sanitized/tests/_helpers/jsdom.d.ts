/**
 * Minimal ambient declarations for the `jsdom` package. The upstream package
 * ships without bundled `.d.ts` files, and `@types/jsdom` is heavy and pulls
 * in DOM lib transitively in ways that conflict with the project's `dom`
 * lib configuration. Tests only consume a small surface (`JSDOM` constructor
 * with `window`, plus a couple of options), so we declare that here.
 *
 * Extend cautiously: if a test needs another method off `JSDOM`/`Window`,
 * add it here rather than reaching for `as any`.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    referrer?: string;
    contentType?: string;
    includeNodeLocations?: boolean;
    storageQuota?: number;
    runScripts?: 'dangerously' | 'outside-only';
    resources?: 'usable' | unknown;
    pretendToBeVisual?: boolean;
    virtualConsole?: unknown;
    cookieJar?: unknown;
    beforeParse?: (window: Window & typeof globalThis) => void;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis & {
      document: Document;
      [extra: string]: unknown;
    };
    serialize(): string;
    nodeLocation(node: Node): unknown;
    reconfigure(settings: { windowTop?: unknown; url?: string }): void;
  }

  export class VirtualConsole {
    constructor();
    on(event: string, listener: (...args: unknown[]) => void): this;
    sendTo(console: Console, options?: { omitJSDOMErrors?: boolean }): this;
  }

  export class CookieJar {
    constructor();
  }
}

declare module 'pdf-parse' {
  /**
   * Minimal type stub for `pdf-parse`. The library ships without its own
   * declaration file, and the test only consumes the default export as a
   * promise-returning parser. We type the resolved shape loosely (`text`
   * is the only field the test inspects) so changes to other fields
   * remain compatible.
   */
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
  }
  function pdfParse(
    <REDACTED_SCHEME> Buffer | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<PdfParseResult>;
  export default pdfParse;
}
