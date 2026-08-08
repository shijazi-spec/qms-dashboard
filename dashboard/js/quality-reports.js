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

    async function qrLoadHub() {
        var host = document.getElementById('qrHub');
        try {
            var res = await fetch('/api/quality-reports/bus', { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            var bus = (data && data.bus) || [];
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
                    '</button>';
            }).join('');
        } catch (e) {
            host.innerHTML = '<div class="text-sm text-red-600">Failed to load business units: ' + escapeHtml(String((e && e.message) || e)) + '</div>';
        }
    }

    window.qrOpenBU = async function (buKey) {
        var host = document.getElementById('qrBU');
        document.getElementById('qrHub').classList.add('hidden');
        host.classList.remove('hidden');
        host.innerHTML = '<div class="rr-kpi-sub">Loading…</div>';
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey), { credentials: 'same-origin' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var payload = await res.json();
            qrRenderBU(payload);
        } catch (e) {
            host.innerHTML =
                '<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrBackToHub">← All units</button>' +
                '<div class="text-sm text-red-600">Failed to load report: ' + escapeHtml(String((e && e.message) || e)) + '</div>';
        }
    };

    window.qrBackToHub = function () {
        document.getElementById('qrBU').classList.add('hidden');
        document.getElementById('qrHub').classList.remove('hidden');
    };

    /** One stat tile in the summary strip. `accent` must be one of the valid rr-acc-* tokens. */
    function qrStatCard(accent, label, value, sub) {
        return '<div class="rr-kpi rr-kpi-rich rr-acc-' + accent + '">' +
            '<div class="rr-kpi-label">' + escapeHtml(label) + '</div>' +
            '<div class="rr-kpi-value">' + escapeHtml(value) + '</div>' +
            (sub ? '<div class="rr-kpi-sub">' + escapeHtml(sub) + '</div>' : '') +
            '</div>';
    }

    /** A detail card below the summary strip. Renders the "not configured" placeholder when unmapped. */
    function qrSection(title, bodyHtml, configured) {
        return '<div class="bg-white rounded-lg shadow p-4 mb-3">' +
            '<div class="font-semibold mb-2 text-gray-900">' + escapeHtml(title) + '</div>' +
            (configured
                ? (bodyHtml || '<div class="text-xs text-gray-500">No data.</div>')
                : '<div class="text-xs text-gray-500">Not configured yet — map this in Quality Reports settings.</div>') +
            '</div>';
    }

    function qrRenderBU(d) {
        var host = document.getElementById('qrBU');
        var bu = d.bu || {};
        var nc = d.notConfigured || [];
        var isCfg = function (name) { return nc.indexOf(name) === -1; };
        var s = d.sections || {};
        var parts = [];

        parts.push('<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrBackToHub">← All units</button>');
        parts.push('<h2 class="text-lg font-bold mb-1 text-gray-900">' + escapeHtml(bu.bu_name || bu.bu_key || '') + '</h2>');
        parts.push('<div class="text-xs text-gray-500 mb-4">' + escapeHtml((CHANNEL_LABEL[bu.channel] || bu.channel || '') + ' · segment ' + (bu.segment || '—') + ' · ' + (bu.fn || '')) + '</div>');

        // Summary strip — one tile per section, always the same 5 slots so the
        // page layout doesn't jump between BUs with different function maps.
        var stats = [];
        stats.push(qrStatCard('blue', 'SOPs', isCfg('sops') && s.sops ? String(s.sops.total != null ? s.sops.total : (s.sops.policies || []).length) : '—', 'controlled documents'));
        stats.push(qrStatCard('amber', 'KPIs', isCfg('kpis') && s.kpis ? (s.kpis.pct || 0) + '%' : '—', isCfg('kpis') && s.kpis ? (s.kpis.done || 0) + ' / ' + (s.kpis.total || 0) + ' done' : 'not mapped'));
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
        parts.push(qrSection('SOPs', s.sops ? qrSopsHtml(s.sops) : '', isCfg('sops')));
        parts.push(qrSection('KPIs', s.kpis ? qrKpisHtml(s.kpis) : '', isCfg('kpis')));
        parts.push(qrSection('Data cleanup', s.cleanup ? qrCleanupHtml(s.cleanup) : '', isCfg('cleanup')));
        parts.push(qrSection('Compliance', s.compliance ? qrComplianceHtml(s.compliance) : '', isCfg('compliance')));
        parts.push(qrSection('Open actions', s.actions ? qrActionsHtml(s.actions) : '', isCfg('actions')));

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

    function qrKpisHtml(k) {
        return '<div class="text-sm">' + (k.pct || 0) + '% (' + (k.done || 0) + '/' + (k.total || 0) + ')</div>';
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

    document.addEventListener('DOMContentLoaded', qrLoadHub);
})();
