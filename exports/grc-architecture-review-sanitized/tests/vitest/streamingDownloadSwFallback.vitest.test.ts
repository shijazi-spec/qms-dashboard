/**
 * Vitest coverage for `dashboard/streaming-download-sw.js`'s fallback page.
 *
 * The service worker emits a small bilingual HTML page (status 410) when the
 * browser navigates to `/_stream-download/<id>` for an id that has no live
 * registration (typically because the registration timed out, was cancelled,
 * or the SW was restarted). The frontend test suite already covers the
 * page-side `streaming-download.js` helper, but until now there was no
 * permanent guard for the SW's fallback path itself — a regression that
 * dropped the `lang` field on register, broke per-id language memory after
 * cancel/timeout, or stopped emitting `Content-Language` would only be
 * caught by an end user on Firefox/Safari.
 *
 * Strategy: load the SW source as plain JS into a `new Function` factory
 * with a hand-rolled `self` shim that records the registered listeners.
 * Each `loadSW()` call yields fresh in-memory state (pending Map,
 * expiredLangs Map, lastKnownLang) so tests stay isolated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SW_PATH = resolve(__dirname, '..', '..', 'dashboard', 'streaming-download-sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf8');

type Listener = (event: any) => void;

interface SWHarness {
  message(data: any, ports?: any[]): void;
  fetch(path: string): Response | undefined;
  listeners: Record<string, Listener[]>;
  self: any;
}

function loadSW(origin = '<REDACTED_URL>'): SWHarness {
  const listeners: Record<string, Listener[]> = {
    install: [],
    activate: [],
    message: [],
    fetch: [],
  };
  const fakeSelf: any = {
    location: { origin },
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ||= []).push(fn);
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  };

  // Wrap the SW source in a function so its top-level `var` declarations
  // (pending, expiredLangs, lastKnownLang, …) live in this call's closure
  // and can't bleed between tests. The script's free `self` reference
  // resolves to the parameter we pass in.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const factory = new Function('self', SW_SOURCE);
  factory(fakeSelf);

  return {
    self: fakeSelf,
    listeners,
    message(data: any, ports: any[] = []) {
      for (const fn of listeners.message) fn({ data, ports });
    },
    fetch(path: string): Response | undefined {
      const url = new URL(path, origin).href;
      let captured: Response | undefined;
      const event = {
        request: { url },
        respondWith(r: Response) {
          captured = r;
        },
      };
      for (const fn of listeners.fetch) fn(event);
      return captured;
    },
  };
}

function fakeStream() {
  return { cancel: vi.fn() };
}

async function readBody(response: Response | undefined): Promise<string> {
  if (!response) throw new Error('SW did not respond');
  return await response.text();
}

describe('streaming-download SW — expired/missing-registration fallback page', () => {
  beforeEach(() => {
    // Use real timers by default; specific tests opt into fake timers when
    // they need to fast-forward past the registration TTL.
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a 410 with Content-Language=en when no registration exists and no language has ever been seen', async () => {
    const sw = loadSW();
    const response = sw.fetch('/_stream-download/missing-id');

    expect(response).toBeDefined();
    expect(response!.status).toBe(410);
    expect(response!.headers.get('Content-Language')).toBe('en');
    expect(response!.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect(response!.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const body = await readBody(response);
    expect(body).toContain('lang="en"');
    expect(body).toContain('dir="ltr"');
    // English heading from the SW dictionary.
    expect(body).toContain('This download link has expired');
    // The bilingual fallback always includes the other language as a
    // courtesy block, so we see the Arabic body string too.
    expect(body).toContain('تعذر بدء التنزيل المتدفق');
  });

  it('renders the fallback in Arabic after a `set-language` { lang: "ar" } message', async () => {
    const sw = loadSW();
    sw.message({ type: 'set-language', lang: 'ar' });

    const response = sw.fetch('/_stream-download/unknown-after-set-lang');
    expect(response).toBeDefined();
    expect(response!.status).toBe(410);
    expect(response!.headers.get('Content-Language')).toBe('ar');

    const body = await readBody(response);
    expect(body).toContain('lang="ar"');
    expect(body).toContain('dir="rtl"');
    // Arabic heading.
    expect(body).toContain('انتهت صلاحية رابط التنزيل');
  });

  it('normalizes BCP-47 language tags like "ar-SA" down to the supported base tag "ar"', async () => {
    const sw = loadSW();
    sw.message({ type: 'set-language', lang: 'ar-SA' });

    const response = sw.fetch('/_stream-download/bcp47-id');
    expect(response!.headers.get('Content-Language')).toBe('ar');
  });

  it('falls back to English when an unsupported language code is sent', async () => {
    const sw = loadSW();
    sw.message({ type: 'set-language', lang: 'fr' });

    const response = sw.fetch('/_stream-download/fr-fallback-id');
    // Unsupported codes leave lastKnownLang at its default ('en').
    expect(response!.headers.get('Content-Language')).toBe('en');
  });

  it('remembers the per-id language after the registration is cancelled (Arabic)', async () => {
    const sw = loadSW();
    const stream = fakeStream();

    // Register an id with lang='ar'…
    sw.message({
      type: 'register',
      id: 'cancel-ar',
      stream,
      filename: 'export.csv',
      contentType: 'text/csv',
      lang: 'ar',
    });
    // …then explicitly cancel it before the user ever hits the URL.
    sw.message({ type: 'cancel', id: 'cancel-ar' });

    // The cancelled stream should have been notified.
    expect(stream.cancel).toHaveBeenCalled();

    // Hit the fallback path: language must come from the per-id memory,
    // not from `lastKnownLang` (which is also 'ar' here, so we additionally
    // bump lastKnownLang to 'en' below to prove per-id memory wins).
    sw.message({ type: 'set-language', lang: 'en' });

    const response = sw.fetch('/_stream-download/cancel-ar');
    expect(response!.status).toBe(410);
    expect(response!.headers.get('Content-Language')).toBe('ar');

    const body = await readBody(response);
    expect(body).toContain('lang="ar"');
    expect(body).toContain('dir="rtl"');
  });

  it('remembers the per-id language after the registration is cancelled (English) even when lastKnownLang is Arabic', async () => {
    const sw = loadSW();
    const stream = fakeStream();

    sw.message({
      type: 'register',
      id: 'cancel-en',
      stream,
      filename: 'export.csv',
      contentType: 'text/csv',
      lang: 'en',
    });
    sw.message({ type: 'cancel', id: 'cancel-en' });

    // Move global lastKnownLang to 'ar' so any leak from the global path
    // would surface as the wrong language.
    sw.message({ type: 'set-language', lang: 'ar' });

    const response = sw.fetch('/_stream-download/cancel-en');
    expect(response!.headers.get('Content-Language')).toBe('en');
    const body = await readBody(response);
    expect(body).toContain('lang="en"');
    expect(body).toContain('dir="ltr"');
  });

  it('remembers the per-id language after the registration TTL expires (timeout path)', async () => {
    vi.useFakeTimers();
    const sw = loadSW();
    const stream = fakeStream();

    sw.message({
      type: 'register',
      id: 'timeout-ar',
      stream,
      filename: 'export.csv',
      contentType: 'text/csv',
      lang: 'ar',
    });

    // Bump lastKnownLang away from 'ar' so we can prove the per-id memory
    // is the source of truth for the fallback page.
    sw.message({ type: 'set-language', lang: 'en' });

    // REGISTRATION_TTL_MS is 60s in the SW; advance past it.
    vi.advanceTimersByTime(60_001);

    // The timeout handler should have cancelled the abandoned stream.
    expect(stream.cancel).toHaveBeenCalled();

    const response = sw.fetch('/_stream-download/timeout-ar');
    expect(response!.status).toBe(410);
    expect(response!.headers.get('Content-Language')).toBe('ar');

    const body = await readBody(response);
    expect(body).toContain('lang="ar"');
    expect(body).toContain('dir="rtl"');
  });

  it('also remembers the per-id language for the English timeout path', async () => {
    vi.useFakeTimers();
    const sw = loadSW();
    const stream = fakeStream();

    sw.message({
      type: 'register',
      id: 'timeout-en',
      stream,
      filename: 'export.csv',
      contentType: 'text/csv',
      lang: 'en',
    });
    sw.message({ type: 'set-language', lang: 'ar' });

    vi.advanceTimersByTime(60_001);

    const response = sw.fetch('/_stream-download/timeout-en');
    expect(response!.headers.get('Content-Language')).toBe('en');
    const body = await readBody(response);
    expect(body).toContain('lang="en"');
  });

  it('returns the live download (not the fallback page) while the registration is still active', async () => {
    const sw = loadSW();
    const stream = fakeStream();

    sw.message({
      type: 'register',
      id: 'live-id',
      stream,
      filename: 'live.csv',
      contentType: 'text/csv',
      lang: 'ar',
    });

    const response = sw.fetch('/_stream-download/live-id');
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    // No fallback HTML — this is the actual file download.
    expect(response!.headers.get('Content-Type')).toBe('text/csv');
    expect(response!.headers.get('Content-Disposition')).toContain('attachment');
    // Live downloads do not advertise Content-Language.
    expect(response!.headers.get('Content-Language')).toBeNull();
    // And the live registration did not need to be cancelled.
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it('ignores cross-origin fetches (does not respond at all)', () => {
    const sw = loadSW('<REDACTED_URL>');
    let respondCalled = false;
    const event = {
      request: { url: '<REDACTED_URL>' },
      respondWith() {
        respondCalled = true;
      },
    };
    for (const fn of sw.listeners.fetch) fn(event);
    expect(respondCalled).toBe(false);
  });

  it('ignores requests outside the /_stream-download/ namespace', () => {
    const sw = loadSW();
    let respondCalled = false;
    const event = {
      request: { url: '<REDACTED_URL>' },
      respondWith() {
        respondCalled = true;
      },
    };
    for (const fn of sw.listeners.fetch) fn(event);
    expect(respondCalled).toBe(false);
  });
});
