(function (global) {
    'use strict';

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

            var filename = options.filename ||
                parseContentDispositionFilename(disposition) ||
                buildFallbackName(url, contentType);

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
                            var sizeText = formatBytes(received);
                            var pctText = totalLength
                                ? ' (' + Math.min(99, Math.round((received / totalLength) * 100)) + '%)'
                                : '';
                            setBusy(button, 'Downloading ' + sizeText + pctText);
                        }
                        if (onProgress) {
                            try { onProgress(received, totalLength); } catch (_) {}
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

            return { filename: filename, bytes: received, type: contentType };
        } catch (err) {
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

    global.streamingDownload = streamingDownload;
    global.streamingDownloadFromEvent = streamingDownloadFromEvent;
    global.streamDownload = streamDownload;
})(window);
