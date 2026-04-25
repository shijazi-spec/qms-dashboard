(function (global) {
    'use strict';

    var DEFAULT_STREAM_TO_DISK_THRESHOLD = 10 * 1024 * 1024; // 10 MB

    // When an export's estimated size or row count exceeds either threshold
    // we show an inline confirmation before the download starts, giving users
    // on slow connections or low-disk environments a chance to cancel or
    // tighten their filters first. Set to Infinity to disable entirely.
    var DEFAULT_LARGE_EXPORT_BYTE_THRESHOLD = 50 * 1024 * 1024; // 50 MB
    var DEFAULT_LARGE_EXPORT_ROW_THRESHOLD  = 250000;            // 250 k rows

    // When a streaming download has gotten "far enough", a single accidental
    // click on the Cancel pill could throw away hundreds of MB of work. Past
    // either threshold below we ask the user to confirm before aborting.
    // Both are overridable per-call via options.confirmCancelThresholdPercent
    // / options.confirmCancelThresholdMs (or disabled with confirmCancel: false).
    var DEFAULT_CONFIRM_CANCEL_PERCENT = 50;
    var DEFAULT_CONFIRM_CANCEL_MS = 30 * 1000;
    var CONFIRM_CANCEL_MESSAGE = "Cancel this download? You'll lose progress.";

    function tr(key, defaultText, vars) {
        var i18n = global.WalaPlusI18n;
        if (i18n && typeof i18n.t === 'function') {
            var translated = i18n.t(key, vars);
            var lastSegment = key.split('.').pop();
            // WalaPlusI18n.t falls back to the last key segment when the
            // string is missing — treat that as "not translated" and use the
            // English default below so we never render a bare key fragment.
            if (translated && translated !== lastSegment) {
                return translated;
            }
        }
        var s = String(defaultText);
        if (vars && typeof vars === 'object') {
            Object.keys(vars).forEach(function (k) {
                s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
            });
        }
        return s;
    }

    function parseContentDispositionFilename(header) {
        if (!header) return null;
        var starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
        if (starMatch && starMatch[1]) {
            var v = starMatch[1].trim();
            var enc = '';
            if (/^[^']+''/.test(v)) {
                var idx = v.indexOf("''");
                enc = v.substring(0, idx).toLowerCase();
                v = v.substring(idx + 2);
            }
            v = v.replace(/^['"]|['"]$/g, '');
            try {
                return enc === 'utf-8' ? decodeURIComponent(v) : decodeURIComponent(escape(v));
            } catch (_) {
                return v;
            }
        }
        var match = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
        if (match) {
            return (match[2] || match[3] || '').trim();
        }
        return null;
    }

    function fallbackExtension(contentType) {
        var ct = (contentType || '').toLowerCase();
        if (ct.indexOf('spreadsheetml') !== -1 || ct.indexOf('vnd.ms-excel') !== -1) return 'xlsx';
        if (ct.indexOf('csv') !== -1) return 'csv';
        if (ct.indexOf('pdf') !== -1) return 'pdf';
        if (ct.indexOf('json') !== -1) return 'json';
        if (ct.indexOf('zip') !== -1) return 'zip';
        return 'bin';
    }

    function buildFallbackName(url, contentType) {
        var base = 'export-' + Date.now();
        try {
            var u = new URL(url, window.location.origin);
            var seg = u.pathname.split('/').filter(Boolean).pop() || 'export';
            base = seg.replace(/[^a-zA-Z0-9_.-]/g, '_');
        } catch (_) {}
        if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
        return base + '.' + fallbackExtension(contentType);
    }

    function formatBytes(n) {
        if (!n || n < 0) return '0 B';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    var SPINNER_SVG = '<svg class="w-4 h-4 animate-spin inline-block" fill="none" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
        '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';

    function setBusy(button, label) {
        if (!button) return;
        // If the button is already in a cancelable streaming state, keep the
        // Cancel affordance intact and just refresh the progress label so the
        // user never loses their ability to abort mid-download.
        if (button.getAttribute('data-streaming-active') === '1') {
            var labelEl = button.querySelector('[data-streaming-label]');
            if (labelEl) {
                labelEl.textContent = label;
                return;
            }
        }
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = SPINNER_SVG + '<span class="streaming-ms-2">' + label + '</span>';
    }

    function restoreButton(button, original) {
        if (!button) return;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (original !== undefined && original !== null) {
            button.innerHTML = original;
        }
    }

    // Put a button into a "streaming, cancelable" state: keep it enabled, swap
    // the contents to spinner + progress label + Cancel pill, and install a
    // capture-phase click handler that fires onCancel() instead of any
    // existing click listeners (which would otherwise re-trigger the export).
    function setupCancelableButton(button, onCancel) {
        if (!button) return null;

        button.disabled = false;
        button.setAttribute('aria-busy', 'true');
        button.setAttribute('data-streaming-active', '1');

        var labelEl = button.ownerDocument.createElement('span');
        labelEl.setAttribute('data-streaming-label', '');
        labelEl.className = 'streaming-ms-2';
        labelEl.textContent = 'Preparing…';

        var cancelEl = button.ownerDocument.createElement('span');
        cancelEl.setAttribute('data-streaming-cancel', '');
        cancelEl.className = 'streaming-ms-2 underline decoration-dotted opacity-90';
        cancelEl.textContent = 'Cancel';

        button.innerHTML = SPINNER_SVG;
        button.appendChild(labelEl);
        button.appendChild(cancelEl);

        var handler = function (event) {
            if (button.getAttribute('data-streaming-active') !== '1') return;
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            if (event && typeof event.stopImmediatePropagation === 'function') {
                event.stopImmediatePropagation();
            } else if (event && typeof event.stopPropagation === 'function') {
                event.stopPropagation();
            }
            try { onCancel(); } catch (_) { /* ignore */ }
        };
        button.addEventListener('click', handler, true);

        return {
            updateLabel: function (text) { labelEl.textContent = text; },
            teardown: function () {
                button.removeAttribute('data-streaming-active');
                try { button.removeEventListener('click', handler, true); } catch (_) { /* ignore */ }
            }
        };
    }

    function progressLabel(received, totalLength) {
        var sizeText = formatBytes(received);
        if (totalLength) {
            var pct = Math.min(99, Math.round((received / totalLength) * 100));
            return tr('downloads.downloading_with_progress',
                'Downloading {size} ({pct}%)',
                { size: sizeText, pct: pct });
        }
        return tr('downloads.downloading', 'Downloading {size}', { size: sizeText });
    }

    function supportsFileSystemAccess() {
        return typeof window !== 'undefined' &&
            typeof window.showSaveFilePicker === 'function' &&
            typeof WritableStream !== 'undefined' &&
            typeof TransformStream !== 'undefined';
    }

    // ── Service-worker streaming shim ──────────────────────────────────────
    // For Firefox & Safari (no File System Access API). Uses a same-origin
    // service worker that intercepts /_stream-download/<id> and replies with
    // a transferred ReadableStream as `attachment`. Memory stays flat because
    // the browser pulls bytes from the network through the SW to disk.

    var SW_PATH = '/streaming-download-sw.js';
    var SW_SCOPE = '/';
    var SW_TRIGGER_PREFIX = '/_stream-download/';
    var swReadyPromise = null;
    var transferableStreamSupport = null;

    function canTransferReadableStream() {
        if (transferableStreamSupport !== null) return transferableStreamSupport;
        if (typeof ReadableStream === 'undefined' ||
            typeof MessageChannel === 'undefined') {
            transferableStreamSupport = false;
            return false;
        }
        try {
            var rs = new ReadableStream();
            var ch = new MessageChannel();
            ch.port1.postMessage(rs, [rs]);
            ch.port1.close();
            ch.port2.close();
            transferableStreamSupport = true;
        } catch (_) {
            transferableStreamSupport = false;
        }
        return transferableStreamSupport;
    }

    function supportsServiceWorkerStreaming() {
        if (typeof navigator === 'undefined') return false;
        if (!('serviceWorker' in navigator)) return false;
        if (typeof TransformStream === 'undefined') return false;
        if (typeof ReadableStream === 'undefined') return false;
        if (typeof MessageChannel === 'undefined') return false;
        // SW registration is only allowed in secure contexts (HTTPS or localhost).
        if (typeof window !== 'undefined' && window.isSecureContext === false) return false;
        return canTransferReadableStream();
    }

    function ensureServiceWorker() {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
            return Promise.resolve(null);
        }
        if (swReadyPromise) return swReadyPromise;
        swReadyPromise = (async function () {
            try {
                var wantedURL = new URL(SW_PATH, window.location.origin).href;
                var reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
                var hasMatching = reg && (
                    (reg.active && reg.active.scriptURL === wantedURL) ||
                    (reg.waiting && reg.waiting.scriptURL === wantedURL) ||
                    (reg.installing && reg.installing.scriptURL === wantedURL)
                );
                if (!hasMatching) {
                    reg = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
                }
                if (!reg.active) {
                    await new Promise(function (resolve, reject) {
                        var sw = reg.installing || reg.waiting;
                        if (!sw) return resolve();
                        var onState = function () {
                            if (sw.state === 'activated') {
                                sw.removeEventListener('statechange', onState);
                                resolve();
                            } else if (sw.state === 'redundant') {
                                sw.removeEventListener('statechange', onState);
                                reject(new Error('Streaming-download SW became redundant'));
                            }
                        };
                        sw.addEventListener('statechange', onState);
                    });
                }
                var activeSw = reg.active || (navigator.serviceWorker.controller || null);
                // Best-effort: push the current UI language so the SW's
                // fallback page (rendered when /_stream-download/<id> hits
                // an expired registration) shows up in the right language
                // even when no register has happened yet this session.
                if (activeSw) {
                    try { activeSw.postMessage({ type: 'set-language', lang: currentUiLang() }); }
                    catch (_) { /* ignore */ }
                }
                return activeSw;
            } catch (err) {
                console.warn('[streamingDownload] service-worker registration failed:', err);
                swReadyPromise = null; // allow retry on next call
                return null;
            }
        })();
        return swReadyPromise;
    }

    function generateStreamId() {
        var rand = Math.random().toString(36).slice(2, 10);
        return Date.now().toString(36) + '-' + rand;
    }

    // Resolve the current UI language ('en' | 'ar') so the SW's fallback
    // pages (e.g. "download link expired") render in the user's language.
    // Falls back to <html lang>/navigator/'en' when WalaPlusI18n isn't ready.
    function currentUiLang() {
        try {
            var i18n = global.WalaPlusI18n;
            if (i18n && typeof i18n.currentLang === 'function') {
                var lang = String(i18n.currentLang() || '').toLowerCase().split('-')[0];
                if (lang === 'en' || lang === 'ar') return lang;
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof document !== 'undefined') {
                var htmlLang = String(document.documentElement.lang || '').toLowerCase().split('-')[0];
                if (htmlLang === 'en' || htmlLang === 'ar') return htmlLang;
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof navigator !== 'undefined') {
                var navLang = String(navigator.language || '').toLowerCase().split('-')[0];
                if (navLang === 'en' || navLang === 'ar') return navLang;
            }
        } catch (_) { /* ignore */ }
        return 'en';
    }

    // True streaming path for Firefox / Safari: hand a ReadableStream off to a
    // service worker that returns it as an `attachment` Response. Returns null
    // (without consuming response.body) when the SW path is unavailable so the
    // caller can still fall back to the in-memory Blob path.
    //
    // `swCancelInfo` (when provided) is populated with `{ sw, id }` once the
    // registration is ack'd, so the caller's cancel handler can post a
    // `{ type: 'cancel', id }` message immediately on user abort instead of
    // waiting for pipeTo() to reject.
    async function streamResponseViaServiceWorker(response, filename, contentType, totalLength, button, onProgress, swCancelInfo) {
        if (!supportsServiceWorkerStreaming()) return null;

        var sw = await ensureServiceWorker();
        if (!sw) return null;

        var id = generateStreamId();
        var received = 0;
        var transform;
        try {
            transform = new TransformStream({
                transform: function (chunk, controller) {
                    received += chunk.byteLength || 0;
                    if (button) {
                        setBusy(button, progressLabel(received, totalLength));
                    }
                    if (onProgress) {
                        try { onProgress(received, totalLength); } catch (_) { /* ignore */ }
                    }
                    controller.enqueue(chunk);
                }
            });
        } catch (_) {
            return null;
        }

        // Register with the SW (transfer the readable side). Wait for ack
        // BEFORE we start piping or trigger the iframe — if registration
        // fails we want response.body still intact for the Blob fallback.
        var channel = new MessageChannel();
        var ackPromise = new Promise(function (resolve, reject) {
            var to = setTimeout(function () {
                reject(new Error('Streaming-download SW register ack timeout'));
            }, 5000);
            channel.port1.onmessage = function (ev) {
                clearTimeout(to);
                if (ev.data && ev.data.ok) resolve();
                else reject(new Error('Streaming-download SW register failed'));
            };
        });

        try {
            sw.postMessage({
                type: 'register',
                id: id,
                filename: filename,
                contentType: contentType,
                totalLength: totalLength,
                lang: currentUiLang(),
                stream: transform.readable
            }, [transform.readable, channel.port2]);
        } catch (err) {
            console.warn('[streamingDownload] SW postMessage(stream) failed:', err);
            try { channel.port1.close(); } catch (_) { /* ignore */ }
            return null;
        }

        try {
            await ackPromise;
        } catch (err) {
            console.warn('[streamingDownload] SW register ack failed:', err);
            try { channel.port1.close(); } catch (_) { /* ignore */ }
            // Best-effort: tell the SW to drop the registration.
            try { sw.postMessage({ type: 'cancel', id: id }); } catch (_) { /* ignore */ }
            return null;
        }
        try { channel.port1.close(); } catch (_) { /* ignore */ }

        // Expose the registration to the caller's cancel path so it can fire
        // `{ type: 'cancel', id }` immediately when the user clicks Cancel.
        if (swCancelInfo) {
            swCancelInfo.sw = sw;
            swCancelInfo.id = id;
        }

        // Trigger the download via a hidden iframe. The SW intercepts the
        // navigation and returns a streamed `attachment` response.
        var iframe = document.createElement('iframe');
        iframe.hidden = true;
        iframe.style.display = 'none';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.src = SW_TRIGGER_PREFIX + encodeURIComponent(id);
        document.body.appendChild(iframe);

        try {
            await response.body.pipeTo(transform.writable);
        } catch (err) {
            // The browser/user may have aborted the download; treat that
            // like a normal cancellation rather than a hard failure.
            try { sw.postMessage({ type: 'cancel', id: id }); } catch (_) { /* ignore */ }
            setTimeout(function () { try { iframe.remove(); } catch (_) { /* ignore */ } }, 1000);
            var aborted = new Error((err && err.message) || 'Streaming download cancelled');
            aborted.name = 'AbortError';
            throw aborted;
        }

        // Keep the iframe alive briefly so the browser can finalise the
        // download response, then clean it up.
        setTimeout(function () { try { iframe.remove(); } catch (_) { /* ignore */ } }, 10000);

        return { bytes: received, streamedToDisk: true };
    }

    function pickerTypesFor(filename, contentType) {
        var ext = '';
        var dot = filename.lastIndexOf('.');
        if (dot > -1 && dot < filename.length - 1) {
            ext = filename.substring(dot).toLowerCase();
        }
        if (!ext) return [];
        var mime = (contentType || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
        var accept = {};
        accept[mime] = [ext];
        return [{ description: tr('downloads.export_file', 'Export file'), accept: accept }];
    }

    // --- Progress UI / Toast helpers --------------------------------------

    var PROGRESS_CONTAINER_ID = 'streaming-download-progress-container';
    var TOAST_CONTAINER_ID = 'streaming-download-toast-container';
    var TRAY_CONTAINER_ID = 'streaming-download-history-tray';
    // v1 is the legacy sessionStorage key — kept around so anonymous users
    // (and one-shot tabs whose user identity hasn't been wired up yet) still
    // see the same per-tab tray they got before. Authenticated callers get a
    // per-user localStorage namespace under HISTORY_STORAGE_KEY_PREFIX so
    // the tray survives a tab close / browser restart / fresh login.
    var HISTORY_STORAGE_KEY = 'walaplus.recentDownloads.v1';
    var HISTORY_STORAGE_KEY_PREFIX = 'walaplus.recentDownloads.v2';
    var TRAY_OPEN_STORAGE_KEY = 'walaplus.recentDownloads.trayOpen';
    var TRAY_LAST_SEEN_STORAGE_KEY = 'walaplus.recentDownloads.lastSeen.v1';
    var HISTORY_LIMIT = 5;
    // Default expiry window for stored entries (30 days). Override on the
    // host page with `window.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS = …`.
    var HISTORY_DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    var cardCounter = 0;
    var trayHydrated = false;
    // null = no signed-in identity wired up yet → behave like before (per-tab
    // sessionStorage). A non-empty string switches the tray over to
    // per-user localStorage so the list persists across browser sessions.
    var currentHistoryUserKey = null;
    var crossTabListenerInstalled = false;

    // --- Server-sync for recent-downloads (cross-device) -------------------
    // When a user is signed in (setHistoryUser was called with a non-empty id),
    // history changes are mirrored to /api/exports/recent-downloads so the tray
    // stays consistent across every device where the user is logged in.
    // All calls are fire-and-forget; network errors are silently ignored so
    // they never block or disrupt the in-browser download experience.
    var RECENT_DOWNLOADS_API = '/api/exports/recent-downloads';

    function isServerSyncEnabled() {
        if (typeof global.STREAMING_DOWNLOAD_SERVER_SYNC === 'boolean') {
            return global.STREAMING_DOWNLOAD_SERVER_SYNC;
        }
        return true;
    }

    function pushToServer(entries) {
        if (!currentHistoryUserKey || !isServerSyncEnabled()) return;
        try {
            fetch(RECENT_DOWNLOADS_API, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: entries }),
            }).catch(function () { /* ignore network errors */ });
        } catch (_) { /* ignore */ }
    }

    function clearOnServer() {
        if (!currentHistoryUserKey || !isServerSyncEnabled()) return;
        try {
            fetch(RECENT_DOWNLOADS_API, {
                method: 'DELETE',
                credentials: 'same-origin',
            }).catch(function () { /* ignore network errors */ });
        } catch (_) { /* ignore */ }
    }

    // Fetch server-side entries and merge them into local storage, then push
    // the merged result back so both sides stay in sync. Called once per
    // setHistoryUser() invocation, i.e. on login / page load with a known user.
    function fetchAndMergeFromServer() {
        if (!currentHistoryUserKey || !isServerSyncEnabled()) return;
        try {
            fetch(RECENT_DOWNLOADS_API, {
                method: 'GET',
                credentials: 'same-origin',
            }).then(function (res) {
                if (!res.ok) return null;
                return res.json();
            }).then(function (data) {
                if (!data || !Array.isArray(data.entries) || !data.entries.length) return;
                var serverEntries = data.entries;
                var local = loadHistory();
                var seen = Object.create(null);
                local.forEach(function (e) { if (e && e.id) seen[e.id] = true; });
                var merged = local.slice();
                serverEntries.forEach(function (e) {
                    if (e && e.id && !seen[e.id]) {
                        merged.push(e);
                        seen[e.id] = true;
                    }
                });
                merged.sort(function (a, b) {
                    var aT = Date.parse((a && (a.startedAt || a.finishedAt)) || '') || 0;
                    var bT = Date.parse((b && (b.startedAt || b.finishedAt)) || '') || 0;
                    return bT - aT;
                });
                var pruned = pruneEntries(merged).slice(0, HISTORY_LIMIT);
                if (pruned.length > local.length) {
                    saveHistory(pruned);
                    pushToServer(pruned);
                    try { renderHistoryTray(); } catch (_) { /* ignore */ }
                }
            }).catch(function () { /* ignore network errors */ });
        } catch (_) { /* ignore */ }
    }

    function ensureProgressContainer() {
        if (typeof document === 'undefined' || !document.body) return null;
        var c = document.getElementById(PROGRESS_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = PROGRESS_CONTAINER_ID;
        c.className = 'fixed bottom-4 streaming-edge-end z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]';
        c.setAttribute('aria-live', 'polite');
        c.setAttribute('aria-label', tr('downloads.in_progress_aria', 'Downloads in progress'));
        document.body.appendChild(c);
        return c;
    }

    function ensureToastContainer() {
        if (typeof document === 'undefined' || !document.body) return null;
        var c = document.getElementById(TOAST_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = TOAST_CONTAINER_ID;
        c.className = 'fixed top-4 streaming-edge-end z-50 flex flex-col gap-2 max-w-sm';
        c.setAttribute('aria-live', 'polite');
        document.body.appendChild(c);
        return c;
    }

    function createProgressCard(filename, onCancel) {
        var container = ensureProgressContainer();
        if (!container) return null;
        cardCounter += 1;
        var idx = cardCounter;

        var card = document.createElement('div');
        card.id = 'streaming-download-card-' + idx;
        card.className = 'bg-white shadow-lg rounded-lg border border-gray-200 p-3 text-sm text-gray-800';
        card.setAttribute('role', 'group');
        card.setAttribute('data-testid', 'card-download-progress');

        var header = document.createElement('div');
        header.className = 'flex items-center justify-between gap-2 mb-2';

        var nameWrap = document.createElement('div');
        nameWrap.className = 'flex items-center gap-2 min-w-0 flex-1';

        var spinner = document.createElement('span');
        spinner.innerHTML = '<svg class="w-4 h-4 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">' +
            '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
            '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
        spinner.className = 'flex-shrink-0';
        nameWrap.appendChild(spinner);

        var defaultLabel = tr('downloads.download', 'Download');
        var defaultFile = tr('downloads.default_file', 'file');

        var nameText = document.createElement('span');
        nameText.className = 'font-medium truncate';
        nameText.textContent = filename || defaultLabel;
        nameText.title = filename || defaultLabel;
        nameText.setAttribute('dir', 'auto');
        nameText.setAttribute('data-testid', 'text-download-filename');
        nameWrap.appendChild(nameText);

        header.appendChild(nameWrap);

        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'text-xs font-medium text-red-600 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 rounded px-2 py-1 flex-shrink-0';
        cancelBtn.textContent = tr('downloads.cancel', 'Cancel');
        cancelBtn.setAttribute('aria-label', tr('downloads.cancel_aria',
            'Cancel download of {filename}', { filename: filename || defaultFile }));
        cancelBtn.setAttribute('data-testid', 'button-cancel-download');
        cancelBtn.addEventListener('click', function () {
            // The owner's onCancel may pop a confirm() and return false if
            // the user backs out. In that case keep the Cancel button live
            // so they can try again instead of getting stuck on "Cancelling…".
            var triggered;
            try {
                if (typeof onCancel === 'function') triggered = onCancel();
            } catch (_) { triggered = undefined; }
            if (triggered === false) return;
            cancelBtn.disabled = true;
            cancelBtn.textContent = tr('downloads.cancelling', 'Cancelling…');
        });
        header.appendChild(cancelBtn);

        card.appendChild(header);

        var barWrap = document.createElement('div');
        barWrap.className = 'h-2 bg-gray-200 rounded overflow-hidden';
        barWrap.setAttribute('role', 'progressbar');
        barWrap.setAttribute('aria-valuemin', '0');
        barWrap.setAttribute('aria-valuemax', '100');
        barWrap.setAttribute('aria-label', tr('downloads.progress_aria',
            'Download progress for {filename}', { filename: filename || defaultFile }));
        var bar = document.createElement('div');
        bar.className = 'h-full bg-blue-600 transition-all duration-150';
        bar.style.width = '0%';
        bar.setAttribute('data-testid', 'progress-download-bar');
        barWrap.appendChild(bar);
        card.appendChild(barWrap);

        var statusEl = document.createElement('div');
        statusEl.className = 'mt-1 text-xs text-gray-500 truncate';
        statusEl.setAttribute('data-testid', 'text-download-status');
        statusEl.textContent = tr('downloads.preparing', 'Preparing…');
        card.appendChild(statusEl);

        container.appendChild(card);

        function setLabel(name) {
            nameText.textContent = name;
            nameText.title = name;
            barWrap.setAttribute('aria-label', tr('downloads.progress_aria',
                'Download progress for {filename}', { filename: name }));
            cancelBtn.setAttribute('aria-label', tr('downloads.cancel_aria',
                'Cancel download of {filename}', { filename: name }));
        }

        function update(received, total) {
            var sizeText = formatBytes(received);
            if (total) {
                var pct = Math.min(100, Math.round((received / total) * 100));
                bar.style.width = pct + '%';
                barWrap.setAttribute('aria-valuenow', String(pct));
                statusEl.textContent = tr('downloads.status_with_total',
                    '{received} / {total} ({pct}%)',
                    { received: sizeText, total: formatBytes(total), pct: pct });
            } else {
                // Indeterminate — approach 95% asymptotically as more bytes arrive.
                var visualPct = Math.min(95, Math.round((received / (received + 2 * 1024 * 1024)) * 100));
                bar.style.width = visualPct + '%';
                barWrap.removeAttribute('aria-valuenow');
                statusEl.textContent = tr('downloads.status_indeterminate',
                    '{size} downloaded', { size: sizeText });
            }
        }

        function disableCancel() {
            cancelBtn.disabled = true;
            cancelBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }

        function hideCancel() {
            cancelBtn.style.display = 'none';
        }

        function setStatus(text) {
            statusEl.textContent = text;
        }

        function setBarColor(twClass) {
            bar.className = 'h-full ' + twClass + ' transition-all duration-150';
        }

        function remove(delayMs) {
            setTimeout(function () {
                if (card.parentNode) card.parentNode.removeChild(card);
            }, delayMs || 0);
        }

        // Surface a "Resume / Cancel" prompt after a recoverable interruption.
        // Replaces the cancel button area with two buttons; resolves the
        // returned promise with `true` when the user clicks Resume and
        // `false` when they click Cancel (or dismiss the card).
        //
        // `reason` (optional) is appended to the status line so the user can
        // tell *why* a previous Resume attempt failed (e.g. when the network
        // is still down after the auto-retries exhausted) instead of just
        // seeing the same generic "Interrupted at X" copy on every loop.
        var resumeRow = null;
        function setResumePrompt(received, total, reason) {
            return new Promise(function (resolve) {
                if (resumeRow && resumeRow.parentNode) {
                    resumeRow.parentNode.removeChild(resumeRow);
                    resumeRow = null;
                }
                // Replace the spinner header state with an "interrupted" look.
                spinner.innerHTML = '<svg class="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" ' +
                    'stroke="currentColor" aria-hidden="true">' +
                    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
                    'd="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 ' +
                    '3.86a2 2 0 00-3.42 0z"/></svg>';
                bar.className = 'h-full bg-amber-500 transition-all duration-150';
                var sizeText = formatBytes(received);
                var baseLine = total
                    ? 'Interrupted at ' + sizeText + ' / ' + formatBytes(total) +
                      ' — click Resume to continue from where it stopped.'
                    : 'Interrupted at ' + sizeText + ' — click Resume to continue.';
                if (reason) {
                    baseLine += ' (' + reason + ')';
                }
                statusEl.textContent = baseLine;
                statusEl.setAttribute('data-resume-reason', reason ? String(reason) : '');

                // Hide the existing cancel button while we own the prompt.
                cancelBtn.style.display = 'none';

                resumeRow = document.createElement('div');
                resumeRow.className = 'mt-2 flex items-center gap-2';
                resumeRow.setAttribute('data-testid', 'row-download-resume-prompt');

                var resumeBtn = document.createElement('button');
                resumeBtn.type = 'button';
                resumeBtn.className = 'text-xs font-medium px-2 py-1 rounded ' +
                    'bg-blue-600 text-white hover:bg-blue-700 ' +
                    'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1';
                resumeBtn.textContent = 'Resume';
                resumeBtn.setAttribute('aria-label', 'Resume download from ' + sizeText);
                resumeBtn.setAttribute('data-testid', 'button-resume-download');

                var giveUpBtn = document.createElement('button');
                giveUpBtn.type = 'button';
                giveUpBtn.className = 'text-xs font-medium text-red-600 hover:text-red-800 hover:underline ' +
                    'focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 rounded px-2 py-1';
                giveUpBtn.textContent = 'Cancel';
                giveUpBtn.setAttribute('aria-label', 'Discard interrupted download');
                giveUpBtn.setAttribute('data-testid', 'button-discard-download');

                var settled = false;
                function pick(value) {
                    if (settled) return;
                    settled = true;
                    resumeBtn.disabled = true;
                    giveUpBtn.disabled = true;
                    resolve(value);
                }
                resumeBtn.addEventListener('click', function () {
                    resumeBtn.textContent = 'Resuming…';
                    pick(true);
                });
                giveUpBtn.addEventListener('click', function () {
                    pick(false);
                });

                resumeRow.appendChild(resumeBtn);
                resumeRow.appendChild(giveUpBtn);
                card.appendChild(resumeRow);
            });
        }

        // Restore the card to its normal "in-progress" appearance after a
        // resume prompt — used when the user clicks Resume so the new pipe
        // attempt looks identical to the first one.
        function clearResumePrompt() {
            if (resumeRow && resumeRow.parentNode) {
                resumeRow.parentNode.removeChild(resumeRow);
                resumeRow = null;
            }
            spinner.innerHTML = '<svg class="w-4 h-4 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">' +
                '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
                '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
            bar.className = 'h-full bg-blue-600 transition-all duration-150';
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancel';
            statusEl.removeAttribute('data-retry-attempt');
            statusEl.removeAttribute('data-retry-max');
            statusEl.removeAttribute('data-resume-reason');
        }

        // Render a "Retrying download (attempt X of N)…" status while the
        // resume loop is auto-retrying the Range fetch. Keeps the Cancel
        // affordance live so the user can give up during the backoff wait,
        // and writes the attempt counter onto data-* attributes so tests
        // (and screen-reader hooks) can observe progress without scraping
        // copy. `info.retryingIn` (ms) renders a "waiting Ns" suffix while
        // we're sleeping between attempts.
        function setRetryStatus(info) {
            info = info || {};
            var attempt = info.attempt || 1;
            var maxAttempts = info.maxAttempts || attempt;
            var reason = info.reason || '';
            var retryingIn = info.retryingIn || 0;

            spinner.innerHTML = '<svg class="w-4 h-4 text-amber-600 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">' +
                '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
                '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
            bar.className = 'h-full bg-amber-500 transition-all duration-150';
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancel';

            var text = 'Retrying download (attempt ' + attempt + ' of ' + maxAttempts + ')';
            if (retryingIn && retryingIn > 0) {
                text += ' — waiting ' + Math.max(1, Math.ceil(retryingIn / 1000)) + 's';
            } else {
                text += '…';
            }
            if (reason) text += ' — ' + reason;
            statusEl.textContent = text;
            statusEl.setAttribute('data-retry-attempt', String(attempt));
            statusEl.setAttribute('data-retry-max', String(maxAttempts));
            if (reason) {
                statusEl.setAttribute('data-resume-reason', String(reason));
            } else {
                statusEl.removeAttribute('data-resume-reason');
            }
        }

        return {
            el: card,
            setLabel: setLabel,
            update: update,
            setStatus: setStatus,
            disableCancel: disableCancel,
            hideCancel: hideCancel,
            setBarColor: setBarColor,
            setResumePrompt: setResumePrompt,
            clearResumePrompt: clearResumePrompt,
            setRetryStatus: setRetryStatus,
            remove: remove
        };
    }

    function showToast(message, type, opts) {
        var container = ensureToastContainer();
        if (!container) return;
        var palette;
        switch (type) {
            case 'error':
                palette = 'bg-red-600 text-white';
                break;
            case 'warn':
                palette = 'bg-amber-600 text-white';
                break;
            case 'info':
                palette = 'bg-blue-600 text-white';
                break;
            default:
                palette = 'bg-green-600 text-white';
        }
        var toast = document.createElement('div');
        toast.className = 'shadow-lg rounded-lg px-4 py-3 text-sm flex items-start gap-3 ' + palette;
        toast.setAttribute('role', type === 'error' || type === 'warn' ? 'alert' : 'status');
        var testId = (opts && opts.testId) || ('toast-download-' + (type || 'success'));
        toast.setAttribute('data-testid', testId);

        var msg = document.createElement('span');
        msg.className = 'flex-1 break-words';
        msg.textContent = message;
        msg.setAttribute('dir', 'auto');
        toast.appendChild(msg);

        var dismissed = false;
        function dismiss() {
            if (dismissed) return;
            dismissed = true;
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }

        // Optional inline action button (e.g. "Retry"). Rendered before the
        // dismiss "×" so screen readers announce the call-to-action first.
        if (opts && opts.action && typeof opts.action.onClick === 'function') {
            var actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'underline font-medium text-white/95 hover:text-white ' +
                'focus:outline-none focus:ring-2 focus:ring-white/60 rounded px-2 py-1 flex-shrink-0';
            actionBtn.textContent = opts.action.label || 'Retry';
            actionBtn.setAttribute('data-testid', (opts.action.testId || 'button-toast-action'));
            actionBtn.addEventListener('click', function () {
                try { opts.action.onClick(); } catch (_) { /* ignore */ }
                dismiss();
            });
            toast.appendChild(actionBtn);
        }

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'text-white/80 hover:text-white text-lg leading-none focus:outline-none focus:ring-2 focus:ring-white/60 rounded';
        close.innerHTML = '&times;';
        close.setAttribute('aria-label', tr('downloads.dismiss_notification', 'Dismiss notification'));
        close.setAttribute('data-testid', 'button-dismiss-toast');
        close.addEventListener('click', dismiss);
        toast.appendChild(close);

        container.appendChild(toast);
        var defaultMs = (type === 'error' || type === 'warn') ? 6000 : 4000;
        var ms = (opts && typeof opts.autoDismissMs === 'number') ? opts.autoDismissMs : defaultMs;
        if (ms > 0) setTimeout(dismiss, ms);
    }

    // --- Recent downloads history & tray ---------------------------------
    //
    // Tracks the last N download attempts so the tray persists across page
    // navigations. Storage location depends on identity:
    //   • Anonymous (no user wired up): sessionStorage under
    //     HISTORY_STORAGE_KEY — per-tab list, wiped when the tab closes.
    //     Matches the legacy behaviour for unauthenticated/unknown callers.
    //   • Signed-in (setHistoryUser was called): localStorage under
    //     `${HISTORY_STORAGE_KEY_PREFIX}.u-${userKey}` — survives tab close,
    //     browser restart, and re-login so users can resume long-running
    //     exports the next day. Entries are pruned by HISTORY_LIMIT and by
    //     HISTORY_DEFAULT_MAX_AGE_MS (configurable via
    //     window.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS).
    //
    // Each entry records the URL, filename, status, byte count, error
    // message, and a sanitised fetch init so failed/cancelled entries can
    // be re-issued via a Retry button (works after a fresh login).

    function safeSessionStorage() {
        try {
            if (typeof window === 'undefined') return null;
            return window.sessionStorage || null;
        } catch (_) { return null; }
    }

    function safeLocalStorage() {
        try {
            if (typeof window === 'undefined') return null;
            return window.localStorage || null;
        } catch (_) { return null; }
    }

    function historyStorage() {
        if (currentHistoryUserKey) {
            return safeLocalStorage() || safeSessionStorage();
        }
        return safeSessionStorage();
    }

    function historyKey() {
        if (currentHistoryUserKey) {
            return HISTORY_STORAGE_KEY_PREFIX + '.u-' + currentHistoryUserKey;
        }
        return HISTORY_STORAGE_KEY;
    }

    function historyMaxAgeMs() {
        var override = global.STREAMING_DOWNLOAD_HISTORY_MAX_AGE_MS;
        if (typeof override === 'number' && override >= 0) return override;
        return HISTORY_DEFAULT_MAX_AGE_MS;
    }

    function pruneEntries(arr) {
        if (!Array.isArray(arr)) return [];
        var maxAge = historyMaxAgeMs();
        var cutoff = (maxAge && maxAge > 0) ? (Date.now() - maxAge) : 0;
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e) continue;
            // Drop entries older than the configured window. Keep entries
            // missing both timestamps (defensive — should not happen).
            if (cutoff > 0) {
                var ts = Date.parse(e.finishedAt || e.startedAt || '');
                if (Number.isFinite(ts) && ts < cutoff) continue;
            }
            out.push(e);
        }
        return out;
    }

    function loadHistoryFrom(store, key) {
        if (!store) return [];
        try {
            var raw = store.getItem(key);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr;
        } catch (_) { return []; }
    }

    function loadHistory() {
        return pruneEntries(loadHistoryFrom(historyStorage(), historyKey()));
    }

    function saveHistory(arr) {
        var store = historyStorage();
        if (!store) return;
        try {
            var pruned = pruneEntries(arr).slice(0, HISTORY_LIMIT);
            store.setItem(historyKey(), JSON.stringify(pruned));
        } catch (_) { /* quota/etc — ignore */ }
    }

    function loadTrayOpen() {
        var store = safeSessionStorage();
        if (!store) return false;
        try { return store.getItem(TRAY_OPEN_STORAGE_KEY) === '1'; }
        catch (_) { return false; }
    }

    function saveTrayOpen(open) {
        var store = safeSessionStorage();
        if (!store) return;
        try { store.setItem(TRAY_OPEN_STORAGE_KEY, open ? '1' : '0'); }
        catch (_) { /* ignore */ }
    }

    // Re-render whenever another tab in the same browser writes to the
    // active per-user history key. Lets the tray stay in sync when, e.g.,
    // a user kicks off an export in a second tab.
    function ensureCrossTabListener() {
        if (crossTabListenerInstalled) return;
        if (typeof window === 'undefined' || !window.addEventListener) return;
        crossTabListenerInstalled = true;
        try {
            window.addEventListener('storage', function (ev) {
                if (!ev) return;
                if (ev.key === null || ev.key === historyKey()) {
                    try { renderHistoryTray(); } catch (_) { /* ignore */ }
                }
            });
        } catch (_) { /* ignore — best effort */ }
    }

    // Promote anonymous (sessionStorage) and any leftover v1 entries into
    // the now-known user's localStorage namespace, then drop the legacy
    // copies so two stores can't drift apart.
    function migrateAnonymousHistoryToUser() {
        if (!currentHistoryUserKey) return;
        var loc = safeLocalStorage();
        if (!loc) return;
        var sess = safeSessionStorage();
        var userKey = HISTORY_STORAGE_KEY_PREFIX + '.u-' + currentHistoryUserKey;
        var existing = loadHistoryFrom(loc, userKey);
        var sessAnon = sess ? loadHistoryFrom(sess, HISTORY_STORAGE_KEY) : [];
        var localLegacy = loadHistoryFrom(loc, HISTORY_STORAGE_KEY);
        if (!sessAnon.length && !localLegacy.length) return;
        var seen = Object.create(null);
        existing.forEach(function (e) { if (e && e.id) seen[e.id] = true; });
        var merged = existing.slice();
        sessAnon.concat(localLegacy).forEach(function (e) {
            if (e && e.id && !seen[e.id]) {
                merged.push(e);
                seen[e.id] = true;
            }
        });
        merged.sort(function (a, b) {
            var aT = Date.parse((a && (a.startedAt || a.finishedAt)) || '') || 0;
            var bT = Date.parse((b && (b.startedAt || b.finishedAt)) || '') || 0;
            return bT - aT;
        });
        try {
            var pruned = pruneEntries(merged).slice(0, HISTORY_LIMIT);
            loc.setItem(userKey, JSON.stringify(pruned));
        } catch (_) { /* ignore */ }
        try { if (sess) sess.removeItem(HISTORY_STORAGE_KEY); } catch (_) { /* ignore */ }
        try { loc.removeItem(HISTORY_STORAGE_KEY); } catch (_) { /* ignore */ }
    }

    // Public hook called by navigation.js (or any caller that knows who is
    // signed in) to switch the tray over to a per-user localStorage
    // namespace. Pass null/undefined/'' to revert to the anonymous tab-only
    // behaviour (e.g. on logout).
    function setHistoryUser(userId) {
        var key = (userId === null || userId === undefined || userId === '')
            ? null
            : String(userId);
        if (key === currentHistoryUserKey) return;
        currentHistoryUserKey = key;
        if (key) {
            try { migrateAnonymousHistoryToUser(); } catch (_) { /* ignore */ }
            try { ensureCrossTabListener(); } catch (_) { /* ignore */ }
            try { fetchAndMergeFromServer(); } catch (_) { /* ignore */ }
        }
        try { reconcileHistoryOnLoad(); } catch (_) { /* ignore */ }
        try { renderHistoryTray(); } catch (_) { /* ignore */ }
    }

    // Snapshot of `{ entryId: status }` taken whenever the user opens the
    // tray. Used to compute the unread-changes badge so the collapsed header
    // can flag attempts that finished (or flipped state) since the user last
    // looked. We only store final statuses we've actually shown to the user.
    function loadLastSeen() {
        var store = safeSessionStorage();
        if (!store) return {};
        try {
            var raw = store.getItem(TRAY_LAST_SEEN_STORAGE_KEY);
            if (!raw) return {};
            var obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (_) { return {}; }
    }

    function saveLastSeen(map) {
        var store = safeSessionStorage();
        if (!store) return;
        try { store.setItem(TRAY_LAST_SEEN_STORAGE_KEY, JSON.stringify(map || {})); }
        catch (_) { /* ignore */ }
    }

    // Build a fresh snapshot scoped to the current set of entry ids so stale
    // ids (already evicted past HISTORY_LIMIT) don't accumulate forever.
    function snapshotSeenStatuses(entries) {
        var map = {};
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || !e.id) continue;
            map[e.id] = e.status || '';
        }
        return map;
    }

    // An entry counts as "unread" if it has reached a final state (done /
    // failed / cancelled) AND its current status differs from what was
    // recorded the last time the user opened the tray. New entries that have
    // never been seen also count as unread once they finish. Entries still
    // in progress are never counted — they're advertised separately via the
    // "X in progress" subtext.
    function computeUnreadCount(entries, lastSeen) {
        if (!entries || !entries.length) return 0;
        var seen = lastSeen || {};
        var count = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || !e.id) continue;
            if (e.status === 'in-progress') continue;
            var prev = Object.prototype.hasOwnProperty.call(seen, e.id) ? seen[e.id] : null;
            if (prev !== e.status) count++;
        }
        return count;
    }

    function makeHistoryId() {
        return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    // Keep only JSON-serialisable, retry-safe parts of the original fetchInit.
    // Strips AbortSignals, Headers/FormData/Blob bodies, etc.
    function sanitizeFetchInit(init) {
        if (!init || typeof init !== 'object') return null;
        var out = {};
        if (typeof init.method === 'string') out.method = init.method;
        if (typeof init.credentials === 'string') out.credentials = init.credentials;
        if (typeof init.cache === 'string') out.cache = init.cache;
        if (typeof init.mode === 'string') out.mode = init.mode;
        if (typeof init.redirect === 'string') out.redirect = init.redirect;
        if (typeof init.referrerPolicy === 'string') out.referrerPolicy = init.referrerPolicy;
        if (init.headers && typeof init.headers === 'object' &&
            !(typeof Headers !== 'undefined' && init.headers instanceof Headers)) {
            try {
                var hdrs = {};
                Object.keys(init.headers).forEach(function (k) {
                    var v = init.headers[k];
                    if (typeof v === 'string') hdrs[k] = v;
                });
                if (Object.keys(hdrs).length) out.headers = hdrs;
            } catch (_) { /* ignore */ }
        }
        if (typeof init.body === 'string') out.body = init.body;
        return Object.keys(out).length ? out : null;
    }

    // On script load, mark any "in-progress" entries as cancelled — they were
    // interrupted by a navigation/reload and can never resolve. This also
    // keeps the tray honest when the user lands on a new page.
    function reconcileHistoryOnLoad() {
        var arr = loadHistory();
        var changed = false;
        var nowIso = new Date().toISOString();
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].status === 'in-progress') {
                arr[i].status = 'cancelled';
                arr[i].error = arr[i].error || 'Interrupted by navigation';
                arr[i].finishedAt = nowIso;
                changed = true;
            }
        }
        if (changed) saveHistory(arr);
    }

    function recordHistoryEntry(entry) {
        var arr = loadHistory();
        arr.unshift(entry);
        if (arr.length > HISTORY_LIMIT) arr = arr.slice(0, HISTORY_LIMIT);
        saveHistory(arr);
        pushToServer(arr);
        renderHistoryTray();
        return entry;
    }

    function updateHistoryEntry(id, patch) {
        if (!id) return;
        var arr = loadHistory();
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].id === id) {
                arr[i] = Object.assign({}, arr[i], patch);
                saveHistory(arr);
                pushToServer(arr);
                renderHistoryTray();
                return;
            }
        }
    }

    function clearHistory() {
        saveHistory([]);
        clearOnServer();
        // Drop the unread snapshot too so a fresh download after clearing
        // doesn't reference stale ids and can light up the badge correctly.
        saveLastSeen({});
        renderHistoryTray();
    }

    function timeAgoShort(iso) {
        if (!iso) return '';
        var then = Date.parse(iso);
        if (!Number.isFinite(then)) return '';
        var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
        if (secs < 60) return 'just now';
        var mins = Math.round(secs / 60);
        if (mins < 60) return mins + 'm ago';
        var hrs = Math.round(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        var days = Math.round(hrs / 24);
        return days + 'd ago';
    }

    function statusMeta(status) {
        switch (status) {
            case 'in-progress':
                return { label: 'In progress', dot: 'bg-blue-500', text: 'text-blue-700' };
            case 'done':
                return { label: 'Done', dot: 'bg-green-500', text: 'text-green-700' };
            case 'failed':
                return { label: 'Failed', dot: 'bg-red-500', text: 'text-red-700' };
            case 'cancelled':
                return { label: 'Cancelled', dot: 'bg-gray-400', text: 'text-gray-600' };
            default:
                return { label: status || 'Unknown', dot: 'bg-gray-400', text: 'text-gray-600' };
        }
    }

    function ensureTrayContainer() {
        if (typeof document === 'undefined' || !document.body) return null;
        var c = document.getElementById(TRAY_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = TRAY_CONTAINER_ID;
        c.className = 'fixed bottom-4 left-4 z-50 w-80 max-w-[calc(100vw-2rem)]';
        c.setAttribute('aria-label', 'Recent downloads');
        c.setAttribute('data-testid', 'tray-recent-downloads');
        document.body.appendChild(c);
        return c;
    }

    function renderHistoryTray() {
        if (typeof document === 'undefined' || !document.body) return;
        var entries = loadHistory();
        var container = document.getElementById(TRAY_CONTAINER_ID);

        // No history yet → don't clutter the page.
        if (!entries.length) {
            if (container && container.parentNode) container.parentNode.removeChild(container);
            return;
        }
        container = ensureTrayContainer();
        if (!container) return;

        var open = loadTrayOpen();

        var inProgress = 0;
        var failed = 0;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].status === 'in-progress') inProgress++;
            else if (entries[i].status === 'failed' || entries[i].status === 'cancelled') failed++;
        }

        // Compute unread changes vs. last-seen snapshot, then refresh the
        // snapshot when the tray is open so the badge clears as soon as the
        // user expands the tray (and stays cleared while it remains open).
        var lastSeen = loadLastSeen();
        var unreadCount = open ? 0 : computeUnreadCount(entries, lastSeen);
        if (open) {
            saveLastSeen(snapshotSeenStatuses(entries));
        }

        var headerLabel = 'Recent downloads (' + entries.length + ')';
        var headerSub = '';
        if (inProgress > 0) {
            headerSub = inProgress + ' in progress';
        } else if (failed > 0 && unreadCount === 0) {
            // When the unread badge is showing it already covers the
            // "needs retry" cue (failures bump the unread count too), so
            // suppress the duplicate subtext to avoid two competing signals.
            headerSub = failed + ' need retry';
        }

        // Build header.
        container.innerHTML = '';
        var card = document.createElement('div');
        card.className = 'bg-white shadow-lg rounded-lg border border-gray-200 overflow-hidden text-sm text-gray-800';
        container.appendChild(card);

        var headerBtn = document.createElement('button');
        headerBtn.type = 'button';
        headerBtn.className = 'w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-inset';
        headerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        headerBtn.setAttribute('aria-controls', TRAY_CONTAINER_ID + '-body');
        headerBtn.setAttribute('data-testid', 'button-recent-downloads-toggle');

        var hLeft = document.createElement('span');
        hLeft.className = 'flex items-center gap-2 min-w-0 relative';
        var iconWrap = document.createElement('span');
        iconWrap.className = 'relative flex-shrink-0';
        iconWrap.innerHTML = '<svg class="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"/></svg>';
        // Render the unread badge as a small pill anchored to the icon. It
        // shows a count when small, or "9+" beyond that, and is fully
        // suppressed once unreadCount drops to zero (i.e. tray was opened).
        if (unreadCount > 0) {
            var badge = document.createElement('span');
            badge.className = 'absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] leading-4 font-semibold text-center shadow ring-1 ring-white';
            badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
            badge.setAttribute('data-testid', 'badge-recent-downloads-unread');
            badge.setAttribute(
                'aria-label',
                unreadCount === 1
                    ? '1 new download update'
                    : unreadCount + ' new download updates'
            );
            iconWrap.appendChild(badge);
        }
        hLeft.appendChild(iconWrap);
        var hLabel = document.createElement('span');
        hLabel.className = 'font-medium truncate';
        hLabel.textContent = headerLabel;
        hLeft.appendChild(hLabel);
        headerBtn.appendChild(hLeft);

        var hRight = document.createElement('span');
        hRight.className = 'flex items-center gap-2 flex-shrink-0';
        if (headerSub) {
            var sub = document.createElement('span');
            sub.className = 'text-xs ' + (inProgress > 0 ? 'text-blue-600' : 'text-amber-600');
            sub.textContent = headerSub;
            sub.setAttribute('data-testid', 'text-recent-downloads-summary');
            hRight.appendChild(sub);
        }
        var chev = document.createElement('span');
        chev.className = 'text-gray-400';
        chev.innerHTML = open
            ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 15l-7-7-7 7"/></svg>'
            : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 9l7 7 7-7"/></svg>';
        hRight.appendChild(chev);
        headerBtn.appendChild(hRight);

        headerBtn.addEventListener('click', function () {
            saveTrayOpen(!loadTrayOpen());
            renderHistoryTray();
        });
        card.appendChild(headerBtn);

        if (!open) return;

        var body = document.createElement('div');
        body.id = TRAY_CONTAINER_ID + '-body';
        body.className = 'border-t border-gray-100 max-h-80 overflow-y-auto';
        body.setAttribute('role', 'list');
        card.appendChild(body);

        entries.forEach(function (entry) {
            var row = document.createElement('div');
            row.className = 'flex items-start gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0';
            row.setAttribute('role', 'listitem');
            row.setAttribute('data-testid', 'row-recent-download-' + entry.id);

            var meta = statusMeta(entry.status);
            var dot = document.createElement('span');
            dot.className = 'mt-1.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ' + meta.dot;
            dot.setAttribute('aria-hidden', 'true');
            row.appendChild(dot);

            var info = document.createElement('div');
            info.className = 'flex-1 min-w-0';

            var name = document.createElement('div');
            name.className = 'text-sm font-medium truncate';
            name.textContent = entry.filename || 'Download';
            name.title = entry.filename || 'Download';
            name.setAttribute('data-testid', 'text-recent-download-filename-' + entry.id);
            info.appendChild(name);

            var detail = document.createElement('div');
            detail.className = 'text-xs ' + meta.text;
            var detailParts = [meta.label, timeAgoShort(entry.startedAt || entry.finishedAt)];
            if (entry.status === 'done' && typeof entry.bytes === 'number' && entry.bytes > 0) {
                detailParts.push(formatBytes(entry.bytes));
            }
            if ((entry.status === 'failed' || entry.status === 'cancelled') && entry.error) {
                detailParts.push(entry.error);
            }
            detail.textContent = detailParts.filter(Boolean).join(' · ');
            detail.setAttribute('data-testid', 'text-recent-download-status-' + entry.id);
            info.appendChild(detail);

            row.appendChild(info);

            if ((entry.status === 'failed' || entry.status === 'cancelled') && entry.url) {
                var retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'text-xs font-medium text-indigo-600 hover:text-indigo-800 hover:underline focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 rounded px-2 py-1 flex-shrink-0';
                retry.textContent = 'Retry';
                retry.setAttribute('aria-label', 'Retry download of ' + (entry.filename || 'file'));
                retry.setAttribute('data-testid', 'button-retry-download-' + entry.id);
                retry.addEventListener('click', function () {
                    retryHistoryEntry(entry.id);
                });
                row.appendChild(retry);
            }

            body.appendChild(row);
        });

        var footer = document.createElement('div');
        footer.className = 'flex items-center justify-end px-3 py-2 bg-gray-50 border-t border-gray-100';
        var clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'text-xs text-gray-600 hover:text-gray-900 hover:underline focus:outline-none focus:ring-2 focus:ring-gray-400 rounded px-2 py-1';
        clearBtn.textContent = 'Clear list';
        clearBtn.setAttribute('data-testid', 'button-clear-recent-downloads');
        clearBtn.addEventListener('click', function () { clearHistory(); });
        footer.appendChild(clearBtn);
        card.appendChild(footer);
    }

    function retryHistoryEntry(id) {
        var entries = loadHistory();
        var match = null;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i] && entries[i].id === id) { match = entries[i]; break; }
        }
        if (!match || !match.url) return;
        var opts = { filename: match.filename };
        if (match.fetchInit) opts.fetchInit = match.fetchInit;
        // Run async; the new attempt records its own history entry.
        try {
            streamingDownload(match.url, opts).catch(function () { /* surfaced via toast/tray */ });
        } catch (_) { /* ignore */ }
    }

    function hydrateTrayIfNeeded() {
        if (trayHydrated) return;
        trayHydrated = true;
        try { reconcileHistoryOnLoad(); } catch (_) { /* ignore */ }
        try { renderHistoryTray(); } catch (_) { /* ignore */ }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', hydrateTrayIfNeeded);
        } else {
            setTimeout(hydrateTrayIfNeeded, 0);
        }
    }

    // --- Streaming paths --------------------------------------------------

    // Drain a response body straight into an already-open File System Access
    // writable, counting bytes as each write completes (so `received` reflects
    // what's actually on disk and not what's still queued upstream). The
    // writable is intentionally NOT closed/aborted here so callers can resume
    // into the same handle on the next attempt.
    //
    // Uses the standard `WritableStreamDefaultWriter` interface (via
    // getWriter()) rather than the FSA-only `writable.write()` convenience
    // method, so the helper works against any WritableStream — including the
    // test mock and any future non-FSA backing.
    async function pipeBodyToWritable(response, writable, button, card, onProgress, totalLength, receivedRef) {
        var reader = response.body.getReader();
        var writer = writable.getWriter();
        try {
            while (true) {
                var step = await reader.read();
                if (step.done) break;
                if (!step.value || !step.value.byteLength) continue;
                // `await` ensures the chunk has been handed off to the
                // underlying sink before we count it — overcounting on the
                // way out would leave gaps after a Range-based resume.
                await writer.ready;
                await writer.write(step.value);
                receivedRef.value += step.value.byteLength;
                if (button) {
                    setBusy(button, progressLabel(receivedRef.value, totalLength));
                }
                if (card) {
                    try { card.update(receivedRef.value, totalLength); } catch (_) { /* ignore */ }
                }
                if (onProgress) {
                    try { onProgress(receivedRef.value, totalLength); } catch (_) { /* ignore */ }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (_) { /* ignore */ }
            // releaseLock() is required so the caller can later call
            // close()/abort()/seek()/truncate() on the writable for resume.
            try { writer.releaseLock(); } catch (_) { /* ignore */ }
        }
    }

    // Resume retry tuning (auto-retry the Range fetch a few times with
    // exponential backoff before falling back to the manual prompt).
    // Overridable per-page via `window.STREAMING_DOWNLOAD_RESUME_*` so
    // tests / power users can shorten or lengthen the retry budget.
    var DEFAULT_RESUME_MAX_ATTEMPTS = 3;
    var DEFAULT_RESUME_BASE_DELAY_MS = 1000;

    function resumeMaxAttempts() {
        var v = global.STREAMING_DOWNLOAD_RESUME_MAX_ATTEMPTS;
        if (typeof v === 'number' && isFinite(v) && v >= 1) return Math.floor(v);
        return DEFAULT_RESUME_MAX_ATTEMPTS;
    }

    function resumeBaseDelayMs() {
        var v = global.STREAMING_DOWNLOAD_RESUME_BASE_DELAY_MS;
        if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
        return DEFAULT_RESUME_BASE_DELAY_MS;
    }

    // Promise-based sleep that resolves early when the caller flips
    // `streamCtx.cancelled` to true (e.g. the user clicks Cancel mid-backoff).
    // Keeps the granularity small so cancellation feels immediate without
    // burning CPU on a tight poll.
    function delayWithCancel(ms, streamCtx) {
        return new Promise(function (resolve) {
            if (!ms || ms <= 0) return resolve();
            if (streamCtx && streamCtx.cancelled) return resolve();
            var step = Math.min(ms, 50);
            var elapsed = 0;
            (function tick() {
                if (streamCtx && streamCtx.cancelled) return resolve();
                elapsed += step;
                if (elapsed >= ms) return resolve();
                setTimeout(tick, step);
            })();
        });
    }

    // Strip transient error noise (DOMExceptions, AbortError frames, …)
    // down to a one-liner suitable for the progress card status copy.
    function describeFetchError(err) {
        if (!err) return 'network error';
        var msg = err.message || err.name || 'network error';
        msg = String(msg).split('\n')[0].trim();
        if (msg.length > 120) msg = msg.substring(0, 117) + '…';
        return msg || 'network error';
    }

    // True streaming path: pipe response.body directly to a file handle so
    // the browser never holds the full document in memory.
    //
    // `streamCtx.cancelled` (when present) signals that a non-cancel error
    // should NOT be treated as resumable — used so the user-cancel path can
    // tear the writable down cleanly without prompting for a resume that
    // they never asked for.
    async function streamResponseToDisk(response, filename, contentType, button, card, onProgress, totalLength, url, fetchInit, streamCtx) {
        var handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: pickerTypesFor(filename, contentType)
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                // Tag the picker dismissal as an explicit user-initiated
                // cancellation so the outer catch can keep the UX silent
                // rather than treating it as an environmental abort.
                try { err.userCancelled = true; } catch (_) { /* frozen err */ }
                throw err;
            }
            // SecurityError (lost user activation), NotAllowedError, or any
            // other failure means we cannot stream to disk — let the caller
            // fall back to the in-memory Blob path with the body still intact.
            return null;
        }

        var writable = await handle.createWritable();
        var receivedRef = { value: 0 };
        // Capture the response validator from the *first* response so resume
        // requests can use If-Range to ensure the export hasn't changed.
        var etag = response.headers.get && response.headers.get('etag');
        var acceptRanges = response.headers.get && response.headers.get('accept-ranges');
        // Resume only makes sense when the server advertises range support
        // (Accept-Ranges: bytes) AND we have a stable validator AND we know
        // the total length (so we can detect truly partial responses).
        var canResume = !!(etag && acceptRanges && /bytes/i.test(acceptRanges) &&
            totalLength && totalLength > 0);

        // Resume state machine. The loop alternates between two phases:
        //   1. Pipe `currentResponse.body` into the writable, advancing
        //      `receivedRef.value` on each successful chunk.
        //   2. If pipe errors with a recoverable network failure, prompt the
        //      user; on Resume, refetch with `Range`+`If-Range` and feed the
        //      next response into phase 1 again.
        // `pendingError` carries the latest pipe/fetch failure between
        // iterations so a re-fetch failure cleanly re-opens the prompt
        // instead of throwing through the loop.
        var currentResponse = response;
        var pendingError = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (pendingError === null) {
                try {
                    await pipeBodyToWritable(
                        currentResponse, writable, button, card, onProgress, totalLength, receivedRef
                    );
                    break; // success — fall through to close()
                } catch (pipeErr) {
                    pendingError = pipeErr;
                }
            }

            var userCancel = !!(streamCtx && streamCtx.cancelled);
            var abortLike = pendingError &&
                (pendingError.name === 'AbortError' || pendingError.cancelled === true);
            if (userCancel || abortLike) {
                try { await writable.abort(pendingError); } catch (_) { /* ignore */ }
                throw pendingError;
            }
            if (!canResume || !card || typeof card.setResumePrompt !== 'function' ||
                receivedRef.value <= 0 || receivedRef.value >= totalLength) {
                try { await writable.abort(pendingError); } catch (_) { /* ignore */ }
                throw pendingError;
            }

            // Ask the user whether to resume. The card prompt resolves
            // true (Resume) or false (Cancel/give up). Either way we
            // do not propagate a "Failed" state to streamingDownload.
            // `lastFetchReason` carries the reason from a previous
            // exhausted-retries cycle so the prompt can show *why* the
            // last attempt(s) failed rather than the original pipe error.
            var promptReason = pendingError ? describeFetchError(pendingError) : '';
            var wantResume = false;
            try {
                wantResume = await card.setResumePrompt(
                    receivedRef.value, totalLength, promptReason
                );
            } catch (_) {
                wantResume = false;
            }
            if (streamCtx && streamCtx.cancelled) wantResume = false;
            if (!wantResume) {
                try { await writable.abort(pendingError); } catch (_) { /* ignore */ }
                var giveUp = new Error('Download cancelled');
                giveUp.name = 'AbortError';
                giveUp.cancelled = true;
                throw giveUp;
            }

            // Refresh the card UI back to the in-progress look.
            if (card.clearResumePrompt) {
                try { card.clearResumePrompt(); } catch (_) { /* ignore */ }
            }

            // Issue a Range request from the byte we last successfully
            // wrote. Keep the original fetchInit (signal, credentials, …)
            // but layer Range/If-Range on top of any existing headers the
            // caller provided.
            var resumeFetchInit = Object.assign({}, fetchInit || {});
            var origHeaders = (fetchInit && fetchInit.headers) || {};
            var mergedHeaders = {};
            if (origHeaders && typeof origHeaders.forEach === 'function') {
                origHeaders.forEach(function (v, k) { mergedHeaders[k] = v; });
            } else {
                for (var k in origHeaders) {
                    if (Object.prototype.hasOwnProperty.call(origHeaders, k)) {
                        mergedHeaders[k] = origHeaders[k];
                    }
                }
            }
            mergedHeaders['Range'] = 'bytes=' + receivedRef.value + '-';
            if (etag) mergedHeaders['If-Range'] = etag;
            resumeFetchInit.headers = mergedHeaders;

            // Auto-retry the Range fetch with exponential backoff before
            // giving up. The user already opted in by clicking Resume; if
            // the network is still flapping we'd rather try a couple more
            // times (with a visible attempt counter and reason) than make
            // them re-click on every transient failure. After the budget
            // is exhausted we hand control back to the prompt with the
            // most recent error reason — preserving the partial bytes on
            // disk so the next click still resumes from the same offset.
            var maxAttempts = resumeMaxAttempts();
            var baseDelay = resumeBaseDelayMs();
            var resumed = null;
            var attemptErr = pendingError;
            var attempt = 0;
            while (attempt < maxAttempts) {
                if (streamCtx && streamCtx.cancelled) break;
                attempt += 1;

                // Backoff *before* attempts 2..N so the first attempt fires
                // immediately (the user just clicked Resume — no delay).
                if (attempt > 1 && baseDelay > 0) {
                    var waitMs = baseDelay * Math.pow(2, attempt - 2);
                    if (card && typeof card.setRetryStatus === 'function') {
                        try {
                            card.setRetryStatus({
                                attempt: attempt,
                                maxAttempts: maxAttempts,
                                reason: describeFetchError(attemptErr),
                                retryingIn: waitMs
                            });
                        } catch (_) { /* ignore */ }
                    }
                    await delayWithCancel(waitMs, streamCtx);
                    if (streamCtx && streamCtx.cancelled) break;
                }

                // Only flip the card into the "Retrying…" look once we're
                // past the user's first click (attempt 1 should look like a
                // normal in-progress download — the user clicked Resume and
                // hasn't seen any failure yet).
                if (attempt > 1 && card && typeof card.setRetryStatus === 'function') {
                    try {
                        card.setRetryStatus({
                            attempt: attempt,
                            maxAttempts: maxAttempts,
                            reason: describeFetchError(attemptErr)
                        });
                    } catch (_) { /* ignore */ }
                }

                try {
                    resumed = await fetch(url, resumeFetchInit);
                    break;
                } catch (fetchErr) {
                    attemptErr = fetchErr;
                    resumed = null;
                    // If the user cancelled mid-fetch (AbortController fired)
                    // there's no point retrying — break out and let the
                    // shared cancellation handler below tear things down.
                    if (fetchErr && (fetchErr.name === 'AbortError' ||
                        fetchErr.cancelled === true ||
                        (streamCtx && streamCtx.cancelled))) {
                        break;
                    }
                }
            }

            if (streamCtx && streamCtx.cancelled) {
                try { await writable.abort(attemptErr || pendingError); } catch (_) { /* ignore */ }
                var ce = new Error('Download cancelled');
                ce.name = 'AbortError';
                ce.cancelled = true;
                throw ce;
            }

            if (!resumed) {
                // Network still down after the auto-retries. Stash the most
                // recent error and re-loop so setResumePrompt re-opens with
                // the reason instead of throwing a generic failure — the
                // partial file on disk is still valid for another attempt.
                pendingError = attemptErr || pendingError;
                continue;
            }

            if (resumed.status === 206) {
                // Validate the server resumed at the byte we expect — a
                // mismatch would corrupt the file, so we'd rather bail out
                // than write garbage on top of good bytes.
                var cr = resumed.headers.get('content-range') || '';
                var crMatch = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(cr);
                var startsAt = crMatch ? parseInt(crMatch[1], 10) : NaN;
                if (!Number.isFinite(startsAt) || startsAt !== receivedRef.value) {
                    try { await writable.abort(); } catch (_) { /* ignore */ }
                    throw new Error('Resume failed: server returned an unexpected byte range');
                }
                currentResponse = resumed;
                pendingError = null;
                continue;
            }
            if (resumed.status === 200) {
                // Server didn't honour Range (or our If-Range validator
                // stopped matching). Restart from byte 0 by truncating the
                // file and re-piping.
                try { await writable.truncate(0); } catch (_) { /* ignore */ }
                try { await writable.seek(0); } catch (_) { /* ignore */ }
                receivedRef.value = 0;
                currentResponse = resumed;
                pendingError = null;
                continue;
            }
            try { await writable.abort(); } catch (_) { /* ignore */ }
            throw new Error('Resume failed (HTTP ' + resumed.status + ')');
        }

        try {
            await writable.close();
        } catch (closeErr) {
            // Surfacing close failures is important — the bytes may have
            // been written but never flushed to disk. We log instead of
            // throwing because the bytes-on-disk count is still meaningful
            // and rethrowing would mask the user's successful resume.
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[streamingDownload] writable.close() failed after resumable download:', closeErr);
            }
        }
        return { bytes: receivedRef.value, streamedToDisk: true };
    }

    // Legacy in-memory path: drain the body into an array of chunks, then
    // assemble a Blob and trigger the browser's normal download flow.
    async function bufferResponseAndDownload(response, filename, contentType, button, card, onProgress, totalLength) {
        var chunks = [];
        var received = 0;

        if (response.body && typeof response.body.getReader === 'function') {
            var reader = response.body.getReader();
            while (true) {
                var step = await reader.read();
                if (step.done) break;
                if (step.value) {
                    chunks.push(step.value);
                    received += step.value.byteLength;
                    if (button) {
                        setBusy(button, progressLabel(received, totalLength));
                    }
                    if (card) {
                        try { card.update(received, totalLength); } catch (_) { /* ignore */ }
                    }
                    if (onProgress) {
                        try { onProgress(received, totalLength); } catch (_) { /* ignore */ }
                    }
                }
            }
        } else {
            var buf = await response.arrayBuffer();
            chunks.push(new Uint8Array(buf));
            received = buf.byteLength;
            if (card) {
                try { card.update(received, totalLength); } catch (_) { /* ignore */ }
            }
        }

        var blob = new Blob(chunks, { type: contentType });
        var objectUrl = window.URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(function () { window.URL.revokeObjectURL(objectUrl); }, 60000);

        return { bytes: received, streamedToDisk: false };
    }

    function shouldStreamToDisk(options, totalLength) {
        var mode = options.streamToDisk;
        if (mode === false || mode === 'never') return false;
        if (mode === true || mode === 'always') return true;
        // 'auto' (default): stream to disk when size is unknown or larger
        // than the configured threshold. Tiny exports keep the legacy UX so
        // users aren't prompted with a picker for a few-KB CSV.
        var threshold = typeof options.streamToDiskThreshold === 'number'
            ? options.streamToDiskThreshold
            : (typeof global.STREAMING_DOWNLOAD_THRESHOLD === 'number'
                ? global.STREAMING_DOWNLOAD_THRESHOLD
                : DEFAULT_STREAM_TO_DISK_THRESHOLD);
        if (!totalLength || totalLength <= 0) return true;
        return totalLength >= threshold;
    }

    // --- Estimate helpers -------------------------------------------------

    // Each export endpoint exposes a sibling `/estimate` route returning
    // { rows, bytes, format }. We cache results briefly and use the bytes to
    // (a) skip the picker for small downloads and (b) show an "≈ X MB" hint
    // on the button.
    var ESTIMATE_TTL_MS = 60 * 1000;
    var estimateCache = Object.create(null);

    function estimateUrlFor(exportUrl) {
        // Insert "/estimate" before the query string so filter params carry over.
        if (typeof exportUrl !== 'string' || !exportUrl) return null;
        var qIdx = exportUrl.indexOf('?');
        if (qIdx === -1) return exportUrl + '/estimate';
        return exportUrl.substring(0, qIdx) + '/estimate' + exportUrl.substring(qIdx);
    }

    async function fetchExportEstimate(exportUrl, fetchInit) {
        var key = exportUrl;
        var cached = estimateCache[key];
        if (cached && (Date.now() - cached.at) < ESTIMATE_TTL_MS) {
            return cached.value;
        }
        var url = estimateUrlFor(exportUrl);
        if (!url) return null;
        try {
            var init = Object.assign({ credentials: 'same-origin' }, fetchInit || {});
            var resp = await fetch(url, init);
            if (!resp.ok) return null;
            // Prefer JSON body; fall back to headers if the server short-circuited.
            var bytes = Number(resp.headers.get('x-estimated-bytes'));
            var rows  = Number(resp.headers.get('x-estimated-rows'));
            var format = resp.headers.get('x-export-format') || null;
            try {
                var body = await resp.json();
                if (body && typeof body === 'object') {
                    if (typeof body.bytes === 'number') bytes = body.bytes;
                    if (typeof body.rows  === 'number') rows  = body.rows;
                    if (typeof body.format === 'string') format = body.format;
                }
            } catch (_) { /* JSON optional */ }
            if (!Number.isFinite(bytes)) bytes = 0;
            if (!Number.isFinite(rows))  rows  = 0;
            var value = { bytes: bytes, rows: rows, format: format };
            estimateCache[key] = { at: Date.now(), value: value };
            return value;
        } catch (_) {
            return null;
        }
    }

    function clearEstimateCache(exportUrl) {
        if (exportUrl) {
            delete estimateCache[exportUrl];
        } else {
            estimateCache = Object.create(null);
        }
    }

    /**
     * Render a human-friendly size hint next to or inside a button.
     *
     * Looks for a child `[data-size-hint]` element and updates its text. If
     * one is not present, appends a `<span data-size-hint>` to the button so
     * existing pages can opt in just by adding `data-estimate-url=…`.
     *
     * Also updates the button's `title` and `aria-label` so screen-reader
     * users hear the size hint too.
     */
    function applySizeHint(el, estimate) {
        if (!el || !estimate) return;
        var label;
        if (!estimate.bytes || estimate.bytes <= 0 || estimate.rows === 0) {
            label = tr('downloads.size_empty', 'empty');
        } else {
            label = '≈ ' + formatBytes(estimate.bytes);
        }
        var hint = el.querySelector('[data-size-hint]');
        if (!hint) {
            hint = document.createElement('span');
            hint.setAttribute('data-size-hint', '');
            hint.className = 'ml-2 text-xs text-gray-500 dark:text-gray-400';
            el.appendChild(hint);
        }
        hint.textContent = '(' + label + ')';
        var rowText = estimate.rows
            ? tr('downloads.rows', '{count} rows', { count: estimate.rows.toLocaleString() })
            : tr('downloads.no_rows', 'no rows');
        var titleSuffix = tr('downloads.estimate_title',
            'Estimated {label} · {rows}', { label: label, rows: rowText });
        var existingTitle = el.getAttribute('data-original-title') || el.getAttribute('title') || '';
        if (!el.getAttribute('data-original-title') && existingTitle) {
            el.setAttribute('data-original-title', existingTitle);
        }
        var baseTitle = el.getAttribute('data-original-title') || '';
        el.setAttribute('title', baseTitle ? (baseTitle + ' · ' + titleSuffix) : titleSuffix);
        var ariaBase = el.getAttribute('data-original-aria-label') || el.getAttribute('aria-label') || el.textContent.trim();
        if (!el.getAttribute('data-original-aria-label') && ariaBase) {
            el.setAttribute('data-original-aria-label', ariaBase);
        }
        el.setAttribute('aria-label', (el.getAttribute('data-original-aria-label') || '') + ' (' + titleSuffix + ')');
    }

    /**
     * Scan the DOM for elements with `data-estimate-url` and asynchronously
     * fetch each estimate, rendering "(≈ X MB)" hints on each button.
     *
     * Safe to call multiple times — estimates are cached for a short TTL.
     * Called automatically on DOMContentLoaded; pages can also call it after
     * dynamically inserting buttons (e.g. after rendering a list of owners).
     */
    function attachSizeHints(root) {
        var scope = root || document;
        if (!scope || typeof scope.querySelectorAll !== 'function') return;
        var nodes = scope.querySelectorAll('[data-estimate-url]:not([data-estimate-attached])');
        nodes.forEach(function (el) {
            el.setAttribute('data-estimate-attached', '1');
            var url = el.getAttribute('data-estimate-url');
            if (!url) return;
            fetchExportEstimate(url).then(function (est) {
                if (est) applySizeHint(el, est);
            }).catch(function () { /* swallow — hints are best-effort */ });
        });
    }

    // ── Fallback advisory ─────────────────────────────────────────────────
    // On very old browsers we end up using `bufferResponseAndDownload`, which
    // holds the whole export in memory. For multi-hundred-MB exports that can
    // crash the tab. Surface a one-time, dismissible note next to the export
    // buttons on capable-but-not-streaming browsers so users know what to
    // expect (and can upgrade to a modern Chrome/Firefox/Safari).

    var FALLBACK_NOTICE_DISMISS_KEY = 'walaplus.streamingFallbackDismissed';
    var FALLBACK_NOTICE_MARKER = 'streaming-download-fallback-notice';

    function canStreamToDisk() {
        return supportsFileSystemAccess() || supportsServiceWorkerStreaming();
    }

    function isFallbackNoticeDismissed() {
        try {
            return window.sessionStorage &&
                window.sessionStorage.getItem(FALLBACK_NOTICE_DISMISS_KEY) === '1';
        } catch (_) {
            return false;
        }
    }

    function dismissFallbackNotice(notice) {
        try {
            if (window.sessionStorage) {
                window.sessionStorage.setItem(FALLBACK_NOTICE_DISMISS_KEY, '1');
            }
        } catch (_) { /* storage may be blocked — still hide for this view */ }
        if (notice && notice.parentNode) {
            notice.parentNode.removeChild(notice);
        }
    }

    function buildFallbackNotice() {
        var notice = document.createElement('div');
        notice.id = FALLBACK_NOTICE_MARKER;
        notice.setAttribute('role', 'status');
        notice.setAttribute('data-testid', 'notice-streaming-fallback');
        notice.className = 'mb-4 flex items-start gap-3 rounded-lg border border-amber-300 ' +
            'bg-amber-50 px-4 py-3 text-sm text-amber-900 ' +
            'dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100';

        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.className = 'mt-0.5 flex-shrink-0';
        icon.innerHTML = '<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" ' +
            'd="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>' +
            '</svg>';

        var text = document.createElement('div');
        text.className = 'flex-1';
        var strong = document.createElement('strong');
        strong.className = 'block font-semibold';
        strong.textContent = tr('downloads.fallback_notice_title',
            "This browser can't stream exports directly to disk.");
        var detail = document.createElement('span');
        detail.className = 'block mt-0.5';
        detail.textContent = tr('downloads.fallback_notice_detail',
            'Exports over ~200 MB will be buffered in memory and may be slow ' +
            'or fail. For large downloads, use a recent Chrome, Firefox, or Safari.');
        text.appendChild(strong);
        text.appendChild(detail);

        var dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', tr('downloads.fallback_notice_dismiss',
            'Dismiss browser export advisory'));
        dismiss.setAttribute('data-testid', 'button-dismiss-streaming-fallback');
        dismiss.className = 'flex-shrink-0 rounded p-1 text-amber-900 hover:bg-amber-100 ' +
            'focus:outline-none focus:ring-2 focus:ring-amber-500 ' +
            'dark:text-amber-100 dark:hover:bg-amber-900';
        dismiss.innerHTML = '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">' +
            '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
        dismiss.addEventListener('click', function () {
            dismissFallbackNotice(notice);
        });

        notice.appendChild(icon);
        notice.appendChild(text);
        notice.appendChild(dismiss);
        return notice;
    }

    function findExportButton(scope) {
        if (!scope || typeof scope.querySelector !== 'function') return null;
        return scope.querySelector(
            '[data-on-click="streamDownload"], ' +
            '[data-on-click="streamingDownload"], ' +
            '[data-on-click="streamingDownloadFromEvent"], ' +
            '[data-estimate-url]'
        );
    }

    function findNoticeAnchor(scope) {
        if (!scope) return null;
        if (typeof scope.querySelector === 'function') {
            var main = scope.querySelector('main');
            if (main) return main;
        }
        var btn = findExportButton(scope);
        if (btn) {
            return btn.closest('main, section, header') || btn.parentElement;
        }
        return null;
    }

    function attachStreamingFallbackNotice(root) {
        var scope = root || document;
        if (!scope || typeof scope.querySelector !== 'function') return;
        if (scope.getElementById && scope.getElementById(FALLBACK_NOTICE_MARKER)) return;
        if (canStreamToDisk()) return;
        if (isFallbackNoticeDismissed()) return;
        if (!findExportButton(scope)) return;
        var anchor = findNoticeAnchor(scope);
        if (!anchor) return;
        var notice = buildFallbackNotice();
        if (typeof anchor.insertAdjacentElement === 'function') {
            anchor.insertAdjacentElement('afterbegin', notice);
        } else if (anchor.firstChild) {
            anchor.insertBefore(notice, anchor.firstChild);
        } else {
            anchor.appendChild(notice);
        }
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () {
                attachSizeHints();
                attachStreamingFallbackNotice();
            });
        } else {
            // Defer to next tick so call sites that load this script late
            // still have a chance to populate buttons before we scan.
            setTimeout(function () {
                attachSizeHints();
                attachStreamingFallbackNotice();
            }, 0);
        }
    }

    async function streamingDownload(url, options) {
        options = options || {};
        var button = options.button || null;
        var userOnProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        var fetchInit = Object.assign({ credentials: 'same-origin' }, options.fetchInit || {});
        var showProgressUI = options.showProgressUI !== false;
        var showToastUI = options.showToast !== false;
        var cancellable = options.cancellable !== false;
        var trackHistory = options.trackHistory !== false;

        var initialFilename = options.filename || tr('downloads.preparing_download', 'Preparing download…');
        var card = null;
        // Local "user pressed Cancel on this download" flag. Declared
        // explicitly so strict-mode mode evaluation doesn't ReferenceError
        // when the catch block reads it before requestCancel() has run
        // (e.g. when the user dismisses the Resume prompt — that path
        // does not flip cancelled, but the catch still inspects it).
        var cancelled = false;
        // Wrapped in an object so streamResponseToDisk's resume loop can see
        // the live value (cancellation may flip while it's mid-pipe).
        var cancelState = { cancelled: false };
        var originalContent = null;
        // Hoisted so the catch block (e.g. environmental-abort path) can
        // reference the parsed filename in the user-facing toast even
        // after the floating progress card has auto-removed.
        var resolvedFilename = options.filename || null;

        // Track whether the abort came from a user-initiated cancel (the
        // export-button Cancel affordance, the floating-card Cancel button,
        // a programmatic onCancelHandle, or an externally-supplied
        // AbortSignal) vs. an environmental abort (browser/OS killing the
        // fetch — tab discarded, mobile background-throttling, sleep/wake,
        // network drop). The two look identical at the AbortError level,
        // but only the latter should surface a visible "Download
        // interrupted — Retry" toast.
        var userCancelled = false;

        // Track live progress so the cancel-confirmation gate can decide
        // whether the user is far enough along to deserve a "Are you sure?"
        // prompt before we tear the download down.
        var progressState = {
            received: 0,
            totalLength: 0,
            startedAt: Date.now()
        };
        var onProgress = function (received, totalLength) {
            progressState.received = received;
            if (totalLength) progressState.totalLength = totalLength;
            if (userOnProgress) {
                try { userOnProgress(received, totalLength); } catch (_) { /* ignore */ }
            }
        };

        // Wire up an AbortController so the user can cancel the download
        // mid-stream (and so external callers can pass their own signal via
        // fetchInit.signal — we forward aborts to our internal controller).
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var externalSignal = fetchInit.signal || null;
        if (controller) {
            if (externalSignal) {
                if (externalSignal.aborted) {
                    // A pre-aborted external signal means the caller chose
                    // not to start — count it as user-initiated.
                    userCancelled = true;
                    try { controller.abort(externalSignal.reason); } catch (_) { /* ignore */ }
                } else {
                    try {
                        externalSignal.addEventListener('abort', function () {
                            userCancelled = true;
                            try { controller.abort(externalSignal.reason); } catch (_) { /* ignore */ }
                        });
                    } catch (_) { /* ignore */ }
                }
            }
            fetchInit.signal = controller.signal;
        }

        // Populated by the SW path so cancelDownload() can post a cancel
        // message immediately, before pipeTo() rejects.
        var swCancelInfo = { sw: null, id: null };
        function cancelDownload() {
            userCancelled = true;
            if (controller && !controller.signal.aborted) {
                try { controller.abort(); } catch (_) { /* ignore */ }
            }
            if (swCancelInfo.sw && swCancelInfo.id) {
                try {
                    swCancelInfo.sw.postMessage({ type: 'cancel', id: swCancelInfo.id });
                } catch (_) { /* ignore */ }
            }
        }

        // Decide whether the download is "far enough along" that a stray
        // click should not be allowed to silently throw away progress.
        // Either threshold trips the confirm prompt:
        //   * percent of bytes received vs total (only when total is known)
        //   * elapsed wall-clock since the download started
        function shouldConfirmCancel() {
            if (options.confirmCancel === false) return false;
            var pctThreshold = (typeof options.confirmCancelThresholdPercent === 'number')
                ? options.confirmCancelThresholdPercent
                : DEFAULT_CONFIRM_CANCEL_PERCENT;
            var msThreshold = (typeof options.confirmCancelThresholdMs === 'number')
                ? options.confirmCancelThresholdMs
                : DEFAULT_CONFIRM_CANCEL_MS;
            var elapsed = Date.now() - progressState.startedAt;
            var pastPct = isFinite(pctThreshold) && pctThreshold >= 0 &&
                progressState.totalLength > 0 &&
                ((progressState.received / progressState.totalLength) * 100) > pctThreshold;
            var pastMs = isFinite(msThreshold) && msThreshold >= 0 && elapsed > msThreshold;
            return pastPct || pastMs;
        }

        // Gate the raw cancelDownload() behind a confirm prompt for
        // long-running downloads. Returns true if the cancellation actually
        // proceeded (so UI can move into a "Cancelling…" state) and false if
        // the user backed out (so the Cancel control should stay live).
        function requestCancel() {
            if (cancelled) return true;
            if (shouldConfirmCancel()) {
                var prompter = (typeof options.confirmCancel === 'function')
                    ? options.confirmCancel
                    : ((typeof window !== 'undefined' && typeof window.confirm === 'function')
                        ? window.confirm.bind(window)
                        : null);
                if (prompter) {
                    var ok;
                    try { ok = prompter(tr('downloads.confirm_cancel_message', CONFIRM_CANCEL_MESSAGE)); }
                    catch (_) { ok = true; }
                    if (!ok) return false;
                }
            }
            cancelled = true;
            // Mirror the cancel flag onto cancelState so streamResponseToDisk
            // (which only sees the shared streamCtx, not this closure) can
            // bail out of the auto-retry loop / mid-backoff sleep without
            // waiting for the AbortController plumbing to surface.
            cancelState.cancelled = true;
            cancelDownload();
            return true;
        }

        // Expose for callers that want a programmatic cancel handle (e.g. an
        // external Cancel button rendered next to the export button).
        if (typeof options.onCancelHandle === 'function') {
            try { options.onCancelHandle(cancelDownload); } catch (_) { /* ignore */ }
        }

        var cancelable = null;

        // Record an "in-progress" history entry up front so the tray reflects
        // the attempt the moment the user kicks it off. We update status,
        // filename, and bytes as the request progresses.
        var historyId = null;
        if (trackHistory) {
            try {
                hydrateTrayIfNeeded();
                historyId = makeHistoryId();
                recordHistoryEntry({
                    id: historyId,
                    url: url,
                    filename: options.filename || buildFallbackName(url, ''),
                    status: 'in-progress',
                    startedAt: new Date().toISOString(),
                    bytes: 0,
                    fetchInit: sanitizeFetchInit(options.fetchInit)
                });
            } catch (_) { /* tray is best-effort */ }
        }

        if (button) {
            originalContent = button.innerHTML;
            cancelable = setupCancelableButton(button, requestCancel);
            var preparingLabel = tr('downloads.preparing', 'Preparing…');
            if (cancelable) cancelable.updateLabel(preparingLabel);
            else setBusy(button, preparingLabel);
        }

        if (showProgressUI) {
            // Route the card's cancel button through requestCancel so the
            // confirm-before-tearing-down-a-near-complete-download gate runs
            // for it too, and so the SW (when used) gets a
            // `{ type: 'cancel', id }` message — not just a fetch abort.
            card = createProgressCard(initialFilename, requestCancel);
            if (card && !cancellable) card.hideCancel();
        }

        // Best-effort pre-flight estimate so shouldStreamToDisk can skip the
        // picker for small downloads. Skipped when the caller forced a choice
        // or passed `skipEstimate: true`.
        var preflightEstimate = options.estimate || null;
        var estimateRequested = options.streamToDisk !== true &&
            options.streamToDisk !== 'always' &&
            options.skipEstimate !== true &&
            !preflightEstimate;
        if (estimateRequested) {
            try {
                preflightEstimate = await fetchExportEstimate(url);
            } catch (_) { /* fall through — estimate is best-effort */ }
        }

        // ── Large-export gate ─────────────────────────────────────────────
        // If the preflight estimate is above either configured threshold,
        // ask the user to confirm before the streaming response starts and
        // the save-as picker fires. This lets users cancel or narrow their
        // filters without consuming bandwidth or triggering a disk write.
        if (preflightEstimate && options.skipLargeExportWarning !== true) {
            var byteThreshold = (typeof options.largeExportByteThreshold === 'number')
                ? options.largeExportByteThreshold
                : (typeof global.STREAMING_DOWNLOAD_LARGE_EXPORT_BYTE_THRESHOLD === 'number'
                    ? global.STREAMING_DOWNLOAD_LARGE_EXPORT_BYTE_THRESHOLD
                    : DEFAULT_LARGE_EXPORT_BYTE_THRESHOLD);
            var rowThreshold = (typeof options.largeExportRowThreshold === 'number')
                ? options.largeExportRowThreshold
                : (typeof global.STREAMING_DOWNLOAD_LARGE_EXPORT_ROW_THRESHOLD === 'number'
                    ? global.STREAMING_DOWNLOAD_LARGE_EXPORT_ROW_THRESHOLD
                    : DEFAULT_LARGE_EXPORT_ROW_THRESHOLD);

            var estimatedBytes = (preflightEstimate.bytes > 0) ? preflightEstimate.bytes : 0;
            var estimatedRows  = (preflightEstimate.rows  > 0) ? preflightEstimate.rows  : 0;
            var exceedsByte    = isFinite(byteThreshold) && byteThreshold >= 0 && estimatedBytes > byteThreshold;
            var exceedsRow     = isFinite(rowThreshold)  && rowThreshold  >= 0 && estimatedRows  > rowThreshold;

            if (exceedsByte || exceedsRow) {
                var sizeStr = estimatedBytes > 0
                    ? formatBytes(estimatedBytes)
                    : null;
                var rowsStr = estimatedRows > 0
                    ? tr('downloads.rows', '{count} rows', { count: estimatedRows.toLocaleString() })
                    : null;

                var detailParts = [];
                if (sizeStr) detailParts.push(sizeStr);
                if (rowsStr) detailParts.push(rowsStr);
                var detailStr = detailParts.join(', ');

                var confirmMsg = detailStr
                    ? tr('downloads.large_export_confirm_detail',
                        'This export is about {detail} and may take a moment. Continue?',
                        { detail: detailStr })
                    : tr('downloads.large_export_confirm',
                        'This is a large export and may take a moment. Continue?');

                var confirmLarge = (typeof options.confirmLargeExport === 'function')
                    ? options.confirmLargeExport
                    : ((typeof window !== 'undefined' && typeof window.confirm === 'function')
                        ? window.confirm.bind(window)
                        : null);

                var proceed = true;
                if (confirmLarge) {
                    try { proceed = !!confirmLarge(confirmMsg, preflightEstimate); }
                    catch (_) { proceed = true; }
                }

                if (!proceed) {
                    // User chose not to proceed — restore the button and bail
                    // cleanly without touching the network.
                    if (cancelable && cancelable.teardown) cancelable.teardown();
                    restoreButton(button, originalContent);
                    if (card) { try { card.remove(0); } catch (_) { /* ignore */ } }
                    if (historyId) {
                        try {
                            updateHistoryEntry(historyId, {
                                status: 'cancelled',
                                finishedAt: new Date().toISOString()
                            });
                        } catch (_) { /* ignore */ }
                    }
                    var largeExportCancelErr = new Error('Large export cancelled by user');
                    largeExportCancelErr.name = 'AbortError';
                    largeExportCancelErr.cancelled = true;
                    largeExportCancelErr.userCancelled = true;
                    // Throw outside the main try/finally so the finally block
                    // does not double-call restoreButton / cancelable.teardown.
                    throw largeExportCancelErr;
                }
            }
        }

        try {
            var response = await fetch(url, fetchInit);

            if (!response.ok) {
                var msg = tr('downloads.export_failed_http',
                    'Export failed (HTTP {status})', { status: response.status });
                try {
                    var ct = response.headers.get('content-type') || '';
                    if (ct.indexOf('application/json') !== -1) {
                        var err = await response.json();
                        if (err && (err.error || err.message)) {
                            msg = err.error || err.message;
                        }
                    } else {
                        var text = await response.text();
                        if (text) msg = text.slice(0, 200);
                    }
                } catch (_) { /* ignore */ }
                throw new Error(msg);
            }

            var contentType = response.headers.get('content-type') || 'application/octet-stream';
            var disposition = response.headers.get('content-disposition') || '';
            var totalLength = Number(response.headers.get('content-length')) || 0;
            // Streaming exports have no Content-Length; use the pre-flight
            // estimate so progress reporting and shouldStreamToDisk work.
            if ((!totalLength || totalLength <= 0) && preflightEstimate && preflightEstimate.bytes > 0) {
                totalLength = preflightEstimate.bytes;
            }
            // Seed the cancel-confirmation gate with the known total before
            // any chunks arrive, so an early-cancel after a slow first byte
            // can still evaluate the percent threshold.
            if (totalLength) progressState.totalLength = totalLength;

            var filename = options.filename ||
                parseContentDispositionFilename(disposition) ||
                buildFallbackName(url, contentType);
            resolvedFilename = filename;

            if (card) {
                card.setLabel(filename);
                card.update(0, totalLength);
            }

            if (historyId) {
                updateHistoryEntry(historyId, { filename: filename });
            }

            var result = null;

            var wantStream = shouldStreamToDisk(options, totalLength);
            var allowServiceWorker = options.useServiceWorker !== false;

            if (supportsFileSystemAccess() && wantStream) {
                // Pass url/fetchInit/cancelState so the FSA path can issue a
                // Range-based resume request after a network interruption,
                // stitching the resumed bytes into the same writable handle.
                result = await streamResponseToDisk(
                    response, filename, contentType, button, card, onProgress, totalLength,
                    url, fetchInit, cancelState
                );
                // result === null means the picker call failed in a recoverable
                // way (e.g. lost user activation) and the body is still intact,
                // so we transparently fall through to the next path.
            }

            if (!result && allowServiceWorker && wantStream && supportsServiceWorkerStreaming()) {
                // Firefox / Safari path. Returns null without consuming the
                // body if the SW can't be registered or transferable streams
                // aren't available, so the Blob fallback below still works.
                result = await streamResponseViaServiceWorker(
                    response, filename, contentType, totalLength, button, onProgress, swCancelInfo
                );
            }

            if (!result) {
                result = await bufferResponseAndDownload(
                    response, filename, contentType, button, card, onProgress, totalLength
                );
            }

            if (card) {
                card.setBarColor('bg-green-600');
                card.update(result.bytes, totalLength || result.bytes);
                card.setStatus(tr('downloads.done', 'Done — {size}',
                    { size: formatBytes(result.bytes) }));
                card.disableCancel();
                card.remove(2500);
            }

            if (showToastUI) {
                showToast(tr('downloads.downloaded_toast',
                    'Downloaded {filename} ({size})',
                    { filename: filename, size: formatBytes(result.bytes) }), 'success');
            }

            if (historyId) {
                updateHistoryEntry(historyId, {
                    status: 'done',
                    bytes: result.bytes,
                    finishedAt: new Date().toISOString()
                });
            }

            return {
                filename: filename,
                bytes: result.bytes,
                type: contentType,
                streamedToDisk: !!result.streamedToDisk
            };
        } catch (err) {
            // An abort can come from several places:
            //   1. User clicked Cancel on the floating progress card
            //      (`cancelled` flag) — userCancelled is also set via
            //      cancelDownload().
            //   2. User clicked Cancel on the export button or invoked the
            //      programmatic onCancelHandle — userCancelled is set.
            //   3. Caller passed an external AbortSignal that fired —
            //      userCancelled is set by the abort listener above.
            //   4. User dismissed the save-file picker — the picker AbortError
            //      is tagged with `userCancelled = true` by streamResponseToDisk.
            //   5. Browser/OS killed the fetch (tab discarded, sleep/wake,
            //      mobile background-throttling, network drop). This shows
            //      up as an AbortError with controller NOT aborted by us.
            //
            // Cases 1–4 are user-initiated and stay silent (the card briefly
            // shows "Cancelled" then disappears). Case 5 is environmental
            // and surfaces a "Download interrupted — Retry" toast so the
            // user knows their long-running export didn't silently vanish.
            var isAbortLike = cancelled
                || userCancelled
                || (controller && controller.signal && controller.signal.aborted)
                || (err && (err.name === 'AbortError' || err.cancelled === true));
            var isUserCancel = cancelled
                || userCancelled
                || (err && err.userCancelled === true);
            // A mid-stream TypeError (Wi-Fi flap, ISP hiccup, mobile
            // handoff) looks identical to the user as an AbortError-based
            // environmental abort: a long export that vanished partway through.
            // Treat it the same way — show the "Download interrupted — Retry"
            // amber toast — but only when we've already received bytes (i.e.
            // the stream was in flight), to avoid masking genuine pre-stream
            // network failures as "interrupted" rather than "failed".
            var isMidStreamNetworkError = !isUserCancel
                && !isAbortLike
                && progressState.received > 0
                && err && err.name === 'TypeError';
            var isEnvironmentalAbort = (isAbortLike && !isUserCancel
                && err && err.name === 'AbortError')
                || isMidStreamNetworkError;
            // Prefer the parsed filename so the interrupted toast keeps the
            // file context even after the floating card has gone away.
            var displayName = options.filename || resolvedFilename || (card ? null : tr('downloads.default_file', 'file'));

            if (isUserCancel) {
                console.info('streamingDownload cancelled by user for', url);
                if (card) {
                    card.setBarColor('bg-gray-400');
                    card.setStatus(tr('downloads.cancelled', 'Cancelled'));
                    card.disableCancel();
                    card.remove(2500);
                }
                // Per spec: user-initiated cancels stay silent — the card
                // state change (or the restored button) is sufficient
                // feedback. No toast, no alert.
                if (historyId) {
                    updateHistoryEntry(historyId, {
                        status: 'cancelled',
                        finishedAt: new Date().toISOString()
                    });
                }
                if (err && err.name === 'AbortError') throw err;
                var cancelErr = new Error((err && err.message) || 'Download cancelled');
                cancelErr.name = 'AbortError';
                cancelErr.cancelled = true;
                cancelErr.userCancelled = true;
                throw cancelErr;
            }

            if (isEnvironmentalAbort) {
                console.warn('streamingDownload interrupted by environment for', url, err);
                if (card) {
                    card.setBarColor('bg-amber-500');
                    card.setStatus(tr('downloads.interrupted_status', 'Interrupted — browser stopped the download'));
                    card.disableCancel();
                    card.remove(8000);
                }
                if (showToastUI) {
                    var retryUrl = url;
                    var retryOptions = options;
                    showToast(
                        displayName
                            ? tr('downloads.interrupted_toast_with_name',
                                'Download interrupted ({filename}) — your browser stopped the download (tab inactive, sleep, or network drop).',
                                { filename: displayName })
                            : tr('downloads.interrupted_toast',
                                'Download interrupted — your browser stopped the download (tab inactive, sleep, or network drop).'),
                        'warn',
                        {
                            testId: 'toast-download-interrupted',
                            autoDismissMs: 12000,
                            action: {
                                label: tr('downloads.retry', 'Retry'),
                                testId: 'button-retry-download',
                                onClick: function () {
                                    try {
                                        // Best-effort: re-run with the same
                                        // url/options. Swallow the rejection
                                        // so an unhandled-promise warning
                                        // doesn't fire — failures will
                                        // surface their own toast.
                                        var p = streamingDownload(retryUrl, retryOptions);
                                        if (p && typeof p.catch === 'function') {
                                            p.catch(function () { /* swallow */ });
                                        }
                                    } catch (_) { /* ignore */ }
                                }
                            }
                        }
                    );
                }
                if (historyId) {
                    updateHistoryEntry(historyId, {
                        status: 'interrupted',
                        error: (err && err.message) ? String(err.message).slice(0, 200) : 'Interrupted',
                        finishedAt: new Date().toISOString()
                    });
                }
                var interruptedErr = new Error((err && err.message) || 'Download interrupted');
                interruptedErr.name = 'AbortError';
                interruptedErr.interrupted = true;
                throw interruptedErr;
            }

            console.error('streamingDownload failed for', url, err);
            var errMsg = (err && err.message) ? err.message : tr('downloads.unknown_error', 'Unknown error');
            if (card) {
                card.setBarColor('bg-red-600');
                card.setStatus(tr('downloads.failed_status', 'Failed: {message}', { message: errMsg }));
                card.disableCancel();
                card.remove(6000);
            }
            if (showToastUI) {
                showToast(tr('downloads.failed_toast', 'Download failed: {message}', { message: errMsg }), 'error');
            }
            if (historyId) {
                updateHistoryEntry(historyId, {
                    status: 'failed',
                    error: (err && err.message) ? String(err.message).slice(0, 200) : 'Unknown error',
                    finishedAt: new Date().toISOString()
                });
            }
            throw err;
        } finally {
            if (cancelable && cancelable.teardown) cancelable.teardown();
            restoreButton(button, originalContent);
        }
    }

    function resolveButtonFromEvent(event) {
        if (!event) return null;
        var ct = event.currentTarget;
        if (ct && (ct.tagName === 'BUTTON' || ct.tagName === 'A')) return ct;
        var t = event.target;
        if (t && typeof t.closest === 'function') {
            return t.closest('button, a[data-on-click], a[data-testid]');
        }
        return null;
    }

    function streamingDownloadFromEvent(event, url, options) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        var opts = Object.assign({}, options || {});
        if (!opts.button) {
            opts.button = resolveButtonFromEvent(event);
        }
        return streamingDownload(url, opts);
    }

    function streamDownload(url, filename, event) {
        var opts = { filename: filename, button: resolveButtonFromEvent(event) };
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }
        return streamingDownload(url, opts);
    }

    streamingDownload.DEFAULT_STREAM_TO_DISK_THRESHOLD = DEFAULT_STREAM_TO_DISK_THRESHOLD;
    streamingDownload.DEFAULT_LARGE_EXPORT_BYTE_THRESHOLD = DEFAULT_LARGE_EXPORT_BYTE_THRESHOLD;
    streamingDownload.DEFAULT_LARGE_EXPORT_ROW_THRESHOLD  = DEFAULT_LARGE_EXPORT_ROW_THRESHOLD;
    streamingDownload.fetchEstimate = fetchExportEstimate;
    streamingDownload.estimateUrlFor = estimateUrlFor;
    streamingDownload.attachSizeHints = attachSizeHints;
    streamingDownload.applySizeHint = applySizeHint;
    streamingDownload.clearEstimateCache = clearEstimateCache;
    streamingDownload.formatBytes = formatBytes;
    streamingDownload._shouldStreamToDisk = shouldStreamToDisk;
    streamingDownload.canStreamToDisk = canStreamToDisk;
    streamingDownload.supportsFileSystemAccess = supportsFileSystemAccess;
    streamingDownload.supportsServiceWorkerStreaming = supportsServiceWorkerStreaming;
    streamingDownload.attachStreamingFallbackNotice = attachStreamingFallbackNotice;
    streamingDownload.FALLBACK_NOTICE_DISMISS_KEY = FALLBACK_NOTICE_DISMISS_KEY;
    streamingDownload.history = {
        list: loadHistory,
        clear: clearHistory,
        retry: retryHistoryEntry,
        renderTray: renderHistoryTray,
        // Wire up the signed-in user so the tray persists across browser
        // sessions in localStorage instead of per-tab sessionStorage. Pass
        // a stable identifier (e.g. numeric user id) — pass null on logout
        // to revert to the anonymous tab-only behaviour.
        setUser: setHistoryUser,
        getUserKey: function () { return currentHistoryUserKey; },
        STORAGE_KEY: HISTORY_STORAGE_KEY,
        STORAGE_KEY_PREFIX: HISTORY_STORAGE_KEY_PREFIX,
        TRAY_OPEN_KEY: TRAY_OPEN_STORAGE_KEY,
        LIMIT: HISTORY_LIMIT,
        DEFAULT_MAX_AGE_MS: HISTORY_DEFAULT_MAX_AGE_MS
    };

    global.streamingDownload = streamingDownload;
    global.streamingDownloadFromEvent = streamingDownloadFromEvent;
    global.streamDownload = streamDownload;
    global.streamingDownloadProgress = {
        showToast: showToast
    };
})(window);
