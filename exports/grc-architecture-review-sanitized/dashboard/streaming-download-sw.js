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
 *          { type: 'register', id, filename, contentType, totalLength, lang,
 *            stream: <ReadableStream> },
 *          [<ReadableStream>, <MessagePort>]
 *        );
 *      The transferred MessagePort receives `{ ok: true }` on success.
 *      `lang` is an optional UI language code ('en' or 'ar') used for any
 *      fallback HTML the SW emits — see the `expired` fetch path below.
 *   2. Page navigates a hidden iframe to `/_stream-download/<id>`.
 *   3. SW intercepts that fetch, looks up the registered stream, and returns
 *      a Response with `Content-Disposition: attachment` so the browser
 *      treats it as a download. The browser pulls bytes through the
 *      transferred ReadableStream — true streaming-to-disk, no Blob in RAM.
 *   4. If the user navigates away or never triggers the download, the
 *      registration self-destructs after REGISTRATION_TTL_MS. A subsequent
 *      hit on `/_stream-download/<id>` returns a small localized HTML page
 *      (in the language captured at registration time) explaining that the
 *      download has expired and asking the user to retry.
 *
 * Same-origin only: the URL pattern is namespaced under `/_stream-download/`
 * and never matches cross-origin requests.
 */
'use strict';

var SW_VERSION = '1.1.0';
var URL_PATTERN = /^\/_stream-download\/([A-Za-z0-9_-]+)$/;
var REGISTRATION_TTL_MS = 60 * 1000;
// How long we remember the language for an expired registration so the
// fallback page can be rendered in the user's language even after the
// pending entry has been cleared.
var EXPIRED_LANG_TTL_MS = 10 * 60 * 1000;

var DEFAULT_LANG = 'en';
var SUPPORTED_LANGS = ['en', 'ar'];

// User-visible strings the SW may emit. Keep this dictionary in sync with
// the matching keys under `downloads.sw_*` in dashboard/i18n/{en,ar}.json.
var SW_STRINGS = {
    en: {
        dir: 'ltr',
        title: 'Download link expired',
        heading: 'This download link has expired',
        body: 'The streaming download could not be started because the link is no longer valid. Please return to the previous page and start the export again.',
        retry_hint: 'You can safely close this tab.'
    },
    ar: {
        dir: 'rtl',
        title: 'انتهت صلاحية رابط التنزيل',
        heading: 'انتهت صلاحية رابط التنزيل',
        body: 'تعذر بدء التنزيل المتدفق لأن الرابط لم يعد صالحًا. يُرجى العودة إلى الصفحة السابقة وبدء التصدير مرة أخرى.',
        retry_hint: 'يمكنك إغلاق هذه التبويبة بأمان.'
    }
};

var pending = new Map();
// id -> { lang, expiresAt } for recently-expired registrations so the
// fallback page can still pick the right language.
var expiredLangs = new Map();
// Last language seen on any register/set-language message — used as the
// best-effort fallback when an unknown id arrives (e.g. after the SW was
// restarted by the browser and lost its in-memory state).
var lastKnownLang = DEFAULT_LANG;

function normalizeLang(value) {
    if (typeof value !== 'string') return null;
    var lang = value.toLowerCase().split('-')[0];
    return SUPPORTED_LANGS.indexOf(lang) !== -1 ? lang : null;
}

function rememberLang(lang) {
    var normalized = normalizeLang(lang);
    if (normalized) lastKnownLang = normalized;
}

function pickLangForId(id) {
    var entry = pending.get(id);
    if (entry && entry.lang) return entry.lang;
    var expired = expiredLangs.get(id);
    if (expired) {
        if (expired.expiresAt > Date.now()) return expired.lang;
        expiredLangs.delete(id);
    }
    return lastKnownLang;
}

