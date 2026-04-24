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

    // True streaming path: pipe response.body directly to a file handle so the
    // browser never holds the full document in memory.
    async function streamResponseToDisk(response, filename, contentType, button, onProgress, totalLength) {
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
    async function bufferResponseAndDownload(response, filename, contentType, button, onProgress, totalLength) {
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
                    if (onProgress) {
                        try { onProgress(received, totalLength); } catch (_) { /* ignore */ }
                    }
                }
            }
        } else {
            var buf = await response.arrayBuffer();
            chunks.push(new Uint8Array(buf));
            received = buf.byteLength;
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

    // Estimate helpers: each export endpoint exposes a sibling `/estimate`
    // route returning { rows, bytes, format }. We cache results briefly and
    // use the bytes to (a) skip the picker for small downloads and (b) show
    // an "≈ X MB" hint on the button.
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
        var originalContent = null;

        if (button) {
            originalContent = button.innerHTML;
            setBusy(button, 'Preparing…');
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

            var result = null;

            if (supportsFileSystemAccess() && shouldStreamToDisk(options, totalLength)) {
                result = await streamResponseToDisk(
                    response, filename, contentType, button, onProgress, totalLength
                );
                // result === null means the picker call failed in a recoverable
                // way (e.g. lost user activation) and the body is still intact,
                // so we transparently fall through to the in-memory path.
            }

            if (!result) {
                result = await bufferResponseAndDownload(
                    response, filename, contentType, button, onProgress, totalLength
                );
            }

            return {
                filename: filename,
                bytes: result.bytes,
                type: contentType,
                streamedToDisk: !!result.streamedToDisk
            };
        } catch (err) {
            if (err && err.name === 'AbortError') {
                // User cancelled the save dialog — quiet, no alert.
                console.info('streamingDownload cancelled by user for', url);
                throw err;
            }
            console.error('streamingDownload failed for', url, err);
            try {
                window.alert('Download failed: ' + ((err && err.message) ? err.message : 'Unknown error'));
            } catch (_) { /* ignore */ }
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
})(window);
