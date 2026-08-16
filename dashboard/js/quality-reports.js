/**
 * quality-reports.js — Quality Reports Department Hub (Task 5: hub grid +
 * per-BU page view). Pure read view: fetches the BU list and one BU's
 * aggregated report (SOPs / KPIs / data cleanup / compliance / open actions)
 * built server-side by qualityReportsAggregator.ts (Task 3) and served by
 * qualityReportsRoutes.ts (Task 4). No writes happen from this page.
 *
 * escapeHtml/escAttr: this file is loaded as a standalone <script src>, so it
 * cannot assume another page's inline script already defined them. `escAttr`
 * normally comes from safe-actions.js (window.escAttr), which quality-reports
 * .html includes — but this file still defines a local fallback in case it's
 * ever reused on a page that doesn't. `escapeHtml` has no shared global
 * anywhere in the codebase (dashboard/consultant.html defines its own copy),
 * so it's always defined locally here — copied verbatim from consultant.html.
 */
(function () {
    'use strict';

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str == null ? '' : String(str)));
        return div.innerHTML;
    }
    if (typeof window.escAttr !== 'function') {
        window.escAttr = function (s) {
            return String(s == null ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        };
    }
    var escAttr = window.escAttr;

    var CHANNEL_LABEL = { B2B: 'B2B', B2C: 'B2C', MP: 'Marketplace' };

    // Populated by qrLoadHub from GET /api/quality-reports/bus. The admin
    // panel's Save handlers (qrSaveBU/qrSaveOwners) read a BU's immutable
    // fields (bu_key/bu_name/channel/fn/sort_order/is_active) out of this
    // list so the POST upsert never has to guess at what wasn't edited —
    // upsertBU()'s ON CONFLICT clause overwrites every column it's given
    // (including sort_order/is_active, which default to 0/true when
    // omitted), so re-sending the row's current values here is what keeps
    // a mapping-only save from silently resetting them.
    var qrCurrentBUs = [];

    // The BU currently open in the detail view — qrKpisHtml needs it to scope
    // the Add KPI action, and it is not part of the sections payload.
    var qrCurrentBUKey = null;

    // Mirrors WRITE_ROLES in qualityReportsRoutes.ts — the server is the
    // real gate (every write endpoint calls requireRole independently);
    // this list only decides whether the admin toggle button is shown.
    var ADMIN_ROLES = ['admin', 'grc_manager', 'head_of_operations_quality', 'quality_manager'];

    async function qrLoadHub() {
        var host = document.getElementById('qrHub');
        try {
            var res = await fetch('/api/quality-reports/bus', { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            var bus = (data && data.bus) || [];
            qrCurrentBUs = bus;
            qrRenderAdmin(bus);
            if (!bus.length) {
                host.innerHTML = '<div class="rr-note rr-note-info">No business units configured yet.</div>';
                return;
            }
            host.innerHTML = bus.map(function (b) {
                var channel = CHANNEL_LABEL[b.channel] || b.channel || '';
                return '<button type="button" class="rr-kpi rr-kpi-rich rr-acc-indigo text-left w-full" data-on-click="qrOpenBU" data-args="' + escAttr(JSON.stringify([b.bu_key])) + '">' +
                    '<div class="rr-kpi-label">' + escapeHtml(channel) + '</div>' +
                    '<div class="rr-kpi-value text-base leading-snug">' + escapeHtml(b.bu_name || b.bu_key) + '</div>' +
                    '<div class="rr-kpi-sub">' + escapeHtml(b.fn || '') + '</div>' +
                    '<div class="rr-sub" id="qr-hubline-' + escAttr(b.bu_key) + '"></div>' +
                    '</button>';
            }).join('');

            // Lazy hub status line: fetch each card's summary in the background
            // and fill in its status line once it arrives (never blocks the grid render).
            qrCurrentBUs.forEach(function (b) {
                fetch('/api/quality-reports/bus/' + encodeURIComponent(b.bu_key) + '/summary', { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (h) {
                        if (!h) return;
                        var el = document.getElementById('qr-hubline-' + b.bu_key);
                        if (!el) return;
                        var parts = [];
                        if (h.kpiPct != null) parts.push('KPIs ' + h.kpiPct + '%');
                        parts.push((h.outstanding || 0) + ' outstanding');
                        if (h.openCapas != null) parts.push(h.openCapas + ' open CAPAs');
                        el.textContent = parts.join(' · ');
                    })
                    .catch(function () { /* leave the status line blank */ });
            });

            // Deep-link: ?bu=<key> opens that BU directly.
            var params = new URLSearchParams(window.location.search);
            var wantBU = params.get('bu');
            if (wantBU && qrCurrentBUs.some(function (b) { return b.bu_key === wantBU; })) {
                qrOpenBU(wantBU);
            }
        } catch (e) {
            host.innerHTML = '<div class="text-sm text-red-600">Failed to load business units: ' + escapeHtml(String((e && e.message) || e)) + '</div>';
        }
    }

    /** Shows the admin toggle button only for roles that can actually write (server still re-checks on every call). */
    function qrCheckAdminAccess() {
        fetch('/api/auth/me', { credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : { authenticated: false }; })
            .then(function (data) {
                var role = (data && data.authenticated && data.user && data.user.role) || null;
                var btn = document.getElementById('qrAdminToggle');
                if (btn && role && ADMIN_ROLES.indexOf(role) !== -1) btn.classList.remove('hidden');
            })
            .catch(function () { /* fail closed — leave the toggle hidden */ });
    }

    window.qrToggleAdmin = function () {
        var panel = document.getElementById('qrAdminPanel');
        if (panel) panel.classList.toggle('hidden');
    };

    /** Rebuilds the admin panel's BU list. Safe to call even while the panel is hidden (cheap, keeps it in sync with qrLoadHub). */
    function qrRenderAdmin(bus) {
        var host = document.getElementById('qrAdminList');
        if (!host) return;
        if (!bus.length) {
            host.innerHTML = '<div class="rr-note rr-note-info">No business units configured yet.</div>';
            return;
        }
        host.innerHTML = bus.map(function (b) {
            var key = escAttr(b.bu_key);
            var channel = CHANNEL_LABEL[b.channel] || b.channel || '';
            var owners = (b.owners || []).join('\n');
            return '<div class="bg-white rounded-lg shadow p-4 mb-3">' +
                '<div class="font-semibold text-gray-900">' + escapeHtml(b.bu_name || b.bu_key) + '</div>' +
                '<div class="rr-kpi-sub mb-2">' + escapeHtml(b.bu_key + ' · ' + channel + ' · ' + (b.fn || '')) + '</div>' +
                '<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mb-2">' +
                '<label class="text-xs text-gray-600">Head email' +
                '<input type="email" id="qr-head-' + key + '" value="' + escAttr(b.head_email || '') + '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>' +
                '<label class="text-xs text-gray-600">SOP policy department' +
                '<input type="text" id="qr-pol-' + key + '" value="' + escAttr(b.policy_department || '') + '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>' +
                '<label class="text-xs text-gray-600" title="Framework action-plan checklist BU (QM-KPI-015) — drives the checklist % only.">KPI BU name <span class="text-gray-400">(checklist)</span>' +
                '<input type="text" id="qr-kpi-' + key + '" value="' + escAttr(b.kpi_bu_name || '') + '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>' +
                '<label class="text-xs text-gray-600" title="KPI catalog owner from /kpis, e.g. &quot;SDR Team&quot; or &quot;Sales Team&quot;. Drives the performance KPI list (most are auto-calculated from CRM). Leave blank if this BU has no catalog KPIs.">KPI owner <span class="text-gray-400">(catalog)</span>' +
                '<input type="text" id="qr-kpiowner-' + key + '" placeholder="e.g. SDR Team" value="' + escAttr(b.kpi_owner_name || '') + '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>' +
                '</div>' +
                '<div class="flex justify-end mb-3">' +
                '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrSaveBU" data-args="' + escAttr(JSON.stringify([b.bu_key])) + '">Save mapping</button>' +
                '</div>' +
                '<label class="text-xs text-gray-600 block mb-1">Owners (comma, semicolon or newline separated emails)</label>' +
                '<textarea id="qr-owners-' + key + '" rows="2" class="w-full border rounded px-2 py-1 text-sm">' + escapeHtml(owners) + '</textarea>' +
                '<div class="flex justify-end mt-2">' +
                '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrSaveOwners" data-args="' + escAttr(JSON.stringify([b.id, b.bu_key])) + '">Save owners</button>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    function qrVal(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }

    /** rrToast isn't defined on this page (it's a duplicates.html/duplicates-app.js helper) — fall back to a status span next to the admin panel heading. */
    function qrStatus(msg) {
        var el = document.getElementById('qrAdminStatus');
        if (!el) return;
        el.textContent = msg;
        clearTimeout(qrStatus._t);
        qrStatus._t = setTimeout(function () { el.textContent = ''; }, 5000);
    }

    window.qrSaveBU = async function (buKey) {
        var bu = qrCurrentBUs.find(function (b) { return b.bu_key === buKey; });
        if (!bu) return;
        var payload = {
            bu_key: bu.bu_key, bu_name: bu.bu_name, channel: bu.channel, fn: bu.fn,
            sort_order: bu.sort_order, is_active: bu.is_active,
            head_email: qrVal('qr-head-' + buKey), policy_department: qrVal('qr-pol-' + buKey),
            kpi_bu_name: qrVal('qr-kpi-' + buKey), kpi_owner_name: qrVal('qr-kpiowner-' + buKey)
        };
        try {
            var res = await fetch('/api/quality-reports/bus', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (!res.ok) {
                var err = await res.json().catch(function () { return {}; });
                qrStatus('Save failed: ' + (err.error || ('HTTP ' + res.status)));
                return;
            }
            if (typeof window.rrToast === 'function') { window.rrToast('Saved'); } else { qrStatus('Saved ' + (bu.bu_name || bu.bu_key)); }
            qrLoadHub();
        } catch (e) {
            qrStatus('Save failed: ' + String((e && e.message) || e));
        }
    };

    window.qrSaveOwners = async function (buId, buKey) {
        var raw = qrVal('qr-owners-' + buKey) || '';
        var owners = raw.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buId) + '/owners', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owners: owners }) });
            if (!res.ok) {
                var err = await res.json().catch(function () { return {}; });
                qrStatus('Owners save failed: ' + (err.error || ('HTTP ' + res.status)));
                return;
            }
            if (typeof window.rrToast === 'function') { window.rrToast('Owners saved'); } else { qrStatus('Owners saved (' + owners.length + ')'); }
            qrLoadHub();
        } catch (e) {
            qrStatus('Owners save failed: ' + String((e && e.message) || e));
        }
    };

    // Client-side ceiling for the per-BU report. Deliberately BELOW the hosting
    // proxy's own cutoff (~60s), so a slow report surfaces our own message with
    // a Retry button instead of the proxy's bare "HTTP 504" — which is what this
    // page used to show after sitting on "Loading…" for a minute. The server
    // bounds itself independently (QUALITY_REPORTS_SECTION_TIMEOUT_MS, 20s
    // default), so hitting this is already the abnormal path.
    var QR_REPORT_TIMEOUT_MS = 45000;

    window.qrOpenBU = async function (buKey) {
        qrCurrentBUKey = buKey;
        var host = document.getElementById('qrBU');
        document.getElementById('qrHub').classList.add('hidden');
        host.classList.remove('hidden');
        host.innerHTML = '<div class="rr-kpi-sub">Loading…</div>';
        var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        var timedOut = false;
        var timer = setTimeout(function () {
            timedOut = true;
            if (ctrl) ctrl.abort();
        }, QR_REPORT_TIMEOUT_MS);
        try {
            var opts = { credentials: 'same-origin' };
            if (ctrl) opts.signal = ctrl.signal;
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey), opts);
            clearTimeout(timer);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var payload = await res.json();
            qrRenderBU(payload);
            try { history.replaceState(null, '', '?bu=' + encodeURIComponent(buKey)); } catch (e2) {}
        } catch (e) {
            clearTimeout(timer);
            // A 504 means the proxy gave up on a still-running request — same
            // user-visible cause as our own abort, so give it the same advice.
            var isSlow = timedOut || (e && e.name === 'AbortError') ||
                /\b(504|502)\b/.test(String((e && e.message) || ''));
            var detail = isSlow
                ? 'This report took too long to build. It scans the full deal corpus for this segment, so it can time out while a CRM sync is running.'
                : 'Failed to load report: ' + escapeHtml(String((e && e.message) || e));
            host.innerHTML =
                '<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrBackToHub">← All units</button> ' +
                '<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrOpenBU" data-args="' + escAttr(JSON.stringify([buKey])) + '">↻ Retry</button>' +
                '<div class="text-sm ' + (isSlow ? 'text-amber-600' : 'text-red-600') + '">' + detail + '</div>';
        }
    };

    window.qrBackToHub = function () {
        document.getElementById('qrBU').classList.add('hidden');
        document.getElementById('qrHub').classList.remove('hidden');
        try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    };

    /**
     * Email-to-head preview modal. `.rr-modal-backdrop`/`.rr-modal` and
     * `.rr-btn-primary` aren't styled anywhere on this page (they're only
     * defined in duplicates.html) — quality-reports.html's own <style>
     * block adds class-based definitions for them below. The email HTML
     * itself is rendered inside a sandboxed <iframe srcdoc="..."> so its
     * own inline styles are isolated to that sub-document and never touch
     * this page's CSP-governed markup.
     */
    window.qrEmailBU = async function (buKey) {
        var host = document.getElementById('qrEmailModal');
        if (!host) { host = document.createElement('div'); host.id = 'qrEmailModal'; document.body.appendChild(host); }
        host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal"><div class="text-sm text-gray-500">Loading preview…</div></div></div>';
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/email-preview', { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var d = await res.json();
            var iframe = '<iframe sandbox="" class="qr-email-frame" srcdoc="' + escAttr(d.html) + '"></iframe>';
            host.innerHTML =
                '<div class="rr-modal-backdrop"><div class="rr-modal">' +
                    '<div class="font-semibold mb-1">' + escapeHtml(d.subject || 'Quality Report') + '</div>' +
                    '<div class="text-xs text-gray-500 mb-2">To: ' + escapeHtml(d.headEmail || '(no head email mapped)') + '</div>' +
                    iframe +
                    '<div class="flex gap-2 mt-3">' +
                        (d.headEmail ? '<button type="button" class="rr-btn rr-btn-primary" data-on-click="qrEmailSend" data-args="' + escAttr(JSON.stringify([buKey, 'head'])) + '">Send to ' + escapeHtml(d.headEmail) + '</button>' : '') +
                        '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrEmailSend" data-args="' + escAttr(JSON.stringify([buKey, 'self'])) + '">Send test to me</button>' +
                        '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrEmailClose">Cancel</button>' +
                    '</div>' +
                '</div></div>';
        } catch (e) {
            host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal"><div class="text-sm text-red-600">Preview failed: ' + escapeHtml(String((e && e.message) || e)) + '</div><button type="button" class="rr-btn rr-btn-ghost mt-2" data-on-click="qrEmailClose">Close</button></div></div>';
        }
    };

    window.qrEmailClose = function () {
        var h = document.getElementById('qrEmailModal');
        if (h) h.innerHTML = '';
    };

    /** rrToast isn't defined on this page (see qrStatus above) — success is silent (modal just closes) and failure falls back to alert(), same pattern as the rest of this file. */
    window.qrEmailSend = async function (buKey, mode) {
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/email', {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode })
            });
            var d = await res.json().catch(function () { return {}; });
            if (res.ok && d.success) {
                if (typeof window.rrToast === 'function') { window.rrToast('Sent to ' + (d.to || (mode === 'self' ? 'you' : 'head'))); }
                qrEmailClose();
            } else {
                var msg = d.error || 'Send failed';
                if (typeof window.rrToast === 'function') { window.rrToast(msg, 'error'); } else { alert(msg); }
            }
        } catch (e) {
            var failMsg = 'Send failed: ' + String((e && e.message) || e);
            if (typeof window.rrToast === 'function') { window.rrToast(failMsg, 'error'); } else { alert(failMsg); }
        }
    };

    /** One stat tile in the summary strip. `accent` must be one of the valid rr-acc-* tokens. */
    function qrStatCard(accent, label, value, sub) {
        return '<div class="rr-kpi rr-kpi-rich rr-acc-' + accent + '">' +
            '<div class="rr-kpi-label">' + escapeHtml(label) + '</div>' +
            '<div class="rr-kpi-value">' + escapeHtml(value) + '</div>' +
            (sub ? '<div class="rr-kpi-sub">' + escapeHtml(sub) + '</div>' : '') +
            '</div>';
    }

    /**
     * A detail card below the summary strip. Three states, kept distinct on
     * purpose: mapped-with-data, mapped-but-too-slow (server dropped it at its
     * section budget), and genuinely unmapped. Folding the timeout case into
     * "not configured" would tell the user to go fix a mapping that is fine.
     */
    function qrSection(title, bodyHtml, configured, didTimeOut) {
        var body;
        if (didTimeOut) {
            body = '<div class="text-xs text-amber-600">Timed out while building this section — the underlying scan is still running. Retry in a moment, or avoid running it during a CRM sync.</div>';
        } else if (configured) {
            body = bodyHtml || '<div class="text-xs text-gray-500">No data.</div>';
        } else {
            body = '<div class="text-xs text-gray-500">Not configured yet — map this in Quality Reports settings.</div>';
        }
        return '<div class="bg-white rounded-lg shadow p-4 mb-3">' +
            '<div class="font-semibold mb-2 text-gray-900">' + escapeHtml(title) + '</div>' +
            body +
            '</div>';
    }

    function qrRenderBU(d) {
        var host = document.getElementById('qrBU');
        var bu = d.bu || {};
        var nc = d.notConfigured || [];
        var to = d.timedOut || [];
        var isCfg = function (name) { return nc.indexOf(name) === -1; };
        var isTO = function (name) { return to.indexOf(name) !== -1; };
        var s = d.sections || {};
        var parts = [];

        parts.push('<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrBackToHub">← All units</button>');
        var hasHead = bu.head_email && String(bu.head_email).trim();
        parts.push('<button type="button" class="rr-btn rr-btn-ghost mb-3" ' + (hasHead ? '' : 'disabled title="Map a head email in settings first" ') + 'data-on-click="qrEmailBU" data-args="' + escAttr(JSON.stringify([bu.bu_key])) + '">✉ Email to head</button>');
        parts.push('<h2 class="text-lg font-bold mb-1 text-gray-900">' + escapeHtml(bu.bu_name || bu.bu_key || '') + '</h2>');
        parts.push('<div class="text-xs text-gray-500 mb-4">' + escapeHtml((CHANNEL_LABEL[bu.channel] || bu.channel || '') + ' · segment ' + (bu.segment || '—') + ' · ' + (bu.fn || '')) + '</div>');

        // Summary strip — one tile per section, always the same 5 slots so the
        // page layout doesn't jump between BUs with different function maps.
        var stats = [];
        stats.push(qrStatCard('blue', 'SOPs', isCfg('sops') && s.sops ? String(s.sops.total != null ? s.sops.total : (s.sops.policies || []).length) : '—', 'controlled documents'));
        // KPI card: prefer the PERFORMANCE KPIs (catalog rows for this BU's
        // team) when the BU has them, and fall back to framework-checklist
        // progress otherwise. Previously it always showed the checklist,
        // which is why a BU with six live KPIs still read "0% — 0 / 0 done".
        var kpiVal = '—', kpiSub = 'not mapped';
        if (isCfg('kpis') && s.kpis) {
            if ((s.kpis.kpiCount || 0) > 0) {
                kpiVal = (s.kpis.kpiOnTarget || 0) + ' / ' + (s.kpis.kpiMeasured || 0);
                kpiSub = 'on target · ' + (s.kpis.kpiCount || 0) + ' KPIs';
            } else if (s.kpis.framework) {
                kpiVal = (s.kpis.framework.pct || 0) + '%';
                kpiSub = (s.kpis.framework.done || 0) + ' / ' + (s.kpis.framework.total || 0) + ' checklist done';
            }
        }
        stats.push(qrStatCard('amber', 'KPIs', kpiVal, kpiSub));
        var cleanupTotal = null;
        if (isCfg('cleanup') && s.cleanup) {
            var dm = (s.cleanup.deals && s.cleanup.deals.modules) || null;
            var dealsMerged = dm && dm.Deals ? (dm.Deals.verified_merges || 0) : 0;
            var acctMerged = dm && dm.Accounts ? (dm.Accounts.verified_merges || 0) : 0;
            var leadsOut = s.cleanup.leads ? (s.cleanup.leads.outstanding_leads || 0) : 0;
            cleanupTotal = dealsMerged + acctMerged;
            stats.push(qrStatCard('teal', 'Data cleanup', String(cleanupTotal), (dm ? 'verified merges' : '') + (s.cleanup.leads ? (dm ? ' · ' : '') + leadsOut + ' leads outstanding' : '')));
        } else {
            stats.push(qrStatCard('teal', 'Data cleanup', '—', 'not mapped'));
        }
        if (isCfg('compliance') && s.compliance) {
            var csV = s.compliance.cs && s.compliance.cs.summary ? (s.compliance.cs.summary.total_violations || 0) : 0;
            var saV = s.compliance.stageAging && s.compliance.stageAging.summary ? (s.compliance.stageAging.summary.total_violations || 0) : 0;
            stats.push(qrStatCard('red', 'Compliance', String(csV + saV), 'open violations'));
        } else {
            stats.push(qrStatCard('red', 'Compliance', '—', 'not mapped'));
        }
        stats.push(qrStatCard('indigo', 'Open actions', isCfg('actions') && s.actions ? String(s.actions.openCapas || 0) : '—', isCfg('actions') && s.actions ? 'open CAPAs' : 'not mapped'));
        parts.push('<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">' + stats.join('') + '</div>');

        // Detail cards.
        parts.push(qrSection('SOPs', s.sops ? qrSopsHtml(s.sops) : '', isCfg('sops'), isTO('sops')));
        parts.push(qrSection('KPIs', s.kpis ? qrKpisHtml(s.kpis) : '', isCfg('kpis'), isTO('kpis')));
        parts.push(qrSection('Data cleanup', s.cleanup ? qrCleanupHtml(s.cleanup) : '', isCfg('cleanup'), isTO('cleanup')));
        parts.push(qrSection('Compliance', s.compliance ? qrComplianceHtml(s.compliance) : '', isCfg('compliance'), isTO('compliance')));
        parts.push(qrSection('Open actions', s.actions ? qrActionsHtml(s.actions) : '', isCfg('actions'), isTO('actions')));

        host.innerHTML = parts.join('');
    }

    function qrSopsHtml(sops) {
        var policies = sops.policies || sops.records || [];
        var total = sops.total != null ? sops.total : policies.length;
        var out = ['<div class="text-sm mb-2">' + total + ' controlled document' + (total === 1 ? '' : 's') + '</div>'];
        if (policies.length) {
            out.push('<ul class="text-xs text-gray-600 space-y-1">');
            policies.slice(0, 6).forEach(function (p) {
                var num = p.document_number || p.policy_number || '';
                out.push('<li>' + (num ? '<span class="rr-kpi-sub">' + escapeHtml(num) + '</span> ' : '') + escapeHtml(p.title || '(untitled)') +
                    (p.status ? ' <span class="text-gray-400">· ' + escapeHtml(p.status) + '</span>' : '') + '</li>');
            });
            out.push('</ul>');
            if (policies.length > 6) out.push('<div class="rr-kpi-sub mt-1">+ ' + (policies.length - 6) + ' more</div>');
        }
        return out.join('');
    }

    // RAG dot colours match the /kpis catalog so the same KPI reads the same
    // in both places. 'none' = no value recorded yet (render "Not started"
    // rather than a red zero, which would look like a missed target).
    var QR_RAG = {
        green: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'On target' },
        amber: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Watch' },
        red: { dot: 'bg-red-500', text: 'text-red-700', label: 'Behind' },
        none: { dot: 'bg-gray-300', text: 'text-gray-500', label: 'Not started' }
    };

    function qrKpiValue(k) {
        if (k.current_value === null || k.current_value === undefined) return '--';
        var n = Number(k.current_value);
        var v = Number.isInteger(n) ? String(n) : n.toFixed(1);
        return v + (k.unit && k.unit !== 'number' ? k.unit : '');
    }

    function qrKpisHtml(k) {
        var out = [];
        var list = (k && k.list) || [];

        // Performance KPIs (the catalog rows for this BU's owning team).
        if (list.length) {
            out.push(
                '<div class="text-xs text-gray-500 mb-2">' +
                escapeHtml(k.owner || 'Team') + ' &middot; ' +
                (k.kpiOnTarget || 0) + ' on target of ' + (k.kpiMeasured || 0) + ' measured' +
                ((k.kpiCount || 0) > (k.kpiMeasured || 0)
                    ? ' <span class="text-gray-400">(' + ((k.kpiCount || 0) - (k.kpiMeasured || 0)) + ' not started)</span>'
                    : '') +
                '</div>'
            );
            // Department KPIs live only here now, so this page must be able to
            // create them. Owner is set server-side from the BU mapping.
            if (k && k.owner) {
                out.push('<div class="mb-2"><button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrAddKpi" data-args="' +
                    escAttr(JSON.stringify([qrCurrentBUKey, k.owner])) + '">+ Add KPI</button></div>');
            }
            var rows = list.map(function (i) {
                var rag = QR_RAG[i.rag] || QR_RAG.none;
                // Department KPIs are no longer in the KPI Engine, so this is
                // the only route to their detail/editor page. Rows without an
                // id render as plain divs rather than dead links.
                var open = i.id ? '<a href="/kpi/' + encodeURIComponent(i.id) + '" class="block hover:bg-gray-50 -mx-2 px-2 rounded">' : '';
                var close = i.id ? '</a>' : '';
                return open + '<div class="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">' +
                    '<span class="w-2 h-2 rounded-full ' + rag.dot + ' shrink-0"></span>' +
                    '<div class="min-w-0 flex-1">' +
                        '<div class="text-sm text-gray-900 truncate">' + escapeHtml(i.kpi_name || '') +
                            ' <span class="text-xs text-gray-400">' + escapeHtml(i.kpi_code || '') + '</span>' +
                            (i.calc_mode === 'auto'
                                ? ' <span class="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-600" title="Calculated automatically from CRM data">Auto</span>'
                                : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="text-right shrink-0">' +
                        '<div class="text-sm font-semibold ' + rag.text + '">' + escapeHtml(qrKpiValue(i)) + '</div>' +
                        '<div class="text-[10px] text-gray-400">' +
                            (i.target_value !== null && i.target_value !== undefined
                                ? 'Target ' + escapeHtml(String(i.target_value)) + (i.unit && i.unit !== 'number' ? escapeHtml(i.unit) : '')
                                : escapeHtml(rag.label)) +
                        '</div>' +
                    '</div>' +
                '</div>' + close;
            });
            out.push('<div class="mb-3">' + rows.join('') + '</div>');
        } else if (k && k.owner) {
            out.push('<div class="text-xs text-gray-500 mb-3">No active KPIs found for ' + escapeHtml(k.owner) + '.</div>');
        }

        // Framework/action-plan checklist progress — kept alongside the KPIs
        // per Sarah 2026-08-16. Labelled explicitly so it can't be mistaken
        // for KPI performance (the two used to share one ambiguous "0%").
        var f = k && k.framework;
        if (f) {
            out.push(
                '<div class="text-xs text-gray-500 pt-1' + (list.length ? ' border-t border-gray-100' : '') + '">' +
                'Framework checklist: <span class="font-medium text-gray-700">' + (f.pct || 0) + '%</span> ' +
                '(' + (f.done || 0) + '/' + (f.total || 0) + ' done)' +
                '</div>'
            );
        }

        return out.join('') || '<div class="text-xs text-gray-500">No KPI data.</div>';
    }

    function qrCleanupHtml(c) {
        var out = [];
        if (c.deals && c.deals.modules) {
            var dealsMerged = (c.deals.modules.Deals && c.deals.modules.Deals.verified_merges) || 0;
            var acctMerged = (c.deals.modules.Accounts && c.deals.modules.Accounts.verified_merges) || 0;
            out.push('<div class="text-sm">Deals removed (verified merges): ' + dealsMerged + ' · Accounts: ' + acctMerged + '</div>');
        }
        if (c.leads) out.push('<div class="text-sm">Outstanding duplicate leads: ' + (c.leads.outstanding_leads || 0) + '</div>');
        return out.join('') || '<div class="text-xs text-gray-500">No cleanup data.</div>';
    }

    function qrComplianceHtml(c) {
        var out = [];
        if (c.cs && c.cs.summary) out.push('<div class="text-sm">CS Lifecycle violations: ' + (c.cs.summary.total_violations || 0) + (c.phaseFocus ? ' (focus: ' + escapeHtml(c.phaseFocus) + ')' : '') + '</div>');
        if (c.stageAging && c.stageAging.summary) out.push('<div class="text-sm">Deal stage-aging violations: ' + (c.stageAging.summary.total_violations || 0) + '</div>');
        if (c.dealCompliance) {
            var dc = c.dealCompliance;
            if (dc.checked > 0) {
                var fmtSar = function (n) { return 'SAR ' + (Number(n) || 0).toLocaleString(); };
                out.push('<div class="text-sm">Deal docs: ' + (dc.compliant || 0) + '/' + dc.checked + ' compliant (' + (dc.compliant_rate == null ? '—' : dc.compliant_rate + '%') + ') · At-risk (missing docs): ' + fmtSar(dc.at_risk_sar) + '</div>');
                // By stage
                if (dc.by_stage && dc.by_stage.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">By stage</div>');
                    out.push('<table class="rr-table"><thead><tr><th>Stage</th><th>Checked</th><th>Compliant</th><th>Missing</th></tr></thead><tbody>' +
                        dc.by_stage.map(function (s) { return '<tr><td>' + escapeHtml(s.stage) + '</td><td>' + s.checked + '</td><td>' + s.compliant + '</td><td>' + s.missing + '</td></tr>'; }).join('') +
                        '</tbody></table>');
                }
                // By owner (top 10)
                if (dc.by_owner && dc.by_owner.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">By owner (top 10)</div>');
                    out.push('<table class="rr-table"><thead><tr><th>Owner</th><th>Checked</th><th>Compliant</th><th>Missing</th></tr></thead><tbody>' +
                        dc.by_owner.map(function (o) { return '<tr><td>' + escapeHtml(o.owner) + '</td><td>' + o.checked + '</td><td>' + o.compliant + '</td><td>' + o.missing + '</td></tr>'; }).join('') +
                        '</tbody></table>');
                    if (dc.owner_overflow > 0) out.push('<div class="text-xs text-gray-400">and ' + dc.owner_overflow + ' more owners</div>');
                }
                // Top missing docs
                if (dc.top_missing_docs && dc.top_missing_docs.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">Top missing documents</div><ul class="text-sm">' +
                        dc.top_missing_docs.slice(0, 6).map(function (m) { return '<li>' + escapeHtml(m.label) + ' — ' + m.count + '</li>'; }).join('') + '</ul>');
                }
            } else {
                out.push('<div class="text-sm rr-sub">Deal docs: no deals checked yet</div>');
            }
        }
        return out.join('') || '<div class="text-xs text-gray-500">No compliance data.</div>';
    }

    function qrActionsHtml(a) {
        var out = ['<div class="text-sm mb-2">' + (a.openCapas || 0) + ' open CAPA' + ((a.openCapas || 0) === 1 ? '' : 's') + '</div>'];
        var capas = a.capas || [];
        if (capas.length) {
            out.push('<ul class="text-xs text-gray-600 space-y-1 mb-2">');
            capas.slice(0, 6).forEach(function (r) {
                out.push('<li>' + escapeHtml(r.capa_number || '') + ' — ' + escapeHtml(r.title || '(untitled)') +
                    (r.severity ? ' <span class="text-gray-400">· ' + escapeHtml(r.severity) + '</span>' : '') + '</li>');
            });
            out.push('</ul>');
            if (capas.length > 6) out.push('<div class="rr-kpi-sub mb-2">+ ' + (capas.length - 6) + ' more</div>');
        }
        var owners = a.ownerAccountability || [];
        if (owners.length) {
            var ragClass = { green: 'text-green-600', amber: 'text-amber-600', red: 'text-red-600' };
            out.push('<div class="text-xs font-medium text-gray-700 mt-2 mb-1">Owner accountability</div>');
            out.push('<ul class="text-xs text-gray-600 space-y-1">');
            owners.slice(0, 8).forEach(function (o) {
                out.push('<li>' + escapeHtml(o.owner_name || o.owner_email || '') +
                    ' <span class="' + (ragClass[o.rag_status] || 'text-gray-400') + '">(' + escapeHtml(o.rag_status || '') + ')</span></li>');
            });
            out.push('</ul>');
        }
        return out.join('');
    }

    window.qrAddKpi = function (buKey, ownerName) {
        var host = document.getElementById('qrKpiModal');
        if (!host) { host = document.createElement('div'); host.id = 'qrKpiModal'; document.body.appendChild(host); }
        var f = function (id, label, value, type) {
            return '<label class="text-xs text-gray-600 block mb-2">' + escapeHtml(label) +
                '<input id="' + escAttr(id) + '" type="' + (type || 'text') + '" value="' + escAttr(value || '') +
                '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>';
        };
        host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal">' +
            '<div class="font-semibold mb-1">Add KPI</div>' +
            '<div class="text-xs text-gray-500 mb-3">Owner: ' + escapeHtml(ownerName) + ' (set automatically)</div>' +
            f('qrk-name', 'KPI name', '') +
            f('qrk-code', 'KPI code (e.g. SDR-KPI-12)', '') +
            f('qrk-cat', 'Category', 'quality') +
            f('qrk-unit', 'Unit', '%') +
            f('qrk-target', 'Target value', '', 'number') +
            f('qrk-green', 'Green threshold', '', 'number') +
            f('qrk-amber', 'Amber threshold', '', 'number') +
            f('qrk-red', 'Red threshold', '', 'number') +
            '<label class="text-xs text-gray-600 block mb-2">Direction' +
            '<select id="qrk-dir" class="mt-1 w-full border rounded px-2 py-1 text-sm">' +
            '<option value="higher_is_better">Higher is better</option>' +
            '<option value="lower_is_better">Lower is better</option></select></label>' +
            '<div id="qrk-err" class="text-xs text-red-600 mb-2"></div>' +
            '<div class="flex gap-2 mt-2">' +
            '<button type="button" class="rr-btn rr-btn-primary" data-on-click="qrAddKpiSave" data-args="' + escAttr(JSON.stringify([buKey])) + '">Create</button>' +
            '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrAddKpiClose">Cancel</button>' +
            '</div></div></div>';
    };

    window.qrAddKpiClose = function () {
        var h = document.getElementById('qrKpiModal');
        if (h) h.innerHTML = '';
    };

    window.qrAddKpiSave = async function (buKey) {
        var err = document.getElementById('qrk-err');
        var payload = {
            kpi_name: qrVal('qrk-name'), kpi_code: qrVal('qrk-code'),
            category: qrVal('qrk-cat'), unit: qrVal('qrk-unit'),
            target_value: qrVal('qrk-target'), threshold_green: qrVal('qrk-green'),
            threshold_amber: qrVal('qrk-amber'), threshold_red: qrVal('qrk-red'),
            threshold_direction: qrVal('qrk-dir')
        };
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/kpis', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            var d = await res.json().catch(function () { return {}; });
            if (!res.ok) { if (err) err.textContent = d.error || ('HTTP ' + res.status); return; }
            qrAddKpiClose();
            qrOpenBU(buKey);
        } catch (e) {
            if (err) err.textContent = String((e && e.message) || e);
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        qrLoadHub();
        qrCheckAdminAccess();
    });
})();
