import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_PATH = resolve(__dirname, '..', '..', 'dashboard', 'js', 'streaming-download.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

interface SetupOptions {
  enableShowSaveFilePicker?: boolean;
  showSaveFilePickerImpl?: (...args: any[]) => any;
  installServiceWorker?: boolean;
  serviceWorkerImpl?: FakeServiceWorkerSetup;
}

interface FakeServiceWorkerSetup {
  registerImpl?: (path: string, opts?: any) => Promise<any> | any;
  postMessageImpl?: (msg: any, transfer: any[]) => void;
  ackOk?: boolean;
}

interface SetupResult {
  win: any;
  writes: Uint8Array[];
  fileHandle: any;
  pickerCalls: any[][];
  swCalls: { msg: any; transfer: any[] }[];
  cleanup: () => void;
}

function setupBrowserEnv(opts: SetupOptions = {}): SetupResult {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
  });

  const win: any = dom.window;

  // ReadableStream / TransformStream / WritableStream are available in
  // Node 18+ via globalThis. Forward them onto the jsdom window.
  win.ReadableStream = (globalThis as any).ReadableStream;
  win.WritableStream = (globalThis as any).WritableStream;
  win.TransformStream = (globalThis as any).TransformStream;
  win.fetch = (globalThis as any).fetch;
  win.Response = (globalThis as any).Response;
  // jsdom's MessageChannel does not transfer ReadableStreams; use Node's so
  // the SW-streaming code path is exercisable in tests.
  win.MessageChannel = (globalThis as any).MessageChannel;

  // jsdom does not implement URL.createObjectURL / revokeObjectURL but the
  // legacy Blob fallback uses them — stub them so we can exercise that path.
  win.URL.createObjectURL = vi.fn(() => 'blob:mock');
  win.URL.revokeObjectURL = vi.fn();

  const writes: Uint8Array[] = [];
  let aborted = false;
  const fileHandle = {
    createWritable: vi.fn(async () => {
      return new (globalThis as any).WritableStream({
        write(chunk: Uint8Array) {
          writes.push(new Uint8Array(chunk));
        },
        abort() {
          aborted = true;
        },
        close() {
          /* no-op */
        },
      });
    }),
    get aborted() {
      return aborted;
    },
  };

  const pickerCalls: any[][] = [];
  if (opts.enableShowSaveFilePicker !== false) {
    win.showSaveFilePicker = opts.showSaveFilePickerImpl
      ? opts.showSaveFilePickerImpl
      : async (...args: any[]) => {
          pickerCalls.push(args);
          return fileHandle;
        };
  }

  // alert is invoked on errors; suppress it.
  win.alert = vi.fn();

  const swCalls: { msg: any; transfer: any[] }[] = [];
  if (opts.installServiceWorker) {
    const ackOk = opts.serviceWorkerImpl?.ackOk !== false;
    const fakeSw = {
      scriptURL: 'http://localhost/streaming-download-sw.js',
      postMessage: opts.serviceWorkerImpl?.postMessageImpl
        ? (msg: any, transfer: any[]) => {
            swCalls.push({ msg, transfer });
            opts.serviceWorkerImpl!.postMessageImpl!(msg, transfer);
          }
        : (msg: any, transfer: any[]) => {
            swCalls.push({ msg, transfer });
            // Drain any transferred ReadableStream so pipeTo() can settle.
            if (msg && msg.type === 'register' && msg.stream) {
              const reader = (msg.stream as ReadableStream<Uint8Array>).getReader();
              (async () => {
                try {
                  // eslint-disable-next-line no-constant-condition
                  while (true) {
                    const step = await reader.read();
                    if (step.done) break;
                  }
                } catch (_) {
                  /* ignore */
                }
              })();
            }
            const port = (transfer || []).find((t) => t && typeof t.postMessage === 'function');
            if (port) {
              setTimeout(() => {
                try {
                  port.postMessage(ackOk ? { ok: true } : { ok: false });
                } catch (_) {
                  /* ignore */
                }
              }, 0);
            }
          },
    };
    const fakeRegistration = { active: fakeSw, installing: null, waiting: null };
    win.isSecureContext = true;
    Object.defineProperty(win.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: fakeSw,
        getRegistration: vi.fn(async () => fakeRegistration),
        register: opts.serviceWorkerImpl?.registerImpl
          ? vi.fn(opts.serviceWorkerImpl.registerImpl)
          : vi.fn(async () => fakeRegistration),
        ready: Promise.resolve(fakeRegistration),
      },
    });
  }

  // Evaluate the script inside the jsdom window context.
  win.eval(SCRIPT_SOURCE);

  return {
    win,
    writes,
    fileHandle,
    pickerCalls,
    swCalls,
    cleanup: () => dom.window.close(),
  };
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new (globalThis as any).ReadableStream({
    start(controller: any) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('streamingDownload (browser helper)', () => {
  let env: SetupResult;
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    env?.cleanup();
  });

  it('streams response body straight to a file handle when File System Access API is available', async () => {
    env = setupBrowserEnv();
    const chunkA = new Uint8Array([1, 2, 3, 4]);
    const chunkB = new Uint8Array([5, 6, 7, 8, 9]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([chunkA, chunkB]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="big.csv"',
          // Intentionally omit content-length so the helper treats the size
          // as unknown and defaults to streaming-to-disk.
        },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/big.csv');

    expect(env.pickerCalls).toHaveLength(1);
    expect(env.pickerCalls[0][0]).toMatchObject({ suggestedName: 'big.csv' });
    expect(result.streamedToDisk).toBe(true);
    expect(result.bytes).toBe(chunkA.byteLength + chunkB.byteLength);

    const merged = new Uint8Array(result.bytes);
    let off = 0;
    for (const w of env.writes) {
      merged.set(w, off);
      off += w.byteLength;
    }
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('keeps the legacy in-memory Blob path for small responses with known content-length', async () => {
    env = setupBrowserEnv();
    const payload = new Uint8Array([10, 20, 30]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="tiny.csv"',
          'content-length': String(payload.byteLength),
        },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/tiny.csv');

    // Content-Length is well below 10 MB so we must NOT prompt the picker.
    expect(env.pickerCalls).toHaveLength(0);
    expect(result.streamedToDisk).toBe(false);
    expect(result.bytes).toBe(payload.byteLength);
  });

  it('falls back to the Blob path when showSaveFilePicker is not available', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });
    const payload = new Uint8Array([7, 7, 7]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/no-fs.csv');
    expect(result.streamedToDisk).toBe(false);
    expect(result.bytes).toBe(payload.byteLength);
  });

  it('falls back to the Blob path when showSaveFilePicker fails with a non-AbortError (e.g. lost user activation)', async () => {
    env = setupBrowserEnv({
      showSaveFilePickerImpl: async () => {
        const err: any = new Error('User activation is required');
        err.name = 'SecurityError';
        throw err;
      },
    });
    const payload = new Uint8Array([1, 2]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/fallback.csv');
    expect(result.streamedToDisk).toBe(false);
    expect(result.bytes).toBe(payload.byteLength);
  });

  it('propagates AbortError when the user cancels the save dialog', async () => {
    env = setupBrowserEnv({
      showSaveFilePickerImpl: async () => {
        const err: any = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      },
    });
    const payload = new Uint8Array([1, 2, 3]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    await expect(env.win.streamingDownload('/api/exports/cancel.csv')).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Cancellation must NOT trigger the noisy alert UX.
    expect(env.win.alert).not.toHaveBeenCalled();
  });

  it('updates the configured button label with byte progress while streaming', async () => {
    env = setupBrowserEnv();
    const chunkA = new Uint8Array(2048).fill(1);
    const chunkB = new Uint8Array(1024).fill(2);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([chunkA, chunkB]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );

    const button = env.win.document.createElement('button');
    button.textContent = 'Export';
    env.win.document.body.appendChild(button);
    const originalHTML = button.innerHTML;

    const result = await env.win.streamingDownload('/api/exports/progress.bin', { button });
    expect(result.streamedToDisk).toBe(true);
    // Button gets restored after completion.
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe(originalHTML);
  });

  it('streams via service worker (Firefox/Safari path) when File System Access is unavailable', async () => {
    env = setupBrowserEnv({
      enableShowSaveFilePicker: false,
      installServiceWorker: true,
    });
    const chunkA = new Uint8Array(2048).fill(3);
    const chunkB = new Uint8Array(1024).fill(4);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([chunkA, chunkB]), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="big-export.bin"',
          // No content-length so streaming is preferred.
        },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/big-export.bin');

    // SW must have received exactly one register message with the readable
    // transferred, and an iframe must have been created to trigger download.
    const registerCalls = env.swCalls.filter((c) => c.msg && c.msg.type === 'register');
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].msg.filename).toBe('big-export.bin');
    expect(registerCalls[0].msg.contentType).toBe('application/octet-stream');
    expect(registerCalls[0].transfer).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ getReader: expect.any(Function) }),
      ])
    );
    const iframes = env.win.document.querySelectorAll('iframe');
    expect(iframes.length).toBeGreaterThanOrEqual(1);
    expect(iframes[0].src).toMatch(/\/_stream-download\//);

    expect(result.streamedToDisk).toBe(true);
    expect(result.bytes).toBe(chunkA.byteLength + chunkB.byteLength);
  });

  it('falls back to the Blob path when the service worker fails to ack registration', async () => {
    env = setupBrowserEnv({
      enableShowSaveFilePicker: false,
      installServiceWorker: true,
      serviceWorkerImpl: { ackOk: false },
    });
    const payload = new Uint8Array([9, 9, 9, 9]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/sw-fail.csv');
    // SW path attempted but rejected — Blob fallback ran instead.
    expect(result.streamedToDisk).toBe(false);
    expect(result.bytes).toBe(payload.byteLength);
  });

  it('lets the user cancel an in-progress download via the export button (File System Access path)', async () => {
    env = setupBrowserEnv();

    // Build a body stream we can drip-feed and then error out from the
    // mocked fetch's signal handler when the user clicks Cancel.
    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, init: any = {}) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            bodyController.error(err);
          } catch (_) { /* ignore */ }
        });
      }
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="big.bin"',
        },
      });
    });

    const button = env.win.document.createElement('button');
    button.textContent = 'Export';
    env.win.document.body.appendChild(button);
    const originalHTML = button.innerHTML;

    // A second click handler simulating the page's existing wiring (e.g. a
    // bound onClick that would re-trigger the export). It must NOT fire while
    // the button is in cancel mode.
    const pageHandler = vi.fn();
    button.addEventListener('click', pageHandler);

    const downloadPromise = env.win.streamingDownload('/api/exports/big.bin', {
      button,
      // Skip the preflight estimate so it doesn't consume our singleton body.
      skipEstimate: true,
      // Force the FSA streaming path even though Content-Length is absent.
      streamToDisk: true,
    });

    // Let setBusy + picker + first chunk run.
    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 5));

    expect(button.getAttribute('data-streaming-active')).toBe('1');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain('Cancel');

    button.click();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });

    // Page-level click handler must not have fired (we suppressed via
    // stopImmediatePropagation in the capture-phase cancel handler).
    expect(pageHandler).not.toHaveBeenCalled();
    // Cancellation is silent — no scary alert, no spurious ok flow.
    expect(env.win.alert).not.toHaveBeenCalled();
    // Original button content restored and cancel state cleared.
    expect(button.innerHTML).toBe(originalHTML);
    expect(button.hasAttribute('data-streaming-active')).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it('lets the user cancel an in-progress download via the export button (service worker path) and notifies the SW', async () => {
    env = setupBrowserEnv({
      enableShowSaveFilePicker: false,
      installServiceWorker: true,
    });

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, init: any = {}) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            bodyController.error(err);
          } catch (_) { /* ignore */ }
        });
      }
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="sw-big.bin"',
        },
      });
    });

    const button = env.win.document.createElement('button');
    button.textContent = 'Export';
    env.win.document.body.appendChild(button);

    const downloadPromise = env.win.streamingDownload('/api/exports/sw-big.bin', {
      button,
      skipEstimate: true,
      streamToDisk: true,
    });

    // Wait until the SW register ack lands and the iframe is in the DOM.
    for (let i = 0; i < 50; i++) {
      const hasReg = env.swCalls.some((c) => c.msg && c.msg.type === 'register');
      const hasIframe = env.win.document.querySelectorAll('iframe').length > 0;
      if (hasReg && hasIframe) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const registerCall = env.swCalls.find((c) => c.msg && c.msg.type === 'register');
    expect(registerCall).toBeDefined();
    const registeredId = registerCall!.msg.id;

    bodyController.enqueue(new Uint8Array([7, 7, 7]));
    await new Promise((r) => setTimeout(r, 5));

    expect(button.getAttribute('data-streaming-active')).toBe('1');
    expect(button.textContent).toContain('Cancel');

    button.click();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });

    // Service worker received an explicit cancel for the registered id.
    const cancelCalls = env.swCalls.filter(
      (c) => c.msg && c.msg.type === 'cancel' && c.msg.id === registeredId
    );
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(env.win.alert).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-streaming-active')).toBe(false);
  });

  it('exposes a programmatic cancel handle via options.onCancelHandle for callers without a button', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, init: any = {}) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            bodyController.error(err);
          } catch (_) { /* ignore */ }
        });
      }
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    });

    let cancelFn: (() => void) | null = null;
    const downloadPromise = env.win.streamingDownload('/api/exports/handle.csv', {
      onCancelHandle: (fn: () => void) => { cancelFn = fn; },
      skipEstimate: true,
      // No SW + no FSA: forces the Blob path, which still respects the abort.
      useServiceWorker: false,
    });

    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(new Uint8Array([1, 2]));
    await new Promise((r) => setTimeout(r, 5));

    expect(cancelFn).toBeTypeOf('function');
    cancelFn!();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.win.alert).not.toHaveBeenCalled();
  });

  it('forwards an externally provided fetchInit.signal abort into the streaming download', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, init: any = {}) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            bodyController.error(err);
          } catch (_) { /* ignore */ }
        });
      }
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    });

    const externalCtrl = new (globalThis as any).AbortController();
    const downloadPromise = env.win.streamingDownload('/api/exports/external.csv', {
      fetchInit: { signal: externalCtrl.signal },
      skipEstimate: true,
      useServiceWorker: false,
    });

    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5));

    externalCtrl.abort();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.win.alert).not.toHaveBeenCalled();
  });

  // === Environmental-abort tests (Task #183) ===
  // Distinguish user-initiated cancels from browser/OS aborts (tab discarded,
  // sleep/wake, background-throttling, network drop) and surface a non-blocking
  // "Download interrupted — Retry" toast in the latter case.

  it('shows an "Interrupted — Retry" toast when the browser aborts the fetch mid-stream (no user cancel)', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    let fetchCalls = 0;
    env.win.fetch = vi.fn(async () => {
      fetchCalls += 1;
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="huge.csv"',
        },
      });
    });

    const downloadPromise = env.win.streamingDownload('/api/exports/huge.csv', {
      skipEstimate: true,
      useServiceWorker: false,
    });

    // Let the download start and receive a chunk.
    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 5));

    // Simulate the browser/OS killing the fetch (tab discarded, sleep/wake,
    // background-throttling, network drop). We surface this as an AbortError
    // even though no one called cancelDownload().
    const browserAbort: any = new Error('The user agent terminated the request.');
    browserAbort.name = 'AbortError';
    bodyController.error(browserAbort);

    await expect(downloadPromise).rejects.toMatchObject({
      name: 'AbortError',
      interrupted: true,
    });

    // The "Interrupted — Retry" warn toast must be in the DOM.
    const toast = env.win.document.querySelector('[data-testid="toast-download-interrupted"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toMatch(/interrupted/i);
    expect(toast?.textContent).toMatch(/huge\.csv/);
    // The Retry action button must be present and labelled "Retry". Scope
    // the lookup to the toast so we don't accidentally match the
    // recent-downloads-tray Retry button (data-testid prefix
    // `button-retry-download-<id>`).
    const retryBtn = toast?.querySelector(
      '[data-testid="button-retry-download"]'
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe('Retry');

    // The progress card must show an "Interrupted" state, not "Cancelled".
    const card = env.win.document.querySelector('[data-testid="card-download-progress"]');
    const status = card?.querySelector('[data-testid="text-download-status"]');
    expect(status?.textContent).toMatch(/interrupted/i);

    // Sanity: only one fetch so far (the Retry hasn't fired yet).
    expect(fetchCalls).toBe(1);
    expect(env.win.alert).not.toHaveBeenCalled();
  });

  it('Retry action on the interrupted toast re-invokes streamingDownload with the same url/options', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    // First call: starts streaming, then errors with an environmental
    // AbortError. Second call (from Retry): completes successfully.
    let callCount = 0;
    let firstBodyController: any;

    env.win.fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        const body = new (globalThis as any).ReadableStream({
          start(c: any) { firstBodyController = c; },
        });
        return new (globalThis as any).Response(body, {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        });
      }
      // Retry attempt — return a small payload that completes normally.
      return new (globalThis as any).Response(streamFromChunks([new Uint8Array([42, 43])]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    });

    const firstPromise = env.win.streamingDownload('/api/exports/retry-abort.csv', {
      skipEstimate: true,
      useServiceWorker: false,
    });

    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.enqueue(new Uint8Array([0]));
    await new Promise((r) => setTimeout(r, 5));

    // Simulate environmental abort.
    const envAbort: any = new Error('aborted by browser');
    envAbort.name = 'AbortError';
    firstBodyController.error(envAbort);

    await expect(firstPromise).rejects.toMatchObject({ name: 'AbortError', interrupted: true });

    // Capture the interrupted toast so we can assert it gets dismissed.
    const interruptedToast = env.win.document.querySelector(
      '[data-testid="toast-download-interrupted"]'
    ) as HTMLElement | null;
    expect(interruptedToast).not.toBeNull();

    // Click Retry on the toast (scoped to the toast itself to avoid the
    // recent-downloads tray's per-row retry button).
    const retryBtn = interruptedToast?.querySelector(
      '[data-testid="button-retry-download"]'
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    retryBtn?.click();

    // Wait for the second download to complete (it runs through the Blob path).
    await new Promise((r) => setTimeout(r, 350));

    expect(callCount).toBe(2);
    // After Retry is clicked, the interrupted toast is dismissed (fades out
    // and is removed from the DOM) so the user isn't left looking at a stale
    // "interrupted" warning while the retried download is in flight.
    expect(
      env.win.document.querySelector('[data-testid="toast-download-interrupted"]')
    ).toBeNull();
  });

  it('does NOT show an "Interrupted — Retry" toast when the user clicks Cancel (stays silent)', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, init: any = {}) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          try {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            bodyController.error(err);
          } catch (_) { /* ignore */ }
        });
      }
      return new (globalThis as any).Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="silent.csv"',
        },
      });
    });

    let cancelFn: (() => void) | null = null;
    const downloadPromise = env.win.streamingDownload('/api/exports/silent.csv', {
      onCancelHandle: (fn: () => void) => { cancelFn = fn; },
      skipEstimate: true,
      useServiceWorker: false,
    });

    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(new Uint8Array([1, 2]));
    await new Promise((r) => setTimeout(r, 5));

    // User-initiated cancel.
    cancelFn!();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });

    // No interrupted toast, no error toast — user cancels stay silent.
    expect(
      env.win.document.querySelector('[data-testid="toast-download-interrupted"]')
    ).toBeNull();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-error"]')
    ).toBeNull();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-info"]')
    ).toBeNull();

    // The card briefly shows "Cancelled" (not "Interrupted").
    const card = env.win.document.querySelector('[data-testid="card-download-progress"]');
    const status = card?.querySelector('[data-testid="text-download-status"]');
    expect(status?.textContent).toMatch(/cancelled/i);

    expect(env.win.alert).not.toHaveBeenCalled();
  });

  it('treats a save-dialog dismissal (picker AbortError) as a user cancel, not an environmental abort', async () => {
    env = setupBrowserEnv({
      showSaveFilePickerImpl: async () => {
        const err: any = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      },
    });
    const payload = new Uint8Array([1, 2, 3]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    await expect(env.win.streamingDownload('/api/exports/picker.csv')).rejects.toMatchObject({
      name: 'AbortError',
    });

    // Picker dismissal is a deliberate user action — must NOT show the
    // environmental-interrupted toast.
    expect(
      env.win.document.querySelector('[data-testid="toast-download-interrupted"]')
    ).toBeNull();
  });

  // === Recent-downloads history tests (anonymous fallback) ===
  // Anonymous visitors keep the legacy per-tab sessionStorage tray. Signed-in
  // users get per-user localStorage persistence — see the
  // "recent-downloads history persistence (signed-in user)" describe block
  // further down.

  it('records each successful download in the recent-downloads history (anonymous → sessionStorage)', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });
    const payload = new Uint8Array([10, 11, 12]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="report.csv"',
        },
      })
    );

    await env.win.streamingDownload('/api/exports/report.csv');

    const list = env.win.streamingDownload.history.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: 'report.csv',
      url: '/api/exports/report.csv',
      status: 'done',
      bytes: payload.byteLength,
    });
  });

  it('records failed downloads with an error message and exposes a Retry button', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response('boom', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    );

    await expect(
      env.win.streamingDownload('/api/exports/broken.csv', { filename: 'broken.csv' })
    ).rejects.toThrow();

    const list = env.win.streamingDownload.history.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: 'broken.csv',
      status: 'failed',
    });
    expect(list[0].error).toBeTruthy();

    // The tray must be auto-rendered with a Retry button on the failed row.
    const tray = env.win.document.getElementById('streaming-download-history-tray');
    expect(tray).not.toBeNull();
    // Tray opens by default when there's at least one entry? It starts collapsed.
    // Open it via the toggle, then the Retry button becomes visible.
    const toggle = tray.querySelector('[data-testid="button-recent-downloads-toggle"]');
    expect(toggle).not.toBeNull();
    toggle.click();
    const retryBtn = tray.querySelector('[data-testid^="button-retry-download-"]');
    expect(retryBtn).not.toBeNull();
  });

  it('records cancelled downloads when the user cancels via the floating progress card', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    let resolveResp: ((r: any) => void) | null = null;
    env.win.fetch = vi.fn(async (_url: string, init: any) => {
      // Reject as soon as the abort signal fires so the cancel path runs.
      return new Promise((resolve, reject) => {
        resolveResp = resolve;
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const promise = env.win
      .streamingDownload('/api/exports/slow.csv', { filename: 'slow.csv', skipEstimate: true })
      .catch((e: any) => e);

    // Wait a tick so the in-progress entry is recorded and the card mounted.
    await new Promise((r) => setTimeout(r, 10));
    const cancelBtn = env.win.document.querySelector(
      '[data-testid="button-cancel-download"]'
    ) as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    const err = await promise;
    expect(err.name).toBe('AbortError');

    const list = env.win.streamingDownload.history.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: 'slow.csv',
      status: 'cancelled',
    });

    // Suppress unused-var lint by referencing resolveResp.
    void resolveResp;
  });

  it('caps the history at 5 entries (most recent first)', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([new Uint8Array([1])]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    for (let i = 0; i < 7; i++) {
      await env.win.streamingDownload('/api/exports/file-' + i + '.csv', {
        filename: 'file-' + i + '.csv',
      });
    }

    const list = env.win.streamingDownload.history.list();
    expect(list).toHaveLength(5);
    // Most recent (file-6) must be at the top.
    expect(list[0].filename).toBe('file-6.csv');
    expect(list[4].filename).toBe('file-2.csv');
  });

  it('retries a failed download via streamingDownload.history.retry()', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    // Sequence of mocked responses. Pre-flight estimates always 404 so the
    // helper falls through quickly without touching our real export slots.
    let realCallCount = 0;
    env.win.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.indexOf('/estimate') !== -1) {
        return new (globalThis as any).Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' },
        });
      }
      realCallCount++;
      if (realCallCount === 1) {
        return new (globalThis as any).Response('boom', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new (globalThis as any).Response(streamFromChunks([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    });

    await expect(
      env.win.streamingDownload('/api/exports/retry.csv', { filename: 'retry.csv' })
    ).rejects.toThrow();

    const before = env.win.streamingDownload.history.list();
    expect(before[0].status).toBe('failed');

    // Use the public retry helper to re-issue the original request.
    env.win.streamingDownload.history.retry(before[0].id);
    await new Promise((r) => setTimeout(r, 50));

    const after = env.win.streamingDownload.history.list();
    // A new entry is recorded for the retry attempt and reaches "done".
    const done = after.find((e: any) => e.status === 'done');
    expect(done).toBeTruthy();
    expect(done.filename).toBe('retry.csv');
    expect(realCallCount).toBe(2);
  });

  // ---- Resume after interrupted streaming download ------------------------
  // This branch's feature: surface a Resume affordance after a recoverable
  // network error and stitch the resumed bytes into the same writable handle.

  it('surfaces a Resume button on a mid-stream network failure and stitches the resumed bytes into the same writable handle', async () => {
    env = setupBrowserEnv();

    // First fetch: serve the first half then error before completion. The
    // mock advertises Accept-Ranges + ETag + Content-Length so the helper
    // considers the response resumable.
    const HEAD = new Uint8Array([10, 20, 30, 40]);
    const TAIL = new Uint8Array([50, 60, 70, 80, 90]);
    const TOTAL = HEAD.byteLength + TAIL.byteLength;
    const ETAG = 'W/"deadbeef"';

    let firstBodyController: any;
    const firstBody = new (globalThis as any).ReadableStream({
      start(c: any) { firstBodyController = c; },
    });

    const fetchSpy = vi.fn(async (_url: string, init: any = {}) => {
      const headers = (init && init.headers) || {};
      const range =
        (typeof headers.get === 'function' && headers.get('Range')) ||
        headers['Range'] || headers['range'];
      const ifRange =
        (typeof headers.get === 'function' && headers.get('If-Range')) ||
        headers['If-Range'] || headers['if-range'];

      if (!range) {
        // Initial request — return the streaming body whose tail we'll error.
        return new (globalThis as any).Response(firstBody, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="demo.bin"',
            'content-length': String(TOTAL),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        });
      }

      // Resume request — must include If-Range matching the original etag
      // and a Range header rooted at exactly the byte we last wrote.
      expect(ifRange).toBe(ETAG);
      expect(range).toBe('bytes=' + HEAD.byteLength + '-');
      return new (globalThis as any).Response(
        new (globalThis as any).Response(TAIL).body,
        {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes ' + HEAD.byteLength + '-' + (TOTAL - 1) + '/' + TOTAL,
            'content-length': String(TAIL.byteLength),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        }
      );
    });
    env.win.fetch = fetchSpy;

    const downloadPromise = env.win.streamingDownload('/api/exports/demo.bin', {
      // Force the FSA streaming path even though the body is small.
      streamToDisk: true,
      skipEstimate: true,
    });

    // Drive the first attempt up to the boundary then simulate a mid-stream
    // network drop by erroring the body controller.
    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.enqueue(HEAD);
    await new Promise((r) => setTimeout(r, 5));
    const netErr: any = new Error('network closed');
    netErr.name = 'TypeError';
    firstBodyController.error(netErr);

    // The Resume affordance should appear in the progress card. We poll the
    // DOM until the button is present (the prompt is added asynchronously
    // when the pipe loop catches the body error).
    let resumeBtn: any = null;
    for (let i = 0; i < 50; i++) {
      resumeBtn = env.win.document.querySelector('[data-testid="button-resume-download"]');
      if (resumeBtn) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resumeBtn).not.toBeNull();
    expect(resumeBtn.textContent).toMatch(/Resume/i);

    // User clicks Resume. The helper must issue a second fetch with the
    // Range/If-Range headers and finish writing the tail into the *same*
    // writable handle — i.e. createWritable must NOT have been called twice.
    resumeBtn.click();

    const result = await downloadPromise;

    expect(result.streamedToDisk).toBe(true);
    expect(result.bytes).toBe(TOTAL);
    expect(env.fileHandle.createWritable).toHaveBeenCalledTimes(1);

    // Both calls (initial + resume) should have been issued against the
    // same URL and the resume call must have included the Range header.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const resumeCallInit = fetchSpy.mock.calls[1][1] || {};
    const resumeRange =
      (resumeCallInit.headers && (
        (typeof resumeCallInit.headers.get === 'function' && resumeCallInit.headers.get('Range')) ||
        resumeCallInit.headers['Range'] ||
        resumeCallInit.headers['range']
      )) || null;
    expect(resumeRange).toBe('bytes=' + HEAD.byteLength + '-');

    // Stitched file must contain HEAD followed by TAIL — no overlap, no gap.
    const merged = new Uint8Array(result.bytes);
    let off = 0;
    for (const w of env.writes) {
      merged.set(w, off);
      off += w.byteLength;
    }
    expect(Array.from(merged)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  // ---- Resume auto-retry with backoff (network still down at Resume time) -

  it('auto-retries the Range fetch with exponential backoff when the network is still down at Resume time, then stitches the bytes once the retry succeeds', async () => {
    env = setupBrowserEnv();
    // Make the backoff delays effectively zero so the test runs in ms, not s.
    env.win.STREAMING_DOWNLOAD_RESUME_MAX_ATTEMPTS = 3;
    env.win.STREAMING_DOWNLOAD_RESUME_BASE_DELAY_MS = 1;

    const HEAD = new Uint8Array([1, 2, 3, 4]);
    const TAIL = new Uint8Array([5, 6, 7, 8]);
    const TOTAL = HEAD.byteLength + TAIL.byteLength;
    const ETAG = 'W/"flaky"';

    let firstBodyController: any;
    const firstBody = new (globalThis as any).ReadableStream({
      start(c: any) { firstBodyController = c; },
    });

    // call#1: initial 200 (interrupts mid-stream)
    // call#2: Resume click → simulated DNS/network failure
    // call#3: backoff retry → STILL fails
    // call#4: backoff retry #2 → succeeds with 206 Partial Content.
    const fetchSpy = vi.fn(async (_url: string, init: any = {}) => {
      const headers = (init && init.headers) || {};
      const range =
        (typeof headers.get === 'function' && headers.get('Range')) ||
        headers['Range'] || headers['range'];

      if (!range) {
        return new (globalThis as any).Response(firstBody, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="flaky.bin"',
            'content-length': String(TOTAL),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        });
      }

      // Reject the first two Range fetches as if the network was still down.
      const rangeAttempt = fetchSpy.mock.calls.filter(
        (c: any[]) => {
          const h = (c[1] && c[1].headers) || {};
          return (typeof h.get === 'function' ? h.get('Range') : (h['Range'] || h['range']));
        }
      ).length;
      if (rangeAttempt <= 2) {
        const err: any = new TypeError('Failed to fetch');
        throw err;
      }

      // Third Range attempt → succeed.
      return new (globalThis as any).Response(
        new (globalThis as any).Response(TAIL).body,
        {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes ' + HEAD.byteLength + '-' + (TOTAL - 1) + '/' + TOTAL,
            'content-length': String(TAIL.byteLength),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        }
      );
    });
    env.win.fetch = fetchSpy;

    const downloadPromise = env.win.streamingDownload('/api/exports/flaky.bin', {
      streamToDisk: true,
      skipEstimate: true,
    });

    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.enqueue(HEAD);
    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.error(Object.assign(new Error('drop'), { name: 'TypeError' }));

    // Wait for the Resume prompt and click it.
    let resumeBtn: any = null;
    for (let i = 0; i < 80; i++) {
      resumeBtn = env.win.document.querySelector('[data-testid="button-resume-download"]');
      if (resumeBtn) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resumeBtn).not.toBeNull();
    resumeBtn.click();

    // Watch the retry attempt counter climb on the status element. The
    // first attempt fires immediately and looks like a normal in-progress
    // pipe; only attempts 2..N flip the data-retry-attempt attribute.
    let sawRetryStatus = false;
    let lastAttemptValue = '';
    let lastReason = '';
    for (let i = 0; i < 200; i++) {
      const status = env.win.document.querySelector('[data-testid="text-download-status"]');
      const a = status && status.getAttribute('data-retry-attempt');
      if (a) {
        sawRetryStatus = true;
        lastAttemptValue = a;
        lastReason = status.getAttribute('data-resume-reason') || '';
      }
      // Bail early once we see attempt 2 (the second retry the user did NOT click).
      if (a && Number(a) >= 2) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(sawRetryStatus).toBe(true);
    expect(Number(lastAttemptValue)).toBeGreaterThanOrEqual(2);
    // The status copy should explain WHY we're retrying so the user can
    // tell a flaky network from a permanent failure.
    expect(lastReason).toMatch(/Failed to fetch|drop|network/i);

    const result = await downloadPromise;

    expect(result.streamedToDisk).toBe(true);
    expect(result.bytes).toBe(TOTAL);
    // Same writable handle reused across the original pipe + auto-retries.
    expect(env.fileHandle.createWritable).toHaveBeenCalledTimes(1);

    // 1 initial GET + 3 Range retries (2 failures + 1 success) = 4 total.
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // Stitched file must be HEAD followed by TAIL — no overlap, no gap.
    const merged = new Uint8Array(result.bytes);
    let off = 0;
    for (const w of env.writes) {
      merged.set(w, off);
      off += w.byteLength;
    }
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('re-opens the Resume prompt with the failure reason after the auto-retry budget is exhausted, preserving the partial bytes for another attempt', async () => {
    env = setupBrowserEnv();
    env.win.STREAMING_DOWNLOAD_RESUME_MAX_ATTEMPTS = 2;
    env.win.STREAMING_DOWNLOAD_RESUME_BASE_DELAY_MS = 1;

    const HEAD = new Uint8Array([9, 9, 9, 9]);
    const TAIL = new Uint8Array([7, 7, 7, 7]);
    const TOTAL = HEAD.byteLength + TAIL.byteLength;
    const ETAG = 'W/"exhaust"';

    let firstBodyController: any;
    const firstBody = new (globalThis as any).ReadableStream({
      start(c: any) { firstBodyController = c; },
    });

    // Track Range-fetch attempts so we can fail the first three (initial
    // click + 2 backoff retries = exhausted budget) and succeed on the
    // *second* Resume click's first attempt.
    let rangeAttempts = 0;
    const fetchSpy = vi.fn(async (_url: string, init: any = {}) => {
      const headers = (init && init.headers) || {};
      const range =
        (typeof headers.get === 'function' && headers.get('Range')) ||
        headers['Range'] || headers['range'];

      if (!range) {
        return new (globalThis as any).Response(firstBody, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="exhaust.bin"',
            'content-length': String(TOTAL),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        });
      }

      rangeAttempts += 1;
      if (rangeAttempts <= 2) {
        // First Resume cycle: fail twice (1 click + 1 backoff retry, since
        // STREAMING_DOWNLOAD_RESUME_MAX_ATTEMPTS=2). User must re-prompt.
        throw new TypeError('Failed to fetch (still down)');
      }
      // Second Resume cycle's first attempt: succeed.
      return new (globalThis as any).Response(
        new (globalThis as any).Response(TAIL).body,
        {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes ' + HEAD.byteLength + '-' + (TOTAL - 1) + '/' + TOTAL,
            'content-length': String(TAIL.byteLength),
            'accept-ranges': 'bytes',
            'etag': ETAG,
          },
        }
      );
    });
    env.win.fetch = fetchSpy;

    const downloadPromise = env.win.streamingDownload('/api/exports/exhaust.bin', {
      streamToDisk: true,
      skipEstimate: true,
    });

    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.enqueue(HEAD);
    await new Promise((r) => setTimeout(r, 5));
    firstBodyController.error(Object.assign(new Error('drop'), { name: 'TypeError' }));

    // First Resume click — exhausts the auto-retry budget.
    let resumeBtn: any = null;
    for (let i = 0; i < 80; i++) {
      resumeBtn = env.win.document.querySelector('[data-testid="button-resume-download"]');
      if (resumeBtn) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(resumeBtn).not.toBeNull();
    resumeBtn.click();

    // After both retries fail, the Resume prompt must reappear with the
    // failure reason surfaced in the status copy / data attribute.
    let secondPrompt: any = null;
    let promptReason = '';
    for (let i = 0; i < 200; i++) {
      // Wait until BOTH the Resume button is back AND the reason has been
      // populated (the prompt is rendered in two paint cycles).
      const btn = env.win.document.querySelector('[data-testid="button-resume-download"]');
      const status = env.win.document.querySelector('[data-testid="text-download-status"]');
      const reason = status && status.getAttribute('data-resume-reason');
      if (btn && reason && rangeAttempts >= 2) {
        secondPrompt = btn;
        promptReason = reason;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(secondPrompt).not.toBeNull();
    expect(promptReason).toMatch(/Failed to fetch|still down/i);
    // We've burned through exactly the configured retry budget — no more,
    // no less — before handing control back to the user.
    expect(rangeAttempts).toBe(2);
    // No fresh writable was opened — the partial bytes on disk are still
    // valid for the next Resume click.
    expect(env.fileHandle.createWritable).toHaveBeenCalledTimes(1);

    // Second Resume click — this time the network is back.
    secondPrompt.click();

    const result = await downloadPromise;
    expect(result.streamedToDisk).toBe(true);
    expect(result.bytes).toBe(TOTAL);
    // 1 initial GET + 2 failed Range fetches + 1 successful Range fetch = 4
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const merged = new Uint8Array(result.bytes);
    let off = 0;
    for (const w of env.writes) {
      merged.set(w, off);
      off += w.byteLength;
    }
    expect(Array.from(merged)).toEqual([9, 9, 9, 9, 7, 7, 7, 7]);
  });

  it('aborts the writable when the user dismisses the Resume prompt', async () => {
    env = setupBrowserEnv();

    const HEAD = new Uint8Array([1, 2, 3, 4]);
    const TOTAL = 8;
    const ETAG = 'W/"giveup"';

    let bodyController: any;
    const body = new (globalThis as any).ReadableStream({
      start(c: any) { bodyController = c; },
    });

    env.win.fetch = vi.fn(async (_url: string, _init: any = {}) =>
      new (globalThis as any).Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(TOTAL),
          'accept-ranges': 'bytes',
          'etag': ETAG,
        },
      })
    );

    const downloadPromise = env.win.streamingDownload('/api/exports/giveup.bin', {
      streamToDisk: true,
      skipEstimate: true,
    });

    await new Promise((r) => setTimeout(r, 5));
    bodyController.enqueue(HEAD);
    await new Promise((r) => setTimeout(r, 5));
    bodyController.error(Object.assign(new Error('drop'), { name: 'TypeError' }));

    let discardBtn: any = null;
    for (let i = 0; i < 50; i++) {
      discardBtn = env.win.document.querySelector('[data-testid="button-discard-download"]');
      if (discardBtn) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(discardBtn).not.toBeNull();

    discardBtn.click();

    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(env.fileHandle.aborted).toBe(true);
  });

  describe('confirm-before-cancel for near-complete downloads', () => {
    function makeAbortableBody() {
      let bodyController: any;
      const body = new (globalThis as any).ReadableStream({
        start(c: any) { bodyController = c; },
      });
      return {
        body,
        get controller() { return bodyController; },
      };
    }

    function installAbortableFetch(win: any, b: { controller: any }, headers: Record<string, string>) {
      win.fetch = vi.fn(async (_url: string, init: any = {}) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            try {
              const err: any = new Error('aborted');
              err.name = 'AbortError';
              b.controller.error(err);
            } catch (_) { /* ignore */ }
          });
        }
        return new (globalThis as any).Response((b as any).body, { status: 200, headers });
      });
    }

    it('does NOT prompt when cancellation happens early in the download (under both thresholds)', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      const confirmFn = vi.fn(() => true);
      env.win.confirm = confirmFn;

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/early-cancel.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
      });

      await new Promise((r) => setTimeout(r, 5));
      // Send 100 bytes of 1000 (10%) — well under the 50% threshold and only
      // a few ms have elapsed, so no confirm should fire.
      b.controller.enqueue(new Uint8Array(100));
      await new Promise((r) => setTimeout(r, 5));

      button.click();

      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(confirmFn).not.toHaveBeenCalled();
    });

    it('prompts before cancelling once the download is past the configurable percent threshold', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      const confirmFn = vi.fn(() => true);
      env.win.confirm = confirmFn;

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/big-cancel.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
        // Lock out the time-based trigger so this test is purely about percent.
        confirmCancelThresholdMs: Infinity,
      });

      await new Promise((r) => setTimeout(r, 5));
      // 700/1000 = 70% > 50% threshold → confirm should fire.
      b.controller.enqueue(new Uint8Array(700));
      await new Promise((r) => setTimeout(r, 5));

      button.click();

      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(confirmFn.mock.calls[0][0]).toMatch(/cancel this download/i);
      expect(confirmFn.mock.calls[0][0]).toMatch(/lose progress/i);
    });

    it('keeps the download running when the user backs out of the cancel confirm', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      // First click → user says "no, keep going". Second click → confirms.
      const confirmFn = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
      env.win.confirm = confirmFn;

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/two-clicks.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
        confirmCancelThresholdMs: Infinity,
      });

      await new Promise((r) => setTimeout(r, 5));
      b.controller.enqueue(new Uint8Array(800));
      await new Promise((r) => setTimeout(r, 5));

      // First click — user backs out. The download must NOT abort.
      button.click();
      await new Promise((r) => setTimeout(r, 10));

      expect(confirmFn).toHaveBeenCalledTimes(1);
      // Internal AbortController stays un-aborted, button remains in cancel mode.
      expect(button.getAttribute('data-streaming-active')).toBe('1');
      expect(button.disabled).toBe(false);

      // Push more bytes through to prove the stream is still alive.
      b.controller.enqueue(new Uint8Array(50));
      await new Promise((r) => setTimeout(r, 5));

      // Second click — user confirms.
      button.click();
      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(confirmFn).toHaveBeenCalledTimes(2);
    });

    it('prompts once the elapsed-time threshold passes even when total size is unknown', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        // No content-length: we can't compute a percentage, only elapsed time.
        'content-type': 'application/octet-stream',
      });

      const confirmFn = vi.fn(() => true);
      env.win.confirm = confirmFn;

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/slow.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
        // 5 ms is easy to cross in the test loop; percent threshold disabled
        // because content-length is absent.
        confirmCancelThresholdMs: 5,
      });

      await new Promise((r) => setTimeout(r, 5));
      b.controller.enqueue(new Uint8Array(10));
      // Wait long enough to pass the 5 ms threshold.
      await new Promise((r) => setTimeout(r, 25));

      button.click();
      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(confirmFn).toHaveBeenCalledTimes(1);
    });

    it('skips the confirm gate entirely when confirmCancel is set to false', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      const confirmFn = vi.fn(() => true);
      env.win.confirm = confirmFn;

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/no-confirm.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
        confirmCancel: false,
      });

      await new Promise((r) => setTimeout(r, 5));
      b.controller.enqueue(new Uint8Array(900));
      await new Promise((r) => setTimeout(r, 5));

      button.click();
      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(confirmFn).not.toHaveBeenCalled();
    });

    it('uses a caller-supplied confirmCancel function instead of window.confirm', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      const windowConfirm = vi.fn(() => true);
      env.win.confirm = windowConfirm;
      const customConfirm = vi.fn(() => true);

      const button = env.win.document.createElement('button');
      env.win.document.body.appendChild(button);

      const downloadPromise = env.win.streamingDownload('/api/exports/custom-confirm.bin', {
        button,
        skipEstimate: true,
        useServiceWorker: false,
        showProgressUI: false,
        confirmCancel: customConfirm,
        confirmCancelThresholdMs: Infinity,
      });

      await new Promise((r) => setTimeout(r, 5));
      b.controller.enqueue(new Uint8Array(800));
      await new Promise((r) => setTimeout(r, 5));

      button.click();
      await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });

      expect(customConfirm).toHaveBeenCalledTimes(1);
      expect(customConfirm.mock.calls[0][0]).toMatch(/cancel this download/i);
      expect(windowConfirm).not.toHaveBeenCalled();
    });

    it('keeps the floating progress card cancel button live when the user backs out of the confirm', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      const b = makeAbortableBody();
      installAbortableFetch(env.win, b, {
        'content-type': 'application/octet-stream',
        'content-length': '1000',
      });

      const confirmFn = vi.fn(() => false);
      env.win.confirm = confirmFn;

      const downloadPromise = env.win.streamingDownload('/api/exports/card-cancel.bin', {
        skipEstimate: true,
        useServiceWorker: false,
        confirmCancelThresholdMs: Infinity,
      });

      await new Promise((r) => setTimeout(r, 5));
      b.controller.enqueue(new Uint8Array(800));
      await new Promise((r) => setTimeout(r, 5));

      const cancelBtn = env.win.document.querySelector(
        '[data-testid="button-cancel-download"]'
      ) as HTMLButtonElement | null;
      expect(cancelBtn).not.toBeNull();

      cancelBtn!.click();
      await new Promise((r) => setTimeout(r, 5));

      expect(confirmFn).toHaveBeenCalledTimes(1);
      // Card stays in "Cancel" state (not "Cancelling…") because the user backed out.
      expect(cancelBtn!.disabled).toBe(false);
      expect(cancelBtn!.textContent).toBe('Cancel');

      // Clean up: actually cancel so the test promise settles.
      b.controller.error(Object.assign(new Error('done'), { name: 'AbortError' }));
      await expect(downloadPromise).rejects.toBeDefined();
    });
  });

  function installI18nShim(win: any, dictionary: any) {
    function get(obj: any, path: string) {
      return path.split('.').reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), obj);
    }
    win.WalaPlusI18n = {
      t: (key: string, vars?: Record<string, any>) => {
        const v = get(dictionary, key);
        if (v == null) return key.split('.').pop();
        let s = String(v);
        if (vars) {
          for (const k of Object.keys(vars)) {
            s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k]));
          }
        }
        return s;
      },
    };
  }

  it('renders Arabic translations for the progress card and toast when WalaPlusI18n is loaded', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    const ar = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'dashboard', 'i18n', 'ar.json'), 'utf8')
    );
    installI18nShim(env.win, ar);

    const payload = new Uint8Array(1024).fill(7);
    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="report.csv"',
          'content-length': String(payload.byteLength),
        },
      })
    );

    await env.win.streamingDownload('/api/exports/report.csv');

    // The success toast should now be in Arabic.
    const toast = env.win.document.querySelector('[data-testid="toast-download-success"]');
    expect(toast).not.toBeNull();
    expect(toast!.textContent || '').toContain('تم تنزيل');
    expect(toast!.textContent || '').toContain('report.csv');

    // The dismiss button label switches to Arabic too.
    const dismiss = toast!.querySelector('[data-testid="button-dismiss-toast"]');
    expect(dismiss?.getAttribute('aria-label')).toBe('إغلاق الإشعار');
  });

  it('renders the streaming-fallback advisory in Arabic when WalaPlusI18n is loaded', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    const ar = JSON.parse(
      readFileSync(resolve(__dirname, '..', '..', 'dashboard', 'i18n', 'ar.json'), 'utf8')
    );
    installI18nShim(env.win, ar);

    const main = env.win.document.createElement('main');
    const button = env.win.document.createElement('button');
    button.setAttribute('data-on-click', 'streamDownload');
    button.textContent = 'Export';
    main.appendChild(button);
    env.win.document.body.appendChild(main);

    env.win.streamingDownload.attachStreamingFallbackNotice(env.win.document);

    const notice = env.win.document.querySelector('[data-testid="notice-streaming-fallback"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent || '').toContain('هذا المتصفح');
    expect(notice!.textContent || '').toContain('200 ميجابايت');

    const dismissBtn = notice!.querySelector('[data-testid="button-dismiss-streaming-fallback"]');
    expect(dismissBtn?.getAttribute('aria-label')).toBe('إغلاق إشعار تصدير المتصفح');
  });

  it('falls back to English defaults when WalaPlusI18n is not loaded', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    const payload = new Uint8Array([1, 2, 3]);
    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="plain.csv"',
          'content-length': String(payload.byteLength),
        },
      })
    );

    await env.win.streamingDownload('/api/exports/plain.csv');

    const toast = env.win.document.querySelector('[data-testid="toast-download-success"]');
    expect(toast?.textContent || '').toContain('Downloaded');
    expect(toast?.textContent || '').toContain('plain.csv');
    const dismiss = toast?.querySelector('[data-testid="button-dismiss-toast"]');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss notification');
  });

  it('shows an unread-count badge on the collapsed tray header for newly-finished attempts and clears it once the tray is opened', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="first.csv"',
        },
      })
    );

    // First completed download — tray starts collapsed, so a badge with "1"
    // should appear immediately on the collapsed header.
    await env.win.streamingDownload('/api/exports/first.csv');

    const tray = env.win.document.getElementById('streaming-download-history-tray');
    expect(tray).not.toBeNull();

    let badge = tray.querySelector('[data-testid="badge-recent-downloads-unread"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('1');
    expect(badge!.getAttribute('aria-label')).toMatch(/1 new download update/i);

    // Expanding the tray must clear the badge.
    const toggle = tray.querySelector('[data-testid="button-recent-downloads-toggle"]') as HTMLButtonElement;
    toggle.click();
    expect(tray.querySelector('[data-testid="badge-recent-downloads-unread"]')).toBeNull();

    // Collapse again — still no badge because the user has now seen the entry.
    toggle.click();
    expect(tray.querySelector('[data-testid="badge-recent-downloads-unread"]')).toBeNull();

    // A second download finishes while the tray is collapsed → badge reappears
    // showing only the count of *new* changes since the last open.
    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([new Uint8Array([4, 5])]), {
        status: 200,
        headers: {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="second.csv"',
        },
      })
    );
    await env.win.streamingDownload('/api/exports/second.csv');

    badge = tray.querySelector('[data-testid="badge-recent-downloads-unread"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('1');

    // While the badge is showing, the duplicate "needs retry" subtext must not
    // also fire (the two cues should be merged so the user sees one signal).
    // No failures here, so nothing should appear; sanity-check by asserting
    // the summary element is absent in the no-active-work case.
    expect(
      tray.querySelector('[data-testid="text-recent-downloads-summary"]')
    ).toBeNull();
  });

  it('does not show the unread badge for downloads still in progress', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    // Stalled fetch keeps the entry in the "in-progress" state.
    env.win.fetch = vi.fn(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );

    env.win
      .streamingDownload('/api/exports/slow.csv', {
        filename: 'slow.csv',
        skipEstimate: true,
      })
      .catch(() => {
        /* swallowed — the test does not await completion */
      });

    // Allow the in-progress history entry + tray render to settle.
    await new Promise((r) => setTimeout(r, 10));

    const tray = env.win.document.getElementById('streaming-download-history-tray');
    expect(tray).not.toBeNull();

    // No badge yet: the entry is still running, only the "1 in progress"
    // subtext should advertise it.
    expect(tray.querySelector('[data-testid="badge-recent-downloads-unread"]')).toBeNull();
    const summary = tray.querySelector(
      '[data-testid="text-recent-downloads-summary"]'
    );
    expect(summary).not.toBeNull();
    expect(summary!.textContent).toMatch(/in progress/i);
  });

  it('suppresses the "needs retry" subtext when the unread badge already covers the failure', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response('boom', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      })
    );

    await expect(
      env.win.streamingDownload('/api/exports/bad.csv', { filename: 'bad.csv' })
    ).rejects.toThrow();

    const tray = env.win.document.getElementById('streaming-download-history-tray');
    expect(tray).not.toBeNull();

    // Failure should light up the unread badge…
    const badge = tray.querySelector('[data-testid="badge-recent-downloads-unread"]');
    expect(badge).not.toBeNull();

    // …and suppress the duplicate "X need retry" subtext so the user sees a
    // single, clear cue rather than two competing ones.
    expect(
      tray.querySelector('[data-testid="text-recent-downloads-summary"]')
    ).toBeNull();
  });

  it('honours useServiceWorker=false to skip the SW path entirely', async () => {
    env = setupBrowserEnv({
      enableShowSaveFilePicker: false,
      installServiceWorker: true,
    });
    const payload = new Uint8Array([1, 2, 3, 4]);

    env.win.fetch = vi.fn(async () =>
      new (globalThis as any).Response(streamFromChunks([payload]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      })
    );

    const result = await env.win.streamingDownload('/api/exports/no-sw.csv', {
      useServiceWorker: false,
    });
    // No SW register message should have been sent.
    expect(env.swCalls.filter((c) => c.msg && c.msg.type === 'register')).toHaveLength(0);
    expect(result.streamedToDisk).toBe(false);
  });

  describe('recent-downloads history persistence (signed-in user)', () => {
    it('persists per-user history into localStorage so it survives a tab close', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });

      env.win.fetch = vi.fn(async () =>
        new (globalThis as any).Response(streamFromChunks([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="payroll.csv"',
          },
        })
      );

      // Simulate navigation.js wiring up the signed-in user identity.
      env.win.streamingDownload.history.setUser(42);

      await env.win.streamingDownload('/api/exports/payroll.csv');

      // The list-API still shows the entry…
      const list = env.win.streamingDownload.history.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        filename: 'payroll.csv',
        url: '/api/exports/payroll.csv',
        status: 'done',
      });

      // …and it lives in localStorage under the per-user key, NOT
      // sessionStorage. This is what makes it survive a tab close.
      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-42';
      const persisted = JSON.parse(env.win.localStorage.getItem(userKey) || '[]');
      expect(persisted).toHaveLength(1);
      expect(persisted[0].filename).toBe('payroll.csv');

      // The legacy v1 sessionStorage key must NOT be holding a duplicate.
      expect(
        env.win.sessionStorage.getItem(
          env.win.streamingDownload.history.STORAGE_KEY
        )
      ).toBeNull();
    });

    it('does not leak history between two different signed-in users', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });

      env.win.fetch = vi.fn(async () =>
        new (globalThis as any).Response(streamFromChunks([new Uint8Array([9])]), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        })
      );

      // User A kicks off an export.
      env.win.streamingDownload.history.setUser('alice-1');
      await env.win.streamingDownload('/api/exports/alice.csv', {
        filename: 'alice.csv',
      });
      expect(env.win.streamingDownload.history.list()).toHaveLength(1);

      // User B logs in (e.g. shared workstation). They must NOT see Alice's
      // download in their tray — different localStorage namespace.
      env.win.streamingDownload.history.setUser('bob-2');
      expect(env.win.streamingDownload.history.list()).toEqual([]);

      // And switching back surfaces Alice's history again.
      env.win.streamingDownload.history.setUser('alice-1');
      const list = env.win.streamingDownload.history.list();
      expect(list).toHaveLength(1);
      expect(list[0].filename).toBe('alice.csv');
    });

    it('migrates anonymous (sessionStorage) history into the user namespace on setUser()', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });

      env.win.fetch = vi.fn(async () =>
        new (globalThis as any).Response(streamFromChunks([new Uint8Array([1, 2])]), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        })
      );

      // Download started while still anonymous (e.g. before /api/auth/me
      // came back) — recorded in sessionStorage under the legacy key.
      await env.win.streamingDownload('/api/exports/early.csv', {
        filename: 'early.csv',
      });
      expect(
        env.win.sessionStorage.getItem(
          env.win.streamingDownload.history.STORAGE_KEY
        )
      ).not.toBeNull();

      // Identity arrives — anonymous list should be promoted to per-user
      // localStorage and the sessionStorage copy cleared so the two stores
      // can never drift.
      env.win.streamingDownload.history.setUser(7);

      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-7';
      const persisted = JSON.parse(env.win.localStorage.getItem(userKey) || '[]');
      expect(persisted).toHaveLength(1);
      expect(persisted[0].filename).toBe('early.csv');

      expect(
        env.win.sessionStorage.getItem(
          env.win.streamingDownload.history.STORAGE_KEY
        )
      ).toBeNull();
    });

    it('rehydrates the tray from localStorage on a fresh page load (simulated tab restart)', async () => {
      // First "session": user 99 records a download.
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      env.win.fetch = vi.fn(async () =>
        new (globalThis as any).Response(streamFromChunks([new Uint8Array([5])]), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        })
      );
      env.win.streamingDownload.history.setUser(99);
      await env.win.streamingDownload('/api/exports/yearly.csv', {
        filename: 'yearly.csv',
      });
      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-99';
      const stored = env.win.localStorage.getItem(userKey);
      expect(stored).not.toBeNull();
      env.cleanup();

      // New tab — sessionStorage starts empty, but localStorage carries
      // the previous session. After re-wiring the user, the tray sees
      // the historical download.
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      env.win.localStorage.setItem(userKey, stored as string);
      env.win.streamingDownload.history.setUser(99);

      const list = env.win.streamingDownload.history.list();
      expect(list).toHaveLength(1);
      expect(list[0].filename).toBe('yearly.csv');

      // Tray DOM should also be auto-rendered.
      const tray = env.win.document.getElementById(
        'streaming-download-history-tray'
      );
      expect(tray).not.toBeNull();
    });

    it('prunes entries older than the configured max-age window', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });

      env.win.streamingDownload.history.setUser(123);

      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-123';
      const now = Date.now();
      const entries = [
        {
          id: 'fresh',
          filename: 'fresh.csv',
          url: '/api/exports/fresh.csv',
          status: 'done',
          startedAt: new Date(now - 60_000).toISOString(),
          finishedAt: new Date(now - 60_000).toISOString(),
          bytes: 10,
        },
        {
          id: 'stale',
          filename: 'stale.csv',
          url: '/api/exports/stale.csv',
          status: 'done',
          startedAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
          finishedAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString(),
          bytes: 10,
        },
      ];
      env.win.localStorage.setItem(userKey, JSON.stringify(entries));

      // Default max-age is 30 days → only the fresh entry survives.
      const list = env.win.streamingDownload.history.list();
      expect(list.map((e: any) => e.id)).toEqual(['fresh']);
    });

    it('honours window.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS override', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      env.win.streamingDownload.history.setUser(7);

      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-7';
      const now = Date.now();
      env.win.localStorage.setItem(
        userKey,
        JSON.stringify([
          {
            id: 'two-hours-old',
            filename: 'old.csv',
            status: 'done',
            startedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            finishedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
            bytes: 1,
          },
        ])
      );

      // Tighten the window to 1 hour — the entry above must be pruned.
      env.win.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS = 60 * 60 * 1000;
      expect(env.win.streamingDownload.history.list()).toEqual([]);

      // Setting it to 0 disables expiration entirely.
      env.win.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS = 0;
      env.win.localStorage.setItem(
        userKey,
        JSON.stringify([
          {
            id: 'ancient',
            filename: 'ancient.csv',
            status: 'done',
            startedAt: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
            finishedAt: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
            bytes: 1,
          },
        ])
      );
      expect(env.win.streamingDownload.history.list()).toHaveLength(1);
    });

    it('retry button still works after a fresh login (entry persisted via localStorage)', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });

      let realCallCount = 0;
      env.win.fetch = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.indexOf('/estimate') !== -1) {
          return new (globalThis as any).Response('not found', {
            status: 404,
            headers: { 'content-type': 'text/plain' },
          });
        }
        realCallCount++;
        if (realCallCount === 1) {
          return new (globalThis as any).Response('boom', {
            status: 500,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new (globalThis as any).Response(
          streamFromChunks([new Uint8Array([1])]),
          { status: 200, headers: { 'content-type': 'text/csv' } }
        );
      });

      // Original session — fail and persist.
      env.win.streamingDownload.history.setUser(55);
      await expect(
        env.win.streamingDownload('/api/exports/quarterly.csv', {
          filename: 'quarterly.csv',
        })
      ).rejects.toThrow();

      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-55';
      const stored = env.win.localStorage.getItem(userKey);
      expect(stored).not.toBeNull();
      env.cleanup();

      // Brand-new tab + fresh login: same user, new sessionStorage,
      // but localStorage still holds the failed entry.
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      env.win.localStorage.setItem(userKey, stored as string);

      let retryCallCount = 0;
      env.win.fetch = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.indexOf('/estimate') !== -1) {
          return new (globalThis as any).Response('not found', {
            status: 404,
            headers: { 'content-type': 'text/plain' },
          });
        }
        retryCallCount++;
        return new (globalThis as any).Response(
          streamFromChunks([new Uint8Array([1])]),
          { status: 200, headers: { 'content-type': 'text/csv' } }
        );
      });
      env.win.streamingDownload.history.setUser(55);

      const list = env.win.streamingDownload.history.list();
      expect(list).toHaveLength(1);
      expect(list[0].filename).toBe('quarterly.csv');
      expect(list[0].status).toBe('failed');

      env.win.streamingDownload.history.retry(list[0].id);
      await new Promise((r) => setTimeout(r, 50));

      const after = env.win.streamingDownload.history.list();
      const done = after.find((e: any) => e.status === 'done');
      expect(done).toBeTruthy();
      expect(done.filename).toBe('quarterly.csv');
      expect(retryCallCount).toBe(1);
    });

    it('clear() wipes the per-user localStorage entries', async () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      env.win.fetch = vi.fn(async () =>
        new (globalThis as any).Response(streamFromChunks([new Uint8Array([1])]), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        })
      );
      env.win.streamingDownload.history.setUser(11);
      await env.win.streamingDownload('/api/exports/will-clear.csv', {
        filename: 'will-clear.csv',
      });

      const userKey =
        env.win.streamingDownload.history.STORAGE_KEY_PREFIX + '.u-11';
      expect(env.win.localStorage.getItem(userKey)).not.toBeNull();

      env.win.streamingDownload.history.clear();
      expect(env.win.streamingDownload.history.list()).toEqual([]);
      const after = env.win.localStorage.getItem(userKey);
      expect(after === null || after === '[]').toBe(true);
    });
  });

  describe('streaming-fallback advisory notice', () => {
    function seedExportButton(win: any) {
      const main = win.document.createElement('main');
      const btn = win.document.createElement('button');
      btn.setAttribute('data-on-click', 'streamDownload');
      btn.setAttribute('data-estimate-url', '/api/exports/example');
      btn.textContent = 'Export CSV';
      main.appendChild(btn);
      win.document.body.appendChild(main);
      return main;
    }

    it('exposes canStreamToDisk() that reflects browser capabilities', () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      expect(env.win.streamingDownload.canStreamToDisk()).toBe(false);
      env.cleanup();

      env = setupBrowserEnv({ enableShowSaveFilePicker: true });
      expect(env.win.streamingDownload.canStreamToDisk()).toBe(true);
    });

    it('does not render a notice on streaming-capable browsers', () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: true });
      seedExportButton(env.win);
      env.win.streamingDownload.attachStreamingFallbackNotice();
      expect(env.win.document.getElementById('streaming-download-fallback-notice')).toBeNull();
    });

    it('renders a dismissible notice when neither streaming path is available', () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      seedExportButton(env.win);

      env.win.streamingDownload.attachStreamingFallbackNotice();

      const notice = env.win.document.getElementById('streaming-download-fallback-notice');
      expect(notice).not.toBeNull();
      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.textContent).toMatch(/can't stream exports directly to disk/i);
      expect(notice?.textContent).toMatch(/Chrome, Firefox, or Safari/i);

      const dismiss = notice?.querySelector(
        '[data-testid="button-dismiss-streaming-fallback"]'
      ) as HTMLButtonElement | null;
      expect(dismiss).not.toBeNull();

      dismiss?.click();

      expect(env.win.document.getElementById('streaming-download-fallback-notice')).toBeNull();
      expect(
        env.win.sessionStorage.getItem(env.win.streamingDownload.FALLBACK_NOTICE_DISMISS_KEY)
      ).toBe('1');

      // Re-attaching after dismissal must NOT bring the notice back.
      env.win.streamingDownload.attachStreamingFallbackNotice();
      expect(env.win.document.getElementById('streaming-download-fallback-notice')).toBeNull();
    });

    it('does nothing when the page has no export buttons', () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      // No export buttons seeded.
      env.win.streamingDownload.attachStreamingFallbackNotice();
      expect(env.win.document.getElementById('streaming-download-fallback-notice')).toBeNull();
    });

    it('only inserts a single notice even when called repeatedly', () => {
      env = setupBrowserEnv({ enableShowSaveFilePicker: false });
      seedExportButton(env.win);

      env.win.streamingDownload.attachStreamingFallbackNotice();
      env.win.streamingDownload.attachStreamingFallbackNotice();
      env.win.streamingDownload.attachStreamingFallbackNotice();

      const notices = env.win.document.querySelectorAll(
        '#streaming-download-fallback-notice'
      );
      expect(notices.length).toBe(1);
    });
  });

  it('Cancel button aborts an in-flight slow download, marks the card cancelled, stays silent (no toast), and never alerts', async () => {
    env = setupBrowserEnv({ enableShowSaveFilePicker: false });

    // Capture the AbortSignal handed to fetch so the test can prove it fired.
    let capturedSignal: AbortSignal | null = null;

    // Stalled fetch: never resolves on its own. Only rejects with AbortError
    // when the caller's AbortSignal fires. This deterministically reproduces
    // the "slow export" the dev DB cannot produce on its own.
    env.win.fetch = vi.fn(async (_url: string, init: any) => {
      capturedSignal = (init && init.signal) || null;
      return await new Promise((_resolve, reject) => {
        const signal = init && init.signal;
        if (signal && signal.aborted) {
          const err: any = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        if (signal) {
          signal.addEventListener('abort', () => {
            const err: any = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    // Kick off the download but don't await — we want to interact with the
    // progress card while the fetch is still pending.
    const downloadPromise = env.win.streamingDownload('/api/exports/slow.csv', {
      skipEstimate: true,
      filename: 'slow.csv',
    });

    // streamingDownload creates the progress card synchronously before its
    // first await; flushing one microtask is enough to be safe across
    // future refactors that move the card creation past an await.
    await Promise.resolve();

    const cancelBtn = env.win.document.querySelector(
      '[data-testid="button-cancel-download"]'
    ) as HTMLButtonElement | null;
    expect(cancelBtn).not.toBeNull();

    const bar = env.win.document.querySelector(
      '[data-testid="progress-download-bar"]'
    ) as HTMLElement;
    // Sanity check: the bar starts in the in-flight (blue) state.
    expect(bar.className).toContain('bg-blue-600');

    // Trigger the cancel — this is the path the user takes when an export
    // is taking too long.
    cancelBtn!.click();

    // The download must reject as a cancellation, not a generic failure.
    await expect(downloadPromise).rejects.toMatchObject({ name: 'AbortError' });

    // The fetch's AbortSignal actually fired — the cancel reached the network.
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as AbortSignal).aborted).toBe(true);

    // The progress card now reflects the cancelled state: gray bar, "Cancelled"
    // status, and disabled cancel button.
    expect(bar.className).toContain('bg-gray-400');
    expect(bar.className).not.toContain('bg-blue-600');

    const status = env.win.document.querySelector(
      '[data-testid="text-download-status"]'
    ) as HTMLElement;
    expect(status.textContent).toBe('Cancelled');

    expect((cancelBtn as HTMLButtonElement).disabled).toBe(true);

    // Per Task #183 spec: user-initiated cancels stay silent. The card
    // state change (gray bar + "Cancelled" status, asserted above) is the
    // only feedback — no toast at all. We must NOT show:
    //   * an info toast (would imply this is just a routine notification)
    //   * an error toast (would imply the download "failed")
    //   * the environmental "interrupted — Retry" toast (would mislead the
    //     user into thinking the browser killed their cancel)
    // and we must NOT use the disruptive native alert() UX.
    expect(env.win.alert).not.toHaveBeenCalled();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-info"]')
    ).toBeNull();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-error"]')
    ).toBeNull();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-interrupted"]')
    ).toBeNull();
  });
});