function recordExpiredLang(id, lang) {
    var normalized = normalizeLang(lang) || lastKnownLang;
    expiredLangs.set(id, { lang: normalized, expiresAt: Date.now() + EXPIRED_LANG_TTL_MS });
    // Cap the size so a long-lived SW can't accumulate state forever.
    if (expiredLangs.size > 256) {
        var iter = expiredLangs.keys().next();
        if (!iter.done) expiredLangs.delete(iter.value);
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildExpiredPage(lang) {
    var strings = SW_STRINGS[lang] || SW_STRINGS[DEFAULT_LANG];
    var altLang = lang === 'ar' ? 'en' : 'ar';
    var altStrings = SW_STRINGS[altLang] || SW_STRINGS[DEFAULT_LANG];
    return '<!doctype html>\n' +
        '<html lang="' + escapeHtml(lang) + '" dir="' + escapeHtml(strings.dir) + '">\n' +
        '<head>\n' +
        '<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<meta name="robots" content="noindex">\n' +
        '<title>' + escapeHtml(strings.title) + '</title>\n' +
        '<style>\n' +
        'html,body{margin:0;padding:0;background:#f8fafc;color:#1f2937;' +
        "font-family:-IdentityProvider-system,BlinkMacSystemFont,'Segoe UI',Tahoma,Arial,sans-serif;}\n" +
        '.wrap{max-width:32rem;margin:4rem auto;padding:1.5rem 1.75rem;background:#fff;' +
        'border:1px solid #e5e7eb;border-radius:.75rem;box-shadow:0 1px 2px rgba(0,0,0,.04);}\n' +
        'h1{font-size:1.125rem;margin:0 0 .75rem;}\n' +
        'p{font-size:.95rem;line-height:1.55;margin:0 0 .75rem;}\n' +
        '.alt{margin-top:1.25rem;padding-top:1rem;border-top:1px solid #e5e7eb;color:#6b7280;font-size:.85rem;}\n' +
        '</style>\n' +
        '</head>\n' +
        '<body>\n' +
        '<main class="wrap" role="main">\n' +
        '<h1>' + escapeHtml(strings.heading) + '</h1>\n' +
        '<p>' + escapeHtml(strings.body) + '</p>\n' +
        '<p>' + escapeHtml(strings.retry_hint) + '</p>\n' +
        '<div class="alt" lang="' + escapeHtml(altLang) + '" dir="' + escapeHtml(altStrings.dir) + '">\n' +
        '<p>' + escapeHtml(altStrings.body) + '</p>\n' +
        '</div>\n' +
        '</main>\n' +
        '</body>\n' +
        '</html>\n';
}

function expiredResponse(lang) {
    var html = buildExpiredPage(lang);
    return new Response(html, {
        status: 410,
        statusText: 'Gone',
        headers: new Headers({
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Language': lang,
            'X-Content-Type-Options': 'nosniff'
        })
    });
}

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
        var lang = normalizeLang(data.lang) || lastKnownLang;
        rememberLang(lang);
        var entry = {
            stream: data.stream,
            filename: typeof data.filename === 'string' && data.filename ? data.filename : 'export.bin',
            contentType: typeof data.contentType === 'string' && data.contentType
                ? data.contentType
                : 'application/octet-stream',
            totalLength: Number(data.totalLength) > 0 ? Number(data.totalLength) : 0,
            lang: lang,
            timeoutId: null,
        };
        entry.timeoutId = setTimeout(function () {
            var current = pending.get(data.id);
            if (current === entry) {
                pending.delete(data.id);
                recordExpiredLang(data.id, current.lang);
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
            recordExpiredLang(data.id, existing.lang);
            try { existing.stream.cancel('streaming-download cancelled'); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (data.type === 'set-language') {
        rememberLang(data.lang);
        if (event.ports && event.ports[0]) {
            try { event.ports[0].postMessage({ ok: true, lang: lastKnownLang, version: SW_VERSION }); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (data.type === 'ping') {
        if (event.ports && event.ports[0]) {
            try { event.ports[0].postMessage({ pong: true, version: SW_VERSION, lang: lastKnownLang }); } catch (_) { /* ignore */ }
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
    if (!entry) {
        // Registration is missing or has timed out. Respond with a small,
        // localized HTML page so users on Firefox/Safari (where the iframe
        // can become visible if the download never auto-attaches) see a
        // clear explanation in their language instead of a generic 404.
        event.respondWith(expiredResponse(pickLangForId(id)));
        return;
    }

    clearTimeout(entry.timeoutId);
    pending.delete(id);
    recordExpiredLang(id, entry.lang);

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
