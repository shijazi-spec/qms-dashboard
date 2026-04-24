/*
 * Streaming Download Service Worker
 * --------------------------------
 * Companion to dashboard/js/streaming-download.js. Lets browsers without the
 * File System Access API (Firefox, Safari) still stream multi-hundred-MB
 * exports straight to disk instead of buffering them in memory.
 *
 * Protocol
 *   1. Page registers a pending stream:
 *        sw.postMessage(
 *          { type: 'register', id, filename, contentType, totalLength,
 *            stream: <ReadableStream> },
 *          [<ReadableStream>, <MessagePort>]
 *        );
 *      The transferred MessagePort receives `{ ok: true }` on success.
 *   2. Page navigates a hidden iframe to `/_stream-download/<id>`.
 *   3. SW intercepts that fetch, looks up the registered stream, and returns
 *      a Response with `Content-Disposition: attachment` so the browser
 *      treats it as a download. The browser pulls bytes through the
 *      transferred ReadableStream — true streaming-to-disk, no Blob in RAM.
 *   4. If the user navigates away or never triggers the download, the
 *      registration self-destructs after REGISTRATION_TTL_MS.
 *
 * Same-origin only: the URL pattern is namespaced under `/_stream-download/`
 * and never matches cross-origin requests.
 */
'use strict';

var SW_VERSION = '1.0.0';
var URL_PATTERN = /^\/_stream-download\/([A-Za-z0-9_-]+)$/;
var REGISTRATION_TTL_MS = 60 * 1000;

var pending = new Map();

self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'register' && typeof data.id === 'string' && data.stream) {
        var entry = {
            stream: data.stream,
            filename: typeof data.filename === 'string' && data.filename ? data.filename : 'export.bin',
            contentType: typeof data.contentType === 'string' && data.contentType
                ? data.contentType
                : 'application/octet-stream',
            totalLength: Number(data.totalLength) > 0 ? Number(data.totalLength) : 0,
            timeoutId: null,
        };
        entry.timeoutId = setTimeout(function () {
            var current = pending.get(data.id);
            if (current === entry) {
                pending.delete(data.id);
                try { current.stream.cancel('streaming-download abandoned'); } catch (_) { /* ignore */ }
            }
        }, REGISTRATION_TTL_MS);
        pending.set(data.id, entry);
        if (event.ports && event.ports[0]) {
            try { event.ports[0].postMessage({ ok: true, version: SW_VERSION }); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (data.type === 'cancel' && typeof data.id === 'string') {
        var existing = pending.get(data.id);
        if (existing) {
            clearTimeout(existing.timeoutId);
            pending.delete(data.id);
            try { existing.stream.cancel('streaming-download cancelled'); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (data.type === 'ping') {
        if (event.ports && event.ports[0]) {
            try { event.ports[0].postMessage({ pong: true, version: SW_VERSION }); } catch (_) { /* ignore */ }
        }
    }
});

self.addEventListener('fetch', function (event) {
    var url;
    try { url = new URL(event.request.url); } catch (_) { return; }
    if (url.origin !== self.location.origin) return;
    var match = URL_PATTERN.exec(url.pathname);
    if (!match) return;

    var id = match[1];
    var entry = pending.get(id);
    if (!entry) return; // unknown id — let it 404 normally

    clearTimeout(entry.timeoutId);
    pending.delete(id);

    var headers = new Headers({
        'Content-Type': entry.contentType,
        'Content-Disposition': contentDispositionAttachment(entry.filename),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    if (entry.totalLength > 0) {
        headers.set('Content-Length', String(entry.totalLength));
    }

    event.respondWith(new Response(entry.stream, { status: 200, headers: headers }));
});

function contentDispositionAttachment(name) {
    var asciiSafe = String(name)
        .replace(/[\\"\r\n\t]/g, '_')
        .replace(/[^\x20-\x7E]/g, '_');
    var utf8 = encodeURIComponent(name);
    return 'attachment; filename="' + asciiSafe + '"; filename*=UTF-8\'\'' + utf8;
}
