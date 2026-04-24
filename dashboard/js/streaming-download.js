(function (global) {
    'use strict';

    var DEFAULT_STREAM_TO_DISK_THRESHOLD = 10 * 1024 * 1024; // 10 MB

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
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.innerHTML = SPINNER_SVG + '<span class="ml-2">' + label + '</span>';
    }

    function restoreButton(button, original) {
        if (!button) return;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        if (original !== undefined && original !== null) {
            button.innerHTML = original;
        }
    }

    function progressLabel(received, totalLength) {
        var sizeText = formatBytes(received);
        var pctText = totalLength
            ? ' (' + Math.min(99, Math.round((received / totalLength) * 100)) + '%)'
            : '';
        return 'Downloading ' + sizeText + pctText;
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
                return reg.active || (navigator.serviceWorker.controller || null);
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

    // True streaming path for Firefox / Safari: hand a ReadableStream off to a
    // service worker that returns it as an `attachment` Response. Returns null
    // (without consuming response.body) when the SW path is unavailable so the
    // caller can still fall back to the in-memory Blob path.
    async function streamResponseViaServiceWorker(response, filename, contentType, totalLength, button, onProgress) {
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
        return [{ description: 'Export file', accept: accept }];
    }

    // --- Progress UI / Toast helpers --------------------------------------

    var PROGRESS_CONTAINER_ID = 'streaming-download-progress-container';
    var TOAST_CONTAINER_ID = 'streaming-download-toast-container';
    var cardCounter = 0;

    function ensureProgressContainer() {
        if (typeof document === 'undefined' || !document.body) return null;
        var c = document.getElementById(PROGRESS_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = PROGRESS_CONTAINER_ID;
        c.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]';
        c.setAttribute('aria-live', 'polite');
        c.setAttribute('aria-label', 'Downloads in progress');
        document.body.appendChild(c);
        return c;
    }

    function ensureToastContainer() {
        if (typeof document === 'undefined' || !document.body) return null;
        var c = document.getElementById(TOAST_CONTAINER_ID);
        if (c) return c;
        c = document.createElement('div');
        c.id = TOAST_CONTAINER_ID;
        c.className = 'fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm';
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

        var nameText = document.createElement('span');
        nameText.className = 'font-medium truncate';
        nameText.textContent = filename || 'Download';
        nameText.title = filename || 'Download';
        nameText.setAttribute('data-testid', 'text-download-filename');
        nameWrap.appendChild(nameText);

        header.appendChild(nameWrap);

        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'text-xs font-medium text-red-600 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 rounded px-2 py-1 flex-shrink-0';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.setAttribute('aria-label', 'Cancel download of ' + (filename || 'file'));
        cancelBtn.setAttribute('data-testid', 'button-cancel-download');
        cancelBtn.addEventListener('click', function () {
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling…';
            try { if (typeof onCancel === 'function') onCancel(); } catch (_) {}
        });
        header.appendChild(cancelBtn);

        card.appendChild(header);

        var barWrap = document.createElement('div');
        barWrap.className = 'h-2 bg-gray-200 rounded overflow-hidden';
        barWrap.setAttribute('role', 'progressbar');
        barWrap.setAttribute('aria-valuemin', '0');
        barWrap.setAttribute('aria-valuemax', '100');
        barWrap.setAttribute('aria-label', 'Download progress for ' + (filename || 'file'));
        var bar = document.createElement('div');
        bar.className = 'h-full bg-blue-600 transition-all duration-150';
        bar.style.width = '0%';
        bar.setAttribute('data-testid', 'progress-download-bar');
        barWrap.appendChild(bar);
        card.appendChild(barWrap);

        var statusEl = document.createElement('div');
        statusEl.className = 'mt-1 text-xs text-gray-500 truncate';
        statusEl.setAttribute('data-testid', 'text-download-status');
        statusEl.textContent = 'Preparing…';
        card.appendChild(statusEl);

        container.appendChild(card);

        function setLabel(name) {
            nameText.textContent = name;
            nameText.title = name;
            barWrap.setAttribute('aria-label', 'Download progress for ' + name);
            cancelBtn.setAttribute('aria-label', 'Cancel download of ' + name);
        }

        function update(received, total) {
            var sizeText = formatBytes(received);
            if (total) {
                var pct = Math.min(100, Math.round((received / total) * 100));
                bar.style.width = pct + '%';
                barWrap.setAttribute('aria-valuenow', String(pct));
                statusEl.textContent = sizeText + ' / ' + formatBytes(total) + ' (' + pct + '%)';
            } else {
                // Indeterminate — approach 95% asymptotically as more bytes arrive.
                var visualPct = Math.min(95, Math.round((received / (received + 2 * 1024 * 1024)) * 100));
                bar.style.width = visualPct + '%';
                barWrap.removeAttribute('aria-valuenow');
                statusEl.textContent = sizeText + ' downloaded';
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

        return {
            el: card,
            setLabel: setLabel,
            update: update,
            setStatus: setStatus,
            disableCancel: disableCancel,
            hideCancel: hideCancel,
            setBarColor: setBarColor,
            remove: remove
        };
    }

    function showToast(message, type) {
        var container = ensureToastContainer();
        if (!container) return;
        var palette;
        switch (type) {
            case 'error':
                palette = 'bg-red-600 text-white';
                break;
            case 'info':
                palette = 'bg-blue-600 text-white';
                break;
            default:
                palette = 'bg-green-600 text-white';
        }
        var toast = document.createElement('div');
        toast.className = 'shadow-lg rounded-lg px-4 py-3 text-sm flex items-start gap-3 ' + palette;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toast.setAttribute('data-testid', 'toast-download-' + (type || 'success'));

        var msg = document.createElement('span');
        msg.className = 'flex-1 break-words';
        msg.textContent = message;
        toast.appendChild(msg);

        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'text-white/80 hover:text-white text-lg leading-none focus:outline-none focus:ring-2 focus:ring-white/60 rounded';
        close.innerHTML = '&times;';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.setAttribute('data-testid', 'button-dismiss-toast');
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
        close.addEventListener('click', dismiss);
        toast.appendChild(close);

        container.appendChild(toast);
        setTimeout(dismiss, type === 'error' ? 6000 : 4000);
    }

    // --- Streaming paths --------------------------------------------------

    // True streaming path: pipe response.body directly to a file handle so the
    // browser never holds the full document in memory.
    async function streamResponseToDisk(response, filename, contentType, button, card, onProgress, totalLength) {
        var handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types: pickerTypesFor(filename, contentType)
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                // Propagate user cancellation as-is so the caller can clean up.
                throw err;
            }
            // SecurityError (lost user activation), NotAllowedError, or any
            // other failure means we cannot stream to disk — let the caller
            // fall back to the in-memory Blob path with the body still intact.
            return null;
        }

        var writable = await handle.createWritable();
        var received = 0;

        var progressStream = new TransformStream({
            transform: function (chunk, controller) {
                received += chunk.byteLength || 0;
                if (button) {
                    setBusy(button, progressLabel(received, totalLength));
                }
                if (card) {
                    try { card.update(received, totalLength); } catch (_) { /* ignore */ }
                }
                if (onProgress) {
                    try { onProgress(received, totalLength); } catch (_) { /* ignore */ }
                }
                controller.enqueue(chunk);
            }
        });

        try {
            await response.body.pipeThrough(progressStream).pipeTo(writable);
        } catch (err) {
            try { await writable.abort(err); } catch (_) { /* ignore */ }
            throw err;
        }

        return { bytes: received, streamedToDisk: true };
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
            label = 'empty';
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
        var rowText = estimate.rows ? estimate.rows.toLocaleString() + ' rows' : 'no rows';
        var titleSuffix = 'Estimated ' + label + ' · ' + rowText;
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

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function () { attachSizeHints(); });
        } else {
            // Defer to next tick so call sites that load this script late
            // still have a chance to populate buttons before we scan.
            setTimeout(function () { attachSizeHints(); }, 0);
        }
    }

    async function streamingDownload(url, options) {
        options = options || {};
        var button = options.button || null;
        var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        var fetchInit = Object.assign({ credentials: 'same-origin' }, options.fetchInit || {});
        var showProgressUI = options.showProgressUI !== false;
        var showToastUI = options.showToast !== false;
        var cancellable = options.cancellable !== false;

        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        if (controller && !fetchInit.signal) {
            fetchInit.signal = controller.signal;
        }

        var initialFilename = options.filename || 'Preparing download…';
        var card = null;
        var cancelled = false;
        var originalContent = null;

        if (button) {
            originalContent = button.innerHTML;
            setBusy(button, 'Preparing…');
        }

        if (showProgressUI) {
            card = createProgressCard(initialFilename, function () {
                cancelled = true;
                if (controller) {
                    try { controller.abort(); } catch (_) { /* ignore */ }
                }
            });
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

        try {
            var response = await fetch(url, fetchInit);

            if (!response.ok) {
                var msg = 'Export failed (HTTP ' + response.status + ')';
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

            var filename = options.filename ||
                parseContentDispositionFilename(disposition) ||
                buildFallbackName(url, contentType);

            if (card) {
                card.setLabel(filename);
                card.update(0, totalLength);
            }

            var result = null;

            var wantStream = shouldStreamToDisk(options, totalLength);
            var allowServiceWorker = options.useServiceWorker !== false;

            if (supportsFileSystemAccess() && wantStream) {
                result = await streamResponseToDisk(
                    response, filename, contentType, button, card, onProgress, totalLength
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
                    response, filename, contentType, totalLength, button, onProgress
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
                card.setStatus('Done — ' + formatBytes(result.bytes));
                card.disableCancel();
                card.remove(2500);
            }

            if (showToastUI) {
                showToast('Downloaded ' + filename + ' (' + formatBytes(result.bytes) + ')', 'success');
            }

            return {
                filename: filename,
                bytes: result.bytes,
                type: contentType,
                streamedToDisk: !!result.streamedToDisk
            };
        } catch (err) {
            var isCancel = cancelled || (err && (err.name === 'AbortError' || err.cancelled === true));
            var displayName = options.filename || (card ? null : 'file');

            if (isCancel) {
                // User cancelled — quiet, no alert. Update UI to reflect cancellation.
                console.info('streamingDownload cancelled by user for', url);
                if (card) {
                    card.setBarColor('bg-gray-400');
                    card.setStatus('Cancelled');
                    card.disableCancel();
                    card.remove(2500);
                }
                if (showToastUI) {
                    showToast('Download cancelled' + (displayName ? ' (' + displayName + ')' : ''), 'info');
                }
                if (cancelled) {
                    var cancelErr = new Error('Download cancelled');
                    cancelErr.name = 'AbortError';
                    cancelErr.cancelled = true;
                    throw cancelErr;
                }
                throw err;
            }

            console.error('streamingDownload failed for', url, err);
            if (card) {
                card.setBarColor('bg-red-600');
                card.setStatus('Failed: ' + ((err && err.message) ? err.message : 'Unknown error'));
                card.disableCancel();
                card.remove(6000);
            }
            if (showToastUI) {
                showToast('Download failed: ' + ((err && err.message) ? err.message : 'Unknown error'), 'error');
            }
            throw err;
        } finally {
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
    streamingDownload.fetchEstimate = fetchExportEstimate;
    streamingDownload.estimateUrlFor = estimateUrlFor;
    streamingDownload.attachSizeHints = attachSizeHints;
    streamingDownload.applySizeHint = applySizeHint;
    streamingDownload.clearEstimateCache = clearEstimateCache;
    streamingDownload.formatBytes = formatBytes;
    streamingDownload._shouldStreamToDisk = shouldStreamToDisk;

    global.streamingDownload = streamingDownload;
    global.streamingDownloadFromEvent = streamingDownloadFromEvent;
    global.streamDownload = streamDownload;
    global.streamingDownloadProgress = {
        showToast: showToast
    };
})(window);
