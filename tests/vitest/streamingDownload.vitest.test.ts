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

  it('Cancel button aborts an in-flight slow download, marks the card cancelled, shows an info toast, and never alerts', async () => {
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

    // An info-style toast (not an error toast) confirms the cancellation.
    const infoToast = env.win.document.querySelector(
      '[data-testid="toast-download-info"]'
    );
    expect(infoToast).not.toBeNull();
    expect((infoToast as HTMLElement).textContent || '').toContain('Download cancelled');
    expect((infoToast as HTMLElement).textContent || '').toContain('slow.csv');

    // Cancellation must NOT use the disruptive native alert UX, and must
    // NOT raise an error toast (which would imply the download "failed").
    expect(env.win.alert).not.toHaveBeenCalled();
    expect(
      env.win.document.querySelector('[data-testid="toast-download-error"]')
    ).toBeNull();
  });
});
