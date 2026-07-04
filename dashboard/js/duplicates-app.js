/* Duplicate Radar app script — extracted from duplicates.html (perf: cacheable, smaller HTML). Classic (non-module) script: top-level function declarations stay global so safe-actions data-on-click dispatch keeps working. */
        const _fd = (d, opts) => window.WalaPlusI18n ? WalaPlusI18n.formatDate(d, opts) : (d ? new Date(d).toLocaleDateString() : '-');
        const _fn = (n) => window.WalaPlusI18n ? WalaPlusI18n.formatNumber(n) : String(n);
        function _runWhenI18nReady(fn) { if (window.WalaPlusI18n && typeof WalaPlusI18n.onReady === 'function') WalaPlusI18n.onReady(fn); else fn(); }
        let summary = {};
        let sourceChart = null;
        let confidenceChart = null;
        // Tracks which heavy tabs (clusters, leads, deals, contacts, accounts)
        // have already fetched their data this refresh cycle. Initialised at
        // module scope so showTab can safely consult it even if the user
        // clicks a tab before refreshData has run. refreshData clears it so
        // the next click on each tab re-fetches.
        window._loadedTabs = window._loadedTabs || new Set();
        // R4: creation-rate trend chart instance (lazily created on first
        // render so it can be destroyed + rebuilt when the window selector
        // changes without leaking canvases).
        let creationTrendChart = null;
        // R6: cross-module triage state. crossModuleClusters caches the
        // full server response so chip-filter clicks don't refetch.
        let crossModuleClusters = [];
        let crossModuleByPairing = {};
        let crossModuleFilter = 'all';
        // Follow-up 3: selection state for the bulk-close-leads action.
        // Stored as a Set so add/remove is O(1) and we can do quick
        // membership checks during render.
        const crossModuleSelected = new Set();
        let clusterPage = 0;
        // R7 (quick-wins): SSE replaces 2s polling for scan progress.
        // scanProgressSse holds the active EventSource; scanRunning tracks
        // whether we're tracking a scan so the page can resume the UI on
        // refresh-mid-scan via attachScanProgressIfRunning().
        let scanProgressSse = null;
        let scanRunning = false;
        let scanStartedAt = null;
        let scanElapsedTicker = null;

        function getDateRange() {
            const from = document.getElementById('filterDateFrom').value;
            const to = document.getElementById('filterDateTo').value;
            return { from: from || null, to: to || null };
        }

        // The duplicate radar fans out a *lot* of API calls per paint
        // (summary + logs + owners + clusters + 4 record tabs + sparkline +
        // creation-trend + cross-module + nav notifications, plus polls).
        // The per-user READ_LIMIT is 100/min — eagerly hitting every tab on
        // every refresh blew through that within a couple of refreshes,
        // and the silent-empty error path made the dashboard look like it
        // had no data at all.
        //
        // Strategy: load the tab the user can actually see, and defer the
        // rest until the user clicks into them (showTab lazy-loads). The
        // Domain Clusters + 4 record tabs are the heaviest queries and only
        // one of them is ever visible, so this cuts ~5 fetches per paint.
        async function refreshData() {
            // The visible Refresh button is the global one in the top
            // header (rendered by navigation.js); it handles its own
            // spinner/disabled state and awaits this function.
            //
            // Refresh invalidates every lazy tab so the next click reloads
            // it from the server instead of showing pre-refresh data.
            if (window._loadedTabs) window._loadedTabs.clear();

            const activeTabEl = document.querySelector('[id^="tab-"].tab-active');
            const activeTab = activeTabEl ? activeTabEl.id.replace(/^tab-/, '') : 'summary';

            try {
                await fetch('/api/duplicates/recalculate-stats', { method: 'POST' }).catch(() => {});
                // Always-on summary essentials — these power the KPI cards
                // and the Logs / Owners tabs (which can render off cached
                // data; the actual tabs lazy-load if missing).
                const [summaryRes, logsRes, ownerAccRes] = await Promise.all([
                    fetch('/api/duplicates/summary'),
                    fetch('/api/duplicates/logs'),
                    fetch('/api/duplicates/owner-accountability')
                ]);

                summary = await summaryRes.json();
                const logsData = await logsRes.json();
                const ownerAccData = await ownerAccRes.json();

                // Marketplace / Corporate segment overlay — when the operator
                // has picked a non-default segment, fetch the segment-aware
                // tiles from filtered-summary and overlay them onto the
                // all-up summary so the Executive headline cards reflect the
                // selected slice. KPI rate cards and resolution-rate stay
                // all-up (they're whole-population denominators).
                try {
                    const seg = document.getElementById('filterSegment')?.value || 'all';
                    if (seg !== 'all' && summary) {
                        const fsRes = await fetch('/api/duplicates/filtered-summary?segment=' + encodeURIComponent(seg));
                        if (fsRes.ok) {
                            const fs = await fsRes.json();
                            // Only overlay the fields filtered-summary actually
                            // computes under the filter — leave the deeper KPIs
                            // (rates / resolution / overall) at their all-up
                            // values rather than fabricate segment-aware ones.
                            if (fs && typeof fs === 'object') {
                                if (fs.totalClusters != null) summary.trueDuplicateClusters = fs.totalClusters;
                                if (fs.totalClusters != null) summary.totalClusters = fs.totalClusters;
                                if (fs.highConfidence != null) summary.highConfidence = fs.highConfidence;
                                if (fs.mediumConfidence != null) summary.mediumConfidence = fs.mediumConfidence;
                                if (fs.lowConfidence != null) summary.lowConfidence = fs.lowConfidence;
                                if (fs.estimatedPipelineInflation != null) summary.estimatedPipelineInflation = fs.estimatedPipelineInflation;
                                if (fs.totalDuplicateLeads != null) summary.totalDuplicateLeads = fs.totalDuplicateLeads;
                                if (fs.totalDuplicateDeals != null) summary.totalDuplicateDeals = fs.totalDuplicateDeals;
                                if (fs.totalDuplicateContacts != null) summary.totalDuplicateContacts = fs.totalDuplicateContacts;
                                if (fs.totalDuplicateAccounts != null) summary.totalDuplicateAccounts = fs.totalDuplicateAccounts;
                                summary._segmentApplied = seg;
                            }
                        }
                    }
                } catch (e) { /* segment overlay is best-effort */ }

                updateSummary(summary);
                renderLogs(logsData.logs || []);
                renderOwners(ownerAccData.owners || []);
                populateLayoutFilter();

                // Load ONLY the active tab's heavy data. Other heavy tabs
                // (Domain Clusters + lead/deal/contact/account record tabs)
                // are loaded on first click by showTab().
                if (activeTab === 'clusters') {
                    await loadClusters();
                } else if (['leads','deals','contacts','accounts'].includes(activeTab)) {
                    await loadRecordTab(activeTab);
                } else if (activeTab === 'cs-lifecycle') {
                    // Sync the visible deals live from Zoho the same way the
                    // green "Refresh from Zoho (live)" button does, so the
                    // CS Lifecycle radar stays consistent with the other
                    // radars (which already read from a fresh Zoho scan via
                    // Sync Now). loadCsLifecycle runs first to populate the
                    // visible-id list that refreshCsLifecycleFromZoho needs.
                    await loadCsLifecycle(window._csLifecycleFilter || 'all');
                    await refreshCsLifecycleFromZoho({ silent: true });
                } else if (activeTab === 'cs-overlap') {
                    loadCsOverlap(window._csOverlapFilter || 'all');
                } else if (activeTab === 'deal-lifecycle') {
                    loadDealLifecycle();
                } else if (activeTab === 'account-hints') {
                    loadAccountHints();
                }
                // summary / logs / owners / search tabs need no extra work —
                // summary essentials above already populated them.
            } catch (error) {
                console.error('Error refreshing data:', error);
            }
            // Load sparkline outside the try so it still renders even if summary calls fail
            loadClustersTrendSparkline();
            // R4: load creation-rate trend chart (independent of the rest;
            // a transient failure here shouldn't blank the dashboard).
            loadCreationTrend();
            // R6: load cross-module overlap counts so the tab badge + KPI
            // cards reflect current state on every refresh.
            loadCrossModule();
            // Per-tab snapshot scorecard — same fire-and-forget pattern;
            // each tile renders its own error state on failure so a slow
            // sub-tab scanner can't block the rest of the Executive
            // Summary tab.
            loadRadarOverview();
        }

        // Register page-level refresh hook so the global Refresh button in
        // the top header (navigation.js → WalaPlusNav.refreshDashboard) runs
        // our smart refresh — summary + active tab — instead of a full page
        // reload.
        window.refreshDashboard = refreshData;

        // R6: pairing labels and per-pairing recommended action — kept in
        // one place so the badge / chip / table all stay consistent.
        // Refined-rule labels (Sarah 2026-06-16). lead_contact / lead_account
        // entries are kept ONLY so a stale cluster carrying those pairings
        // still renders without crashing — they should no longer leave the
        // backend filter, and the chips for them have been removed.
        const CROSS_MODULE_PAIRING_LABELS = {
            lead_contact:   { label: 'Lead ↔ Contact',   chip: 'cmoChip-lead_contact',   action: 'Handle in the Leads Duplicates tab (close the Lead).' },
            lead_account:   { label: 'Lead ↔ Account',   chip: 'cmoChip-lead_account',   action: 'Handle in the Leads Duplicates tab (close the Lead).' },
            lead_deal:      { label: 'Lead ↔ Active Deal', chip: 'cmoChip-lead_deal',    action: 'Close the redundant Lead — Sales is already pursuing the active Deal.' },
            contact_account:{ label: 'Contact ↔ Account', chip: 'cmoChip-contact_account', action: 'Link Contact: set Account_Name to the existing Account.' },
            contact_deal:   { label: 'Contact ↔ Deal',   chip: 'cmoChip-contact_deal',   action: 'Link Deal: set Contact_Name to the existing Contact.' },
            deal_account:   { label: 'Deal ↔ Account',   chip: 'cmoChip-deal_account',   action: 'Link Deal: set Account_Name to the existing Account.' },
            mixed:          { label: '3+ modules',       chip: 'cmoChip-mixed',          action: 'Compound case — open the cluster to see per-record recommendations.' },
        };

        // Tracks the last load outcome so the empty-state row can explain
        // *why* the table is empty (auth, server error, or genuinely zero
        // overlaps) instead of always showing the same "No cross-module
        // overlaps in this view." message. Repeated empty fetches were
        // indistinguishable from a 401 / 500 silent failure before.
        let crossModuleLoadError = null;
        async function loadCrossModule() {
            crossModuleLoadError = null;
            try {
                // limit=100000 → load the WHOLE cross-module dataset (the old
                // default of 200 silently hid overlaps). The table paginates
                // client-side, so loading everything is fine. status drives the
                // Open / Resolved / Dismissed / All filter.
                const _cmStatus = window._crossModuleStatusFilter || 'active';
                const res = await fetch('/api/duplicates/cross-module-overlaps?limit=100000&status=' + encodeURIComponent(_cmStatus), { credentials: 'same-origin' });
                if (!res.ok) {
                    let body = '';
                    try { body = (await res.text()).slice(0, 200); } catch (_) {}
                    crossModuleLoadError = `HTTP ${res.status} from /api/duplicates/cross-module-overlaps${body ? ' — ' + body : ''}`;
                    console.error('cross-module load failed:', crossModuleLoadError);
                    crossModuleClusters = [];
                    crossModuleByPairing = {};
                    updateCrossModuleKpis({});
                    updateCrossModuleBadge();
                    renderCrossModuleTable();
                    return;
                }
                const data = await res.json();
                crossModuleClusters = Array.isArray(data && data.clusters) ? data.clusters : [];
                crossModuleByPairing = (data && data.by_pairing) || {};
                updateCrossModuleKpis(data || {});
                updateCrossModuleBadge();
                renderCrossModuleTable();
            } catch (e) {
                crossModuleLoadError = (e && e.message) ? e.message : String(e);
                console.error('cross-module load failed:', e);
                crossModuleClusters = [];
                crossModuleByPairing = {};
                updateCrossModuleKpis({});
                updateCrossModuleBadge();
                renderCrossModuleTable();
            }
        }

        function updateCrossModuleBadge() {
            const total = (crossModuleClusters || []).length;
            const badge = document.getElementById('crossModulePendingBadge');
            if (!badge) return;
            if (total > 0) {
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }
        }

        // Refined-rule tile painter — reads action counts produced by the
        // backend (by_action) and falls back to recomputing from clusters if
        // an older response shape is in the cache.
        function _cmoComputeActionCountsFromList(list) {
            const arr = Array.isArray(list) ? list : [];
            const counts = {
                lead_vs_active_deal: 0,
                contact_account_link: 0,
                deal_account_link: 0,
                contact_deal_link: 0,
                three_plus_modules: 0,
                existing_client_cs_owned: 0,
            };
            let arrSum = 0;
            for (const c of arr) {
                const leads = Number(c.total_leads || 0);
                const contacts = Number(c.total_contacts || 0);
                const accounts = Number(c.total_accounts || 0);
                const deals = Number(c.total_deals || 0);
                if (leads > 0 && deals > 0 && c.has_active_lead && c.has_active_deal) counts.lead_vs_active_deal++;
                if (contacts > 0 && accounts > 0) counts.contact_account_link++;
                if (deals > 0 && accounts > 0) counts.deal_account_link++;
                if (contacts > 0 && deals > 0) counts.contact_deal_link++;
                if (c.pairing === 'mixed') counts.three_plus_modules++;
                if (c.has_client_deal) counts.existing_client_cs_owned++;
                arrSum += Number(c.estimated_pipeline_value || 0);
            }
            return { counts, arrSum };
        }

        function _cmoPaintTiles(totalClusters, counts, arrSum) {
            const totalEl    = document.getElementById('cmoTotal');
            const ladEl      = document.getElementById('cmoLeadActiveDeal');
            const linkEl     = document.getElementById('cmoLinkGaps'); // now the "3+ modules" tile
            const clientsEl  = document.getElementById('cmoExistingClients');
            const arrEl      = document.getElementById('cmoArr');
            if (totalEl)   totalEl.textContent   = _fn(totalClusters);
            if (ladEl)     ladEl.textContent     = _fn(counts.lead_vs_active_deal || 0);
            // The 3 pure-linking pairings moved to Record Hint and are excluded
            // from this tab, so the old contact/deal/account "link gaps" sum was
            // inflated (mixed clusters triple-count). Show the real 3+-module count.
            if (linkEl)    linkEl.textContent    = _fn(counts.three_plus_modules || 0);
            if (clientsEl) clientsEl.textContent = _fn(counts.existing_client_cs_owned || 0);
            if (arrEl)     arrEl.textContent     = formatCurrency(Number(arrSum || 0));
        }

        function updateCrossModuleKpis(data) {
            const clusters = Array.isArray(data.clusters) ? data.clusters : [];
            // Prefer backend by_action (authoritative); fall back to recompute
            // for older response shapes still in flight after a deploy.
            const counts = (data && data.by_action)
                ? data.by_action
                : _cmoComputeActionCountsFromList(clusters).counts;
            const arrSum = Number(data.arr_exposure_total || 0);
            _cmoPaintTiles(clusters.length, counts, arrSum);
        }

        // Recompute the KPI cards from a (filtered) cluster list so the amounts
        // reflect exactly what the table shows after Advanced Filters + the
        // pairing chip are applied. Called from renderCrossModuleTable.
        function updateCrossModuleKpisFromList(list) {
            const arr = Array.isArray(list) ? list : [];
            const { counts, arrSum } = _cmoComputeActionCountsFromList(arr);
            _cmoPaintTiles(arr.length, counts, arrSum);
        }

        // Status filter (Open / Resolved / Dismissed / All). Re-fetches with the
        // chosen status so handled/dismissed overlaps are reviewable + reversible.
        window._crossModuleStatusFilter = window._crossModuleStatusFilter || 'active';
        function setCrossModuleStatus(status) {
            window._crossModuleStatusFilter = status || 'active';
            ['active', 'resolved', 'ignored', 'all'].forEach(k => {
                const el = document.getElementById('cmoStatus-' + k);
                if (!el) return;
                const active = k === window._crossModuleStatusFilter;
                const palette = {
                    active:   active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                    resolved: active ? 'bg-green-700 text-white' : 'bg-green-100 text-green-700 hover:bg-green-200',
                    ignored:  active ? 'bg-gray-700 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300',
                    all:      active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                };
                el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + palette[k];
            });
            window._crossModulePage = 0;
            loadCrossModule();
        }

        // Mark a cross-module overlap as HANDLED. This is MODULE-SCOPED (bug
        // #4 fix): it only acknowledges the cross-module relationship (e.g.
        // Lead<->Account) — it does NOT resolve the whole cluster, so a
        // same-module duplicate also living in this cluster (e.g. 2 Leads)
        // stays visible in Domain Clusters / the per-module tabs. No Zoho
        // write here; it just drops the row from the Cross-Module open queue
        // (still reviewable under "Handled" and reversible via Un-handle).
        async function markCrossModuleHandled(clusterId) {
            if (!confirm('Mark this cross-module overlap as resolved?\n\nUse this once you have CONVERTED / LINKED / CLOSED the records in Zoho. The cluster itself stays active, so any same-module duplicate (e.g. 2 Leads) keeps showing up where it belongs. Reviewable under "Resolved" and reversible (Re-open). No Zoho changes are made here.')) return;
            const payload = JSON.stringify({ notes: 'Cross-module overlap handled in Zoho (convert / link / close) — marked from the Cross-Module tab.' });
            try {
                let res = await fetch('/api/duplicates/clusters/' + clusterId + '/cross-module-handled', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/clusters/' + clusterId + '/cross-module-handled', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                loadCrossModule();
            } catch (e) {
                alert('Could not mark handled: ' + (e && e.message || e));
            }
        }

        // Reverse of markCrossModuleHandled — clears cross_module_handled_at so
        // the cluster reappears in the Cross-Module open queue. No Zoho changes.
        async function unhandleCrossModule(clusterId) {
            if (!confirm('Move this cross-module overlap back to the open queue?\n\nNo Zoho changes.')) return;
            try {
                let res = await fetch('/api/duplicates/clusters/' + clusterId + '/cross-module-unhandle', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/clusters/' + clusterId + '/cross-module-unhandle', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                loadCrossModule();
            } catch (e) {
                alert('Could not un-handle: ' + (e && e.message || e));
            }
        }

        // Refined-rule chip matcher — mirrors the backend matchesPairingChip:
        // a chip click filters by ACTION, not by strict 2-module pairing. A
        // 3+ modules cluster that carries an active Lead + active Deal also
        // matches the Lead↔Active Deal chip, etc.
        function _cmoClusterMatchesChip(c, key) {
            if (!key || key === 'all') return true;
            const leads = Number(c.total_leads || 0);
            const deals = Number(c.total_deals || 0);
            switch (key) {
                case 'lead_deal':
                    return leads > 0 && deals > 0 && !!c.has_active_lead && !!c.has_active_deal;
                case 'mixed':
                    return c.pairing === 'mixed';
                case 'existing_clients':
                    return !!c.has_client_deal;
                default:
                    return false;
            }
        }

        function filterCrossModule(pairing) {
            crossModuleFilter = pairing || 'all';
            // Repaint chip styles — rose for the strategic "Lead ↔ Active
            // Deal", red for "Existing clients" (CS routing), amber for "3+
            // modules", indigo for the LINK queue, neutral for All.
            const allChips = document.querySelectorAll('#cmoChips button');
            allChips.forEach(btn => {
                const isAll = btn.id === 'cmoChip-all';
                const isMatch = (crossModuleFilter === 'all' && isAll) ||
                                btn.id === 'cmoChip-' + crossModuleFilter;
                if (isMatch) {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-gray-900 text-white';
                } else if (isAll) {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-gray-200 text-gray-700 hover:bg-gray-300';
                } else if (btn.id === 'cmoChip-mixed') {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200';
                } else if (btn.id === 'cmoChip-lead_deal') {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-rose-100 text-rose-700 hover:bg-rose-200';
                } else if (btn.id === 'cmoChip-existing_clients') {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-red-100 text-red-700 hover:bg-red-200';
                } else {
                    btn.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-indigo-100 text-indigo-700 hover:bg-indigo-200';
                }
            });
            renderCrossModuleTable();
        }

        // Sort state — mirrors sortCsOverlap / sortCsLifecycle. No default
        // key (server order — confidence/recency from the scan — is kept
        // until the user clicks a header).
        window._crossModuleSort = window._crossModuleSort || { key: null, dir: 'desc' };

        function crossModuleSortValue(c, key) {
            switch (key) {
                case 'domain':     return (c.domain || '').toLowerCase();
                case 'company':    return (c.company_name || '').toLowerCase();
                case 'records':    return Number(c.total_records || 0);
                case 'confidence': return Number(c.confidence_score || 0);
                case 'pipeline':   return Number(c.estimated_pipeline_value || 0);
                default:           return 0;
            }
        }

        function sortCrossModuleRows(rows, key, dir) {
            const factor = dir === 'asc' ? 1 : -1;
            return rows.slice().sort((a, b) => {
                const va = crossModuleSortValue(a, key);
                const vb = crossModuleSortValue(b, key);
                if (va < vb) return -1 * factor;
                if (va > vb) return  1 * factor;
                return 0;
            });
        }

        function updateCrossModuleSortIndicators() {
            const headers = document.querySelectorAll('#crossModuleTableHead .cross-module-sort');
            headers.forEach(h => {
                const key = h.getAttribute('data-sort-key');
                const ind = h.querySelector('.cross-module-sort-indicator');
                if (!ind) return;
                if (key === window._crossModuleSort.key) {
                    ind.textContent = window._crossModuleSort.dir === 'asc' ? '↑' : '↓';
                    ind.classList.remove('opacity-30');
                    ind.classList.add('text-gray-900');
                } else {
                    ind.textContent = '⇅';
                    ind.classList.add('opacity-30');
                    ind.classList.remove('text-gray-900');
                }
            });
        }

        function sortCrossModuleBy(key) {
            const cur = window._crossModuleSort;
            if (cur.key === key) {
                cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
            } else {
                cur.key = key;
                cur.dir = ['records','confidence','pipeline'].includes(key) ? 'desc' : 'asc';
            }
            window._crossModulePage = 0;
            renderCrossModuleTable();
        }

        function renderCrossModuleTable() {
            const tbody = document.getElementById('crossModuleTable');
            if (!tbody) return;
            updateCrossModuleSortIndicators();
            const _cmSpec = getAdvancedFilterSpec();
            const list = (crossModuleClusters || []).filter(c => {
                if (!_cmoClusterMatchesChip(c, crossModuleFilter)) return false;
                // Advanced Filter — match a cross-module CLUSTER by what its
                // member records hold. Owner/Stage/Layout/Pipeline are
                // aggregated onto the cluster by the backend (owners[]/stages[]
                // /layouts[]/pipelines[]); Module is derived here from the
                // per-module counts so 'Leads' etc. match the filter vocabulary.
                // The pairing chip above is a complement; both stack.
                const modulesPresent = [];
                if (c.total_leads    > 0) modulesPresent.push('leads');
                if (c.total_contacts > 0) modulesPresent.push('contacts');
                if (c.total_accounts > 0) modulesPresent.push('accounts');
                if (c.total_deals    > 0) modulesPresent.push('deals');
                const row = Object.assign({}, c, { modules_present: modulesPresent });
                return rowMatchesAdvancedFilter(row, {
                    ownerField:      'owner_name',
                    moduleField:     'modules_present',
                    stageField:      'stages',
                    layoutField:     'layouts',
                    pipelineField:   'pipelines',
                    domainField:     'domain',
                    confidenceField: 'confidence_score',
                    dateField:       'updated_at',
                }, _cmSpec);
            });
            // Recompute the KPI cards from the FILTERED list so the amounts
            // (Total open / Lead↔Contact / Lead↔Account / ARR exposure) track
            // the active filters + pairing chip instead of showing stale
            // server-load totals.
            updateCrossModuleKpisFromList(list);
            if (list.length === 0) {
                let msg;
                if (crossModuleLoadError) {
                    msg = `<div class="text-red-700 font-medium mb-1">Cross-module fetch failed</div><div class="text-xs text-red-600 break-all">${escapeHtml(crossModuleLoadError)}</div><div class="text-xs text-gray-500 mt-2">Click <strong>Run scan</strong> to rebuild, or check the server logs for <code>cross-module-overlaps</code>.</div>`;
                } else if ((crossModuleClusters || []).length === 0) {
                    msg = '<div class="text-gray-600">No cross-module overlaps detected.</div><div class="text-xs text-gray-500 mt-1">Either the latest sync found none, or no Zoho scan has been run yet. Click <strong>Run scan</strong> to rebuild clusters.</div>';
                } else {
                    msg = 'No cross-module overlaps match this filter — try the <strong>All</strong> chip.';
                }
                tbody.innerHTML = `<tr><td colspan="10" class="px-4 py-8 text-center text-sm">${msg}</td></tr>`;
                updateCrossModuleBulkBar();
                return;
            }
            // Full-array sort — sort the WHOLE filtered list before paginating,
            // not just the visible page. No key selected yet = keep server order.
            const sortedList = window._crossModuleSort.key
                ? sortCrossModuleRows(list, window._crossModuleSort.key, window._crossModuleSort.dir)
                : list;
            // Client-side pagination — 20 cross-module clusters per page.
            window._crossModulePage = Number.isFinite(window._crossModulePage) ? window._crossModulePage : 0;
            const crossModuleTotalPages = Math.max(1, Math.ceil(sortedList.length / RADAR_PAGE_SIZE));
            if (window._crossModulePage >= crossModuleTotalPages) window._crossModulePage = 0;
            const crossModulePageStart = window._crossModulePage * RADAR_PAGE_SIZE;
            const crossModuleSlice = sortedList.slice(crossModulePageStart, crossModulePageStart + RADAR_PAGE_SIZE);
            renderPagination('crossModulePagination', window._crossModulePage, crossModuleTotalPages,
                (p) => { window._crossModulePage = p; renderCrossModuleTable(); },
                sortedList.length, 'clusters');
            tbody.innerHTML = crossModuleSlice.map(c => {
                const meta = CROSS_MODULE_PAIRING_LABELS[c.pairing] || { label: c.pairing || '—', action: 'Open cluster for per-record recommendations' };
                const modules = [];
                if (c.total_leads    > 0) modules.push('Leads(' + c.total_leads + ')');
                if (c.total_contacts > 0) modules.push('Contacts(' + c.total_contacts + ')');
                if (c.total_accounts > 0) modules.push('Accounts(' + c.total_accounts + ')');
                if (c.total_deals    > 0) modules.push('Deals(' + c.total_deals + ')');
                // Refined-rule chip colour: mixed=amber, lead↔active-deal=
                // rose (strategic), LINK queue=indigo. The Existing-client
                // badge is shown OUT-OF-BAND beside the pairing chip when
                // any deal is in Paid / Agreement Signed (CS-owned).
                let chipBg = 'bg-indigo-100 text-indigo-700';
                if (c.pairing === 'mixed') chipBg = 'bg-amber-100 text-amber-700';
                else if (c.pairing === 'lead_deal') chipBg = 'bg-rose-100 text-rose-700';
                const pairingChip = '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold ' + chipBg + '">' + escapeHtml(meta.label) + '</span>'
                    + (c.has_client_deal
                        ? ' <span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700" title="Cluster contains a Paid / Agreement Signed deal — owned by Customer Success. Do NOT pursue from Sales.">Existing client · CS</span>'
                        : '');
                // Follow-up 3: checkbox cell only when the cluster has a
                // Lead — leads are what the bulk action closes; a row with
                // no lead has nothing for the action to do.
                const hasLead = (c.total_leads || 0) > 0;
                const checked = crossModuleSelected.has(c.id) ? 'checked' : '';
                const checkboxCell = hasLead
                    ? `<td class="px-3 py-2 text-xs text-center"><input type="checkbox" data-on-change="toggleCrossModuleRowSelection" data-args="[${c.id}]" data-cmo-row="${c.id}" ${checked} aria-label="Select cluster ${c.id} for bulk-close" /></td>`
                    : '<td class="px-3 py-2 text-xs text-center text-gray-300" title="No Lead records — nothing to bulk-close">—</td>';
                // The row stays clickable to open the cluster modal, but
                // the checkbox uses stopPropagation in toggleCrossModuleRowSelection
                // so clicking it doesn't also open the modal.
                return '<tr class="hover:bg-gray-50" data-testid="row-cmo-' + c.id + '">'
                    + checkboxCell
                    + '<td class="px-4 py-2 text-xs cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + pairingChip + '</td>'
                    + '<td class="px-4 py-2 text-xs font-mono text-gray-700 cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + escapeHtml(c.domain || '—') + '</td>'
                    + '<td class="px-4 py-2 text-xs text-gray-800 cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + escapeHtml(c.company_name || '—') + '</td>'
                    + '<td class="px-4 py-2 text-xs text-gray-600 cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + escapeHtml(modules.join(' · ')) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-end font-medium cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + _fn(c.total_records || 0) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-end cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']"><span class="confidence-' + getConfidenceLevel(c.confidence_score || 0) + ' px-2 py-1 rounded">' + _fn(c.confidence_score || 0) + '%</span></td>'
                    + '<td class="px-4 py-2 text-xs text-end font-medium cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + formatCurrency(Number(c.estimated_pipeline_value || 0)) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-gray-700 cursor-pointer" data-on-click="showClusterDetails" data-args="[' + c.id + ']">' + escapeHtml(meta.action) + '</td>'
                    + _crossModuleTrackCell(c)
                    + '</tr>';
            }).join('');
            updateCrossModuleBulkBar();
        }

        // Per-row tracking cell. In the open queue: ✓ Handled (mark resolved —
        // I converted/linked/closed it in Zoho) + 🚫 Dismiss (false positive /
        // intentional). In the Resolved/Dismissed views: a status tag + 🔓 Re-open.
        // No Zoho writes — this only tracks the cluster's status so handled items
        // leave "Total open" and the KPIs stay honest, while staying auditable.
        function _crossModuleTrackCell(c) {
            const st = window._crossModuleStatusFilter || 'active';
            const isHandled = !!c.cross_module_handled_at;   // cross-module marked-done
            const isResolvedCluster = (c.status === 'resolved');
            const isDismissed = (c.status === 'ignored');
            // Open queue: the two actions. (Handled clusters are excluded from the
            // Open filter, so a row here is genuinely open.)
            if (st === 'active') {
                return '<td class="px-4 py-2 text-xs text-center whitespace-nowrap">'
                    + '<button data-on-click="markCrossModuleHandled" data-args="[' + c.id + ']" title="Mark resolved — I converted / linked / closed this in Zoho. Removes it from the open queue (the cluster stays active so any same-module duplicate still shows elsewhere). Reversible." class="px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 me-1">✓ Resolved</button>'
                    + '<button data-on-click="dismissCluster" data-args="[&quot;cross-module&quot;,' + c.id + ']" title="Dismiss — not the same company / intentional. No Zoho changes." class="px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200">🚫</button>'
                    + '</td>';
            }
            // Resolved (merged: whole-cluster resolved OR cross-module marked-done).
            if (isResolvedCluster || isHandled) {
                // Re-open uses the right reversal: un-handle for a marked-done
                // cross-module overlap, reopen for a whole-cluster resolution.
                const reopen = isHandled && !isResolvedCluster
                    ? '<button data-on-click="unhandleCrossModule" data-args="[' + c.id + ']" title="Re-open — return this overlap to the open queue. No Zoho changes." class="px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200">🔓</button>'
                    : '<button data-on-click="reopenCluster" data-args="[&quot;cross-module&quot;,' + c.id + ']" title="Re-open — return this overlap to the open queue. No Zoho changes." class="px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200">🔓</button>';
                return '<td class="px-4 py-2 text-xs text-center whitespace-nowrap">'
                    + '<span class="text-[10px] text-green-600 me-1">Resolved</span>' + reopen + '</td>';
            }
            if (isDismissed) {
                return '<td class="px-4 py-2 text-xs text-center whitespace-nowrap">'
                    + '<span class="text-[10px] text-gray-500 me-1">Dismissed</span>'
                    + '<button data-on-click="reopenCluster" data-args="[&quot;cross-module&quot;,' + c.id + ']" title="Re-open — return this overlap to the open queue. No Zoho changes." class="px-2 py-1 rounded bg-amber-100 text-amber-700 hover:bg-amber-200">🔓</button>'
                    + '</td>';
            }
            // Fallback (e.g. All view, still-open cluster): the open-queue actions.
            return '<td class="px-4 py-2 text-xs text-center whitespace-nowrap">'
                + '<button data-on-click="markCrossModuleHandled" data-args="[' + c.id + ']" title="Mark resolved — I converted / linked / closed this in Zoho. Reversible." class="px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200 me-1">✓ Resolved</button>'
                + '<button data-on-click="dismissCluster" data-args="[&quot;cross-module&quot;,' + c.id + ']" title="Dismiss — not the same company / intentional. No Zoho changes." class="px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200">🚫</button>'
                + '</td>';
        }

        // Follow-up 3: bulk-close selection state + action.
        function toggleCrossModuleRowSelection(clusterId, event) {
            // Prevent the row-level click handler from also firing
            // (which would open the cluster details modal).
            if (event && typeof event.stopPropagation === 'function') {
                event.stopPropagation();
            }
            const cid = Number(clusterId);
            if (crossModuleSelected.has(cid)) {
                crossModuleSelected.delete(cid);
            } else {
                crossModuleSelected.add(cid);
            }
            updateCrossModuleBulkBar();
        }

        function toggleCrossModuleSelectAll(event) {
            const cb = (event && event.target) || document.getElementById('cmoSelectAll');
            const checked = !!(cb && cb.checked);
            // Apply only to currently-visible (post-filter) rows that have a Lead.
            const visible = (crossModuleClusters || []).filter(c => {
                if (!_cmoClusterMatchesChip(c, crossModuleFilter)) return false;
                return (c.total_leads || 0) > 0;
            });
            for (const c of visible) {
                if (checked) crossModuleSelected.add(c.id);
                else crossModuleSelected.delete(c.id);
            }
            renderCrossModuleTable();
        }

        function updateCrossModuleBulkBar() {
            const bar = document.getElementById('cmoBulkActionBar');
            const cnt = document.getElementById('cmoSelectedCount');
            const plural = document.getElementById('cmoSelectedPlural');
            if (!bar || !cnt) return;
            const n = crossModuleSelected.size;
            cnt.textContent = String(n);
            if (plural) plural.textContent = n === 1 ? '' : 's';
            if (n > 0) bar.classList.remove('hidden');
            else bar.classList.add('hidden');
        }

        async function bulkCloseLeadsDryRun() {
            await runBulkCloseLeads({ dryRun: true });
        }

        async function bulkCloseLeadsExecute() {
            const n = crossModuleSelected.size;
            if (n === 0) return;
            const ok = confirm(
                `Close lead records in Zoho for ${n} cluster${n === 1 ? '' : 's'}?\n\n` +
                `This will set Lead_Status = "Lost Lead" on every Lead in these clusters and mark each cluster Resolved.\n\n` +
                `Already-Lost / already-Junk leads will be skipped silently.\n\n` +
                `Cancel and run "Dry run" first if you want to preview the impact.`
            );
            if (!ok) return;
            await runBulkCloseLeads({ dryRun: false });
        }

        async function runBulkCloseLeads(opts) {
            const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
            if (!adminKey) return;
            const ids = Array.from(crossModuleSelected);
            if (ids.length === 0) return;
            try {
                const res = await fetch('/api/duplicates/cross-module-overlaps/bulk-close-leads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                    body: JSON.stringify({ cluster_ids: ids, dry_run: !!opts.dryRun }),
                });
                const data = await res.json();
                if (!data.success) {
                    alert(data.error || 'Bulk-close failed.');
                    return;
                }
                showCmoBulkResult(data);
                // On real execute, clear selection + reload so resolved
                // clusters disappear from the active view.
                if (!opts.dryRun) {
                    crossModuleSelected.clear();
                    loadCrossModule();
                }
            } catch (e) {
                alert('Network error during bulk-close: ' + (e && e.message || e));
            }
        }

        function showCmoBulkResult(data) {
            const modal = document.getElementById('cmoBulkResultModal');
            const body = document.getElementById('cmoBulkResultBody');
            const subtitle = document.getElementById('cmoBulkResultSubtitle');
            if (!modal || !body) return;
            const dry = !!data.dry_run;
            if (subtitle) subtitle.textContent = dry
                ? `Dry run — examined ${data.examined} cluster${data.examined === 1 ? '' : 's'}`
                : `Real run — examined ${data.examined} cluster${data.examined === 1 ? '' : 's'}`;
            const summary = `<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
                ${[
                    ['Leads closed', _fn(data.total_leads_closed || 0)],
                    ['Leads skipped', _fn(data.total_leads_skipped || 0)],
                    ['Leads failed', _fn(data.total_leads_failed || 0)],
                    ['Clusters resolved', _fn(data.clusters_resolved || 0)],
                ].map(([k, v]) => `<div class="bg-gray-50 rounded p-2"><div class="text-gray-500">${escapeHtml(k)}</div><div class="text-lg font-semibold text-gray-900">${escapeHtml(String(v))}</div></div>`).join('')}
            </div>`;
            const per = Array.isArray(data.per_cluster) ? data.per_cluster : [];
            const rows = per.length === 0
                ? '<div class="text-xs text-gray-400 italic">No per-cluster details returned.</div>'
                : '<div class="overflow-x-auto"><table class="min-w-full text-xs border border-gray-200"><thead class="bg-gray-50"><tr>'
                    + ['Cluster','Closed','Skipped','Failed','Resolved','Notes'].map(h => `<th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">${escapeHtml(h)}</th>`).join('')
                    + '</tr></thead><tbody>'
                    + per.map(c => {
                        const errPart = c.errors && c.errors.length > 0
                            ? '<div class="text-[10px] text-red-600 mt-1">' + escapeHtml(c.errors.map(e => `${e.zoho_lead_id || '—'}: ${e.message}`).join(' · ')) + '</div>'
                            : '';
                        return `<tr class="border-t border-gray-100">
                            <td class="px-2 py-1 font-mono">${escapeHtml(String(c.cluster_id))}</td>
                            <td class="px-2 py-1">${_fn(c.leads_closed || 0)}</td>
                            <td class="px-2 py-1">${_fn(c.leads_skipped || 0)}</td>
                            <td class="px-2 py-1 ${c.leads_failed ? 'text-red-700 font-semibold' : 'text-gray-500'}">${_fn(c.leads_failed || 0)}</td>
                            <td class="px-2 py-1">${c.cluster_resolved ? '<span class="text-emerald-700 font-medium">Yes</span>' : '<span class="text-gray-400">No</span>'}</td>
                            <td class="px-2 py-1 text-gray-600">${escapeHtml(c.notes || '')}${errPart}</td>
                        </tr>`;
                    }).join('')
                    + '</tbody></table></div>';
            body.innerHTML = summary + rows;
            modal.classList.remove('hidden');
        }

        function closeCmoBulkResult() {
            const m = document.getElementById('cmoBulkResultModal');
            if (m) m.classList.add('hidden');
        }

        // Per-tab "at-a-glance" scorecard on the Executive Summary tab.
        // Fans out to /api/duplicates/overview which calls every tab
        // scanner in parallel and returns one verdict + headline per
        // tab. Loads on first Exec-Summary paint and on the Refresh
        // button in the section header.
        const _RADAR_TAB_META = [
            { key: 'leadDuplicates',       label: 'Lead Duplicates',       icon: '🟠', tab: 'leads',            desc: 'Duplicate Leads grouped into clusters.' },
            { key: 'dealDuplicates',       label: 'Deal Duplicates',       icon: '🟣', tab: 'deals',            desc: 'Duplicate Deals grouped into clusters.' },
            { key: 'contactDuplicates',    label: 'Contact Duplicates',    icon: '⚪', tab: 'contacts',         desc: 'Duplicate Contacts grouped into clusters.' },
            { key: 'accountDuplicates',    label: 'Account Duplicates',    icon: '🟢', tab: 'accounts',         desc: 'Duplicate Accounts grouped into clusters.' },
            { key: 'crossModule',          label: 'Cross-Module',          icon: '🔗', tab: 'cross-module',     desc: 'Same company across ≥2 Zoho modules.' },
            { key: 'csOverlap',            label: 'CS Pipeline Overlap',   icon: '🛑', tab: 'cs-overlap',       desc: 'Open Sales Deal + Paid/Agreement-Signed handoff on the same customer.' },
            { key: 'csLifecycle',          label: 'CS Lifecycle',          icon: '🌱', tab: 'cs-lifecycle',     desc: 'Customer Success deals deviating from GRQ-defined lifecycle rules.' },
            { key: 'dealsLifecycle',       label: 'Deals Lifecycle',       icon: '📐', tab: 'deal-lifecycle',   desc: 'Sales-pipeline stage aging vs Sales SOP §7.' },
            { key: 'dealCompliance',       label: 'Deal Compliance',       icon: '📎', tab: 'deal-compliance',  desc: 'Required document attachments on Proposal / Agreement Signed / Paid deals.' },
            { key: 'accountHints',         label: 'Account Hints',         icon: '💡', tab: 'account-hints',    desc: 'Deals missing Account_Name with inferred-Account verdicts.' },
            { key: 'ownerAccountability',  label: 'Owner Accountability',  icon: '👤', tab: 'owners',           desc: 'Per-rep duplicate scorecard. RAG bands per SDR-KPI-09.' },
            { key: 'logs',                 label: 'Logs',                  icon: '📋', tab: 'logs',             desc: 'Agent Activity + operator Manual Actions audit trail (24h window).' },
        ];

        async function loadRadarOverview() {
            const grid = document.getElementById('radarOverviewGrid');
            if (grid) grid.innerHTML = '<div class="col-span-full text-center text-xs text-gray-400 py-6">Loading per-tab snapshot…</div>';
            try {
                const res = await fetch('/api/duplicates/overview');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                renderRadarOverview(data || {});
            } catch (e) {
                console.error('overview load failed:', e);
                if (grid) grid.innerHTML = '<div class="col-span-full text-center text-xs text-red-600 py-6">Failed to load per-tab snapshot: ' + escapeHtml(e.message || String(e)) + '</div>';
            }
        }

        function _verdictBadge(verdict) {
            const map = {
                green:   { cls: 'bg-emerald-50 border-emerald-300 text-emerald-700', label: '✓ Green' },
                amber:   { cls: 'bg-amber-50 border-amber-300 text-amber-700',       label: '⚠ Amber' },
                red:     { cls: 'bg-red-50 border-red-300 text-red-700',             label: '✗ Red' },
                neutral: { cls: 'bg-gray-50 border-gray-300 text-gray-600',          label: '— Idle' },
            };
            const v = map[verdict] || map.neutral;
            return '<span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold border ' + v.cls + '">' + v.label + '</span>';
        }
        function _verdictBorderColor(verdict) {
            return verdict === 'green' ? 'border-emerald-400'
                : verdict === 'amber'  ? 'border-amber-400'
                : verdict === 'red'    ? 'border-red-400'
                : 'border-gray-300';
        }

        function renderRadarOverview(data) {
            const grid = document.getElementById('radarOverviewGrid');
            if (!grid) return;
            const tabs = (data && data.tabs) || {};
            const generated = data && data.generatedAt ? new Date(data.generatedAt) : null;

            const html = _RADAR_TAB_META.map(meta => {
                const slot = tabs[meta.key] || { verdict: 'neutral', headline: 'No data', metrics: {} };
                const verdict = slot.verdict || 'neutral';
                const headline = slot.headline || '—';
                const err = slot.error ? '<div class="text-[10px] text-red-600 mt-1">⚠ ' + escapeHtml(slot.error) + '</div>' : '';
                return ''
                    + '<div class="bg-white border-s-4 ' + _verdictBorderColor(verdict) + ' rounded-lg shadow-sm p-3 hover:shadow-md transition-shadow cursor-pointer" data-on-click="showTab" data-args=\'["' + meta.tab + '"]\'>'
                    + '  <div class="flex items-start justify-between gap-2 mb-1">'
                    + '    <div class="text-xs font-semibold text-gray-800">' + meta.icon + ' ' + escapeHtml(meta.label) + '</div>'
                    + '    ' + _verdictBadge(verdict)
                    + '  </div>'
                    + '  <div class="text-sm font-medium text-gray-900 mb-1">' + escapeHtml(headline) + '</div>'
                    + '  <div class="text-[10px] text-gray-500">' + escapeHtml(meta.desc) + '</div>'
                    + '  <div class="text-[10px] text-indigo-600 font-medium mt-2">Open ' + escapeHtml(meta.label) + ' →</div>'
                    + err
                    + '</div>';
            }).join('');

            const footer = generated
                ? '<div class="col-span-full text-[10px] text-gray-400 text-end mt-1">Snapshot generated ' + escapeHtml(generated.toISOString().replace('T', ' ').slice(0, 16)) + ' UTC</div>'
                : '';

            grid.innerHTML = html + footer;
        }

        // R4: fetch + render the duplicate creation-rate trend.
        // Reuses Chart.js (already loaded for the other dashboard charts).
        async function loadCreationTrend() {
            const weeksSel = document.getElementById('trendWeeks');
            const weeks = weeksSel ? Number(weeksSel.value) || 12 : 12;
            try {
                const res = await fetch(`/api/duplicates/creation-trend?weeks=${weeks}`);
                if (!res.ok) return;
                const data = await res.json();
                renderCreationTrend(data || {});
            } catch (e) {
                console.error('creation-trend load failed:', e);
            }
        }

        function reloadCreationTrend() { loadCreationTrend(); }

        function renderCreationTrend(data) {
            const buckets = Array.isArray(data && data.buckets) ? data.buckets : [];
            const labels = buckets.map(b => b.bucket_start);
            const dupCounts = buckets.map(b => Number(b.new_duplicates || 0));
            const totalCounts = buckets.map(b => Number(b.new_records || 0));
            const rates = buckets.map(b => Number(b.duplicate_rate_pct || 0));

            // KPI cards on the right
            const latest = buckets[buckets.length - 1];
            const prev = buckets[buckets.length - 2];
            const latestEl = document.getElementById('trendLatestCount');
            const deltaEl = document.getElementById('trendLatestDelta');
            const rateEl = document.getElementById('trendLatestRate');
            const totalEl = document.getElementById('trendWindowTotal');
            const avgEl = document.getElementById('trendWindowAvg');
            const vsAvgEl = document.getElementById('trendVsAvg');
            const rateVsTargetEl = document.getElementById('trendRateVsTarget');
            const verdictEl = document.getElementById('trendVerdictChip');
            const headlineEl = document.getElementById('trendHeadline');

            if (latestEl) latestEl.textContent = latest ? _fn(latest.new_duplicates) : '—';
            if (rateEl) rateEl.textContent = latest ? (_fn(latest.duplicate_rate_pct) + '%') : '—';
            const windowTotal = dupCounts.reduce((a, b) => a + b, 0);
            const windowAvg = dupCounts.length > 0 ? Math.round(windowTotal / dupCounts.length) : 0;
            if (totalEl) totalEl.textContent = _fn(windowTotal);
            if (avgEl) avgEl.textContent = _fn(windowAvg);

            // Delta vs previous bucket — improvement (down) is green.
            if (deltaEl) {
                if (!latest || !prev) {
                    deltaEl.textContent = 'vs previous week: —';
                    deltaEl.className = 'text-xs font-medium text-gray-500';
                } else {
                    const diff = latest.new_duplicates - prev.new_duplicates;
                    const sign = diff > 0 ? '+' : '';
                    deltaEl.textContent = 'vs previous week: ' + sign + _fn(diff);
                    deltaEl.className = 'text-xs font-medium ' + (diff > 0 ? 'text-red-600' : diff < 0 ? 'text-emerald-600' : 'text-gray-500');
                }
            }

            // Latest vs window average — context for whether this week is
            // typical or an outlier.
            if (vsAvgEl) {
                if (!latest || windowAvg === 0) {
                    vsAvgEl.textContent = 'Latest vs avg: —';
                } else {
                    const delta = latest.new_duplicates - windowAvg;
                    const sign = delta > 0 ? '+' : '';
                    const pct = Math.round((delta / windowAvg) * 100);
                    vsAvgEl.textContent = 'Latest vs avg: ' + sign + _fn(delta) + ' (' + sign + pct + '%)';
                    vsAvgEl.className = 'text-[11px] font-semibold ' + (delta > 0 ? 'text-red-600' : delta < 0 ? 'text-emerald-600' : 'text-gray-400');
                }
            }

            // Rate vs 2% target context line.
            if (rateVsTargetEl && latest) {
                const r = Number(latest.duplicate_rate_pct || 0);
                if (r <= 2) {
                    rateVsTargetEl.textContent = '✓ At or under the 2% target';
                    rateVsTargetEl.className = 'text-[11px] text-emerald-600 font-semibold';
                } else if (r <= 5) {
                    rateVsTargetEl.textContent = 'Above 2% target (amber band)';
                    rateVsTargetEl.className = 'text-[11px] text-amber-600 font-semibold';
                } else {
                    rateVsTargetEl.textContent = (Math.round(r / 2 * 10) / 10) + '× the 2% target';
                    rateVsTargetEl.className = 'text-[11px] text-red-600 font-semibold';
                }
            }

            // Verdict chip + plain-English headline.
            // Compare the average of the latest 3 buckets to the average of
            // the 3 buckets before them. Smoothed comparison resists a single
            // noisy week from misleading the verdict either direction.
            // "Improving" requires a >=15% drop, "Worsening" a >=15% rise,
            // anything else is "Holding steady".
            if (verdictEl && headlineEl && buckets.length >= 6) {
                const tail = dupCounts.slice(-3);
                const prevTail = dupCounts.slice(-6, -3);
                const avgT = tail.reduce((a, b) => a + b, 0) / tail.length;
                const avgP = prevTail.reduce((a, b) => a + b, 0) / prevTail.length;
                const denomSafe = avgP === 0 ? 1 : avgP;
                const pctChange = ((avgT - avgP) / denomSafe) * 100;
                let label, cls, headline;
                if (avgP === 0 && avgT === 0) {
                    label = 'No activity'; cls = 'border-gray-300 bg-gray-100 text-gray-700';
                    headline = 'No new duplicates created in the last 6 weeks. Either prevention is excellent or sync activity has paused.';
                } else if (pctChange <= -15) {
                    label = '✓ Improving'; cls = 'border-emerald-400 bg-emerald-50 text-emerald-700';
                    headline = 'Prevention is winning — new duplicates dropped ' + Math.abs(Math.round(pctChange)) + '% over the last 3 weeks vs the prior 3. Keep cleansing.';
                } else if (pctChange >= 15) {
                    label = '✗ Worsening'; cls = 'border-red-400 bg-red-50 text-red-700';
                    headline = 'New duplicates rose ' + Math.round(pctChange) + '% over the last 3 weeks vs the prior 3. Investigate which source channel is leaking in (check the Duplicates by Source chart below).';
                } else {
                    label = '~ Holding steady'; cls = 'border-amber-300 bg-amber-50 text-amber-700';
                    headline = 'Trend is roughly flat (' + (pctChange >= 0 ? '+' : '') + Math.round(pctChange) + '% over 3 weeks). Prevention is keeping pace with new inflow but not gaining ground.';
                }
                verdictEl.className = 'px-3 py-1 rounded-full text-xs font-bold border ' + cls;
                verdictEl.textContent = label;
                verdictEl.classList.remove('hidden');
                headlineEl.textContent = headline;
            } else if (verdictEl && headlineEl) {
                verdictEl.classList.add('hidden');
                headlineEl.textContent = 'Need at least 6 weeks of data for a smoothed trend verdict — widen the Window selector if you have older data.';
            }

            // Chart
            const canvas = document.getElementById('creationTrendChart');
            if (!canvas) return;
            if (creationTrendChart) creationTrendChart.destroy();
            creationTrendChart = new Chart(canvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'New duplicates',
                            data: dupCounts,
                            borderColor: '#DC2626',
                            backgroundColor: 'rgba(220, 38, 38, 0.12)',
                            fill: true,
                            tension: 0.25,
                            pointRadius: 3,
                            yAxisID: 'y',
                        },
                        {
                            label: 'New records (total)',
                            data: totalCounts,
                            borderColor: '#94A3B8',
                            backgroundColor: 'rgba(148, 163, 184, 0.08)',
                            borderDash: [4, 4],
                            fill: false,
                            tension: 0.25,
                            pointRadius: 2,
                            yAxisID: 'y',
                        },
                        {
                            label: 'Duplicate rate %',
                            data: rates,
                            borderColor: '#2563EB',
                            backgroundColor: 'transparent',
                            fill: false,
                            tension: 0.25,
                            pointRadius: 2,
                            yAxisID: 'y1',
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: {
                            callbacks: {
                                label(ctx) {
                                    const v = ctx.parsed.y;
                                    if (ctx.dataset.yAxisID === 'y1') return `${ctx.dataset.label}: ${_fn(v)}%`;
                                    return `${ctx.dataset.label}: ${_fn(v)}`;
                                },
                            },
                        },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Records' },
                            ticks: { precision: 0 },
                        },
                        y1: {
                            beginAtZero: true,
                            position: 'right',
                            grid: { drawOnChartArea: false },
                            title: { display: true, text: 'Dup rate %' },
                            ticks: {
                                callback: (v) => v + '%',
                            },
                        },
                    },
                },
            });
            if (window.WalaPlusA11y) window.WalaPlusA11y.makeChartAccessible('creationTrendChart', creationTrendChart, 'Duplicate Creation Trend');
        }

        // ── Inline SVG sparkline + delta for True Duplicates trend (additive) ──
        function _renderSparklineSVG(values, w, h) {
            const valid = (values || []).filter(v => typeof v === 'number' && !isNaN(v));
            if (valid.length < 2) return '';
            const first = valid[0], last = valid[valid.length - 1];
            const improving = last < first;
            const flat = last === first;
            const stroke = flat ? '#9CA3AF' : (improving ? '#10B981' : '#EF4444');
            const fill = flat ? 'rgba(156,163,175,0.12)' : (improving ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)');
            const min = Math.min(...valid), max = Math.max(...valid);
            const range = max - min || 1;
            const step = w / (valid.length - 1);
            const pts = valid.map((v, i) => {
                const x = (i * step).toFixed(1);
                const y = (h - ((v - min) / range) * (h - 2) - 1).toFixed(1);
                return `${x},${y}`;
            });
            const area = `M0,${h} L${pts.join(' L')} L${w},${h} Z`;
            const line = `M${pts.join(' L')}`;
            return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="block" aria-hidden="true">
                <path d="${area}" fill="${fill}" stroke="none"/>
                <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
            </svg>`;
        }
        function _renderDelta(values) {
            const valid = (values || []).filter(v => typeof v === 'number' && !isNaN(v));
            if (valid.length < 2) return '';
            const last = valid[valid.length - 1];
            const prev = valid[valid.length - 2];
            const diff = last - prev;
            if (diff === 0) return `<span class="text-[10px] text-gray-400" title="${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_change_tip'))}">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_change'))}</span>`;
            const improving = diff < 0;
            const arrow = improving ? '▼' : '▲';
            const cls = improving ? 'text-green-600' : 'text-red-500';
            const sign = improving ? '' : '+';
            return `<span class="text-[10px] font-semibold ${cls}" title="${escapeHtml(WalaPlusI18n.t('dyn.duplicates.vs_prev_scan'))}">${arrow} ${sign}${_fn(diff)}</span>`;
        }
        async function loadClustersTrendSparkline() {
            try {
                const sparkEl = document.getElementById('clustersSparkline');
                const deltaEl = document.getElementById('clustersDelta');
                if (!sparkEl || !deltaEl) return;
                const res = await fetch('/api/dashboard/quality-trend?limit=30', { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                const values = (data.duplicates || []).map(d => Number(d.clusters)).filter(v => !isNaN(v));
                sparkEl.innerHTML = _renderSparklineSVG(values, 80, 20);
                deltaEl.innerHTML = _renderDelta(values);
            } catch (e) {
                console.warn('[trend] cluster sparkline failed:', e);
            }
        }

        function updateSummary(data) {
            document.getElementById('totalClusters').textContent = _fn(data.trueDuplicateClusters || data.totalClusters || 0);
            document.getElementById('totalLeads').textContent = _fn(data.totalDuplicateLeads || 0);
            document.getElementById('totalDeals').textContent = _fn(data.totalDuplicateDeals || 0);
            document.getElementById('totalContacts').textContent = _fn(data.totalDuplicateContacts || 0);
            document.getElementById('totalAccounts').textContent = _fn(data.totalDuplicateAccounts || 0);
            document.getElementById('highConfidence').textContent = _fn(data.highConfidence || 0);
            document.getElementById('mediumConfidence').textContent = _fn(data.mediumConfidence || 0);
            document.getElementById('pipelineInflation').textContent = formatCurrency(data.estimatedPipelineInflation || 0);

            document.getElementById('leadRate').textContent = WalaPlusI18n.t('dyn.duplicates.rate_label', { pct: _fn(data.duplicateLeadRate || data.kpis?.duplicateLeadRate || 0) });
            document.getElementById('dealRate').textContent = WalaPlusI18n.t('dyn.duplicates.rate_label', { pct: _fn(data.duplicateDealRate || data.kpis?.duplicateDealRate || 0) });

            // kpiLeadRate / kpiDealRate tiles were dropped — the headline
            // cards above already show the same number against the 2% target.
            // Keeping a second copy on the same screen with the same value was
            // pure noise; removing those getElementById calls so a future
            // refactor doesn't try to populate elements that no longer exist.
            document.getElementById('kpiMultiDeal').textContent = _fn(data.kpis?.domainsWithMultipleDeals || 0);
            // Active Duplicate Clusters — singletons excluded (they aren't
            // duplicates). Same source as the True Duplicates headline card.
            document.getElementById('kpiActive').textContent = _fn(data.trueDuplicateClusters || 0);

            // D4: Resolution rate (duplicate clusters only)
            document.getElementById('resolutionRate').textContent = _fn(data.resolutionRate || 0) + '%';
            document.getElementById('resolvedCount').textContent = _fn(data.resolvedCount || 0);
            document.getElementById('ignoredCount').textContent = _fn(data.ignoredCount || 0);

            // Total cleanup actions across ALL action tabs (not just merges).
            const ca = data.cleanupActions || null;
            const ctEl = document.getElementById('cleanupTotal');
            const cbEl = document.getElementById('cleanupBreakdown');
            if (ctEl && ca) {
                ctEl.textContent = _fn(ca.total || 0);
                const parts = [];
                const merges = (ca.duplicatesResolved || 0) + (ca.duplicatesDismissed || 0);
                if (merges) parts.push(_fn(merges) + ' duplicate' + (ca.duplicatesDismissed ? ' (incl. ' + _fn(ca.duplicatesDismissed) + ' dismissed)' : ''));
                if (ca.emptyDeleteTagged) parts.push(_fn(ca.emptyDeleteTagged) + ' Empty-Delete');
                if (ca.accountHintsLinked) parts.push(_fn(ca.accountHintsLinked) + ' account links');
                let txt = parts.join(' · ') || 'no actions yet';
                if (ca.crossModuleHandled) txt += '  ·  (' + _fn(ca.crossModuleHandled) + ' cross-module, already counted in duplicates)';
                if (cbEl) cbEl.textContent = txt;
            } else if (ctEl) {
                ctEl.textContent = '—';
            }

            // D4: KPI Gauge — WHOLE-SYSTEM duplicate rate (all modules), not
            // just Leads. Falls back to the lead rate only if the backend
            // hasn't been redeployed with duplicateOverallRate yet. Bar is a
            // direct 0–100% scale (the overall rate runs well above the 2%
            // lead target, so the old 0–4% scale would just peg at full red).
            const overallDupRate = (data.duplicateOverallRate != null ? data.duplicateOverallRate
                : (data.kpis?.duplicateOverallRate != null ? data.kpis.duplicateOverallRate
                : (data.duplicateLeadRate || data.kpis?.duplicateLeadRate || 0)));
            document.getElementById('kpiGaugeValue').textContent = _fn(overallDupRate) + '%';
            const gaugePct = Math.min(overallDupRate, 100);
            const gaugeBar = document.getElementById('kpiGaugeBar');
            gaugeBar.style.width = gaugePct + '%';
            gaugeBar.style.background = overallDupRate <= 2 ? '#22C55E' : overallDupRate <= 5 ? '#F59E0B' : '#EF4444';

            // Sync Activity card — top line is the most recent sync of any
            // kind (incremental Sync Now / scheduled cron / full rebuild),
            // sourced from zoho_sync_state.last_sync_at. The bottom line is
            // the most recent FULL rebuild from duplicate_detection_logs.
            // Pre-fix the card only showed the latter, which made the
            // dashboard look frozen on the last rebuild date even though
            // operators were syncing daily.
            const lastSyncDateEl = document.getElementById('lastSyncDate');
            const lastSyncRelEl  = document.getElementById('lastSyncRelative');
            if (data.lastSyncAt) {
                const syncDate = new Date(data.lastSyncAt);
                lastSyncDateEl.textContent = _fd(syncDate, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                const diffMs = Date.now() - syncDate.getTime();
                const diffMin = Math.max(0, Math.round(diffMs / 60000));
                let rel;
                if (diffMin < 1) rel = 'just now';
                else if (diffMin < 60) rel = diffMin + ' min ago';
                else if (diffMin < 60 * 24) rel = Math.round(diffMin / 60) + ' hr ago';
                else rel = Math.round(diffMin / 60 / 24) + ' day(s) ago';
                lastSyncRelEl.textContent = rel;
            } else {
                lastSyncDateEl.textContent = 'Never';
                lastSyncRelEl.textContent = '';
            }
            if (data.lastScanInfo) {
                const scanDate = new Date(data.lastScanInfo.completed_at);
                document.getElementById('lastScanDate').textContent = _fd(scanDate, { day: 'numeric', month: 'short', year: 'numeric' });
                document.getElementById('lastScanDetails').textContent = WalaPlusI18n.t('dyn.duplicates.scan_summary', { records: _fn(data.lastScanInfo.total_records_scanned || 0), dur: _fn(Math.round((data.lastScanInfo.detection_duration_ms || 0) / 1000)), dup: _fn(data.lastScanInfo.total_duplicates_detected || 0) });
            } else if (data.lastScanDate) {
                document.getElementById('lastScanDate').textContent = _fd(new Date(data.lastScanDate), { day: 'numeric', month: 'short', year: 'numeric' });
            }

            // D4: Top signals
            const topSignalsEl = document.getElementById('topSignals');
            const signals = data.topSignals || {};
            const signalLabels = { exact_email: WalaPlusI18n.t('dyn.duplicates.signals.exact_email'), domain_match: WalaPlusI18n.t('dyn.duplicates.signals.domain_match'), phone_match: WalaPlusI18n.t('dyn.duplicates.signals.phone_match'), company_exact: WalaPlusI18n.t('dyn.duplicates.signals.company_exact'), company_fuzzy: WalaPlusI18n.t('dyn.duplicates.signals.company_fuzzy') };
            const signalColors = { exact_email: 'bg-blue-100 text-blue-800', domain_match: 'bg-green-100 text-green-800', phone_match: 'bg-purple-100 text-purple-800', company_exact: 'bg-amber-100 text-amber-800', company_fuzzy: 'bg-orange-100 text-orange-800' };
            const sortedSignals = Object.entries(signals).sort((a, b) => b[1] - a[1]);
            topSignalsEl.innerHTML = sortedSignals.length === 0 ? `<p class="text-sm text-gray-400">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_signal_data'))}</p>` :
                sortedSignals.map(([key, count]) => `<div class="flex justify-between items-center cursor-pointer hover:bg-gray-50 -mx-2 px-2 py-1 rounded" data-on-click="openClustersBySignalModal" data-args="${escAttr(JSON.stringify([key, signalLabels[key] || key]))}" data-testid="row-signal-${key}" title="Click to see all clusters with this signal"><span class="px-2 py-1 rounded text-xs font-medium ${signalColors[key] || 'bg-gray-100 text-gray-700'}">${escapeHtml(signalLabels[key] || key)}</span><span class="text-sm font-bold text-gray-700">${_fn(count)} →</span></div>`).join('');

            // D4: Top clusters by inflation
            const topClustersEl = document.getElementById('topClustersInflation');
            const topC = data.topClustersByInflation || [];
            topClustersEl.innerHTML = topC.length === 0 ? `<p class="text-sm text-gray-400">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_pipeline_inflation'))}</p>` :
                topC.map(c => `<div class="flex justify-between items-center p-2 bg-gray-50 rounded cursor-pointer hover:bg-gray-100" data-on-click="showClusterDetails" data-args="[${c.id}]"><div><span class="font-medium text-sm">${escapeHtml(c.company_name || c.domain)}</span><span class="text-xs text-gray-400 ms-2">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.n_records_short', { n: _fn(c.total_records) }))}</span></div><span class="text-sm font-bold text-purple-600">${formatCurrency(c.estimated_pipeline_value)}</span></div>`).join('');

            updateCharts(data);
        }

        function updateCharts(data) {
            const sourceData = data.kpis?.duplicateBySource || [];
            if (sourceChart) sourceChart.destroy();
            sourceChart = new Chart(document.getElementById('sourceChart'), {
                type: 'bar',
                data: { labels: sourceData.map(s => s.source || WalaPlusI18n.t('dyn.duplicates.unknown')), datasets: [{ label: WalaPlusI18n.t('dyn.duplicates.duplicates_chart_label'), data: sourceData.map(s => parseInt(s.total) || 0), backgroundColor: ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });

            if (window.WalaPlusA11y) window.WalaPlusA11y.makeChartAccessible('sourceChart', sourceChart, 'Duplicates by Source');

            if (confidenceChart) confidenceChart.destroy();
            confidenceChart = new Chart(document.getElementById('confidenceChart'), {
                type: 'doughnut',
                data: { labels: [WalaPlusI18n.t('dyn.duplicates.conf_strong'), WalaPlusI18n.t('dyn.duplicates.conf_moderate'), WalaPlusI18n.t('dyn.duplicates.conf_weak')], datasets: [{ data: [data.highConfidence||0, data.mediumConfidence||0, data.lowConfidence||0], backgroundColor: ['#EF4444','#F59E0B','#22C55E'] }] },
                options: { responsive: true, maintainAspectRatio: false }
            });
            if (window.WalaPlusA11y) window.WalaPlusA11y.makeChartAccessible('confidenceChart', confidenceChart, 'Similarity Score Distribution');
        }

        // C4: Paginated cluster loading
        // Render a status message into the Domain Clusters grid so a 429 /
        // auth / network error is visible instead of looking like "no clusters".
        function _renderClustersMessage(html, tone) {
            const grid = document.getElementById('clustersGrid');
            if (!grid) return;
            const palette = {
                info:  'text-gray-500',
                warn:  'text-amber-700',
                error: 'text-red-600',
            };
            const colorClass = palette[tone] || palette.info;
            grid.innerHTML = '<div class="col-span-full text-center py-8 text-sm ' + colorClass + '">' + html + '</div>';
        }

        async function loadClusters(page = 0) {
            clusterPage = page;
            const conf = document.getElementById('clusterFilter').value;
            const status = document.getElementById('statusFilter').value;
            const layout = document.getElementById('layoutFilter')?.value || '';
            const sort = document.getElementById('clusterSort')?.value || 'records';
            const dirBtn = document.getElementById('clusterSortDir');
            const dir = (dirBtn && dirBtn.getAttribute('data-sort-dir')) || 'desc';
            const range = getDateRange();
            let url = `/api/duplicates/clusters?limit=${RADAR_PAGE_SIZE}&offset=${page * RADAR_PAGE_SIZE}&sort=${encodeURIComponent(sort)}&dir=${encodeURIComponent(dir)}`;
            if (conf) url += `&confidence_level=${conf}`;
            if (status) url += `&status=${status}`;
            if (layout) url += `&layouts=${encodeURIComponent(layout)}`;
            if (range.from) url += `&start_date=${range.from}`;
            if (range.to) url += `&end_date=${range.to}`;

            // Supersede earlier in-flight loads (paginate / filter change).
            const loadId = window._clustersLoadId = (window._clustersLoadId || 0) + 1;
            const MAX_RETRIES = 4;

            _renderClustersMessage('Loading…', 'info');

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const res = await fetch(url, { credentials: 'same-origin' });
                    if (loadId !== window._clustersLoadId) return;

                    if (res.status === 429 && attempt < MAX_RETRIES) {
                        const retryAfterHdr = parseInt(res.headers.get('Retry-After') || '', 10);
                        const waitSec = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
                            ? Math.min(retryAfterHdr, 60)
                            : Math.min(5 * Math.pow(2, attempt), 60);
                        _renderClustersMessage(
                            'Rate-limited — retrying in ' + waitSec + 's… '
                                + '<span class="text-xs text-gray-500">(attempt ' + (attempt + 1) + ' of ' + MAX_RETRIES + ')</span>',
                            'warn',
                        );
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                        if (loadId !== window._clustersLoadId) return;
                        continue;
                    }
                    if (res.status === 401 || res.status === 403) {
                        _renderClustersMessage(
                            'Not authorized to view clusters. Ask an admin to grant your account the duplicate-radar read role.',
                            'error',
                        );
                        return;
                    }
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    if (loadId !== window._clustersLoadId) return;

                    renderClusters(data.clusters || []);
                    renderPagination('clustersPagination', page, data.pages || 1, loadClusters, data.total, 'clusters');
                    const hint = document.getElementById('layoutFilterHint');
                    if (hint) hint.textContent = layout ? WalaPlusI18n.t('dyn.duplicates.filtered_in_layout', { n: _fn(data.total ?? 0), layout: layout }) : '';
                    window._loadedTabs.add('clusters');
                    return;
                } catch (e) {
                    if (loadId !== window._clustersLoadId) return;
                    const msg = String(e && e.message || e);
                    _renderClustersMessage(
                        /HTTP 429/.test(msg)
                            ? 'Still rate-limited after ' + (MAX_RETRIES + 1) + ' attempts. Wait a minute and click Refresh.'
                            : 'Failed to load: ' + escapeHtml(msg),
                        'error',
                    );
                    return;
                }
            }
        }

        function toggleClusterSortDir() {
            const btn = document.getElementById('clusterSortDir');
            if (!btn) return;
            const next = btn.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';
            btn.setAttribute('data-sort-dir', next);
            btn.textContent = next === 'asc' ? '↑' : '↓';
            loadClusters(0);
        }

        async function populateLayoutFilter() {
            const sel = document.getElementById('layoutFilter');
            if (!sel || sel.dataset.loaded === '1') return;
            try {
                const res = await fetch('/api/duplicates/filters/options');
                const data = await res.json();
                const current = sel.value;
                const opts = ['<option value="">All Layouts</option>']
                    .concat((data.layouts || []).map(l => `<option value="${escAttr(l)}">${escapeHtml(l)}</option>`));
                sel.innerHTML = opts.join('');
                if (current) sel.value = current;
                sel.dataset.loaded = '1';
            } catch (e) {
                console.warn('Failed to load layouts for cluster tab filter:', e);
            }
        }

        // Data-quality flags shown at the top of each cluster card so users can
        // triage without opening every modal. All three are cheap derivations
        // from fields already on the cluster row.
        //   - synthetic: cluster keyed on a name-built ".cluster" pseudo-domain
        //     (no real Company_Domain available at sync time)
        //   - placeholder: routed to the quarantine bucket because the company
        //     name was a sentinel value like "N/A" / "لا يوجد" — needs CS to
        //     backfill the real name in Zoho
        //   - mixed: 2+ distinct corporate email domains across the cluster's
        //     records (domain_count comes from the list-endpoint subquery).
        //     Almost always means unrelated companies sharing a name fragment.
        function clusterCardFlags(c) {
            const flags = [];
            const isPlaceholder = c.domain === '_placeholder.cluster';
            const isSynthetic = typeof c.domain === 'string' && c.domain.endsWith('.cluster') && !isPlaceholder;
            const isMixed = Number(c.domain_count || 0) >= 2;
            if (isPlaceholder) {
                flags.push('<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-800" title="Placeholder company name — CS needs to backfill the real name in Zoho">❓ placeholder</span>');
            } else if (isSynthetic) {
                flags.push('<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800" title="Synthetic cluster — built from normalized company name, not a real corporate domain. Going forward these only form when there is no email/phone identity either.">🔧 synthetic</span>');
            }
            if (isMixed) {
                flags.push('<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800" title="' + Number(c.domain_count) + ' distinct corporate domains inside this cluster — usually two unrelated companies sharing a name fragment. Open the cluster and use Split by domain.">⚠ mixed (' + Number(c.domain_count) + ')</span>');
            }
            return flags.length ? '<div class="flex flex-wrap gap-1 mb-2">' + flags.join('') + '</div>' : '';
        }

        // Cache the most recent server page so the client-side quality
        // filter can re-paint without re-fetching.
        let _lastClustersPage = [];

        // Classify a cluster against the three card-badge flags so the
        // qualityFilter dropdown matches what users actually see on the
        // card. Mirrors the logic in clusterCardFlags().
        function clusterQualityKind(c) {
            const isPlaceholder = c.domain === '_placeholder.cluster';
            const isSynthetic = typeof c.domain === 'string' && c.domain.endsWith('.cluster') && !isPlaceholder;
            const isMixed = Number(c.domain_count || 0) >= 2;
            if (isPlaceholder) return 'placeholder';
            if (isSynthetic) return 'synthetic';
            if (isMixed) return 'mixed';
            return 'clean';
        }

        function applyQualityFilter() {
            renderClusters(_lastClustersPage);
        }

        function renderClusters(clusters) {
            _lastClustersPage = Array.isArray(clusters) ? clusters : [];
            const qSel = document.getElementById('qualityFilter');
            const quality = qSel ? qSel.value : '';
            const filtered = quality
                ? _lastClustersPage.filter(c => clusterQualityKind(c) === quality)
                : _lastClustersPage;
            const hint = document.getElementById('qualityFilterHint');
            if (hint) {
                hint.textContent = quality
                    ? `${_fn(filtered.length)} of ${_fn(_lastClustersPage.length)} on this page match`
                    : '';
            }
            document.getElementById('clustersGrid').innerHTML = filtered.map(c => `
                <div class="bg-white rounded-lg shadow p-4 cluster-card cursor-pointer" data-on-click="showClusterDetails" data-args="[${c.id}]" data-testid="card-cluster-${c.id}">
                    ${clusterCardFlags(c)}
                    <div class="flex justify-between items-start mb-3">
                        <div>
                            <h4 class="font-semibold text-gray-900">${escapeHtml(c.domain)}</h4>
                            <p class="text-sm text-gray-500">${escapeHtml(c.company_name || '')}</p>
                        </div>
                        <span class="confidence-${['high','medium','low'].includes(c.confidence_level)?c.confidence_level:'low'} px-2 py-1 rounded text-xs font-medium">${c.confidence_score}%</span>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-sm">
                        <div><span class="text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.leads'))}</span> <span class="font-medium text-amber-600">${_fn(c.total_leads)}</span></div>
                        <div><span class="text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.deals'))}</span> <span class="font-medium text-red-600">${_fn(c.total_deals)}</span></div>
                        <div><span class="text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.contacts'))}</span> <span class="font-medium text-teal-600">${_fn(c.total_contacts||0)}</span></div>
                        <div><span class="text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.accounts'))}</span> <span class="font-medium text-indigo-600">${_fn(c.total_accounts||0)}</span></div>
                        <div><span class="text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.status_kw'))}</span> <span class="font-medium capitalize">${escapeHtml(c.status)}</span></div>
                        <div title="Pipeline inflation — sum of deal values for non-primary (duplicate) deals in this cluster. Not the cluster's total pipeline value."><span class="text-gray-500">Inflation:</span> <span class="font-medium">${formatCurrency(c.estimated_pipeline_value||0)}</span></div>
                    </div>
                </div>
            `).join('') || `<div class="col-span-3 text-center py-8 text-gray-400">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_clusters_found'))}</div>`;
        }

        // Pagination renderer (rewritten 2026-05-30).
        //
        // The previous implementation built buttons with
        //   data-on-click="${callback.name}"
        // and let the safe-actions delegator dispatch the click. That
        // shape silently broke for any caller that passed an ARROW
        // function — JavaScript reports `.name === ""` for arrows, so
        // the rendered attribute was `data-on-click=""`, the delegator
        // found no handler, and the Next / Prev buttons did nothing.
        // Both record-tab pagination call-sites
        //   renderPagination(type + 'Pagination', page, pages,
        //                    (p) => loadRecordTab(type, p))
        // hit exactly this gap, so Next was dead on every Lead / Deal /
        // Contact / Account duplicates tab.
        //
        // Fix: bind the callback directly via addEventListener, no
        // .name dependency. Works identically whether the caller passes
        // a named function declaration (loadClusters) or an inline
        // arrow expression. CSP-clean — listeners attached
        // programmatically don't violate any inline-handler policy.
        // Page size used by every paginated tab in the radar (Domain
        // Clusters + the 4 record-tab Duplicate views). Centralised so
        // the operator can change it in one place if they prefer denser
        // pages later. Smaller pages = lower viewport scroll burden +
        // faster server response on each click.
        // Sarah Hijazi (2026-06-10): kept at 20 clusters per page. The
        // backend paginates by cluster but the frontend re-buckets the
        // returned records by visible signals (name / email / phone /
        // website / CRM ID) and only renders groups with ≥2 cross-record
        // matches. At 10 per page many windows had no overlap → blank
        // pages mid-pagination; 20 gives enough volume per page to keep
        // visible group hit rate high while still scrolling cleanly.
        const RADAR_PAGE_SIZE = 20;

        // renderPagination(containerId, currentPage, totalPages, callback,
        //                  totalRecords?, unitLabel?)
        // Renders:  [Prev]  Page X of Y · M total records  [Next]
        // When totalPages <= 1 we still render the "M total records"
        // chip on its own so the operator always sees the corpus size,
        // not just a blank strip.
        function renderPagination(containerId, currentPage, totalPages, callback, totalRecords, unitLabel) {
            const el = document.getElementById(containerId);
            if (!el) return;
            el.innerHTML = '';

            const showButtons = totalPages > 1;
            const btnClass = 'px-3 py-1 bg-white border rounded hover:bg-gray-50 text-sm';

            if (showButtons && currentPage > 0) {
                const prevBtn = document.createElement('button');
                prevBtn.type = 'button';
                prevBtn.className = btnClass;
                prevBtn.textContent = WalaPlusI18n.t('dyn.common.prev_short');
                const prevPage = currentPage - 1;
                prevBtn.addEventListener('click', () => {
                    try { callback(prevPage); }
                    catch (e) { console.error('[renderPagination] prev callback threw:', e); }
                });
                el.appendChild(prevBtn);
            }

            // Status line: page indicator (when multi-page) + always the
            // total record count when supplied. "20 of 1,234 accounts" beats
            // "Page 2 of 62" alone because the operator immediately sees
            // the corpus they're working through.
            const status = document.createElement('span');
            status.className = 'px-3 py-1 text-sm text-gray-600 font-medium';
            const parts = [];
            if (showButtons) {
                parts.push(WalaPlusI18n.t('dyn.common.page_x_of_y', {
                    current: _fn(currentPage + 1),
                    total: _fn(totalPages),
                }));
            }
            if (Number.isFinite(Number(totalRecords))) {
                const unit = String(unitLabel || 'records');
                const startRow = currentPage * RADAR_PAGE_SIZE + 1;
                const endRow   = Math.min((currentPage + 1) * RADAR_PAGE_SIZE, Number(totalRecords));
                if (showButtons) {
                    parts.push(_fn(startRow) + '–' + _fn(endRow) + ' of ' + _fn(totalRecords) + ' ' + unit);
                } else {
                    parts.push(_fn(totalRecords) + ' ' + unit);
                }
            }
            status.textContent = parts.join(' · ');
            el.appendChild(status);

            if (showButtons && currentPage < totalPages - 1) {
                const nextBtn = document.createElement('button');
                nextBtn.type = 'button';
                nextBtn.className = btnClass;
                nextBtn.textContent = WalaPlusI18n.t('dyn.common.next_short');
                const nextPage = currentPage + 1;
                nextBtn.addEventListener('click', () => {
                    try { callback(nextPage); }
                    catch (e) { console.error('[renderPagination] next callback threw:', e); }
                });
                el.appendChild(nextBtn);
            }
        }

        // C4: Paginated record tabs (20/page)
        let recordPages = { leads: 0, deals: 0, contacts: 0, accounts: 0 };

        // Full-dataset, server-side column sort for the Lead/Deal/Contact/
        // Account Duplicates tabs (mirrors the Domain Clusters sort/dir
        // pattern at loadClusters() above — same query-param contract,
        // clickable <th> headers instead of a dropdown). Independent
        // per-tab state so sorting Leads doesn't affect Deals/Contacts/
        // Accounts. { key: <sort key or null>, dir: 'asc'|'desc' }. key=null
        // means "no sort selected" → server falls back to its default
        // (confidence DESC, id ASC).
        window._recordSort = window._recordSort || {
            leads: { key: null, dir: 'desc' },
            deals: { key: null, dir: 'desc' },
            contacts: { key: null, dir: 'desc' },
            accounts: { key: null, dir: 'desc' },
        };

        // Click handler for the sortable <th> headers on the four record
        // tabs. Same toggle convention as erSortBy(): clicking the active
        // column flips its direction; clicking a new column selects it
        // descending first (matches clusterSort's "biggest first" default).
        // Always resets to page 0 — a sort change reorders the WHOLE
        // dataset server-side, so the previous page offset is meaningless.
        function recordSortBy(tab, key) {
            const st = window._recordSort[tab] || (window._recordSort[tab] = { key: null, dir: 'desc' });
            if (st.key === key) {
                st.dir = st.dir === 'asc' ? 'desc' : 'asc';
            } else {
                st.key = key;
                st.dir = 'desc';
            }
            _updateRecordSortCarets(tab);
            loadRecordTab(tab, 0);
        }

        // Paint a caret (↑/↓) on the active sort column's header for `tab`,
        // clearing any caret left over from a previously-active column.
        // Headers carry data-sort-key="<tab>:<key>" and a child
        // .record-sort-caret span — see dashboard/duplicates.html.
        function _updateRecordSortCarets(tab) {
            const st = window._recordSort[tab];
            document.querySelectorAll('th[data-sort-key^="' + tab + ':"] .record-sort-caret').forEach(function (el) {
                const th = el.closest('th');
                const k = (th.getAttribute('data-sort-key') || '').split(':')[1];
                el.textContent = (st && st.key === k) ? (st.dir === 'asc' ? ' ↑' : ' ↓') : '';
            });
        }
        // Generic "Refresh from Zoho (live)" engine — scrapes the visible
        // Zoho ids out of a tbody (via the data-testid="link-zoho-<id>"
        // anchors emitted by zohoLink()), infers each row's Zoho module
        // from the anchor's href (/tab/Leads/... etc), groups ids by
        // module, and posts each group to /api/duplicates/refresh-records.
        // This lets tabs that mix record types (Cross-Module, CS Overlap,
        // Account Hints) all use the same one-click live-sync UX as the
        // per-module Leads/Deals/Contacts/Accounts tabs.
        //
        // opts = { reload?: () => Promise|void, silent?: bool }
        //   reload — invoked after a successful refresh to repaint the
        //            tab from its own data source. If omitted, the tab is
        //            left as-is and only the refreshed values land in
        //            the underlying duplicate_records table.
        //   silent — suppress alert popups (for chained callers).
        async function refreshTbodyFromZoho(tbodyId, btnId, opts) {
            const silent = !!(opts && opts.silent);
            const reload = opts && opts.reload;
            const tbody = document.getElementById(tbodyId);
            const btn = btnId ? document.getElementById(btnId) : null;
            if (!tbody) return { refreshed: 0, skipped: true };

            // Collect (module, id) pairs from every Zoho-link anchor in
            // the table body. The module name is read from the href so
            // mixed-module tabs (Cross-Module, CS Overlap, Account Hints)
            // are dispatched correctly without needing tab-specific code.
            const MODULE_FROM_TAB = {
                Leads: 'leads',
                Deals: 'deals',
                Contacts: 'contacts',
                Accounts: 'accounts',
            };
            const byModule = { leads: new Set(), deals: new Set(), contacts: new Set(), accounts: new Set() };
            const anchors = tbody.querySelectorAll('a[data-testid^="link-zoho-"]');
            for (const a of anchors) {
                const id = (a.getAttribute('data-testid') || '').replace(/^link-zoho-/, '');
                if (!id || id.startsWith('test_') || id.startsWith('LEAD_') || id.startsWith('DEAL_')) continue;
                const href = a.getAttribute('href') || '';
                const m = href.match(/\/tab\/(Leads|Deals|Contacts|Accounts)\//);
                if (!m) continue;
                const moduleKey = MODULE_FROM_TAB[m[1]];
                if (!moduleKey) continue;
                byModule[moduleKey].add(id);
            }
            const totalIds = Object.values(byModule).reduce((n, s) => n + s.size, 0);
            if (totalIds === 0) {
                if (!silent) alert('No Zoho records on this view to refresh.');
                return { refreshed: 0, skipped: true };
            }

            const orig = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Refreshing ' + totalIds + ' record' + (totalIds === 1 ? '' : 's') + '…';
            }
            try {
                const CHUNK = 50;
                let totalRefreshed = 0, totalFailed = 0, totalMissing = 0;
                for (const [moduleKey, set] of Object.entries(byModule)) {
                    const ids = Array.from(set);
                    if (ids.length === 0) continue;
                    for (let i = 0; i < ids.length; i += CHUNK) {
                        const slice = ids.slice(i, i + CHUNK);
                        const res = await fetch('/api/duplicates/refresh-records', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ module: moduleKey, zohoIds: slice }),
                        });
                        if (!res.ok) {
                            const err = await res.json().catch(() => ({}));
                            throw new Error(err.error || ('HTTP ' + res.status));
                        }
                        const json = await res.json();
                        totalRefreshed += json.refreshed_count || 0;
                        totalFailed += json.failed_count || 0;
                        totalMissing += json.missing_count || 0;
                    }
                }
                const notes = [];
                if (totalFailed) notes.push(totalFailed + ' failed');
                if (totalMissing) notes.push(totalMissing + ' not found in Zoho');
                if (btn) {
                    btn.innerHTML = '✓ Refreshed ' + totalRefreshed + (notes.length ? ' (' + notes.join(', ') + ')' : '');
                }
                if (typeof reload === 'function') {
                    try { await reload(); } catch (_) {}
                }
                if (btn) setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                return { refreshed: totalRefreshed, failed: totalFailed, missing: totalMissing };
            } catch (e) {
                if (btn) {
                    btn.innerHTML = '✗ Failed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
                if (!silent) {
                    alert('Refresh from Zoho failed: ' + (e.message || e));
                } else {
                    try { console.error('Refresh from Zoho failed:', e); } catch (_) {}
                }
                return { refreshed: 0, error: String(e && e.message || e) };
            }
        }

        // Cluster-aware live refresh — used by Cross-Module and CS Overlap
        // tabs where each visible row represents a cluster (not a single
        // Zoho record) and links to showClusterDetails(clusterId). For
        // each visible cluster we fetch its constituent records via the
        // existing /api/duplicates/clusters/:id endpoint, group those
        // records' Zoho ids by module, and reuse the same per-module
        // refresh-records endpoint as every other tab.
        async function refreshClustersFromZoho(tbodyId, btnId, opts) {
            const silent = !!(opts && opts.silent);
            const reload = opts && opts.reload;
            const tbody = document.getElementById(tbodyId);
            const btn = btnId ? document.getElementById(btnId) : null;
            if (!tbody) return { refreshed: 0, skipped: true };

            // Scrape unique cluster IDs from data-args of any row element
            // that opens the cluster detail modal.
            const clusterIds = new Set();
            const triggers = tbody.querySelectorAll('[data-on-click="showClusterDetails"][data-args]');
            for (const el of triggers) {
                try {
                    const args = JSON.parse(el.getAttribute('data-args') || '[]');
                    const id = Number(args[0]);
                    if (Number.isFinite(id) && id > 0) clusterIds.add(id);
                } catch (_) { /* ignore malformed data-args */ }
            }
            if (clusterIds.size === 0) {
                if (!silent) alert('No clusters on this view to refresh.');
                return { refreshed: 0, skipped: true };
            }

            const orig = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Resolving ' + clusterIds.size + ' cluster' + (clusterIds.size === 1 ? '' : 's') + '…';
            }

            const RECORD_TYPE_TO_MODULE = { lead: 'leads', deal: 'deals', contact: 'contacts', account: 'accounts' };
            const byModule = { leads: new Set(), deals: new Set(), contacts: new Set(), accounts: new Set() };

            try {
                // Fetch cluster contents with bounded parallelism so we
                // don't fan out hundreds of requests at once.
                const ids = Array.from(clusterIds);
                const POOL = 6;
                let idx = 0;
                async function worker() {
                    while (idx < ids.length) {
                        const cid = ids[idx++];
                        try {
                            const r = await fetch('/api/duplicates/clusters/' + cid);
                            if (!r.ok) continue;
                            const j = await r.json();
                            for (const rec of (j.records || [])) {
                                const mod = RECORD_TYPE_TO_MODULE[String(rec.record_type || '').toLowerCase()];
                                const zid = rec.zoho_record_id;
                                if (!mod || !zid || typeof zid !== 'string') continue;
                                if (zid.startsWith('test_') || zid.startsWith('LEAD_') || zid.startsWith('DEAL_')) continue;
                                byModule[mod].add(zid);
                            }
                        } catch (_) { /* skip individual cluster failures */ }
                    }
                }
                await Promise.all(Array.from({ length: Math.min(POOL, ids.length) }, worker));

                const totalIds = Object.values(byModule).reduce((n, s) => n + s.size, 0);
                if (totalIds === 0) {
                    if (btn) {
                        btn.innerHTML = 'No Zoho records resolved';
                        setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                    }
                    return { refreshed: 0, skipped: true };
                }

                if (btn) btn.innerHTML = 'Refreshing ' + totalIds + ' record' + (totalIds === 1 ? '' : 's') + '…';
                const CHUNK = 50;
                let totalRefreshed = 0, totalFailed = 0, totalMissing = 0;
                for (const [moduleKey, set] of Object.entries(byModule)) {
                    const arr = Array.from(set);
                    for (let i = 0; i < arr.length; i += CHUNK) {
                        const slice = arr.slice(i, i + CHUNK);
                        const res = await fetch('/api/duplicates/refresh-records', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ module: moduleKey, zohoIds: slice }),
                        });
                        if (!res.ok) {
                            const err = await res.json().catch(() => ({}));
                            throw new Error(err.error || ('HTTP ' + res.status));
                        }
                        const json = await res.json();
                        totalRefreshed += json.refreshed_count || 0;
                        totalFailed += json.failed_count || 0;
                        totalMissing += json.missing_count || 0;
                    }
                }
                const notes = [];
                if (totalFailed) notes.push(totalFailed + ' failed');
                if (totalMissing) notes.push(totalMissing + ' not found in Zoho');
                if (btn) btn.innerHTML = '✓ Refreshed ' + totalRefreshed + (notes.length ? ' (' + notes.join(', ') + ')' : '');
                if (typeof reload === 'function') { try { await reload(); } catch (_) {} }
                if (btn) setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                return { refreshed: totalRefreshed, failed: totalFailed, missing: totalMissing };
            } catch (e) {
                if (btn) {
                    btn.innerHTML = '✗ Failed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
                if (!silent) alert('Refresh from Zoho failed: ' + (e.message || e));
                return { refreshed: 0, error: String(e && e.message || e) };
            }
        }

        // Tab-specific wrappers that point the generic engines at the
        // right tbody / button / reload function for each tab.
        async function refreshCrossModuleFromZoho(opts) {
            // Each Cross-Module row is a cluster (no per-record Zoho
            // anchors), so resolve cluster IDs to constituent records.
            return refreshClustersFromZoho('crossModuleTable', 'crossModuleZohoRefreshBtn', {
                reload: () => loadCrossModule(),
                silent: !!(opts && opts.silent),
            });
        }
        async function refreshCsOverlapFromZoho(opts) {
            // Each CS Overlap row is also a cluster — same resolution path.
            return refreshClustersFromZoho('csOverlapTable', 'csOverlapZohoRefreshBtn', {
                reload: () => loadCsOverlap(window._csOverlapFilter || 'all'),
                silent: !!(opts && opts.silent),
            });
        }
        async function refreshAccountHintsFromZoho(opts) {
            // Account Hints rows render Deal/Account/Contact Zoho links
            // directly, so the anchor-scrape engine works as-is.
            return refreshTbodyFromZoho('accountHintsTable', 'accountHintsZohoRefreshBtn', {
                reload: () => loadAccountHints(),
                silent: !!(opts && opts.silent),
            });
        }
        // Owner Accountability has no per-record Zoho ids in its table
        // (it's an aggregate per-owner scorecard computed from the locally
        // synced duplicate_records). The button reloads the aggregate so
        // owners see whatever the most-recent global sync produced; for a
        // true live re-pull of every record the user should click the
        // top-header "Sync Now" button which scans the whole CRM.
        async function refreshOwnersFromZoho() {
            const btn = document.getElementById('ownersZohoRefreshBtn');
            const orig = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Refreshing…';
            }
            try {
                if (typeof loadOwners === 'function') {
                    await loadOwners();
                }
                if (btn) {
                    btn.innerHTML = '✓ Refreshed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
            } catch (e) {
                if (btn) {
                    btn.innerHTML = '✗ Failed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
                alert('Refresh failed: ' + (e.message || e));
            }
        }

        // Per-module live refresh from Zoho. Same UX as the green
        // "Refresh from Zoho (live)" button on the CS Lifecycle tab, but
        // generic so every per-module tab (Leads / Deals / Contacts /
        // Accounts) gets the same one-click sync. Reads the Zoho IDs of
        // every row currently rendered in the module's table (via the
        // data-testid="link-zoho-<id>" anchors that zohoLink() emits),
        // POSTs them to /api/duplicates/refresh-records, then reloads the
        // visible page so updated values appear immediately.
        async function refreshModuleTableFromZoho(module, opts) {
            const silent = !!(opts && opts.silent);
            const TABLE_BY_MODULE = {
                leads: 'leadsTable',
                deals: 'dealsTable',
                contacts: 'contactsTable',
                accounts: 'accountsTable',
            };
            const BTN_BY_MODULE = {
                leads: 'leadsZohoRefreshBtn',
                deals: 'dealsZohoRefreshBtn',
                contacts: 'contactsZohoRefreshBtn',
                accounts: 'accountsZohoRefreshBtn',
            };
            const tbody = document.getElementById(TABLE_BY_MODULE[module]);
            const btn = document.getElementById(BTN_BY_MODULE[module]);
            if (!tbody) return { refreshed: 0, skipped: true };
            const ids = Array.from(new Set(
                Array.from(tbody.querySelectorAll('a[data-testid^="link-zoho-"]'))
                    .map(a => (a.getAttribute('data-testid') || '').replace(/^link-zoho-/, ''))
                    .filter(id => id && !id.startsWith('test_') && !id.startsWith('LEAD_') && !id.startsWith('DEAL_'))
            ));
            if (ids.length === 0) {
                if (!silent) alert('No records on this page to refresh.');
                return { refreshed: 0, skipped: true };
            }
            const orig = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Refreshing ' + ids.length + ' record' + (ids.length === 1 ? '' : 's') + '…';
            }
            try {
                // Backend caps each call at 50 records; batch larger pages.
                const CHUNK = 50;
                let totalRefreshed = 0, totalFailed = 0, totalMissing = 0;
                for (let i = 0; i < ids.length; i += CHUNK) {
                    const slice = ids.slice(i, i + CHUNK);
                    const res = await fetch('/api/duplicates/refresh-records', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ module: module, zohoIds: slice }),
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error || ('HTTP ' + res.status));
                    }
                    const json = await res.json();
                    totalRefreshed += json.refreshed_count || 0;
                    totalFailed += json.failed_count || 0;
                    totalMissing += json.missing_count || 0;
                }
                const notes = [];
                if (totalFailed) notes.push(totalFailed + ' failed');
                if (totalMissing) notes.push(totalMissing + ' not found in Zoho');
                if (btn) {
                    btn.innerHTML = '✓ Refreshed ' + totalRefreshed + (notes.length ? ' (' + notes.join(', ') + ')' : '');
                }
                await loadRecordTab(module, (typeof recordPages !== 'undefined' && recordPages[module]) || 0);
                if (btn) setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                return { refreshed: totalRefreshed, failed: totalFailed, missing: totalMissing };
            } catch (e) {
                if (btn) {
                    btn.innerHTML = '✗ Failed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
                if (!silent) {
                    alert('Refresh from Zoho failed: ' + (e.message || e));
                } else {
                    try { console.error('Refresh from Zoho failed:', e); } catch (_) {}
                }
                return { refreshed: 0, error: String(e && e.message || e) };
            }
        }

        // Track which record/cluster tabs have already loaded so we don't
        // refetch them just because the user clicked the tab again. Cleared
        // by refreshData() and after a successful sync.
        window._loadedTabs = window._loadedTabs || new Set();

        // Render a one-row table message into the tab's tbody so 429/error
        // states are visible instead of looking like "no data". Column count
        // varies per tab; pick a value that spans every column in the table
        // header (leads has 8 columns, deals 7, contacts 7, accounts 8).
        function _recordTabColspan(type) {
            return type === 'deals' || type === 'contacts' ? 7 : 8;
        }
        function _renderRecordTabMessage(type, html, tone) {
            const tbody = document.getElementById(type + 'Table');
            if (!tbody) return;
            const palette = {
                info:   'text-gray-500',
                warn:   'text-amber-700',
                error:  'text-red-600',
            };
            const colorClass = palette[tone] || palette.info;
            tbody.innerHTML = '<tr><td colspan="' + _recordTabColspan(type)
                + '" class="px-4 py-8 text-center text-sm ' + colorClass + '">'
                + html + '</td></tr>';
        }

        // Per-tab AI-status chip state. Default 'active' = untouched clusters
        // (no merge_action yet). The chip set lets the operator toggle to
        // tagged-pending / resolved / all without leaving the tab.
        window._aiStatusByTab = window._aiStatusByTab || {};
        function setAiStatus(tab, status) {
            window._aiStatusByTab[tab] = status;
            // Repaint the chip row so the active one is highlighted.
            ['active','tagged_pending','resolved','dismissed','all'].forEach(s => {
                const el = document.getElementById('aiChip-' + tab + '-' + s);
                if (!el) return;
                const isActive = s === status;
                const palette = {
                    active:         { on: 'bg-gray-900 text-white',           off: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
                    tagged_pending: { on: 'bg-amber-600 text-white',          off: 'bg-amber-100 text-amber-700 hover:bg-amber-200' },
                    resolved:       { on: 'bg-emerald-600 text-white',        off: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' },
                    dismissed:      { on: 'bg-gray-600 text-white',           off: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
                    all:            { on: 'bg-gray-700 text-white',           off: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
                };
                el.className = 'px-3 py-1 text-xs font-semibold rounded-full ' + (isActive ? palette[s].on : palette[s].off);
            });
            // Reload the tab with the new filter. Re-enter loadRecordTab for
            // module tabs; the per-tab cache is invalidated by the param change.
            window._loadedTabs && window._loadedTabs.delete(tab);
            if (['leads','deals','contacts','accounts'].includes(tab)) {
                loadRecordTab(tab, 0);
            }
            // Selection doesn't carry across filters; reset + refresh the bulk bar
            // (it stays visible on Dismissed/Resolved for Select-all + Re-open).
            window._dupBulkSel = new Set();
            if (typeof _renderDupBulkBar === 'function') _renderDupBulkBar();
        }

        async function loadRecordTab(type, page = 0) {
            recordPages[type] = page;
            // Per-tab Advanced Filters: the same filter selections (owner,
            // layout, pipeline, stage, confidence, domain, date range) constrain
            // the rows shown inside this tab. The server ignores the Module
            // filter here because the tab itself pins the module.
            const params = buildFilterParams();
            params.set('limit', String(RADAR_PAGE_SIZE));
            params.set('offset', String(page * RADAR_PAGE_SIZE));
            // Full-dataset server-side column sort (clickable <th> headers).
            // Omitted entirely when no column is selected so the server uses
            // its default order (confidence DESC, id ASC) unchanged.
            const sortState = (window._recordSort && window._recordSort[type]) || null;
            if (sortState && sortState.key) {
                params.set('sort', sortState.key);
                params.set('dir', sortState.dir);
            }
            const url = `/api/duplicates/${type}?` + params.toString();

            // Cancel any older in-flight load for this tab so a quick double
            // click / paginate doesn't race with the previous fetch.
            const loadKey = '_recordTabLoadId_' + type;
            const loadId = window[loadKey] = (window[loadKey] || 0) + 1;
            const MAX_RETRIES = 4;

            _renderRecordTabMessage(type, 'Loading…', 'info');

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const res = await fetch(url, { credentials: 'same-origin' });
                    if (loadId !== window[loadKey]) return; // superseded

                    // Rate-limited by our own limiter (READ_LIMIT=100/min/user).
                    // Honor Retry-After when present, else exponential backoff
                    // (5s → 10s → 20s → 40s, capped at 60s).
                    if (res.status === 429 && attempt < MAX_RETRIES) {
                        const retryAfterHdr = parseInt(res.headers.get('Retry-After') || '', 10);
                        const waitSec = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
                            ? Math.min(retryAfterHdr, 60)
                            : Math.min(5 * Math.pow(2, attempt), 60);
                        _renderRecordTabMessage(
                            type,
                            'Rate-limited — retrying in ' + waitSec + 's… '
                                + '<span class="text-xs text-gray-500">(attempt ' + (attempt + 1) + ' of ' + MAX_RETRIES + ')</span>',
                            'warn',
                        );
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                        if (loadId !== window[loadKey]) return;
                        continue;
                    }
                    if (res.status === 401 || res.status === 403) {
                        _renderRecordTabMessage(
                            type,
                            'Not authorized to view this data. Ask an admin to grant your account the duplicate-radar read role.',
                            'error',
                        );
                        return;
                    }
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    if (loadId !== window[loadKey]) return;

                    const groups = data.groups || [];
                    const pages  = data.pages  || 1;
                    const total  = data.total_duplicate_groups;
                    let shown;
                    if (type === 'leads')        shown = renderLeadRows(groups);
                    else if (type === 'deals')   shown = renderDealRows(groups);
                    else if (type === 'contacts') shown = renderContactRows(groups);
                    else if (type === 'accounts') shown = renderAccountRows(groups);
                    // On a single page, trust the COUNT THE TABLE ACTUALLY RENDERED
                    // over the server's raw cluster count — the client drops
                    // colleague/chained-match clusters, so the server total can read
                    // "5 duplicate groups" while the table shows none. Multi-page
                    // tabs keep the server total (other pages still have groups).
                    const footerTotal = (typeof shown === 'number' && pages <= 1) ? shown : total;
                    renderPagination(type + 'Pagination', page, pages, (p) => loadRecordTab(type, p), footerTotal, 'duplicate groups');
                    window._loadedTabs.add(type);
                    return;
                } catch (e) {
                    if (loadId !== window[loadKey]) return;
                    const msg = String(e && e.message || e);
                    _renderRecordTabMessage(
                        type,
                        /HTTP 429/.test(msg)
                            ? 'Still rate-limited after ' + (MAX_RETRIES + 1) + ' attempts. Wait a minute and click Refresh.'
                            : 'Failed to load: ' + escapeHtml(msg),
                        'error',
                    );
                    return;
                }
            }
        }

        function zohoLink(id, module, label) {
            // When a custom label is provided (e.g. "render the account name as
            // the clickable text rather than the Zoho record id"), it must be
            // HTML-escaped — the id-only path is safe because Zoho ids are
            // numeric, but free-text labels can contain quotes/brackets.
            const text = label != null ? escapeHtml(String(label)) : (id || '-');
            if (!id || id.startsWith('test_') || id.startsWith('LEAD_') || id.startsWith('DEAL_')) return `<span class="text-xs font-mono text-gray-400">${text}</span>`;
            return `<a href="https://crm.zoho.com/crm/org766568398/tab/${module}/${id}" target="_blank" class="text-blue-600 hover:underline text-xs font-mono" data-testid="link-zoho-${id}">${text}</a>`;
        }

        // Render the "Created By" cell from the Zoho raw_data payload.
        // Shows the creator's name on top and the formatted date/time below.
        function createdByCell(r) {
            const raw = r && r.raw_data ? r.raw_data : {};
            const name = (raw.Created_By && raw.Created_By.name) || r.created_by_name || '-';
            const ts = raw.Created_Time || r.created_date || r.created_at || null;
            let when = '';
            if (ts) {
                const d = new Date(ts);
                if (!isNaN(d.getTime())) {
                    when = _fd(d, {
                        year: 'numeric', month: 'short', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', hour12: false
                    });
                }
            }
            return `<td class="px-4 py-3 text-sm">
                <div class="text-gray-700 font-medium">${escapeHtml(name)}</div>
                ${when ? `<div class="text-xs text-gray-400">${when}</div>` : ''}
            </td>`;
        }

        // R8 (quick wins): turn each record-table row's Domain cell into a
        // clickable "open this cluster" link. Operators previously had to
        // copy the company name and search in the Clusters tab. Reuses the
        // existing showClusterDetails modal so context (current tab, filters)
        // is preserved.
        function clusterDomainCell(r) {
            const label = escapeHtml(r.cluster_domain || r.domain || '-');
            const cid = r && r.cluster_id;
            if (!cid) {
                return `<td class="px-4 py-3 text-sm font-medium text-blue-600">${label}</td>`;
            }
            return `<td class="px-4 py-3 text-sm font-medium"><a href="javascript:void(0)" data-on-click="showClusterDetails" data-args="[${cid}]" class="text-blue-600 hover:text-blue-800 hover:underline" title="View this cluster's full record set + recommendations" data-testid="link-record-cluster-${cid}">${label}</a></td>`;
        }

        // Pull a usable phone for a lead row. Zoho exposes both Phone and
        // Mobile separately, and the duplicate scan should treat either as
        // a match key — many reps put the cell number in the wrong field.
        function leadPhone(r) {
            const raw = r && r.raw_data ? r.raw_data : {};
            return r.phone || raw.Phone || raw.Mobile || raw.Home_Phone || '';
        }

        // Normalize values for cross-row matching:
        //   email → lowercase + trim   ("Ali@X.com" == "ali@x.com")
        //   phone → digits only        ("+966 50 123 4567" == "966501234567")
        //   name  → lowercase + collapse whitespace ("Ali  AL Mikhdam" == "ali al mikhdam")
        function _normEmail(s) { return String(s || '').trim().toLowerCase(); }
        // Canonicalize phones the SAME way the backend normalizePhone does, so
        // a Saudi local format (0535807059) and international (+966 53 580 7059)
        // compare equal: strip non-digits, drop a leading 00 / 966 country code,
        // keep the last 9 digits (the national significant number). Without this
        // the DUP SIGNAL showed "name" only on pairs that actually share a phone.
        function _normPhone(s) {
            return String(s || '').replace(/\D+/g, '').replace(/^00/, '').replace(/^966/, '').slice(-9);
        }
        // Arabic-aware name normalizer (mirrors the backend normalizePersonName):
        // NFKC, strip bidi/zero-width marks + tatweel + diacritics, fold the
        // common Arabic letter variants (آأإ→ا, ى→ي, ة→ه), collapse whitespace,
        // lowercase — so visually-identical Arabic names group reliably.
        function _normName(s) {
            return String(s || '')
                .normalize('NFKC')
                .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
                .replace(/\u0640/g, '')
                .replace(/[\u064B-\u0652\u0670]/g, '')
                .replace(/[\u0622\u0623\u0625]/g, '\u0627')
                .replace(/\u0649/g, '\u064A')
                .replace(/\u0629/g, '\u0647')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        // Compact "3d ago" style relative time. Falls back to absolute
        // date when the gap is large or unparseable. Full timestamp is
        // always available via the cell's title attribute.
        function _relTime(ts) {
            if (!ts) return { short: '-', full: '' };
            const d = new Date(ts);
            if (isNaN(d.getTime())) return { short: '-', full: String(ts) };
            const full = _fd(d, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            const diffMs = Date.now() - d.getTime();
            const sec = Math.round(diffMs / 1000);
            if (sec < 60) return { short: 'just now', full };
            const min = Math.round(sec / 60);
            if (min < 60) return { short: min + 'm ago', full };
            const hr = Math.round(min / 60);
            if (hr < 24) return { short: hr + 'h ago', full };
            const day = Math.round(hr / 24);
            if (day < 30) return { short: day + 'd ago', full };
            const mo = Math.round(day / 30);
            if (mo < 12) return { short: mo + 'mo ago', full };
            const yr = Math.round(mo / 12);
            return { short: yr + 'y ago', full };
        }

        // Toggle the expanded/collapsed state of one duplicate group on
        // the Leads tab. Wired through SafeActions via data-on-click.
        // Generic group-toggle handler. data-dup-group ids are prefixed by
        // module ("leads-0", "deals-3", ...) so the four tabs don't collide.
        function toggleDupGroup(gid) {
            const children = document.querySelectorAll('tr[data-dup-group="' + gid + '"]');
            const chevron = document.getElementById('dup-chev-' + gid);
            let nowOpen = false;
            children.forEach(tr => {
                tr.classList.toggle('hidden');
                if (!tr.classList.contains('hidden')) nowOpen = true;
            });
            if (chevron) chevron.textContent = nowOpen ? '▼' : '▶';
        }

        // Normalize a URL/website value to a bare lowercase hostname so two
        // accounts on "https://acme.com/path" and "www.acme.com" group together.
        function _normWebsite(w) {
            if (!w) return '';
            try {
                let s = String(w).trim().toLowerCase();
                if (!s) return '';
                if (!/^https?:\/\//.test(s)) s = 'http://' + s;
                const u = new URL(s);
                return u.hostname.replace(/^www\./, '');
            } catch { return String(w).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
        }

        // Build per-key collision counts {key:{value:count}} for the page.
        function _dupCounts(items, extractors) {
            const counts = {};
            for (const k of Object.keys(extractors)) {
                counts[k] = {};
                items.forEach(r => { const v = extractors[k](r); if (v) counts[k][v] = (counts[k][v] || 0) + 1; });
            }
            return counts;
        }

        // Union-find groups: any two items sharing ANY one extractor value
        // collapse into the same bucket. Returns groups of size >= 2,
        // sorted by size desc.
        function _dupBuckets(items, extractors) {
            const parent = items.map((_, i) => i);
            const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
            const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
            for (const k of Object.keys(extractors)) {
                const seen = {};
                items.forEach((r, i) => {
                    const v = extractors[k](r);
                    if (!v) return;
                    if (seen[v] === undefined) seen[v] = i;
                    else union(seen[v], i);
                });
            }
            const groups = {};
            items.forEach((_, i) => { const r = find(i); (groups[r] = groups[r] || []).push(i); });
            return Object.values(groups).filter(idxs => idxs.length >= 2).sort((a, b) => b.length - a.length);
        }

        // Group header summary: which key values are *uniformly* shared
        // across the whole group (badge color/emoji from keyDefs).
        function _dupGroupSummary(items, idxs, extractors, keyDefs) {
            const recs = idxs.map(i => items[i]);
            const sharedKeys = [];
            for (const k of Object.keys(extractors)) {
                const vals = new Set(recs.map(r => extractors[k](r)).filter(Boolean));
                if (vals.size === 1 && (k !== 'id' || recs.length > 1)) {
                    const def = keyDefs[k] || {};
                    sharedKeys.push({ k: def.emoji || '•', label: def.label || k, color: def.color || 'bg-gray-100 text-gray-700', value: [...vals][0] });
                }
            }
            const primary = recs.find(r => r.is_primary) || recs[0];
            // The exact Zoho ids of THIS sub-group's members — passed to the AI
            // plan so it scopes to what the tab shows, not the whole cluster
            // (fixes "tab shows 2 contacts, plan opens the 21-record cluster").
            const zohoIds = recs.map(r => String((r && (r.zoho_record_id || r.zohoId)) || '')).filter(Boolean);
            return { sharedKeys, primary, count: recs.length, zohoIds };
        }

        // Yellow collapsible group-header row.
        function _dupGroupHeaderRow(gid, summary, colspan, moduleLabel, clusterMeta) {
            const chips = summary.sharedKeys.length
                ? summary.sharedKeys.map(s => `<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${s.color}" title="All ${summary.count} ${moduleLabel} in this group share this ${s.label}: ${escapeHtml(String(s.value))}">${s.k} ${escapeHtml(s.label)}</span>`).join(' ')
                : `<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700" title="Members of this group are linked through chained matches (e.g. A shares email with B, B shares phone with C)">🔗 chained match</span>`;
            const _aiMod = moduleLabel.charAt(0).toUpperCase() + moduleLabel.slice(1);
            const _aiCid = summary.primary && summary.primary.cluster_id;
            // AI-state badge — visible at-a-glance so the operator can tell
            // which clusters were already AI-applied (and are just waiting
            // for the Zoho admin to physically delete the tagged records)
            // vs. truly untouched. Comes from the new merge_action sidecar
            // on the list endpoint.
            const aiState = clusterMeta && clusterMeta.ai_state;
            const tagged = (clusterMeta && Number(clusterMeta.tagged_records || 0)) || 0;
            const lastAt = clusterMeta && clusterMeta.last_merge_at
                ? new Date(clusterMeta.last_merge_at).toLocaleDateString()
                : '';
            let aiStateBadge = '';
            if (aiState === 'tagged_pending_delete') {
                aiStateBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="Apply was already run on this cluster${lastAt ? ' (' + lastAt + ')' : ''}. ${tagged} duplicate(s) carry the Duplicate-Delete tag in Zoho — the cluster keeps re-appearing here on every scan until the Zoho admin physically deletes those tagged records.">🤖 AI-Applied · ${tagged} pending Zoho delete</span>`;
            } else if (aiState === 'resolved') {
                aiStateBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300" title="Cluster status='resolved' — confirmed via agentic apply / CRM verification.">✅ Resolved</span>`;
            }
            // Button label clarified: "🔍 Open AI Plan" instead of
            // "🔍 Resolve with AI" — the original wording made operators
            // believe one click would auto-apply, when it actually only
            // opens the merge plan preview.
            const aiBtnLabel = aiState === 'tagged_pending_delete'
                ? '🔁 Re-open AI Plan'
                : '🔍 Open AI Plan';
            // Pass the exact ids of THIS sub-group so the plan scopes to what the
            // operator sees here, not every record in a (possibly synthetic /
            // multi-company) cluster. JSON of numeric ids — safe inside the
            // single-quoted data-args attribute.
            const _aiIds = JSON.stringify((summary.zohoIds || []).map(String));
            const aiBtn = _aiCid
                ? `<button data-on-click="resolveGroupWithAI" data-args='["${_aiMod}",${_aiCid},${_aiIds}]' data-testid="btn-resolve-ai-${gid}" class="px-2 py-1 rounded text-[11px] font-semibold bg-purple-600 text-white hover:bg-purple-700" title="Open the AI merge-plan modal scoped to these records. You still need to click Apply in Zoho inside the modal to actually tag duplicates.">${aiBtnLabel}</button>`
                : '';
            // Dismiss — mark as a false positive (e.g. intentionally separate
            // accounts: a Corporate-Accounts account vs a Marketplace account).
            const dismissBtn = _aiCid
                ? `<button data-on-click="dismissCluster" data-args='["${_aiMod}",${_aiCid}]' data-testid="btn-dismiss-${gid}" class="px-2 py-1 rounded text-[11px] font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300" title="Dismiss as a false positive — use when these are intentionally separate accounts (e.g. Corporate-Accounts vs Marketplace: Sales B2B/B2C account vs Merchants account). Moves it to the Dismissed filter; it stops appearing as a duplicate to action.">🚫 Dismiss</button>`
                : '';
            // Verify in CRM — the trustworthy "resolve": re-query Zoho for every
            // record this cluster tagged Duplicate-Delete and, ONLY if the admin
            // has actually deleted them all, mark the cluster Resolved. Shown on
            // AI-Applied (pending Zoho delete) clusters across every module tab —
            // this replaces the old "assert it's done" Mark Resolved.
            const verifyBtn = (_aiCid && aiState === 'tagged_pending_delete')
                ? `<button data-on-click="verifyAndResolveCluster" data-args='["${_aiMod}",${_aiCid}]' data-testid="btn-verify-crm-${gid}" class="px-2 py-1 rounded text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700" title="Check Zoho: has the admin actually deleted the Duplicate-Delete records? If every tagged duplicate is gone, this marks the cluster Resolved. If any are still in Zoho, it tells you which — and does NOT resolve.">✅ Verify in CRM</button>`
                : '';
            // Re-open — set a resolved/dismissed cluster back to active so it can
            // be merged. Shown on resolved clusters and in the Resolved/Dismissed
            // filter views (for clusters marked done but not actually merged).
            const _viewFilter = (window._aiStatusByTab && window._currentTab && window._aiStatusByTab[window._currentTab]) || 'active';
            const reopenBtn = (_aiCid && (aiState === 'resolved' || _viewFilter === 'resolved' || _viewFilter === 'dismissed'))
                ? `<button data-on-click="reopenCluster" data-args='["${_aiMod}",${_aiCid}]' data-testid="btn-reopen-${gid}" class="px-2 py-1 rounded text-[11px] font-semibold bg-blue-100 text-blue-800 hover:bg-blue-200" title="Re-open this cluster (set it back to active) so you can merge it — for clusters marked Resolved/Dismissed but not actually merged in Zoho.">🔓 Re-open</button>`
                : '';
            return `<tr class="bg-yellow-50 hover:bg-yellow-100 cursor-pointer border-t-2 border-yellow-300" data-on-click="toggleDupGroup" data-args='["${gid}"]' data-testid="row-dup-group-${gid}">
                <td class="px-4 py-3 text-sm" colspan="${colspan}">
                    <div class="flex items-center gap-2 flex-wrap">
                        ${_aiCid ? `<input type="checkbox" data-on-click="toggleDupBulk" data-args='["${_aiMod}",${_aiCid}]' data-cid="${_aiCid}" class="dup-bulk-cb w-4 h-4 cursor-pointer" title="Select this cluster for bulk dismiss / re-open" ${(window._dupBulkSel && window._dupBulkSel.has(String(_aiCid))) ? 'checked' : ''}>` : ''}
                        <span id="dup-chev-${gid}" class="text-gray-600 font-mono" aria-hidden="true">▶</span>
                        <span class="font-semibold text-gray-900">${escapeHtml(summary.primary.record_name || '(no name)')}</span>
                        <span class="text-xs text-gray-500">${summary.count} duplicate ${moduleLabel}</span>
                        <span class="flex flex-wrap gap-1">${chips}</span>
                        ${aiStateBadge}
                        <span class="ms-auto flex items-center gap-2">${reopenBtn}${verifyBtn}${aiBtn}${dismissBtn}<span class="text-xs text-gray-500">Click to expand</span></span>
                    </div>
                </td>
            </tr>`;
        }

        // Identity column: ★ primary, bold name, secondary line, tiny ↗ Zoho link.
        function _dupIdentityCell(r, moduleZoho, secondaryText, nameIsDup) {
            const star = r.is_primary
                ? `<span class="text-yellow-500 me-1" title="${escapeHtml(WalaPlusI18n.t('dyn.duplicates.primary'))} — system-chosen master record for this cluster">★</span>`
                : '';
            const idStr = String(r.zoho_record_id || '');
            const isSynthetic = !idStr || idStr.startsWith('test_') || idStr.startsWith('LEAD_') || idStr.startsWith('DEAL_') || idStr.startsWith('CONTACT_') || idStr.startsWith('ACCOUNT_');
            const zohoIconLink = isSynthetic ? ''
                : `<a href="https://crm.zoho.com/crm/org766568398/tab/${moduleZoho}/${idStr}" target="_blank" class="text-blue-500 hover:text-blue-700 ms-1 text-xs" title="Open in Zoho CRM (id ${escapeHtml(idStr)})" data-testid="link-zoho-${idStr}">↗</a>`;
            const nameColorCls = nameIsDup ? 'text-purple-700' : 'text-gray-900';
            return `<td class="px-4 py-3 text-sm">
                <div class="flex items-center font-medium ${nameColorCls}">${star}<span>${escapeHtml(r.record_name || '-')}</span>${zohoIconLink}</div>
                ${secondaryText ? `<div class="text-xs text-gray-500">${escapeHtml(secondaryText)}</div>` : ''}
            </td>`;
        }

        function _dupLayoutCell(r) {
            const raw = r && r.raw_data ? r.raw_data : {};
            const layoutName = (raw.Layout && (raw.Layout.name || raw.Layout.display_label)) || r.layout || '-';
            return `<td class="px-4 py-3 text-sm text-gray-600" title="Zoho layout">${escapeHtml(layoutName || '-')}</td>`;
        }

        // 2026-06-09 — Contact-only variant of _dupLayoutCell. Reads the
        // Zoho Contacts module's "Contact_Type" field instead of Layout
        // because operators triaging contact dupes care about WHICH KIND
        // of contact (Customer / Prospect / Vendor / Partner / etc.) far
        // more than which UI layout was used. The Layout column on this
        // tab was almost always "Standard" so it provided ~no signal
        // during merge decisions. Per operator request: only the Contact
        // Duplicates tab swaps this; Leads/Deals/Accounts still use the
        // generic _dupLayoutCell above.
        function _dupContactTypeCell(r) {
            const raw = r && r.raw_data ? r.raw_data : {};
            const ctRaw =
                raw.Contact_Type ??
                raw.contact_type ??
                r.contact_type ??
                null;
            // Zoho returns the field as either a plain string or a
            // {id, name, display_label} object depending on the field
            // type + tenant config. Handle both shapes defensively.
            let val = '';
            if (typeof ctRaw === 'string') {
                val = ctRaw;
            } else if (ctRaw && typeof ctRaw === 'object') {
                val = String(ctRaw.name || ctRaw.display_label || '');
            }
            val = (val || '').trim();
            return `<td class="px-4 py-3 text-sm text-gray-600" title="Zoho Contacts → Contact Type field">${escapeHtml(val || '-')}</td>`;
        }

        function _dupCreatedCell(r) {
            const raw = r && r.raw_data ? r.raw_data : {};
            const creator = (raw.Created_By && raw.Created_By.name) || r.created_by_name || '';
            const ts = raw.Created_Time || r.created_date || r.created_at || null;
            const rel = _relTime(ts);
            // Show the absolute date & time for auditing/comparison; relative
            // time ("3d ago") stays available on hover via the title.
            const disp = rel.full || rel.short;
            return `<td class="px-4 py-3 text-sm">
                <div class="text-gray-700 whitespace-nowrap" title="${escapeHtml(rel.short)}">${escapeHtml(disp)}</div>
                ${creator ? `<div class="text-xs text-gray-400">${escapeHtml(creator)}</div>` : ''}
            </td>`;
        }

        function renderLeadRows(groups) {
            const tbody = document.getElementById('leadsTable');
            // Flatten the page so we can count duplicate names/emails/phones/IDs
            // across every lead currently shown.
            const allLeads = [];
            const clusterMetaById = {};
            for (const g of groups) {
                if (g.cluster && g.cluster.id != null) clusterMetaById[g.cluster.id] = g.cluster;
                for (const r of (g.leads || [])) allLeads.push(r);
            }

            // Counts per match-key so each row can show 👤/📧/📞/🆔 badges.
            // OR rule: a row is a duplicate if ANY of name, email, phone, or
            // Zoho CRM ID matches another lead on this page. A repeated Zoho
            // ID is normally an indexer/sync bug (the same record stored
            // twice in our DB) — worth surfacing explicitly.
            const nameCounts = {};
            const emailCounts = {};
            const phoneCounts = {};
            const idCounts = {};
            for (const r of allLeads) {
                const n = _normName(r.record_name);
                const e = _normEmail(r.email);
                const p = _normPhone(leadPhone(r));
                const id = String(r.zoho_record_id || '').trim();
                if (n) nameCounts[n] = (nameCounts[n] || 0) + 1;
                if (e) emailCounts[e] = (emailCounts[e] || 0) + 1;
                if (p) phoneCounts[p] = (phoneCounts[p] || 0) + 1;
                if (id) idCounts[id] = (idCounts[id] || 0) + 1;
            }

            // Union-find: merge any two leads that share at least one of
            // name / email / phone / Zoho ID. This way a lead matching
            // another by phone AND a third by email all end up in the same
            // group. Index-into-allLeads is the node identifier.
            const parent = allLeads.map((_, i) => i);
            const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
            const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
            const byKey = (keyName) => {
                const map = {};
                allLeads.forEach((r, i) => {
                    let k = '';
                    if (keyName === 'name') k = _normName(r.record_name);
                    else if (keyName === 'email') k = _normEmail(r.email);
                    else if (keyName === 'phone') k = _normPhone(leadPhone(r));
                    else if (keyName === 'id') k = String(r.zoho_record_id || '').trim();
                    if (!k) return;
                    if (map[k] === undefined) map[k] = i;
                    else union(map[k], i);
                });
            };
            byKey('name'); byKey('email'); byKey('phone'); byKey('id');

            // Bucket indices by their union-find root.
            const buckets = {};
            allLeads.forEach((_, i) => {
                const r = find(i);
                (buckets[r] = buckets[r] || []).push(i);
            });

            // Build the render list: only groups with 2+ leads (singletons
            // are not duplicates by any signal). Order by group size desc
            // so the messiest clusters are at the top.
            const groupList = Object.values(buckets)
                .filter(idxs => idxs.length >= 2)
                .sort((a, b) => b.length - a.length);

            // Friendly summary for the group header: shared key + N members
            // + the "primary" lead's name as the human label.
            function _groupSummary(idxs) {
                const recs = idxs.map(i => allLeads[i]);
                const sharedKeys = [];
                const nameVals = new Set(recs.map(r => _normName(r.record_name)).filter(Boolean));
                const emailVals = new Set(recs.map(r => _normEmail(r.email)).filter(Boolean));
                const phoneVals = new Set(recs.map(r => _normPhone(leadPhone(r))).filter(Boolean));
                const idVals = new Set(recs.map(r => String(r.zoho_record_id || '').trim()).filter(Boolean));
                if (nameVals.size === 1) sharedKeys.push({ k: '👤', label: 'name', color: 'bg-purple-100 text-purple-800', value: [...nameVals][0] });
                if (emailVals.size === 1) sharedKeys.push({ k: '📧', label: 'email', color: 'bg-red-100 text-red-800', value: [...emailVals][0] });
                if (phoneVals.size === 1) sharedKeys.push({ k: '📞', label: 'phone', color: 'bg-orange-100 text-orange-800', value: [...phoneVals][0] });
                if (idVals.size === 1 && recs.length > 1) sharedKeys.push({ k: '🆔', label: 'CRM ID', color: 'bg-rose-200 text-rose-900', value: [...idVals][0] });
                const primary = recs.find(r => r.is_primary) || recs[0];
                const zohoIds = recs.map(r => String((r && (r.zoho_record_id || r.zohoId)) || '')).filter(Boolean);
                return { sharedKeys, primary, count: recs.length, zohoIds };
            }

            let rows = '';
            groupList.forEach((idxs, gIdx) => {
                const summary = _groupSummary(idxs);
                // Use the shared _dupGroupHeaderRow helper (same one the
                // Deals/Contacts/Accounts tabs use) so Leads gets parity:
                //   - "🤖 AI-Applied · N pending Zoho delete" badge when
                //     the cluster already has a merge_action against it
                //   - "🔍 Open AI Plan" / "🔁 Re-open AI Plan" button
                //     label (NOT the misleading old "Resolve with AI")
                //   - "✅ Verify in CRM" button on AI-applied clusters
                //   - "🔓 Re-open" button on resolved/dismissed clusters
                //   - "🚫 Dismiss" button on active clusters
                //   - "✓" bulk-select checkbox
                // Previously the Leads tab rendered an asymmetric inline
                // header that was missing every one of these states.
                const _gid = 'leads-' + gIdx;
                const _leadCid = summary.primary && summary.primary.cluster_id;
                const cmeta = (_leadCid && clusterMetaById[_leadCid]) || null;
                rows += _dupGroupHeaderRow(_gid, summary, 8, 'leads', cmeta);

                idxs.forEach(i => {
                    const r = allLeads[i];
                const phone = leadPhone(r);
                const n = _normName(r.record_name);
                const e = _normEmail(r.email);
                const p = _normPhone(phone);
                const idKey = String(r.zoho_record_id || '').trim();
                const nDup = n && nameCounts[n] > 1 ? nameCounts[n] : 0;
                const eDup = e && emailCounts[e] > 1 ? emailCounts[e] : 0;
                const pDup = p && phoneCounts[p] > 1 ? phoneCounts[p] : 0;
                const idDup = idKey && idCounts[idKey] > 1 ? idCounts[idKey] : 0;

                // Lead cell — name (bold) + company (small grey) + primary
                // star + tiny Zoho-link icon. Single identity column instead
                // of four separate ones (Zoho ID / Domain / Name / Company).
                const star = r.is_primary
                    ? `<span class="text-yellow-500 me-1" title="${escapeHtml(WalaPlusI18n.t('dyn.duplicates.primary'))} — system-chosen master record for this cluster">★</span>`
                    : '';
                const zohoIconLink = r.zoho_record_id && !String(r.zoho_record_id).startsWith('test_') && !String(r.zoho_record_id).startsWith('LEAD_')
                    ? `<a href="https://crm.zoho.com/crm/org766568398/tab/Leads/${r.zoho_record_id}" target="_blank" class="text-blue-500 hover:text-blue-700 ms-1 text-xs" title="Open in Zoho CRM (id ${escapeHtml(String(r.zoho_record_id))})" data-testid="link-zoho-${r.zoho_record_id}">↗</a>`
                    : '';
                const nameColorCls = nDup ? 'text-purple-700' : 'text-gray-900';
                const leadCell = `<td class="px-4 py-3 text-sm">
                    <div class="flex items-center font-medium ${nameColorCls}">${star}<span title="${nDup ? nDup + ' leads on this page share this exact name' : ''}">${escapeHtml(r.record_name || '-')}</span>${zohoIconLink}</div>
                    <div class="text-xs text-gray-500">${escapeHtml(r.company_name || '-')}</div>
                </td>`;

                // Dup signal — single source of truth, no more inline × N chips.
                const signals = [];
                if (nDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800" title="${nDup} leads on this page share this exact name">👤 name ×${nDup}</span>`);
                if (eDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800" title="${eDup} leads on this page share this exact email">📧 email ×${eDup}</span>`);
                if (pDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800" title="${pDup} leads on this page share this exact phone">📞 phone ×${pDup}</span>`);
                if (idDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-200 text-rose-900 border border-rose-400" title="${idDup} rows reference the same Zoho CRM ID — usually an indexer/sync bug, not a true CRM duplicate. Investigate before merging.">🆔 dup CRM ID ×${idDup}</span>`);
                if (!signals.length) signals.push('<span class="text-gray-400 text-xs" title="No name/email/phone/ID collisions with other leads on this page">-</span>');
                const signalCell = `<td class="px-4 py-3 text-sm"><div class="flex flex-wrap gap-1">${signals.join('')}</div></td>`;

                const emailCell = r.email
                    ? `<td class="px-4 py-3 text-sm ${eDup ? 'text-red-700 font-medium' : 'text-gray-600'}">${escapeHtml(r.email)}</td>`
                    : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                const phoneCell = phone
                    ? `<td class="px-4 py-3 text-sm font-mono text-xs ${pDup ? 'text-orange-700 font-medium' : 'text-gray-600'}">${escapeHtml(phone)}</td>`
                    : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';

                // Created — absolute date & time on top (relative on hover),
                // creator name below in grey.
                const raw = r && r.raw_data ? r.raw_data : {};
                const creator = (raw.Created_By && raw.Created_By.name) || r.created_by_name || '';
                const ts = raw.Created_Time || r.created_date || r.created_at || null;
                const rel = _relTime(ts);
                const createdDisp = rel.full || rel.short;
                const createdCell = `<td class="px-4 py-3 text-sm">
                    <div class="text-gray-700 whitespace-nowrap" title="${escapeHtml(rel.short)}">${escapeHtml(createdDisp)}</div>
                    ${creator ? `<div class="text-xs text-gray-400">${escapeHtml(creator)}</div>` : ''}
                </td>`;

                    const layoutName = (raw.Layout && (raw.Layout.name || raw.Layout.display_label)) || r.layout || '-';
                    const layoutCell = `<td class="px-4 py-3 text-sm text-gray-600" title="Zoho layout">${escapeHtml(layoutName || '-')}</td>`;
                    rows += `<tr data-dup-group="${_gid}" class="hidden bg-white">${leadCell}${signalCell}${emailCell}${phoneCell}${layoutCell}<td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(r.owner_name||'-')}</td><td class="px-4 py-3 text-sm"><span class="px-2 py-1 rounded text-xs bg-gray-100">${escapeHtml(r.status||'-')}</span></td>${createdCell}</tr>`;
                });
            });
            tbody.innerHTML = rows || `<tr><td colspan="8" class="px-4 py-8 text-center text-gray-500">No duplicate leads detected on this page — every lead has a unique name, email, phone, and CRM ID.</td></tr>`;
        }

        // ─── DEALS ───
        // Match keys: name+account (combined — same deal name on the same
        // account is a strong duplicate signal) and Zoho CRM ID. We do NOT
        // group by bare deal name alone, because "Renewal 2025" naturally
        // recurs across many accounts and would balloon the groups.
        function renderDealRows(groups) {
            const tbody = document.getElementById('dealsTable');
            const items = [];
            const clusterMetaById = {};
            for (const g of groups) {
                if (g.cluster && g.cluster.id != null) clusterMetaById[g.cluster.id] = g.cluster;
                for (const r of (g.deals || [])) items.push(r);
            }

            const accountIdOf = r => {
                const raw = r && r.raw_data ? r.raw_data : {};
                return (raw.Account_Name && raw.Account_Name.id) || r.account_id || raw.account_id || '';
            };
            const extractors = {
                nameAccount: r => {
                    const n = _normName(r.record_name);
                    const a = accountIdOf(r);
                    return n && a ? (n + '|' + a) : '';
                },
                id: r => String(r.zoho_record_id || '').trim(),
            };
            const keyDefs = {
                nameAccount: { emoji: '👤', label: 'name + account', color: 'bg-purple-100 text-purple-800' },
                id: { emoji: '🆔', label: 'CRM ID', color: 'bg-rose-200 text-rose-900 border border-rose-400' },
            };
            const counts = _dupCounts(items, extractors);
            const groupList = _dupBuckets(items, extractors);

            let rows = '';
            groupList.forEach((idxs, gIdx) => {
                const gid = 'deals-' + gIdx;
                const summary = _dupGroupSummary(items, idxs, extractors, keyDefs);
                const cmeta = (summary.primary && clusterMetaById[summary.primary.cluster_id]) || null;
                rows += _dupGroupHeaderRow(gid, summary, 7, 'deals', cmeta);

                idxs.forEach(i => {
                    const r = items[i];
                    const naKey = extractors.nameAccount(r);
                    const idKey = extractors.id(r);
                    const naDup = naKey && counts.nameAccount[naKey] > 1 ? counts.nameAccount[naKey] : 0;
                    const idDup = idKey && counts.id[idKey] > 1 ? counts.id[idKey] : 0;

                    const identity = _dupIdentityCell(r, 'Deals', r.company_name || '-', !!naDup);
                    const signals = [];
                    if (naDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800" title="${naDup} deals on this page share the same name on the same account">👤 name+account ×${naDup}</span>`);
                    if (idDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-200 text-rose-900 border border-rose-400" title="${idDup} rows reference the same Zoho CRM ID — usually an indexer/sync bug, not a true CRM duplicate. Investigate before merging.">🆔 dup CRM ID ×${idDup}</span>`);
                    if (!signals.length) signals.push('<span class="text-gray-400 text-xs">-</span>');
                    const signalCell = `<td class="px-4 py-3 text-sm"><div class="flex flex-wrap gap-1">${signals.join('')}</div></td>`;

                    const stageCell = `<td class="px-4 py-3 text-sm"><span class="px-2 py-1 rounded text-xs bg-blue-100 text-blue-800">${escapeHtml(r.stage || '-')}</span></td>`;
                    const valueCell = `<td class="px-4 py-3 text-sm font-medium">${formatCurrency(r.deal_value || 0)}</td>`;
                    const ownerCell = `<td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(r.owner_name || '-')}</td>`;

                    rows += `<tr data-dup-group="${gid}" class="hidden bg-white">${identity}${signalCell}${stageCell}${valueCell}${_dupLayoutCell(r)}${ownerCell}${_dupCreatedCell(r)}</tr>`;
                });
            });
            tbody.innerHTML = rows || `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">No duplicate deals detected on this page — every deal has a unique name-on-account and CRM ID.</td></tr>`;
        }

        // ─── CONTACTS ───
        // Match keys: name, email, phone, Zoho CRM ID (same OR rule as leads).
        function renderContactRows(groups) {
            const tbody = document.getElementById('contactsTable');
            const items = [];
            const clusterMetaById = {};
            for (const g of groups) {
                if (g.cluster && g.cluster.id != null) clusterMetaById[g.cluster.id] = g.cluster;
                for (const r of (g.contacts || [])) items.push(r);
            }

            const contactPhone = r => r.phone || (r.raw_data && (r.raw_data.Phone || r.raw_data.Mobile || r.raw_data.Home_Phone)) || '';
            const extractors = {
                name:  r => _normName(r.record_name),
                email: r => _normEmail(r.email),
                phone: r => _normPhone(contactPhone(r)),
                id:    r => String(r.zoho_record_id || '').trim(),
            };
            const keyDefs = {
                name:  { emoji: '👤', label: 'name',  color: 'bg-purple-100 text-purple-800' },
                email: { emoji: '📧', label: 'email', color: 'bg-red-100 text-red-800' },
                phone: { emoji: '📞', label: 'phone', color: 'bg-orange-100 text-orange-800' },
                id:    { emoji: '🆔', label: 'CRM ID', color: 'bg-rose-200 text-rose-900 border border-rose-400' },
            };
            const counts = _dupCounts(items, extractors);
            // Group ONLY by a DIRECT identity signal — name / email / phone / id
            // (Ahmad 2026-06-22). No cluster-id fallback: two contacts that share
            // nothing but their company's domain (colleagues in a "chained match"
            // cluster) must NOT group as duplicates — they're a link-to-account
            // job. The server already filters the tab to clusters that hold a
            // real same-signal pair, and _normName is Arabic-aware, so genuine
            // duplicates (incl. Arabic names that differ by an invisible mark or
            // ة-vs-ه) still group reliably and no real duplicate is dropped.
            const groupList = _dupBuckets(items, extractors);

            let rows = '';
            groupList.forEach((idxs, gIdx) => {
                const gid = 'contacts-' + gIdx;
                const summary = _dupGroupSummary(items, idxs, extractors, keyDefs);
                const cmeta = (summary.primary && clusterMetaById[summary.primary.cluster_id]) || null;
                rows += _dupGroupHeaderRow(gid, summary, 7, 'contacts', cmeta);

                idxs.forEach(i => {
                    const r = items[i];
                    const phone = contactPhone(r);
                    const nKey = extractors.name(r), eKey = extractors.email(r), pKey = extractors.phone(r), idKey = extractors.id(r);
                    const nDup = nKey && counts.name[nKey] > 1 ? counts.name[nKey] : 0;
                    const eDup = eKey && counts.email[eKey] > 1 ? counts.email[eKey] : 0;
                    const pDup = pKey && counts.phone[pKey] > 1 ? counts.phone[pKey] : 0;
                    const idDup = idKey && counts.id[idKey] > 1 ? counts.id[idKey] : 0;

                    const identity = _dupIdentityCell(r, 'Contacts', r.company_name || '-', !!nDup);
                    const signals = [];
                    if (nDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800" title="${nDup} contacts on this page share this exact name">👤 name ×${nDup}</span>`);
                    if (eDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800" title="${eDup} contacts on this page share this exact email">📧 email ×${eDup}</span>`);
                    if (pDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800" title="${pDup} contacts on this page share this exact phone">📞 phone ×${pDup}</span>`);
                    if (idDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-200 text-rose-900 border border-rose-400" title="${idDup} rows reference the same Zoho CRM ID — usually an indexer/sync bug, not a true CRM duplicate.">🆔 dup CRM ID ×${idDup}</span>`);
                    if (!signals.length) signals.push('<span class="text-gray-400 text-xs">-</span>');
                    const signalCell = `<td class="px-4 py-3 text-sm"><div class="flex flex-wrap gap-1">${signals.join('')}</div></td>`;

                    const emailCell = r.email
                        ? `<td class="px-4 py-3 text-sm ${eDup ? 'text-red-700 font-medium' : 'text-gray-600'}">${escapeHtml(r.email)}</td>`
                        : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                    const phoneCell = phone
                        ? `<td class="px-4 py-3 text-sm font-mono text-xs ${pDup ? 'text-orange-700 font-medium' : 'text-gray-600'}">${escapeHtml(phone)}</td>`
                        : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                    const ownerCell = `<td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(r.owner_name || '-')}</td>`;

                    // Contact-only swap: use _dupContactTypeCell instead
                    // of _dupLayoutCell so the column reads the Contacts
                    // module's "Contact Type" field (Customer / Prospect /
                    // …) rather than the near-always-"Standard" Layout.
                    rows += `<tr data-dup-group="${gid}" class="hidden bg-white">${identity}${signalCell}${emailCell}${phoneCell}${_dupContactTypeCell(r)}${ownerCell}${_dupCreatedCell(r)}</tr>`;
                });
            });
            tbody.innerHTML = rows || `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">No duplicate contacts detected on this page — every contact has a unique name, email, phone, and CRM ID.</td></tr>`;
            // How many groups actually rendered (client re-groups by a DIRECT
            // name/email/phone signal and drops colleague/chained-match clusters).
            // The caller uses this so the footer count can't disagree with the
            // table (e.g. "5 duplicate groups" under "No duplicates detected").
            return groupList.length;
        }

        // ─── ACCOUNTS ───
        // Match keys: account name, email, phone, website hostname, Zoho CRM ID.
        function renderAccountRows(groups) {
            const tbody = document.getElementById('accountsTable');
            const items = [];
            // Build cluster-meta lookup so _dupGroupHeaderRow can render the
            // AI-state badge ("🤖 AI-Applied · N pending Zoho delete" vs
            // "✅ Resolved" vs default).
            const clusterMetaById = {};
            for (const g of groups) {
                if (g.cluster && g.cluster.id != null) clusterMetaById[g.cluster.id] = g.cluster;
                for (const r of (g.accounts || [])) items.push(r);
            }
            window._clusterMetaByIdForTab = clusterMetaById;

            const websiteOf = r => {
                const raw = r && r.raw_data ? r.raw_data : {};
                return r.website || raw.Website || raw.website || r.domain || '';
            };
            const extractors = {
                name:    r => _normName(r.record_name),
                email:   r => _normEmail(r.email),
                phone:   r => _normPhone(r.phone),
                website: r => _normWebsite(websiteOf(r)),
                id:      r => String(r.zoho_record_id || '').trim(),
            };
            const keyDefs = {
                name:    { emoji: '👤', label: 'name',    color: 'bg-purple-100 text-purple-800' },
                email:   { emoji: '📧', label: 'email',   color: 'bg-red-100 text-red-800' },
                phone:   { emoji: '📞', label: 'phone',   color: 'bg-orange-100 text-orange-800' },
                website: { emoji: '🌐', label: 'website', color: 'bg-cyan-100 text-cyan-800' },
                id:      { emoji: '🆔', label: 'CRM ID',  color: 'bg-rose-200 text-rose-900 border border-rose-400' },
            };
            const counts = _dupCounts(items, extractors);
            // Group by exact shared key OR by the server's own cluster id.
            // Account clusters are frequently FUZZY-name matches (e.g. "Saudi
            // Electricity Co" vs "Saudi Electricity Company") whose members
            // share no exactly-equal field. The server paginates and counts by
            // cluster, so without a cluster fallback those clusters are dropped
            // client-side and a page of purely-fuzzy clusters renders empty even
            // though the pager reports thousands of groups — which made the
            // Untouched view show 14+ blank pages. The cluster key only unions
            // records WITHIN the same server cluster; cross-cluster chaining via
            // name/email/phone/website/id is unchanged (it only ever adds
            // unions, never removes them), so the dense exact-match views are
            // unaffected.
            const bucketExtractors = {
                ...extractors,
                _cluster: r => (r.cluster_id != null ? 'cid:' + r.cluster_id : ''),
            };
            const groupList = _dupBuckets(items, bucketExtractors);

            let rows = '';
            groupList.forEach((idxs, gIdx) => {
                const gid = 'accounts-' + gIdx;
                const summary = _dupGroupSummary(items, idxs, extractors, keyDefs);
                const cmeta = (summary.primary && clusterMetaById[summary.primary.cluster_id]) || null;
                rows += _dupGroupHeaderRow(gid, summary, 8, 'accounts', cmeta);

                idxs.forEach(i => {
                    const r = items[i];
                    const site = websiteOf(r);
                    const nKey = extractors.name(r), eKey = extractors.email(r), pKey = extractors.phone(r), wKey = extractors.website(r), idKey = extractors.id(r);
                    const nDup  = nKey && counts.name[nKey] > 1 ? counts.name[nKey] : 0;
                    const eDup  = eKey && counts.email[eKey] > 1 ? counts.email[eKey] : 0;
                    const pDup  = pKey && counts.phone[pKey] > 1 ? counts.phone[pKey] : 0;
                    const wDup  = wKey && counts.website[wKey] > 1 ? counts.website[wKey] : 0;
                    const idDup = idKey && counts.id[idKey] > 1 ? counts.id[idKey] : 0;

                    const identity = _dupIdentityCell(r, 'Accounts', r.source ? ('Source: ' + r.source) : '', !!nDup);
                    const signals = [];
                    if (nDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-800" title="${nDup} accounts on this page share this exact name">👤 name ×${nDup}</span>`);
                    if (eDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800" title="${eDup} accounts on this page share this exact email">📧 email ×${eDup}</span>`);
                    if (pDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800" title="${pDup} accounts on this page share this exact phone">📞 phone ×${pDup}</span>`);
                    if (wDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-100 text-cyan-800" title="${wDup} accounts on this page share the same website hostname">🌐 website ×${wDup}</span>`);
                    if (idDup) signals.push(`<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-200 text-rose-900 border border-rose-400" title="${idDup} rows reference the same Zoho CRM ID — usually an indexer/sync bug, not a true CRM duplicate.">🆔 dup CRM ID ×${idDup}</span>`);
                    if (!signals.length) signals.push('<span class="text-gray-400 text-xs">-</span>');
                    const signalCell = `<td class="px-4 py-3 text-sm"><div class="flex flex-wrap gap-1">${signals.join('')}</div></td>`;

                    const emailCell = r.email
                        ? `<td class="px-4 py-3 text-sm ${eDup ? 'text-red-700 font-medium' : 'text-gray-600'}">${escapeHtml(r.email)}</td>`
                        : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                    const phoneCell = r.phone
                        ? `<td class="px-4 py-3 text-sm font-mono text-xs ${pDup ? 'text-orange-700 font-medium' : 'text-gray-600'}">${escapeHtml(r.phone)}</td>`
                        : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                    const websiteCell = site
                        ? `<td class="px-4 py-3 text-sm ${wDup ? 'text-cyan-700 font-medium' : 'text-gray-600'}">${escapeHtml(_normWebsite(site) || site)}</td>`
                        : '<td class="px-4 py-3 text-sm text-gray-400">-</td>';
                    const ownerCell = `<td class="px-4 py-3 text-sm text-gray-600">${escapeHtml(r.owner_name || '-')}</td>`;

                    rows += `<tr data-dup-group="${gid}" class="hidden bg-white">${identity}${signalCell}${emailCell}${phoneCell}${websiteCell}${_dupLayoutCell(r)}${ownerCell}${_dupCreatedCell(r)}</tr>`;
                });
            });
            tbody.innerHTML = rows || `<tr><td colspan="8" class="px-4 py-8 text-center text-gray-500">No duplicate accounts detected on this page — every account has a unique name, email, phone, website, and CRM ID.</td></tr>`;
        }

        // C3: Owner accountability with RAG status.
        // Owners are cached on window so the Export CSV button can build a
        // CSV from the currently selected rows without re-fetching.
        //
        // Sort state — applied client-side before each render. Default
        // is waste-value DESC so the worst exposure rises to the top
        // (previously the page was alphabetical; A Alsharif with 3 dups
        // / SAR 0 sat above Abdullah Mubarak with 411 dups / SAR 107K).
        // Sort key matches the property name on the owner row object,
        // EXCEPT 'owner_name' / 'team' / 'owner_email' which are sorted
        // case-insensitively as strings.
        let _ownersCache = [];
        let _ownersSortKey = 'estimated_waste_value';
        let _ownersSortDir = 'desc';

        // Reverse case of NAME_ALIASES (which handles "one person, multiple
        // name spellings on one email"). This handles "one person, multiple
        // emails": a rep tagged on several mailboxes across CRM (their own
        // address + a shared/import mailbox like pipedrive@ or info@) gets
        // split into 3 separate rows on Owner Accountability and looks like
        // three different people. Maps alias-email → canonical-email so
        // _mergeOwnersByEmail buckets them all under one owner.
        //
        // Maintenance: when adding an alias, double-check the source
        // mailbox is actually used by ONLY that one rep — a shared mailbox
        // legitimately tagged with multiple modifiers (e.g. an auto-mod
        // account everyone uses) should NOT be aliased here, because it
        // would erroneously fold every other rep's records into the
        // alias target. The current entries cover Rayan Saleh's three
        // tagged addresses; info@walaplus.com appears only with the
        // "Rayan Saleh" name in this tenant's data, so it's safe to alias.
        const EMAIL_ALIASES = {
            'pipedrive@walaplus.com': 'rayan@walaplus.com',
            'info@walaplus.com':      'rayan@walaplus.com',
        };

        function _canonicaliseOwnerEmail(rawEmail) {
            const key = String(rawEmail || '').trim().toLowerCase();
            if (!key) return '';
            return EMAIL_ALIASES[key] || key;
        }

        // Merge rows that share the same email address. The server side
        // builds the per-owner aggregates from the modified-by name on each
        // record, so a single rep with two name spellings in CRM
        // ("Naif Almutari" + "Naif Almutairi" on naif@walaplus.com,
        // "Mohammed Ghanem" × 2 on m.ghanem@walaplus.com, etc.) gets
        // double-counted. We re-aggregate client-side by lowercased email
        // and combine the names into one row so the scorecard reads as
        // intended ("this email = this person's debt"). Rows with no email
        // are passed through unchanged — without a shared key there's
        // nothing to merge them on.
        //
        // 2026-06-07 — also normalise through EMAIL_ALIASES first so the
        // reverse case (one person, multiple email addresses) collapses to
        // a single row too.
        function _mergeOwnersByEmail(owners) {
            const out = [];
            const byEmail = new Map();
            for (const o of owners || []) {
                const emailKey = _canonicaliseOwnerEmail(o.owner_email);
                if (!emailKey) { out.push({ ...o, merged_count: 1 }); continue; }
                const existing = byEmail.get(emailKey);
                if (!existing) {
                    byEmail.set(emailKey, {
                        ...o,
                        // Force the canonical email onto the merged row so the
                        // display + sort + export show the real owner address,
                        // not whichever alias arrived first (e.g. pipedrive@
                        // first → row would otherwise display pipedrive@
                        // instead of rayan@).
                        owner_email: emailKey,
                        _name_set: new Set([o.owner_name || '—']),
                        _team_set: new Set([o.team || 'Unassigned']),
                        _alias_email_set: new Set(
                            String(o.owner_email || '').trim().toLowerCase() !== emailKey
                                ? [String(o.owner_email || '').trim().toLowerCase()]
                                : []
                        ),
                        merged_count: 1,
                    });
                    continue;
                }
                existing.merged_count += 1;
                existing._name_set.add(o.owner_name || '—');
                existing._team_set.add(o.team || 'Unassigned');
                // Track non-canonical addresses we folded in so we can show
                // them in the row title attribute — useful when auditing
                // why Rayan's "535 dups" suddenly includes pipedrive@ rows.
                const lookedUp = String(o.owner_email || '').trim().toLowerCase();
                if (lookedUp && lookedUp !== emailKey) {
                    existing._alias_email_set.add(lookedUp);
                }
                existing.total_records             = Number(existing.total_records || 0)             + Number(o.total_records || 0);
                existing.duplicate_records         = Number(existing.duplicate_records || 0)         + Number(o.duplicate_records || 0);
                existing.high_confidence_duplicates = Number(existing.high_confidence_duplicates || 0) + Number(o.high_confidence_duplicates || 0);
                existing.estimated_waste_value     = Number(existing.estimated_waste_value || 0)     + Number(o.estimated_waste_value || 0);
            }
            for (const merged of byEmail.values()) {
                // Combine names + teams. Distinct values are joined with
                // " / "; if everything matches we keep the single value.
                merged.owner_name = Array.from(merged._name_set).filter(Boolean).join(' / ') || '—';
                merged.team       = Array.from(merged._team_set).filter(Boolean).join(' / ') || 'Unassigned';
                // Stash the folded alias addresses on the row so the
                // renderer can expose them in a tooltip without changing
                // the visible email column. Consumers that don't know
                // about merged_alias_emails just ignore the field.
                merged.merged_alias_emails = Array.from(merged._alias_email_set || []);
                delete merged._alias_email_set;
                // Recompute the dup-rate against the merged totals; round
                // to one decimal to match the server-side formatting.
                const tot = Number(merged.total_records || 0);
                const dup = Number(merged.duplicate_records || 0);
                merged.duplicate_rate = tot > 0 ? Math.round((dup / tot) * 1000) / 10 : 0;
                // Re-derive RAG using the SDR-KPI-09 bands the backend
                // applies after consolidation: ≤2% green · 2–5% amber · >5%
                // red. (Previous version used 25/50% bands — fixed
                // 2026-06-14 so a 49% rep no longer renders as amber.)
                merged.rag_status = merged.duplicate_rate > 5 ? 'red'
                                  : merged.duplicate_rate > 2 ? 'amber'
                                  : 'green';
                delete merged._name_set;
                delete merged._team_set;
                out.push(merged);
            }
            return out;
        }

        function renderOwners(owners) {
            // Re-aggregate same-email rows BEFORE caching so every consumer
            // (sort, filter, export, picker) sees the merged view.
            _ownersCache = _mergeOwnersByEmail(Array.isArray(owners) ? owners : []);
            applyOwnersSort();
            updateOwnersSortIndicators();
            // Advanced Filter — apply against owner_name (the typical
            // identifier in the Advanced Filters' Owner multi-select). The
            // owner-only filterbar above the table is the per-string search
            // input; both narrow the same rows.
            const tbody = document.getElementById('ownersTable');
            const filteredOwners = _ownersCache.filter(o => rowMatchesAdvancedFilter(o, {
                ownerField: 'owner_name',
            }));
            if (_ownersCache.length > 0 && filteredOwners.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">No owners match the active filters. Clear the Advanced Filters or pick a different owner.</td></tr>';
                renderPagination('ownersPagination', 0, 1, () => {}, 0, 'owners');
                return;
            }
            // Client-side pagination — 20 owners per page.
            window._ownersPage = Number.isFinite(window._ownersPage) ? window._ownersPage : 0;
            const ownersTotalPages = Math.max(1, Math.ceil(filteredOwners.length / RADAR_PAGE_SIZE));
            if (window._ownersPage >= ownersTotalPages) window._ownersPage = 0;
            const ownersPageStart = window._ownersPage * RADAR_PAGE_SIZE;
            const ownersSlice = filteredOwners.slice(ownersPageStart, ownersPageStart + RADAR_PAGE_SIZE);
            renderPagination('ownersPagination', window._ownersPage, ownersTotalPages,
                (p) => { window._ownersPage = p; renderOwners(_ownersCache); },
                filteredOwners.length, 'owners');
            tbody.innerHTML = ownersSlice.map((o, idx) => {
                const rowKey = encodeURIComponent(o.owner_name || `row-${idx}`);
                // RAG class lives on the Dup Rate cell now (was a redundant
                // separate KPI Status column showing the same threshold
                // label for every row). Default to 'red' for unknown
                // statuses since any row showing up here at all has
                // duplicate debt > 0.
                const ragClass = ['green','amber','red'].includes(o.rag_status) ? o.rag_status : 'red';
                // Merged-rows chip — shown when the email aggregator
                // combined ≥2 server rows. Hover-title spells out which
                // name spellings were folded together so the operator
                // knows what's behind the merged metric.
                const mergedBadge = (o.merged_count && o.merged_count > 1)
                    ? `<span class="ms-2 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800" title="Combined ${o.merged_count} CRM owner rows that share this email — names: ${escAttr(o.owner_name)}">merged ×${o.merged_count}</span>`
                    : '';
                return `
                <tr data-testid="row-owner-${escAttr(o.owner_name)}" data-owner-row data-owner-key="${rowKey}" data-owner-name="${escAttr(o.owner_name || '')}" data-owner-team="${escAttr(o.team || 'Unassigned')}" data-owner-email="${escAttr(o.owner_email || '')}">
                    <td class="px-4 py-3 text-sm"><input type="checkbox" class="owner-row-checkbox" data-on-change="syncOwnersSelectionState" data-testid="checkbox-owner-${escAttr(o.owner_name)}" aria-label="Select ${escAttr(o.owner_name || '')}" /></td>
                    <td class="px-6 py-3 text-sm font-medium">
                        <button data-on-click="openOwnerClusters"
                                data-args='${escAttr(JSON.stringify([o.owner_email || '', o.owner_name || '']))}'
                                title="View duplicate clusters owned by ${escAttr(o.owner_name)}"
                                class="text-indigo-700 hover:text-indigo-900 hover:underline text-start font-medium">${escapeHtml(o.owner_name)}</button>
                        ${mergedBadge}
                    </td>
                    <td class="px-6 py-3 text-sm"><span class="px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">${escapeHtml(o.team || 'Unassigned')}</span></td>
                    <td class="px-6 py-3 text-sm text-gray-500">${escapeHtml(o.owner_email || '-')}</td>
                    <td class="px-6 py-3 text-sm">${o.total_records}</td>
                    <td class="px-6 py-3 text-sm font-medium">${o.duplicate_records}</td>
                    <td class="px-6 py-3 text-sm"><span class="rag-${ragClass} px-2 py-1 rounded text-xs font-bold">${_fn(o.duplicate_rate)}%</span></td>
                    <td class="px-6 py-3 text-sm">${_fn(o.high_confidence_duplicates)}</td>
                    <td class="px-6 py-3 text-sm">${formatCurrency(o.estimated_waste_value)}</td>
                </tr>`;
            }).join('') || `<tr><td colspan="9" class="px-6 py-4 text-center text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_owner_data'))}</td></tr>`;
            // Re-apply any active filter and refresh select-all/count chrome.
            filterOwnersTable();
            syncOwnersSelectionState();
        }

        /**
         * Sort the cached owners by `_ownersSortKey` in `_ownersSortDir`.
         * String columns (owner_name / team / owner_email) get a
         * case-insensitive compare; numeric columns coerce to Number.
         * Stable: equal-key rows retain their pre-sort order, which is
         * the order the server returned them in.
         */
        function applyOwnersSort() {
            const key = _ownersSortKey;
            const dir = _ownersSortDir === 'asc' ? 1 : -1;
            const isStringColumn = ['owner_name', 'team', 'owner_email'].includes(key);
            _ownersCache.sort((a, b) => {
                const av = a[key];
                const bv = b[key];
                if (av == null && bv == null) return 0;
                if (av == null) return 1; // nulls always sink to the bottom
                if (bv == null) return -1;
                if (isStringColumn) {
                    return String(av).toLowerCase().localeCompare(String(bv).toLowerCase()) * dir;
                }
                const an = Number(av);
                const bn = Number(bv);
                if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
                if (Number.isNaN(an)) return 1;
                if (Number.isNaN(bn)) return -1;
                return (an - bn) * dir;
            });
        }

        /**
         * Click a column header → toggle direction if same key, otherwise
         * pick a sensible default direction for the new key (DESC for
         * numeric / impact columns, ASC for the text identity columns).
         * Then re-render so the table reflects the new ordering.
         */
        function sortOwnersBy(key) {
            if (!key) return;
            if (key === _ownersSortKey) {
                _ownersSortDir = _ownersSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _ownersSortKey = key;
                _ownersSortDir = ['owner_name', 'team', 'owner_email'].includes(key) ? 'asc' : 'desc';
            }
            // Re-render from the existing cache — no server round-trip.
            renderOwners(_ownersCache);
        }

        /**
         * Paint the ▲ / ▼ arrow on the active sort column's header span
         * and blank out the others. Called by renderOwners so the header
         * stays in sync after every sort/filter/data refresh.
         */
        function updateOwnersSortIndicators() {
            const keys = [
                'owner_name', 'team', 'owner_email', 'total_records',
                'duplicate_records', 'duplicate_rate',
                'high_confidence_duplicates', 'estimated_waste_value',
            ];
            keys.forEach(k => {
                const el = document.getElementById('owners-sort-' + k);
                if (!el) return;
                if (k === _ownersSortKey) {
                    el.textContent = _ownersSortDir === 'asc' ? '▲' : '▼';
                    el.classList.remove('text-gray-400');
                    el.classList.add('text-gray-700');
                } else {
                    el.textContent = '';
                    el.classList.add('text-gray-400');
                    el.classList.remove('text-gray-700');
                }
            });
        }

        // ===================================================================
        //   Per-owner cluster drill modal
        //
        //   Click owner name on the Owners tab → modal opens listing
        //   every duplicate cluster the person is named on (owner_email
        //   match on any record in the cluster, case-insensitive). Fed
        //   by /api/duplicates/clusters?owner_email=<email>&limit=200.
        //
        //   The cluster row's [Open] button hands off to the existing
        //   cluster-detail modal (openCluster) so all the existing
        //   resolve / merge / split actions still work — no duplicated
        //   UI surface.
        // ===================================================================

        let _ownerClustersCache = null;

        async function openOwnerClusters(ownerEmail, ownerName) {
            const modal = document.getElementById('ownerClustersModal');
            const title = document.getElementById('ownerClustersTitle');
            const subtitle = document.getElementById('ownerClustersSubtitle');
            const summary = document.getElementById('ownerClustersSummary');
            const list = document.getElementById('ownerClustersList');
            if (!modal) return;

            // Reset modal chrome and show a clear loading state. Each
            // re-open of the modal must NOT leak the previous owner's
            // data while the new fetch is in flight.
            if (title) title.textContent = ownerName || ownerEmail || 'Owner clusters';
            if (subtitle) subtitle.textContent = ownerEmail || '';
            if (summary) summary.innerHTML = '';
            if (list) list.innerHTML = '<div class="text-center text-gray-400 py-8">Loading…</div>';
            modal.classList.remove('hidden');

            if (!ownerEmail) {
                if (list) list.innerHTML = '<div class="text-center text-gray-500 py-8">No email on this owner row — can\'t filter clusters by owner.</div>';
                return;
            }

            try {
                const qs = new URLSearchParams();
                qs.set('owner_email', ownerEmail);
                qs.set('limit', '200');
                // Include hierarchies in the drill: the user is auditing
                // one specific owner, so a "1 account + N contacts" parent
                // is exactly the kind of thing they want to see.
                qs.set('include_hierarchies', 'true');
                const res = await fetch('/api/duplicates/clusters?' + qs.toString(), { credentials: 'same-origin' });
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                const data = await res.json();
                _ownerClustersCache = { owner_email: ownerEmail, owner_name: ownerName, data };
                renderOwnerClustersSummary(data);
                renderOwnerClustersList(data);
            } catch (err) {
                console.error('[OwnerClusters] load failed:', err);
                if (list) list.innerHTML = '<div class="text-center text-red-600 py-8">Couldn\'t load this owner\'s clusters. Try again.</div>';
            }
        }

        function renderOwnerClustersSummary(data) {
            const summary = document.getElementById('ownerClustersSummary');
            if (!summary) return;
            const clusters = Array.isArray(data?.clusters) ? data.clusters : [];
            const total = clusters.length;
            const highConf = clusters.filter(c => c.confidence_level === 'high').length;
            const active = clusters.filter(c => (c.status || 'active') === 'active').length;
            const wasteSum = clusters.reduce((s, c) => s + (Number(c.estimated_pipeline_value) || 0), 0);
            const card = (label, value, colorCls) => `
                <div class="bg-gray-50 rounded-lg p-3 border border-gray-100">
                    <div class="text-xs text-gray-500">${escapeHtml(label)}</div>
                    <div class="text-xl font-bold ${colorCls}">${value}</div>
                </div>`;
            summary.innerHTML = [
                card('Clusters', _fn(total), 'text-gray-900'),
                card('High-confidence', _fn(highConf), 'text-red-700'),
                card('Active (unresolved)', _fn(active), 'text-amber-700'),
                card('Exposure', typeof formatCurrency === 'function' ? formatCurrency(wasteSum) : ('SAR ' + _fn(wasteSum)), 'text-indigo-700'),
            ].join('');
        }

        function renderOwnerClustersList(data) {
            const list = document.getElementById('ownerClustersList');
            if (!list) return;
            const clusters = Array.isArray(data?.clusters) ? data.clusters : [];
            if (clusters.length === 0) {
                list.innerHTML = '<div class="text-center text-gray-500 py-8">This owner has no duplicate clusters in the current scan.</div>';
                return;
            }

            // Choose the "primary" module label for the cluster row by
            // picking whichever total_* count is largest. The cluster
            // can span multiple modules; this is just the headline.
            const headlineModule = (c) => {
                const counts = [
                    { label: 'Accounts', n: c.total_accounts || 0 },
                    { label: 'Deals', n: c.total_deals || 0 },
                    { label: 'Leads', n: c.total_leads || 0 },
                    { label: 'Contacts', n: c.total_contacts || 0 },
                ].filter(x => x.n > 0).sort((a, b) => b.n - a.n);
                return counts.length > 0 ? `${counts[0].label} (${counts[0].n})` : '—';
            };

            const statusBadge = (status) => {
                const s = (status || 'active').toLowerCase();
                const cls = s === 'resolved'
                    ? 'bg-green-100 text-green-800'
                    : s === 'ignored'
                        ? 'bg-gray-200 text-gray-700'
                        : 'bg-amber-100 text-amber-800';
                return `<span class="px-2 py-0.5 rounded text-xs font-medium ${cls}">${escapeHtml(s)}</span>`;
            };

            const confBadge = (level, score) => {
                const lvl = (level || 'low').toLowerCase();
                const cls = lvl === 'high'
                    ? 'bg-red-100 text-red-800'
                    : lvl === 'medium'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-gray-100 text-gray-600';
                const pct = Number.isFinite(Number(score))
                    ? ` ${Math.round(Number(score) * 100)}%`
                    : '';
                return `<span class="px-2 py-0.5 rounded text-xs font-medium ${cls}">${escapeHtml(lvl)}${pct}</span>`;
            };

            const rows = clusters.map(c => {
                const company = c.company_name || c.company_name_arabic || c.domain || '—';
                const waste = typeof formatCurrency === 'function'
                    ? formatCurrency(c.estimated_pipeline_value || 0)
                    : ('SAR ' + _fn(c.estimated_pipeline_value || 0));
                return `
                <tr class="border-b last:border-b-0 hover:bg-gray-50">
                    <td class="px-3 py-2 text-sm font-medium text-gray-900">${escapeHtml(company)}</td>
                    <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(c.domain || '—')}</td>
                    <td class="px-3 py-2 text-sm text-gray-700">${escapeHtml(headlineModule(c))}</td>
                    <td class="px-3 py-2 text-sm text-gray-700">${_fn(c.total_records || 0)}</td>
                    <td class="px-3 py-2 text-sm">${confBadge(c.confidence_level, c.confidence_score)}</td>
                    <td class="px-3 py-2 text-sm text-gray-700">${waste}</td>
                    <td class="px-3 py-2 text-sm">${statusBadge(c.status)}</td>
                    <td class="px-3 py-2 text-end">
                        <button data-on-click="openClusterFromOwner"
                                data-args='${escAttr(JSON.stringify([c.id]))}'
                                class="px-2 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-700 text-white">Open</button>
                    </td>
                </tr>`;
            }).join('');

            list.innerHTML = `
                <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Company</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Domain</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Module (headline)</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Records</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Confidence</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Exposure</th>
                                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Status</th>
                                <th scope="col" class="px-3 py-2"></th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-gray-200">${rows}</tbody>
                    </table>
                </div>`;
        }

        function closeOwnerClusters() {
            const modal = document.getElementById('ownerClustersModal');
            if (modal) modal.classList.add('hidden');
            _ownerClustersCache = null;
        }

        /**
         * Hand-off to the existing cluster-detail modal so all the
         * resolve / merge / split actions on /duplicates#clusters
         * continue to work without duplicating UI here. Closes this
         * modal first so the cluster modal sits on the same z-50
         * stack rather than stacking on top.
         */
        function openClusterFromOwner(clusterId) {
            closeOwnerClusters();
            // openCluster is the page's existing cluster-detail loader
            // (binds the cluster modal). We test for it on the chance
            // a future refactor renames it.
            if (typeof window.openCluster === 'function') {
                window.openCluster(clusterId);
            } else if (typeof window.openClusterById === 'function') {
                window.openClusterById(clusterId);
            } else {
                console.warn('[OwnerClusters] No openCluster handler found; falling back to URL hash.');
                window.location.hash = '#cluster-' + encodeURIComponent(String(clusterId));
            }
        }

        // Hide rows that don't match the owner/role/email filter input.
        // Filtering hides rows but does NOT uncheck them — operators can
        // search → tick → clear filter → search again → tick more, then
        // export the union with one click.
        function filterOwnersTable() {
            const inp = document.getElementById('ownersFilterInput');
            const q = (inp && inp.value || '').trim().toLowerCase();
            const tbody = document.getElementById('ownersTable');
            if (!tbody) return;
            tbody.querySelectorAll('tr[data-owner-row]').forEach(tr => {
                if (!q) { tr.classList.remove('hidden'); return; }
                const hay = [
                    tr.dataset.ownerName,
                    tr.dataset.ownerTeam,
                    tr.dataset.ownerEmail,
                ].filter(Boolean).join(' ').toLowerCase();
                tr.classList.toggle('hidden', !hay.includes(q));
            });
            syncOwnersSelectionState();
        }

        // Header checkbox: select / clear every VISIBLE owner row.
        function toggleAllOwnersSelected() {
            const all = document.getElementById('ownersSelectAll');
            const checked = !!(all && all.checked);
            const tbody = document.getElementById('ownersTable');
            if (!tbody) return;
            tbody.querySelectorAll('tr[data-owner-row]:not(.hidden) .owner-row-checkbox').forEach(cb => {
                cb.checked = checked;
            });
            syncOwnersSelectionState();
        }

        // Keep the header checkbox in sync (checked / unchecked / indeterminate)
        // and update the "X selected" hint next to the filter input.
        function syncOwnersSelectionState() {
            const tbody = document.getElementById('ownersTable');
            if (!tbody) return;
            const visibleRows = Array.from(tbody.querySelectorAll('tr[data-owner-row]:not(.hidden)'));
            const checkedRows = visibleRows.filter(tr => {
                const cb = tr.querySelector('.owner-row-checkbox');
                return cb && cb.checked;
            });
            const all = document.getElementById('ownersSelectAll');
            if (all) {
                if (visibleRows.length === 0) {
                    all.checked = false;
                    all.indeterminate = false;
                } else if (checkedRows.length === visibleRows.length) {
                    all.checked = true;
                    all.indeterminate = false;
                } else if (checkedRows.length === 0) {
                    all.checked = false;
                    all.indeterminate = false;
                } else {
                    all.checked = false;
                    all.indeterminate = true;
                }
            }
            const totalChecked = tbody.querySelectorAll('.owner-row-checkbox:checked').length;
            const hint = document.getElementById('ownersSelectionCount');
            if (hint) hint.textContent = totalChecked > 0 ? `${totalChecked} selected` : '';
        }

        // Build a CSV from the currently checked owner rows (cached server
        // payload, not DOM scraping, so numeric fields keep their precision).
        // No-op + alert when nothing is ticked — avoids an empty download
        // which is the more confusing failure mode.
        function exportOwnersSelected() {
            const tbody = document.getElementById('ownersTable');
            if (!tbody) return;
            const checkedKeys = new Set();
            tbody.querySelectorAll('tr[data-owner-row] .owner-row-checkbox:checked').forEach(cb => {
                const tr = cb.closest('tr[data-owner-row]');
                if (tr && tr.dataset.ownerKey) checkedKeys.add(tr.dataset.ownerKey);
            });
            if (checkedKeys.size === 0) {
                alert('Tick at least one row in the table to include it in the CSV.');
                return;
            }
            const selected = _ownersCache.filter((o, idx) => {
                const k = encodeURIComponent(o.owner_name || `row-${idx}`);
                return checkedKeys.has(k);
            });
            const esc = (v) => {
                if (v === null || v === undefined) return '""';
                return '"' + String(v).replace(/"/g, '""') + '"';
            };
            const row = (cells) => cells.map(esc).join(',');
            const lines = [];
            lines.push(row(['Owner', 'Role', 'Email', 'Total Records', 'Duplicates', 'Dup Rate (%)', 'KPI Status', 'High Confidence', 'Waste Value (SAR)']));
            for (const o of selected) {
                lines.push(row([
                    o.owner_name || '',
                    o.team || 'Unassigned',
                    o.owner_email || '',
                    o.total_records ?? 0,
                    o.duplicate_records ?? 0,
                    o.duplicate_rate ?? 0,
                    o.rag_status || '',
                    o.high_confidence_duplicates ?? 0,
                    o.estimated_waste_value ?? 0,
                ]));
            }
            // BOM so Excel decodes UTF-8 (Arabic owner names) correctly.
            const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `owner-accountability-${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        function renderLogs(logs) {
            const tbody = document.getElementById('logsTable');
            const ALLOWED_STATUSES = ['completed', 'failed', 'running', 'pending'];
            tbody.innerHTML = logs.map(l => {
                const safeStatus = ALLOWED_STATUSES.includes(String(l.status || '')) ? String(l.status) : 'unknown';
                const statusClass = safeStatus === 'completed' ? 'bg-green-100 text-green-800' : safeStatus === 'failed' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800';
                return `
                <tr>
                    <td class="px-6 py-3 text-sm text-gray-500">${formatDate(l.created_at)}</td>
                    <td class="px-6 py-3 text-sm capitalize">${escapeHtml(l.detection_type || l.triggered_by || '-')}</td>
                    <td class="px-6 py-3 text-sm">${l.total_records_scanned || 0}</td>
                    <td class="px-6 py-3 text-sm">${l.total_clusters_found || 0}</td>
                    <td class="px-6 py-3 text-sm">${l.total_duplicates_detected || 0}</td>
                    <td class="px-6 py-3 text-sm">${l.detection_duration_ms ? _fn((l.detection_duration_ms / 1000).toFixed(1)) + 's' : '-'}</td>
                    <td class="px-6 py-3 text-sm"><span class="px-2 py-1 rounded text-xs ${statusClass}">${escapeHtml(safeStatus)}</span></td>
                </tr>`;
            }).join('') || `<tr><td colspan="7" class="px-6 py-4 text-center text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_scan_logs'))}</td></tr>`;
        }

        // Agent Activity Log — every AI Duplicate Resolution action from
        // /api/duplicates/resolution-activity. Rendered in the Logs tab.
        async function loadAgentActivity() {
            const tbody = document.getElementById('agentActivityTable');
            if (!tbody) return;
            let data;
            try {
                const res = await fetch('/api/duplicates/resolution-activity?limit=100', { credentials: 'same-origin' });
                data = await res.json();
            } catch (_) { data = null; }
            renderAgentActivity((data && data.activity) || []);
        }
        function renderAgentActivity(rows) {
            const tbody = document.getElementById('agentActivityTable');
            if (!tbody) return;
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="10" class="px-6 py-4 text-center text-gray-400">No AI resolution activity yet — it appears here as soon as the agent previews, dry-runs, or applies a merge.</td></tr>';
                return;
            }
            const actionBadge = (t) => {
                const cls = t === 'applied' ? 'bg-green-100 text-green-800' : t === 'dry_run' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700';
                const label = t === 'dry_run' ? 'Dry-run' : t === 'applied' ? 'Applied' : 'Preview';
                return '<span class="px-2 py-0.5 rounded text-xs font-medium ' + cls + '">' + escapeHtml(label) + '</span>';
            };
            tbody.innerHTML = rows.map(r => {
                const survivor = '<span class="font-mono text-xs text-gray-700">' + escapeHtml(r.chosenMaster || '—') + '</span>' +
                    (r.masterOverridden ? ' <span class="text-amber-600 text-xs">(overridden)</span>' : '');
                const errCls = (r.errors > 0) ? 'text-red-700 font-medium' : 'text-gray-500';
                return '<tr>' +
                    '<td class="px-4 py-3 text-sm text-gray-500">' + formatDate(r.at) + '</td>' +
                    '<td class="px-4 py-3 text-sm">' + actionBadge(r.eventType) + '</td>' +
                    '<td class="px-4 py-3 text-sm"><span class="text-blue-600 hover:underline cursor-pointer" data-on-click="showClusterDetails" data-args="[' + Number(r.clusterId) + ']">#' + Number(r.clusterId) + '</span></td>' +
                    '<td class="px-4 py-3 text-sm">' + survivor + '</td>' +
                    '<td class="px-4 py-3 text-sm text-end">' + (r.fieldsMigrated || 0) + '</td>' +
                    '<td class="px-4 py-3 text-sm text-end">' + (r.duplicatesTagged || 0) + '</td>' +
                    '<td class="px-4 py-3 text-sm text-end">' + (r.reparented || 0) + '</td>' +
                    '<td class="px-4 py-3 text-sm text-end ' + errCls + '">' + (r.errors || 0) + '</td>' +
                    '<td class="px-4 py-3 text-sm text-gray-600">' + escapeHtml(r.performedBy || '—') + '</td>' +
                    '<td class="px-4 py-3 text-sm whitespace-nowrap">' +
                        '<button data-on-click="redoResolution" data-args="[' + Number(r.clusterId) + ']" class="text-indigo-600 hover:underline text-xs" title="Re-run the resolution for this cluster now">↻ Re-do</button>' +
                        (r.eventType === 'applied'
                            ? ' <button data-on-click="undoResolution" data-args="[' + Number(r.clusterId) + ']" class="ms-2 text-red-600 hover:underline text-xs" title="Remove the Duplicate-Delete tags and reopen the cluster">⤺ Undo</button>'
                            : '') +
                    '</td>' +
                    '</tr>';
            }).join('');
        }

        // Re-do: re-run the agent on one cluster now.
        async function redoResolution(clusterId) {
            if (!confirm('Re-run the autonomous resolution for cluster #' + clusterId + ' now?')) return;
            try {
                const res = await fetch('/api/duplicates/autonomous/run-cluster/' + clusterId, {
                    method: 'POST', credentials: 'same-origin'
                });
                const data = await res.json();
                const s = (data && data.summary) || {};
                alert('Re-do complete for #' + clusterId + ': applied ' + (s.applied || 0) + ', queued ' + (s.queued || 0) + ', errors ' + (s.errors || 0) + '.');
                loadAgentActivity();
            } catch (e) { alert('Re-do failed: ' + e); }
        }

        // Manual Actions table — Mark Resolved / Mark Dismissed / Bulk-split
        // events from duplicate_merge_actions, paired with the AI activity
        // above. Default filter is "all"; chips narrow to one action_type.
        window._manualActionsFilter = window._manualActionsFilter || 'all';
        async function loadManualActions() {
            const tbody = document.getElementById('manualActionsTable');
            if (!tbody) return;
            const filter = window._manualActionsFilter || 'all';
            const url = filter === 'all'
                ? '/api/duplicates/merge-actions?limit=100'
                : '/api/duplicates/merge-actions?limit=100&action_type=' + encodeURIComponent(filter);
            let data;
            try {
                const res = await fetch(url, { credentials: 'same-origin' });
                data = await res.json();
            } catch (_) { data = null; }
            renderManualActions((data && data.actions) || []);
        }
        function filterMergeActions(filter) {
            window._manualActionsFilter = filter || 'all';
            // Repaint chip palette — active chip = solid, others = soft.
            ['all','resolve','ignore','module_resolved','split'].forEach(function (k) {
                const el = document.getElementById('manualActChip-' + k);
                if (!el) return;
                const isOn = k === filter;
                const palette = {
                    all:             { on: 'bg-gray-900 text-white',     off: 'bg-gray-100 text-gray-700 hover:bg-gray-200' },
                    resolve:         { on: 'bg-emerald-600 text-white',  off: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' },
                    ignore:          { on: 'bg-gray-700 text-white',     off: 'bg-gray-200 text-gray-700 hover:bg-gray-300' },
                    module_resolved: { on: 'bg-amber-600 text-white',    off: 'bg-amber-100 text-amber-700 hover:bg-amber-200' },
                    split:           { on: 'bg-violet-600 text-white',   off: 'bg-violet-100 text-violet-700 hover:bg-violet-200' },
                };
                el.className = 'px-3 py-1 rounded-full font-semibold ' + (isOn ? palette[k].on : palette[k].off);
            });
            loadManualActions();
        }
        function renderManualActions(rows) {
            const tbody = document.getElementById('manualActionsTable');
            if (!tbody) return;
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-400">No manual actions yet for this filter — Mark Resolved / Mark Dismissed / Bulk-split events land here as soon as an operator acts.</td></tr>';
                return;
            }
            const actionBadge = function (t) {
                if (t === 'resolve')         return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">Mark Resolved</span>';
                if (t === 'ignore')          return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700">Mark Dismissed</span>';
                if (t === 'module_resolved') return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800" title="One module of a cross-module cluster applied; other modules still open">Partial apply</span>';
                if (t === 'split')           return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-800" title="Bulk-split contacts cleanup re-shaped this cluster">Bulk-split</span>';
                if (t === 'auto_merge_pending') return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800" title="Auto-merge tagged the duplicates Duplicate-Delete — pending the Zoho admin actually deleting them">Auto-merge · pending</span>';
                if (t === 'merge')           return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">Merge</span>';
                return '<span class="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">' + escapeHtml(String(t || '—')) + '</span>';
            };
            tbody.innerHTML = rows.map(function (r) {
                const mergedIds = Array.isArray(r.merged_record_ids) ? r.merged_record_ids
                    : (typeof r.merged_record_ids === 'string'
                        ? (function () { try { return JSON.parse(r.merged_record_ids); } catch (_) { return []; } })()
                        : []);
                const recordsCount = mergedIds.length;
                const cluster = '<span class="text-blue-600 hover:underline cursor-pointer" data-on-click="showClusterDetails" data-args="[' + Number(r.cluster_id) + ']">#' + Number(r.cluster_id) + '</span>'
                    + (r.cluster_company_name ? ' <span class="text-gray-500 text-xs">' + escapeHtml(r.cluster_company_name) + '</span>' : '')
                    + (r.cluster_domain ? ' <span class="text-gray-400 text-[10px] font-mono">(' + escapeHtml(r.cluster_domain) + ')</span>' : '');
                return '<tr>'
                    + '<td class="px-4 py-3 text-sm text-gray-500">' + formatDate(r.created_at) + '</td>'
                    + '<td class="px-4 py-3 text-sm">' + actionBadge(r.action_type) + '</td>'
                    + '<td class="px-4 py-3 text-sm">' + cluster + '</td>'
                    + '<td class="px-4 py-3 text-sm text-end">' + recordsCount + '</td>'
                    + '<td class="px-4 py-3 text-sm text-gray-600">' + escapeHtml(r.performed_by || '—') + '</td>'
                    + '<td class="px-4 py-3 text-xs text-gray-500 max-w-md" title="' + escapeHtml(r.notes || '') + '">' + escapeHtml((r.notes || '').slice(0, 120)) + (r.notes && r.notes.length > 120 ? '…' : '') + '</td>'
                    + '</tr>';
            }).join('');
        }

        // Undo: remove the agent's Duplicate-Delete tags + reopen the cluster.
        async function undoResolution(clusterId) {
            if (!confirm('Undo the last apply on cluster #' + clusterId + '?\n\nThis removes the Duplicate-Delete tags and reopens the cluster. Gap-filled survivor fields are kept (they only filled blanks).')) return;
            try {
                const res = await fetch('/api/duplicates/autonomous/undo/' + clusterId, {
                    method: 'POST', credentials: 'same-origin'
                });
                const data = await res.json();
                alert((data && data.message) || (data && data.ok ? 'Undone.' : 'Undo failed.'));
                loadAgentActivity();
            } catch (e) { alert('Undo failed: ' + e); }
        }

        // D2: Enhanced cluster modal with side-by-side comparison + AI recommendations
        async function showClusterDetails(id) {
            document.getElementById('clusterModal').classList.remove('hidden');
            document.getElementById('modalContent').innerHTML = `<div class="text-center py-8 text-gray-400">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.loading_dots'))}</div>`;

            // Wrap the whole render in a try/catch so any downstream exception
            // (missing field on the API response, translation lookup miss, etc.)
            // surfaces inside the modal instead of leaving it stuck on "Loading…".
            let data, res;
            try {
                res = await fetch(`/api/duplicates/clusters/${id}`);
            } catch (e) {
                document.getElementById('modalContent').innerHTML =
                    `<div class="text-center py-8 text-red-600 text-sm">Failed to reach server: ${escapeHtml(String(e && e.message || e))}</div>`;
                return;
            }
            if (!res || !res.ok) {
                document.getElementById('modalContent').innerHTML =
                    `<div class="text-center py-8 text-red-600 text-sm">Server returned ${res ? res.status : '—'} for cluster ${escapeHtml(String(id))}. The cluster may have been resolved, dismissed, or removed.</div>`;
                return;
            }
            try {
                data = await res.json();
            } catch (e) {
                document.getElementById('modalContent').innerHTML =
                    `<div class="text-center py-8 text-red-600 text-sm">Response was not JSON: ${escapeHtml(String(e && e.message || e))}</div>`;
                return;
            }

            const { cluster, records: recordsRaw, recommendations, primary_type, is_cross_module, record_types, mixed_signal } = data || {};
            if (!cluster) {
                document.getElementById('modalContent').innerHTML =
                    `<div class="text-center py-8 text-amber-700 text-sm">Cluster ${escapeHtml(String(id))} not found in the API response.</div>`;
                return;
            }
            const records = Array.isArray(recordsRaw) ? recordsRaw : [];

            window.__currentClusterId = id;
            window.__currentMixedSignal = mixed_signal || { domains: [], phones: [], domain_groups: {} };

            document.getElementById('modalTitle').textContent = cluster.company_name || cluster.domain;
            const isSynthetic = typeof cluster.domain === 'string' && cluster.domain.endsWith('.cluster');
            const syntheticNote = isSynthetic
                ? ' · <span class="text-amber-600" title="Synthetic domain — built from phone or company-name match, not a real web domain">synthetic cluster</span>'
                : '';
            document.getElementById('modalDomain').innerHTML =
                `${escapeHtml(WalaPlusI18n.t('dyn.duplicates.domain_kw'))} ${escapeHtml(cluster.domain || '')} | ${escapeHtml(WalaPlusI18n.t('dyn.duplicates.score_kw'))} ${_fn(cluster.confidence_score || 0)}% | ${escapeHtml(WalaPlusI18n.t('dyn.duplicates.status_kw'))} ${escapeHtml(cluster.status || '')}` + syntheticNote;

            const recMap = {};
            (recommendations || []).forEach(r => { recMap[r.record_id] = r; });

            // Catch any exception in the heavy body-render below so the modal
            // never silently sticks on the original "Loading…" placeholder.
            try {
                __renderClusterDetailBody({ cluster, records, recommendations: recommendations || [], primary_type, is_cross_module, record_types, mixed_signal: window.__currentMixedSignal, recMap, id });
                loadClusterDetailAttachmentChips(id, records);
                _resumeMergeJobIfRunning(id);
            } catch (err) {
                console.error('[clusterDetails] render failed', err);
                document.getElementById('modalContent').innerHTML =
                    `<div class="py-6 px-4 text-sm">
                        <div class="text-red-700 font-medium mb-2">Failed to render cluster details.</div>
                        <pre class="bg-gray-50 border border-gray-200 rounded p-2 overflow-auto text-xs text-gray-700">${escapeHtml(String(err && err.message || err))}</pre>
                        <div class="text-xs text-gray-500 mt-2">Cluster ID ${escapeHtml(String(id))} — open browser DevTools for the full stack trace.</div>
                    </div>`;
            }
            return;
        }

        // After the cluster-detail modal renders, decorate each record's Zoho
        // link (data-testid="link-zoho-<id>") with a 📎 attachment count, so
        // manual operators see evidence-richness when deciding the survivor —
        // the same signal the autonomous agent reads. Bounded: one fetch per
        // module present in the cluster.
        async function loadClusterDetailAttachmentChips(clusterId, records) {
            try {
                const MOD = { lead: 'Leads', deal: 'Deals', contact: 'Contacts', account: 'Accounts' };
                const modules = Array.from(new Set((records || [])
                    .map(r => MOD[String(r.record_type || '').toLowerCase()])
                    .filter(Boolean)));
                const modal = document.getElementById('modalContent');
                if (!modal || !modules.length) return;
                for (const module of modules) {
                    let counts = {};
                    try {
                        const res = await fetch('/api/duplicates/clusters/' + clusterId + '/attachments?module=' + encodeURIComponent(module), { credentials: 'same-origin' });
                        if (!res.ok) continue;
                        counts = ((await res.json()) || {}).counts || {};
                    } catch (_) { continue; }
                    Object.keys(counts).forEach(function (zid) {
                        const n = counts[zid] | 0;
                        if (n <= 0) return; // only badge records that actually carry files
                        modal.querySelectorAll('a[data-testid="link-zoho-' + zid + '"]').forEach(function (a) {
                            if (a.nextSibling && a.nextSibling.classList && a.nextSibling.classList.contains('att-chip')) return;
                            const chip = document.createElement('span');
                            chip.className = 'att-chip ms-1 text-xs font-semibold text-amber-700';
                            chip.title = n + ' attachment(s) on this record — evidence';
                            chip.textContent = '📎' + n;
                            a.insertAdjacentElement('afterend', chip);
                        });
                    });
                }
            } catch (_) { /* non-fatal */ }
        }

        function __renderClusterDetailBody({ cluster, records, recommendations, primary_type, is_cross_module, record_types, mixed_signal, recMap, id }) {

            // Per-record-type tally so users can see at a glance what's
            // inside the "N records" total without scrolling through the
            // record cards below. Same color scheme as the cluster cards
            // on the Domain Clusters tab (leads=amber, deals=red,
            // contacts=teal, accounts=indigo).
            const _typeCounts = { lead: 0, deal: 0, contact: 0, account: 0 };
            for (const r of records) {
                const t = String(r.record_type || '').toLowerCase();
                if (t in _typeCounts) _typeCounts[t]++;
            }
            const _typeChipMeta = [
                { key: 'lead',    label: 'Leads',    cls: 'bg-amber-100 text-amber-800',   testid: 'badge-type-leads' },
                { key: 'deal',    label: 'Deals',    cls: 'bg-red-100 text-red-800',       testid: 'badge-type-deals' },
                { key: 'contact', label: 'Contacts', cls: 'bg-teal-100 text-teal-800',     testid: 'badge-type-contacts' },
                { key: 'account', label: 'Accounts', cls: 'bg-indigo-100 text-indigo-800', testid: 'badge-type-accounts' },
            ];
            // Clickable type chips — clicking one filters the comparison table
            // below to that record type; "All" resets. CSP-safe data-on-click.
            const _allChip = `<button type="button" data-on-click="filterClusterComparison" data-args='["all"]' data-cluster-chip="all" data-testid="badge-type-all" class="cluster-type-chip px-2.5 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-800 cursor-pointer hover:ring-2 hover:ring-gray-400" title="Show all record types in the comparison below">All: ${_fn(records.length)}</button>`;
            const _typeChips = _allChip + _typeChipMeta
                .filter(m => _typeCounts[m.key] > 0)
                .map(m => `<button type="button" data-on-click="filterClusterComparison" data-args='["${m.key}"]' data-cluster-chip="${m.key}" data-testid="${m.testid}" class="cluster-type-chip px-2.5 py-1 rounded-full text-xs font-medium ${m.cls} cursor-pointer hover:ring-2 hover:ring-gray-400" title="Show only ${escapeHtml(m.label.toLowerCase())} in the comparison below">${escapeHtml(m.label)}: ${_fn(_typeCounts[m.key])}</button>`)
                .join('');

            let html = `<div class="mb-4 flex flex-wrap gap-2 items-center">
                <span class="confidence-${['high','medium','low'].includes(cluster.confidence_level)?cluster.confidence_level:'low'} px-3 py-1 rounded-full text-sm font-medium">${WalaPlusI18n.t('dyn.duplicates.badge_match', { score: _fn(cluster.confidence_score) })}</span>
                <span class="px-3 py-1 rounded-full text-sm bg-gray-100">${WalaPlusI18n.t('dyn.duplicates.badge_records', { n: _fn(records.length) })}</span>
                ${_typeChips}
                <span class="px-3 py-1 rounded-full text-sm bg-purple-100 text-purple-800">${WalaPlusI18n.t('dyn.duplicates.badge_inflation', { value: formatCurrency(cluster.estimated_pipeline_value||0) })}</span>
                ${primary_type ? `<span class="px-3 py-1 rounded-full text-sm bg-indigo-100 text-indigo-800">${WalaPlusI18n.t('dyn.duplicates.badge_primary', { type: escapeHtml(primary_type) })}</span>` : ''}
                ${is_cross_module ? `<span data-testid="badge-cross-module" class="px-3 py-1 rounded-full text-sm bg-amber-100 text-amber-800 font-medium">Cross-module cluster (${(record_types||[]).map(t => escapeHtml(t)).join(' + ')})</span>` : ''}
            </div>`;

            if (is_cross_module) {
                html += `<div data-testid="banner-cross-module" class="mb-4 p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-900">
                    <strong>${WalaPlusI18n.t('dyn.duplicates.cross_module_heads_up')}:</strong> ${WalaPlusI18n.t('dyn.duplicates.cross_module_no_cross_merge')}
                    <strong>MERGE</strong>. ${WalaPlusI18n.t('dyn.duplicates.cross_module_cross_children')}
                    <strong>LINK</strong> ${WalaPlusI18n.t('dyn.duplicates.cross_module_set_the')}
                    <code class="bg-amber-100 px-1 rounded">Account_Name</code> /
                    <code class="bg-amber-100 px-1 rounded">Contact_Name</code> ${WalaPlusI18n.t('dyn.duplicates.cross_module_field_in_zoho')}
                    ${WalaPlusI18n.t('dyn.duplicates.cross_module_lead_superseded')} <strong>CLOSED</strong> ${WalaPlusI18n.t('dyn.duplicates.cross_module_or_converted')}
                </div>`;
            }

            // Mixed-cluster warning — fires when 2+ distinct corporate
            // email domains are present inside a single cluster (almost
            // always two unrelated companies sharing a name fragment).
            if (mixed_signal && Array.isArray(mixed_signal.domains) && mixed_signal.domains.length > 1) {
                const domainBadges = mixed_signal.domains
                    .map(d => `<code class="bg-red-100 text-red-800 px-1.5 py-0.5 rounded text-xs">${escapeHtml(d)}</code>`)
                    .join(' · ');
                html += `<div data-testid="banner-mixed-cluster" class="mb-4 p-3 rounded-lg border border-red-300 bg-red-50 text-sm text-red-900">
                    <div class="flex items-start justify-between gap-3 flex-wrap">
                        <div class="flex-1 min-w-0">
                            <strong>⚠ Mixed cluster — ${mixed_signal.domains.length} distinct domains detected.</strong>
                            <div class="mt-1">${domainBadges}</div>
                            <p class="mt-2 text-xs text-red-800">
                                These records were grouped by name similarity but appear to belong to different companies.
                                Review each row before any merge / link in Zoho. The largest domain group will stay in this
                                cluster; the others will move to fresh clusters.
                            </p>
                        </div>
                        <button type="button" data-on-click="splitClusterByDomain" data-args="[${id}]"
                                class="shrink-0 px-3 py-1.5 bg-red-600 text-white rounded-md hover:bg-red-700 text-xs font-medium"
                                data-testid="button-split-by-domain">
                            Split by domain
                        </button>
                    </div>
                </div>`;
            }

            // Side-by-side comparison table
            html += `<div id="clusterComparison" class="overflow-x-auto mb-6"><table class="min-w-full text-sm border"><thead class="bg-gray-50"><tr>
                <th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500">${WalaPlusI18n.t('dyn.duplicates.col_field')}</th>`;
            records.forEach((r, i) => {
                html += `<th scope="col" data-rc-type="${escAttr(r.record_type || '')}" class="px-3 py-2 text-start text-xs font-medium text-gray-500 border-l">${r.is_primary ? '★ ' : ''}${WalaPlusI18n.t('dyn.duplicates.record_n_header', { n: _fn(i+1) })} (${escapeHtml(r.record_type)})</th>`;
            });
            html += '</tr></thead><tbody>';

            const fields = [
                { key: 'record_name', label: WalaPlusI18n.t('dyn.duplicates.field_name') },
                { key: 'zoho_record_id', label: WalaPlusI18n.t('dyn.duplicates.field_zoho_id'), render: (v, r) => zohoLink(v, r.record_type === 'lead' ? 'Leads' : r.record_type === 'deal' ? 'Deals' : r.record_type === 'contact' ? 'Contacts' : 'Accounts') },
                { key: 'company_name', label: WalaPlusI18n.t('dyn.duplicates.field_company') },
                { key: 'email', label: WalaPlusI18n.t('dyn.duplicates.field_email') },
                { key: 'phone', label: WalaPlusI18n.t('dyn.duplicates.field_phone') },
                { key: 'mobile', label: WalaPlusI18n.t('dyn.duplicates.field_mobile') },
                { key: 'owner_name', label: WalaPlusI18n.t('dyn.duplicates.field_owner') },
                { key: 'status', label: WalaPlusI18n.t('dyn.duplicates.field_status') },
                { key: 'stage', label: WalaPlusI18n.t('dyn.duplicates.field_stage') },
                { key: 'deal_value', label: WalaPlusI18n.t('dyn.duplicates.field_value'), render: v => v ? formatCurrency(v) : '-' },
                { key: 'source', label: WalaPlusI18n.t('dyn.duplicates.field_source') },
                { key: 'layout_name', label: WalaPlusI18n.t('dyn.duplicates.field_layout') },
                { key: 'zoho_module', label: WalaPlusI18n.t('dyn.duplicates.field_module') },
                { key: 'pipeline', label: WalaPlusI18n.t('dyn.duplicates.field_pipeline') },
                { key: 'contact_name', label: WalaPlusI18n.t('dyn.duplicates.field_contact') },
                { key: 'account_name', label: WalaPlusI18n.t('dyn.duplicates.field_account') },
                { key: 'cr_number', label: WalaPlusI18n.t('dyn.duplicates.field_cr_number') },
                { key: 'vat_number', label: WalaPlusI18n.t('dyn.duplicates.field_vat_number') },
                { key: 'website', label: WalaPlusI18n.t('dyn.duplicates.field_website') },
                { key: 'country', label: WalaPlusI18n.t('dyn.duplicates.field_country') },
                { key: 'industry', label: WalaPlusI18n.t('dyn.duplicates.field_industry') },
                { key: 'title', label: WalaPlusI18n.t('dyn.duplicates.field_title') },
                { key: 'created_date', label: WalaPlusI18n.t('dyn.duplicates.field_created'), render: v => formatDate(v) },
                { key: 'modified_date', label: WalaPlusI18n.t('dyn.duplicates.field_modified'), render: v => formatDate(v) },
            ];

            fields.forEach(f => {
                html += `<tr class="border-t"><td class="px-3 py-2 font-medium text-gray-600">${f.label}</td>`;
                records.forEach(r => {
                    const val = f.render ? f.render(r[f.key], r) : escapeHtml(r[f.key] || '-');
                    html += `<td data-rc-type="${escAttr(r.record_type || '')}" class="px-3 py-2 border-l">${val}</td>`;
                });
                html += '</tr>';
            });

            // AI recommendation row
            html += `<tr class="border-t bg-blue-50"><td class="px-3 py-2 font-medium text-blue-700">${WalaPlusI18n.t('dyn.duplicates.ai_recommendation')}</td>`;
            records.forEach(r => {
                const rec = recMap[r.id];
                if (rec) {
                    const actionClass = `action-${escAttr(rec.action_type)}`;
                    const typeTag = r.record_type
                        ? `<span class="ms-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600 border border-slate-200 uppercase tracking-wide">${escapeHtml(r.record_type)}</span>`
                        : '';
                    html += `<td data-rc-type="${escAttr(r.record_type || '')}" class="px-3 py-2 border-l"><span class="${actionClass} px-2 py-1 rounded text-xs font-bold">${escapeHtml(rec.action_type).toUpperCase()}</span>${typeTag}<div class="text-xs text-gray-500 mt-1">${escapeHtml(rec.recommendation)}</div>`;
                    if (rec.reasons?.length) html += `<div class="text-xs text-gray-400 mt-1">${rec.reasons.map(reason => escapeHtml(reason)).join(', ')}</div>`;
                    html += '</td>';
                } else {
                    html += `<td data-rc-type="${escAttr(r.record_type || '')}" class="px-3 py-2 border-l text-gray-400">-</td>`;
                }
            });
            html += '</tr></tbody></table></div>';

            if (cluster.status === 'active') {
                html += `<div class="border-t pt-4">
                    <div class="flex flex-wrap gap-3 mb-2">
                        <button data-on-click="resolveClusterAction" data-args="[${cluster.id},&quot;ignore&quot;]" data-testid="button-ignore-${cluster.id}" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 text-sm font-medium">${WalaPlusI18n.t('dyn.duplicates.ignore_label')}</button>
                    </div>
                    <p data-testid="text-post-merge-hint" class="text-xs text-gray-500 italic">
                        ${WalaPlusI18n.t('dyn.duplicates.post_merge_hint')}
                    </p>
                </div>`;
            } else if (cluster.verification_state) {
                // R3: surface verification outcome on already-resolved clusters
                // so operators can audit whether previous Mark-Resolved actions
                // actually landed in Zoho.
                const v = cluster.verification_state;
                const badgeCls = v === 'verified'
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                    : v === 'failed'
                        ? 'bg-red-100 text-red-800 border-red-300'
                        : 'bg-gray-100 text-gray-700 border-gray-300';
                html += `<div class="border-t pt-4">
                    <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded border ${badgeCls} text-xs font-medium" data-testid="badge-verification-${cluster.id}">
                        <span class="font-semibold uppercase">${escapeHtml(v)}</span>
                        ${cluster.verification_notes ? '<span class="opacity-80">' + escapeHtml(cluster.verification_notes) + '</span>' : ''}
                    </div>
                </div>`;
            }

            // Phase 1 — Agentic Duplicate Resolution: non-destructive "Preview
            // Merge Plan" for Accounts clusters (2+ account records). Calls the
            // read-only /plan endpoint and renders the proposed survivor, field
            // migrations, conflicts, and which duplicates would be tagged
            // Duplicate-Delete. No writes happen here — pure preview.
            // One Agentic Resolution section per module present with >=2
            // records. Each resolves its own module independently (same
            // migrate-then-tag model); on multi-module clusters each section
            // leaves the cluster open for the other modules.
            const _agenticModules = [
                { module: 'Accounts', type: 'account', label: 'Accounts' },
                { module: 'Leads', type: 'lead', label: 'Leads' },
                { module: 'Deals', type: 'deal', label: 'Deals' },
                { module: 'Contacts', type: 'contact', label: 'Contacts' },
            ].filter(m => (_typeCounts[m.type] || 0) >= 2);
            for (const am of _agenticModules) {
                html += `<div class="border-t-2 border-purple-200 pt-4 mt-4" data-testid="section-merge-plan-${am.module}">
                    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
                        <div>
                            <h4 class="text-sm font-bold text-purple-800 flex items-center gap-2">
                                <span class="px-2 py-0.5 rounded-full bg-purple-600 text-white text-[10px] font-bold uppercase tracking-wide">AI</span>
                                Agentic Resolution — ${escapeHtml(am.label)}
                                <span class="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 text-[10px] font-medium">${_fn(_typeCounts[am.type])} ${escapeHtml(am.label.toLowerCase())}</span>
                            </h4>
                            <p class="text-xs text-gray-500">Proposes a survivor, migrates winning fields, reparents related records + notes, and flags duplicates with <code class="bg-gray-100 px-1 rounded">Duplicate-Delete</code> for the admin. Preview first — then dry-run or apply. The platform never deletes.</p>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <button data-on-click="recheckCluster" data-args='[${cluster.id}]' data-testid="button-recheck-cluster-${cluster.id}" class="px-3 py-2 bg-white border border-blue-300 text-blue-700 hover:bg-blue-50 rounded-lg text-sm font-medium" title="Re-fetch every record in this cluster from Zoho fresh — confirms the post-merge state (Account_Name, Duplicate-Delete tag, still-alive vs. deleted) without waiting for the next 6h scan.">🔁 Re-check cluster</button>
                            <button data-on-click="verifyTaggedRecords" data-args='[${cluster.id}]' data-testid="button-verify-tags-${cluster.id}" class="px-3 py-2 bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 rounded-lg text-sm font-medium" title="Re-query Zoho for every record this cluster has tagged Duplicate-Delete — shows how many the admin has actually deleted vs. still pending.">✅ Verify tags in Zoho</button>
                            <button data-on-click="previewMergePlan" data-args='["${am.module}",${cluster.id}]' data-testid="button-preview-merge-plan-${am.module}-${cluster.id}" title="Loads the AI merge plan into the panel below. You still need to click Apply in Zoho inside the plan to actually tag duplicates." class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-semibold">🔍 Preview ${escapeHtml(am.label)} Plan <span class="text-[10px] font-normal opacity-80">(then Apply inside)</span></button>
                        </div>
                    </div>
                    <div id="recheckPanel-${cluster.id}" class="text-sm mb-2"></div>
                    <div id="verifyTagsPanel-${cluster.id}" class="text-sm mb-2"></div>
                    ${is_cross_module ? `<div class="mb-2 p-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900"><strong>Multi-module cluster:</strong> this resolves <strong>${escapeHtml(am.label)} only</strong> and <strong>leaves the cluster open</strong> for the other modules — finish them via their own Agentic Resolution section. The platform never deletes.</div>` : ''}
                    <div id="mergePlanPanel-${am.module}" class="text-sm"></div>
                </div>`;
            }

            // R10: snapshots section. Empty placeholder rendered with the
            // modal; the async loadClusterSnapshots() fetch populates it
            // after the main modal content is in place so the modal doesn't
            // block on a second round-trip.
            html += `<div class="border-t pt-4 mt-4">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-semibold text-gray-700">Pre-merge snapshots</h4>
                    <span class="text-xs text-gray-400">Forensic trail — captured before each agentic apply / domain-collision merge</span>
                </div>
                <div id="clusterSnapshotsList" data-cluster-id="${cluster.id}" class="text-xs text-gray-500">Loading snapshots…</div>
            </div>`;

            // Follow-up 1: Action timeline (duplicate_merge_actions). Audit
            // trail of every resolve / ignore / domain_collision_merge
            // performed on this cluster.
            html += `<div class="border-t pt-4 mt-4">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-semibold text-gray-700">Action timeline</h4>
                    <span class="text-xs text-gray-400">Audit trail — who acted, when, and what they did</span>
                </div>
                <div id="clusterActionTimeline" data-cluster-id="${cluster.id}" class="text-xs text-gray-500">Loading actions…</div>
            </div>`;

            document.getElementById('modalContent').innerHTML = html;
            loadClusterSnapshots(cluster.id);
            loadClusterActionTimeline(cluster.id);
        }

        // Follow-up 1: fetch + render the action timeline for the current
        // cluster. Pulls /api/duplicates/merge-history?cluster_id=N — the
        // endpoint and getMergeHistory helper both pre-existed; this is
        // purely a UI surface so the audit trail is one click away from
        // the operator's normal workflow. Silent on errors so a network
        // blip doesn't blank the rest of the modal.
        async function loadClusterActionTimeline(clusterId) {
            const listEl = document.getElementById('clusterActionTimeline');
            if (!listEl || String(listEl.dataset.clusterId) !== String(clusterId)) return;
            try {
                const res = await fetch(`/api/duplicates/merge-history?cluster_id=${encodeURIComponent(clusterId)}&limit=50`);
                if (!res.ok) { listEl.textContent = 'Action timeline unavailable.'; return; }
                const data = await res.json();
                const actions = Array.isArray(data && data.history) ? data.history : [];
                if (actions.length === 0) {
                    listEl.innerHTML = '<span class="text-gray-400 italic">No actions yet — Dismiss, an agentic apply, or a domain-collision merge will log here.</span>';
                    return;
                }
                listEl.innerHTML = '<ul class="divide-y divide-gray-100 border border-gray-100 rounded">' + actions.map(a => renderActionTimelineRow(a)).join('') + '</ul>';
            } catch (e) {
                listEl.textContent = 'Action timeline unavailable.';
            }
        }

        // Visually distinguish actions by type. resolve / ignore are the
        // common operator paths; domain_collision_merge surfaces the
        // collision-triage workflow. Unknown action_type falls back to a
        // neutral chip.
        function actionTimelineChip(actionType) {
            const map = {
                resolve: { label: 'Resolved', cls: 'bg-emerald-100 text-emerald-800' },
                ignore: { label: 'Dismissed', cls: 'bg-gray-100 text-gray-700' },
                auto_merge_pending: { label: 'Auto-merge · pending', cls: 'bg-amber-100 text-amber-800' },
                domain_collision_merge: { label: 'Collision merge', cls: 'bg-indigo-100 text-indigo-700' },
            };
            const m = map[actionType] || { label: String(actionType || '—'), cls: 'bg-gray-100 text-gray-600' };
            return `<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${m.cls}">${escapeHtml(m.label)}</span>`;
        }

        function renderActionTimelineRow(a) {
            const when = formatDate(a.created_at || a.performed_at);
            const who = escapeHtml(a.performed_by || 'system');
            const chip = actionTimelineChip(a.action_type);
            const primaryId = a.primary_record_id != null
                ? `primary #${escapeHtml(String(a.primary_record_id))}`
                : 'no primary set';
            let mergedCount = 0;
            try {
                const ids = typeof a.merged_record_ids === 'string' ? JSON.parse(a.merged_record_ids) : a.merged_record_ids;
                if (Array.isArray(ids)) mergedCount = ids.length;
            } catch { mergedCount = 0; }
            const notesPart = a.notes
                ? `<div class="text-[11px] text-gray-500 mt-1">${escapeHtml(a.notes)}</div>`
                : '';
            return `<li class="px-3 py-2">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="text-xs text-gray-700">${chip} · ${when} · by ${who}</div>
                        <div class="text-[11px] text-gray-500">${primaryId} · ${mergedCount} record${mergedCount === 1 ? '' : 's'} affected</div>
                    </div>
                </div>
                ${notesPart}
            </li>`;
        }

        // R10: fetch + render the snapshot list for the current cluster.
        // Silent on errors (we don't want a transient network blip to make
        // the whole cluster modal look broken — the section just stays in
        // its placeholder state).
        async function loadClusterSnapshots(clusterId) {
            const listEl = document.getElementById('clusterSnapshotsList');
            if (!listEl || String(listEl.dataset.clusterId) !== String(clusterId)) return;
            try {
                const res = await fetch(`/api/duplicates/clusters/${clusterId}/snapshots`);
                if (!res.ok) { listEl.textContent = 'Snapshots unavailable.'; return; }
                const data = await res.json();
                const snaps = (data && data.snapshots) || [];
                if (snaps.length === 0) {
                    listEl.innerHTML = '<span class="text-gray-400 italic">No snapshots yet — they\'re captured automatically before each agentic apply or domain-collision merge.</span>';
                    return;
                }
                listEl.innerHTML = '<ul class="divide-y divide-gray-100 border border-gray-100 rounded">' + snaps.map(s => {
                    const when = formatDate(s.snapshot_at);
                    const who = escapeHtml(s.taken_by || 'system');
                    // `trig` is already HTML-escaped — interpolate it directly
                    // rather than re-escape, which would turn `&` into
                    // `&amp;amp;` on triggers that contain special chars.
                    const trig = escapeHtml(s.trigger || 'unknown');
                    const cnt = Number(s.record_count || 0);
                    return `<li class="px-3 py-2 flex items-center justify-between gap-3">
                        <div class="flex-1 min-w-0">
                            <div class="text-xs text-gray-700"><span class="font-medium">${trig}</span> · ${when} · by ${who}</div>
                            <div class="text-[11px] text-gray-500">${cnt} record${cnt === 1 ? '' : 's'} frozen${s.notes ? ' · ' + escapeHtml(s.notes) : ''}</div>
                        </div>
                        <button data-on-click="openSnapshotViewer" data-args="[${s.id}]" data-testid="button-view-snapshot-${s.id}" class="px-2 py-1 text-xs font-medium rounded bg-gray-100 hover:bg-gray-200 text-gray-700 whitespace-nowrap">View</button>
                    </li>`;
                }).join('') + '</ul>';
            } catch (e) {
                listEl.textContent = 'Snapshots unavailable.';
            }
        }

        // R10: open the snapshot viewer modal and lazy-fetch the full
        // frozen state. Separate modal (clusterSnapshotModal) layered on
        // top of the cluster modal so the operator can keep both views
        // available side-by-side.
        async function openSnapshotViewer(snapshotId) {
            const m = document.getElementById('clusterSnapshotModal');
            const body = document.getElementById('clusterSnapshotBody');
            if (!m || !body) return;
            m.classList.remove('hidden');
            body.innerHTML = `<div class="text-center text-gray-400 py-8">Loading snapshot…</div>`;
            try {
                const res = await fetch(`/api/duplicates/snapshots/${snapshotId}`);
                if (!res.ok) {
                    body.innerHTML = `<div class="text-center text-red-600 py-6 text-sm">Server returned ${res.status} for snapshot ${escapeHtml(String(snapshotId))}.</div>`;
                    return;
                }
                const data = await res.json();
                const s = data && data.snapshot;
                if (!s) {
                    body.innerHTML = `<div class="text-center text-red-600 py-6 text-sm">Snapshot not found.</div>`;
                    return;
                }
                renderSnapshotDetail(s);
            } catch (e) {
                body.innerHTML = `<div class="text-center text-red-600 py-6 text-sm">Failed to load snapshot: ${escapeHtml(String(e && e.message || e))}</div>`;
            }
        }
        function closeSnapshotViewer() {
            const m = document.getElementById('clusterSnapshotModal');
            if (m) m.classList.add('hidden');
        }
        function renderSnapshotDetail(s) {
            const body = document.getElementById('clusterSnapshotBody');
            if (!body) return;
            const meta = `<div class="bg-amber-50 border border-amber-200 rounded p-3 mb-4 text-xs text-amber-900">
                <div class="font-semibold mb-1">Forensic snapshot — read-only frozen state</div>
                <div>Trigger: <span class="font-medium">${escapeHtml(s.trigger || '—')}</span> · Captured: ${formatDate(s.snapshot_at)} · By: ${escapeHtml(s.taken_by || 'system')}</div>
                ${s.notes ? '<div class="opacity-80 mt-1">' + escapeHtml(s.notes) + '</div>' : ''}
            </div>`;
            const cluster = s.cluster_snapshot || {};
            const records = Array.isArray(s.records_snapshot) ? s.records_snapshot : [];
            const clusterFacts = `<div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 text-xs">
                ${[
                    ['Cluster ID', cluster.id],
                    ['Domain', cluster.domain],
                    ['Company', cluster.company_name],
                    ['Confidence', (cluster.confidence_score || 0) + '%'],
                    ['Status at snapshot', cluster.status],
                    ['Total records', cluster.total_records],
                ].map(([k, v]) => `<div><div class="text-gray-500">${escapeHtml(k)}</div><div class="font-medium text-gray-800">${escapeHtml(String(v ?? '—'))}</div></div>`).join('')}
            </div>`;
            const rowsHtml = records.length === 0
                ? '<div class="text-xs text-gray-400 italic">No records were attached to this cluster at snapshot time.</div>'
                : '<div class="overflow-x-auto"><table class="min-w-full text-xs border border-gray-200"><thead class="bg-gray-50"><tr>'
                    + ['Zoho ID','Type','Name','Company','Owner','Status/Stage','Primary'].map(h => `<th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">${escapeHtml(h)}</th>`).join('')
                    + '</tr></thead><tbody>'
                    + records.map(r => {
                        const rt = (r.record_type || '').toLowerCase();
                        const tab = rt === 'lead' ? 'Leads'
                                  : rt === 'deal' ? 'Potentials'
                                  : rt === 'contact' ? 'Contacts'
                                  : rt === 'account' ? 'Accounts'
                                  : null;
                        const idCell = (r.zoho_record_id && tab)
                            ? `<td class="px-2 py-1">${zohoLink(r.zoho_record_id, tab)}</td>`
                            : `<td class="px-2 py-1 font-mono text-gray-400">${escapeHtml(r.zoho_record_id || '—')}</td>`;
                        return `<tr class="border-t border-gray-100">${idCell}<td class="px-2 py-1">${escapeHtml(r.record_type || '—')}</td><td class="px-2 py-1">${escapeHtml(r.record_name || '—')}</td><td class="px-2 py-1 text-gray-600">${escapeHtml(r.company_name || '—')}</td><td class="px-2 py-1 text-gray-600">${escapeHtml(r.owner_name || '—')}</td><td class="px-2 py-1 text-gray-600">${escapeHtml(r.status || r.stage || '—')}</td><td class="px-2 py-1">${r.is_primary ? '<span class="text-green-700 font-medium">Yes</span>' : '<span class="text-gray-400">No</span>'}</td></tr>`;
                    }).join('')
                    + '</tbody></table></div>';
            body.innerHTML = meta + clusterFacts + '<h4 class="text-sm font-semibold text-gray-700 mb-2">Records (frozen)</h4>' + rowsHtml;
        }

        async function splitClusterByDomain(clusterId) {
            const mixed = window.__currentMixedSignal || { domains: [] };
            if (!mixed.domains || mixed.domains.length < 2) {
                alert('This cluster has only one corporate domain — nothing to split.');
                return;
            }
            const sorted = [...mixed.domains].sort((a, b) => {
                const la = (mixed.domain_groups[a] || []).length;
                const lb = (mixed.domain_groups[b] || []).length;
                return lb - la;
            });
            const keep = sorted[0];
            const moveOut = sorted.slice(1);
            const summary =
                `Split this cluster by email domain?\n\n` +
                `KEEP in this cluster:\n  • ${keep} (${(mixed.domain_groups[keep] || []).length} record(s))\n\n` +
                `MOVE to new cluster(s):\n` +
                moveOut
                    .map(d => `  • ${d} (${(mixed.domain_groups[d] || []).length} record(s))`)
                    .join('\n') +
                `\n\nThis cannot be undone automatically (you'd have to re-scan or merge them back manually).`;
            if (!confirm(summary)) return;

            const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
            if (!adminKey) return;

            try {
                const res = await fetch(`/api/duplicates/clusters/${clusterId}/split`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                    body: JSON.stringify({ mode: 'by_domain' })
                });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    alert(data.error || 'Split failed.');
                    return;
                }
                alert(`Split complete: ${data.split_count} new cluster(s) created.`);
                closeModal();
                refreshData();
            } catch (e) {
                alert('Network error during split.');
            }
        }

        // Type-chip filter for the cluster comparison matrix. Each record
        // column is tagged data-rc-type; clicking a chip hides every column
        // whose type != selected (the "Field" label column has no data-rc-type,
        // so it always stays). "all" shows everything. CSP-safe (no inline JS).
        function filterClusterComparison(type) {
            const root = document.getElementById('clusterComparison');
            if (root) {
                root.querySelectorAll('[data-rc-type]').forEach(el => {
                    const hide = type && type !== 'all' && el.getAttribute('data-rc-type') !== type;
                    el.classList.toggle('hidden', hide);
                });
            }
            document.querySelectorAll('[data-cluster-chip]').forEach(chip => {
                const active = chip.getAttribute('data-cluster-chip') === (type || 'all');
                chip.classList.toggle('ring-2', active);
                chip.classList.toggle('ring-purple-600', active);
                chip.classList.toggle('font-bold', active);
            });
        }

        // ── Phase 1 Agentic Duplicate Resolution — read-only plan preview ──────
        // Invoked via data-on-click="previewMergePlan". POSTs the read-only
        // /plan endpoint and renders the proposed merge plan into #mergePlanPanel.
        // Performs NO writes; the destructive execute path is built separately.
        // Per-module plan state: { [module]: { selected, master } }. Keyed by
        // module so one cluster modal can host several module sections at once.
        window.__planState = window.__planState || {};
        function _planSt(module) {
            window.__planState[module] = window.__planState[module] || { selected: null, master: null };
            return window.__planState[module];
        }
        // From a per-module tab group's "🔍 Resolve with AI" button: open the
        // group's cluster modal and auto-preview that module's Agentic plan.
        // The cluster may hold more records than the on-page group — use the
        // plan's checkboxes to pick exactly which to merge.
        async function resolveGroupWithAI(module, clusterId, groupZohoIds) {
            if (!clusterId) {
                alert('This group has no cluster id yet — run a scan first, then try again.');
                return;
            }
            try { await showClusterDetails(clusterId); } catch (_) { /* modal still opens */ }
            // Modal now has an "Agentic Resolution — <module>" section
            // (#mergePlanPanel-<module>) when the cluster has >=2 of that module.
            try { await previewMergePlan(module, clusterId, groupZohoIds); } catch (_) { /* user can click Preview */ }
        }

        async function previewMergePlan(module, clusterId, seedZohoIds) {
            const panel = document.getElementById('mergePlanPanel-' + module);
            if (!panel) return;
            // Reset all module selections when previewing a different cluster.
            if (window.__planClusterId !== clusterId) {
                window.__planState = {};
                window.__planClusterId = clusterId;
            }
            const st = _planSt(module);
            // First open from a tab group: scope the plan to exactly that sub-group's
            // records (seedZohoIds) instead of the whole cluster. Only on a fresh
            // open (st.selected not set yet) so re-previews after the operator
            // ticks/unticks keep their own selection.
            if (Array.isArray(seedZohoIds) && seedZohoIds.length >= 2 && !Array.isArray(st.selected)) {
                st.selected = seedZohoIds.map(String);
            }
            panel.innerHTML = '<div class="py-4 text-gray-400">Building plan…</div>';
            const reqBody = { module: module };
            if (Array.isArray(st.selected)) reqBody.record_zoho_ids = st.selected;
            if (st.master) reqBody.master_zoho_id = st.master;
            if (st.linkAccount !== undefined) reqBody.link_account_zoho_id = st.linkAccount;
            let res, data;
            try {
                res = await fetch('/api/duplicates/clusters/' + encodeURIComponent(clusterId) + '/plan', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody),
                });
            } catch (e) {
                panel.innerHTML = '<div class="py-3 text-red-600 text-sm">Failed to reach server: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                return;
            }
            try { data = await res.json(); } catch (_) { data = null; }
            if (!res.ok || !data || !data.plan) {
                const msg = (data && data.error) ? data.error : ('Server returned ' + (res ? res.status : '—'));
                panel.innerHTML = '<div class="py-3 text-amber-700 text-sm">' + escapeHtml(msg) + '</div>';
                return;
            }
            // Sync selection state to what the plan actually included, so the
            // checkboxes and subsequent dry-run/apply stay consistent.
            st.selected = (data.plan.records || []).filter(r => r.included && r.zohoId).map(r => r.zohoId);
            st.planRecords = data.plan.records || []; // for the Split action (zohoId → dbId)
            panel.innerHTML = __renderMergePlan(data.plan);
            // Middle-column lazy fill — three flavours:
            //   Contacts → "Account" column reads from the planner; no fetch.
            //   Accounts → "Deals" count column → /deal-counts (more useful
            //              survivor signal than 📎 attachments).
            //   Leads / Deals → 📎 attachments (as before).
            if (data.plan.module === 'Accounts') {
                loadAccountDealCounts(data.plan.clusterId);
            } else if (data.plan.module === 'Leads') {
                // Deals now show the Stage (from the plan, synchronously) instead
                // of attachments, so only Leads still fetch the 📎 chips.
                loadAttachmentChips(data.plan.module, data.plan.clusterId);
            }
            // Reparent preview — Accounts/Contacts merges repoint child
            // Deals/Contacts onto the survivor. Fetch the count separately
            // so the plan render isn't blocked on Zoho calls.
            if (data.plan.module === 'Accounts' || data.plan.module === 'Contacts') {
                loadReparentPreview(data.plan.module, data.plan.clusterId);
            }
        }

        // Bulk-split bad Contact clusters — one-shot cleanup that applies
        // the ≥2-attribute rule retroactively to today's already-bad
        // clusters. Always runs DRY-RUN first; only after the user accepts
        // the preview does a second call with confirm=true write to the DB.
        // Idempotent on re-run: clusters already split won't change again.
        async function bulkSplitContacts() {
            const panel = document.getElementById('bulkSplitContactsPanel');
            const btn = document.getElementById('bulkSplitContactsBtn');
            if (btn) btn.disabled = true;
            panel.innerHTML = '<div class="text-violet-700">Computing dry-run plan…</div>';

            const callApi = async (confirmFlag, limitOverride) => {
                const res = await fetch('/api/duplicates/bulk-split-contacts', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirm: !!confirmFlag, limit: limitOverride || 500 }),
                });
                const j = await res.json().catch(() => null);
                return { ok: res.ok, status: res.status, data: j };
            };

            let preview;
            try {
                preview = await callApi(false);
            } catch (e) {
                panel.innerHTML = '<div class="text-red-600">Failed to reach server: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            if (!preview.ok || !preview.data) {
                panel.innerHTML = '<div class="text-amber-700">' + escapeHtml((preview.data && preview.data.error) || ('Server returned ' + preview.status)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            const p = preview.data;
            if (p.clustersSplit === 0) {
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800">Nothing to split — every active Contact cluster already passes the ≥2-attribute rule.</div>';
                if (btn) btn.disabled = false;
                return;
            }
            const examples = (p.perCluster || []).filter(r => r.split_out > 0).slice(0, 5).map(r =>
                'Cluster #' + r.cluster_id + ': ' + r.contacts + ' contacts → ' + r.components + ' groups (split out ' + r.split_out + ')'
            ).join('<br>');
            const planMsg = 'DRY-RUN plan:\\n\\n'
                + '• ' + p.clustersInspected + ' contact cluster(s) inspected\\n'
                + '• ' + p.clustersSplit + ' will be split\\n'
                + '• ' + p.recordsMoved + ' contact record(s) will move\\n'
                + '• ' + p.newClustersCreated + ' new cluster(s) will be created\\n\\n'
                + 'Apply for real?';
            panel.innerHTML = '<div class="px-3 py-2 rounded bg-violet-50 border border-violet-200 text-violet-900">'
                + '<strong>Dry-run:</strong> ' + p.clustersSplit + ' cluster(s) would split · ' + p.recordsMoved + ' contact(s) would move · ' + p.newClustersCreated + ' new cluster(s).<br>'
                + '<span class="text-xs text-violet-700">' + examples + (p.perCluster.filter(r => r.split_out > 0).length > 5 ? '<br>…' : '') + '</span>'
                + '</div>';
            const confirmed = window.confirm(planMsg);
            if (!confirmed) { if (btn) btn.disabled = false; return; }
            // Apply in SMALL BATCHES, not one giant request. Splitting 500
            // clusters in a single call exceeds the proxy's request timeout
            // (504 "Gateway Timeout") and the UI hangs on "Applying…" with no
            // feedback. The endpoint is idempotent — each call re-selects the
            // clusters that STILL violate the rule — so we loop with a small
            // limit until a batch splits nothing, showing live progress. A
            // batch that errors pauses gracefully (re-runnable, no data loss).
            panel.insertAdjacentHTML('beforeend',
                '<div id="bulkSplitProgress" class="text-violet-700 mt-1">Applying… 0 cluster(s) split so far</div>');
            const progressEl = document.getElementById('bulkSplitProgress');
            const BATCH = 10;       // clusters per request — safe under the gateway timeout
            const MAX_ITERS = 2000; // runaway backstop
            let totalSplit = 0, totalMoved = 0, totalNew = 0, iter = 0;
            while (iter++ < MAX_ITERS) {
                let r;
                try { r = await callApi(true, BATCH); }
                catch (e) {
                    progressEl.innerHTML = '<span class="text-amber-700">Apply paused (network): ' + escapeHtml(String(e && e.message || e))
                        + ' — ' + totalSplit + ' cluster(s) split so far. Click Bulk-split again to resume the rest.</span>';
                    if (btn) btn.disabled = false;
                    return;
                }
                if (!r.ok || !r.data) {
                    progressEl.innerHTML = '<span class="text-amber-700">Apply paused: ' + escapeHtml((r.data && r.data.error) || ('Server returned ' + r.status))
                        + ' — ' + totalSplit + ' cluster(s) split so far. Click Bulk-split again to resume the rest.</span>';
                    if (btn) btn.disabled = false;
                    return;
                }
                const d = r.data;
                totalSplit += (d.clustersSplit || 0);
                totalMoved += (d.recordsMoved || 0);
                totalNew += (d.newClustersCreated || 0);
                progressEl.textContent = 'Applying… ' + totalSplit + ' cluster(s) split, ' + totalMoved + ' contact(s) moved…';
                // A batch that splits nothing means there's nothing left that
                // can be split (done, or the remainder keeps failing) — stop.
                if ((d.clustersSplit || 0) === 0) break;
            }
            progressEl.outerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 mt-1">'
                + '<strong>Done.</strong> Split ' + totalSplit + ' cluster(s), moved ' + totalMoved + ' contact(s), created ' + totalNew + ' new cluster(s). Reloading list…'
                + '</div>';
            // Auto-reload the Contact Duplicates list so the operator sees
            // the recompacted page immediately — no manual refresh needed.
            try {
                if (typeof loadRecordTab === 'function') {
                    const currentPage = (typeof recordPages !== 'undefined' && recordPages.contacts) || 0;
                    loadRecordTab('contacts', currentPage);
                }
            } catch (_) { /* non-fatal */ }
            if (btn) btn.disabled = false;
        }

        // Run a bulk-merge endpoint in SMALL BATCHES so a large run can't hit
        // the proxy's request timeout (504 "Gateway Timeout"). The endpoints are
        // idempotent and return `remaining`, so we loop until nothing is left
        // (or a batch makes no progress). Accumulates numeric result fields.
        // onTick(totals, lastBatch) renders running progress.
        async function _runBatchedMerge(url, opts) {
            const totals = {};
            let iter = 0;
            const MAX = 5000;
            while (iter++ < MAX) {
                const res = await fetch(url, {
                    method: 'POST', credentials: 'same-origin',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.key ? { 'x-admin-key': opts.key } : {}),
                    body: JSON.stringify(Object.assign({ limit: opts.batchLimit }, opts.body || {})),
                });
                const d = await res.json().catch(function () { return {}; });
                if (!res.ok || !d.success) throw new Error((d && d.error) || ('HTTP ' + res.status));
                for (const k in d) { if (typeof d[k] === 'number' && k !== 'remaining') totals[k] = (totals[k] || 0) + d[k]; }
                totals.remaining = d.remaining || 0;
                if (opts.onTick) opts.onTick(totals, d);
                const progressed = (opts.progressKeys || ['merged', 'mergedGroups']).some(function (k) { return (d[k] || 0) > 0; });
                if (!d.remaining || d.remaining <= 0) break;
                if (!progressed) break; // can't advance (e.g. every group erroring) — stop
            }
            return totals;
        }

        // Bulk auto-merge contacts where Email AND Phone match 100% (Sarah 2026-06-20).
        // Preview count first (read-only), then admin-password apply (tags the
        // duplicates Duplicate-Delete, keeps the most complete survivor).
        // ── Shared contact-merge drill-in (exact email+phone AND name+phone) ──
        // Each preview group is expandable: every contact with a completion %,
        // the most-complete proposed as survivor; click a row to override which
        // contact is KEPT. The override travels to the backend on Apply.
        function toggleContactGroup(gi) {
            const detail = document.getElementById('ctcgrp-detail-' + gi);
            const caret = document.getElementById('ctcgrp-caret-' + gi);
            if (!detail) return;
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : '';
            if (caret) caret.textContent = open ? '▸' : '▾';
        }
        function setContactSurvivor(gi, zohoId) {
            const g = (window._contactMergeGroups || [])[gi];
            if (!g) return;
            if (g._excluded && g._excluded[zohoId]) return; // an excluded contact can't be the survivor
            window._contactMergeOverrides = window._contactMergeOverrides || {};
            const def = (g.members.find(function (m) { return m.isSurvivor; }) || {}).zohoId;
            if (zohoId === def) { delete window._contactMergeOverrides[g.key]; }
            else { window._contactMergeOverrides[g.key] = zohoId; }
            document.querySelectorAll('.ctcgrp-radio-' + gi).forEach(function (el) {
                const on = el.getAttribute('data-mid') === zohoId;
                el.textContent = on ? '●' : '○';
                el.className = 'ctcgrp-radio-' + gi + ' ' + (on ? 'text-emerald-600' : 'text-gray-300');
            });
            document.querySelectorAll('.ctcgrp-badge-' + gi).forEach(function (el) {
                const on = el.getAttribute('data-mid') === zohoId;
                el.innerHTML = on ? '<span class="text-[9px] bg-emerald-100 text-emerald-800 px-1 rounded">SURVIVOR</span>' : '';
            });
            document.querySelectorAll('.ctcgrp-member-' + gi).forEach(function (tr) {
                tr.classList.toggle('bg-emerald-50', tr.getAttribute('data-mid') === zohoId);
            });
            const chosen = g.members.find(function (m) { return m.zohoId === zohoId; });
            if (chosen) {
                const nm = document.getElementById('ctcgrp-survname-' + gi);
                if (nm) nm.textContent = chosen.name || '—';
                const pc = document.getElementById('ctcgrp-survpct-' + gi);
                if (pc) pc.textContent = (chosen.completionPct != null ? chosen.completionPct + '%' : '—');
            }
        }
        function _contactOverridesAll() {
            const out = {};
            const ov = window._contactMergeOverrides || {};
            (window._contactMergeGroups || []).forEach(function (g) { if (!g._excluded || !g._excluded[ov[g.key]]) { if (ov[g.key]) out[g.key] = ov[g.key]; } });
            return out;
        }
        // Toggle a single contact in/out of its group's merge. An EXCLUDED contact
        // is left completely untouched; the rest still merge. If the excluded one
        // was the survivor, the survivor moves to the next included (most-complete).
        function toggleContactMemberInclude(gi, zohoId) {
            const g = (window._contactMergeGroups || [])[gi];
            if (!g) return;
            g._excluded = g._excluded || {};
            const nowExcluded = !g._excluded[zohoId];
            if (nowExcluded) g._excluded[zohoId] = true; else delete g._excluded[zohoId];
            document.querySelectorAll('.ctcgrp-incl-' + gi).forEach(function (el) {
                if (el.getAttribute('data-mid') !== zohoId) return;
                el.textContent = nowExcluded ? '☐' : '☑';
                el.className = 'ctcgrp-incl-' + gi + ' cursor-pointer ' + (nowExcluded ? 'text-gray-300' : 'text-emerald-600');
            });
            document.querySelectorAll('.ctcgrp-member-' + gi).forEach(function (tr) {
                if (tr.getAttribute('data-mid') === zohoId) {
                    tr.classList.toggle('opacity-40', nowExcluded);
                    tr.classList.toggle('line-through', nowExcluded);
                }
            });
            const cur = (window._contactMergeOverrides && window._contactMergeOverrides[g.key]) || (g.members.find(function (m) { return m.isSurvivor; }) || {}).zohoId;
            if (nowExcluded && zohoId === cur) {
                const next = g.members.find(function (m) { return !g._excluded[m.zohoId]; });
                if (next) setContactSurvivor(gi, next.zohoId);
            }
        }
        function _contactExcludesAll() {
            const out = {};
            (window._contactMergeGroups || []).forEach(function (g) {
                if (g._excluded) {
                    const ids = Object.keys(g._excluded);
                    if (ids.length) out[g.key] = ids;
                }
            });
            return out;
        }
        function _renderContactMergeGroups(sample) {
            return (sample || []).map(function (g) {
                const gi = window._contactMergeGroups.length;
                window._contactMergeGroups.push({ key: g.key, survivorZohoId: g.survivorZohoId, members: g.members || [] });
                const survivor = (g.members || []).find(function (m) { return m.isSurvivor; }) || (g.members || [])[0] || {};
                const signal = (g.email ? '✉ ' + g.email : '') + (g.email && g.phone ? ' · ' : '') + (g.phone ? '☎ ' + g.phone : '');
                const headRow = '<tr class="border-t hover:bg-emerald-50 cursor-pointer" data-on-click="toggleContactGroup" data-args=\'[' + gi + ']\'>'
                    + '<td class="px-2 py-1"><span id="ctcgrp-caret-' + gi + '" class="text-gray-400 me-1">▸</span><span id="ctcgrp-survname-' + gi + '">' + escapeHtml(survivor.name || g.label || '—') + '</span></td>'
                    + '<td class="px-2 py-1 text-[10px] text-gray-500">' + escapeHtml(signal || '—') + '</td>'
                    + '<td class="px-2 py-1 text-center">' + ((g.members || []).length) + '</td>'
                    + '<td class="px-2 py-1 text-center"><span id="ctcgrp-survpct-' + gi + '" class="text-[11px] font-semibold text-emerald-700">' + (survivor.completionPct != null ? survivor.completionPct + '%' : '—') + '</span></td>'
                    + '</tr>';
                const memberRows = (g.members || []).map(function (m) {
                    const created = m.createdMs ? new Date(m.createdMs * 1000).toISOString().slice(0, 10) : '—';
                    return '<tr class="border-t ctcgrp-member-' + gi + ' ' + (m.isSurvivor ? 'bg-emerald-50' : '') + '" data-mid="' + escapeHtml(m.zohoId) + '" data-on-click="setContactSurvivor" data-args=\'[' + gi + ',"' + escapeHtml(m.zohoId) + '"]\' style="cursor:pointer">'
                        + '<td class="px-2 py-1 text-center"><span class="ctcgrp-incl-' + gi + ' text-emerald-600 cursor-pointer" data-mid="' + escapeHtml(m.zohoId) + '" data-on-click="toggleContactMemberInclude" data-args=\'[' + gi + ',"' + escapeHtml(m.zohoId) + '"]\' title="Included in the merge — click to EXCLUDE (leave this contact untouched)">☑</span></td>'
                        + '<td class="px-2 py-1"><span class="ctcgrp-radio-' + gi + ' ' + (m.isSurvivor ? 'text-emerald-600' : 'text-gray-300') + '" data-mid="' + escapeHtml(m.zohoId) + '">' + (m.isSurvivor ? '●' : '○') + '</span></td>'
                        + '<td class="px-2 py-1">' + escapeHtml(m.name || '—') + ' <span class="ctcgrp-badge-' + gi + '" data-mid="' + escapeHtml(m.zohoId) + '">' + (m.isSurvivor ? '<span class="text-[9px] bg-emerald-100 text-emerald-800 px-1 rounded">SURVIVOR</span>' : '') + '</span></td>'
                        + '<td class="px-2 py-1 font-mono text-[10px] text-gray-600">' + escapeHtml(m.email || '—') + '</td>'
                        + '<td class="px-2 py-1 font-mono text-[10px] text-gray-600">' + escapeHtml(m.phone || '—') + '</td>'
                        + '<td class="px-2 py-1 text-gray-600">' + escapeHtml(m.account || '—') + '</td>'
                        + '<td class="px-2 py-1 text-gray-600">' + escapeHtml(m.owner || '—') + '</td>'
                        + '<td class="px-2 py-1 text-gray-500 text-[10px]">' + escapeHtml(m.layout || '—') + '</td>'
                        + '<td class="px-2 py-1"><div class="flex items-center gap-1"><div class="w-14 h-1.5 bg-gray-200 rounded"><div class="h-1.5 rounded bg-emerald-500" style="width:' + (m.completionPct || 0) + '%"></div></div><span class="text-[10px] text-gray-600">' + (m.completionPct || 0) + '% (' + (m.fieldsPopulated || 0) + '/' + (m.fieldsTotal || 0) + ')</span></div></td>'
                        + '</tr>';
                }).join('');
                const detail = '<tr id="ctcgrp-detail-' + gi + '" style="display:none"><td colspan="4" class="px-2 pb-2 bg-gray-50">'
                    + '<div class="text-[10px] text-gray-500 mt-1 mb-1">Click a row to KEEP that contact as the survivor (● = most complete). Untick <strong>Merge?</strong> to EXCLUDE a contact (e.g. a Partner) — it stays untouched and the rest still merge. The non-survivor included contacts are tagged Duplicate-Delete; their email(s) are preserved on the survivor.</div>'
                    + '<table class="w-full text-xs"><thead><tr class="text-gray-400"><th class="px-2 py-1 text-start">Merge?</th><th class="px-2 py-1 text-start">Keep</th><th class="px-2 py-1 text-start">Contact</th><th class="px-2 py-1 text-start">Email</th><th class="px-2 py-1 text-start">Phone</th><th class="px-2 py-1 text-start">Account</th><th class="px-2 py-1 text-start">Owner</th><th class="px-2 py-1 text-start">Layout</th><th class="px-2 py-1 text-start">Completion</th></tr></thead><tbody>' + memberRows + '</tbody></table>'
                    + '</td></tr>';
                return headRow + detail;
            }).join('');
        }

        // ONE-CLICK "Apply all safe merges": loops /api/duplicates/apply-all-safe
        // until there's nothing left to merge, behind a SINGLE admin password.
        // Runs the same conservative rules as the individual buttons (accounts
        // domain+name, contacts exact email+phone, contacts same name+phone).
        async function applyAllSafeMerges() {
            const panel = document.getElementById('applyAllSafePanel');
            const btn = document.getElementById('applyAllSafeBtn');
            if (!confirm('Apply ALL safe auto-merges now?\n\n• Accounts: same domain + same name\n• Contacts: exact email+phone, then same name+phone\n\nThese are the same conservative rules as the individual buttons — the survivor is kept, the rest are tagged "Duplicate-Delete" for the admin to delete. NOTHING is deleted by the platform.\n\nRuns in batches behind one admin password; you can stop by leaving the page.')) return;
            if (btn) btn.disabled = true;
            let adminKey = null;
            const totals = { acctMerged: 0, acctTagged: 0, contactsTagged: 0, errors: 0, passes: 0 };
            const render = (msg, tone) => { if (panel) panel.innerHTML = '<div class="' + (tone || 'text-emerald-700') + '">' + msg + '</div>'; };
            render('Starting…');
            try {
                for (let pass = 0; pass < 500; pass++) {
                    const headers = { 'Content-Type': 'application/json' };
                    if (adminKey) headers['x-admin-key'] = adminKey;
                    let res = await fetch('/api/duplicates/apply-all-safe', {
                        method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ limit: 15 })
                    });
                    if (res.status === 401 || res.status === 403) {
                        adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                        if (!adminKey) { render('Cancelled.', 'text-gray-500'); break; }
                        continue; // retry this pass with the key
                    }
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok || !data.success) { render('Stopped on error: ' + escapeHtml(String((data && data.error) || ('HTTP ' + res.status))), 'text-red-600'); break; }
                    totals.acctMerged += (data.accounts && data.accounts.merged) || 0;
                    totals.acctTagged += (data.accounts && data.accounts.accountsTagged) || 0;
                    totals.contactsTagged += ((data.exactContacts && data.exactContacts.taggedRecords) || 0) + ((data.namePhoneContacts && data.namePhoneContacts.taggedRecords) || 0);
                    totals.errors += ((data.accounts && data.accounts.errors) || 0) + ((data.exactContacts && data.exactContacts.errors) || 0) + ((data.namePhoneContacts && data.namePhoneContacts.errors) || 0);
                    totals.passes++;
                    render('Working… batch ' + totals.passes + ' · ' + totals.acctMerged.toLocaleString() + ' account(s) merged · ' + totals.contactsTagged.toLocaleString() + ' contact duplicate(s) tagged' + (data.remaining ? ' · ~' + Number(data.remaining).toLocaleString() + ' remaining' : ''));
                    if (!data.more) break;
                }
                const tone = totals.errors > 0 ? 'text-amber-700' : 'text-emerald-800';
                render('✓ Done — ' + totals.acctMerged.toLocaleString() + ' account(s) merged, ' + totals.contactsTagged.toLocaleString() + ' contact duplicate(s) tagged across ' + totals.passes + ' batch(es)' + (totals.errors > 0 ? ' · ' + totals.errors + ' error(s) (re-run to retry)' : '') + '. Tagged records await the Zoho admin delete; nothing was deleted by the platform.', tone);
            } catch (e) {
                render('Stopped: ' + escapeHtml(String(e && e.message || e)), 'text-red-600');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function bulkMergeExactContacts() {
            const panel = document.getElementById('bulkMergeExactPanel');
            const btn = document.getElementById('bulkMergeExactBtn');
            if (btn) btn.disabled = true;
            panel.innerHTML = '<div class="text-emerald-700">Finding exact email+phone matches…</div>';
            let preview;
            try {
                const res = await fetch('/api/duplicates/contacts/exact-match-preview', { credentials: 'same-origin' });
                preview = await res.json();
                if (!res.ok || !preview.success) throw new Error((preview && preview.error) || ('HTTP ' + res.status));
            } catch (e) {
                panel.innerHTML = '<div class="text-red-600">Preview failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            if (!preview.qualifyingGroups) {
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800">No exact email+phone matches found — nothing to auto-merge.</div>';
                if (btn) btn.disabled = false;
                return;
            }
            window._contactMergeGroups = [];
            window._contactMergeOverrides = {};
            const list = _renderContactMergeGroups(preview.sample);
            panel.innerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-900">'
                + '<strong>' + preview.qualifyingGroups.toLocaleString() + '</strong> group(s) match exactly on email + phone · <strong>'
                + preview.duplicatesToTag.toLocaleString() + '</strong> contact(s) would be tagged Duplicate-Delete (the most complete is kept) · <strong>'
                + (preview.numbersPreserved || 0).toLocaleString() + '</strong> survivor(s) keep an extra number. <span class="text-[10px] text-emerald-700">Click a group to verify / change its survivor.</span>'
                + list
                + (preview.qualifyingGroups > (preview.sample || []).length ? '<div class="text-[10px] text-gray-500 mt-1">… showing ' + (preview.sample || []).length + ' of ' + preview.qualifyingGroups + ' groups.</div>' : '')
                + '<div><button data-on-click="applyExactContactsNow" class="mt-2 px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">⚡ Apply these ' + preview.qualifyingGroups.toLocaleString() + ' merge(s) (admin)</button></div></div>';
            if (btn) btn.disabled = false;
        }

        async function applyExactContactsNow() {
            const panel = document.getElementById('bulkMergeExactPanel');
            const key = window.prompt('Enter the admin password to apply this bulk merge:');
            if (!key || !key.trim()) return;
            const overrides = _contactOverridesAll();
            const excludes = _contactExcludesAll();
            const ovN = Object.keys(overrides).length;
            const exN = Object.keys(excludes).reduce(function (n, k) { return n + excludes[k].length; }, 0);
            const prog = document.createElement('div'); prog.className = 'text-emerald-700 mt-1';
            prog.textContent = 'Applying…' + (ovN ? ' (' + ovN + ' survivor override' + (ovN === 1 ? '' : 's') + ')' : '') + (exN ? ' (' + exN + ' excluded)' : ''); panel.appendChild(prog);
            let live;
            try {
                live = await _runBatchedMerge('/api/duplicates/contacts/exact-match-merge', {
                    key: key.trim(), batchLimit: 50, body: { overrides: overrides, excludes: excludes }, progressKeys: ['mergedGroups'],
                    onTick: function (t) { prog.textContent = 'Applying… merged ' + (t.mergedGroups || 0).toLocaleString() + ' group(s), tagged ' + (t.taggedRecords || 0).toLocaleString() + ' contact(s)…'; },
                });
            } catch (e) {
                prog.innerHTML = '<span class="text-amber-700">Apply paused: ' + escapeHtml(String(e && e.message || e)) + ' — click Apply again to resume.</span>';
                return;
            }
            prog.outerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 mt-1">'
                + '<strong>Done.</strong> Merged ' + (live.mergedGroups || 0).toLocaleString() + ' group(s), tagged ' + (live.taggedRecords || 0).toLocaleString() + ' contact(s) Duplicate-Delete.'
                + (live.errors > 0 ? ' (' + live.errors + ' group error(s) — re-run to retry.)' : ' All exact matches handled.')
                + '</div>';
            try {
                if (typeof loadRecordTab === 'function') {
                    const currentPage = (typeof recordPages !== 'undefined' && recordPages.contacts) || 0;
                    loadRecordTab('contacts', currentPage);
                }
            } catch (_) { /* non-fatal */ }
        }

        // Auto-merge contacts that share the SAME NAME + SAME PHONE (Ahmad
        // 2026-06-22). Same person even when emails differ or one is missing.
        // Preserves both emails on the survivor (primary + Secondary_Email);
        // a single email becomes the primary. Preview → admin password → apply.
        async function bulkMergeNamePhoneContacts() {
            const panel = document.getElementById('bulkMergeNamePhonePanel');
            const btn = document.getElementById('bulkMergeNamePhoneBtn');
            if (btn) btn.disabled = true;
            panel.innerHTML = '<div class="text-teal-700">Finding same name + phone matches…</div>';
            let preview;
            try {
                const res = await fetch('/api/duplicates/contacts/name-phone-preview', { credentials: 'same-origin' });
                preview = await res.json();
                if (!res.ok || !preview.success) throw new Error((preview && preview.error) || ('HTTP ' + res.status));
            } catch (e) {
                panel.innerHTML = '<div class="text-red-600">Preview failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            if (!preview.qualifyingGroups) {
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-teal-50 border border-teal-200 text-teal-800">No same name + phone matches found — nothing to auto-merge.</div>';
                if (btn) btn.disabled = false;
                return;
            }
            window._contactMergeGroups = [];
            window._contactMergeOverrides = {};
            const list = _renderContactMergeGroups(preview.sample);
            panel.innerHTML = '<div class="px-3 py-2 rounded bg-teal-50 border border-teal-200 text-teal-900">'
                + '<strong>' + preview.qualifyingGroups.toLocaleString() + '</strong> group(s) match on name + phone · <strong>'
                + preview.duplicatesToTag.toLocaleString() + '</strong> contact(s) would be tagged Duplicate-Delete · <strong>'
                + (preview.emailsPreserved || 0).toLocaleString() + '</strong> survivor(s) keep an extra email · <strong>'
                + (preview.numbersPreserved || 0).toLocaleString() + '</strong> survivor(s) keep an extra number. <span class="text-[10px] text-teal-700">Click a group to verify / change its survivor.</span>'
                + list
                + (preview.qualifyingGroups > (preview.sample || []).length ? '<div class="text-[10px] text-gray-500 mt-1">… showing ' + (preview.sample || []).length + ' of ' + preview.qualifyingGroups + ' groups.</div>' : '')
                + '<div><button data-on-click="applyNamePhoneContactsNow" class="mt-2 px-3 py-1.5 text-xs font-bold rounded-lg bg-teal-600 text-white hover:bg-teal-700">⚡ Apply these ' + preview.qualifyingGroups.toLocaleString() + ' merge(s) (admin)</button></div></div>';
            if (btn) btn.disabled = false;
        }

        async function applyNamePhoneContactsNow() {
            const panel = document.getElementById('bulkMergeNamePhonePanel');
            const key = window.prompt('Enter the admin password to apply this bulk merge:');
            if (!key || !key.trim()) return;
            const overrides = _contactOverridesAll();
            const excludes = _contactExcludesAll();
            const ovN = Object.keys(overrides).length;
            const exN = Object.keys(excludes).reduce(function (n, k) { return n + excludes[k].length; }, 0);
            const prog = document.createElement('div'); prog.className = 'text-teal-700 mt-1';
            prog.textContent = 'Applying…' + (ovN ? ' (' + ovN + ' survivor override' + (ovN === 1 ? '' : 's') + ')' : '') + (exN ? ' (' + exN + ' excluded)' : ''); panel.appendChild(prog);
            let live;
            try {
                live = await _runBatchedMerge('/api/duplicates/contacts/name-phone-merge', {
                    key: key.trim(), batchLimit: 25, body: { overrides: overrides, excludes: excludes }, progressKeys: ['mergedGroups'],
                    onTick: function (t) { prog.textContent = 'Applying… merged ' + (t.mergedGroups || 0).toLocaleString() + ' group(s), tagged ' + (t.taggedRecords || 0).toLocaleString() + ', preserved ' + (t.emailsWritten || 0).toLocaleString() + ' email(s)…'; },
                });
            } catch (e) {
                prog.innerHTML = '<span class="text-amber-700">Apply paused: ' + escapeHtml(String(e && e.message || e)) + ' — click Apply again to resume.</span>';
                return;
            }
            prog.outerHTML = '<div class="px-3 py-2 rounded bg-teal-50 border border-teal-200 text-teal-800 mt-1">'
                + '<strong>Done.</strong> Merged ' + (live.mergedGroups || 0).toLocaleString() + ' group(s), tagged ' + (live.taggedRecords || 0).toLocaleString() + ' contact(s) Duplicate-Delete, preserved ' + (live.emailsWritten || 0).toLocaleString() + ' email(s).'
                + (live.errors > 0 ? ' (' + live.errors + ' group error(s) — re-run to retry.)' : ' All name+phone matches handled.')
                + '</div>';
            try {
                if (typeof loadRecordTab === 'function') {
                    const currentPage = (typeof recordPages !== 'undefined' && recordPages.contacts) || 0;
                    loadRecordTab('contacts', currentPage);
                }
            } catch (_) { /* non-fatal */ }
        }

        // Bulk-link the remaining "chained match" colleague clusters to their
        // company Account (Account_Name cascade). Link-only — no tagging, no
        // deletion; clusters with genuine duplicates are skipped server-side.
        async function bulkLinkContactsToAccount() {
            const panel = document.getElementById('bulkLinkContactsPanel');
            const btn = document.getElementById('bulkLinkContactsBtn');
            if (btn) btn.disabled = true;
            panel.innerHTML = '<div class="text-indigo-700">Finding colleagues to link to their Account…</div>';
            let preview;
            try {
                const res = await fetch('/api/duplicates/contacts/link-account-preview', { credentials: 'same-origin' });
                preview = await res.json();
                if (!res.ok || !preview.success) throw new Error((preview && preview.error) || ('HTTP ' + res.status));
            } catch (e) {
                panel.innerHTML = '<div class="text-red-600">Preview failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            if (!preview.clusters) {
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-800">No link candidates — no contacts-only clusters with a single clear Account.</div>';
                if (btn) btn.disabled = false;
                return;
            }
            panel.innerHTML = '<div class="px-3 py-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-900">'
                + '<strong>' + preview.clusters.toLocaleString() + '</strong> cluster(s) · <strong>' + preview.contacts.toLocaleString() + '</strong> contact(s) would be linked to their company Account (Account_Name set; no tagging, no deletion). Clusters with genuine duplicates are skipped — use the merge buttons for those.</div>';
            if (!window.confirm('Bulk-link ' + preview.clusters + ' cluster(s) (' + preview.contacts + ' contact(s)) to their Account?\n\nSets Account_Name on each contact so colleagues roll up under one customer, then resolves the cluster. No tagging, no deletion.\n\nYou will be asked for the admin password next.')) {
                if (btn) btn.disabled = false; return;
            }
            const key = window.prompt('Enter the admin password to apply the bulk link:');
            if (!key || !key.trim()) { if (btn) btn.disabled = false; return; }
            const prog = document.createElement('div'); prog.className = 'text-indigo-700 mt-1'; prog.textContent = 'Linking…'; panel.appendChild(prog);
            let live;
            try {
                live = await _runBatchedMerge('/api/duplicates/contacts/link-account-apply', {
                    key: key.trim(), batchLimit: 25, progressKeys: ['linked'],
                    onTick: function (t) { prog.textContent = 'Linking… ' + (t.linked || 0).toLocaleString() + ' cluster(s), ' + (t.contactsLinked || 0).toLocaleString() + ' contact(s)…'; },
                });
            } catch (e) {
                prog.innerHTML = '<span class="text-amber-700">Link paused: ' + escapeHtml(String(e && e.message || e)) + ' — click again to resume the rest.</span>';
                if (btn) btn.disabled = false; return;
            }
            prog.outerHTML = '<div class="px-3 py-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-800 mt-1">'
                + '<strong>Done.</strong> Linked ' + (live.linked || 0).toLocaleString() + ' cluster(s), ' + (live.contactsLinked || 0).toLocaleString() + ' contact(s) to their Account'
                + (live.skippedHadDuplicates ? '; skipped ' + (live.skippedHadDuplicates).toLocaleString() + ' with genuine duplicates' : '')
                + (live.errors > 0 ? ' (' + live.errors + ' error(s) — re-run to retry.)' : '.')
                + (live.errors > 0 && live.errorSample ? '<div class="text-xs text-red-700 mt-1">First error: ' + escapeHtml(String(live.errorSample)) + '</div>' : '')
                + '</div>';
            try {
                if (typeof loadRecordTab === 'function') {
                    const currentPage = (typeof recordPages !== 'undefined' && recordPages.contacts) || 0;
                    loadRecordTab('contacts', currentPage);
                }
            } catch (_) { /* non-fatal */ }
            if (btn) btn.disabled = false;
        }

        // DRY-RUN preview of the account auto-merge (same domain + same name,
        // within layout). READ-ONLY — nothing is written. Lets the operator
        // validate the rule on real data before the apply step is enabled.
        async function previewAccountAutoMerge(mode) {
            // mode: 'domain' = looser "same domain, any name" (Sarah 2026-06-23);
            // anything else = strict "same domain + same name".
            const amMode = (mode === 'domain') ? 'domain' : 'domain_name';
            window._accountMergeMode = amMode;
            const panel = document.getElementById('accountAutoMergePanel');
            const btn = document.getElementById(amMode === 'domain' ? 'accountDomainOnlyPreviewBtn' : 'accountAutoMergePreviewBtn');
            if (btn) btn.disabled = true;
            panel.innerHTML = '<div class="text-teal-700">Computing dry-run (no changes)…</div>';
            let data;
            try {
                const url = amMode === 'domain'
                    ? '/api/duplicates/accounts/domain-only-preview'
                    : '/api/duplicates/accounts/domain-name-preview';
                const res = await fetch(url, { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                panel.innerHTML = '<div class="text-red-600">Preview failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                if (btn) btn.disabled = false;
                return;
            }
            // Reset the per-session group registry + survivor overrides each
            // time we recompute the preview (stale ids would be meaningless).
            window._accountMergeGroups = [];
            window._accountMergeOverrides = {};
            window._accountMergeScopeCount = {};
            const scopeBlock = (title, scopeKey, s) => {
                if (!s || !s.groups) {
                    return '<div class="px-3 py-2 rounded bg-gray-50 border border-gray-200 text-gray-600 mb-2">' + title + ': no ' + (amMode === 'domain' ? 'same-domain' : 'same domain+name') + ' groups found.</div>';
                }
                const rows = (s.sample || []).map(function (g) {
                    // Register the group by a stable integer index so the click
                    // handlers never have to embed the (Arabic / spaced) key.
                    const gi = window._accountMergeGroups.length;
                    window._accountMergeGroups.push({ scope: scopeKey, key: g.key, label: g.label, survivorZohoId: g.survivorZohoId, members: g.members || [] });
                    const others = (g.names || []).filter(function (n) { return (n || '').trim() && n !== g.label; });
                    const survivor = (g.members || []).find(function (m) { return m.isSurvivor; }) || (g.members || [])[0] || {};
                    const headRow = '<tr id="acctgrp-head-' + gi + '" class="border-t hover:bg-teal-50 cursor-pointer" data-on-click="toggleAccountGroup" data-args=\'[' + gi + ']\'>'
                        + '<td class="px-2 py-1 align-top"><span id="acctgrp-caret-' + gi + '" class="text-gray-400 me-1">▸</span><span id="acctgrp-survname-' + gi + '">' + escapeHtml(g.label || '—') + '</span>'
                        + (others.length ? '<div class="text-[10px] text-gray-500 ms-3">also: ' + escapeHtml(others.join(' · ')) + '</div>' : '') + '</td>'
                        + '<td class="px-2 py-1 align-top font-mono text-[11px]">' + escapeHtml(g.domain || '—') + '</td>'
                        + '<td class="px-2 py-1 align-top text-center">' + ((g.members || []).length) + '</td>'
                        + '<td class="px-2 py-1 align-top text-center"><span id="acctgrp-survpct-' + gi + '" class="text-[11px] font-semibold text-emerald-700">' + (survivor.completionPct != null ? survivor.completionPct + '%' : '—') + '</span></td>'
                        + '</tr>';
                    const memberRows = (g.members || []).map(function (m) {
                        const created = m.createdMs ? new Date(m.createdMs * 1000).toISOString().slice(0, 10) : '—';
                        return '<tr class="border-t acctgrp-member-' + gi + '" data-mid="' + escapeHtml(m.zohoId) + '" data-on-click="setAccountSurvivor" data-args=\'[' + gi + ',"' + escapeHtml(m.zohoId) + '"]\' style="cursor:pointer">'
                            + '<td class="px-2 py-1 text-center"><span class="acctgrp-incl-' + gi + ' text-emerald-600 cursor-pointer" data-mid="' + escapeHtml(m.zohoId) + '" data-on-click="toggleAccountMemberInclude" data-args=\'[' + gi + ',"' + escapeHtml(m.zohoId) + '"]\' title="Included in the merge — click to EXCLUDE (leave this account untouched)">☑</span></td>'
                            + '<td class="px-2 py-1"><span class="acctgrp-radio-' + gi + ' ' + (m.isSurvivor ? 'text-emerald-600' : 'text-gray-300') + '" data-mid="' + escapeHtml(m.zohoId) + '">' + (m.isSurvivor ? '●' : '○') + '</span></td>'
                            + '<td class="px-2 py-1">' + escapeHtml(m.name || '—') + ' <span class="acctgrp-badge-' + gi + '" data-mid="' + escapeHtml(m.zohoId) + '">' + (m.isSurvivor ? '<span class="text-[9px] bg-emerald-100 text-emerald-800 px-1 rounded">SURVIVOR</span>' : '') + '</span></td>'
                            + '<td class="px-2 py-1 text-[10px] text-gray-500">' + escapeHtml(m.layout || '—') + '</td>'
                            + '<td class="px-2 py-1 text-gray-600">' + escapeHtml(m.owner || '—') + '</td>'
                            + '<td class="px-2 py-1 font-mono text-[10px] text-gray-600">' + escapeHtml(m.website || '—') + '</td>'
                            + '<td class="px-2 py-1 text-center" title="Deals linked to this Account (a bigger Deals book = stronger survivor)">' + ((m.dealCount || 0) > 0 ? '<span class="font-semibold text-indigo-700">💼 ' + m.dealCount + '</span>' : '<span class="text-gray-400">0</span>') + '</td>'
                            + '<td class="px-2 py-1 text-gray-600">' + escapeHtml(m.country || '—') + '</td>'
                            + '<td class="px-2 py-1 text-gray-500 text-[10px]">' + created + '</td>'
                            + '<td class="px-2 py-1"><div class="flex items-center gap-1"><div class="w-14 h-1.5 bg-gray-200 rounded"><div class="h-1.5 rounded bg-emerald-500" style="width:' + (m.completionPct || 0) + '%"></div></div><span class="text-[10px] text-gray-600">' + (m.completionPct || 0) + '% (' + (m.fieldsPopulated || 0) + '/' + (m.fieldsTotal || 0) + ')</span></div></td>'
                            + '</tr>';
                    }).join('');
                    const detailRow = '<tr id="acctgrp-detail-' + gi + '" style="display:none"><td colspan="4" class="px-2 pb-2 bg-gray-50">'
                        + '<div class="text-[10px] text-gray-500 mt-1 mb-1">Click a row to keep that account as the <strong>survivor</strong> (● = highest data completeness). Untick <strong>Merge?</strong> to EXCLUDE an account (e.g. a Partner) — it stays untouched and the rest still merge. The non-survivor included accounts are tagged Duplicate-Delete; their contacts & deals re-parent onto the survivor.</div>'
                        + '<table class="w-full text-xs"><thead><tr class="text-gray-400"><th class="px-2 py-1 text-start">Merge?</th><th class="px-2 py-1 text-start">Keep</th><th class="px-2 py-1 text-start">Account</th><th class="px-2 py-1 text-start">Layout</th><th class="px-2 py-1 text-start">Owner</th><th class="px-2 py-1 text-start">Website</th><th class="px-2 py-1 text-center" title="Deals linked to each Account">Deals</th><th class="px-2 py-1 text-start">Country</th><th class="px-2 py-1 text-start">Created</th><th class="px-2 py-1 text-start">Completion</th></tr></thead><tbody>' + memberRows + '</tbody></table>'
                        + '<div class="mt-1"><button data-on-click="dismissAccountGroup" data-args=\'[' + gi + ']\' class="px-2 py-1 text-[11px] font-semibold rounded bg-rose-100 text-rose-700 hover:bg-rose-200" title="These accounts are NOT the same company — exclude this group from this and all future auto-merges.">✕ Not duplicates — dismiss (don\'t merge)</button></div>'
                        + '</td></tr>';
                    return headRow + detailRow;
                }).join('');
                window._accountMergeScopeCount[scopeKey] = s.groups;
                const applyBtn = '<button data-on-click="applyAccountAutoMerge" data-args=\'["' + scopeKey + '"]\' class="mt-2 px-3 py-1.5 text-xs font-bold rounded-lg bg-teal-600 text-white hover:bg-teal-700">⚡ Apply these <span id="acctmerge-applycount-' + scopeKey + '">' + s.groups.toLocaleString() + '</span> merge(s) (admin)</button>';
                return '<div class="px-3 py-2 rounded bg-teal-50 border border-teal-200 text-teal-900 mb-2">'
                    + '<strong>' + title + ':</strong> <span id="acctmerge-count-' + scopeKey + '">' + s.groups.toLocaleString() + '</span> group(s) would merge · ' + (s.accountsToTag || 0).toLocaleString() + ' account(s) tagged Duplicate-Delete. <span class="text-[10px] text-teal-700">Click a group to verify / change its survivor.</span>'
                    + (rows ? '<table class="mt-1 w-full text-xs bg-white rounded"><thead><tr class="text-gray-500"><th class="px-2 py-1 text-start">Survivor name</th><th class="px-2 py-1 text-start">Domain</th><th class="px-2 py-1"># </th><th class="px-2 py-1">Survivor %</th></tr></thead><tbody>' + rows + '</tbody></table>'
                        + (s.groups > (s.sample || []).length ? '<div class="text-[10px] text-gray-500 mt-1">… showing ' + (s.sample || []).length + ' of ' + s.groups + ' groups.</div>' : '') : '')
                    + '<div>' + applyBtn + '</div>'
                    + '</div>';
            };
            panel.innerHTML = scopeBlock('Corporate ↔ Corporate', 'corporate', data.corporate)
                + scopeBlock('Partner ↔ Partner (Marketplace)', 'partner', data.partner)
                + '<div class="text-[11px] text-gray-500">Preview is a dry-run. <strong>Apply</strong> preserves both EN + AR names (alternate saved to the account Description), re-parents the duplicates\' contacts/deals onto the survivor, and tags the rest Duplicate-Delete — nothing is deleted by the platform.</div>';
            if (btn) btn.disabled = false;
        }

        // Expand / collapse one domain+name group to view its members + %.
        function toggleAccountGroup(gi) {
            const detail = document.getElementById('acctgrp-detail-' + gi);
            const caret = document.getElementById('acctgrp-caret-' + gi);
            if (!detail) return;
            const open = detail.style.display !== 'none';
            detail.style.display = open ? 'none' : '';
            if (caret) caret.textContent = open ? '▸' : '▾';
        }

        // Operator picks which account in a group is the survivor. Records the
        // override (keyed by the group's stable key) and updates the UI; the
        // override travels to the backend on Apply, where it FORCES the merge
        // master so what you selected is exactly what is kept.
        function setAccountSurvivor(gi, zohoId) {
            const g = (window._accountMergeGroups || [])[gi];
            if (!g) return;
            if (g._excluded && g._excluded[zohoId]) return; // an excluded account can't be the survivor
            window._accountMergeOverrides = window._accountMergeOverrides || {};
            const def = (g.members.find(function (m) { return m.isSurvivor; }) || {}).zohoId;
            if (zohoId === def) { delete window._accountMergeOverrides[g.key]; }
            else { window._accountMergeOverrides[g.key] = zohoId; }
            // Update radios + SURVIVOR badges within this group.
            document.querySelectorAll('.acctgrp-radio-' + gi).forEach(function (el) {
                const on = el.getAttribute('data-mid') === zohoId;
                el.textContent = on ? '●' : '○';
                el.className = 'acctgrp-radio-' + gi + ' ' + (on ? 'text-emerald-600' : 'text-gray-300');
            });
            document.querySelectorAll('.acctgrp-badge-' + gi).forEach(function (el) {
                const on = el.getAttribute('data-mid') === zohoId;
                el.innerHTML = on ? '<span class="text-[9px] bg-emerald-100 text-emerald-800 px-1 rounded">SURVIVOR</span>' : '';
            });
            document.querySelectorAll('.acctgrp-member-' + gi).forEach(function (tr) {
                tr.classList.toggle('bg-emerald-50', tr.getAttribute('data-mid') === zohoId);
            });
            // Reflect the choice in the collapsed header (name + completion %).
            const chosen = g.members.find(function (m) { return m.zohoId === zohoId; });
            if (chosen) {
                const nm = document.getElementById('acctgrp-survname-' + gi);
                if (nm) nm.textContent = chosen.name || '—';
                const pc = document.getElementById('acctgrp-survpct-' + gi);
                if (pc) pc.textContent = (chosen.completionPct != null ? chosen.completionPct + '%' : '—');
            }
        }

        // Collect the survivor overrides for one scope as { key: zohoId }.
        function _accountOverridesForScope(scope) {
            const out = {};
            const ov = window._accountMergeOverrides || {};
            (window._accountMergeGroups || []).forEach(function (g) {
                if (g.scope === scope && !g._dismissed && ov[g.key]) out[g.key] = ov[g.key];
            });
            return out;
        }

        // Toggle a single account in/out of its group's merge. An EXCLUDED account
        // is left completely untouched (not survivor, not tagged); the rest still
        // merge. If the excluded one was the survivor, the survivor moves to the
        // next included (highest-%) account.
        function toggleAccountMemberInclude(gi, zohoId) {
            const g = (window._accountMergeGroups || [])[gi];
            if (!g) return;
            g._excluded = g._excluded || {};
            const nowExcluded = !g._excluded[zohoId];
            if (nowExcluded) g._excluded[zohoId] = true; else delete g._excluded[zohoId];
            document.querySelectorAll('.acctgrp-incl-' + gi).forEach(function (el) {
                if (el.getAttribute('data-mid') !== zohoId) return;
                el.textContent = nowExcluded ? '☐' : '☑';
                el.className = 'acctgrp-incl-' + gi + ' cursor-pointer ' + (nowExcluded ? 'text-gray-300' : 'text-emerald-600');
            });
            document.querySelectorAll('.acctgrp-member-' + gi).forEach(function (tr) {
                if (tr.getAttribute('data-mid') === zohoId) {
                    tr.classList.toggle('opacity-40', nowExcluded);
                    tr.classList.toggle('line-through', nowExcluded);
                }
            });
            // If we just excluded the current survivor, promote the first included.
            const cur = (window._accountMergeOverrides && window._accountMergeOverrides[g.key]) || (g.members.find(function (m) { return m.isSurvivor; }) || {}).zohoId;
            if (nowExcluded && zohoId === cur) {
                const next = g.members.find(function (m) { return !g._excluded[m.zohoId]; });
                if (next) setAccountSurvivor(gi, next.zohoId);
            }
        }

        function _accountExcludesForScope(scope) {
            const out = {};
            (window._accountMergeGroups || []).forEach(function (g) {
                if (g.scope === scope && !g._dismissed && g._excluded) {
                    const ids = Object.keys(g._excluded);
                    if (ids.length) out[g.key] = ids;
                }
            });
            return out;
        }

        // Dismiss a group as "NOT duplicates" — records the accounts as mutually
        // separated (durable) so the group is excluded from this AND every future
        // auto-merge. No Zoho write. The apply re-derives groups server-side, so a
        // dismissed group is skipped automatically; here we just clear it from view.
        async function dismissAccountGroup(gi) {
            const g = (window._accountMergeGroups || [])[gi];
            if (!g) return;
            const ids = (g.members || []).map(function (m) { return m.zohoId; });
            if (ids.length < 2) return;
            if (!window.confirm('Mark these ' + ids.length + ' account(s) as NOT duplicates of each other?\n\nThey will be excluded from this and all FUTURE auto-merges (recorded in the separation ledger). Nothing is written to Zoho.')) return;
            try {
                const res = await fetch('/api/duplicates/accounts/dismiss-merge-group', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ zohoIds: ids }),
                });
                const d = await res.json().catch(function () { return {}; });
                if (!res.ok || !d.success) throw new Error((d && d.error) || ('HTTP ' + res.status));
            } catch (e) {
                alert('Dismiss failed: ' + (e && e.message || e));
                return;
            }
            g._dismissed = true;
            if (window._accountMergeOverrides) delete window._accountMergeOverrides[g.key];
            const head = document.getElementById('acctgrp-head-' + gi);
            const detail = document.getElementById('acctgrp-detail-' + gi);
            if (detail) detail.remove();
            if (head) {
                head.style.display = 'none';
                head.removeAttribute('data-on-click');
            }
            // Decrement the scope's "N group(s) would merge" header + Apply button.
            window._accountMergeScopeCount = window._accountMergeScopeCount || {};
            const sc = g.scope;
            const left = Math.max(0, (window._accountMergeScopeCount[sc] != null ? window._accountMergeScopeCount[sc] : 1) - 1);
            window._accountMergeScopeCount[sc] = left;
            const cEl = document.getElementById('acctmerge-count-' + sc);
            if (cEl) cEl.textContent = left.toLocaleString();
            const bEl = document.getElementById('acctmerge-applycount-' + sc);
            if (bEl) bEl.textContent = left.toLocaleString();
        }

        // Apply the account auto-merge for one scope (admin-gated). Re-uses the
        // proven agentic merge engine: preserves EN+AR names, re-parents the
        // duplicates' contacts/deals onto the survivor, tags the rest. Nothing
        // is deleted by the platform.
        async function applyAccountAutoMerge(scope) {
            const amMode = window._accountMergeMode === 'domain' ? 'domain' : 'domain_name';
            const matchDesc = amMode === 'domain' ? 'same domain, any name' : 'same domain + same name';
            const panel = document.getElementById('accountAutoMergePanel');
            if (!window.confirm('Apply the ' + scope + ' account auto-merge (' + matchDesc + ')?\\n\\nFor each group: the survivor keeps both EN + AR names (alternate saved to its Description), the duplicate accounts have their contacts/deals re-parented onto the survivor, and the duplicates are tagged Duplicate-Delete — the admin deletes them later; nothing is deleted now.' + (amMode === 'domain' ? '\\n\\nNote: this is the LOOSER domain-only rule — please review the groups (drill in / override survivor) before applying.' : '') + '\\n\\nYou will be asked for the admin password next.')) return;
            const key = window.prompt('Enter the admin password to apply this account merge:');
            if (!key || !key.trim()) return;
            const overrides = _accountOverridesForScope(scope);
            const excludes = _accountExcludesForScope(scope);
            const applyUrl = amMode === 'domain'
                ? '/api/duplicates/accounts/domain-only-merge'
                : '/api/duplicates/accounts/domain-name-merge';
            const note = document.createElement('div');
            note.className = 'text-teal-700 mt-1';
            const ovCount = Object.keys(overrides).length;
            const exCount = Object.keys(excludes).reduce(function (n, k) { return n + excludes[k].length; }, 0);
            note.textContent = 'Applying ' + scope + ' merges…' + (ovCount ? ' (' + ovCount + ' survivor override' + (ovCount === 1 ? '' : 's') + ')' : '') + (exCount ? ' (' + exCount + ' excluded)' : '') + ' (this re-parents records in Zoho — give it a moment)';
            panel.appendChild(note);
            let live;
            try {
                live = await _runBatchedMerge(applyUrl, {
                    key: key.trim(), batchLimit: 8, body: { scope: scope, overrides: overrides, excludes: excludes }, progressKeys: ['merged'],
                    onTick: function (t) { note.textContent = 'Applying ' + scope + ' merges… ' + (t.merged || 0).toLocaleString() + ' group(s), re-parented ' + (t.reparentedDeals || 0) + ' deal(s)/' + (t.reparentedContacts || 0) + ' contact(s)…'; },
                });
            } catch (e) {
                note.innerHTML = '<span class="text-amber-700">Apply paused: ' + escapeHtml(String(e && e.message || e)) + ' — click Apply again to resume.</span>';
                return;
            }
            note.outerHTML = '<div class="px-3 py-2 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 mt-1">'
                + '<strong>Done (' + escapeHtml(scope) + ').</strong> Merged ' + (live.merged || 0).toLocaleString() + ' group(s), tagged ' + (live.accountsTagged || 0).toLocaleString() + ' account(s) Duplicate-Delete, re-parented ' + (live.reparentedDeals || 0) + ' deal(s) + ' + (live.reparentedContacts || 0) + ' contact(s), preserved ' + (live.namesPreserved || 0) + ' alternate name(s).'
                + (live.errors > 0 ? ' (' + live.errors + ' group error(s) — re-run to retry.)' : ' All ' + scope + ' groups handled.')
                + '</div>';
            try {
                if (typeof loadRecordTab === 'function') {
                    const currentPage = (typeof recordPages !== 'undefined' && recordPages.accounts) || 0;
                    loadRecordTab('accounts', currentPage);
                }
            } catch (_) { /* non-fatal */ }
        }

        // Re-check Cluster — for every record currently in the cluster,
        // re-fetch from Zoho fresh and report live state per row. Confirms
        // the post-merge cascade actually landed (Account_Name on every
        // contact, Duplicate-Delete tag on every duplicate) without waiting
        // for the next 6h scan.
        async function recheckCluster(clusterId) {
            const panel = document.getElementById('recheckPanel-' + clusterId);
            if (!panel) return;
            panel.innerHTML = '<div class="py-2 text-blue-700 text-xs">Re-fetching every record in this cluster from Zoho…</div>';
            let res, data;
            try {
                res = await fetch('/api/duplicates/clusters/' + clusterId + '/recheck', { credentials: 'same-origin' });
                data = await res.json().catch(() => null);
            } catch (e) {
                panel.innerHTML = '<div class="py-2 text-red-600 text-xs">Failed to reach server: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                return;
            }
            if (!res.ok || !data) {
                panel.innerHTML = '<div class="py-2 text-amber-700 text-xs">' + escapeHtml((data && data.error) || ('Server returned ' + res.status)) + '</div>';
                return;
            }
            const headerTone = data.deleted > 0 ? 'blue' : (data.errors ? 'amber' : 'emerald');
            const truncNote = data.truncated ? ' <span class="text-amber-700">(showing first ' + data.total + ' of ' + data.totalInCluster + ')</span>' : '';
            const purgedNote = (data.purged > 0)
                ? ' · <strong class="text-emerald-700">' + data.purged + ' already-deleted record(s) removed — refreshing…</strong>'
                : '';
            const header = '<div class="px-3 py-2 rounded-lg bg-' + headerTone + '-50 border border-' + headerTone + '-200 text-xs mb-2">'
                + '<strong class="text-' + headerTone + '-800">Re-check:</strong> '
                + data.alive + ' alive · '
                + data.deleted + ' deleted · '
                + data.tagged + ' carry Duplicate-Delete tag'
                + (data.errors ? ' · ' + data.errors + ' Zoho error(s)' : '')
                + truncNote
                + purgedNote
                + '</div>';
            // Records confirmed deleted in Zoho were just purged server-side —
            // re-render the cluster so it collapses to the survivor(s) only.
            if (data.purged > 0 && typeof showClusterDetails === 'function') {
                setTimeout(function () { showClusterDetails(clusterId); }, 1400);
            }
            const rows = (data.byRecord || []).map(function (r) {
                const statusBadge = r.status === 'alive'
                    ? (r.hasDuplicateDeleteTag ? '<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-semibold">ALIVE · TAGGED</span>' : '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-semibold">ALIVE</span>')
                    : r.status === 'deleted'
                        ? '<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-[11px] font-semibold">DELETED</span>'
                        : r.status === 'error'
                            ? '<span class="px-2 py-0.5 rounded bg-red-100 text-red-800 text-[11px] font-semibold">ERROR</span>'
                            : '<span class="px-2 py-0.5 rounded bg-gray-100 text-gray-600 text-[11px] font-semibold">NO ZOHO</span>';
                const primaryBadge = r.isPrimary ? ' <span class="text-emerald-700 text-[11px] font-semibold">★ SURVIVOR</span>' : '';
                const tab = r.module === 'Deals' ? 'Potentials' : r.module;
                const link = (r.zohoId && tab) ? zohoLink(r.zohoId, tab) : '<span class="text-gray-400">—</span>';
                const acctCell = r.status === 'alive'
                    ? '<td class="px-2 py-1 text-xs text-gray-700" title="Current Zoho Account_Name (post-merge)">' + escapeHtml(r.currentAccountName || '—') + '</td>'
                    : '<td class="px-2 py-1 text-gray-300">—</td>';
                return '<tr class="border-t border-gray-100"><td class="px-2 py-1">' + statusBadge + primaryBadge + '</td>'
                    + '<td class="px-2 py-1 text-gray-700">' + escapeHtml(r.name || '—') + '</td>'
                    + '<td class="px-2 py-1 text-xs text-gray-500">' + escapeHtml(r.module || '—') + '</td>'
                    + '<td class="px-2 py-1">' + link + '</td>'
                    + acctCell
                    + '</tr>';
            }).join('');
            panel.innerHTML = header + (rows
                ? '<div class="overflow-x-auto"><table class="min-w-full text-xs border border-gray-200"><thead class="bg-gray-50"><tr><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Status</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Record</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Module</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Zoho</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Account (now)</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
                : '');
        }

        // Verify Tags — re-query Zoho for every record this cluster has
        // tagged Duplicate-Delete (via prior Apply / Agentic runs). Renders
        // a small status panel in #verifyTagsPanel-<clusterId> with totals
        // + per-record alive/deleted badges, plus clickable Zoho links so
        // the user can chase down anything still pending admin delete.
        async function verifyTaggedRecords(clusterId) {
            const panel = document.getElementById('verifyTagsPanel-' + clusterId);
            if (!panel) return;
            panel.innerHTML = '<div class="py-2 text-emerald-700 text-xs">Verifying tags in Zoho…</div>';
            let res, data;
            try {
                res = await fetch('/api/duplicates/clusters/' + clusterId + '/verify-tags', { credentials: 'same-origin' });
                data = await res.json().catch(() => null);
            } catch (e) {
                panel.innerHTML = '<div class="py-2 text-red-600 text-xs">Failed to reach server: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                return;
            }
            if (!res.ok || !data) {
                panel.innerHTML = '<div class="py-2 text-amber-700 text-xs">' + escapeHtml((data && data.error) || ('Server returned ' + res.status)) + '</div>';
                return;
            }
            if (data.message) {
                panel.innerHTML = '<div class="py-2 px-3 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600">' + escapeHtml(data.message) + '</div>';
                return;
            }
            const tone = (data.alive === 0) ? 'emerald'
                       : (data.deleted === 0) ? 'amber'
                       : 'indigo';
            const header = '<div class="px-3 py-2 rounded-lg bg-' + tone + '-50 border border-' + tone + '-200 text-xs mb-2">'
                + '<strong class="text-' + tone + '-800">' + data.deleted + ' of ' + data.total + ' tagged records have been deleted in Zoho.</strong>'
                + (data.alive ? ' <span class="text-' + tone + '-700">' + data.alive + ' still pending admin delete.</span>' : '')
                + (data.errors ? ' <span class="text-amber-700">' + data.errors + ' could not be verified (Zoho error).</span>' : '')
                + (data.purged > 0 ? ' <strong class="text-emerald-700">' + data.purged + ' removed from this cluster — refreshing…</strong>' : '')
                + '</div>';
            // Deleted records were purged server-side — re-render so the
            // cluster collapses to the survivor(s) only.
            if (data.purged > 0 && typeof showClusterDetails === 'function') {
                setTimeout(function () { showClusterDetails(clusterId); }, 1400);
            }
            const rows = (data.byRecord || []).map(function (r) {
                const badge = r.status === 'deleted'
                    ? '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[11px] font-semibold">DELETED</span>'
                    : r.status === 'alive'
                        ? '<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-semibold">PENDING</span>'
                        : r.status === 'no-zoho-id'
                            ? '<span class="px-2 py-0.5 rounded bg-gray-100 text-gray-600 text-[11px] font-semibold">NO ZOHO ID</span>'
                            : '<span class="px-2 py-0.5 rounded bg-red-100 text-red-800 text-[11px] font-semibold">ERROR</span>';
                const tab = r.module === 'Deals' ? 'Potentials' : r.module;
                const link = (r.zohoId && tab) ? zohoLink(r.zohoId, tab) : '<span class="text-gray-400">—</span>';
                return '<tr class="border-t border-gray-100"><td class="px-2 py-1">' + badge + '</td>'
                    + '<td class="px-2 py-1 text-gray-700">' + escapeHtml(r.name || '—') + '</td>'
                    + '<td class="px-2 py-1 text-xs text-gray-500">' + escapeHtml(r.module || '—') + '</td>'
                    + '<td class="px-2 py-1">' + link + '</td>'
                    + (r.error ? '<td class="px-2 py-1 text-[11px] text-red-600">' + escapeHtml(r.error) + '</td>' : '<td class="px-2 py-1"></td>')
                    + '</tr>';
            }).join('');
            panel.innerHTML = header + (rows
                ? '<div class="overflow-x-auto"><table class="min-w-full text-xs border border-gray-200"><thead class="bg-gray-50"><tr><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Status</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Record</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Module</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Zoho</th><th scope="col" class="px-2 py-1 text-start font-medium text-gray-600">Note</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
                : '');
        }

        // Fill the "Will reparent: X Deals · Y Contacts" line in the merge
        // plan. Called AFTER __renderMergePlan paints — fans out to Zoho
        // related lists, then updates the placeholder span. Best-effort:
        // a Zoho rate-limit or 5xx leaves the placeholder as "…" rather
        // than blocking the dry-run / apply flow.
        async function loadReparentPreview(module, clusterId) {
            const slot = document.getElementById('reparent-preview-' + module);
            if (!slot) return;
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/reparent-preview?module=' + encodeURIComponent(module), { credentials: 'same-origin' });
                if (!res.ok) { slot.textContent = '—'; return; }
                const data = await res.json();
                const parts = [];
                if (typeof data.deals === 'number' && data.deals > 0) parts.push(data.deals + ' Deal' + (data.deals === 1 ? '' : 's'));
                if (typeof data.contacts === 'number' && data.contacts > 0) parts.push(data.contacts + ' Contact' + (data.contacts === 1 ? '' : 's'));
                const trailer = (data.scope === 'truncated')
                    ? ' <span class="text-amber-700">(sampled ' + data.duplicatesInspected + '/' + data.duplicatesTotal + ' dups)</span>'
                    : '';
                slot.innerHTML = parts.length
                    ? '<span class="text-indigo-700 font-medium">' + parts.join(' · ') + '</span> will be repointed onto the survivor' + trailer
                    : '<span class="text-gray-500">No related Deals or Contacts to reparent.</span>';
            } catch (_) { slot.textContent = '—'; }
        }

        // Lazily fill the "Deals" column on the Accounts merge modal with the
        // child-Deal count for each Account (via Zoho related list). Sarah
        // Hijazi (2026-06-10): "instead of attachments here we can add the
        // no. of deals that inside the account itself" — the bigger Deals
        // book is a stronger survivor signal than attachment counts for
        // Accounts. Best-effort: a Zoho rate-limit / error leaves the cell
        // as a neutral dash instead of blocking the plan.
        async function loadAccountDealCounts(clusterId) {
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/deal-counts', { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                const counts = (data && data.counts) || {};
                Object.keys(counts).forEach(function (zohoId) {
                    const el = document.getElementById('dealcount-Accounts-' + zohoId);
                    if (!el) return;
                    const n = Number(counts[zohoId]);
                    if (n < 0) {
                        // -1 sentinel = Zoho error; neutral dash.
                        el.textContent = '—';
                        el.className = 'text-xs text-gray-300';
                        el.title = 'Could not fetch Deals from Zoho.';
                    } else if (n > 0) {
                        el.textContent = '💼 ' + n;
                        el.className = 'text-xs font-semibold text-indigo-700';
                        el.title = n + ' Deal(s) linked to this Account in Zoho';
                    } else {
                        el.textContent = '0';
                        el.className = 'text-xs text-gray-400';
                        el.title = 'No Deals linked to this Account';
                    }
                });
            } catch (_) { /* non-fatal */ }
        }

        // Lazily fill the 📎 column with per-record attachment counts. A record
        // with files is a strong "keep this one" signal — and the autonomous
        // agent refuses to auto-merge a duplicate that carries attachments.
        async function loadAttachmentChips(module, clusterId) {
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/attachments?module=' + encodeURIComponent(module), { credentials: 'same-origin' });
                if (!res.ok) return;
                const data = await res.json();
                const counts = (data && data.counts) || {};
                Object.keys(counts).forEach(function (zohoId) {
                    const el = document.getElementById('att-' + module + '-' + zohoId);
                    if (!el) return;
                    const n = counts[zohoId] | 0;
                    if (n > 0) {
                        el.textContent = '📎 ' + n;
                        el.className = 'text-xs font-semibold text-amber-700';
                        el.title = n + ' attachment(s) — evidence on this record';
                    } else {
                        el.textContent = '—';
                        el.className = 'text-xs text-gray-300';
                    }
                });
            } catch (_) { /* non-fatal */ }
        }

        // Toggle one record in/out of the merge set, then re-preview. Enforces
        // at least 2 selected — you can't merge fewer than two records.
        function toggleMergeRecord(module, zohoId) {
            const st = _planSt(module);
            const sel = new Set(Array.isArray(st.selected) ? st.selected : []);
            const key = String(zohoId);
            if (sel.has(key)) sel.delete(key); else sel.add(key);
            // A link-only cascade (an Account is chosen to link to) is valid
            // with a single contact (the survivor) — it just sets Account_Name,
            // nothing is merged. Only require 2 for an actual merge (no link).
            var linkOnly = !!(st.linkAccount && String(st.linkAccount).trim());
            var minSel = linkOnly ? 1 : 2;
            if (sel.size < minSel) {
                alert(linkOnly ? 'Keep at least the survivor contact selected.' : 'Select at least 2 records to merge (or pick an Account to link to for a link-only cascade).');
                previewMergePlan(module, window.__planClusterId);
                return;
            }
            // If the operator unticked the record they'd forced as survivor,
            // drop the override so the agent re-picks among the remaining set.
            if (!sel.has(key) && st.master === key) st.master = null;
            st.selected = Array.from(sel);
            previewMergePlan(module, window.__planClusterId);
        }

        // Link the survivor to a cluster Account (Contacts/Deals set Account_Name).
        // "" = don't link. Re-previews so the choice persists into dry-run/apply.
        function setMergeLinkAccount(module, zohoId) {
            const st = _planSt(module);
            st.linkAccount = String(zohoId);
            previewMergePlan(module, window.__planClusterId);
        }

        // Move a single Deal/Contact under an Account NOW (sets Account_Name in
        // Zoho via the proven link primitive). Powers the per-row "move to →"
        // buttons in the Deals/Contacts merge pop-up and the Account pop-up's
        // deal list. Confirm-gated; writes live, deletes nothing.
        async function linkRecordToAccount(module, recordZohoId, accountZohoId, accountName) {
            const noun = String(module).replace(/s$/, '');
            if (!confirm('Move this ' + noun + ' under "' + (accountName || 'the selected account') + '"?\n\nThis sets the ' + noun + "'s Account_Name in Zoho. Nothing is deleted.")) return;
            try {
                const res = await fetch('/api/duplicates/link-record-to-account', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ module: module, record_zoho_id: String(recordZohoId), account_zoho_id: String(accountZohoId) })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                alert('Done — linked to "' + (accountName || accountZohoId) + '" in Zoho. The next sync will reflect it.');
                if (window.__planClusterId) previewMergePlan(module, window.__planClusterId);
            } catch (e) {
                alert('Could not link: ' + (e && e.message || e) + (/403|401|admin/i.test(String(e && e.message || e)) ? '\n(Admin access is required to link records.)' : ''));
            }
        }

        // Account pop-up: lazily list the Deals under each Account in the cluster
        // and let the operator move any Deal to another Account in the same
        // cluster. Fetches /account-deals once per open; renders into #accountDealsPanel-<clusterId>.
        async function loadAccountDealsMover(clusterId) {
            const panel = document.getElementById('accountDealsPanel-' + clusterId);
            if (!panel) return;
            panel.innerHTML = '<div class="text-xs text-gray-500 p-2">Loading deals…</div>';
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/account-deals', { credentials: 'same-origin' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
                const accounts = data.accounts || [];
                const deals = data.deals || {};
                if (!accounts.length) { panel.innerHTML = '<div class="text-xs text-gray-500 p-2">No accounts in this cluster.</div>'; return; }
                const esc = (s) => escapeHtml(String(s == null ? '' : s));
                panel.innerHTML = accounts.map(function (a) {
                    const ds = deals[a.zohoId] || [];
                    const others = accounts.filter(function (x) { return x.zohoId !== a.zohoId; });
                    const rows = ds.length ? ds.map(function (d) {
                        const moveBtns = others.map(function (o) {
                            return '<button data-on-click="linkRecordToAccount" data-args=\'["Deals","' + esc(d.id) + '","' + esc(o.zohoId) + '","' + esc(String(o.name).replace(/"/g, '')) + '"]\' class="px-1.5 py-0.5 rounded text-[10px] bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 ms-1" title="Move this deal under ' + esc(o.name) + '">→ ' + esc(o.name) + '</button>';
                        }).join('');
                        return '<div class="flex flex-wrap items-center gap-1 py-1 border-t border-gray-100"><span class="text-xs text-gray-800">' + esc(d.name) + '</span>' + (d.stage ? '<span class="text-[10px] text-gray-500">(' + esc(d.stage) + ')</span>' : '') + '<span class="ms-auto"></span>' + moveBtns + '</div>';
                    }).join('') : '<div class="text-[11px] text-gray-400 py-1">No deals on this account.</div>';
                    return '<div class="mb-2"><div class="text-xs font-semibold text-gray-700">' + esc(a.name) + ' <span class="text-gray-400">(' + ds.length + ' deal' + (ds.length === 1 ? '' : 's') + ')</span></div>' + rows + '</div>';
                }).join('');
            } catch (e) {
                panel.innerHTML = '<div class="text-xs text-red-600 p-2">Could not load deals: ' + escapeHtml(String(e && e.message || e)) + '</div>';
            }
        }

        // Split the TICKED records into a brand-new cluster — for name-collision
        // false positives (two real companies sharing a word). Platform-only:
        // re-points cluster membership; no Zoho writes.
        async function splitMergeSelection(module, clusterId) {
            const st = _planSt(module);
            const selected = new Set(Array.isArray(st.selected) ? st.selected : []);
            const recs = (st.planRecords || []).filter(r => r.zohoId && selected.has(String(r.zohoId)));
            const dbIds = recs.map(r => r.dbId).filter(x => x !== null && x !== undefined);
            if (dbIds.length < 1) {
                alert('Tick the records you want to move into a new cluster first (e.g. the accounts that belong to the OTHER company), then click Split.');
                return;
            }
            if ((st.planRecords || []).length && dbIds.length >= (st.planRecords || []).length) {
                alert('Leave at least one record behind — splitting every record would just move the cluster. Untick the records that should stay.');
                return;
            }
            if (!confirm('Move the ' + dbIds.length + ' ticked record(s) into a NEW cluster?\n\nThey become a separate cluster you can resolve on their own. This changes nothing in Zoho.')) return;
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/split', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'manual', record_ids: dbIds })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                alert('Done — ' + dbIds.length + ' record(s) split into a new cluster. It now appears separately in the list to resolve.');
                closeModal();
                refreshData();
            } catch (e) {
                alert('Could not split: ' + (e && e.message || e) + (/403|401|admin/i.test(String(e && e.message || e)) ? '\n(Admin access is required to split a cluster.)' : ''));
            }
        }

        // Auto-split a cluster by distinct company name (largest group stays,
        // each other name becomes its own cluster). For name-collision clusters.
        async function splitClusterByName(module, clusterId) {
            if (!confirm('Auto-split this cluster by company name?\n\nRecords are grouped by company name; the largest group stays here and each other name becomes its own cluster. Best for name-collision clusters (e.g. "Andalusia Group" vs "Andalusia Hospital").\n\nNo Zoho changes.')) return;
            try {
                const res = await fetch('/api/duplicates/clusters/' + clusterId + '/split', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'by_name' })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                alert('Split into ' + ((data.new_cluster_ids || []).length) + ' new cluster(s) by company name. They now appear separately in the list to resolve.');
                closeModal();
                refreshData();
            } catch (e) {
                alert('Could not split by name: ' + (e && e.message || e) + (/403|401|admin/i.test(String(e && e.message || e)) ? '\n(Admin access is required to split a cluster.)' : ''));
            }
        }

        // Force a specific record to be the survivor (overrides the auto-pick).
        // Ensures it's part of the merge set, then re-previews.
        function setMergeSurvivor(module, zohoId) {
            const st = _planSt(module);
            const key = String(zohoId);
            st.master = key;
            if (Array.isArray(st.selected) && !st.selected.includes(key)) st.selected.push(key);
            previewMergePlan(module, window.__planClusterId);
        }

        // ── Agentic Resolution — execute (dry-run / apply) ────────────────────
        // dryRunMergePlan: POST /execute with no confirm → server performs NO
        // writes but enumerates exactly what a real run would do.
        async function dryRunMergePlan(module, clusterId) {
            const st = _planSt(module);
            await _runMergeExec(module, clusterId, { module: module, dry_run: true, record_zoho_ids: st.selected || undefined, master_zoho_id: st.master || undefined, link_account_zoho_id: st.linkAccount }, false);
        }
        // applyMergePlan: explicit confirm → POST /execute with confirm:true →
        // real Zoho writes (migrate fields, reparent, tag, stamp, resolve).
        async function applyMergePlan(module, clusterId) {
            const ok = window.confirm(
                'Apply this ' + module + ' merge in Zoho?\n\n' +
                '• Winning field values are written onto the survivor.\n' +
                '• Related records + notes are reparented to the survivor.\n' +
                '• Duplicates are tagged "Duplicate-Delete" for the admin.\n' +
                '• Nothing is deleted by the platform.\n\n' +
                'This writes to production Zoho.'
            );
            if (!ok) return;
            const st = _planSt(module);
            await _runMergeExec(module, clusterId, { module: module, confirm: true, record_zoho_ids: st.selected || undefined, master_zoho_id: st.master || undefined, link_account_zoho_id: st.linkAccount }, true);
        }
        // Force-merge override — tag the TICKED contacts as the same person even
        // when they share fewer than 2 of {email, phone, name}. Verified by the
        // operator; migrate-then-tag (nothing deleted); logged in the timeline.
        async function forceMergePlan(module, clusterId) {
            const st = _planSt(module);
            const sel = (st.selected || []);
            if (sel.length < 2) {
                alert('Tick the contacts that are the SAME person — at least 2 (the survivor + the one(s) to merge into it) — then click Force-merge.');
                return;
            }
            const ok = window.confirm(
                '⚠ FORCE-MERGE override\n\n' +
                'These contacts do NOT meet the automatic ≥2-signal rule (email/phone/name). ' +
                'Only proceed if you have VERIFIED they are the SAME person.\n\n' +
                '• ' + sel.length + ' selected contact(s): the survivor keeps its data; the rest are tagged "Duplicate-Delete".\n' +
                '• Migrate-then-tag — nothing is deleted by the platform.\n' +
                '• Logged in the action timeline as an operator-forced merge.\n\n' +
                'Proceed with the force-merge in Zoho?'
            );
            if (!ok) return;
            await _runMergeExec(module, clusterId, { module: module, confirm: true, force_merge: true, record_zoho_ids: st.selected || undefined, master_zoho_id: st.master || undefined, link_account_zoho_id: st.linkAccount }, true);
        }
        async function _runMergeExec(module, clusterId, body, isApply) {
            const panel = document.getElementById('mergeExecPanel-' + module);
            if (!panel) return;
            panel.innerHTML = '<div class="py-3 text-gray-400">' + (isApply ? 'Applying in Zoho…' : 'Running dry-run…') + '</div>';
            let res, data;
            try {
                res = await fetch('/api/duplicates/clusters/' + encodeURIComponent(clusterId) + '/execute', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
            } catch (e) {
                panel.innerHTML = '<div class="py-3 text-red-600 text-sm">Failed to reach server: ' + escapeHtml(String(e && e.message || e)) + '</div>';
                return;
            }
            try { data = await res.json(); } catch (_) { data = null; }
            // Real apply (confirm:true) now launches a background job instead
            // of returning a final report — the endpoint responds 202 with
            // { job_id, status, total }. Dry-run is untouched: it still
            // returns { report } synchronously and renders the full preview.
            if (isApply && data && data.job_id) {
                panel.innerHTML = '<div class="py-3 text-gray-500 text-sm">Apply queued — job #' + escapeHtml(String(data.job_id)) + ' started…</div>';
                const jobPanel = document.getElementById('mergeJobPanel');
                if (jobPanel) {
                    jobPanel.classList.remove('hidden');
                    _pollMergeJob(clusterId, module, jobPanel);
                }
                return;
            }
            if (!res.ok || !data || !data.report) {
                const msg = (data && data.error) ? data.error : ('Server returned ' + (res ? res.status : '—'));
                panel.innerHTML = '<div class="py-3 text-amber-700 text-sm">' + escapeHtml(msg) + '</div>';
                return;
            }
            panel.innerHTML = __renderExecReport(data.report);
            // After a successful real apply, refresh the active tab so the
            // page recompacts to 20 visible clusters — the just-applied
            // cluster moves from "Untouched" to "AI-Applied · pending Zoho
            // admin delete" (cross-module case) or "Resolved" (single-module
            // case). Either way, with the default Untouched chip selected
            // the cluster leaves the page and the backend slides the next
            // cluster in to fill the slot. Reload the CURRENT tab (cheaper
            // than refreshData's full-page reload) and preserve the page
            // number so the operator stays at the same scroll position.
            if (isApply && data.report && !data.report.dryRun) {
                try {
                    const tab = window._currentTab;
                    if (['leads','deals','contacts','accounts'].includes(tab) && typeof loadRecordTab === 'function') {
                        const currentPage = (typeof recordPages !== 'undefined' && recordPages[tab]) || 0;
                        loadRecordTab(tab, currentPage);
                    } else if (typeof refreshData === 'function') {
                        refreshData();
                    }
                } catch (_) { /* non-fatal — operator can paginate manually */ }
            }
        }

        // ── Background merge-apply job — progress panel + polling ─────────────
        // The real apply (confirm:true) now runs as an in-process background
        // job so 200+-record merges never hit a gateway timeout. This polls
        // GET …/merge-job?module=<M> every ~3s and renders live progress until
        // the job reaches a terminal state (done/partial/failed) or goes stale
        // (heartbeat cold while still "running" — server-computed `stale` flag).
        async function _pollMergeJob(clusterId, module, panelEl) {
            for (;;) {
                let j = null;
                try {
                    const r = await fetch('/api/duplicates/clusters/' + encodeURIComponent(clusterId) + '/merge-job?module=' + encodeURIComponent(module), { credentials: 'same-origin' });
                    const body = await r.json().catch(() => ({}));
                    j = body && body.job;
                } catch (_) { /* transient network hiccup — keep polling */ }
                if (!j) {
                    panelEl.textContent = WalaPlusI18n.t('dyn.duplicates.mj_title') + ': ' + 'no job found.';
                    return;
                }
                const total = j.total || 0;
                const tagged = j.tagged || 0;
                const reparented = j.reparented || 0;
                const remaining = Math.max(0, total - tagged);
                let line;
                if (j.status === 'running' && j.stale) {
                    line = '⚠ ' + WalaPlusI18n.t('dyn.duplicates.mj_stalled');
                } else if (j.status === 'running') {
                    line = '⏳ ' + WalaPlusI18n.t('dyn.duplicates.mj_running') + ' — ' + tagged + ' / ' + total + ' · reparented ' + reparented + ' · ' + remaining + ' remaining…';
                } else if (j.status === 'done') {
                    line = '✓ ' + WalaPlusI18n.t('dyn.duplicates.mj_done') + ' — ' + tagged + ' / ' + total;
                } else if (j.status === 'partial') {
                    line = '⚠ ' + WalaPlusI18n.t('dyn.duplicates.mj_partial') + ' — ' + (j.errors || 0) + ' error(s)';
                } else {
                    line = '✗ ' + WalaPlusI18n.t('dyn.duplicates.mj_failed');
                }
                panelEl.innerHTML = '<div class="text-xs uppercase tracking-wide text-gray-500 mb-1">' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.mj_title')) + '</div><div class="font-semibold">' + line + '</div>';
                if (j.status !== 'running' || j.stale) return;
                await new Promise(function (resolve) { setTimeout(resolve, 3000); });
            }
        }

        // On cluster modal open, resume the progress panel if a job from an
        // earlier apply is still running — guards against navigating away
        // mid-merge and losing visibility into a job that's still ticking.
        async function _resumeMergeJobIfRunning(clusterId) {
            const jobPanel = document.getElementById('mergeJobPanel');
            if (!jobPanel) return;
            jobPanel.classList.add('hidden');
            jobPanel.innerHTML = '';
            try {
                const modules = ['Accounts', 'Contacts', 'Deals', 'Leads'];
                for (const module of modules) {
                    const r = await fetch('/api/duplicates/clusters/' + encodeURIComponent(clusterId) + '/merge-job?module=' + encodeURIComponent(module), { credentials: 'same-origin' });
                    const body = await r.json().catch(() => ({}));
                    const j = body && body.job;
                    if (j && j.status === 'running' && !j.stale) {
                        jobPanel.classList.remove('hidden');
                        _pollMergeJob(clusterId, module, jobPanel);
                        return;
                    }
                }
            } catch (_) { /* non-fatal — panel just stays hidden */ }
        }
        function __renderExecReport(rep) {
            const esc = (v) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
            const banner = rep.dryRun
                ? '<div class="rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-sm p-2 mb-2">Dry-run — no changes were written to Zoho. This is what a real apply would do.</div>'
                : (rep.errors && rep.errors.length
                    ? '<div class="rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm p-2 mb-2">Applied with ' + rep.errors.length + ' error(s) — see below.</div>'
                    : '<div class="rounded-lg bg-green-50 border border-green-300 text-green-900 text-sm p-2 mb-2">Applied successfully in Zoho.</div>');
            const fields = (rep.fieldsMigrated || []).length
                ? (rep.fieldsMigrated || []).map(f => esc(f.field) + '=' + esc(f.value)).join(', ')
                : 'none';
            const errs = (rep.errors || []).length
                ? '<div class="text-xs uppercase tracking-wide text-gray-500 mt-2 mb-1">Errors</div><ul class="list-disc ms-5 text-red-700 text-sm">' +
                    rep.errors.map(e => '<li>' + esc(e.step) + (e.recordId ? ' [' + esc(e.recordId) + ']' : '') + ': ' + esc(e.message) + '</li>').join('') + '</ul>'
                : '';
            const warns = (rep.warnings || []).length
                ? '<div class="text-xs uppercase tracking-wide text-gray-500 mt-2 mb-1">Warnings</div><ul class="list-disc ms-5 text-amber-800 text-sm">' +
                    rep.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>'
                : '';
            return banner +
                '<div class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">' +
                '<div class="text-gray-500">Fields migrated</div><div>' + fields + '</div>' +
                '<div class="text-gray-500">Reparented</div><div>' + (rep.reparented ? (rep.reparented.deals + ' deals · ' + rep.reparented.contacts + ' contacts · ' + rep.reparented.notes + ' notes') : '—') + '</div>' +
                '<div class="text-gray-500">Linked to Account</div><div>' + (rep.linkedToAccount ? esc(rep.linkedToAccount) : 'no') + '</div>' +
                '<div class="text-gray-500">Left on duplicate</div><div>' + (rep.leftOnDuplicate ? (rep.leftOnDuplicate.activities + ' activities · ' + rep.leftOnDuplicate.attachments + ' attachments') : '—') + '</div>' +
                '<div class="text-gray-500">Tagged Duplicate-Delete</div><div>' + ((rep.taggedRecordIds || []).length) + ' record(s)</div>' +
                '<div class="text-gray-500">Notes stamped</div><div>' + esc(rep.notesStamped) + '</div>' +
                '<div class="text-gray-500">Cluster resolved</div><div>' + (rep.clusterResolved ? 'yes' : (rep.dryRun ? 'no (dry-run)' : 'no')) + '</div>' +
                '</div>' + warns + errs;
        }

        function __renderMergePlan(plan) {
            const esc = (v) => escapeHtml(v === null || v === undefined || v === '' ? '—' : String(v));
            // Contacts merge modal swaps the 📎 attachments chip for the parent
            // Account name — operators have asked for that context (which company
            // does each duplicate belong to?) since most contacts share the same
            // "Standard" layout. Attachment safety still runs in the backend risk
            // gate via /api/duplicates/clusters/:id/attachments — only the chip
            // moves off the modal for Contacts.
            const isContacts = plan.module === 'Contacts';

            // LINK-ONLY mode (Contacts + 0 duplicates). Triggered when the
            // ≥2-attribute rule filters every candidate duplicate out so the
            // plan would only cascade Account_Name. Sarah Hijazi (2026-06-10):
            // "no merge action here — it shall be Link, not Merge". When this
            // fires, the modal swaps the word "Merge" for "Link" everywhere
            // (header, table column, button, footer note). The records that
            // were soft-excluded by the strict rule are now rendered as
            // "→ Link" rows instead of "Excluded", because the executor's
            // cascade still updates their Account_Name.
            const dupCount = Array.isArray(plan.duplicateZohoIds) ? plan.duplicateZohoIds.length : 0;
            const cascadeIds = new Set(plan.cascadeOnlyZohoIds || []);
            const linkOnlyMode = isContacts && dupCount === 0;

            // "Link survivor to Account" control — only when the cluster has
            // account(s) and this is a Contacts/Deals plan. CSP-safe buttons.
            const linkControl = (plan.accountCandidates && plan.accountCandidates.length)
                ? '<div class="mb-3 p-2 rounded-lg border border-indigo-100 bg-indigo-50">' +
                    '<div class="text-xs uppercase tracking-wide text-indigo-700 mb-1">Link survivor to Account</div>' +
                    '<div class="flex flex-wrap gap-2 items-center">' +
                        '<button data-on-click="setMergeLinkAccount" data-args=\'["' + esc(plan.module) + '",""]\' class="px-2 py-1 rounded text-xs ' + (!plan.linkAccountZohoId ? 'bg-gray-300 text-gray-900 font-semibold' : 'bg-white border border-gray-300 text-gray-600 hover:bg-gray-100') + '">Don\'t link</button>' +
                        plan.accountCandidates.map(a =>
                            '<button data-on-click="setMergeLinkAccount" data-args=\'["' + esc(plan.module) + '","' + esc(a.zohoId) + '"]\' class="px-2 py-1 rounded text-xs ' + (plan.linkAccountZohoId === a.zohoId ? 'bg-indigo-600 text-white font-semibold' : 'bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100') + '">' + esc(a.name) + '</button>'
                        ).join('') +
                    '</div>' +
                    '<div class="text-[11px] text-gray-500 mt-1">On apply, the surviving ' + (plan.module === 'Deals' ? 'deal' : 'contact') + ' gets its <code class="bg-white px-1 rounded">Account_Name</code> set to the chosen account.</div>' +
                '</div>'
                : '';

            const recRows = (plan.records || []).map(r => {
                const included = r.included !== false;
                const isCascadeOnly = !!(r.zohoId && cascadeIds.has(r.zohoId));
                const makeSurvivorBtn = (included && !r.isMaster && r.zohoId)
                    ? ' <button data-on-click="setMergeSurvivor" data-args=\'["' + esc(plan.module) + '","' + esc(r.zohoId) + '"]\' class="ms-1 text-[11px] text-indigo-600 hover:underline cursor-pointer" title="' + (linkOnlyMode ? 'Make this the contact that is KEPT' : 'Make this the surviving record') + '">' + (linkOnlyMode ? '★ make KEEP' : '★ make survivor') + '</button>'
                    : '';
                // Outcome label — three branches:
                //   1) cascadeOnly (Contacts soft-excluded by ≥2-attribute rule)
                //      → "→ Link to Account" (green). They are NOT tagged
                //      Duplicate-Delete; the executor only updates their
                //      Account_Name. This was previously mislabelled as
                //      "Excluded" which scared operators.
                //   2) Master / SURVIVOR
                //   3) Operator-excluded → "Excluded" (unchanged)
                //   4) Real duplicate → "Duplicate-Delete" (unchanged)
                let outcome;
                if (isCascadeOnly) {
                    // The make-survivor button is appended here too so the operator
                    // can choose WHICH contact is the KEEP/survivor in a link-only
                    // plan — previously only genuine-duplicate rows let you pick,
                    // so the KEEP looked locked. Clicking re-previews with the new
                    // master (setMergeSurvivor), unifying both views.
                    outcome = '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-semibold" title="The ≥2-attribute rule says this contact is NOT a duplicate of the survivor. On Apply, its Account_Name is updated to the surviving Account — but it is NOT tagged Duplicate-Delete.">→ Link to Account</span>' + makeSurvivorBtn;
                } else if (!included) {
                    outcome = '<span class="px-2 py-0.5 rounded bg-gray-100 text-gray-500 text-xs font-medium">Excluded</span>';
                } else if (r.isMaster) {
                    outcome = linkOnlyMode
                        ? '<span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 text-xs font-semibold" title="The surviving contact — keeps its current state, just gets re-linked to the chosen Account.">★ KEEP</span>'
                        : '<span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 text-xs font-semibold">SURVIVOR</span>';
                } else {
                    outcome = '<span class="px-2 py-0.5 rounded bg-red-100 text-red-800 text-xs font-medium">Duplicate-Delete</span>' + makeSurvivorBtn;
                }
                // Per-row "move to account" — Deals/Contacts only. Sets THIS
                // record's Account_Name to any cluster account immediately (not
                // just the survivor). Writes live via linkRecordToAccount.
                const perRowLink = (r.zohoId && (plan.module === 'Deals' || plan.module === 'Contacts') && Array.isArray(plan.accountCandidates) && plan.accountCandidates.length)
                    ? '<div class="mt-1 flex flex-wrap items-center gap-1"><span class="text-[10px] text-gray-400">move to:</span>'
                        + plan.accountCandidates.map(function (a) {
                            return '<button data-on-click="linkRecordToAccount" data-args=\'["' + esc(plan.module) + '","' + esc(r.zohoId) + '","' + esc(a.zohoId) + '","' + esc(String(a.name).replace(/"/g, '')) + '"]\' class="px-1.5 py-0.5 rounded text-[10px] bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50" title="Set this record\'s Account_Name to ' + esc(a.name) + ' in Zoho">→ ' + esc(a.name) + '</button>';
                        }).join('')
                        + '</div>'
                    : '';
                const cb = r.zohoId
                    ? '<input type="checkbox" data-on-click="toggleMergeRecord" data-args=\'["' + esc(plan.module) + '","' + esc(r.zohoId) + '"]\'' + (included ? ' checked' : '') + ' class="cursor-pointer w-4 h-4" title="' + (linkOnlyMode ? 'Include this contact in the link cascade' : 'Include this record in the merge') + '">'
                    : '<span class="text-gray-300" title="No Zoho id — cannot be ' + (linkOnlyMode ? 'linked' : 'merged') + '">—</span>';
                // Middle cell — three flavours by module:
                //   Contacts → "Account" (parent Account_Name)
                //   Accounts → "Deals" (count of child Deals — stronger
                //              survivor signal than attachment counts)
                //   Leads / Deals → 📎 attachments
                let midCell;
                if (isContacts) {
                    midCell = '<td class="px-3 py-2 text-xs text-gray-700" title="Zoho Contacts → Account_Name (parent Account this contact is linked to)">' + esc(r.accountName) + '</td>';
                } else if (plan.module === 'Accounts') {
                    midCell = '<td class="px-3 py-2 text-center">' + (r.zohoId ? '<span id="dealcount-Accounts-' + esc(r.zohoId) + '" class="text-xs text-gray-400" title="Number of Deals linked to this Account (Zoho related list)">…</span>' : '<span class="text-gray-300">—</span>') + '</td>';
                } else if (plan.module === 'Deals') {
                    // Deal Stage — the key signal when merging deals (don't merge
                    // away an open/won deal). Shown in place of attachments.
                    midCell = '<td class="px-3 py-2" title="Deal Stage in Zoho">' + (r.stage ? '<span class="inline-block px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-xs">' + esc(r.stage) + '</span>' : '<span class="text-gray-300">—</span>') + '</td>';
                } else {
                    midCell = '<td class="px-3 py-2 text-center">' + (r.zohoId ? '<span id="att-' + esc(plan.module) + '-' + esc(r.zohoId) + '" class="text-xs text-gray-400" title="Attachments on this record">…</span>' : '<span class="text-gray-300">—</span>') + '</td>';
                }
                // Make the Zoho ID clickable — every CRM id in the platform
                // should jump straight to that Zoho record. The merge modal
                // was the worst offender (id was monospaced plain text).
                const zohoTab = plan.module === 'Deals' ? 'Potentials' : plan.module;
                const idCell = r.zohoId
                    ? '<td class="px-3 py-2">' + zohoLink(r.zohoId, zohoTab) + '</td>'
                    : '<td class="px-3 py-2 text-gray-300 text-xs">—</td>';
                return '<tr class="border-t' + (included ? '' : ' opacity-50') + '">' +
                    '<td class="px-3 py-2 text-center">' + cb + '</td>' +
                    '<td class="px-3 py-2">' + outcome + perRowLink + '</td>' +
                    '<td class="px-3 py-2">' + esc(r.name) + '</td>' +
                    idCell +
                    midCell +
                    '<td class="px-3 py-2 text-end">' + Math.round((r.completeness || 0) * 100) + '%</td>' +
                    '<td class="px-3 py-2 text-xs text-gray-500">' + esc(r.owner) + '</td>' +
                    '<td class="px-3 py-2 text-xs text-gray-700">' + esc(r.layout) + '</td>' +
                    '</tr>';
            }).join('');

            const decRows = (plan.fieldDecisions || []).map(d => {
                const tone = d.action === 'fill' ? 'bg-green-50' : 'bg-amber-50';
                const badge = d.action === 'fill'
                    ? '<span class="px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs font-medium">FILL</span>'
                    : '<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">CONFLICT</span>';
                const alts = (d.alternatives || []).map(a => esc(a.recordName) + ': ' + esc(a.value)).join(' · ');
                return '<tr class="border-t ' + tone + '">' +
                    '<td class="px-3 py-2 font-medium">' + esc(d.label) + '</td>' +
                    '<td class="px-3 py-2">' + badge + '</td>' +
                    '<td class="px-3 py-2">' + esc(d.chosenValue) + '</td>' +
                    '<td class="px-3 py-2 text-xs text-gray-500">' + esc(d.reason) + (alts ? '<div class="mt-1 text-gray-400">alt: ' + alts + '</div>' : '') + '</td>' +
                    '</tr>';
            }).join('');

            const warns = (plan.warnings || []).length
                ? '<ul class="list-disc ms-5 mt-1 space-y-1 text-amber-800">' + plan.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>'
                : '<span class="text-gray-400">None</span>';

            // Survivor headline — render the master Zoho id as a clickable
            // CRM link so the operator can open the surviving record in one
            // click instead of copying the id and pasting it into Zoho.
            const survivorTab = plan.module === 'Deals' ? 'Potentials' : plan.module;
            const survivorIdLink = plan.masterZohoId
                ? ' <span class="ms-1">' + zohoLink(plan.masterZohoId, survivorTab) + '</span>'
                : '';
            // Reparent-preview slot — lazily filled by loadReparentPreview
            // after Zoho returns. Only Accounts/Contacts merges have child
            // records to repoint; the slot stays empty otherwise.
            const reparentSlot = (plan.module === 'Accounts' || plan.module === 'Contacts')
                ? '<div class="mb-3 p-2 rounded-lg border border-indigo-100 bg-indigo-50 text-xs text-indigo-900"><span class="uppercase tracking-wide text-indigo-700 font-semibold">Cascade to survivor</span> · <span id="reparent-preview-' + esc(plan.module) + '">Checking Zoho related records…</span></div>'
                : '';
            // Account pop-up only — list the Deals under each Account and move
            // any Deal to another Account in this cluster (sets Account_Name).
            const accountDealsMover = (plan.module === 'Accounts')
                ? '<div class="mb-3 p-2 rounded-lg border border-emerald-100 bg-emerald-50">'
                    + '<button data-on-click="loadAccountDealsMover" data-args=\'[' + plan.clusterId + ']\' class="text-xs font-semibold text-emerald-800 hover:underline" title="List the Deals under each Account and move any Deal to another Account in this cluster (sets Account_Name in Zoho).">💼 Move deals between these accounts ▾</button>'
                    + '<div id="accountDealsPanel-' + plan.clusterId + '" class="mt-2"></div>'
                    + '</div>'
                : '';
            // LINK-ONLY copy overrides — applied when 0 contacts qualify as
            // duplicates of the survivor. Sarah Hijazi (2026-06-10): "no
            // merge action here — it shall be Link, not Merge". When this
            // fires, the modal swaps "Merge" for "Link" everywhere (header
            // banner, instruction, table column, Apply button, footer).
            const headerBanner = linkOnlyMode
                ? '<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 mb-3 text-sm text-emerald-900" data-testid="merge-plan-rationale"><strong>🔗 Link-only plan.</strong> None of these contacts share ≥2 of {email, phone, name} with the surviving contact — they are NOT duplicates of each other (different people at the same Account). On Apply, every contact\'s <code class="bg-white px-1 rounded">Account_Name</code> is updated to the chosen Account. <strong>No record is tagged Duplicate-Delete; no record is deleted.</strong></div>'
                : '<div class="rounded-lg border border-purple-200 bg-purple-50 p-3 mb-3 text-sm text-purple-900" data-testid="merge-plan-rationale">' + esc(plan.rationale) + '</div>';
            const instructionLine = linkOnlyMode
                ? '<div class="text-xs text-gray-500 mb-1">Tick the contacts to include in the link cascade. Unticked contacts are left completely untouched.</div>'
                : '<div class="text-xs text-gray-500 mb-1">Tick the accounts to merge — at least 2. Unticked accounts are excluded and left untouched.</div>';
            const mergeColHeader = linkOnlyMode
                ? '<th scope="col" class="px-3 py-2 text-start" title="Include this contact in the link cascade">Link</th>'
                : '<th scope="col" class="px-3 py-2 text-start">Merge</th>';
            const applyBtn = linkOnlyMode
                ? '<button data-on-click="applyMergePlan" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' data-testid="button-apply-merge-' + plan.module + '-' + plan.clusterId + '" class="px-4 py-2 bg-emerald-700 text-white hover:bg-emerald-800 rounded-lg text-sm font-semibold">🔗 Link contacts in Zoho</button>'
                : '<button data-on-click="applyMergePlan" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' data-testid="button-apply-merge-' + plan.module + '-' + plan.clusterId + '" class="px-4 py-2 bg-purple-700 text-white hover:bg-purple-800 rounded-lg text-sm font-semibold">⚡ Apply in Zoho</button>';
            const trailingNote = linkOnlyMode
                ? '<span class="text-xs text-gray-500">Apply only writes <code class="bg-gray-100 px-1 rounded">Account_Name</code> on each contact. No tagging, no deletion.</span>'
                : '<span class="text-xs text-gray-400">Apply migrates fields, reparents Deals/Contacts/Notes, and tags duplicates <code class="bg-gray-100 px-1 rounded">Duplicate-Delete</code>. No deletions.</span>';
            // FORCE-MERGE override — only for Contacts where the ≥2-attribute rule
            // soft-excluded some (link-only or cascade-only). Lets the operator
            // tag verified same-person contacts that share only 1 signal.
            const hasSoftExcluded = isContacts && (linkOnlyMode || (Array.isArray(plan.cascadeOnlyZohoIds) && plan.cascadeOnlyZohoIds.length > 0));
            const forceBtn = hasSoftExcluded
                ? '<button data-on-click="forceMergePlan" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' title="Override the ≥2-attribute rule: MERGE the TICKED contacts as the same person (for verified cases — e.g. the same person entered twice sharing only a phone). Migrate-then-tag; nothing deleted. Logged in the action timeline." class="px-3 py-2 bg-rose-600 text-white hover:bg-rose-700 rounded-lg text-sm font-semibold">⚠ Force-merge (same person)</button>'
                : '';
            // Contacts-only clarity panel — plain-language email/phone outcome so
            // a multi-email / multi-phone contact merge is transparent before Apply.
            const cds = (isContacts && plan.contactDataSummary) ? plan.contactDataSummary : null;
            const _cdSlot = (s) => s
                ? (esc(s.value) + (s.from === 'survivor'
                    ? ' <span class="text-[10px] text-gray-500">(survivor — kept)</span>'
                    : ' <span class="text-[10px] text-emerald-700">(from ' + esc(s.from) + ')</span>'))
                : '<span class="text-gray-400">—</span>';
            const _cdExtras = (arr, label) => (arr && arr.length)
                ? '<div class="text-[11px] text-amber-700 mt-1">⚠ ' + arr.length + ' more ' + label + ' can\'t be stored (Zoho holds 2) — capture manually: ' + arr.map(x => esc(x.value)).join(', ') + '</div>'
                : '';
            const contactDataPanel = cds
                ? '<div class="mb-3 p-3 rounded-lg border border-teal-200 bg-teal-50">'
                    + '<div class="text-xs uppercase tracking-wide text-teal-800 font-semibold mb-2">📇 Emails &amp; phones after this merge — nothing is lost</div>'
                    + '<div class="grid grid-cols-1 md:grid-cols-2 gap-3">'
                    + '<div><div class="text-xs font-semibold text-gray-700 mb-1">✉️ Emails</div>'
                    +   '<div class="text-xs mb-0.5"><span class="text-gray-500">Email (primary):</span> ' + _cdSlot(cds.emails.primary) + '</div>'
                    +   '<div class="text-xs"><span class="text-gray-500">Secondary_Email:</span> ' + _cdSlot(cds.emails.secondary) + '</div>'
                    +   _cdExtras(cds.emails.extras, 'email(s)')
                    + '</div>'
                    + '<div><div class="text-xs font-semibold text-gray-700 mb-1">📞 Phones</div>'
                    +   '<div class="text-xs mb-0.5"><span class="text-gray-500">Phone (primary):</span> ' + _cdSlot(cds.phones.phone) + '</div>'
                    +   '<div class="text-xs"><span class="text-gray-500">Mobile:</span> ' + _cdSlot(cds.phones.mobile) + '</div>'
                    +   _cdExtras(cds.phones.extras, 'number(s)')
                    + '</div>'
                    + '</div>'
                    + '<div class="text-[11px] text-gray-500 mt-2">Blank survivor fields are filled from the duplicates. Duplicates are tagged Duplicate-Delete for the admin — the platform deletes nothing.</div>'
                + '</div>'
                : '';
            return '' +
                headerBanner +
                '<div class="mb-3"><span class="text-xs uppercase tracking-wide text-gray-500">' + (linkOnlyMode ? 'Surviving contact' : 'Survivor') + '</span><div class="font-semibold">' + esc(plan.masterName) + survivorIdLink + ' <span class="font-normal text-gray-500 text-xs">' + esc(plan.masterReason) + '</span></div></div>' +
                contactDataPanel +
                reparentSlot +
                accountDealsMover +
                linkControl +
                instructionLine +
                '<div class="overflow-x-auto mb-4"><table class="min-w-full text-sm"><thead><tr class="text-xs text-gray-500">' + mergeColHeader + '<th scope="col" class="px-3 py-2 text-start">Outcome</th><th scope="col" class="px-3 py-2 text-start">Record</th><th scope="col" class="px-3 py-2 text-start">Zoho ID</th>' + (
                    isContacts
                        ? '<th scope="col" class="px-3 py-2 text-start" title="Zoho Contacts → Account_Name (parent Account this contact is linked to)">Account</th>'
                        : plan.module === 'Accounts'
                            ? '<th scope="col" class="px-3 py-2 text-center" title="Number of Deals linked to each Account in Zoho. Stronger survivor signal than attachment counts — the Account with the bigger Deals book is usually the one to keep.">Deals</th>'
                            : plan.module === 'Deals'
                                ? '<th scope="col" class="px-3 py-2 text-start" title="Deal Stage in Zoho — check each deal\'s stage before merging an open/won deal away">Stage</th>'
                                : '<th scope="col" class="px-3 py-2 text-center" title="Attachments on the record (📎)">📎</th>'
                ) + '<th scope="col" class="px-3 py-2 text-end">Complete</th><th scope="col" class="px-3 py-2 text-start">Owner</th><th scope="col" class="px-3 py-2 text-start">Layout</th></tr></thead><tbody>' + recRows + '</tbody></table></div>' +
                (linkOnlyMode
                    ? ''
                    : '<div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Field migrations &amp; conflicts (' + (plan.fieldDecisions || []).length + ')</div>' +
                      (decRows
                        ? '<div class="overflow-x-auto mb-4"><table class="min-w-full text-sm"><thead><tr class="text-xs text-gray-500"><th scope="col" class="px-3 py-2 text-start">Field</th><th scope="col" class="px-3 py-2 text-start">Action</th><th scope="col" class="px-3 py-2 text-start">Value kept</th><th scope="col" class="px-3 py-2 text-start">Why</th></tr></thead><tbody>' + decRows + '</tbody></table></div>'
                        : '<div class="text-gray-400 text-sm mb-4">No field changes needed — survivor already holds all values.</div>')) +
                '<div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Warnings</div><div class="text-sm mb-3">' + warns + '</div>' +
                '<div class="flex flex-wrap items-center gap-2 border-t pt-3">' +
                    '<button data-on-click="dryRunMergePlan" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' data-testid="button-dryrun-merge-' + plan.module + '-' + plan.clusterId + '" class="px-3 py-2 bg-white border border-purple-300 text-purple-700 hover:bg-purple-50 rounded-lg text-sm font-medium">Dry-run (no writes)</button>' +
                    applyBtn +
                    forceBtn +
                    '<button data-on-click="splitMergeSelection" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' title="Move the TICKED records into a brand-new cluster — for name-collision false positives (two real companies sharing a word, e.g. Andalusia Group vs Andalusia Hospital). No Zoho changes; they just become a separate cluster to resolve." class="px-3 py-2 bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 rounded-lg text-sm font-medium">✂️ Split ticked → new cluster</button>' +
                    '<button data-on-click="splitClusterByName" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' title="Auto-detect the distinct company-name groups and split each into its own cluster (largest stays here). One click for name-collision clusters like Andalusia Group vs Andalusia Hospital. No Zoho changes." class="px-3 py-2 bg-white border border-amber-300 text-amber-800 hover:bg-amber-50 rounded-lg text-sm font-medium">🪪 Split by company name</button>' +
                    '<button data-on-click="dismissCluster" data-args=\'["' + esc(plan.module) + '",' + plan.clusterId + ']\' title="Dismiss this whole cluster as a false positive — intentionally separate records (e.g. a Corporate-Accounts account vs a Marketplace account). Moves it to the Dismissed filter; no merge, no Zoho changes." class="px-3 py-2 bg-white border border-gray-400 text-gray-700 hover:bg-gray-100 rounded-lg text-sm font-medium">🚫 Dismiss (false positive)</button>' +
                    trailingNote +
                '</div>' +
                '<div id="mergeExecPanel-' + esc(plan.module) + '" class="text-sm mt-3"></div>' +
                '<div class="text-xs text-gray-400 mt-2">Generated ' + esc(plan.generatedAt) + ' · by ' + esc(plan.generatedBy) + '</div>';
        }

        // Dismiss a cluster from the list as a false positive (status=ignored).
        // For intentionally-separate accounts (e.g. a Corporate-Accounts account
        // and a Marketplace account — Sales B2B/B2C vs Merchants). Uses the
        // admin SESSION (no key prompt); falls back to a key prompt if needed.
        // Verify-in-CRM resolve: re-query Zoho for the cluster's Duplicate-Delete
        // records and mark the cluster Resolved ONLY if the admin has actually
        // deleted every one. This is the trustworthy replacement for the manual
        // "Mark Resolved" — a cluster is only "done" once the CRM proves it.
        async function verifyAndResolveCluster(module, clusterId) {
            let res, data;
            try {
                res = await fetch('/api/duplicates/clusters/' + clusterId + '/verify-tags', { credentials: 'same-origin' });
                data = await res.json().catch(() => null);
            } catch (e) {
                alert('Could not reach server to verify: ' + (e && e.message || e));
                return;
            }
            if (!res.ok || !data) {
                alert('Verify failed: ' + ((data && data.error) || ('HTTP ' + res.status)));
                return;
            }
            if (data.message || (data.total || 0) === 0) {
                alert(data.message || 'No tagged duplicates on this cluster yet — run Apply first, then have the Zoho admin delete the tagged records.');
                return;
            }
            const total = data.total || 0, deleted = data.deleted || 0, alive = data.alive || 0, errors = data.errors || 0;
            if (errors > 0) {
                alert('Could not verify ' + errors + ' of ' + total + ' tagged record(s) (Zoho error). Try again in a moment — not marking Resolved until every record is confirmed.');
                return;
            }
            if (alive > 0) {
                alert(deleted + ' of ' + total + ' tagged duplicate(s) have been deleted in Zoho.\n\n' + alive + ' are STILL in Zoho — the admin hasn\'t removed these yet. Open the cluster to see which records, share them with the admin, and re-run Verify once deleted.\n\nNot marked Resolved.');
                return;
            }
            // All tagged duplicates confirmed deleted → mark Resolved (verified).
            if (!confirm('✓ All ' + total + ' tagged duplicate(s) are confirmed deleted in Zoho.\n\nMark this cluster Resolved? (Reversible via Re-open.)')) return;
            const payload = JSON.stringify({ action: 'resolve', notes: 'Verified in CRM: all ' + total + ' Duplicate-Delete record(s) confirmed deleted in Zoho by the admin.' });
            try {
                let r2 = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (r2.status === 401 || r2.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    r2 = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const d2 = await r2.json();
                if (!r2.ok || !d2.success) throw new Error((d2 && d2.error) || ('HTTP ' + r2.status));
                if (typeof closeModal === 'function') { try { closeModal(); } catch (e) {} }
                var tab = String(module || '').toLowerCase();
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (tab === 'cross-module' && typeof loadCrossModule === 'function') {
                    loadCrossModule();
                } else if (typeof refreshData === 'function') { refreshData(); }
            } catch (e) {
                alert('Verified deleted, but could not mark Resolved: ' + (e && e.message || e));
            }
        }

        // Bulk Verify-in-CRM: check ALL AI-Applied clusters in a module at once
        // and resolve every one whose Duplicate-Delete records the admin has
        // fully deleted. For when a batch is cleared in Zoho. Server-side +
        // bounded, so one click can't fan out into thousands of Zoho calls.
        async function bulkVerifyResolveInCRM(module) {
            const mod = ({ leads: 'Leads', deals: 'Deals', contacts: 'Contacts', accounts: 'Accounts' })[String(module || '').toLowerCase()] || null;
            const btn = document.getElementById('verifyAllCrm-' + String(module || '').toLowerCase());
            if (!confirm('Verify all AI-Applied ' + (mod || '') + ' clusters against Zoho?\n\nThis checks each cluster\'s Duplicate-Delete records in the CRM and marks Resolved ONLY the ones the admin has fully deleted. Clusters with records still in Zoho are left untouched. No Zoho changes are made.')) return;
            const origLabel = btn ? btn.textContent : '';
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Verifying…'; }
            const payload = JSON.stringify({ module: mod, maxClusters: 50 });
            try {
                let res = await fetch('/api/duplicates/verify-resolve-applied', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) { if (btn) { btn.disabled = false; btn.textContent = origLabel; } return; }
                    res = await fetch('/api/duplicates/verify-resolve-applied', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                let msg = 'Checked ' + data.checked + ' AI-Applied cluster(s):\n'
                    + '• ' + data.resolved + ' fully deleted in Zoho → marked Resolved\n'
                    + '• ' + data.pending + ' still have records in Zoho → left open\n'
                    + (data.errored ? ('• ' + data.errored + ' had Zoho errors → left open (retry later)\n') : '');
                if (data.more) msg += '\nThere are more AI-Applied clusters than processed this run — click again to continue.';
                alert(msg);
                var tab = String(module || '').toLowerCase();
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (typeof refreshData === 'function') { refreshData(); }
            } catch (e) {
                alert('Bulk verify failed: ' + (e && e.message || e));
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = origLabel; }
            }
        }

        async function dismissCluster(module, clusterId) {
            if (!confirm('Dismiss this cluster as a false positive?\n\nUse this when the records are intentionally separate accounts (e.g. a Corporate-Accounts account and a Marketplace account). It moves to the "Dismissed" filter and stops appearing as a duplicate to action.\n\nNo Zoho changes.')) return;
            const payload = JSON.stringify({ action: 'ignore', notes: 'Dismissed from list — intentional separate accounts (e.g. different layout: Corporate Accounts vs Marketplace).' });
            try {
                let res = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                        body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                // Close the merge-plan modal if it's open (harmless from a list row).
                if (typeof closeModal === 'function') { try { closeModal(); } catch (e) {} }
                var tab = String(module || '').toLowerCase();
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (tab === 'cross-module' && typeof loadCrossModule === 'function') {
                    loadCrossModule();
                } else if (typeof refreshData === 'function') {
                    refreshData();
                }
            } catch (e) {
                alert('Could not dismiss: ' + (e && e.message || e));
            }
        }

        // Re-open a resolved/dismissed cluster (set status back to active) so it
        // can be merged. For clusters marked resolved before they were actually
        // merged in Zoho, or dismissed by mistake.
        async function reopenCluster(module, clusterId) {
            if (!confirm('Re-open this cluster so you can merge it?\n\nUse this if it was marked Resolved/Dismissed but the records still need merging. It returns to the active "Untouched" list. No Zoho changes.')) return;
            const payload = JSON.stringify({ action: 'reopen' });
            try {
                let res = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/clusters/' + clusterId + '/resolve', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                if (typeof closeModal === 'function') { try { closeModal(); } catch (e) {} }
                var tab = String(module || '').toLowerCase();
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (tab === 'cross-module' && typeof loadCrossModule === 'function') {
                    loadCrossModule();
                } else if (typeof refreshData === 'function') { refreshData(); }
            } catch (e) {
                alert('Could not re-open: ' + (e && e.message || e));
            }
        }

        // ── Bulk dismiss — tick cluster checkboxes, dismiss them all at once ──
        window._dupBulkSel = window._dupBulkSel || new Set();
        function toggleDupBulk(module, clusterId) {
            window._dupBulkSel = window._dupBulkSel || new Set();
            const k = String(clusterId);
            if (window._dupBulkSel.has(k)) window._dupBulkSel.delete(k); else window._dupBulkSel.add(k);
            _renderDupBulkBar();
        }
        function _renderDupBulkBar() {
            const bar = document.getElementById('dupBulkBar');
            const n = (window._dupBulkSel && window._dupBulkSel.size) || 0;
            const cnt = document.getElementById('dupBulkCount');
            if (cnt) cnt.textContent = n;
            // Show the bulk bar ONLY when at least one cluster is selected — so it
            // never floats over the rows at "0 selected". To start a bulk action,
            // tick any row's checkbox (always available); the bar then appears with
            // "Select all on page" + Re-open / Dismiss. (Previously it was forced
            // visible on the Dismissed/Resolved filters, which covered content.)
            if (bar) {
                if (n > 0) { bar.classList.remove('hidden'); bar.classList.add('flex'); }
                else { bar.classList.add('hidden'); bar.classList.remove('flex'); }
            }
        }
        function clearDupBulk() {
            window._dupBulkSel = new Set();
            document.querySelectorAll('.dup-bulk-cb').forEach(function (cb) { cb.checked = false; });
            _renderDupBulkBar();
        }
        // Tick every cluster checkbox currently rendered on this page.
        function selectAllDupOnPage() {
            window._dupBulkSel = window._dupBulkSel || new Set();
            document.querySelectorAll('.dup-bulk-cb').forEach(function (cb) {
                const cid = cb.getAttribute('data-cid');
                if (cid) { window._dupBulkSel.add(String(cid)); cb.checked = true; }
            });
            _renderDupBulkBar();
        }
        // Bulk re-open selected clusters — recover ones dismissed/resolved by mistake.
        async function bulkReopenSelected() {
            const ids = Array.from(window._dupBulkSel || []).map(Number).filter(function (x) { return Number.isFinite(x); });
            if (!ids.length) { alert('Select at least one cluster (tick the checkboxes or "Select all on page").'); return; }
            if (!confirm('Re-open ' + ids.length + ' selected cluster(s)?\n\nThey return to the active "Untouched" list so you can action them. No Zoho changes.')) return;
            const payload = JSON.stringify({ cluster_ids: ids, action: 'reopen' });
            try {
                let res = await fetch('/api/duplicates/bulk-resolve', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/bulk-resolve', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                window._dupBulkSel = new Set();
                _renderDupBulkBar();
                var tab = window._currentTab || 'accounts';
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (typeof refreshData === 'function') { refreshData(); }
            } catch (e) {
                alert('Could not re-open selected: ' + (e && e.message || e));
            }
        }
        async function bulkDismissSelected() {
            const ids = Array.from(window._dupBulkSel || []).map(Number).filter(function (x) { return Number.isFinite(x); });
            if (!ids.length) return;
            if (!confirm('Dismiss ' + ids.length + ' selected cluster(s) as false positives?\n\nThey move to the "Dismissed" filter and stop appearing as duplicates to action. No Zoho changes.')) return;
            const payload = JSON.stringify({ cluster_ids: ids, action: 'ignore' });
            try {
                let res = await fetch('/api/duplicates/bulk-resolve', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: payload
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/bulk-resolve', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }, body: payload
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                window._dupBulkSel = new Set();
                _renderDupBulkBar();
                var tab = window._currentTab || 'accounts';
                if (['leads','deals','contacts','accounts'].includes(tab)) {
                    window._loadedTabs && window._loadedTabs.delete(tab);
                    loadRecordTab(tab, 0);
                } else if (typeof refreshData === 'function') { refreshData(); }
            } catch (e) {
                alert('Could not dismiss selected: ' + (e && e.message || e));
            }
        }

        async function resolveClusterAction(clusterId, action) {
            const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
            if (!adminKey) return;
            const res = await fetch(`/api/duplicates/clusters/${clusterId}/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                body: JSON.stringify({ action })
            });
            const data = await res.json();
            if (data.success) {
                alert(action === 'resolve' ? WalaPlusI18n.t('dyn.duplicates.cluster_resolved') : WalaPlusI18n.t('dyn.duplicates.cluster_ignored'));
                closeModal();
                refreshData();
            } else {
                alert(data.error || WalaPlusI18n.t('dyn.duplicates.failed_action'));
            }
        }


        function closeModal() { document.getElementById('clusterModal').classList.add('hidden'); }

        // ----- Generic "View All" list modal (Top Signals + Top Inflation) -----
        function openListModal(title, subtitle) {
            document.getElementById('listModalTitle').textContent = title;
            document.getElementById('listModalSubtitle').textContent = subtitle || '';
            document.getElementById('listModalBody').innerHTML = `<div class="text-center text-gray-400 py-8">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.loading_dots'))}</div>`;
            document.getElementById('listModal').classList.remove('hidden');
        }
        function closeListModal() { document.getElementById('listModal').classList.add('hidden'); }

        function renderClusterListRows(clusters, opts = {}) {
            if (!clusters || clusters.length === 0) {
                return `<p class="text-sm text-gray-400 text-center py-6">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_clusters_found_dot'))}</p>`;
            }
            const showInflation = opts.showInflation !== false;
            const rows = clusters.map((c, i) => {
                const name = c.company_name || c.company_name_arabic || c.domain || 'Unknown';
                const moduleParts = [];
                if (c.total_accounts) moduleParts.push(WalaPlusI18n.t('dyn.duplicates.acc_short', { n: _fn(c.total_accounts) }));
                if (c.total_contacts) moduleParts.push(WalaPlusI18n.t('dyn.duplicates.con_short', { n: _fn(c.total_contacts) }));
                if (c.total_deals) moduleParts.push(WalaPlusI18n.t('dyn.duplicates.deal_short', { n: _fn(c.total_deals) }));
                if (c.total_leads) moduleParts.push(WalaPlusI18n.t('dyn.duplicates.lead_short', { n: _fn(c.total_leads) }));
                const breakdown = moduleParts.join(' · ');
                const conf = c.confidence_score != null ? `${c.confidence_score}%` : '—';
                const status = c.status || 'active';
                const statusClr = status === 'resolved' ? 'bg-green-100 text-green-800'
                    : status === 'ignored' ? 'bg-gray-100 text-gray-700'
                    : 'bg-blue-100 text-blue-800';
                return `<tr class="border-t hover:bg-gray-50 cursor-pointer" data-on-click="closeListModal,showClusterDetails" data-args="[[],[${c.id}]]" data-testid="row-list-cluster-${c.id}">
                    <td class="px-3 py-2 text-xs text-gray-400 text-end">${i + 1}</td>
                    <td class="px-3 py-2 text-sm font-medium text-gray-800">${escapeHtml(name)}<div class="text-xs text-gray-400">${escapeHtml(c.domain || '')}</div></td>
                    <td class="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.n_records_short', { n: _fn(c.total_records) }))}${breakdown ? ` <span class="text-gray-400">(${escapeHtml(breakdown)})</span>` : ''}</td>
                    <td class="px-3 py-2 text-xs text-center"><span class="px-2 py-0.5 rounded ${statusClr}">${escapeHtml(status)}</span></td>
                    <td class="px-3 py-2 text-xs text-center font-semibold text-gray-700">${conf}</td>
                    ${showInflation ? `<td class="px-3 py-2 text-sm font-bold text-purple-600 text-end whitespace-nowrap">${formatCurrency(c.estimated_pipeline_value || 0)}</td>` : ''}
                </tr>`;
            }).join('');
            return `<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-500"><tr>
                <th scope="col" class="px-3 py-2 text-end">#</th>
                <th scope="col" class="px-3 py-2 text-start">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_cluster'))}</th>
                <th scope="col" class="px-3 py-2 text-start">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_records'))}</th>
                <th scope="col" class="px-3 py-2 text-center">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_status'))}</th>
                <th scope="col" class="px-3 py-2 text-center">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_score'))}</th>
                ${showInflation ? `<th scope="col" class="px-3 py-2 text-end">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_inflation'))}</th>` : ''}
            </tr></thead><tbody>${rows}</tbody></table></div>`;
        }

        async function openInflationListModal() {
            openListModal(WalaPlusI18n.t('dyn.duplicates.modal_inflation_title'), WalaPlusI18n.t('dyn.duplicates.modal_inflation_subtitle'));
            try {
                const res = await fetch('/api/duplicates/clusters-by-inflation?limit=500');
                const data = await res.json();
                const clusters = data.clusters || [];
                const totalInflation = clusters.reduce((s, c) => s + parseFloat(c.estimated_pipeline_value || 0), 0);
                document.getElementById('listModalSubtitle').textContent = WalaPlusI18n.t('dyn.duplicates.inflation_summary', { n: _fn(clusters.length), val: formatCurrency(totalInflation) });
                document.getElementById('listModalBody').innerHTML = renderClusterListRows(clusters, { showInflation: true });
            } catch (e) {
                document.getElementById('listModalBody').innerHTML = `<p class="text-sm text-red-600 text-center py-6">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.load_failed', { err: e.message }))}</p>`;
            }
        }

        async function openClustersBySignalModal(signal, label) {
            openListModal(WalaPlusI18n.t('dyn.duplicates.modal_signal_title', { label: label }), WalaPlusI18n.t('dyn.duplicates.modal_signal_subtitle', { key: signal }));
            try {
                const res = await fetch(`/api/duplicates/clusters-by-signal/${encodeURIComponent(signal)}?limit=500`);
                const data = await res.json();
                const clusters = data.clusters || [];
                document.getElementById('listModalSubtitle').textContent = WalaPlusI18n.t('dyn.duplicates.signal_match_count', { n: _fn(clusters.length), label: label });
                document.getElementById('listModalBody').innerHTML = renderClusterListRows(clusters, { showInflation: true });
            } catch (e) {
                document.getElementById('listModalBody').innerHTML = `<p class="text-sm text-red-600 text-center py-6">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.load_failed', { err: e.message }))}</p>`;
            }
        }

        async function openSignalsListModal() {
            // Aggregate of every signal type with click-through to per-signal cluster lists.
            openListModal(WalaPlusI18n.t('dyn.duplicates.modal_signals_title'), WalaPlusI18n.t('dyn.duplicates.modal_signals_subtitle'));
            try {
                const res = await fetch('/api/duplicates/summary');
                const data = await res.json();
                const signals = data.topSignals || {};
                const labels = { exact_email: WalaPlusI18n.t('dyn.duplicates.signals.exact_email'), domain_match: WalaPlusI18n.t('dyn.duplicates.signals.domain_match'), phone_match: WalaPlusI18n.t('dyn.duplicates.signals.phone_match'), company_exact: WalaPlusI18n.t('dyn.duplicates.signals.company_exact'), company_fuzzy: WalaPlusI18n.t('dyn.duplicates.signals.company_fuzzy') };
                const colors = { exact_email: 'bg-blue-100 text-blue-800', domain_match: 'bg-green-100 text-green-800', phone_match: 'bg-purple-100 text-purple-800', company_exact: 'bg-amber-100 text-amber-800', company_fuzzy: 'bg-orange-100 text-orange-800' };
                const sorted = Object.entries(signals).sort((a, b) => b[1] - a[1]);
                if (sorted.length === 0) {
                    document.getElementById('listModalBody').innerHTML = `<p class="text-sm text-gray-400 text-center py-6">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.no_signal_data_dot'))}</p>`;
                    return;
                }
                const total = sorted.reduce((s, [, n]) => s + n, 0);
                document.getElementById('listModalSubtitle').textContent = WalaPlusI18n.t('dyn.duplicates.signal_summary', { n: _fn(sorted.length), total: _fn(total) });
                const rows = sorted.map(([key, count]) => {
                    const lbl = labels[key] || key;
                    const clr = colors[key] || 'bg-gray-100 text-gray-700';
                    const pct = Math.round((count / total) * 100);
                    return `<tr class="border-t hover:bg-gray-50 cursor-pointer" data-on-click="openClustersBySignalModal" data-args="${escAttr(JSON.stringify([key, lbl]))}" data-testid="row-signal-detail-${key}">
                        <td class="px-3 py-2"><span class="px-2 py-1 rounded text-xs font-medium ${clr}">${escapeHtml(lbl)}</span></td>
                        <td class="px-3 py-2 text-xs text-gray-500"><code class="bg-gray-100 px-1 rounded">${escapeHtml(key)}</code></td>
                        <td class="px-3 py-2 text-sm text-end font-bold text-gray-700">${_fn(count)}</td>
                        <td class="px-3 py-2 text-xs text-end text-gray-500">${_fn(pct)}%</td>
                        <td class="px-3 py-2 text-xs text-end text-blue-600 font-medium">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.view_clusters'))}</td>
                    </tr>`;
                }).join('');
                document.getElementById('listModalBody').innerHTML = `<div class="overflow-x-auto"><table class="min-w-full text-sm"><thead class="bg-gray-50 text-xs uppercase text-gray-500"><tr>
                    <th scope="col" class="px-3 py-2 text-start">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_signal'))}</th>
                    <th scope="col" class="px-3 py-2 text-start">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_key'))}</th>
                    <th scope="col" class="px-3 py-2 text-end">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_hits'))}</th>
                    <th scope="col" class="px-3 py-2 text-end">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.table_header_share'))}</th>
                    <th scope="col" class="px-3 py-2 text-end"></th>
                </tr></thead><tbody>${rows}</tbody></table></div>`;
            } catch (e) {
                document.getElementById('listModalBody').innerHTML = `<p class="text-sm text-red-600 text-center py-6">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.load_failed', { err: e.message }))}</p>`;
            }
        }
        // close on backdrop click
        document.addEventListener('DOMContentLoaded', () => {
            const lm = document.getElementById('listModal');
            if (lm) lm.addEventListener('click', (e) => { if (e.target === lm) closeListModal(); });

            // (Export Center tab removed — its size-hint listener used to
            // live here. Per-tab "⬇ Export CSV" buttons stream directly
            // via exportTab() without a pre-flight estimate.)

            // Wire the Advanced-Filters Segment dropdown so changing it via
            // the dropdown updates the chip and re-runs the active tab —
            // matches the behaviour of clicking the chips at the top.
            const segDD = document.getElementById('filterSegment');
            if (segDD && typeof setSegment === 'function') {
                segDD.addEventListener('change', (e) => {
                    const v = (e.target && e.target.value) || 'all';
                    setSegment(v);
                });
            }
        });

        // D1: Scan with progress bar
        async function scanZohoCRM() {
            const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key_scan'));
            if (!adminKey) return;

            const btn = document.getElementById('scanZohoBtn');
            btn.disabled = true;
            btn.textContent = WalaPlusI18n.t('dyn.duplicates.scanning');

            try {
                const res = await fetch('/api/duplicates/scan-zoho', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }
                });
                const data = await res.json();
                if (!data.success && data.error) {
                    alert(data.error);
                    btn.disabled = false;
                    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg> Scan from Zoho';
                    return;
                }

                // Show progress bar
                document.getElementById('scanProgressBar').classList.remove('hidden');
                startScanPolling();
            } catch (e) {
                alert(WalaPlusI18n.t('dyn.duplicates.error_starting_scan'));
                btn.disabled = false;
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg> ' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.scan_zoho_btn'));
            }
        }

        async function rebuildClusters() {
            const confirmed = confirm(WalaPlusI18n.t('dyn.duplicates.rebuild_confirm_full'));
            if (!confirmed) return;

            const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key_rebuild'));
            if (!adminKey) return;

            const btn = document.getElementById('rebuildBtn');
            btn.disabled = true;
            btn.textContent = WalaPlusI18n.t('dyn.duplicates.rebuild_starting');

            try {
                const res = await fetch('/api/duplicates/rebuild', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey }
                });
                const data = await res.json();
                if (!data.success) {
                    alert(data.error || WalaPlusI18n.t('dyn.duplicates.failed_rebuild'));
                    btn.disabled = false;
                    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg> ' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.rebuild_clusters_btn'));
                    return;
                }

                document.getElementById('scanProgressBar').classList.remove('hidden');
                document.getElementById('scanProgressText').textContent = WalaPlusI18n.t('dyn.duplicates.tables_wiped');
                startScanPolling();
            } catch (e) {
                alert(WalaPlusI18n.t('dyn.duplicates.error_rebuild'));
                btn.disabled = false;
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg> ' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.rebuild_clusters_btn'));
            }
        }

        // R7: real-time scan progress via SSE. Function name kept ("startScanPolling")
        // so existing callers (scanZohoCRM, rebuildClusters, syncNowZohoCRM) don't
        // need to change. Internally it now opens an EventSource on
        // /api/duplicates/scan-stream, which the server already emits to.
        //
        // Events handled:
        //   connected   — initial state snapshot when EventSource attaches
        //   progress    — { percentage, message } during scan
        //   module      — { module, status, count? } per-module updates
        //   scan        — { status: 'started' | 'completed' | 'failed', timestamp }
        //
        // The elapsed-time ticker runs locally at 1 Hz so the seconds counter
        // ticks smoothly between server events instead of jumping every 2s.
        function startScanPolling() {
            closeScanProgressSse();
            scanRunning = true;
            scanStartedAt = Date.now();
            startElapsedTicker();

            const updateProgressFromSnapshot = (data) => {
                if (!data || typeof data !== 'object') return;
                if (typeof data.progress === 'string') {
                    document.getElementById('scanProgressText').textContent = data.progress;
                }
                if (typeof data.percentage === 'number') {
                    document.getElementById('scanPct').textContent = _fn(data.percentage) + '%';
                    document.getElementById('scanProgressFill').style.width = data.percentage + '%';
                }
                if (typeof data.elapsedMs === 'number' && data.elapsedMs > 0) {
                    // Server-reported elapsed beats local ticker on refresh-mid-scan
                    // (we may have just attached SSE and don't know scanStartedAt).
                    scanStartedAt = Date.now() - data.elapsedMs;
                    document.getElementById('scanElapsed').textContent =
                        _fn(Math.round(data.elapsedMs / 1000)) + 's';
                }
                if (data.moduleStatuses) {
                    renderModuleChips(data.moduleStatuses, data.recordCounts || {});
                }
            };

            const updateModule = (moduleName, status, count) => {
                const chips = document.getElementById('moduleChips');
                if (!chips) return;
                const existing = chips.querySelector('[data-module="' + escAttr(moduleName) + '"]');
                const label = escapeHtml(moduleName) + ': ' + escapeHtml(status) +
                    (typeof count === 'number' ? ' (' + _fn(count) + ')' : '');
                const html = '<span class="module-chip module-' + escAttr(status) +
                    '" data-module="' + escAttr(moduleName) + '">' + label + '</span>';
                if (existing) {
                    existing.outerHTML = html;
                } else {
                    chips.insertAdjacentHTML('beforeend', html);
                }
            };

            const finishScan = (status, errorMessage) => {
                closeScanProgressSse();
                stopElapsedTicker();
                scanRunning = false;
                if (status === 'failed') {
                    // Pull the error message from /scan-status if the SSE event
                    // didn't include one, then show it as a visible banner on
                    // the progress bar so users don't have to guess why the
                    // header just stopped spinning.
                    const showFailure = (msg) => {
                        const text = String(msg || 'Scan failed. Check server logs for details.');
                        const bar = document.getElementById('scanProgressBar');
                        const progressText = document.getElementById('scanProgressText');
                        if (progressText) progressText.textContent = text;
                        if (bar) {
                            bar.classList.remove('hidden');
                            bar.classList.remove('bg-blue-50', 'border-blue-200');
                            bar.classList.add('bg-red-50', 'border-red-300');
                        }
                        const fill = document.getElementById('scanProgressFill');
                        if (fill) {
                            fill.style.width = '100%';
                            fill.classList.remove('bg-blue-600');
                            fill.classList.add('bg-red-500');
                        }
                        // Stay visible — failure is information, not noise.
                        // Users dismiss it by triggering another scan.
                    };
                    if (errorMessage) {
                        showFailure(errorMessage);
                    } else {
                        fetch('/api/duplicates/scan-status')
                            .then(r => r.json())
                            .then(d => showFailure(d?.error || d?.progress))
                            .catch(() => showFailure(null));
                    }
                } else {
                    setTimeout(() => {
                        document.getElementById('scanProgressBar').classList.add('hidden');
                    }, 3000);
                }
                const btn = document.getElementById('scanZohoBtn');
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg> ' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.scan_zoho_btn'));
                }
                if (status === 'completed') refreshData();
            };

            const sse = new EventSource('/api/duplicates/scan-stream');
            scanProgressSse = sse;

            sse.addEventListener('connected', (e) => {
                try { updateProgressFromSnapshot(JSON.parse(e.data)); } catch {}
            });
            sse.addEventListener('progress', (e) => {
                try {
                    const d = JSON.parse(e.data);
                    if (typeof d.percentage === 'number') {
                        document.getElementById('scanPct').textContent = _fn(d.percentage) + '%';
                        document.getElementById('scanProgressFill').style.width = d.percentage + '%';
                    }
                    if (typeof d.message === 'string') {
                        document.getElementById('scanProgressText').textContent = d.message;
                    }
                } catch {}
            });
            sse.addEventListener('module', (e) => {
                try {
                    const d = JSON.parse(e.data);
                    if (d && d.module) updateModule(d.module, d.status, d.count);
                } catch {}
            });
            sse.addEventListener('scan', (e) => {
                try {
                    const d = JSON.parse(e.data);
                    if (d && (d.status === 'completed' || d.status === 'failed')) {
                        finishScan(d.status, d.error);
                    }
                } catch {}
            });
            sse.onerror = () => {
                // Browser will auto-reconnect on transient errors; only fall
                // back to a one-shot status poll if the stream stays down
                // long enough that we suspect the server actually finished.
                fetch('/api/duplicates/scan-status').then(r => r.json()).then(d => {
                    if (d && (d.status === 'completed' || d.status === 'failed')) {
                        finishScan(d.status, d.error);
                    }
                }).catch(() => {});
            };
        }

        function renderModuleChips(modules, recordCounts) {
            const chips = document.getElementById('moduleChips');
            if (!chips) return;
            chips.innerHTML = Object.entries(modules || {}).map(([m, s]) =>
                `<span class="module-chip module-${escAttr(s)}" data-module="${escAttr(m)}">${escapeHtml(m)}: ${escapeHtml(s)}${recordCounts?.[m] ? ' (' + _fn(recordCounts[m]) + ')' : ''}</span>`
            ).join('');
        }

        function closeScanProgressSse() {
            if (scanProgressSse) {
                try { scanProgressSse.close(); } catch {}
                scanProgressSse = null;
            }
        }

        function startElapsedTicker() {
            stopElapsedTicker();
            scanElapsedTicker = setInterval(() => {
                if (!scanRunning || !scanStartedAt) return;
                const secs = Math.round((Date.now() - scanStartedAt) / 1000);
                const el = document.getElementById('scanElapsed');
                if (el) el.textContent = _fn(secs) + 's';
            }, 1000);
        }

        function stopElapsedTicker() {
            if (scanElapsedTicker) {
                clearInterval(scanElapsedTicker);
                scanElapsedTicker = null;
            }
        }

        // R7: if the page is loaded mid-scan (operator refreshed, switched
        // tabs and came back, etc.) silently attach the SSE stream so the
        // progress bar resumes instead of leaving the operator wondering
        // whether a scan is still running.
        async function attachScanProgressIfRunning() {
            try {
                const res = await fetch('/api/duplicates/scan-status');
                const d = await res.json();
                if (d && d.status === 'scanning') {
                    document.getElementById('scanProgressBar')?.classList.remove('hidden');
                    startScanPolling();
                }
            } catch {}
        }

        function exportDataXLSX(event) {
            // Default omits the redundant "All Records" sheet — per-type sheets cover the same
            // data without doubling memory/file size. Add &include_raw=1 manually if you need it.
            const range = getDateRange();
            let url = '/api/duplicates/export-xlsx';
            if (range.from) url += `?start_date=${range.from}`;
            if (range.to) url += (url.includes('?') ? '&' : '?') + `end_date=${range.to}`;
            // Multi-sheet XLSX builds are heavy on both server and client and
            // are a frequent source of mid-download disconnects, so warm up
            // autoResume here. Lighter CSV exports below intentionally keep
            // the default (opt-out) behavior so users on metered/mobile
            // connections aren't surprised by background retries.
            return streamingDownloadFromEvent(event, url, { filename: 'duplicates.xlsx', autoResume: true });
        }

        function exportData(event) {
            const range = getDateRange();
            let url = '/api/duplicates/export?type=all';
            if (range.from) url += `&start_date=${range.from}`;
            if (range.to) url += `&end_date=${range.to}`;
            return streamingDownloadFromEvent(event, url, { filename: 'duplicates-all.csv' });
        }

        // Per-tab CSV export — replaces the standalone Export Center tab.
        // Each tab's green "⬇ Export CSV" button calls this with the
        // record type that tab pivots on ('lead' / 'deal' / 'contact' /
        // 'account' / 'all'). The backend accepts ?record_type=<type>
        // and scopes the duplicate_records WHERE clause to that module;
        // 'all' falls through with no extra filter and exports the
        // full radar. Date filters from the Advanced Filters panel
        // (getDateRange) still apply so an in-progress audit-evidence
        // window is honored even when the user clicks Export from a
        // module tab.
        function exportTab(recordType, event) {
            const allowed = ['lead', 'deal', 'contact', 'account'];
            const safeType = allowed.includes(String(recordType)) ? String(recordType) : 'all';
            const range = getDateRange();
            let url = '/api/duplicates/export?type=all';
            if (safeType !== 'all') url += `&record_type=${safeType}`;
            if (range.from) url += `&start_date=${range.from}`;
            if (range.to) url += `&end_date=${range.to}`;
            const filename = safeType === 'all'
                ? 'duplicates-all.csv'
                : `duplicates-${safeType}s.csv`;
            return streamingDownloadFromEvent(event, url, { filename });
        }

        // ─── Client-side CSV export ──────────────────────────────────────────
        // Tabs whose rows are fully loaded + sorted in the browser (CS Lifecycle,
        // CS Overlap, Account Hints, Cross-Module) export exactly what's on
        // screen — same rows, same columns, same applied sort order and
        // status/verdict/pairing filter — rather than the server's generic
        // full-radar duplicate dump. The server-paginated module tabs
        // (Leads/Deals/Contacts/Accounts) stay on the streaming server export
        // because "the data in the tab" is the full per-type set the server
        // already returns (exporting only the visible page would be worse).
        function csvCell(v) {
            let s = (v === null || v === undefined) ? '' : String(v);
            // CSV-injection hardening: a leading = + - @ can be run as a formula
            // by Excel/Sheets, so neutralize it with a leading apostrophe.
            if (/^[=+\-@]/.test(s)) s = "'" + s;
            if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
            return s;
        }
        function downloadCsvRows(filename, headers, rows) {
            const lines = [headers.map(csvCell).join(',')];
            for (const r of rows) lines.push(r.map(csvCell).join(','));
            // Prepend a UTF-8 BOM so Excel renders Arabic company names correctly.
            const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        function exportCsLifecycle() {
            const data = window._csLifecycleData;
            const violations = (data && data.violations) || [];
            if (!violations.length) { alert('Nothing to export for the current filter.'); return; }
            const groups = groupCsLifecycleByDeal(violations);
            const sorted = sortCsLifecycleRows(groups, window._csLifecycleSort.key, window._csLifecycleSort.dir);
            // CSV keeps BOTH Health and ExtID (Admin) — the dashboard UI
            // replaced Health with ExtID per operator request, but losing
            // Health from the audit-trail export would break downstream
            // reporting. New "ExtID (Admin)" column slotted in next to
            // Health so the file stays self-describing.
            const headers = ['Severity', 'Account', 'Domain', 'Phase', 'CS Owner', 'Customer Since', 'Renewal Date', 'Churn Date', 'Health', 'ExtID (Admin)', 'Days Since Modified', 'Violations', 'Messages'];
            const rows = sorted.map(g => [
                g.worst_severity || '',
                g.account_name || '',
                g.domain || '',
                g.current_phase || '',
                g.cs_owner_name || '',
                g.customer_since || '',
                g.renewal_date || '',
                g.churn_date || '',
                (g.health == null || g.health === '') ? '' : g.health,
                (g.ext_id == null || g.ext_id === '') ? '' : g.ext_id,
                g.days_since_modified == null ? '' : g.days_since_modified,
                g.violations.map(v => csLifeViolationLabel(v.code)).join('; '),
                g.violations.map(v => (v.severity || '').toUpperCase() + ': ' + (v.message || '')).join(' | '),
            ]);
            downloadCsvRows('cs-lifecycle-violations.csv', headers, rows);
        }

        function exportCsOverlap() {
            const data = window._csOverlapData;
            const clusters = (data && data.clusters) || [];
            if (!clusters.length) { alert('Nothing to export for the current filter.'); return; }
            const sorted = sortCsOverlapRows(clusters, window._csOverlapSort.key, window._csOverlapSort.dir);
            const sectorText = s => s === 'government' ? 'Government' : s === 'private' ? 'Private' : '';
            const headers = ['Verdict', 'Domain', 'Company', 'Sector', 'Phase', 'ARR Exposure', 'Records', 'Updated'];
            const rows = sorted.map(r => [
                (r.cs_overlap_verdict || '').toUpperCase(),
                r.domain || '',
                r.company_name || r.company_name_arabic || '',
                sectorText(r.client_sector),
                csPhaseLabel(r.pipeline_lifecycle_state),
                Number(r.arr_exposure || 0),
                Number(r.total_records || 0),
                r.updated_at ? formatDate(r.updated_at) : '',
            ]);
            downloadCsvRows('cs-overlap-clusters.csv', headers, rows);
        }

        function exportAccountHints() {
            const data = window._accountHintsData;
            const hints = (data && data.hints) || [];
            if (!hints.length) { alert('Nothing to export for the current filter.'); return; }
            const headers = ['Deal', 'Deal Account (current)', 'Suggested Account', 'Suggested Domain', 'Evidence Contact', 'Confidence %', 'Status'];
            const rows = hints.map(h => [
                h.deal_company_name || h.deal_account_name || '',
                h.deal_account_name || '',
                h.suggested_account_name || '',
                h.suggested_domain || '',
                h.evidence_contact_email || '',
                Number(h.confidence || 0),
                h.status || '',
            ]);
            downloadCsvRows('account-hints.csv', headers, rows);
        }

        // Cross-Module tab export: emit exactly the overlap clusters shown in
        // the table, honouring the active pairing filter and the server order
        // they were rendered in (the table applies no client-side re-sort).
        function exportCrossModule() {
            const list = (crossModuleClusters || []).filter(c =>
                crossModuleFilter === 'all' ? true : c.pairing === crossModuleFilter);
            if (!list.length) { alert('Nothing to export for the current filter.'); return; }
            const headers = ['Pairing', 'Domain', 'Company', 'Modules', 'Records', 'Confidence %', 'Pipeline Value', 'Recommended Action'];
            const rows = list.map(c => {
                const meta = CROSS_MODULE_PAIRING_LABELS[c.pairing] || { label: c.pairing || '', action: '' };
                const modules = [];
                if (c.total_leads    > 0) modules.push('Leads(' + c.total_leads + ')');
                if (c.total_contacts > 0) modules.push('Contacts(' + c.total_contacts + ')');
                if (c.total_accounts > 0) modules.push('Accounts(' + c.total_accounts + ')');
                if (c.total_deals    > 0) modules.push('Deals(' + c.total_deals + ')');
                return [
                    meta.label || '',
                    c.domain || '',
                    c.company_name || '',
                    modules.join(' · '),
                    Number(c.total_records || 0),
                    Number(c.confidence_score || 0),
                    formatCurrency(Number(c.estimated_pipeline_value || 0)),
                    meta.action || '',
                ];
            });
            downloadCsvRows('cross-module-overlaps.csv', headers, rows);
        }

        function exportOwner(anchor, event) {
            const owner = anchor && anchor.dataset ? (anchor.dataset.owner || 'owner') : 'owner';
            const safe = owner.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'owner';
            return streamingDownloadFromEvent(event, anchor.href, { filename: `duplicates-owner-${safe}.csv` });
        }

        // R2: per-owner Remediation Packet download. Backend returns the
        // xlsx and the Content-Disposition filename; we still pass a
        // local fallback name in case the streaming-download helper
        // exposes the file before headers are seen.
        //
        // Appends ?lang=ar when the dashboard is in Arabic mode so the
        // packet body (Cover labels, Yes/No, RAG, FAQ) and RTL views
        // match the operator's locale. ASCII-only slug matches the
        // server's packetFilename() so the two agree for non-ASCII names.
        function downloadOwnerPacket(anchor, event) {
            const owner = anchor && anchor.dataset ? (anchor.dataset.owner || 'owner') : 'owner';
            const safe = owner.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'owner';
            const lang = (window.WalaPlusI18n && WalaPlusI18n.currentLang && WalaPlusI18n.currentLang()) || 'en';
            const href = anchor.href + (anchor.href.includes('?') ? '&' : '?') + 'lang=' + encodeURIComponent(lang);
            return streamingDownloadFromEvent(event, href, { filename: `duplicate-radar-packet-${safe}.xlsx` });
        }

        // (buildDownloadExportUrl / refreshDownloadExportHint / downloadExport
        // removed alongside the Export Center tab — superseded by exportTab().)

        async function performSearch() {
            const params = {
                domain: document.getElementById('searchDomain').value,
                phone: document.getElementById('searchPhone').value,
                company_name: document.getElementById('searchCompany').value,
                contract_number: document.getElementById('searchContract').value,
                email: document.getElementById('searchEmail').value,
                record_name: document.getElementById('searchName').value,
                owner_email: document.getElementById('searchOwner').value
            };

            const hasValue = Object.values(params).some(v => v && v.trim());
            if (!hasValue) { alert(WalaPlusI18n.t('dyn.duplicates.search_no_criteria')); return; }

            const res = await fetch('/api/duplicates/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            const data = await res.json();

            if (data.records?.length > 0) {
                document.getElementById('searchResults').classList.remove('hidden');
                document.getElementById('noSearchResults').classList.add('hidden');
                document.getElementById('searchResultsCount').textContent = WalaPlusI18n.t('dyn.duplicates.search_results_count', { n: _fn(data.records.length) });
                document.getElementById('searchClusterInfo').textContent = WalaPlusI18n.t('dyn.duplicates.search_clusters_count', { n: _fn(data.clusters?.length || 0) });

                // ── Cluster cards ───────────────────────────────────────
                // Each card now carries:
                //   • a Type chip — "Domain" for the canonical company
                //     cluster vs "Solo contact" for a single-contact stub
                //     (.solo-suffixed domain — these are not mergeable per
                //     the contact-merge rule, they're distinct people).
                //   • a module-mix chip strip — L · D · C · A counts so the
                //     operator sees what's inside before clicking.
                //   • record total + confidence + a clear "Open" affordance.
                const _isSoloContactCluster = (c) => typeof c.domain === 'string' && /\.solo$/i.test(c.domain);
                const _clusterTypeChip = (c) => _isSoloContactCluster(c)
                    ? '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-200 text-gray-700" title="A single contact whose email shares the company domain but is a different person. Per the contact-merge rule (≥2 of email/phone/name) these are NOT duplicates — link to the company Account instead of merging.">Solo contact</span>'
                    : '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-700" title="The main cluster for this company. Records inside have been grouped as real duplicates.">Domain</span>';
                const _moduleChips = (c) => {
                    const chips = [];
                    if ((c.total_leads || 0) > 0)    chips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 me-1">L ' + (c.total_leads||0) + '</span>');
                    if ((c.total_deals || 0) > 0)    chips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700 me-1">D ' + (c.total_deals||0) + '</span>');
                    if ((c.total_contacts || 0) > 0) chips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 me-1">C ' + (c.total_contacts||0) + '</span>');
                    if ((c.total_accounts || 0) > 0) chips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 me-1">A ' + (c.total_accounts||0) + '</span>');
                    return chips.length > 0 ? chips.join('') : '<span class="text-[10px] text-gray-400">no module breakdown</span>';
                };
                document.getElementById('searchClustersGrid').innerHTML = (data.clusters || []).map(c => {
                    // Trim the .solo suffix from the display label — keeps
                    // the operator's eye on the email itself, not the marker.
                    const displayDomain = _isSoloContactCluster(c)
                        ? String(c.domain).replace(/^contact:/, '').replace(/\.solo$/i, '')
                        : c.domain;
                    // Checkbox is a SIBLING of the clickable card (not a child)
                    // so ticking it never triggers the card's "open cluster"
                    // action. Ticking 2+ enables "Combine selected clusters".
                    return ''
                        + '<div class="flex items-start gap-2">'
                        + '<input type="checkbox" class="search-cluster-cb mt-3 shrink-0" data-cid="' + Number(c.id) + '" data-records="' + Number(c.total_records || 0) + '" data-on-click="updateCombineBtn" title="Tick if this is the same company as another cluster, then Combine.">'
                        + '<div class="flex-1 bg-white border border-gray-200 rounded-lg p-3 cursor-pointer hover:bg-gray-50 hover:border-blue-300 transition" data-on-click="showClusterDetails" data-args="[' + Number(c.id) + ']" title="Open cluster #' + Number(c.id) + ' — merge view, per-record recommendations, snapshots, undo">'
                        +   '<div class="flex items-center justify-between gap-2 mb-1">'
                        +     _clusterTypeChip(c)
                        +     '<span class="text-[10px] text-gray-400 font-mono">#' + Number(c.id) + '</span>'
                        +   '</div>'
                        +   '<div class="font-medium text-sm text-gray-900 break-all">' + escapeHtml(displayDomain || '—') + '</div>'
                        +   (c.company_name && c.company_name !== c.domain ? '<div class="text-[11px] text-gray-500 mt-0.5">' + escapeHtml(c.company_name) + '</div>' : '')
                        +   '<div class="mt-2 flex flex-wrap items-center gap-1">' + _moduleChips(c) + '</div>'
                        +   '<div class="mt-2 flex items-center justify-between text-xs text-gray-500">'
                        +     '<span>' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.n_records_short', { n: _fn(c.total_records) })) + '</span>'
                        +     '<span class="text-blue-600 font-medium">Open →</span>'
                        +   '</div>'
                        + '</div>'
                        + '</div>';
                }).join('');
                if (typeof updateCombineBtn === 'function') updateCombineBtn();

                // ── Record rows ─────────────────────────────────────────
                // Adds Phone + Status/Stage + a Cluster button that opens
                // the cluster modal directly (operator was previously
                // having to scroll back up to the cluster card). The
                // confidence column drops to a compact "Conf." header.
                const _statusOrStage = (r) => {
                    // Leads use `status` (Lead_Status). Deals use `stage`.
                    // Both stored on the duplicate_records row.
                    if (r.record_type === 'lead'  && r.status) return r.status;
                    if (r.record_type === 'deal'  && r.stage)  return r.stage;
                    if (r.record_type === 'deal'  && r.status) return r.status;
                    if (r.record_type === 'lead'  && r.stage)  return r.stage;
                    return '';
                };
                const _phoneCell = (r) => {
                    const p = (r.phone || r.mobile || '').toString().trim();
                    return p ? '<span class="font-mono text-[11px]">' + escapeHtml(p) + '</span>' : '<span class="text-gray-300">—</span>';
                };
                const _typeBadge = (t) => {
                    const map = {
                        lead:    'bg-amber-100 text-amber-700',
                        deal:    'bg-purple-100 text-purple-700',
                        contact: 'bg-gray-100 text-gray-700',
                        account: 'bg-green-100 text-green-700',
                    };
                    const cls = map[t] || 'bg-gray-100 text-gray-700';
                    return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold uppercase ' + cls + '">' + escapeHtml(t || '—') + '</span>';
                };
                document.getElementById('searchResultsTable').innerHTML = data.records.map(r => {
                    const stat = _statusOrStage(r);
                    return ''
                        + '<tr class="hover:bg-gray-50">'
                        +   '<td class="px-3 py-2 text-xs">' + _typeBadge(r.record_type) + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-900">' + escapeHtml(r.record_name || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-700">' + escapeHtml(r.company_name || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-blue-700 font-mono">' + escapeHtml(r.domain || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(r.email || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-600">' + _phoneCell(r) + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-700">' + (stat ? escapeHtml(stat) : '<span class="text-gray-300">—</span>') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(r.owner_name || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs">'
                        +     (r.cluster_id
                                ? '<button type="button" data-on-click="showClusterDetails" data-args="[' + Number(r.cluster_id) + ']" class="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 text-[11px]" title="Open cluster #' + Number(r.cluster_id) + '">#' + Number(r.cluster_id) + ' →</button>'
                                : '<span class="text-gray-300">—</span>')
                        +   '</td>'
                        +   '<td class="px-3 py-2 text-xs"><span class="confidence-' + getConfidenceLevel(r.confidence_score) + ' px-2 py-0.5 rounded">' + (r.confidence_score != null ? r.confidence_score : 0) + '%</span></td>'
                        + '</tr>';
                }).join('');
            } else {
                document.getElementById('searchResults').classList.add('hidden');
                document.getElementById('noSearchResults').classList.remove('hidden');
            }
        }

        // ── Cross-cluster combine (Search tab) ──────────────────────────────
        // When the same company is split across separate clusters (different
        // domain/identity keys), the per-cluster Account merge can't span them.
        // Tick the clusters and Combine: re-groups their records into the
        // largest cluster (radar-only, NO Zoho changes — snapshotted + undoable
        // on the Logs tab), then opens it so the Accounts can be merged with the
        // normal Apply-in-Zoho flow.
        function updateCombineBtn() {
            const btn = document.getElementById('combineClustersBtn');
            if (!btn) return;
            const n = document.querySelectorAll('.search-cluster-cb:checked').length;
            btn.classList.toggle('hidden', n < 1);
            btn.disabled = n < 2;
            btn.innerHTML = n >= 2 ? ('🔗 Combine ' + n + ' selected clusters') : '🔗 Combine selected (tick 1 more)';
        }

        async function combineSelectedSearchClusters() {
            const boxes = Array.from(document.querySelectorAll('.search-cluster-cb:checked'));
            const ids = boxes.map(b => Number(b.getAttribute('data-cid'))).filter(Boolean);
            if (ids.length < 2) { alert('Tick at least 2 clusters that are the SAME company.'); return; }
            // Target = the ticked cluster with the most records (keeps the richest one).
            let target = ids[0], best = -1;
            for (const b of boxes) {
                const recs = Number(b.getAttribute('data-records') || 0);
                if (recs > best) { best = recs; target = Number(b.getAttribute('data-cid')); }
            }
            const sources = ids.filter(id => id !== target);
            if (!confirm('Combine ' + sources.length + ' cluster(s) into cluster #' + target + ' (the largest).\n\nThis only RE-GROUPS the radar records so the Accounts can be merged together — it makes NO Zoho changes and is undoable from the Logs tab.\n\nAfterwards #' + target + ' opens so you can merge the Accounts (Apply in Zoho).')) return;
            const btn = document.getElementById('combineClustersBtn');
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = 'Combining…'; }
            try {
                const res = await fetch('/api/duplicates/clusters/merge-into', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        target_cluster_id: target,
                        source_cluster_ids: sources,
                        notes: 'Combined from Search tab — same company across clusters',
                    }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok || !j.success) throw new Error(j.error || ('HTTP ' + res.status));
                alert('Combined into cluster #' + target + ' — ' + (j.records_moved || 0) + ' record(s) moved. Opening it so you can merge the Accounts.');
                if (typeof showClusterDetails === 'function') showClusterDetails(target);
                else if (typeof performSearch === 'function') performSearch();
            } catch (e) {
                alert('Combine failed: ' + (e.message || e));
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        function clearSearch() {
            ['searchDomain','searchPhone','searchCompany','searchContract','searchEmail','searchName','searchOwner'].forEach(id => document.getElementById(id).value = '');
            document.getElementById('searchResults').classList.add('hidden');
            document.getElementById('noSearchResults').classList.add('hidden');
        }

        function showTab(tab) {
            // Track which tab the user is on — buildFilterParams() reads this
            // to look up the per-tab AI-status chip selection.
            window._currentTab = tab;
            // Per-tab filter persistence: snapshot the OUTGOING tab's form
            // BEFORE we swap classes, then restore the INCOMING tab's form
            // AFTER the swap (when document.querySelector('.tab-active')
            // resolves to the new tab). This is the only hook needed for
            // Option A — independent filter state per tab. Wrapped in
            // try/catch so a tab without the standard filter form (or a
            // first-render race) doesn't crash the navigation.
            try {
                const __outgoingTab = _currentActiveTabId();
                if (__outgoingTab && _filterAwareTabs.has(__outgoingTab) && __outgoingTab !== tab) {
                    _snapshotFilterFormToTab(__outgoingTab);
                }
            } catch (e) { /* navigation must not depend on filter snapshot */ }
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('[id^="tab-"]').forEach(el => { el.classList.remove('tab-active'); el.classList.add('tab-inactive'); });
            document.getElementById('content-' + tab).classList.remove('hidden');
            document.getElementById('tab-' + tab).classList.remove('tab-inactive');
            document.getElementById('tab-' + tab).classList.add('tab-active');
            try {
                if (_filterAwareTabs.has(tab)) {
                    _restoreFilterFormFromTab(tab);
                }
            } catch (e) { /* restore is non-essential; the form just stays as-is */ }
            // The post-merge guidance banner only makes sense on tabs that
            // actually expose the "Mark Resolved" cluster action (the cluster +
            // per-module duplicate tabs, including cross-module). Hide it
            // everywhere else, and never override an explicit dismissal.
            const mergeGuideTabs = ['clusters', 'leads', 'deals', 'contacts', 'accounts', 'cross-module'];
            const mergeBanner = document.getElementById('mergeGuideBanner');
            if (mergeBanner) {
                const dismissed = localStorage.getItem('mergeGuideDismissed') === '1';
                if (mergeGuideTabs.includes(tab) && !dismissed) {
                    mergeBanner.classList.remove('hidden');
                } else {
                    mergeBanner.classList.add('hidden');
                }
            }
            // Lazy-load the heavy tabs on first visit. _loadedTabs is cleared
            // by refreshData() so a top-header Refresh re-fetches whichever
            // tab the user lands on next. These four cs-* / account-hints
            // loaders already short-circuit cheaply on re-entry, so calling
            // them every time is fine — they manage their own state.
            if (tab === 'cs-overlap') loadCsOverlap(window._csOverlapFilter || 'all');
            if (tab === 'cs-lifecycle') loadCsLifecycle(window._csLifecycleFilter || 'all');
            if (tab === 'deal-lifecycle') loadDealLifecycle();
            if (tab === 'account-hints') {
                loadAccountHints();
                // Record Hint tab now has 2 additional sections (Contact→Account,
                // Deal↔Contact) alongside the original Deal→Account section above.
                renderRecordHintsSection('contact_account', 'recordHintsContactAccountBody');
                renderRecordHintsSection('deal_contact', 'recordHintsDealContactBody');
            }
            if (tab === 'logs') { loadAgentActivity(); loadManualActions(); }
            if (tab === 'deal-compliance' && !window._loadedTabs.has('deal-compliance')) loadDealCompliance();
            if (tab === 'empty-records' && !window._loadedTabs.has('empty-records')) loadEmptyRecords();
            if (tab === 'merge-candidates' && !window._loadedTabs.has('merge-candidates')) { loadClusterMergeCandidates(); window._loadedTabs.add('merge-candidates'); }
            // The Domain Clusters + 4 record tabs are expensive list queries;
            // load each one ONLY on first visit per refresh cycle. This is
            // the change that keeps the page under the 100 reads/min limit.
            if (tab === 'clusters' && !window._loadedTabs.has('clusters')) {
                loadClusters();
            }
            if (['leads','deals','contacts','accounts'].includes(tab) && !window._loadedTabs.has(tab)) {
                loadRecordTab(tab);
            }
        }

        // ─── Deal Compliance (Sales SOP 7.5 — docs + mandatory fields) ──────
        // The three stages the business always checks. "Paid" == "Agreement
        // Signed" (backdated/migrated deals) — same full-document requirement.
        var DC_DEFAULT_STAGES = ['Proposal', 'Agreement Signed', 'Paid'];

        // Which stages are ticked in the in-tab Stage filter (empty before the
        // first load → the server falls back to DC_DEFAULT_STAGES).
        function _dcSelectedStages() {
            var cbs = document.querySelectorAll('#dcStageFilter .dc-stage-cb:checked');
            return Array.prototype.slice.call(cbs)
                .map(function (c) { return c.value; }).filter(Boolean);
        }

        // Render the in-tab Stage filter: the 3 defaults always shown, plus any
        // other stage that actually exists in Zoho (so she can add docs to more
        // stages later). `wanted` = the stages currently applied (kept ticked).
        function _dcRenderStageFilter(distinct, wanted) {
            var box = document.getElementById('dcStageFilter');
            if (!box) return;
            var checked = {};
            (wanted && wanted.length ? wanted : DC_DEFAULT_STAGES)
                .forEach(function (s) { checked[String(s).toLowerCase()] = true; });
            var seen = {}, all = [];
            DC_DEFAULT_STAGES.concat(distinct || []).forEach(function (s) {
                var k = String(s).toLowerCase();
                if (k && !seen[k]) { seen[k] = true; all.push(s); }
            });
            box.innerHTML = all.map(function (s) {
                var ck = checked[String(s).toLowerCase()] ? ' checked' : '';
                var isDefault = DC_DEFAULT_STAGES.some(function (d) { return d.toLowerCase() === String(s).toLowerCase(); });
                var cls = isDefault ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-white';
                return '<label class="inline-flex items-center gap-1 px-2 py-1 rounded border ' + cls + ' cursor-pointer">' +
                    '<input type="checkbox" class="dc-stage-cb" value="' + escapeHtml(String(s)) + '"' + ck + '> ' + escapeHtml(String(s)) + '</label>';
            }).join('');
        }

        // Short date formatter for the Created column.
        function _dcFmtDate(v) {
            if (!v) return '—';
            var d = new Date(v);
            if (isNaN(d.getTime())) return escapeHtml(String(v));
            try {
                return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            } catch (e) { return escapeHtml(String(v)); }
        }
        window._dcDeals = [];
        window._dcResults = {};
        // Compact SAR formatter for amounts (e.g. 1234567 -> "SAR 1.23M").
        function _dcSar(n) {
            var v = Number(n) || 0;
            if (v >= 1e9) return 'SAR ' + (v / 1e9).toFixed(2) + 'B';
            if (v >= 1e6) return 'SAR ' + (v / 1e6).toFixed(2) + 'M';
            if (v >= 1e3) return 'SAR ' + (v / 1e3).toFixed(1) + 'K';
            return 'SAR ' + v.toLocaleString();
        }
        function _dcUpdateCards() {
            var deals = window._dcDeals || [];
            var results = window._dcResults || {};
            var ok = 0, missing = 0, atRisk = 0;
            var amtById = {};
            deals.forEach(function (d) { amtById[String(d.id)] = Number(d.amount) || 0; });
            Object.keys(results).forEach(function (id) {
                if (results[id].compliant) ok++;
                else { missing++; atRisk += (amtById[id] || 0); }
            });
            var setCard = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
            setCard('dcCardScope', deals.length);
            setCard('dcCardOk', ok);
            setCard('dcCardMissing', missing);
            setCard('dcCardAtRisk', missing ? _dcSar(atRisk) : '—');
            setCard('dcCardPending', Math.max(0, deals.length - ok - missing));
            _dcRenderCharts();
            // Keep an active chart filter consistent as row statuses fill in.
            if (window._dcChartFilter) _dcFilterTableRows();
        }

        // ── Compliance charts: 100%-stacked bars by stage & by owner ─────────
        // green = compliant, red = missing docs, gray = not yet checked.
        // Click a segment to filter the table. Data comes from _dcDeals +
        // _dcResults (populated by Run Scan / per-row checks).
        window._dcCharts = window._dcCharts || { stage: null, owner: null };
        window._dcChartFilter = null; // { dim:'stage'|'owner', key, status:'compliant'|'missing'|'unchecked' }

        function _dcAggregate(dimKey) {
            // Returns { labels:[], compliant:[], missing:[], unchecked:[] } grouped by dimKey ('stage'|'owner').
            var deals = window._dcDeals || [];
            var results = window._dcResults || {};
            var map = {}; // key -> {c,m,u,mAmt}
            deals.forEach(function (d) {
                var key = (dimKey === 'owner' ? (d.owner || '—') : (d.stage || '—'));
                if (!map[key]) map[key] = { c: 0, m: 0, u: 0, mAmt: 0 };
                var r = results[String(d.id)];
                if (!r) map[key].u++;
                else if (r.compliant) map[key].c++;
                else { map[key].m++; map[key].mAmt += (Number(d.amount) || 0); }
            });
            // Sort: most non-compliant first (worst offenders on top).
            var labels = Object.keys(map).sort(function (a, b) { return map[b].m - map[a].m; });
            // Owners can be many — cap to top 15 by deal volume to keep readable.
            if (dimKey === 'owner' && labels.length > 15) {
                labels = labels.sort(function (a, b) {
                    return (map[b].c + map[b].m + map[b].u) - (map[a].c + map[a].m + map[a].u);
                }).slice(0, 15);
            }
            return {
                labels: labels,
                compliant: labels.map(function (k) { return map[k].c; }),
                missing: labels.map(function (k) { return map[k].m; }),
                unchecked: labels.map(function (k) { return map[k].u; }),
                missingAmount: labels.map(function (k) { return map[k].mAmt; }),
            };
        }

        function _dcBuildChart(canvasId, dimKey) {
            var canvas = document.getElementById(canvasId);
            if (!canvas || typeof Chart === 'undefined') return null;
            var agg = _dcAggregate(dimKey);
            var cfg = {
                type: 'bar',
                data: {
                    labels: agg.labels,
                    datasets: [
                        { label: 'Compliant', data: agg.compliant, backgroundColor: '#16a34a', stack: 's' },
                        { label: 'Missing docs', data: agg.missing, backgroundColor: '#dc2626', stack: 's' },
                        { label: 'Not checked', data: agg.unchecked, backgroundColor: '#d1d5db', stack: 's' }
                    ]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { stacked: true, ticks: { precision: 0 } },
                        y: { stacked: true, ticks: { font: { size: 10 } } }
                    },
                    plugins: {
                        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
                        tooltip: { callbacks: {
                            // On the "Missing docs" segment, show SAR at risk for that stage/owner.
                            afterLabel: function (ctx) {
                                if (ctx.datasetIndex !== 1) return '';
                                var amt = (agg.missingAmount && agg.missingAmount[ctx.dataIndex]) || 0;
                                return amt ? 'At risk: ' + _dcSar(amt) : '';
                            },
                            footer: function () { return 'Click to filter the table'; }
                        } }
                    },
                    onClick: function (evt, els) {
                        if (!els || !els.length) return;
                        var el = els[0];
                        var label = agg.labels[el.index];
                        var statusKey = ['compliant', 'missing', 'unchecked'][el.datasetIndex];
                        _dcApplyChartFilter(dimKey, label, statusKey);
                    }
                }
            };
            return new Chart(canvas, cfg);
        }

        function _dcRenderCharts() {
            if (typeof Chart === 'undefined') return;
            ['stage', 'owner'].forEach(function (dim) {
                var id = dim === 'stage' ? 'dcStageChart' : 'dcOwnerChart';
                if (window._dcCharts[dim]) { try { window._dcCharts[dim].destroy(); } catch (e) {} }
                window._dcCharts[dim] = _dcBuildChart(id, dim);
            });
        }

        function _dcApplyChartFilter(dim, key, status) {
            window._dcChartFilter = { dim: dim, key: key, status: status };
            var statusLabel = { compliant: 'compliant', missing: 'missing docs', unchecked: 'not checked' }[status] || status;
            var bar = document.getElementById('dcChartFilterBar');
            var lbl = document.getElementById('dcChartFilterLabel');
            if (lbl) lbl.textContent = (dim === 'owner' ? 'Owner' : 'Stage') + ': ' + key + ' · ' + statusLabel;
            if (bar) { bar.classList.remove('hidden'); bar.classList.add('flex'); }
            _dcFilterTableRows();
        }

        function clearDcChartFilter() {
            window._dcChartFilter = null;
            var bar = document.getElementById('dcChartFilterBar');
            if (bar) { bar.classList.add('hidden'); bar.classList.remove('flex'); }
            _dcFilterTableRows();
        }

        function _dcFilterTableRows() {
            var f = window._dcChartFilter;
            var results = window._dcResults || {};
            var rows = Array.prototype.slice.call(document.querySelectorAll('#dealComplianceBody tr[data-deal-id]'));
            rows.forEach(function (row) {
                if (!f) { row.style.display = ''; return; }
                var id = row.getAttribute('data-deal-id');
                var matchDim = (f.dim === 'owner')
                    ? row.getAttribute('data-deal-owner') === f.key
                    : row.getAttribute('data-deal-stage') === f.key;
                var r = results[String(id)];
                var rowStatus = !r ? 'unchecked' : (r.compliant ? 'compliant' : 'missing');
                var matchStatus = rowStatus === f.status;
                row.style.display = (matchDim && matchStatus) ? '' : 'none';
            });
        }

        async function loadDealCompliance() {
            var body = document.getElementById('dealComplianceBody');
            var summary = document.getElementById('dealComplianceSummary');
            if (!body) return;
            window._dcResults = {};
            if (typeof clearDcChartFilter === 'function') clearDcChartFilter(); // rows rebuilt → drop any active chart filter
            body.innerHTML = '<tr><td colspan="7" class="px-3 py-4 text-gray-500">Loading deals from Zoho…</td></tr>';
            var stages = _dcSelectedStages();
            var url = '/api/duplicates/deal-compliance' + (stages.length ? ('?stages=' + encodeURIComponent(stages.join(','))) : '');
            var data;
            try {
                var res = await fetch(url, { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                body.innerHTML = '<tr><td colspan="7" class="px-3 py-4 text-amber-700">Could not load: ' + escapeHtml(String(e && e.message || e)) + '</td></tr>';
                return;
            }
            // Render the in-tab Stage filter (defaults + any other Zoho stage).
            _dcRenderStageFilter(data.distinct_stages || [], data.wanted || []);
            window._loadedTabs.add('deal-compliance');
            var deals = (data && data.deals) || [];
            window._dcDeals = deals;
            var bs = (data && data.by_stage) || {};
            var setCard = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
            setCard('dcCardScanned', data.scanned != null ? data.scanned : '—');
            _dcUpdateCards();
            summary.innerHTML = 'Stages: <strong>' + escapeHtml((data.wanted || []).join(', ')) + '</strong> · ' +
                (data.total || 0) + ' deal(s) · ' +
                Object.keys(bs).map(function (s) { return escapeHtml(s) + ': ' + bs[s].total; }).join(' · ') +
                ' · <span class="text-gray-400">Run Scan (or a row button) to verify attachments</span>';
            if (!deals.length) {
                body.innerHTML = '<tr><td colspan="7" class="px-3 py-4 text-gray-500">No deals in the selected stage(s). Tick stages above and click Apply.</td></tr>';
                return;
            }
            body.innerHTML = deals.map(function (d) {
                var reqd = (d.requiredDocs || []).map(function (x) { return x.label; }).join(', ');
                var docArgs = escapeHtml(JSON.stringify([String(d.id), String(d.stage)]));
                return '<tr class="border-t border-gray-100 align-top" data-deal-id="' + escapeHtml(String(d.id)) + '" data-deal-stage="' + escapeHtml(String(d.stage)) + '" data-deal-owner="' + escapeHtml(String(d.owner || '—')) + '">' +
                    '<td class="px-3 py-2 font-medium">' +
                        '<a href="https://crm.zoho.com/crm/org766568398/tab/Potentials/' + encodeURIComponent(String(d.id)) + '" target="_blank" rel="noopener" class="text-blue-600 hover:underline" title="Open this deal in Zoho CRM">' + escapeHtml(d.name) + '</a>' +
                        (d.accountName ? '<div class="text-xs text-gray-400">' + escapeHtml(d.accountName) + '</div>' : '') + '</td>' +
                    '<td class="px-3 py-2"><span class="inline-block px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-xs">' + escapeHtml(d.stage) + '</span></td>' +
                    '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(d.owner) + '</td>' +
                    '<td class="px-3 py-2 text-xs text-gray-600">' + (d.source ? escapeHtml(d.source) : '—') + '</td>' +
                    '<td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">' + _dcFmtDate(d.createdTime) + '</td>' +
                    '<td class="px-3 py-2 text-end text-xs text-gray-700">' + (d.amount != null ? escapeHtml(String(d.amount)) : '—') + '</td>' +
                    '<td class="px-3 py-2"><span id="docs-' + escapeHtml(String(d.id)) + '" title="Required: ' + escapeHtml(reqd) + '"><button data-on-click="checkDealDocs" data-args=\'' + docArgs + '\' class="px-2 py-1 text-xs rounded border border-blue-300 text-blue-700 hover:bg-blue-50">📎 Check documents</button></span></td>' +
                    '</tr>';
            }).join('');
            // Restore previously-scanned results (persisted) so re-opening the
            // tab doesn't start from scratch.
            _dcRehydrateFromStore();
        }

        // Sequentially verify documents for every loaded deal (bounded, paced to
        // respect Zoho rate limits). Documents is the whole point of this tab.
        async function checkAllDealDocs() {
            var btn = document.getElementById('checkAllDocsBtn');
            var rows = Array.prototype.slice.call(document.querySelectorAll('#dealComplianceBody tr[data-deal-id]'));
            if (!rows.length) return;
            var cap = Math.min(rows.length, 200);
            if (btn) { btn.disabled = true; }
            for (var i = 0; i < cap; i++) {
                if (btn) btn.textContent = 'Checking ' + (i + 1) + '/' + cap + '…';
                var id = rows[i].getAttribute('data-deal-id');
                var stage = rows[i].getAttribute('data-deal-stage');
                await checkDealDocs(id, stage);
                // Pace the loop so we don't burst Zoho's attachment API (which
                // 429s under load). The server also retries 429 with backoff.
                if (i < cap - 1) await new Promise(function (r) { setTimeout(r, 350); });
            }
            if (btn) { btn.disabled = false; btn.textContent = '🔍 Run Scan'; }
        }

        // Lazily fetch a deal's Zoho attachments and show which required docs are present/missing.
        async function checkDealDocs(id, stage) {
            var span = document.getElementById('docs-' + id);
            if (span) span.innerHTML = '<span class="text-xs text-gray-400">checking…</span>';
            var data;
            try {
                var res = await fetch('/api/duplicates/deals/' + encodeURIComponent(id) + '/doc-compliance?stage=' + encodeURIComponent(stage), { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                if (span) span.innerHTML = '<span class="text-xs text-amber-700">err: ' + escapeHtml(String(e && e.message || e)) + '</span>';
                return;
            }
            // Record for the summary cards + CSV export, and PERSIST so the
            // scan survives a page reload / platform restart (so you don't
            // re-scan from scratch — scan once, send the missing-doc scope to
            // owners, re-check later).
            var rec = {
                compliant: !!data.compliant,
                present: (data.presentDocs || []).map(function (p) { return p.label; }),
                missing: (data.missingDocs || []).map(function (m) { return m.label; }),
                attachmentCount: data.attachmentCount || 0,
                stage: stage,
                // Prefer the server's checkedAt/checkedBy when present so the
                // row matches the persisted attribution; fall back to "now"
                // for environments where the response doesn't echo them yet.
                checkedAt: data.checkedAt || new Date().toISOString(),
                checkedBy: data.checkedBy || null,
            };
            window._dcResults[id] = rec;
            _dcStorePut(id, rec);
            _dcUpdateCards();
            if (span) span.innerHTML = _dcDocCellHtml(id, rec, stage);
        }

        // ══ Empty / Orphaned Records cleanup tab ════════════════════════════
        // Client-side pagination keeps the DOM small (was rendering up to ~1,485
        // rows at once, which made the whole tab heavy). Selections are held in a
        // per-module set so they survive page changes and the bulk-tag still acts
        // on every selected record across all pages.
        var ER_PAGE_SIZE = 50;
        function _erSelSet(module) {
            window._erSel = window._erSel || {};
            if (!window._erSel[module]) window._erSel[module] = {};
            return window._erSel[module];
        }
        function erCbToggle(cb) {
            var set = _erSelSet(cb.getAttribute('data-kind'));
            var id = String(cb.getAttribute('data-zoho-id'));
            if (cb.checked) set[id] = true; else delete set[id];
            erSelChanged();
        }
        function erChangePage(kind, delta) {
            var map = { deals: 'erDealsBody', accounts: 'erAccountsBody', contacts: 'erContactsBody' };
            var rows = window['_er_' + kind] || [];
            var pages = Math.max(1, Math.ceil(rows.length / ER_PAGE_SIZE));
            var cur = (window['_erPage_' + kind] || 0) + delta;
            window['_erPage_' + kind] = Math.min(pages - 1, Math.max(0, cur));
            erRender(kind, map[kind]);
        }
        async function loadEmptyRecords() {
            window._loadedTabs.add('empty-records');
            if (!window._erCbBound) {
                window._erCbBound = true;
                document.addEventListener('change', function (e) {
                    if (e.target && e.target.classList && e.target.classList.contains('er-cb')) erCbToggle(e.target);
                });
            }
            await Promise.all([erLoad('deals', 'erDealsBody'), erLoad('accounts', 'erAccountsBody'), erLoad('contacts', 'erContactsBody')]);
            erLoadTaggedStatus();
        }
        function erReload(kind) {
            const map = { deals: 'erDealsBody', accounts: 'erAccountsBody', contacts: 'erContactsBody' };
            erLoad(kind, map[kind]);
        }
        async function erLoad(kind, bodyId) {
            const body = document.getElementById(bodyId);
            if (!body) return;
            body.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-gray-400">' + escapeHtml(WalaPlusI18n.t('duplicates.er_loading')) + '</td></tr>';
            let data;
            try {
                const res = await fetch('/api/duplicates/empty-records/' + kind, { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                body.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-sm text-amber-700">Error: ' + escapeHtml(String(e && e.message || e)) + '</td></tr>';
                return;
            }
            window['_er_' + kind] = data.rows || [];
            window['_erPage_' + kind] = 0; // fresh data → back to page 1
            window._erSel = window._erSel || {};
            window._erSel[kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts'] = {}; // clear stale selection
            erRender(kind, bodyId);
            erSelChanged();
            const chip = document.getElementById('erCount-' + kind);
            if (chip) chip.textContent = (data.rows || []).length.toLocaleString();
        }
        function erReasonBadge(reason) {
            const m = { orphaned: ['bg-amber-100', 'text-amber-800', 'ORPHANED'], empty: ['bg-gray-200', 'text-gray-700', 'EMPTY'], test: ['bg-rose-100', 'text-rose-700', 'TEST'], junk: ['bg-orange-100', 'text-orange-800', 'JUNK'] };
            const x = m[reason] || m.empty;
            const lbl = WalaPlusI18n.t('duplicates.er_badge_' + (m[reason] ? reason : 'empty'));
            return '<span class="px-2 py-0.5 rounded text-[10px] font-bold ' + x[0] + ' ' + x[1] + '">' + lbl + '</span>';
        }
        function erZohoUrl(kind, id) {
            const tab = kind === 'deals' ? 'Potentials' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            return 'https://crm.zoho.com/crm/org766568398/tab/' + tab + '/' + encodeURIComponent(id);
        }
        function _erSortVal(r, field) {
            if (field === 'reason') return String(r.reason || '');
            if (field === 'owner') return String(r.owner || '').toLowerCase();
            if (field === 'stage') return String((r.extra && r.extra.stage) || '').toLowerCase();
            if (field === 'created') return String((r.extra && r.extra.created) || ''); // ISO → lexical sort = chronological
            return String(r.name || '').toLowerCase(); // 'name'
        }
        function erRender(kind, bodyId) {
            // Sort the WHOLE list (all records, not just the visible page) by the
            // active column, then paginate the sorted result — so ascending/
            // descending spans the full 500, as expected (Ahmad 2026-06-30).
            let rows = (window['_er_' + kind] || []).slice();
            const _ss = (window._erSort || {})[kind];
            if (_ss && _ss.field) {
                const _dir = _ss.dir === 'desc' ? -1 : 1;
                rows.sort(function (a, b) {
                    const va = _erSortVal(a, _ss.field), vb = _erSortVal(b, _ss.field);
                    if (va < vb) return -_dir;
                    if (va > vb) return _dir;
                    return 0;
                });
            }
            const body = document.getElementById(bodyId);
            if (!body) return;
            // Deals have extra Stage + Created columns (7); accounts/contacts have 5.
            const COLS = kind === 'deals' ? 7 : 5;
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="' + COLS + '" class="px-4 py-6 text-center text-sm text-gray-400">' + escapeHtml(WalaPlusI18n.t('duplicates.er_none')) + '</td></tr>';
                // Clear any stale pager left from a previous (non-empty) render —
                // otherwise "Showing 1–50 of 215 · Page 1/5" lingers under "None found".
                const _t = body.closest('table');
                const _tf = _t && _t.querySelector('tfoot.er-pager');
                if (_tf) _tf.innerHTML = '';
                return;
            }
            const moduleOf = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            // Pagination: render only the current page so the DOM stays small.
            const pages = Math.max(1, Math.ceil(rows.length / ER_PAGE_SIZE));
            const cur = Math.min(pages - 1, Math.max(0, window['_erPage_' + kind] || 0));
            window['_erPage_' + kind] = cur;
            const start = cur * ER_PAGE_SIZE;
            const pageRows = rows.slice(start, start + ER_PAGE_SIZE);
            const selSet = _erSelSet(moduleOf);
            const rowsHtml = pageRows.map(function (r) {
                const cbId = 'er-cb-' + kind + '-' + r.zohoId;
                const isSel = !!selSet[String(r.zohoId)];
                const cb = '<input type="checkbox" class="er-cb" id="' + escapeHtml(cbId) + '" data-kind="' + moduleOf + '" data-zoho-id="' + escapeHtml(String(r.zohoId)) + '"' + (isSel ? ' checked' : '') + (r.deleteEligible ? '' : ' disabled title="Not delete-eligible yet"') + '>';
                const args = escapeHtml(JSON.stringify([String(r.zohoId)]));
                let action;
                if (kind === 'accounts' || kind === 'deals') {
                    if (r.deleteEligible) {
                        // Label by reason: genuine test data → "test — ready" (red);
                        // a merely-empty record → "empty — ready" (neutral).
                        var _isTest = r.reason === 'test';
                        var _lbl = WalaPlusI18n.t(_isTest ? 'duplicates.er_test_ready' : 'duplicates.er_empty_ready');
                        action = '<span class="text-xs ' + (_isTest ? 'text-rose-600' : 'text-emerald-700') + '">' + escapeHtml(_lbl) + '</span>';
                    } else {
                        // "Check documents" — live-verify this one record (no account/
                        // contact/docs) before it becomes delete-eligible. Same gate for
                        // Accounts and Deals.
                        var _kargs = escapeHtml(JSON.stringify([kind, String(r.zohoId)]));
                        action = '<span id="eratt-' + escapeHtml(String(r.zohoId)) + '"><button data-on-click="erCheckDocuments" data-args=\'' + _kargs + '\' class="px-2 py-1 text-xs rounded border border-blue-300 text-blue-700 hover:bg-blue-50">📎 ' + escapeHtml(WalaPlusI18n.t('duplicates.er_check_att')) + '</button></span>';
                    }
                } else {
                    action = '';
                }
                // Per-row Dismiss — "this isn't empty, keep it" (false positive,
                // e.g. a deal that actually has data). Removes it from the list
                // durably without any Zoho write.
                const dismissBtn = '<button data-on-click="erDismiss" data-args=\'' + escapeHtml(JSON.stringify([kind, String(r.zohoId)])) + '\' class="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100" title="Not empty — keep this record and remove it from the cleanup list">✕ ' + escapeHtml(WalaPlusI18n.t('duplicates.er_dismiss')) + '</button>';
                // Stage column — Deals only. Protected stages (Agreement Signed /
                // Paid) are highlighted so the operator sees at a glance a deal that
                // should NEVER be tagged.
                var stageCell = '', createdCell = '';
                if (kind === 'deals') {
                    var _stg = (r.extra && r.extra.stage) ? String(r.extra.stage) : '';
                    var _prot = /^(agreement signed|paid)$/i.test(_stg.trim());
                    stageCell = '<td class="px-3 py-2 text-xs ' + (_prot ? 'text-emerald-700 font-semibold' : 'text-gray-600') + '">' + escapeHtml(_stg || '—') + (_prot ? ' 🔒' : '') + '</td>';
                    var _cr = (r.extra && r.extra.created) ? new Date(r.extra.created) : null;
                    createdCell = '<td class="px-3 py-2 text-xs text-gray-500">' + escapeHtml(_cr && !isNaN(_cr) ? _cr.toLocaleDateString() : '—') + '</td>';
                }
                return '<tr class="border-t border-gray-100">'
                    + '<td class="px-3 py-2">' + cb + '</td>'
                    + '<td class="px-3 py-2">' + erReasonBadge(r.reason) + '</td>'
                    + '<td class="px-3 py-2"><a href="' + erZohoUrl(kind, r.zohoId) + '" target="_blank" rel="noopener" class="text-blue-600 hover:underline">' + escapeHtml(r.name || '(no name)') + '</a></td>'
                    + stageCell
                    + createdCell
                    + '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(r.owner || '—') + '</td>'
                    + '<td class="px-3 py-2"><div class="flex items-center gap-2 whitespace-nowrap">' + action + dismissBtn + '</div></td>'
                    + '</tr>';
            }).join('');
            // Pagination footer (only when there's more than one page).
            let footer = '';
            if (rows.length > ER_PAGE_SIZE) {
                const from = start + 1, to = start + pageRows.length;
                const prevDis = cur === 0 ? ' opacity-40 pointer-events-none' : ' hover:bg-gray-100';
                const nextDis = cur >= pages - 1 ? ' opacity-40 pointer-events-none' : ' hover:bg-gray-100';
                footer = '<tr class="bg-gray-50"><td colspan="' + COLS + '" class="px-3 py-2">'
                    + '<div class="flex items-center justify-between text-xs text-gray-600">'
                    + '<span>Showing ' + from.toLocaleString() + '–' + to.toLocaleString() + ' of ' + rows.length.toLocaleString() + '</span>'
                    + '<span class="flex items-center gap-2">'
                    + '<button data-on-click="erChangePage" data-args=\'["' + kind + '",-1]\' class="px-2 py-1 rounded border border-gray-300' + prevDis + '">‹ Prev</button>'
                    + '<span>Page ' + (cur + 1) + ' / ' + pages + '</span>'
                    + '<button data-on-click="erChangePage" data-args=\'["' + kind + '",1]\' class="px-2 py-1 rounded border border-gray-300' + nextDis + '">Next ›</button>'
                    + '</span></div></td></tr>';
            }
            body.innerHTML = rowsHtml;
            // Render the pager into a <tfoot>, NOT the tbody — table-sort sorts
            // every tbody row, which would otherwise shuffle the pager into the data.
            const table = body.closest('table');
            if (table) {
                let tf = table.querySelector('tfoot.er-pager');
                if (footer) {
                    if (!tf) { tf = document.createElement('tfoot'); tf.className = 'er-pager'; table.appendChild(tf); }
                    tf.innerHTML = footer;
                } else if (tf) {
                    tf.innerHTML = '';
                }
            }
            // Auto-check documents for the visible Deals on fetch/render, so the
            // operator doesn't click "Check documents" per row (Ahmad 2026-06-30).
            // One batched request — no per-row rate-limit; read-only (tagging still
            // live-verifies). Deduped so a record is checked once.
            if (kind === 'deals') { try { _erAutoCheckPage(kind, bodyId); } catch (_) { } }
        }
        async function _erAutoCheckPage(kind, bodyId) {
            window._erAutoChecked = window._erAutoChecked || {};
            window._erAutoChecked[kind] = window._erAutoChecked[kind] || {};
            window._erAutoBusy = window._erAutoBusy || {};
            if (window._erAutoBusy[kind]) return; // one auto-check at a time per tab
            const body = document.getElementById(bodyId);
            if (!body) return;
            // Visible rows still showing the "Check documents" button (not yet
            // delete-ready) that we haven't auto-checked yet.
            const ids = [];
            body.querySelectorAll('span[id^="eratt-"]').forEach(function (span) {
                const id = span.id.slice('eratt-'.length);
                if (id && !window._erAutoChecked[kind][id]) ids.push(id);
            });
            if (!ids.length) return;
            window._erAutoBusy[kind] = true;
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const prog = document.getElementById('erAiProgress-' + kind);
            if (prog) prog.textContent = '⏳ Auto-checking ' + ids.length + ' for documents…';
            let j = null;
            try {
                const res = await fetch('/api/duplicates/empty-records/check-batch', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ module: module, zohoIds: ids }),
                });
                j = await res.json();
                if (!res.ok || !j.success) throw new Error((j && j.error) || ('HTTP ' + res.status));
            } catch (e) {
                if (prog) prog.textContent = 'Auto-check paused — verify manually. (' + String(e && e.message || e) + ')';
                window._erAutoBusy[kind] = false;
                return;
            }
            let ready = 0, kept = 0; const ghosts = [];
            (j.results || []).forEach(function (r) {
                window._erAutoChecked[kind][r.id] = true;
                if (r.ghost) { ghosts.push(String(r.id)); return; }
                const row = (window['_er_' + kind] || []).find(function (x) { return String(x.zohoId) === String(r.id); });
                const cell = document.getElementById('eratt-' + r.id);
                if (r.tagged) { kept++; return; } // handled by the tagged-move flow on demand
                if (r.empty) {
                    if (row) row.deleteEligible = true;
                    const cbx = document.getElementById('er-cb-' + kind + '-' + r.id);
                    if (cbx) cbx.disabled = false;
                    if (cell) cell.innerHTML = '<span class="text-xs text-emerald-700">' + escapeHtml(WalaPlusI18n.t('duplicates.er_empty_ready')) + '</span>';
                    ready++;
                } else {
                    if (row) row.deleteEligible = false;
                    if (cell) cell.innerHTML = '<span class="text-xs text-gray-600">' + escapeHtml((r.reason || 'has data') + ' — ' + WalaPlusI18n.t('duplicates.er_keep')) + '</span>';
                    kept++;
                }
            });
            window._erAutoBusy[kind] = false;
            if (ghosts.length) _erRemoveLocal(kind, ghosts); // re-renders; remaining auto-check next pass
            if (prog) prog.textContent = '✓ Auto-checked: ' + ready + ' ready · ' + kept + ' have data' + (ghosts.length ? ' · ' + ghosts.length + ' already deleted' : '');
        }
        function erSelChanged() {
            window._erSel = window._erSel || {};
            let n = 0;
            ['Deals', 'Accounts', 'Contacts'].forEach(function (m) { n += Object.keys(window._erSel[m] || {}).length; });
            const bar = document.getElementById('erBulkBar');
            const cnt = document.getElementById('erBulkCount');
            if (cnt) cnt.textContent = n + ' selected';
            if (bar) { if (n > 0) bar.classList.remove('hidden'); else bar.classList.add('hidden'); }
        }
        // Header checkbox: select / clear ALL delete-ready rows on the current page,
        // so the bulk "Tag selected" / "Dismiss selected (keep)" acts on up to 50 at
        // once in ONE request (avoids the per-row "Too many requests" rate limit).
        function erSelectAllPage(e) {
            const cb = e && e.target; if (!cb) return;
            const table = cb.closest('table'); if (!table) return;
            const body = table.querySelector('tbody'); if (!body) return;
            const kind = body.id === 'erDealsBody' ? 'deals' : body.id === 'erAccountsBody' ? 'accounts' : body.id === 'erContactsBody' ? 'contacts' : null;
            if (!kind) return;
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const on = !!cb.checked;
            const set = _erSelSet(module);
            // Only ENABLED (delete-ready) rows — disabled ones aren't taggable yet.
            body.querySelectorAll('input.er-cb:not([disabled])').forEach(function (rowCb) {
                rowCb.checked = on;
                const id = String(rowCb.getAttribute('data-zoho-id'));
                if (on) set[id] = true; else delete set[id];
            });
            erSelChanged();
        }
        // Sort the FULL list by a column (toggle asc/desc), reset to page 1, re-render.
        function erSortBy(kind, field) {
            window._erSort = window._erSort || {};
            const cur = window._erSort[kind];
            const dir = (cur && cur.field === field && cur.dir === 'asc') ? 'desc' : 'asc';
            window._erSort[kind] = { field: field, dir: dir };
            window['_erPage_' + kind] = 0;
            const bodyId = kind === 'deals' ? 'erDealsBody' : kind === 'accounts' ? 'erAccountsBody' : 'erContactsBody';
            erRender(kind, bodyId);
            _erUpdateSortCarets(kind);
        }
        function _erUpdateSortCarets(kind) {
            const st = (window._erSort || {})[kind];
            document.querySelectorAll('.er-sort-caret[data-sk^="' + kind + ':"]').forEach(function (el) {
                const f = (el.getAttribute('data-sk') || '').split(':')[1];
                el.textContent = (st && st.field === f) ? (st.dir === 'desc' ? ' ↓' : ' ↑') : '';
            });
        }
        async function erAiApply(kind) {
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const n = (window['_er_' + kind] || []).length;
            if (!n) return;
            if (!confirm('AI-Apply ALL ' + n + ' empty ' + module + '?\n\nFor each one it verifies live in Zoho, tags the genuinely-empty as Empty-Delete (Adam, pending admin delete), prunes any already deleted, and removes any that turn out to have data. It runs batch-after-batch until the whole list is done.\n\nThe platform never deletes — the admin removes the tagged records.')) return;
            // Visible progress lives in a per-section span next to the button (the
            // shared #erBulkResult sits in a hidden bar, so the operator couldn't
            // see anything happening — Ahmad 2026-06-30). Also disable the button +
            // show a spinner so it's obvious the run is in flight.
            const result = document.getElementById('erBulkResult');
            const prog = document.getElementById('erAiProgress-' + kind);
            const btn = document.getElementById('erAiBtn-' + kind);
            const btnHtml = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.classList.add('opacity-60', 'pointer-events-none'); btn.innerHTML = '⏳ AI-Applying…'; }
            const setProg = function (txt) { if (prog) prog.textContent = txt; if (result) result.textContent = txt; };
            let tagged = 0, pruned = 0, dismissed = 0, docs = 0, iter = 0;
            try {
                // Loop the batched endpoint until nothing is left (or no progress).
                while (true) {
                    iter++;
                    setProg('⏳ Batch ' + iter + ' — verifying live in Zoho… (' + tagged + ' tagged so far)');
                    if (btn) btn.innerHTML = '⏳ AI-Applying… (' + tagged + ' tagged)';
                    const j = await erAdminPost('/api/duplicates/empty-records/ai-apply', { module: module });
                    if (!j) { setProg('Cancelled after ' + tagged + ' tagged.'); break; }
                    if (!j.success) { setProg('⚠ Stopped: ' + (j.error || 'failed') + ' (after ' + tagged + ' tagged)'); break; }
                    tagged += (j.tagged || 0);
                    pruned += (j.prunedGhosts || 0);
                    dismissed += (j.dismissed || 0);
                    docs += (j.skippedWithDocs || 0);
                    // Progress = anything that removed a record from the list this batch.
                    const progressed = (j.tagged || 0) + (j.prunedGhosts || 0) + (j.dismissed || 0) + (j.skippedAlreadyTagged || 0);
                    if ((j.remaining || 0) <= 0 || progressed === 0 || iter >= 60) {
                        let msg = '✓ Done (' + iter + ' batch' + (iter === 1 ? '' : 'es') + '): tagged ' + tagged + ' Empty-Delete · pruned ' + pruned + ' ghosts';
                        if (dismissed > 0) msg += ' · removed ' + dismissed + ' that had data';
                        if ((j.remaining || 0) > 0 && progressed === 0) msg += ' · ' + j.remaining + ' left need manual review';
                        setProg(msg);
                        break;
                    }
                }
            } finally {
                // Restore the button regardless of how the loop ended.
                if (btn) { btn.disabled = false; btn.classList.remove('opacity-60', 'pointer-events-none'); btn.innerHTML = btnHtml; }
            }
            erReload(kind);
            erLoadTaggedStatus();
        }
        // Live-verify ONLY the rows currently visible on this page against Zoho
        // (bounded — the same gate AI-Apply uses). Confirmed-empty rows stay; rows
        // that turn out to have deals/contacts are auto-Dismissed and removed;
        // already-deleted rows are pruned. No tagging.
        async function erVerifyPage(kind) {
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const rows = window['_er_' + kind] || [];
            if (!rows.length) return;
            const pages = Math.max(1, Math.ceil(rows.length / ER_PAGE_SIZE));
            const cur = Math.min(pages - 1, Math.max(0, window['_erPage_' + kind] || 0));
            const pageRows = rows.slice(cur * ER_PAGE_SIZE, cur * ER_PAGE_SIZE + ER_PAGE_SIZE);
            const ids = pageRows.map(function (r) { return String(r.zohoId); });
            if (!ids.length) return;
            const result = document.getElementById('erBulkResult');
            if (result) result.textContent = 'Verifying ' + ids.length + ' ' + module + ' against Zoho… (live deals/contacts check)';
            const j = await erAdminPost('/api/duplicates/empty-records/verify-page', { module: module, zohoIds: ids });
            if (!j) { if (result) result.textContent = 'Cancelled.'; return; }
            if (!j.success) { if (result) result.textContent = 'Error: ' + (j.error || 'failed'); return; }
            // Confirmed-empty accounts → enable their checkbox (delete-eligible).
            if (kind === 'accounts') {
                (j.empty || []).forEach(function (id) {
                    const row = (window['_er_accounts'] || []).find(function (r) { return String(r.zohoId) === String(id); });
                    if (row) row.deleteEligible = true;
                });
            }
            // Drop the non-empty (dismissed), ghosts (pruned), and already-tagged.
            const drop = []
                .concat((j.keep || []).map(function (k) { return String(k.id); }))
                .concat((j.ghosts || []).map(String))
                .concat((j.tagged || []).map(String));
            if (drop.length) _erRemoveLocal(kind, drop);
            else erRender(kind, 'er' + module + 'Body'); // reflect deleteEligible
            let msg = '✓ Verified ' + ids.length + ': ' + (j.empty || []).length + ' confirmed empty · ' + (j.keep || []).length + ' had deals/contacts (removed)';
            if ((j.ghosts || []).length) msg += ' · ' + j.ghosts.length + ' already deleted (pruned)';
            if ((j.tagged || []).length) msg += ' · ' + j.tagged.length + ' already tagged → moved to "Tagged · pending delete"';
            if (result) result.textContent = msg;
            // Already-tagged records were recorded in the ledger server-side; refresh
            // the Tagged · pending delete section so they show up there now.
            if ((j.tagged || []).length) erLoadTaggedStatus();
        }
        // Per-row "Check documents" for an Account OR a Deal — live-verify it has
        // no account/contact/email/documents in Zoho (the shared empty gate). On
        // confirmed-empty it becomes delete-eligible; if it has data we show why
        // and keep it; if it was deleted in Zoho the row is pruned on the spot.
        async function erCheckDocuments(kind, id) {
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const cell = document.getElementById('eratt-' + id);
            if (cell) cell.innerHTML = '<span class="text-xs text-gray-400">checking…</span>';
            let data;
            try {
                const res = await fetch('/api/duplicates/empty-records/' + module + '/' + encodeURIComponent(id) + '/check-empty', { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                var msg = String(e && e.message || e);
                if (/invalid_data|related id given seems to be invalid|record not found/i.test(msg)) {
                    _erRemoveLocal(kind, [String(id)]);
                    return;
                }
                if (cell) cell.innerHTML = '<span class="text-xs text-amber-700">err: ' + escapeHtml(msg) + '</span>';
                return;
            }
            if (data.ghost) { _erRemoveLocal(kind, [String(id)]); return; } // deleted in Zoho
            if (data.tagged) {
                // Already tagged in Zoho (mirror was stale). Don't leave it sitting
                // here as "keep" — record it properly (Empty-Delete → ledger so it
                // moves to "Tagged · pending delete"; Duplicate-Delete → dismissed)
                // and drop it off this active cleanup list.
                if (cell) cell.innerHTML = '<span class="text-xs text-gray-400">moving to tagged…</span>';
                await erAdminPost('/api/duplicates/empty-records/verify-page', { module: module, zohoIds: [String(id)] });
                _erRemoveLocal(kind, [String(id)]);
                erLoadTaggedStatus();
                return;
            }
            const row = (window['_er_' + kind] || []).find(function (r) { return String(r.zohoId) === String(id); });
            if (data.empty) {
                if (cell) cell.innerHTML = '<span class="text-xs text-emerald-700">' + escapeHtml(WalaPlusI18n.t('duplicates.er_empty_ready')) + '</span>';
                const cb = document.getElementById('er-cb-' + kind + '-' + id);
                if (cb) cb.disabled = false;
                if (row) row.deleteEligible = true; // persists across page re-render
            } else {
                // Not empty — explain why and keep it (never let it become eligible).
                var reasonMap = {
                    tagged: 'already tagged', protected_stage: 'active stage',
                    deals: WalaPlusI18n.t('duplicates.er_deals'), contacts: WalaPlusI18n.t('duplicates.er_contacts'),
                    documents: '📎 docs', email: 'email', account: 'account', contact_info: 'has contact info'
                };
                var why = reasonMap[data.reason] || (data.reason || 'has data');
                if (cell) cell.innerHTML = '<span class="text-xs text-gray-600">' + escapeHtml(why + ' — ' + WalaPlusI18n.t('duplicates.er_keep')) + '</span>';
                if (row) row.deleteEligible = false;
            }
        }
        async function erLinkDeal(id) {
            const cell = document.getElementById('erlink-' + id);
            if (cell) cell.innerHTML = '<span class="text-xs text-gray-400">finding account…</span>';
            let sug = null;
            try {
                const res = await fetch('/api/duplicates/empty-records/deals/' + encodeURIComponent(id) + '/account-suggestion', { credentials: 'same-origin' });
                const data = await res.json();
                sug = data && data.suggestion;
            } catch (e) { /* manual still available */ }
            let html = '';
            if (sug && sug.accountId) {
                html += '<button data-on-click="erDoLinkDeal" data-args=\'' + escapeHtml(JSON.stringify([String(id), String(sug.accountId)])) + '\' class="px-2 py-1 text-xs rounded bg-emerald-600 text-white hover:bg-emerald-700">Link to ' + escapeHtml(sug.accountName || sug.accountId) + ' (' + (sug.confidence || 0) + '%)</button> ';
            }
            html += '<input id="erlinkacc-' + escapeHtml(String(id)) + '" placeholder="Account Zoho ID" class="px-2 py-1 text-xs border border-gray-300 rounded w-36">'
                + '<button data-on-click="erDoLinkDealManual" data-args=\'' + escapeHtml(JSON.stringify([String(id)])) + '\' class="ml-1 px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">' + escapeHtml(WalaPlusI18n.t('duplicates.er_link')) + '</button>';
            if (cell) cell.innerHTML = html;
        }
        function erDoLinkDealManual(id) {
            const inp = document.getElementById('erlinkacc-' + id);
            const accId = inp ? (inp.value || '').trim() : '';
            if (!accId) { alert('Enter an Account Zoho ID.'); return; }
            erDoLinkDeal(id, accId);
        }
        async function erDoLinkDeal(dealId, accountId) {
            const cell = document.getElementById('erlink-' + dealId);
            if (cell) cell.innerHTML = '<span class="text-xs text-gray-400">linking…</span>';
            try {
                const j = await erAdminPost('/api/duplicates/empty-records/link-deal', { dealId: dealId, accountId: accountId });
                if (!j) { if (cell) cell.innerHTML = '<span class="text-xs text-gray-500">cancelled</span>'; return; }
                if (!j.success) throw new Error(j.error || 'failed');
                if (cell) cell.innerHTML = '<span class="text-xs text-emerald-700">✓ linked</span>';
                window._er_deals = (window._er_deals || []).filter(function (r) { return String(r.zohoId) !== String(dealId); });
            } catch (e) {
                if (cell) cell.innerHTML = '<span class="text-xs text-red-600">err: ' + escapeHtml(String(e && e.message || e)) + '</span>';
            }
        }
        // Admin-gated POST — on 401/403 prompt for the admin key and retry (mirrors applyAllSafeMerges).
        async function erAdminPost(url, body) {
            let adminKey = window._erAdminKey || null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const headers = { 'Content-Type': 'application/json' };
                if (adminKey) headers['x-admin-key'] = adminKey;
                const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) });
                if (res.status === 401 || res.status === 403) {
                    adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return null;
                    window._erAdminKey = adminKey;
                    continue;
                }
                return await res.json().catch(function () { return {}; });
            }
            return null;
        }
        async function erLoadTaggedStatus() {
            const body = document.getElementById('erTaggedBody');
            const progress = document.getElementById('erTaggedProgress');
            if (!body) return;
            body.innerHTML = '<tr><td colspan="5" class="px-4 py-4 text-center text-sm text-gray-400">' + escapeHtml(WalaPlusI18n.t('duplicates.er_loading')) + '</td></tr>';
            let data;
            try {
                const res = await fetch('/api/duplicates/empty-records/tagged-status', { credentials: 'same-origin' });
                data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
            } catch (e) {
                body.innerHTML = '<tr><td colspan="5" class="px-4 py-4 text-center text-sm text-amber-700">Error: ' + escapeHtml(String(e && e.message || e)) + '</td></tr>';
                return;
            }
            const rows = data.rows || [];
            const counts = data.counts || {};
            window._erTaggedCounts = counts;
            _erRenderTaggedHeader();
            // PERF (Ahmad 2026-06-30): this can be 1000+ rows. Rendering them all
            // bloated the DOM so badly that every reflow (e.g. the sticky bulk-bar
            // appearing on a checkbox tick) froze the tab for ~a minute. Paginate
            // like the other tables — keep the rows in memory, render one page.
            window._erTagged = rows;
            window._erTaggedPage = 0;
            _erRenderTaggedPage();
        }
        // Clickable status filter chips for the Tagged · pending-delete view.
        // 'dismissed' = the operator removed the delete tag in Zoho, so the admin
        // will never delete it — the re-check moved it out of Pending.
        function _erRenderTaggedHeader() {
            const progress = document.getElementById('erTaggedProgress');
            if (!progress) return;
            const counts = window._erTaggedCounts || {};
            const f = window._erTaggedFilter || 'all';
            const chip = function (key, label, n, activeCls) {
                const active = f === key;
                const cls = active ? (activeCls + ' ring-2 ring-offset-1 ring-gray-300') : 'bg-gray-100 text-gray-600 hover:bg-gray-200';
                return '<button data-on-click="erTaggedFilter" data-args="[&quot;' + key + '&quot;]" class="px-2 py-0.5 rounded text-xs font-medium ' + cls + '" title="Show only these">' + label + ': ' + n + '</button>';
            };
            progress.innerHTML = chip('all', 'All tagged', (counts.tagged || 0), 'bg-gray-800 text-white')
                + ' ' + chip('deleted', 'Deleted', (counts.deleted || 0), 'bg-emerald-600 text-white')
                + ' ' + chip('pending_delete', 'Pending', (counts.pending || 0), 'bg-amber-500 text-white')
                + ' ' + chip('dismissed', 'Dismissed', (counts.dismissed || 0), 'bg-slate-600 text-white');
        }
        function erTaggedFilter(status) {
            window._erTaggedFilter = status;
            window._erTaggedPage = 0;
            _erRenderTaggedHeader();
            _erRenderTaggedPage();
        }
        function _erTaggedFilteredRows() {
            const rows = window._erTagged || [];
            const f = window._erTaggedFilter || 'all';
            return f === 'all' ? rows : rows.filter(function (r) { return r.status === f; });
        }
        // Manually dismiss one pending record from the delete queue (local only).
        async function erDismissTagged(zohoId) {
            try {
                const res = await fetch('/api/duplicates/empty-records/dismiss-tagged', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin', body: JSON.stringify({ zohoId: zohoId }),
                });
                const j = await res.json();
                if (!res.ok || !j.success) throw new Error((j && j.error) || ('HTTP ' + res.status));
                const rows = window._erTagged || [];
                const row = rows.find(function (r) { return r.zohoId === zohoId; });
                if (row) row.status = 'dismissed';
                const counts = window._erTaggedCounts || {};
                counts.pending = Math.max(0, (counts.pending || 0) - 1);
                counts.dismissed = (counts.dismissed || 0) + 1;
                _erRenderTaggedHeader();
                _erRenderTaggedPage();
            } catch (e) {
                alert('Dismiss failed: ' + (e && e.message || e));
            }
        }
        function erTaggedChangePage(delta) {
            const rows = _erTaggedFilteredRows();
            const pages = Math.max(1, Math.ceil(rows.length / ER_PAGE_SIZE));
            window._erTaggedPage = Math.min(pages - 1, Math.max(0, (window._erTaggedPage || 0) + delta));
            _erRenderTaggedPage();
        }
        function _erRenderTaggedPage() {
            const body = document.getElementById('erTaggedBody');
            if (!body) return;
            const rows = _erTaggedFilteredRows();
            const table = body.closest('table');
            const clearPager = function () { const tf = table && table.querySelector('tfoot.er-pager'); if (tf) tf.innerHTML = ''; };
            if (!rows.length) {
                const f = window._erTaggedFilter || 'all';
                body.innerHTML = '<tr><td colspan="5" class="px-4 py-4 text-center text-sm text-gray-400">' + (f === 'all' ? 'None yet.' : 'No ' + escapeHtml(f === 'pending_delete' ? 'pending' : f) + ' records.') + '</td></tr>';
                clearPager();
                return;
            }
            const pages = Math.max(1, Math.ceil(rows.length / ER_PAGE_SIZE));
            const cur = Math.min(pages - 1, Math.max(0, window._erTaggedPage || 0));
            window._erTaggedPage = cur;
            const start = cur * ER_PAGE_SIZE;
            const pageRows = rows.slice(start, start + ER_PAGE_SIZE);
            body.innerHTML = pageRows.map(function (r) {
                const kindMap = { Deals: 'deals', Accounts: 'accounts', Contacts: 'contacts' };
                const kind = kindMap[r.module] || 'accounts';
                const link = '<a href="' + erZohoUrl(kind, r.zohoId) + '" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-mono text-xs">' + escapeHtml(r.zohoId) + '</a>';
                const statusChip = r.status === 'deleted'
                    ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">' + escapeHtml(WalaPlusI18n.t('duplicates.er_status_deleted')) + '</span>'
                    : r.status === 'dismissed'
                    ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-700" title="Delete tag was removed in Zoho — will NOT be deleted by admin">Dismissed</span>'
                    : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">' + escapeHtml(WalaPlusI18n.t('duplicates.er_status_pending')) + '</span>';
                const taggedAt = r.createdAt ? new Date(r.createdAt).toLocaleString() : '—';
                // Pending rows get a manual Dismiss (local disposition — no Zoho write).
                const statusCell = r.status === 'pending_delete'
                    ? statusChip + ' <button data-on-click="erDismissTagged" data-args="[&quot;' + escapeHtml(r.zohoId) + '&quot;]" class="ms-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-slate-300 text-slate-600 hover:bg-slate-100" title="Move to Dismissed without changing Zoho — it will not be deleted by admin">Dismiss</button>'
                    : statusChip;
                return '<tr class="border-t border-gray-100">'
                    + '<td class="px-3 py-2">' + link + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(r.module || '—') + '</td>'
                    + '<td class="px-3 py-2">' + statusCell + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-600">' + escapeHtml(r.taggedBy || '—') + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-500">' + escapeHtml(taggedAt) + '</td>'
                    + '</tr>';
            }).join('');
            if (table) {
                let tf = table.querySelector('tfoot.er-pager');
                if (rows.length > ER_PAGE_SIZE) {
                    if (!tf) { tf = document.createElement('tfoot'); tf.className = 'er-pager'; table.appendChild(tf); }
                    const from = start + 1, to = start + pageRows.length;
                    const prevDis = cur === 0 ? ' opacity-40 pointer-events-none' : ' hover:bg-gray-100';
                    const nextDis = cur >= pages - 1 ? ' opacity-40 pointer-events-none' : ' hover:bg-gray-100';
                    tf.innerHTML = '<tr class="bg-gray-50"><td colspan="5" class="px-3 py-2">'
                        + '<div class="flex items-center justify-between text-xs text-gray-600">'
                        + '<span>Showing ' + from.toLocaleString() + '–' + to.toLocaleString() + ' of ' + rows.length.toLocaleString() + '</span>'
                        + '<span class="flex items-center gap-2">'
                        + '<button data-on-click="erTaggedChangePage" data-args="[-1]" class="px-2 py-1 rounded border border-gray-300' + prevDis + '">‹ Prev</button>'
                        + '<span>Page ' + (cur + 1) + ' / ' + pages + '</span>'
                        + '<button data-on-click="erTaggedChangePage" data-args="[1]" class="px-2 py-1 rounded border border-gray-300' + nextDis + '">Next ›</button>'
                        + '</span></div></td></tr>';
                } else if (tf) { tf.innerHTML = ''; }
            }
        }
        async function erRecheckDeletions() {
            const progress = document.getElementById('erTaggedProgress');
            if (progress) progress.textContent = 'Re-checking…';
            const j = await erAdminPost('/api/duplicates/empty-records/recheck-deletions', {});
            if (!j) { if (progress) progress.textContent = 'Cancelled.'; return; }
            if (!j.success) { if (progress) progress.textContent = 'Error: ' + (j.error || 'failed'); return; }
            await erLoadTaggedStatus();
            const prog = document.getElementById('erTaggedProgress');
            if (prog) {
                // erLoadTaggedStatus re-rendered the filter chips (innerHTML) — append
                // the re-check result as a note rather than overwriting them.
                const note = document.createElement('span');
                note.className = 'ms-2 text-xs text-gray-500';
                note.textContent = 'checked ' + (j.checked || 0) + ' · ' + (j.nowDeleted || 0) + ' now deleted · ' + (j.nowDismissed || 0) + ' now dismissed';
                prog.appendChild(note);
            }
        }
        async function erTagSelected() {
            // Read from the persisted per-module selection set so records selected
            // on ANY page are tagged (not just the visible page's checkboxes).
            window._erSel = window._erSel || {};
            const byModule = {};
            let totalSel = 0;
            ['Deals', 'Accounts', 'Contacts'].forEach(function (m) {
                const ids = Object.keys(window._erSel[m] || {});
                if (ids.length) { byModule[m] = ids; totalSel += ids.length; }
            });
            if (!totalSel) return;
            if (!confirm('Tag ' + totalSel + ' record(s) with "Empty-Delete"?\n\nThis adds the tag in Zoho for the admin to delete. The platform never deletes.')) return;
            const result = document.getElementById('erBulkResult');
            const undoPayload = { modules: [] };
            let total = 0;
            for (const m in byModule) {
                if (result) result.textContent = 'Tagging ' + m + '…';
                const j = await erAdminPost('/api/duplicates/empty-records/tag', { module: m, zohoIds: byModule[m] });
                if (!j) { if (result) result.textContent = 'Cancelled.'; return; }
                if (!j.success) { if (result) result.textContent = 'Error: ' + (j.error || 'failed'); return; }
                total += j.tagged || 0;
                undoPayload.modules.push({ module: m, zohoIds: byModule[m] });
                const kind = m.toLowerCase();
                window['_er_' + kind] = (window['_er_' + kind] || []).filter(function (r) { return byModule[m].indexOf(String(r.zohoId)) === -1; });
                window._erSel[m] = {}; // tagged records are gone → drop their selection
                window['_erPage_' + kind] = 0; // counts changed → back to page 1
                erRender(kind, 'er' + m + 'Body');
                const chip = document.getElementById('erCount-' + kind);
                if (chip) chip.textContent = (window['_er_' + kind] || []).length.toLocaleString();
            }
            window._erLastTagged = undoPayload;
            if (result) result.textContent = '✓ Tagged ' + total + ' record(s) Empty-Delete. Admin deletes in Zoho.';
            const undoBtn = document.getElementById('erUndoBtn');
            if (undoBtn) undoBtn.classList.remove('hidden');
            erSelChanged();
        }
        // Remove records from the local list + selection and re-render (shared by
        // dismiss). erRender clamps the page if the last row of a page goes away.
        function _erRemoveLocal(kind, ids) {
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const gone = {};
            ids.forEach(function (x) { gone[String(x)] = true; });
            window['_er_' + kind] = (window['_er_' + kind] || []).filter(function (r) { return !gone[String(r.zohoId)]; });
            if (window._erSel && window._erSel[module]) ids.forEach(function (x) { delete window._erSel[module][String(x)]; });
            erRender(kind, 'er' + module + 'Body');
            const chip = document.getElementById('erCount-' + kind);
            if (chip) chip.textContent = (window['_er_' + kind] || []).length.toLocaleString();
            erSelChanged();
        }
        // Per-row Dismiss — "not empty, keep it". Durable; no Zoho write.
        async function erDismiss(kind, id) {
            const module = kind === 'deals' ? 'Deals' : kind === 'accounts' ? 'Accounts' : 'Contacts';
            const j = await erAdminPost('/api/duplicates/empty-records/dismiss', { module: module, zohoIds: [String(id)] });
            if (!j) return; // cancelled at admin-key prompt
            if (!j.success) { alert('Could not dismiss: ' + (j.error || 'failed')); return; }
            _erRemoveLocal(kind, [String(id)]);
        }
        // Bulk Dismiss for the current selection (across all pages).
        async function erDismissSelected() {
            window._erSel = window._erSel || {};
            const byModule = {};
            let total = 0;
            ['Deals', 'Accounts', 'Contacts'].forEach(function (m) {
                const ids = Object.keys(window._erSel[m] || {});
                if (ids.length) { byModule[m] = ids; total += ids.length; }
            });
            if (!total) return;
            if (!confirm('Dismiss ' + total + ' record(s) as "not empty — keep"?\n\nThey are removed from the cleanup list and will not reappear. No Zoho changes.')) return;
            const result = document.getElementById('erBulkResult');
            let done = 0;
            for (const m in byModule) {
                if (result) result.textContent = 'Dismissing ' + m + '…';
                const j = await erAdminPost('/api/duplicates/empty-records/dismiss', { module: m, zohoIds: byModule[m] });
                if (!j) { if (result) result.textContent = 'Cancelled.'; return; }
                if (!j.success) { if (result) result.textContent = 'Error: ' + (j.error || 'failed'); return; }
                done += byModule[m].length;
                _erRemoveLocal(m.toLowerCase(), byModule[m]);
            }
            if (result) result.textContent = '✓ Dismissed ' + done + ' record(s) — kept, removed from cleanup.';
        }
        async function erUndoLast() {
            const payload = window._erLastTagged;
            if (!payload || !payload.modules || !payload.modules.length) return;
            if (!confirm('Remove the Empty-Delete tag from the last batch?')) return;
            const result = document.getElementById('erBulkResult');
            for (const grp of payload.modules) {
                const j = await erAdminPost('/api/duplicates/empty-records/untag', { module: grp.module, zohoIds: grp.zohoIds });
                if (!j || !j.success) { if (result) result.textContent = 'Undo error.'; return; }
            }
            if (result) result.textContent = '↩ Removed Empty-Delete tag from last batch. Refresh a section to see them again.';
            window._erLastTagged = null;
            const undoBtn = document.getElementById('erUndoBtn');
            if (undoBtn) undoBtn.classList.add('hidden');
        }

        // ── Persisted doc-compliance results (localStorage) ──────────────────
        // Keyed by Zoho deal id, independent of stage, so re-opening the tab
        // shows prior results without re-scanning. Capped/pruned to stay small.
        var DC_STORE_KEY = 'dc_doc_results_v1';
        function _dcStoreLoad() {
            try { return JSON.parse(localStorage.getItem(DC_STORE_KEY) || '{}') || {}; }
            catch (e) { return {}; }
        }
        function _dcStorePut(id, rec) {
            try {
                var store = _dcStoreLoad();
                store[String(id)] = rec;
                var keys = Object.keys(store);
                if (keys.length > 5000) { // prune oldest by checkedAt
                    keys.sort(function (a, b) { return (store[a].checkedAt || '') < (store[b].checkedAt || '') ? -1 : 1; });
                    keys.slice(0, keys.length - 5000).forEach(function (k) { delete store[k]; });
                }
                localStorage.setItem(DC_STORE_KEY, JSON.stringify(store));
            } catch (e) { /* quota / disabled storage — non-fatal */ }
        }
        function _dcWhen(iso) {
            if (!iso) return '';
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            try { return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
            catch (e) { return iso; }
        }
        // Renders the document-status cell from a stored/live result record.
        function _dcDocCellHtml(id, rec, stage) {
            var present = (rec.present || []).map(function (l) { return '<div class="text-xs text-green-700">✓ ' + escapeHtml(l) + '</div>'; }).join('');
            var missing = (rec.missing || []).map(function (l) { return '<div class="text-xs text-red-700">✗ ' + escapeHtml(l) + '</div>'; }).join('');
            var head = rec.compliant
                ? '<div class="text-xs font-medium text-green-700 mb-1">✓ All required docs present (' + (rec.attachmentCount || 0) + ' files)</div>'
                : '<div class="text-xs font-medium text-red-700 mb-1">✗ ' + ((rec.missing || []).length) + ' missing (' + (rec.attachmentCount || 0) + ' files attached)</div>';
            // Surface "checked by" alongside the timestamp so a second
            // reviewer can see who already ran the scan on this deal
            // (the server's deal_doc_compliance row carries checkedBy,
            // overlaid by _dcRehydrateFromServer). Cross-team visibility.
            var byPart = rec.checkedBy ? ' by ' + escapeHtml(String(rec.checkedBy)) : '';
            var when = rec.checkedAt ? '<div class="text-[10px] text-gray-400 mt-0.5" title="Persisted in deal_doc_compliance. Whoever scans this deal most recently overwrites the checkedBy field.">checked ' + escapeHtml(_dcWhen(rec.checkedAt)) + byPart + '</div>' : '';
            var recheck = '<button data-on-click="checkDealDocs" data-args=\'' + escapeHtml(JSON.stringify([String(id), String(stage || rec.stage || '')])) + '\' class="text-[10px] text-blue-600 hover:underline">↻ re-check</button>';
            return head + present + missing + when + recheck;
        }
        // After deals load, restore any previously-scanned results for the
        // visible deals and paint their status cells. localStorage paints
        // instantly; then the SERVER copy (shared across users/devices) is
        // overlaid as the authoritative source.
        function _dcRehydrateFromStore() {
            var deals = window._dcDeals || [];
            if (!deals.length) return;
            var store = _dcStoreLoad();
            var restored = 0;
            deals.forEach(function (d) {
                var rec = store[String(d.id)];
                if (!rec) return;
                window._dcResults[String(d.id)] = rec;
                var span = document.getElementById('docs-' + d.id);
                if (span) span.innerHTML = _dcDocCellHtml(d.id, rec, d.stage);
                restored++;
            });
            if (restored > 0) _dcUpdateCards();
            _dcRehydrateFromServer(); // authoritative shared copy (async overlay)
        }

        // Overlay the server-persisted results (shared, durable) for the
        // visible deals — so a scan run on another device / by a teammate
        // shows up here too. Best-effort: localStorage already painted.
        async function _dcRehydrateFromServer() {
            var deals = window._dcDeals || [];
            if (!deals.length) return;
            var ids = deals.map(function (d) { return String(d.id); });
            var data;
            try {
                var res = await fetch('/api/duplicates/deal-compliance/results?ids=' + encodeURIComponent(ids.join(',')), { credentials: 'same-origin' });
                if (!res.ok) return;
                data = await res.json();
            } catch (e) { return; }
            var results = (data && data.results) || {};
            var n = 0;
            deals.forEach(function (d) {
                var rec = results[String(d.id)];
                if (!rec) return;
                window._dcResults[String(d.id)] = rec;
                _dcStorePut(d.id, rec); // keep local cache in sync with server
                var span = document.getElementById('docs-' + d.id);
                if (span) span.innerHTML = _dcDocCellHtml(d.id, rec, d.stage);
                n++;
            });
            if (n > 0) _dcUpdateCards();
        }

        // CSV export of the deals shown + their document status.
        function exportDealCompliance() {
            var deals = window._dcDeals || [];
            if (!deals.length) { alert('Nothing to export — load the tab first.'); return; }
            var results = window._dcResults || {};
            var esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
            var rows = [['Deal', 'Stage', 'Owner', 'Lead source', 'Created', 'Amount', 'Account', 'Doc status', 'Missing documents', 'Attachments', 'Checked at'].join(',')];
            deals.forEach(function (d) {
                var r = results[String(d.id)];
                var status = !r ? 'not checked' : (r.compliant ? 'compliant' : 'missing docs');
                var miss = r ? r.missing.join('; ') : '';
                var att = r ? r.attachmentCount : '';
                var when = r && r.checkedAt ? r.checkedAt : '';
                rows.push([esc(d.name), esc(d.stage), esc(d.owner), esc(d.source), esc(d.createdTime), esc(d.amount), esc(d.accountName), esc(status), esc(miss), esc(att), esc(when)].join(','));
            });
            var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'deal-compliance.csv';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }

        // ─── Account Hints (smart account inference) ────────────────────────
        window._accountHintsFilter = window._accountHintsFilter || 'pending';

        function filterAccountHints(status) {
            window._accountHintsFilter = status;
            loadAccountHints();
        }

        async function loadAccountHints() {
            const status = window._accountHintsFilter || 'pending';
            ['pending','applied','dismissed'].forEach(k => {
                const el = document.getElementById('accountHintsChip-' + k);
                if (!el) return;
                if (k === status) {
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-gray-900 text-white';
                } else {
                    const palette = {
                        pending:   'bg-amber-100 text-amber-700 hover:bg-amber-200',
                        applied:   'bg-emerald-100 text-emerald-700 hover:bg-emerald-200',
                        dismissed: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
                    };
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + palette[k];
                }
            });
            const body = document.getElementById('accountHintsTable');
            body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>';
            // Track this load so a later filter switch / tab change cancels
            // any in-flight auto-retry instead of stomping the new view.
            const loadId = (window._accountHintsLoadId = (window._accountHintsLoadId || 0) + 1);
            const MAX_RETRIES = 5;
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const res = await fetch('/api/duplicates/account-hints?status=' + encodeURIComponent(status));
                    if (loadId !== window._accountHintsLoadId) return; // superseded
                    if (res.status === 429 && attempt < MAX_RETRIES) {
                        // Honor Retry-After (seconds) when present, else back off
                        // 5s → 10s → 20s → 40s → 60s.
                        const retryAfterHdr = parseInt(res.headers.get('Retry-After') || '', 10);
                        const waitSec = Number.isFinite(retryAfterHdr) && retryAfterHdr > 0
                            ? Math.min(retryAfterHdr, 60)
                            : Math.min(5 * Math.pow(2, attempt), 60);
                        body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-amber-700">'
                            + 'Rate-limited by the server — retrying in ' + waitSec + 's… '
                            + '<span class="text-xs text-gray-500">(attempt ' + (attempt + 1) + ' of ' + MAX_RETRIES + ')</span>'
                            + '</td></tr>';
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                        if (loadId !== window._accountHintsLoadId) return;
                        continue;
                    }
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    if (loadId !== window._accountHintsLoadId) return;
                    renderAccountHints(data);
                    return;
                } catch (e) {
                    if (loadId !== window._accountHintsLoadId) return;
                    const msg = String(e && e.message || e);
                    const friendly = /HTTP 429/.test(msg)
                        ? 'The server is still rate-limited. Wait a minute and try again.'
                        : 'Failed to load: ' + escapeHtml(msg);
                    body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-red-600">' + friendly + '</td></tr>';
                    return;
                }
            }
        }

        // Sort state — mirrors sortCsOverlap / sortCsLifecycle.
        window._accountHintsSort = window._accountHintsSort || { key: null, dir: 'desc' };

        function accountHintsSortValue(h, key) {
            switch (key) {
                case 'deal':       return (h.deal_company_name || h.deal_account_name || '').toLowerCase();
                case 'current':    return (h.deal_account_name || '').toLowerCase();
                case 'suggested':  return (h.suggested_account_name || '').toLowerCase();
                case 'domain':     return (h.suggested_domain || '').toLowerCase();
                case 'evidence':   return (h.evidence_contact_email || '').toLowerCase();
                case 'confidence': return Number(h.confidence || 0);
                default:           return 0;
            }
        }

        function sortAccountHintsRows(rows, key, dir) {
            const factor = dir === 'asc' ? 1 : -1;
            return rows.slice().sort((a, b) => {
                const va = accountHintsSortValue(a, key);
                const vb = accountHintsSortValue(b, key);
                if (va < vb) return -1 * factor;
                if (va > vb) return  1 * factor;
                return 0;
            });
        }

        function updateAccountHintsSortIndicators() {
            const headers = document.querySelectorAll('#accountHintsTableHead .account-hints-sort');
            headers.forEach(h => {
                const key = h.getAttribute('data-sort-key');
                const ind = h.querySelector('.account-hints-sort-indicator');
                if (!ind) return;
                if (key === window._accountHintsSort.key) {
                    ind.textContent = window._accountHintsSort.dir === 'asc' ? '↑' : '↓';
                    ind.classList.remove('opacity-30');
                    ind.classList.add('text-gray-900');
                } else {
                    ind.textContent = '⇅';
                    ind.classList.add('opacity-30');
                    ind.classList.remove('text-gray-900');
                }
            });
        }

        function sortAccountHintsBy(key) {
            const cur = window._accountHintsSort;
            if (cur.key === key) {
                cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
            } else {
                cur.key = key;
                cur.dir = key === 'confidence' ? 'desc' : 'asc';
            }
            window._accountHintsPage = 0;
            if (window._accountHintsData) renderAccountHints(window._accountHintsData);
        }

        function renderAccountHints(data) {
            // Cache for the per-tab "Export CSV" button (exportAccountHints).
            window._accountHintsData = data;
            updateAccountHintsSortIndicators();
            const summary = data.summary || { pending: 0, applied: 0, dismissed: 0 };
            document.getElementById('accountHintsSumPending').textContent   = summary.pending;
            document.getElementById('accountHintsSumApplied').textContent   = summary.applied;
            document.getElementById('accountHintsSumDismissed').textContent = summary.dismissed;
            // Top-nav badge reflects pending count so users see new suggestions
            // without opening the tab.
            const badge = document.getElementById('accountHintsPendingBadge');
            if (badge) {
                if (summary.pending > 0) {
                    badge.textContent = summary.pending;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }

            const body = document.getElementById('accountHintsTable');
            const allHints = data.hints || [];
            if (allHints.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">No hints in this bucket. Click <em>Run scan</em> to generate fresh suggestions.</td></tr>';
                // Reset the pagination footer too — otherwise it keeps the stale
                // count from the previously-viewed bucket (e.g. "1–20 of 475"
                // under an empty Pending bucket after everything was Applied).
                renderPagination('accountHintsPagination', 0, 1, () => {}, 0, 'hints');
                return;
            }
            // Advanced Filter — client-side. Account Hints expose
            // suggested_domain and a numeric confidence; map both.
            const rows = allHints.filter(h => rowMatchesAdvancedFilter(h, {
                domainField:     'suggested_domain',
                confidenceField: 'confidence',
            }));
            if (rows.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">No hints match the active filters. Adjust the bucket chip or click <em>Clear All Filters</em>.</td></tr>';
                renderPagination('accountHintsPagination', 0, 1, () => {}, 0, 'hints');
                return;
            }
            // Full-array sort — sort the WHOLE filtered list before paginating.
            // No key selected yet = keep the bucket's default (server) order.
            const sortedRows = window._accountHintsSort.key
                ? sortAccountHintsRows(rows, window._accountHintsSort.key, window._accountHintsSort.dir)
                : rows;
            // Client-side pagination — 20 hints per page.
            window._accountHintsPage = Number.isFinite(window._accountHintsPage) ? window._accountHintsPage : 0;
            const accountHintsTotalPages = Math.max(1, Math.ceil(sortedRows.length / RADAR_PAGE_SIZE));
            if (window._accountHintsPage >= accountHintsTotalPages) window._accountHintsPage = 0;
            const accountHintsPageStart = window._accountHintsPage * RADAR_PAGE_SIZE;
            const accountHintsSlice = sortedRows.slice(accountHintsPageStart, accountHintsPageStart + RADAR_PAGE_SIZE);
            renderPagination('accountHintsPagination', window._accountHintsPage, accountHintsTotalPages,
                (p) => { window._accountHintsPage = p; renderAccountHints(window._accountHintsData); },
                sortedRows.length, 'hints');
            body.innerHTML = accountHintsSlice.map(h => {
                const dealCell = h.deal_zoho_id
                    ? zohoLink(h.deal_zoho_id, 'Deals', h.deal_company_name || h.deal_account_name || h.deal_zoho_id)
                    : escapeHtml(h.deal_company_name || h.deal_account_name || '—');
                const suggestedCell = h.suggested_account_zoho_id
                    ? zohoLink(h.suggested_account_zoho_id, 'Accounts', h.suggested_account_name || h.suggested_account_zoho_id)
                    : escapeHtml(h.suggested_account_name || '—');
                const evidenceCell = h.evidence_contact_zoho_id && h.evidence_contact_email
                    ? zohoLink(h.evidence_contact_zoho_id, 'Contacts', h.evidence_contact_email)
                    : escapeHtml(h.evidence_contact_email || '—');
                const conf = Number(h.confidence || 0);
                const confColor = conf >= 80 ? 'text-emerald-700' : conf >= 60 ? 'text-amber-700' : 'text-gray-600';
                // High-confidence rows (≥70%) get the 🤖 Resolve with AI
                // button — one click writes Account_Name on the Zoho Deal
                // and flips the hint to Applied. Below the threshold, only
                // the manual Applied / Dismiss path is exposed so the user
                // doesn't accidentally auto-apply a low-signal guess.
                const aiEligible = h.status === 'pending' && Number(h.confidence || 0) >= 70;
                const actions = h.status === 'pending'
                    ? (aiEligible
                        ? '<button data-on-click="resolveAccountHintWithAi" data-args="[' + h.id + ']" class="px-2 py-1 rounded bg-purple-600 text-white text-xs hover:bg-purple-700 me-1" title="Write the suggested Account_Name on the Zoho Deal automatically — confidence ≥70%, attributed to GRQ Assistant.">🤖 Resolve with AI</button>'
                        : '')
                    + '<button data-on-click="markAccountHintApplied" data-args="[' + h.id + ']" class="px-2 py-1 rounded bg-emerald-600 text-white text-xs hover:bg-emerald-700" title="I fixed the Zoho record — mark applied">Applied</button>'
                    + ' <button data-on-click="dismissAccountHint" data-args="[' + h.id + ']" class="px-2 py-1 rounded bg-gray-200 text-gray-700 text-xs hover:bg-gray-300" title="This suggestion is wrong">Dismiss</button>'
                    : '<span class="text-xs text-gray-400 capitalize">' + escapeHtml(h.status) + '</span>';
                return '<tr class="hover:bg-gray-50">'
                    + '<td class="px-3 py-2 text-xs text-gray-800">' + dealCell + '</td>'
                    + '<td class="px-3 py-2 text-xs"><span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800">' + escapeHtml(h.deal_account_name || '— missing —') + '</span></td>'
                    + '<td class="px-3 py-2 text-xs text-gray-800">' + suggestedCell + '</td>'
                    + '<td class="px-3 py-2 text-xs font-mono text-gray-700">' + escapeHtml(h.suggested_domain || '—') + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-700">' + evidenceCell + '</td>'
                    + '<td class="px-3 py-2 text-xs text-end font-medium ' + confColor + '">' + conf + '%</td>'
                    + '<td class="px-3 py-2 text-xs text-end whitespace-nowrap">' + actions + '</td>'
                    + '</tr>';
            }).join('');
        }

        async function runAccountHintsScan() {
            const btn = document.getElementById('accountHintsScanBtn');
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Scanning…';
            try {
                const res = await fetch('/api/duplicates/account-hints/scan', { method: 'POST' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                const ts = new Date().toLocaleTimeString();

                // Surface ALL counters the backend returns. Previously this
                // dropped no_contact + no_match, which were exactly the two
                // numbers that explained a "scanned N, hinted 0" outcome:
                // is it that the problem deals have no linked Contact at
                // all (no_contact), or that the contacts exist but their
                // email domain doesn't match any Account record (no_match)?
                // Each failure mode has a different remediation, so the
                // operator needs to see both to act.
                const noContact = Number(data.no_contact || 0);
                const noMatch   = Number(data.no_match || 0);
                const scanned   = Number(data.scanned   || 0);
                const hinted    = Number(data.hinted    || 0);
                const inserted  = Number(data.inserted  || 0);
                const updated   = Number(data.updated   || 0);

                // Inline plain-English explanation when nothing was hinted.
                // Each branch maps to a specific data-quality finding the
                // operator can act on, instead of staring at "hinted 0" and
                // wondering whether the engine is broken.
                let explainer = '';
                if (scanned === 0) {
                    explainer = ' — no deals need help (every deal already has a real Account_Name or sits in a cluster with a real corporate domain).';
                } else if (hinted === 0) {
                    if (noContact === scanned) {
                        explainer = ' — all problem deals have NO linked Contact in Zoho (the engine walks deal → contact → account; no contact = no inference path). Fix in Zoho: set Contact_Name on each deal, re-sync, re-scan.';
                    } else if (noMatch === scanned) {
                        explainer = ' — every problem deal has a linked contact, but their email domains do not match any Account record (or the domains are free-mail). Fix in Zoho: set the Account_Name directly, or set a corporate Company_Domain on the related Account.';
                    } else if (noContact > 0 && noMatch > 0) {
                        explainer = ` — ${noContact} deal(s) have no linked Contact; ${noMatch} have contacts whose domain didn't match any Account. Mix of both data-quality gaps above.`;
                    }
                }

                const summary = `${ts} — scanned ${scanned}, hinted ${hinted} (${inserted} new, ${updated} refreshed; ${noContact} no-contact, ${noMatch} no-domain-match)${explainer}`;
                document.getElementById('accountHintsLastScan').textContent = summary;
                await loadAccountHints();
            } catch (e) {
                alert('Scan failed: ' + (e.message || e));
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        async function setAccountHintStatus(id, status) {
            try {
                const res = await fetch('/api/duplicates/account-hints/' + id + '/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                await loadAccountHints();
            } catch (e) {
                alert('Update failed: ' + (e.message || e));
            }
        }
        function markAccountHintApplied(id) { return setAccountHintStatus(id, 'applied'); }
        function dismissAccountHint(id)     { return setAccountHintStatus(id, 'dismissed'); }

        // Bulk version: loop every pending hint ≥70% confidence and let
        // the backend write Account_Name on each Zoho Deal. Confirmation
        // dialog first (this is a Zoho write, not a local-only flag).
        async function resolveAllAccountHintsWithAi() {
            const btn = document.getElementById('accountHintsAiResolveAllBtn');
            const panel = document.getElementById('accountHintsAiResolveAllPanel');
            if (!btn || !panel) return;
            const hintsList = (window._accountHintsData && window._accountHintsData.hints) || [];
            const pendingTotal = hintsList.filter(h => h.status === 'pending' && Number(h.confidence || 0) >= 70).length;
            const ok = window.confirm('AI-resolve every pending hint with confidence ≥70% (' + (pendingTotal || 'all') + ' rows)? Each one writes Account_Name on the Zoho Deal and flips the hint to Applied. This is a real Zoho write, attributed to GRQ Assistant.');
            if (!ok) return;
            btn.disabled = true;
            const original = btn.textContent;
            btn.textContent = 'Resolving…';
            panel.innerHTML = '<div class="px-3 py-2 rounded bg-purple-50 border border-purple-200 text-purple-800">Looping through Zoho Deals…</div>';
            try {
                const res = await fetch('/api/duplicates/account-hints/resolve-all-with-ai', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok || !data) {
                    panel.innerHTML = '<div class="px-3 py-2 rounded bg-amber-50 border border-amber-200 text-amber-800">' + escapeHtml((data && data.error) || ('Server returned ' + res.status)) + '</div>';
                    return;
                }
                const tone = data.errors === 0 && data.resolved > 0 ? 'emerald'
                           : data.errors > 0 ? 'amber'
                           : 'gray';
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-' + tone + '-50 border border-' + tone + '-200 text-' + tone + '-800">'
                    + '<strong>Done.</strong> Resolved ' + data.resolved + ' of ' + data.inspected
                    + (data.refused ? ' · ' + data.refused + ' refused (below threshold)' : '')
                    + (data.errors ? ' · <span class="text-amber-700">' + data.errors + ' Zoho error(s)</span>' : '')
                    + '. Reloading list…</div>';
                await loadAccountHints();
            } catch (e) {
                panel.innerHTML = '<div class="px-3 py-2 rounded bg-red-50 border border-red-200 text-red-800">Failed: ' + escapeHtml(String(e && e.message || e)) + '</div>';
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        // One-click AI resolve: POST to the new endpoint, the backend
        // writes Account_Name on the Zoho Deal + marks the hint applied.
        // We optimistically show "Resolving…" then reload the table so the
        // row moves from Pending → Applied. Refuses inline for sub-threshold
        // confidence (the backend gates at 70% by default) — the reason
        // surfaces back as `reason` and we show it as a toast.
        async function resolveAccountHintWithAi(id) {
            try {
                const res = await fetch('/api/duplicates/account-hints/' + id + '/resolve-with-ai', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok) {
                    alert('AI resolve failed: ' + ((data && (data.error || data.reason)) || ('HTTP ' + res.status)));
                    return;
                }
                if (data && data.success === false) {
                    alert(data.reason || data.error || 'AI resolve refused.');
                    return;
                }
                await loadAccountHints();
            } catch (e) {
                alert('AI resolve failed: ' + (e && e.message ? e.message : e));
            }
        }

        // ─── Record Hint — Sections 2 & 3 (Contact→Account, Deal↔Contact) ────
        // Section 1 (Deal→Account) stays on the original account-hints
        // endpoints/handlers above, unchanged. These two new sections share
        // the generic /api/duplicates/record-hints endpoint, distinguished
        // by `type`. Row markup mirrors renderAccountHints() rows exactly
        // (source · current · suggested · domain · evidence · confidence ·
        // actions) so the three sections look and behave identically.
        window._recordHints = window._recordHints || {};

        const RECORD_HINT_TBODY_BY_TYPE = {
            contact_account: 'recordHintsContactAccountBody',
            deal_contact: 'recordHintsDealContactBody',
        };
        const RECORD_HINT_BADGE_BY_TYPE = {
            contact_account: 'recordHintsContactAccountPendingBadge',
            deal_contact: 'recordHintsDealContactPendingBadge',
        };
        const RECORD_HINT_SCAN_BTN_BY_TYPE = {
            contact_account: 'recordHintsContactAccountScanBtn',
            deal_contact: 'recordHintsDealContactScanBtn',
        };

        async function renderRecordHintsSection(type, tbodyId) {
            const body = document.getElementById(tbodyId);
            if (!body) return;
            body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>';
            try {
                const res = await fetch('/api/duplicates/record-hints?type=' + encodeURIComponent(type) + '&status=pending');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                window._recordHints[type] = data;

                const badge = document.getElementById(RECORD_HINT_BADGE_BY_TYPE[type]);
                const hints = data.hints || [];
                const pending = hints.filter(h => h.status === 'pending').length;
                if (badge) {
                    if (pending > 0) {
                        badge.textContent = pending;
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }

                if (hints.length === 0) {
                    body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">No hints in this bucket. Click <em>Run scan</em> to generate fresh suggestions.</td></tr>';
                    return;
                }

                body.innerHTML = hints.map(h => {
                    // Field names + module derivation follow the /record-hints
                    // response contract: source_type ('contact'|'deal') and
                    // link_field ('Account_Name'|'Contact_Name') drive the module;
                    // names come from source_record_name / suggested_target_name.
                    const srcModule = h.source_type === 'deal' ? 'Deals' : 'Contacts';
                    const tgtModule = h.link_field === 'Contact_Name' ? 'Contacts' : 'Accounts';
                    const sourceName = h.source_record_name || h.source_zoho_id || '—';
                    const suggestedName = h.suggested_target_name || h.suggested_target_zoho_id || '—';
                    const sourceCell = h.source_zoho_id
                        ? zohoLink(h.source_zoho_id, srcModule, sourceName)
                        : escapeHtml(sourceName);
                    const suggestedCell = h.suggested_target_zoho_id
                        ? zohoLink(h.suggested_target_zoho_id, tgtModule, suggestedName)
                        : escapeHtml(suggestedName);
                    const evidenceCell = escapeHtml(h.evidence_detail || '—');
                    const conf = Number(h.confidence || 0);
                    const confColor = conf >= 80 ? 'text-emerald-700' : conf >= 60 ? 'text-amber-700' : 'text-gray-600';
                    const aiEligible = h.status === 'pending' && conf >= 70;
                    const actions = h.status === 'pending'
                        ? (aiEligible
                            ? '<button data-on-click="resolveRecordHintWithAi" data-args="[' + h.id + ',&quot;' + type + '&quot;]" class="px-2 py-1 rounded bg-purple-600 text-white text-xs hover:bg-purple-700 me-1" title="Write the suggested value on the Zoho record automatically — confidence ≥70%, attributed to GRQ Assistant.">🤖 Resolve with AI</button>'
                            : '')
                        + '<button data-on-click="markRecordHintApplied" data-args="[' + h.id + ',&quot;' + type + '&quot;]" class="px-2 py-1 rounded bg-emerald-600 text-white text-xs hover:bg-emerald-700" title="I fixed the Zoho record — mark applied">Applied</button>'
                        + ' <button data-on-click="dismissRecordHint" data-args="[' + h.id + ',&quot;' + type + '&quot;]" class="px-2 py-1 rounded bg-gray-200 text-gray-700 text-xs hover:bg-gray-300" title="This suggestion is wrong">Dismiss</button>'
                        : '<span class="text-xs text-gray-400 capitalize">' + escapeHtml(h.status) + '</span>';
                    return '<tr class="hover:bg-gray-50">'
                        + '<td class="px-3 py-2 text-xs text-gray-800">' + sourceCell + '</td>'
                        + '<td class="px-3 py-2 text-xs"><span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-800">' + escapeHtml(h.current_value || '— missing —') + '</span></td>'
                        + '<td class="px-3 py-2 text-xs text-gray-800">' + suggestedCell + '</td>'
                        + '<td class="px-3 py-2 text-xs font-mono text-gray-700">' + escapeHtml(h.suggested_domain || '—') + '</td>'
                        + '<td class="px-3 py-2 text-xs text-gray-700">' + evidenceCell + '</td>'
                        + '<td class="px-3 py-2 text-xs text-end font-medium ' + confColor + '">' + conf + '%</td>'
                        + '<td class="px-3 py-2 text-xs text-end whitespace-nowrap">' + actions + '</td>'
                        + '</tr>';
                }).join('');
            } catch (e) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-red-600">Failed to load: ' + escapeHtml(String(e && e.message || e)) + '</td></tr>';
            }
        }

        async function runRecordHintsScan(onlyType) {
            const btnId = onlyType ? RECORD_HINT_SCAN_BTN_BY_TYPE[onlyType] : null;
            const btn = btnId ? document.getElementById(btnId) : null;
            const original = btn ? btn.textContent : null;
            if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
            try {
                const res = await fetch('/api/duplicates/record-hints/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(onlyType ? { type: onlyType } : {}),
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                await res.json().catch(() => null);
                // Re-render BOTH new sections regardless of which scan button
                // was clicked — a scan can surface hints for either type, and
                // both tables should reflect the latest state.
                await renderRecordHintsSection('contact_account', 'recordHintsContactAccountBody');
                await renderRecordHintsSection('deal_contact', 'recordHintsDealContactBody');
            } catch (e) {
                alert('Scan failed: ' + (e && e.message ? e.message : e));
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = original; }
            }
        }

        async function setRecordHintStatus(id, type, status) {
            try {
                const res = await fetch('/api/duplicates/record-hints/' + id + '/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                await renderRecordHintsSection(type, RECORD_HINT_TBODY_BY_TYPE[type]);
            } catch (e) {
                alert('Update failed: ' + (e && e.message ? e.message : e));
            }
        }
        function markRecordHintApplied(id, type) { return setRecordHintStatus(id, type, 'applied'); }
        function dismissRecordHint(id, type)     { return setRecordHintStatus(id, type, 'dismissed'); }

        async function resolveRecordHintWithAi(id, type) {
            try {
                const res = await fetch('/api/duplicates/record-hints/' + id + '/resolve-with-ai', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok) {
                    alert('AI resolve failed: ' + ((data && (data.error || data.reason)) || ('HTTP ' + res.status)));
                    return;
                }
                if (data && data.success === false) {
                    alert(data.reason || data.error || 'AI resolve refused.');
                    return;
                }
                await renderRecordHintsSection(type, RECORD_HINT_TBODY_BY_TYPE[type]);
            } catch (e) {
                alert('AI resolve failed: ' + (e && e.message ? e.message : e));
            }
        }

        // ─── CS-pipeline overlap loaders ─────────────────────────────────────
        window._csOverlapFilter = 'all';

        function csVerdictBadge(v) {
            const map = {
                block:  { bg: 'bg-red-100',    fg: 'text-red-700',    label: 'BLOCK'  },
                review: { bg: 'bg-amber-100',  fg: 'text-amber-700',  label: 'REVIEW' },
                warn:   { bg: 'bg-yellow-100', fg: 'text-yellow-700', label: 'WARN'   },
            };
            const m = map[v] || { bg: 'bg-gray-100', fg: 'text-gray-600', label: (v || '—').toUpperCase() };
            return '<span class="px-2 py-1 text-xs font-bold rounded ' + m.bg + ' ' + m.fg + '">' + m.label + '</span>';
        }

        function csPhaseLabel(state) {
            const map = {
                onboarding:          'Onboarding',
                adoption:            'Adoption',
                renewal:             'Renewal',
                active_other:        'Active (custom phase)',
                termination_recent:  'Termination (recent)',
                termination_old:     'Termination (≥ cool-off)',
            };
            return map[state] || '—';
        }

        function csSectorLabel(s) {
            if (s === 'government') return '<span class="text-purple-700 font-medium">Government</span>';
            if (s === 'private')    return '<span class="text-blue-700 font-medium">Private</span>';
            return '<span class="text-gray-400">—</span>';
        }

        // ─── Cluster Merge Candidates (Sarah 2026-06-17) ────────────────
        // Loads same-domain duplicate clusters from
        // /api/duplicates/cluster-merge-candidates and renders one card
        // per offending domain. Each card lists every cluster on that
        // domain; operator picks a master radio + selects which sources
        // to merge in, then clicks Merge — backend reparents records,
        // snapshots sources, deletes the empty rows, logs the action.
        let _cmcData = null;
        async function loadClusterMergeCandidates() {
            const host = document.getElementById('cmcGroups');
            if (host) host.innerHTML = '<div class="text-center text-sm text-gray-500 py-8">Scanning duplicate_clusters for same-domain duplicates…</div>';
            try {
                const res = await fetch('/api/duplicates/cluster-merge-candidates?limit=200', { credentials: 'same-origin' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                _cmcData = data;
                _cmcRenderStats(data);
                _cmcRenderGroups(data);
            } catch (e) {
                if (host) host.innerHTML = '<div class="text-center text-sm text-red-600 py-8">Scan failed: ' + escapeHtml(e.message || String(e)) + '</div>';
            }
        }

        function _cmcRenderStats(data) {
            const groups = Array.isArray(data && data.groups) ? data.groups : [];
            const totalGroups = data && typeof data.total_groups === 'number' ? data.total_groups : groups.length;
            let extraClusters = 0;
            let recordsAffected = 0;
            for (const g of groups) {
                extraClusters += Math.max(0, (g.cluster_count || g.clusters?.length || 0) - 1);
                recordsAffected += g.total_records || 0;
            }
            const _safe = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            _safe('cmcStatGroups', _fn(totalGroups));
            _safe('cmcStatExtra',  _fn(extraClusters));
            _safe('cmcStatRecords', _fn(recordsAffected));
            _safe('cmcStatTrunc',  data && data.truncated ? 'Yes' : 'No');
        }

        function _cmcRecommendedMaster(clusters) {
            // Prefer a cluster that has an Account record, then highest
            // record count, then highest confidence_score. Matches what
            // the in-tab banner tells the operator to pick.
            if (!Array.isArray(clusters) || clusters.length === 0) return null;
            return clusters.slice().sort((a, b) => {
                const aHasAcc = (a.has_account || (a.total_accounts || 0) > 0) ? 1 : 0;
                const bHasAcc = (b.has_account || (b.total_accounts || 0) > 0) ? 1 : 0;
                if (aHasAcc !== bHasAcc) return bHasAcc - aHasAcc;
                if ((b.total_records || 0) !== (a.total_records || 0)) return (b.total_records || 0) - (a.total_records || 0);
                return (b.confidence_score || 0) - (a.confidence_score || 0);
            })[0].id;
        }

        function _cmcRenderGroups(data) {
            const host = document.getElementById('cmcGroups');
            if (!host) return;
            const groups = Array.isArray(data && data.groups) ? data.groups : [];
            if (groups.length === 0) {
                host.innerHTML = '<div class="text-center text-sm text-green-700 py-8 bg-green-50 border border-green-200 rounded-lg">✓ No same-domain cluster duplicates found. The radar is clean.</div>';
                return;
            }
            host.innerHTML = groups.map((g, gi) => {
                const masterId = _cmcRecommendedMaster(g.clusters);
                const rows = (g.clusters || []).map(c => {
                    const isMaster = c.id === masterId;
                    const modChips = [];
                    if ((c.total_leads || 0) > 0)    modChips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 me-1">L ' + (c.total_leads||0) + '</span>');
                    if ((c.total_deals || 0) > 0)    modChips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-700 me-1">D ' + (c.total_deals||0) + '</span>');
                    if ((c.total_contacts || 0) > 0) modChips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-700 me-1">C ' + (c.total_contacts||0) + '</span>');
                    if ((c.total_accounts || 0) > 0) modChips.push('<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700 me-1">A ' + (c.total_accounts||0) + '</span>');
                    return ''
                        + '<tr class="' + (isMaster ? 'bg-emerald-50' : '') + '">'
                        +   '<td class="px-3 py-2 text-xs text-center"><input type="radio" name="cmc-master-' + gi + '" value="' + Number(c.id) + '" data-on-change="_cmcOnMasterChange" data-args="[' + gi + ',' + Number(c.id) + ']" ' + (isMaster ? 'checked' : '') + ' aria-label="Set cluster ' + Number(c.id) + ' as master" /></td>'
                        +   '<td class="px-3 py-2 text-xs text-center"><input type="checkbox" data-cmc-source-cb data-group="' + gi + '" data-cluster="' + Number(c.id) + '" ' + (isMaster ? 'disabled' : 'checked') + ' aria-label="Include cluster ' + Number(c.id) + ' as a source to merge" /></td>'
                        +   '<td class="px-3 py-2 text-xs font-mono text-gray-700">#' + Number(c.id) + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-gray-800">' + escapeHtml(c.company_name || '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs">' + (modChips.join('') || '<span class="text-gray-300 text-[10px]">—</span>') + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-end font-medium">' + _fn(c.total_records || 0) + '</td>'
                        +   '<td class="px-3 py-2 text-xs text-end">' + (c.confidence_score != null ? (_fn(c.confidence_score) + '%') : '—') + '</td>'
                        +   '<td class="px-3 py-2 text-xs"><span class="' + (c.status === 'resolved' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700') + ' px-2 py-0.5 rounded text-[10px] font-semibold">' + escapeHtml(c.status) + '</span></td>'
                        +   '<td class="px-3 py-2 text-xs"><button type="button" data-on-click="showClusterDetails" data-args="[' + Number(c.id) + ']" class="text-blue-700 hover:underline">Open →</button></td>'
                        + '</tr>';
                }).join('');
                return ''
                    + '<div class="bg-white rounded-lg shadow border border-gray-200" data-cmc-group="' + gi + '">'
                    +   '<div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b bg-gray-50">'
                    +     '<span class="font-mono text-sm text-gray-900 break-all">' + escapeHtml(g.domain) + '</span>'
                    +     '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700">' + _fn(g.cluster_count) + ' clusters</span>'
                    +     '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-200 text-gray-700">' + _fn(g.total_records) + ' records</span>'
                    +     '<button type="button" data-on-click="mergeClusterGroup" data-args="[' + gi + ']" data-testid="button-cmc-merge-' + gi + '" class="ms-auto px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700">Merge selected → master</button>'
                    +   '</div>'
                    +   '<div class="overflow-x-auto">'
                    +     '<table class="min-w-full divide-y divide-gray-200">'
                    +       '<thead class="bg-gray-50">'
                    +         '<tr>'
                    +           '<th scope="col" class="px-3 py-2 text-xs font-medium text-gray-500 uppercase" title="Pick which cluster to merge the others INTO">Master</th>'
                    +           '<th scope="col" class="px-3 py-2 text-xs font-medium text-gray-500 uppercase" title="Tick the clusters whose records get moved into the master">Merge in?</th>'
                    +           '<th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Cluster</th>'
                    +           '<th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Company</th>'
                    +           '<th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Modules</th>'
                    +           '<th scope="col" class="px-3 py-2 text-end text-xs font-medium text-gray-500 uppercase">Records</th>'
                    +           '<th scope="col" class="px-3 py-2 text-end text-xs font-medium text-gray-500 uppercase">Conf.</th>'
                    +           '<th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">Status</th>'
                    +           '<th scope="col" class="px-3 py-2 text-start text-xs font-medium text-gray-500 uppercase">View</th>'
                    +         '</tr>'
                    +       '</thead>'
                    +       '<tbody class="bg-white divide-y divide-gray-200">' + rows + '</tbody>'
                    +     '</table>'
                    +   '</div>'
                    + '</div>';
            }).join('');
        }

        function _cmcOnMasterChange(groupIdx, clusterId, event) {
            // Re-enable / re-disable the per-row checkboxes so the master
            // is never selected as a source.
            const card = document.querySelector('[data-cmc-group="' + Number(groupIdx) + '"]');
            if (!card) return;
            card.querySelectorAll('[data-cmc-source-cb]').forEach(cb => {
                const cid = Number(cb.getAttribute('data-cluster'));
                if (cid === Number(clusterId)) { cb.checked = false; cb.disabled = true; }
                else { cb.disabled = false; cb.checked = true; }
            });
            // Tint highlight the master row.
            card.querySelectorAll('tbody tr').forEach(tr => tr.classList.remove('bg-emerald-50'));
            const radio = card.querySelector('input[type=radio]:checked');
            if (radio) {
                const row = radio.closest('tr');
                if (row) row.classList.add('bg-emerald-50');
            }
        }

        async function mergeClusterGroup(groupIdx) {
            const card = document.querySelector('[data-cmc-group="' + Number(groupIdx) + '"]');
            if (!card) return;
            const masterEl = card.querySelector('input[type=radio]:checked');
            if (!masterEl) { alert('Pick a master cluster first.'); return; }
            const targetId = Number(masterEl.value);
            const sourceIds = Array.from(card.querySelectorAll('[data-cmc-source-cb]:checked'))
                .map(cb => Number(cb.getAttribute('data-cluster')))
                .filter(n => Number.isFinite(n) && n > 0 && n !== targetId);
            if (sourceIds.length === 0) { alert('Tick at least one source cluster to merge.'); return; }
            const grp = (_cmcData && _cmcData.groups && _cmcData.groups[groupIdx]) || null;
            const dom = grp ? grp.domain : '(unknown domain)';
            if (!confirm(
                'Merge ' + sourceIds.length + ' cluster(s) on domain "' + dom + '" INTO master cluster #' + targetId + '?\n\n' +
                'This reparents every record from the source cluster(s) into the master, snapshots each source first (undo-able from the Logs tab), audit-logs the action, and deletes the now-empty source clusters. No Zoho writes.'
            )) return;
            try {
                let res = await fetch('/api/duplicates/clusters/merge-into', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_cluster_id: targetId, source_cluster_ids: sourceIds, notes: 'Same-domain cluster merge via Cluster Merge tab.' }),
                });
                if (res.status === 401 || res.status === 403) {
                    const adminKey = prompt(WalaPlusI18n.t('dyn.duplicates.prompt_admin_key'));
                    if (!adminKey) return;
                    res = await fetch('/api/duplicates/clusters/merge-into', {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
                        body: JSON.stringify({ target_cluster_id: targetId, source_cluster_ids: sourceIds, notes: 'Same-domain cluster merge via Cluster Merge tab.' }),
                    });
                }
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error((data && data.error) || ('HTTP ' + res.status));
                alert('✓ Merged ' + (data.records_moved || 0) + ' record(s) into cluster #' + targetId + ', deleted ' + (data.source_clusters_deleted || 0) + ' source cluster(s).');
                loadClusterMergeCandidates();
            } catch (e) {
                alert('Merge failed: ' + (e && e.message || e));
            }
        }

        async function loadCsOverlap(verdict) {
            window._csOverlapFilter = verdict || 'all';
            ['all','block','review','warn'].forEach(k => {
                const el = document.getElementById('csOverlapChip-' + k);
                if (!el) return;
                if (k === window._csOverlapFilter) {
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-gray-900 text-white';
                } else {
                    const palette = {
                        all:    'bg-gray-100 text-gray-700 hover:bg-gray-200',
                        block:  'bg-red-100 text-red-700 hover:bg-red-200',
                        review: 'bg-amber-100 text-amber-700 hover:bg-amber-200',
                        warn:   'bg-yellow-100 text-yellow-700 hover:bg-yellow-200',
                    };
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + palette[k];
                }
            });
            const body = document.getElementById('csOverlapTable');
            body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>';

            let url = '/api/duplicates/cs-overlap/clusters?limit=500';
            if (window._csOverlapFilter !== 'all') url += '&verdict=' + encodeURIComponent(window._csOverlapFilter);
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                renderCsOverlap(data);
            } catch (e) {
                body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-red-600">Failed to load: ' + escapeHtml(String(e.message || e)) + '</td></tr>';
            }
        }

        function filterCsOverlap(v) { loadCsOverlap(v); }

        // Sort state — default to ARR desc (matches backend ORDER BY)
        window._csOverlapSort = window._csOverlapSort || { key: 'arr', dir: 'desc' };
        window._csOverlapData = window._csOverlapData || null;

        const CS_OVERLAP_VERDICT_RANK = { block: 3, review: 2, warn: 1 };

        function csOverlapSortValue(r, key) {
            switch (key) {
                case 'verdict':  return CS_OVERLAP_VERDICT_RANK[r.cs_overlap_verdict] || 0;
                case 'domain':   return (r.domain || '').toLowerCase();
                case 'company':  return (r.company_name || r.company_name_arabic || '').toLowerCase();
                case 'sector':   return (r.client_sector || '').toLowerCase();
                case 'phase':    return (r.pipeline_lifecycle_state || '').toLowerCase();
                case 'arr':      return Number(r.arr_exposure || 0);
                case 'records':  return Number(r.total_records || 0);
                case 'updated':  return r.updated_at ? new Date(r.updated_at).getTime() : 0;
                default:         return 0;
            }
        }

        function sortCsOverlapRows(rows, key, dir) {
            const factor = dir === 'asc' ? 1 : -1;
            return rows.slice().sort((a, b) => {
                const va = csOverlapSortValue(a, key);
                const vb = csOverlapSortValue(b, key);
                if (va < vb) return -1 * factor;
                if (va > vb) return  1 * factor;
                return 0;
            });
        }

        function updateCsOverlapSortIndicators() {
            const headers = document.querySelectorAll('#csOverlapTableHead .cs-overlap-sort');
            headers.forEach(h => {
                const key = h.getAttribute('data-sort-key');
                const ind = h.querySelector('.cs-overlap-sort-indicator');
                if (!ind) return;
                if (key === window._csOverlapSort.key) {
                    ind.textContent = window._csOverlapSort.dir === 'asc' ? '↑' : '↓';
                    ind.classList.remove('opacity-30');
                    ind.classList.add('text-gray-900');
                } else {
                    ind.textContent = '⇅';
                    ind.classList.add('opacity-30');
                    ind.classList.remove('text-gray-900');
                }
            });
        }

        function sortCsOverlap(key) {
            const cur = window._csOverlapSort;
            // Toggle direction if clicking the same column; default to a sensible
            // first-click direction otherwise (desc for numeric/date, asc for text).
            if (cur.key === key) {
                cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
            } else {
                cur.key = key;
                cur.dir = ['arr','records','updated','verdict'].includes(key) ? 'desc' : 'asc';
            }
            if (window._csOverlapData) renderCsOverlap(window._csOverlapData);
        }

        function renderCsOverlap(data) {
            window._csOverlapData = data;
            const sum = data.summary || {};
            document.getElementById('csOverlapBlockCount').textContent  = (sum.block  && sum.block.count)  || 0;
            document.getElementById('csOverlapReviewCount').textContent = (sum.review && sum.review.count) || 0;
            document.getElementById('csOverlapWarnCount').textContent   = (sum.warn   && sum.warn.count)   || 0;
            document.getElementById('csOverlapArrExposure').textContent = formatCurrency(data.total_arr_exposure || 0);

            updateCsOverlapSortIndicators();

            const body = document.getElementById('csOverlapTable');
            const allRows = data.clusters || [];
            if (allRows.length === 0) {
                body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">No CS-pipeline overlaps detected. Click <em>Run scan</em> to evaluate.</td></tr>';
                return;
            }
            // Advanced Filter — client-side. CS-Overlap clusters expose
            // domain and updated_at, so we wire those dims; owner/confidence
            // don't apply at the cluster level here.
            const filteredRows = allRows.filter(r => rowMatchesAdvancedFilter(r, {
                domainField: 'domain',
                dateField:   'updated_at',
            }));
            if (filteredRows.length === 0) {
                body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">No CS-Overlap clusters match the active filters. Adjust the chip above or click <em>Clear All Filters</em>.</td></tr>';
                return;
            }
            const rows = sortCsOverlapRows(filteredRows, window._csOverlapSort.key, window._csOverlapSort.dir);
            // Client-side pagination — 20 clusters per page.
            window._csOverlapPage = Number.isFinite(window._csOverlapPage) ? window._csOverlapPage : 0;
            const csOverlapTotalPages = Math.max(1, Math.ceil(rows.length / RADAR_PAGE_SIZE));
            if (window._csOverlapPage >= csOverlapTotalPages) window._csOverlapPage = 0;
            const csOverlapPageStart = window._csOverlapPage * RADAR_PAGE_SIZE;
            const csOverlapSlice = rows.slice(csOverlapPageStart, csOverlapPageStart + RADAR_PAGE_SIZE);
            renderPagination('csOverlapPagination', window._csOverlapPage, csOverlapTotalPages,
                (p) => { window._csOverlapPage = p; renderCsOverlap(window._csOverlapData); },
                rows.length, 'clusters');
            body.innerHTML = csOverlapSlice.map(r => {
                const safeDomain = escapeHtml(r.domain || '');
                const domainCell = r.id
                    ? '<a href="javascript:void(0)" data-on-click="showClusterDetails" data-args="[' + r.id + ']" class="text-blue-700 hover:text-blue-900 hover:underline font-mono text-xs" title="View this cluster\'s underlying records">' + safeDomain + '</a>'
                    : '<span class="text-xs text-gray-700 font-mono">' + safeDomain + '</span>';
                const safeCompany = escapeHtml(r.company_name || r.company_name_arabic || '—');
                // Company name opens the same cluster-detail modal as the
                // domain cell, since each CS Overlap row IS a cluster (not a
                // single Zoho record) — so an external Zoho link would not
                // have a unique target.
                const companyCell = r.id
                    ? '<a href="javascript:void(0)" data-on-click="showClusterDetails" data-args="[' + r.id + ']" class="text-blue-700 hover:text-blue-900 hover:underline text-xs" title="View this cluster\'s underlying records">' + safeCompany + '</a>'
                    : safeCompany;
                return '<tr class="hover:bg-gray-50">'
                    + '<td class="px-4 py-2 whitespace-nowrap">' + csVerdictBadge(r.cs_overlap_verdict) + '</td>'
                    + '<td class="px-4 py-2">' + domainCell + '</td>'
                    + '<td class="px-4 py-2 text-xs text-gray-800">' + companyCell + '</td>'
                    + '<td class="px-4 py-2 text-xs">' + csSectorLabel(r.client_sector) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-gray-700">' + escapeHtml(csPhaseLabel(r.pipeline_lifecycle_state)) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-end font-medium">' + formatCurrency(r.arr_exposure || 0) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-end text-gray-600">' + (r.total_records || 0) + '</td>'
                    + '<td class="px-4 py-2 text-xs text-end text-gray-500">' + formatDate(r.updated_at) + '</td>'
                    + '</tr>';
            }).join('');
        }

        async function rescanCsOverlap() {
            const btn = document.getElementById('csOverlapScanBtn');
            const original = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Scanning…';
            try {
                const res = await fetch('/api/duplicates/cs-overlap/scan', { method: 'POST' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                await loadCsOverlap(window._csOverlapFilter || 'all');
            } catch (e) {
                alert('Scan failed: ' + (e.message || e));
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        // ─── Preflight check (pre-import) ────────────────────────────────────
        function parsePreflightInput(raw) {
            const text = (raw || '').trim();
            if (!text) return [];
            // JSON array form
            if (text.startsWith('[') || text.startsWith('{')) {
                try {
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed)) return parsed;
                    if (parsed && Array.isArray(parsed.rows)) return parsed.rows;
                } catch (e) {
                    throw new Error('Invalid JSON: ' + e.message);
                }
                return [];
            }
            // CSV form: first non-empty line is header
            const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
            if (lines.length === 0) return [];
            const splitCsv = (line) => {
                const out = [];
                let cur = '', inQ = false;
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    if (ch === '"') { inQ = !inQ; continue; }
                    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
                    cur += ch;
                }
                out.push(cur);
                return out.map(s => s.trim());
            };
            const headers = splitCsv(lines[0]).map(h => h.toLowerCase());
            const allowed = ['domain','email','company_name','contact_name','phone','ref','title'];
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const parts = splitCsv(lines[i]);
                const obj = {};
                headers.forEach((h, idx) => {
                    if (allowed.includes(h)) obj[h] = parts[idx] || '';
                });
                if (Object.values(obj).some(v => v && String(v).length > 0)) rows.push(obj);
            }
            return rows;
        }

        function preflightVerdictBadge(v, reason) {
            const map = {
                block:     { bg: 'bg-red-100',     fg: 'text-red-700',    label: 'BLOCK'     },
                review:    { bg: 'bg-amber-100',   fg: 'text-amber-700',  label: 'REVIEW'    },
                warn:      { bg: 'bg-yellow-100',  fg: 'text-yellow-700', label: 'WARN'      },
                duplicate:  { bg: 'bg-gray-200',    fg: 'text-gray-700',   label: 'DUPLICATE' },
                no_contact: { bg: 'bg-rose-100',    fg: 'text-rose-700',   label: 'REJECTED'  },
                pass:       { bg: 'bg-green-100',   fg: 'text-green-700',  label: 'PASS'      },
            };
            const m = map[v] || { bg: 'bg-gray-100', fg: 'text-gray-600', label: (v || '—').toUpperCase() };
            // R9 (quick wins): hover tooltip explains the verdict in plain
            // English so operators don't have to guess what `active_phase:adoption`
            // or `termination_within_cooloff:60d<180d` means.
            const human = reason ? humanizePreflightReason(reason) : '';
            const titleAttr = human ? ' title="' + escAttr(human) + '"' : '';
            const cursor = human ? ' cursor-help' : '';
            return '<span class="px-2 py-1 text-xs font-bold rounded ' + m.bg + ' ' + m.fg + cursor + '"' + titleAttr + '>' + m.label + '</span>';
        }

        // Translate the classifier's machine-style reason codes into plain
        // English. Reasons are produced by classifyCsOverlap / duplicate
        // preflight; keep this map in sync with the codes there.
        function humanizePreflightReason(reason) {
            if (!reason) return '';
            let r = String(reason);
            // Preflight match-path prefix (2026-06-11): the reason may now be
            // "phone_match__<verdict_reason>" or "company_fuzzy_match__<verdict_reason>"
            // when the row matched a cluster via the phone or company-name
            // fallback path instead of the domain match. Surface that lead-in
            // separately, then humanise the inner reason.
            let prefix = '';
            if (r.startsWith('phone_match__')) {
                prefix = 'Matched by PHONE — ';
                r = r.slice('phone_match__'.length);
            } else if (r.startsWith('company_fuzzy_match__')) {
                prefix = 'Matched by COMPANY-NAME fuzzy similarity — ';
                r = r.slice('company_fuzzy_match__'.length);
            }
            // Preflight verdict reasons (top-level) — wrapped so the prefix
            // can chain. The match below shadows the recursion model.
            const inner = (() => {
                // active_cs_customer (BLOCK)
                if (r === 'active_cs_customer') return 'Active CS customer — do not push as new lead.';
                // cs_termination_within_cooloff (REVIEW)
                if (r === 'cs_termination_within_cooloff') return 'Within sector cool-off (180d Private / 365d Government). CS to confirm before re-engagement.';
                // cs_termination_past_cooloff (WARN)
                if (r === 'cs_termination_past_cooloff') return 'Past sector cool-off — Sales may re-engage after notifying CS.';
                // existing_record_no_cs_overlap (DUPLICATE)
                if (r === 'existing_record_no_cs_overlap') return 'Already present in Leads/Deals — no active CS overlap.';
                // no_match (PASS) / no_domain_resolved (PASS)
                if (r === 'no_match') return 'No overlap detected — safe to import.';
                if (r === 'no_domain_resolved') return 'No domain/email/phone/company resolved — treated as PASS.';
                // ── Cluster-level CS overlap classifier reasons (2026-06-11) ──
                if (r === 'overlap_active_handoff' || r === 'overlap_active_cs_phase' || r.startsWith('overlap_active_cs_phase:'))
                    return 'OPEN Sales Deal + Paid/Agreement-Signed handoff Deal coexist on this customer (CS phase is active).';
                if (r.startsWith('overlap_within_cooloff:'))
                    return 'OPEN Sales Deal + handoff Deal coexist — churn date is within the sector cool-off (180d Private / 365d Government). Sales must stop.';
                if (r.startsWith('overlap_past_cooloff:'))
                    return 'OPEN Sales Deal + handoff Deal coexist BUT churn date is past the sector cool-off. Sales may re-engage after notifying CS.';
                if (r === 'overlap_unknown_cs_phase')
                    return 'OPEN Sales Deal + handoff Deal coexist; CS phase is unreadable — conservative BLOCK.';
                if (r === 'no_handoff_deal')
                    return 'No Paid/Agreement-Signed handoff Deal in cluster — not flagged as overlap.';
                if (r === 'no_open_sales_deal')
                    return 'No OPEN Sales Deal in cluster — not flagged as overlap.';
                // ── Legacy per-deal reasons (still emitted by Communication
                // Eligibility check and CS Lifecycle Compliance) ──
                const ap = r.match(/^active_phase:(.+)$/);
                if (ap) return 'Active CS customer (phase: ' + ap[1] + '). Marketing must not push as new lead.';
                if (r === 're_engaged_renewal_after_churn') return 'Re-engaged customer (Renewal Date set after Churn Date). Treat as active.';
                if (r === 'termination_no_churn_date') return 'Terminated but Churn Date missing — CS to confirm before sales can re-engage.';
                const tw = r.match(/^termination_within_cooloff:(\d+)d<(\d+)d$/);
                if (tw) return 'Within sector cool-off (' + tw[1] + ' days since churn, threshold ' + tw[2] + 'd). CS to confirm before re-engagement.';
                const tp = r.match(/^termination_past_cooloff:(\d+)d>=(\d+)d$/);
                if (tp) return 'Past sector cool-off (' + tp[1] + ' days since churn, threshold ' + tp[2] + 'd). Sales may re-engage.';
                if (r === 'no_cs_phase') return 'No CS pipeline overlap.';
                const up = r.match(/^unknown_phase:(.+)$/);
                if (up) return 'Phase "' + up[1] + '" is not configured — verdict held.';
                // Fallback: tidy up the raw code (underscores → spaces, sentence-case).
                return r.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
            })();
            return prefix + inner;
        }

        function loadPreflightSample() {
            const sample = 'domain,company_name\nanb.com.sa,Arab National Bank\nbahri.sa,Bahri\nawqaf.gov.sa,General Authority of Awqaf\nnewco.example.com,Brand New Co\n';
            document.getElementById('preflightInput').value = sample;
            document.getElementById('preflightParsedCount').textContent = '';
        }

        // Excel upload — fires hidden file input. handlePreflightExcelChosen
        // (bound via data-on-change on the input) does the actual upload +
        // textarea fill. Two-step pattern so the operator can review what
        // came out of the workbook before clicking Check.
        function triggerPreflightExcelUpload() {
            const input = document.getElementById('preflightExcelInput');
            if (input) input.click();
        }

        // Stores the operator's full original-row data between upload and
        // export. Keyed by domain so we can reconstruct rows per verdict
        // after the preflight check completes. Indexed-parallel to the
        // engine's response rows (which only see domain/email/phone).
        let preflightLastUpload = null; // { fileName, headers, originalRows: [], sourceRowNumbers: [] }
        // Stores the most recent preflight response so the export step
        // knows which rows are PASS. Cleared by clearPreflight().
        let preflightLastResult = null;

        async function handlePreflightExcelChosen(event) {
            const input = event && event.target ? event.target : document.getElementById('preflightExcelInput');
            const file = input && input.files && input.files[0];
            if (!file) return;

            const countSpan = document.getElementById('preflightParsedCount');
            const uploadBtn = document.getElementById('preflightUploadBtn');
            const originalBtnText = uploadBtn ? uploadBtn.textContent : '';
            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.textContent = '⏳ Parsing…';
            }
            if (countSpan) countSpan.textContent = '';

            try {
                const fd = new FormData();
                fd.append('file', file, file.name || 'upload.xlsx');
                const res = await fetch('/api/duplicates/preflight/parse-excel', {
                    method: 'POST',
                    body: fd,
                    credentials: 'include',
                });
                let body = null;
                try { body = await res.json(); } catch { body = null; }
                if (!res.ok || !body || body.success === false) {
                    const errMsg = (body && (body.error || body.detail)) || ('Upload failed: HTTP ' + res.status);
                    if (body && Array.isArray(body.detected_headers)) {
                        alert(errMsg + '\n\nHeaders found in row ' + (body.header_row || 1) + ':\n  ' + body.detected_headers.join(', '));
                    } else {
                        alert(errMsg);
                    }
                    return;
                }

                // Stash the original-row data for the export step. The
                // engine itself never sees these — we keep them in browser
                // memory so the "Download PASS rows" button can write out
                // a CSV that preserves the operator's full column set.
                preflightLastUpload = {
                    fileName: body.file_name || file.name || 'upload.xlsx',
                    originalRows: Array.isArray(body.original_rows) ? body.original_rows : [],
                    sourceRowNumbers: Array.isArray(body.source_row_numbers) ? body.source_row_numbers : [],
                };

                // Fill the textarea with the server-emitted CSV so the operator
                // can still inspect / edit before clicking Check.
                const ta = document.getElementById('preflightInput');
                if (ta) ta.value = body.csv || '';

                // Surface within-file dedup result. If we found same-domain
                // duplicates inside the upload itself, flag it BEFORE the
                // operator hits Check — saves a Zoho cleanup later.
                const dupInfo = body.intra_file_duplicates || {};
                const dupDomainRows = dupInfo.by_domain_rows || 0;
                let dupNote = '';
                if (dupDomainRows > 0) {
                    dupNote = ' · ⚠ ' + dupDomainRows + ' within-file duplicate row(s) across ' + (dupInfo.by_domain_groups || 0) + ' domain(s)';
                }

                if (countSpan) {
                    const skipped = Number(body.skipped_rows || 0);
                    const skipNote = skipped > 0 ? ' · ⚠ ' + skipped + ' row(s) skipped (unreadable cells)' : '';
                    countSpan.textContent = '✓ Parsed ' + body.count + ' row(s) from "' + preflightLastUpload.fileName + '"' + dupNote + skipNote + ' — click Check to run preflight.';
                    countSpan.className = 'ms-auto text-xs ' + ((dupDomainRows > 0 || skipped > 0) ? 'text-amber-700' : 'text-emerald-700') + ' font-medium';
                }
            } catch (e) {
                alert('Upload failed: ' + ((e && e.message) || String(e)));
            } finally {
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = originalBtnText || '📄 Upload Excel';
                }
                // Reset the input so the same file can be re-uploaded after edits.
                if (input) input.value = '';
            }
        }

        // Download ONLY the flagged rows (Block / Review / Warn / Duplicate)
        // as a native .xlsx for the Head of Sales. 2026-06-17 — switched from
        // a client-built CSV to the server's native-xlsx endpoint: the manual
        // CSV→Excel conversion was shifting cells and dropping the header row.
        // We merge the uploaded file's Contact / Email / Phone columns (keyed
        // by row_index) and let the server emit a proper workbook with the
        // Churn Date column already present — no conversion step, no shifts.
        // Shared native-.xlsx export (Summary + colour-coded Findings sheets,
        // built server-side). mode='flagged' → Block/Review/Warn/Duplicate;
        // mode='pass' → safe-to-import rows, SAME design. SLIM payload: only the
        // subset's rows + the fields the Findings sheet uses + contacts for only
        // those row_indexes (avoids the browser freeze + the 1 MB body cap).
        async function _exportPreflightXlsx(mode) {
            const isPass = mode === 'pass';
            const data = preflightLastResult || window._preflightLastResult;
            if (!data || !Array.isArray(data.rows)) {
                alert('Run the preflight Check first.');
                return;
            }
            const subset = data.rows.filter(r => r && r.verdict && (isPass ? r.verdict === 'pass' : r.verdict !== 'pass'));
            if (subset.length === 0) {
                alert(isPass ? 'No PASS (safe-to-import) rows in the last run.' : 'No flagged rows (Block / Review / Warn / Duplicate) in the last run — nothing to send.');
                return;
            }
            const subsetIdx = new Set(subset.map(r => r.row_index));
            const slimRows = subset.map(r => ({
                row_index: r.row_index,
                verdict: r.verdict,
                executive_severity: r.executive_severity,
                executive_action: r.executive_action,
                suggested_action: r.suggested_action,
                input: { domain: r.input && r.input.domain, company_name: r.input && r.input.company_name },
                owners: r.owners,
                cs_owner: r.cs_owner,
                cs_phase: r.cs_phase,
                module_counts: r.module_counts,
                lifecycle_state: r.lifecycle_state,
                arr_exposure: r.arr_exposure,
                churn_date: r.churn_date,
                churn_days: r.churn_days,
                crm_links: r.crm_links,
                reason: r.reason,
                matched_via: r.matched_via,
            }));
            const slimResult = {
                generated_at: data.generated_at,
                total_rows: data.total_rows,
                examined: data.examined,
                skipped: data.skipped,
                summary: data.summary,
                total_arr_exposure_blocked: data.total_arr_exposure_blocked,
                pct_actionable: data.pct_actionable,
                top_reasons: data.top_reasons,
                rows: slimRows,
            };
            // Contacts only for the subset's rows (keyed by row_index).
            const contacts = {};
            if (preflightLastUpload && Array.isArray(preflightLastUpload.originalRows)) {
                const pick = (obj, keys) => {
                    for (const k of keys) {
                        for (const ok of Object.keys(obj || {})) {
                            if (ok.toLowerCase().replace(/[^a-z]/g, '') === k) return obj[ok];
                        }
                    }
                    return '';
                };
                preflightLastUpload.originalRows.forEach((o, idx) => {
                    if (!subsetIdx.has(idx)) return;
                    o = o || {};
                    const name = pick(o, ['fullname','name','contactname'])
                        || [pick(o, ['firstname']), pick(o, ['lastname'])].filter(Boolean).join(' ').trim();
                    contacts[idx] = {
                        name: name,
                        email: pick(o, ['email','emailaddress']),
                        phone: pick(o, ['phone','mobile','mobilephone','phonenumber']),
                    };
                });
            }
            // FULL original columns for the export — every column from the
            // uploaded file, keyed by row_index, so the operator gets their
            // complete record back (First Name, Title, Industry, … all of it),
            // not just Company/Contact/Email/Phone. original_headers preserves
            // the column order; originals carries the per-row values.
            const originals = {};
            const originalHeaders = [];
            if (preflightLastUpload && Array.isArray(preflightLastUpload.originalRows)) {
                const seenHdr = new Set();
                preflightLastUpload.originalRows.forEach((o, idx) => {
                    if (!subsetIdx.has(idx)) return;
                    o = o || {};
                    originals[idx] = o;
                    Object.keys(o).forEach(k => { if (k && !seenHdr.has(k)) { seenHdr.add(k); originalHeaders.push(k); } });
                });
            }
            const btn = document.getElementById(isPass ? 'preflightExportPassXlsxBtn' : 'preflightExportFlaggedBtn');
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = 'Building…'; }
            try {
                const body = { result: slimResult, contacts: contacts, originals: originals, original_headers: originalHeaders };
                if (isPass) body.passOnly = true; else body.flaggedOnly = true;
                const res = await fetch('/api/duplicates/preflight/export-xlsx', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    const e = await res.json().catch(() => ({}));
                    throw new Error(e.error || ('HTTP ' + res.status));
                }
                const blob = await res.blob();
                const baseName = (preflightLastUpload && preflightLastUpload.fileName ? preflightLastUpload.fileName : 'preflight').replace(/\.[^.]+$/, '');
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = baseName + (isPass ? '__PASS__' : '__FLAGGED__') + subset.length + '.xlsx';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
            } catch (e) {
                alert((isPass ? 'PASS' : 'Flagged') + ' export failed: ' + (e.message || e));
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }
        async function downloadPreflightFlaggedRows() { return _exportPreflightXlsx('flagged'); }
        async function downloadPreflightPassRowsXlsx() { return _exportPreflightXlsx('pass'); }

        function clearPreflight() {
            document.getElementById('preflightInput').value = '';
            document.getElementById('preflightParsedCount').textContent = '';
            const body = document.getElementById('preflightResultTable');
            body.innerHTML = '<tr><td colspan="10" class="px-4 py-8 text-center text-sm text-gray-500">Paste a list and click <em>Check</em>.</td></tr>';
            ['Block','Review','Warn','Dup','NoContact','Pass'].forEach(k => {
                const el = document.getElementById('preflightSum' + k);
                if (el) el.textContent = '—';
            });
            // Reset both upload + result so the export button hides and a
            // subsequent paste-only run doesn't try to export stale data.
            preflightLastUpload = null;
            preflightLastResult = null;
            const flaggedBtn = document.getElementById('preflightExportFlaggedBtn');
            if (flaggedBtn) flaggedBtn.classList.add('hidden');
            const passXlsxBtn = document.getElementById('preflightExportPassXlsxBtn');
            if (passXlsxBtn) passXlsxBtn.classList.add('hidden');
        }

        // Replit's gateway returns HTTP 504 if a single request runs past
        // its ~60s ceiling — sending all 1,668 rows at once hit that wall
        // no matter how fast the backend got. Solution: split into 250-row
        // chunks (≈10-row groups × 25 = well under the per-request budget),
        // run 4 chunks concurrently to keep wall-clock low, merge results
        // client-side. The same engine runs server-side per chunk — only
        // the framing changes. Progress is shown on the Check button.
        const PREFLIGHT_CHUNK_SIZE = 250;
        const PREFLIGHT_CHUNK_CONCURRENCY = 4;

        async function _preflightOneChunk(chunkRows, refreshOverlap) {
            const res = await fetch('/api/duplicates/preflight', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    rows: chunkRows,
                    refresh_overlap: !!refreshOverlap,
                }),
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error('HTTP ' + res.status + ': ' + (txt || '').slice(0, 200));
            }
            return res.json();
        }

        // Merge N chunk responses back into the shape renderPreflight expects.
        // Row indices are RE-NUMBERED to be globally unique across chunks so
        // the export / push-to-Zoho flows that key off row_index don't
        // collide. top_reasons + pct_actionable are recomputed because they
        // are derived from the merged totals, not summable.
        function _preflightMergeChunks(parts, totalRows) {
            const summary = { block: 0, review: 0, warn: 0, duplicate: 0, no_contact: 0, pass: 0 };
            const rowsOut = [];
            let examined = 0;
            let skipped = 0;
            let arrBlocked = 0;
            const reasonCounts = new Map();
            for (const part of parts) {
                if (!part) continue;
                if (part.summary) {
                    summary.block    += part.summary.block    || 0;
                    summary.review   += part.summary.review   || 0;
                    summary.warn     += part.summary.warn     || 0;
                    summary.duplicate += part.summary.duplicate || 0;
                    summary.no_contact += part.summary.no_contact || 0;
                    summary.pass     += part.summary.pass     || 0;
                }
                examined += part.examined || 0;
                skipped  += part.skipped  || 0;
                arrBlocked += Number(part.total_arr_exposure_blocked || 0);
                if (Array.isArray(part.rows)) {
                    for (const r of part.rows) rowsOut.push(r);
                }
                if (Array.isArray(part.top_reasons)) {
                    for (const tr of part.top_reasons) {
                        const key = tr.label || '';
                        reasonCounts.set(key, (reasonCounts.get(key) || 0) + (tr.count || 0));
                    }
                }
            }
            // CROSS-CHUNK propagation. Chunks are screened in independent
            // requests, so the SAME company can be BLOCKED in one chunk (a
            // work-email contact, caught by domain) and PASS in another (a
            // personal/blank-email contact, only a name). The backend applies
            // this rule WITHIN a chunk; here we apply it ACROSS chunks after the
            // merge. Match is the EXACT (lower/trim/collapsed) company string in
            // the SAME upload — a strong, safe signal even for short acronyms
            // (e.g. "SRC"), so the >=4 directory floor doesn't apply.
            const _pfNormCo = (s) => (s == null ? '' : String(s)).trim().toLowerCase().replace(/\s+/g, ' ');
            const _pfClientByCo = new Map();
            for (const r of rowsOut) {
                if (r.verdict !== 'block' && r.verdict !== 'review') continue;
                const co = _pfNormCo(r.input && r.input.company_name);
                if (co.length < 3) continue;
                const prev = _pfClientByCo.get(co);
                if (!prev || (r.verdict === 'block' && prev.verdict !== 'block')) _pfClientByCo.set(co, r);
            }
            if (_pfClientByCo.size > 0) {
                for (const r of rowsOut) {
                    if (r.verdict !== 'pass') continue;
                    const co = _pfNormCo(r.input && r.input.company_name);
                    if (co.length < 3) continue;
                    const t = _pfClientByCo.get(co);
                    if (!t) continue;
                    summary.pass--;
                    summary[t.verdict] = (summary[t.verdict] || 0) + 1;
                    r.verdict = t.verdict;
                    r.reason = (t.reason || '') + '_same_company_in_upload';
                    r.suggested_action = (t.suggested_action || '') + ' (Another contact for this company in the same upload is an existing client.)';
                    r.executive_action = t.executive_action;
                    r.executive_severity = t.executive_severity;
                    r.matched_via = 'company_name';
                    r.sector = t.sector;
                    r.cs_owner = t.cs_owner;
                    r.owners = Array.isArray(t.owners) ? t.owners.slice() : r.owners;
                    r.churn_date = t.churn_date;
                    r.churn_days = t.churn_days;
                    r.cs_phase = t.cs_phase;
                    r.lifecycle_state = t.lifecycle_state;
                    const lbl = t.verdict === 'block'
                        ? 'Existing active client — do not cold-contact, route to owner'
                        : 'Recently churned client — CS sign-off before re-engaging';
                    reasonCounts.set(lbl, (reasonCounts.get(lbl) || 0) + 1);
                }
            }

            // Re-index globally so downstream consumers (push-to-Zoho,
            // Excel export) can address rows uniquely.
            for (let i = 0; i < rowsOut.length; i++) rowsOut[i].row_index = i;
            const totalActionable = summary.block + summary.review + summary.warn + summary.duplicate + (summary.no_contact || 0);
            // Match backend precision (.1 decimal, e.g. 78.5%) so chunked
            // and non-chunked runs produce visually identical numbers.
            const pctActionable = examined > 0
                ? Math.round((totalActionable / examined) * 1000) / 10
                : 0;
            const topReasons = [];
            for (const [label, count] of reasonCounts) {
                topReasons.push({
                    label,
                    count,
                    pct: examined > 0 ? Math.round((count / examined) * 1000) / 10 : 0,
                });
            }
            topReasons.sort((a, b) => b.count - a.count);
            return {
                total_rows: totalRows,
                examined,
                skipped,
                summary,
                total_arr_exposure_blocked: arrBlocked,
                rows: rowsOut,
                top_reasons: topReasons.slice(0, 10),
                generated_at: new Date().toISOString(),
                pct_actionable: pctActionable,
            };
        }

        async function runPreflight() {
            const btn = document.getElementById('preflightRunBtn');
            const original = btn.textContent;
            const raw = document.getElementById('preflightInput').value;

            let rows;
            try {
                rows = parsePreflightInput(raw);
            } catch (e) {
                alert('Could not parse input: ' + e.message);
                return;
            }
            if (rows.length === 0) {
                alert('No rows to check. Paste a CSV with a domain column or a JSON array.');
                return;
            }
            document.getElementById('preflightParsedCount').textContent = rows.length + ' row(s) parsed';

            btn.disabled = true;
            btn.textContent = 'Checking…';
            try {
                const refreshOverlap = !!(document.getElementById('preflightRefreshOverlap') || {}).checked;
                // Split into chunks. Even with one row we go through this
                // path so the merge code is the single source of truth.
                const chunks = [];
                for (let i = 0; i < rows.length; i += PREFLIGHT_CHUNK_SIZE) {
                    chunks.push(rows.slice(i, i + PREFLIGHT_CHUNK_SIZE));
                }
                const total = chunks.length;
                const results = new Array(total);
                let completed = 0;
                let firstError = null;

                const updateProgress = () => {
                    if (firstError) return;
                    const done = Math.min(completed * PREFLIGHT_CHUNK_SIZE, rows.length);
                    btn.textContent = 'Checking ' + done.toLocaleString() + '/' + rows.length.toLocaleString() + '…';
                };
                updateProgress();

                // Bounded-concurrency worker pool. Up to N in-flight
                // requests at once; the next index is pulled off `cursor`
                // when a worker finishes.
                let cursor = 0;
                const workerCount = Math.min(PREFLIGHT_CHUNK_CONCURRENCY, total);
                const worker = async () => {
                    while (!firstError) {
                        const myIdx = cursor++;
                        if (myIdx >= total) return;
                        try {
                            const data = await _preflightOneChunk(chunks[myIdx], refreshOverlap);
                            results[myIdx] = data;
                        } catch (e) {
                            if (!firstError) firstError = e;
                            return;
                        }
                        completed++;
                        updateProgress();
                    }
                };
                const workers = [];
                for (let i = 0; i < workerCount; i++) workers.push(worker());
                await Promise.all(workers);
                if (firstError) throw firstError;

                const data = _preflightMergeChunks(results, rows.length);
                preflightLastResult = data; // stash for "Download PASS rows"
                renderPreflight(data);
                // Flagged-rows button — show whenever the run produced any
                // Block/Review/Warn/Duplicate row (works for typed-in runs
                // too; contact columns are just blank without an upload).
                const flaggedBtn = document.getElementById('preflightExportFlaggedBtn');
                if (flaggedBtn) {
                    const s = (data && data.summary) || {};
                    // Match the flagged FILE exactly = every non-pass row, incl.
                    // no_contact (REJECTED: no email & no phone). Without no_contact
                    // the button under-counted (file said 761, button said 758).
                    const flaggedCount = (s.block || 0) + (s.review || 0) + (s.warn || 0) + (s.duplicate || 0) + (s.no_contact || 0);
                    if (flaggedCount > 0) {
                        flaggedBtn.classList.remove('hidden');
                        flaggedBtn.textContent = '⚑ Download ' + flaggedCount.toLocaleString() + ' Rejected Data';
                    } else {
                        flaggedBtn.classList.add('hidden');
                    }
                }
                // PASS Excel report button — same design as the flagged export,
                // for the safe-to-import rows. Shown whenever there are PASS rows.
                const passXlsxBtn = document.getElementById('preflightExportPassXlsxBtn');
                if (passXlsxBtn) {
                    const passCount = (data && data.summary && typeof data.summary.pass === 'number')
                        ? data.summary.pass : 0;
                    if (passCount > 0) {
                        passXlsxBtn.classList.remove('hidden');
                        passXlsxBtn.textContent = '📊 Download ' + passCount.toLocaleString() + ' PASS Data';
                    } else {
                        passXlsxBtn.classList.add('hidden');
                    }
                }
            } catch (e) {
                alert('Preflight failed: ' + (e.message || e));
            } finally {
                btn.disabled = false;
                btn.textContent = original;
            }
        }

        // ─── Deals Lifecycle (Sales SOP stage aging) ────────────────────────
        window._dealLifecycleSeverityFilter = 'all';
        window._dealLifecycleStageFilter = '';
        window._dealLifecycleData = null;

        // Sort state — mirrors sortCsOverlap / sortCsLifecycle. Sorts the
        // FILTERED set (post rowMatchesAdvancedFilter) so sort + filter compose.
        window._dealLifecycleSort = window._dealLifecycleSort || { key: null, dir: 'desc' };

        const DEAL_LIFECYCLE_SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

        function dealLifecycleSortValue(r, key) {
            const v = r.violation || {};
            switch (key) {
                case 'severity': return DEAL_LIFECYCLE_SEVERITY_RANK[v.severity] || 0;
                case 'deal':     return (r.deal_name || r.account_name || '').toLowerCase();
                case 'account':  return (r.account_name || '').toLowerCase();
                case 'stage':    return (r.stage || '').toLowerCase();
                case 'owner':    return (r.owner_name || '').toLowerCase();
                case 'aging':    return v.aging_calendar_days == null ? -1 : Number(v.aging_calendar_days);
                default:         return 0;
            }
        }

        function sortDealLifecycleRows(rows, key, dir) {
            const factor = dir === 'asc' ? 1 : -1;
            return rows.slice().sort((a, b) => {
                const va = dealLifecycleSortValue(a, key);
                const vb = dealLifecycleSortValue(b, key);
                if (va < vb) return -1 * factor;
                if (va > vb) return  1 * factor;
                return 0;
            });
        }

        function updateDealLifecycleSortIndicators() {
            const headers = document.querySelectorAll('#dealLifecycleTableHead .deal-lifecycle-sort');
            headers.forEach(h => {
                const key = h.getAttribute('data-sort-key');
                const ind = h.querySelector('.deal-lifecycle-sort-indicator');
                if (!ind) return;
                if (key === window._dealLifecycleSort.key) {
                    ind.textContent = window._dealLifecycleSort.dir === 'asc' ? '↑' : '↓';
                    ind.classList.remove('opacity-30');
                    ind.classList.add('text-gray-900');
                } else {
                    ind.textContent = '⇅';
                    ind.classList.add('opacity-30');
                    ind.classList.remove('text-gray-900');
                }
            });
        }

        function sortDealLifecycleBy(key) {
            const cur = window._dealLifecycleSort;
            if (cur.key === key) {
                cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
            } else {
                cur.key = key;
                cur.dir = ['severity','aging'].includes(key) ? 'desc' : 'asc';
            }
            if (window._dealLifecycleData) renderDealLifecycle(window._dealLifecycleData);
        }

        function dealLifeSeverityBadge(s) {
            const map = {
                critical: 'bg-red-100 text-red-800 border-red-200',
                warning:  'bg-amber-100 text-amber-800 border-amber-200',
                info:     'bg-blue-100 text-blue-800 border-blue-200',
            };
            const cls = map[s] || 'bg-gray-100 text-gray-800 border-gray-200';
            return '<span class="inline-block px-2 py-0.5 text-[10px] font-bold rounded-full border ' + cls + '">' + (s || '—').toUpperCase() + '</span>';
        }

        async function loadDealLifecycle() {
            const body = document.getElementById('dealLifecycleTable');
            if (body) body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>';
            try {
                const sevQ = window._dealLifecycleSeverityFilter !== 'all'
                    ? ('&severity=' + encodeURIComponent(window._dealLifecycleSeverityFilter))
                    : '';
                const stageQ = window._dealLifecycleStageFilter
                    ? ('&stage=' + encodeURIComponent(window._dealLifecycleStageFilter))
                    : '';
                const res = await fetch('/api/duplicates/deal-stage-aging?limit=10000' + sevQ + stageQ);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                window._dealLifecycleData = data;
                renderDealLifecycle(data);
            } catch (e) {
                console.error('Deal Lifecycle load failed:', e);
                if (body) body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-red-600">Failed to load: ' + (e.message || e) + '</td></tr>';
            }
        }

        function renderDealLifecycle(data) {
            const summary = (data && data.summary) || {};
            const sev = summary.by_severity || {};
            const totalViolations = (sev.critical || 0) + (sev.warning || 0);
            const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v ?? 0).toLocaleString(); };
            setText('dealLifeSumCritical', sev.critical || 0);
            setText('dealLifeSumWarning', sev.warning || 0);
            setText('dealLifeSumDeals', summary.total_tracked_deals || 0);
            setText('dealLifeSumTotal', totalViolations);

            // SOP spec card — render only once per data load to avoid flicker
            const specHost = document.getElementById('dealLifeSpecRows');
            if (specHost && Array.isArray(data.spec)) {
                specHost.innerHTML = data.spec.map(s => {
                    const unitLabel = s.unit === 'business_days' ? 'BD' : 'days';
                    const range = (s.warnDays != null && s.critDays != null)
                        ? (s.warnDays + '–' + s.critDays + ' calendar days')
                        : ('≤ ' + s.sla + ' ' + unitLabel);
                    return '<div class="bg-gray-50 border border-gray-200 rounded p-2"><div class="font-semibold text-gray-800">' + escapeHtml(s.stage) + '</div><div class="text-gray-600">' + escapeHtml(range) + '</div><div class="text-[10px] text-gray-500 mt-1">Sales SOP §' + escapeHtml(s.clauseRef) + '</div></div>';
                }).join('');
            }

            // Populate the stage filter dropdown — show ALL stages from
            // the Sales SOP spec so the operator can filter to a stage
            // that currently has zero violations (the next sync might
            // surface some). Falls back to violation-derived stages if
            // the spec isn't on the response yet.
            const stageSelect = document.getElementById('dealLifeStageFilter');
            if (stageSelect) {
                const specStages = Array.isArray(data.spec) ? data.spec.map(s => s.stage).filter(Boolean) : [];
                const violationStages = (data.violations || []).map(v => v.stage).filter(Boolean);
                const stages = Array.from(new Set([...specStages, ...violationStages])).sort();
                const cur = window._dealLifecycleStageFilter || '';
                stageSelect.innerHTML = '<option value="">All stages</option>' + stages.map(s => '<option value="' + escapeHtml(s) + '"' + (s === cur ? ' selected' : '') + '>' + escapeHtml(s) + '</option>').join('');
            }

            updateDealLifecycleSortIndicators();

            const body = document.getElementById('dealLifecycleTable');
            if (!body) return;
            const allRows = data.violations || [];
            if (allRows.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">No stage-aging violations 🎉</td></tr>';
                return;
            }

            // Advanced Filter — applied client-side here exactly like CS
            // Lifecycle's renderCsLifecycle (rowMatchesAdvancedFilter), since
            // /api/duplicates/deal-stage-aging doesn't accept owner/layout/
            // pipeline/stage/domain params. Each violation row already
            // carries layout / pipeline / stage / owner_name at the top
            // level (see scanDealStageAgingViolations), so the mapping
            // mirrors CS Lifecycle's deal-row mapping field-for-field.
            const rows = allRows.filter(r => rowMatchesAdvancedFilter(r, {
                ownerField:    'owner_name',
                layoutField:   'layout',
                pipelineField: 'pipeline',
                stageField:    'stage',
            }));
            if (rows.length === 0) {
                body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-gray-500">No deals match the active filters. Adjust Advanced Filters or click <em>Clear All Filters</em>.</td></tr>';
                return;
            }
            // Full-array sort — sort the FILTERED set (post advanced-filter)
            // so sort + filter compose, exactly like CS Lifecycle. No key
            // selected yet = keep the API's default order.
            const sortedRows = window._dealLifecycleSort.key
                ? sortDealLifecycleRows(rows, window._dealLifecycleSort.key, window._dealLifecycleSort.dir)
                : rows;
            body.innerHTML = sortedRows.map(r => {
                const v = r.violation || {};
                const unitLabel = v.unit === 'business_days' ? 'BD' : 'days';
                const slaLabel = v.unit === 'business_days'
                    ? (v.sla_units + ' BD')
                    : (v.sla_units + ' days');
                const dealCell = (r.deal_name ? '<div class="font-medium text-gray-900">' + escapeHtml(r.deal_name) + '</div>' : '')
                    + (r.account_name ? '<div class="text-xs text-gray-500">' + escapeHtml(r.account_name) + '</div>' : '');
                const ownerCell = (r.owner_name ? '<div>' + escapeHtml(r.owner_name) + '</div>' : '<span class="text-gray-400">—</span>')
                    + (r.owner_email ? '<div class="text-[10px] text-gray-500 font-mono">' + escapeHtml(r.owner_email) + '</div>' : '');
                const stageCell = '<div class="font-medium text-gray-800">' + escapeHtml(r.stage) + '</div>'
                    + (r.pipeline ? '<div class="text-[10px] text-gray-500">' + escapeHtml(r.pipeline) + '</div>' : '');
                return '<tr class="hover:bg-orange-50">'
                    + '<td class="px-2 py-2 align-top">' + dealLifeSeverityBadge(v.severity) + '</td>'
                    + '<td class="px-2 py-2 align-top">' + dealCell + '</td>'
                    + '<td class="px-2 py-2 align-top">' + stageCell + '</td>'
                    + '<td class="px-2 py-2 align-top text-xs text-gray-700">' + ownerCell + '</td>'
                    + '<td class="px-2 py-2 align-top text-end font-semibold ' + (v.severity === 'critical' ? 'text-red-700' : v.severity === 'warning' ? 'text-amber-700' : 'text-gray-700') + '">' + (v.aging_units ?? '—') + ' ' + unitLabel + '<div class="text-[10px] font-normal text-gray-500">' + (v.aging_calendar_days ?? '—') + ' calendar d</div></td>'
                    + '<td class="px-2 py-2 align-top text-xs"><div class="font-mono text-gray-800">≤ ' + escapeHtml(slaLabel) + '</div><div class="text-[10px] text-gray-500">Sales SOP §' + escapeHtml(v.clause_ref) + '</div></td>'
                    + '<td class="px-2 py-2 align-top text-xs text-gray-700">' + escapeHtml(v.suggested_action || v.message || '') + '</td>'
                    + '</tr>';
            }).join('');
        }

        function filterDealLifecycle(severity) {
            window._dealLifecycleSeverityFilter = severity || 'all';
            // Repaint chip highlight — All / Critical / Warning / Info
            // (Info matches CS Lifecycle's chip set; for Deals Lifecycle
            // it currently picks up only within-SLA stages that the
            // scanner emits as info-severity context rows.)
            ['all','critical','warning','info'].forEach(k => {
                const el = document.getElementById('dealLifeChip-' + k);
                if (!el) return;
                if (k === window._dealLifecycleSeverityFilter) {
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + (k === 'critical' ? 'bg-red-600 text-white' : k === 'warning' ? 'bg-amber-500 text-white' : k === 'info' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-white');
                } else {
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + (k === 'critical' ? 'bg-red-100 text-red-700 hover:bg-red-200' : k === 'warning' ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : k === 'info' ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' : 'bg-gray-200 text-gray-700 hover:bg-gray-300');
                }
            });
            loadDealLifecycle();
        }

        async function refreshDealLifecycleFromZoho(opts) {
            // Pulls a live copy of every Deal currently visible in the
            // Deals Lifecycle table from Zoho, re-upserts so the next scan
            // reflects the latest Stage / Modified_Time. Mirrors the
            // existing refreshCsLifecycleFromZoho. The underlying endpoint
            // (/api/duplicates/cs-lifecycle/refresh-deals) is module-
            // agnostic — it refreshes any Deal zoho_record_id passed in.
            const data = window._dealLifecycleData || {};
            const ids = Array.from(new Set((data.violations || [])
                .map(v => v.zoho_record_id)
                .filter(Boolean))).slice(0, 50); // endpoint caps at 50
            if (ids.length === 0) {
                if (!opts || !opts.silent) alert('No deals on screen to refresh.');
                return;
            }
            const btn = document.getElementById('dealLifeZohoRefreshBtn');
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '🔄 Refreshing from Zoho…'; }
            try {
                const res = await fetch('/api/duplicates/cs-lifecycle/refresh-deals', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ zohoIds: ids }),
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                // Recompute the scan over the just-refreshed records.
                await loadDealLifecycle();
            } catch (e) {
                try { console.error('Deals Lifecycle live refresh failed:', e); } catch (_) {}
                if (!opts || !opts.silent) alert('Refresh from Zoho failed: ' + (e.message || e));
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        function onDealLifecycleStageChange() {
            // Read the value straight off the <select> by id — the page's
            // safe-actions delegation does NOT pass the DOM event unless
            // data-pass-event is set, so reading from an `ev` argument was
            // always undefined and the filter silently reset to "All stages"
            // on every change. Same convention as onCsLifecyclePhaseChange.
            const sel = document.getElementById('dealLifeStageFilter');
            const v = sel ? sel.value : '';
            window._dealLifecycleStageFilter = v || '';
            loadDealLifecycle();
        }

        function exportDealLifecycle() {
            const data = window._dealLifecycleData;
            if (!data || !Array.isArray(data.violations) || data.violations.length === 0) {
                alert('Nothing to export — run a scan first or clear filters.');
                return;
            }
            const headers = ['Severity','Stage','Deal','Account','Owner','Owner email','Aging units','Aging unit','Aging calendar days','SLA units','SOP clause','Modified date','Suggested action'];
            const rows = data.violations.map(r => {
                const v = r.violation || {};
                return [
                    v.severity || '',
                    r.stage || '',
                    r.deal_name || '',
                    r.account_name || '',
                    r.owner_name || '',
                    r.owner_email || '',
                    v.aging_units ?? '',
                    v.unit || '',
                    v.aging_calendar_days ?? '',
                    v.sla_units ?? '',
                    v.clause_ref || '',
                    r.modified_date || '',
                    (v.suggested_action || v.message || '').replace(/\n/g, ' '),
                ];
            });
            const csv = [headers, ...rows].map(r => r.map(cell => {
                const s = String(cell ?? '');
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(',')).join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'deal-lifecycle-violations.csv';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }

        // ─── CS lifecycle compliance ────────────────────────────────────────
        window._csLifecycleFilter = 'all';

        function csLifeSeverityBadge(s) {
            const map = {
                critical: { bg: 'bg-red-100',    fg: 'text-red-700',    label: 'CRITICAL' },
                warning:  { bg: 'bg-amber-100',  fg: 'text-amber-700',  label: 'WARNING'  },
                info:     { bg: 'bg-blue-100',   fg: 'text-blue-700',   label: 'INFO'     },
            };
            const m = map[s] || { bg: 'bg-gray-100', fg: 'text-gray-600', label: (s || '—').toUpperCase() };
            return '<span class="px-2 py-1 text-xs font-bold rounded ' + m.bg + ' ' + m.fg + '">' + m.label + '</span>';
        }

        function csLifeViolationLabel(code) {
            const map = {
                onboarding_overdue:               'Onboarding overdue',
                phase_churn_desync:               'Phase ↔ Churn desync',
                termination_missing_churn_date:   'Termination missing Churn Date',
                termination_missing_churn_reason: 'Termination missing Churn Reason',
                phase_transition_stalled:         'Phase transition stalled',
                adoption_premature:               'Adoption premature',
                missing_company_domain:           'Missing Company_Domain',
                // CS data-quality completeness pack (2026-05-30).
                missing_cs_owner:                 'Missing CS Owner',
                missing_customer_since:           'Missing Customer Since',
                missing_renewal_date:             'Missing Renewal Date',
                missing_health_score:             'Missing Health score',
                missing_arr_value:                'Missing ARR value',
                renewal_overdue:                  'Renewal overdue',
            };
            return map[code] || code || '—';
        }

        // Severity-pill helper used inside grouped violation rows. Smaller
        // than csLifeSeverityBadge — pills sit next to each other in the
        // violation column, so they need to be compact.
        function csLifeSeverityPill(severity) {
            const m = severity === 'critical'
                ? { bg: 'bg-red-100',   fg: 'text-red-800' }
                : severity === 'warning'
                ? { bg: 'bg-amber-100', fg: 'text-amber-800' }
                : { bg: 'bg-blue-100',  fg: 'text-blue-800' };
            return m.bg + ' ' + m.fg;
        }

        function filterCsLifecycle(sev) { loadCsLifecycle(sev); }

        // Pulls a live copy of every Deal currently visible in the CS Lifecycle
        // table directly from Zoho's single-record API (which bypasses the
        // bulk-read cache that occasionally serves stale Phase / Company_Domain
        // values), upserts each into duplicate_records, then reloads the table.
        async function refreshCsLifecycleFromZoho(opts) {
            const silent = !!(opts && opts.silent);
            const btn = document.getElementById('csLifeZohoRefreshBtn');
            const data = window._csLifecycleData || {};
            const violations = data.violations || [];
            const ids = Array.from(new Set(violations.map(v => v.zoho_record_id).filter(Boolean)));
            if (ids.length === 0) {
                // When chained from the global Refresh button there's nothing
                // to do and no need to interrupt the user with an alert.
                if (!silent) alert('No violations to refresh.');
                return { refreshed: 0, failed: 0, missing: 0, skipped: true };
            }
            const orig = btn ? btn.innerHTML : null;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = 'Refreshing ' + ids.length + ' deal' + (ids.length === 1 ? '' : 's') + '…';
            }
            try {
                // Batch in chunks of 50 (server cap) so the UI stays usable
                // even when the table has more than 50 violations visible.
                const CHUNK = 50;
                let totalRefreshed = 0, totalFailed = 0, totalMissing = 0;
                for (let i = 0; i < ids.length; i += CHUNK) {
                    const slice = ids.slice(i, i + CHUNK);
                    const res = await fetch('/api/duplicates/cs-lifecycle/refresh-deals', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ zohoIds: slice }),
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error || ('HTTP ' + res.status));
                    }
                    const json = await res.json();
                    totalRefreshed += json.refreshed_count || 0;
                    totalFailed += json.failed_count || 0;
                    totalMissing += json.missing_count || 0;
                }
                const notes = [];
                if (totalFailed) notes.push(totalFailed + ' failed');
                if (totalMissing) notes.push(totalMissing + ' not found in Zoho');
                if (btn) {
                    btn.innerHTML = '✓ Refreshed ' + totalRefreshed + (notes.length ? ' (' + notes.join(', ') + ')' : '');
                }
                await loadCsLifecycle(window._csLifecycleFilter || 'all');
                if (btn) setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                return { refreshed: totalRefreshed, failed: totalFailed, missing: totalMissing, skipped: false };
            } catch (e) {
                if (btn) {
                    btn.innerHTML = '✗ Failed';
                    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
                }
                // Only show the alert when the user explicitly clicked the
                // green button — when chained from the global Refresh the
                // error is logged and the table just keeps the prior data.
                if (!silent) {
                    alert('Refresh from Zoho failed: ' + (e.message || e));
                } else {
                    try { console.error('CS Lifecycle live refresh failed:', e); } catch (_) {}
                }
                return { refreshed: 0, failed: 0, missing: 0, error: String(e && e.message || e) };
            }
        }

        async function loadCsLifecycle(severity) {
            window._csLifecycleFilter = severity || 'all';
            ['all','critical','warning','info'].forEach(k => {
                const el = document.getElementById('csLifeChip-' + k);
                if (!el) return;
                if (k === window._csLifecycleFilter) {
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full bg-gray-900 text-white';
                } else {
                    const palette = {
                        all:      'bg-gray-100 text-gray-700 hover:bg-gray-200',
                        critical: 'bg-red-100 text-red-700 hover:bg-red-200',
                        warning:  'bg-amber-100 text-amber-700 hover:bg-amber-200',
                        info:     'bg-blue-100 text-blue-700 hover:bg-blue-200',
                    };
                    el.className = 'px-3 py-1.5 text-xs font-medium rounded-full ' + palette[k];
                }
            });
            const body = document.getElementById('csLifecycleTable');
            body.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-sm text-gray-500">Loading…</td></tr>';

            // Ask for the full deal corpus. The bulk Zoho sync caps each
            // module at 5,000 records so 10,000 comfortably covers every
            // Deal currently in duplicate_records. The previous default
            // (server-side 2,000) silently undercounted "CS Deals Scanned"
            // whenever the org had more than 2k synced deals — the KPI
            // showed only the most recently-modified slice instead of the
            // true CS-deal population.
            let url = '/api/duplicates/cs-lifecycle/violations?limit=10000';
            if (window._csLifecycleFilter !== 'all') url += '&severity=' + encodeURIComponent(window._csLifecycleFilter);
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                renderCsLifecycle(data);
            } catch (e) {
                body.innerHTML = '<tr><td colspan="12" class="px-4 py-8 text-center text-sm text-red-600">Failed to load: ' + escapeHtml(String(e.message || e)) + '</td></tr>';
            }
        }

        // Sort state — default to severity desc so critical floats to the top.
        window._csLifecycleSort = window._csLifecycleSort || { key: 'severity', dir: 'desc' };
        window._csLifecycleData = window._csLifecycleData || null;

        const CS_LIFE_SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

        // Group flat violation rows from the API into one entry per deal so a
        // single account with two violations renders as ONE table row with
        // both violations stacked, not as duplicate rows. Grouping key is
        // record_id (stable, unique per Zoho record). Within each group we
        // sort the violations by severity desc so the worst one anchors the
        // row's severity badge and is shown first.
        function groupCsLifecycleByDeal(violations) {
            const map = new Map();
            for (const v of violations) {
                const key = v.record_id ?? (v.zoho_record_id || '__noid__' + Math.random());
                if (!map.has(key)) {
                    map.set(key, {
                        record_id: v.record_id,
                        zoho_record_id: v.zoho_record_id,
                        account_name: v.account_name,
                        domain: v.domain,
                        current_phase: v.current_phase,
                        days_since_modified: v.days_since_modified,
                        cs_owner_name: v.cs_owner_name,
                        customer_since: v.customer_since,
                        renewal_date: v.renewal_date,
                        churn_date: v.churn_date,
                        health: v.health,
                        ext_id: v.ext_id,
                        // 2026-06-08 — propagate layout / stage / pipeline so
                        // the Advanced Filter (Layout / Stage / Pipeline multi-
                        // selects) can match against the group object. Backend
                        // surfaces these on every CsLifecycleViolationRow now.
                        layout: v.layout || null,
                        stage: v.stage || null,
                        pipeline: v.pipeline || null,
                        violations: [],
                    });
                }
                map.get(key).violations.push(v.violation);
            }
            // Sort the violations inside each group: worst severity first,
            // then alphabetic by code for stable display.
            for (const g of map.values()) {
                g.violations.sort((a, b) => {
                    const d = (CS_LIFE_SEVERITY_RANK[b.severity] || 0) - (CS_LIFE_SEVERITY_RANK[a.severity] || 0);
                    if (d !== 0) return d;
                    return (a.code || '').localeCompare(b.code || '');
                });
                g.worst_severity = g.violations[0]?.severity || 'info';
                g.worst_violation = g.violations[0] || null;
            }
            return Array.from(map.values());
        }

        function csLifecycleSortValue(g, key) {
            const worst = g.worst_violation || {};
            switch (key) {
                case 'severity':  return CS_LIFE_SEVERITY_RANK[g.worst_severity] || 0;
                case 'account':   return (g.account_name || '').toLowerCase();
                case 'domain':    return (g.domain || '').toLowerCase();
                case 'phase':     return (g.current_phase || '').toLowerCase();
                case 'days':      return g.days_since_modified == null ? -1 : Number(g.days_since_modified);
                case 'violation': return csLifeViolationLabel(worst.code).toLowerCase();
                case 'message':   return (worst.message || '').toLowerCase();
                default:          return 0;
            }
        }

        function sortCsLifecycleRows(groups, key, dir) {
            const factor = dir === 'asc' ? 1 : -1;
            return groups.slice().sort((a, b) => {
                const va = csLifecycleSortValue(a, key);
                const vb = csLifecycleSortValue(b, key);
                if (va < vb) return -1 * factor;
                if (va > vb) return  1 * factor;
                return 0;
            });
        }

        function updateCsLifecycleSortIndicators() {
            const headers = document.querySelectorAll('#csLifecycleTableHead .cs-lifecycle-sort');
            headers.forEach(h => {
                const key = h.getAttribute('data-sort-key');
                const ind = h.querySelector('.cs-lifecycle-sort-indicator');
                if (!ind) return;
                if (key === window._csLifecycleSort.key) {
                    ind.textContent = window._csLifecycleSort.dir === 'asc' ? '↑' : '↓';
                    ind.classList.remove('opacity-30');
                    ind.classList.add('text-gray-900');
                } else {
                    ind.textContent = '⇅';
                    ind.classList.add('opacity-30');
                    ind.classList.remove('text-gray-900');
                }
            });
        }

        function sortCsLifecycle(key) {
            const cur = window._csLifecycleSort;
            if (cur.key === key) {
                cur.dir = cur.dir === 'asc' ? 'desc' : 'asc';
            } else {
                cur.key = key;
                // Numeric / ranked keys default to desc; text columns default to asc.
                cur.dir = ['severity','days'].includes(key) ? 'desc' : 'asc';
            }
            if (window._csLifecycleData) renderCsLifecycle(window._csLifecycleData);
        }

        // Phase filter helpers.
        //
        // The Phase <select> always offers the five canonical CS lifecycle
        // phases (New Deal → Onboarding → Adoption → Renewal → Termination)
        // in lifecycle order, even when the current violation set has no deal
        // in a given phase — e.g. brand-new "New Deal" deals rarely have
        // violations yet, but the operator must still be able to filter to
        // them. Any extra tenant-custom phases present in the data are
        // appended after the canonical list (alphabetically) so nothing from
        // Zoho is hidden. Matching is case/whitespace-insensitive (see
        // _normCsPhase) so a selection lines up with however Zoho stored the
        // phase casing — this is what previously made the filter appear
        // "broken" when a deal's phase was e.g. "onboarding" vs "Onboarding".
        //
        // The active selection is preserved across re-renders; canonical
        // options always exist, so a canonical selection always survives.
        //
        // onCsLifecyclePhaseChange is the data-on-change handler. It stashes
        // the choice on window so a subsequent renderCsLifecycle re-applies
        // it, then triggers a render with the existing in-memory dataset (no
        // Zoho re-fetch — phase filtering is purely client-side over the data
        // we already loaded).
        const CS_LIFECYCLE_CANONICAL_PHASES = ['New Deal', 'Onboarding', 'Adoption', 'Renewal', 'Termination'];
        function _normCsPhase(p) {
            return String(p == null ? '' : p).trim().toLowerCase();
        }
        function _refreshCsLifecyclePhaseOptions(groups) {
            const sel = document.getElementById('csLifePhaseFilter');
            if (!sel) return;
            // Distinct phases actually present in the dataset, keyed by their
            // normalised form so case variants ("onboarding" / "Onboarding")
            // collapse to one entry. Preserve the first raw casing for display.
            const dataPhases = new Map();
            for (const g of (groups || [])) {
                const raw = String(g.current_phase || '').trim();
                if (!raw) continue;
                const norm = _normCsPhase(raw);
                if (!dataPhases.has(norm)) dataPhases.set(norm, raw);
            }
            // Canonical phases first (lifecycle order), then any extra data
            // phases not already covered by a canonical entry, alphabetically.
            const seen = new Set();
            const ordered = [];
            for (const c of CS_LIFECYCLE_CANONICAL_PHASES) {
                ordered.push(c);
                seen.add(_normCsPhase(c));
            }
            const extras = [];
            for (const [norm, display] of dataPhases) {
                if (!seen.has(norm)) { extras.push(display); seen.add(norm); }
            }
            extras.sort((a, b) => a.localeCompare(b));
            const all = ordered.concat(extras);

            const current = window._csLifecyclePhaseFilter || '';
            const currentNorm = _normCsPhase(current);
            // Canonical options always exist, so a canonical selection always
            // survives; an extra (tenant-custom) selection clears if it drops
            // out of the dataset so the operator never sees a stale filter.
            const stillPresent = !!current && all.some(p => _normCsPhase(p) === currentNorm);
            const opts = ['<option value="">All phases</option>'].concat(
                all.map(p =>
                    '<option value="' + escAttr(p) + '"' + (current && _normCsPhase(p) === currentNorm ? ' selected' : '') + '>' + escapeHtml(p) + '</option>'
                )
            );
            sel.innerHTML = opts.join('');
            if (!stillPresent && current) {
                window._csLifecyclePhaseFilter = '';
                sel.value = '';
            }
        }
        function onCsLifecyclePhaseChange() {
            // Read the value straight off the <select> by id (the page
            // convention for data-on-change handlers). The safe-actions
            // delegation does NOT pass the DOM event unless data-pass-event is
            // set, so an `event`-based read here was always undefined and the
            // filter silently reset to "All phases" on every change.
            const sel = document.getElementById('csLifePhaseFilter');
            const v = sel ? sel.value : '';
            window._csLifecyclePhaseFilter = v || '';
            // Reset to the first page so the operator sees the start of the
            // newly filtered set rather than a stale page index carried over
            // from the previous (wider) filter.
            window._csLifecyclePage = 0;
            // Re-paint the table from the in-memory dataset with the new
            // filter applied. No Zoho re-fetch.
            const data = window._csLifecycleData;
            if (data) renderCsLifecycle(data);
        }

        function renderCsLifecycle(data) {
            window._csLifecycleData = data;
            const s = (data.summary && data.summary.by_severity) || {};
            document.getElementById('csLifeSumCritical').textContent = s.critical || 0;
            document.getElementById('csLifeSumWarning').textContent  = s.warning  || 0;
            document.getElementById('csLifeSumInfo').textContent     = s.info     || 0;
            document.getElementById('csLifeSumDeals').textContent    = (data.summary && data.summary.total_cs_deals) || 0;
            document.getElementById('csLifeSumTotal').textContent    = (data.summary && data.summary.total_violations) || 0;

            updateCsLifecycleSortIndicators();

            const body = document.getElementById('csLifecycleTable');
            const allViolations = data.violations || [];
            if (allViolations.length === 0) {
                body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">No violations detected. CS is compliant for the current filter.</td></tr>';
                _refreshCsLifecyclePhaseOptions([]);
                return;
            }
            // Each API row is one (deal × violation) pair. Group into one
            // entry per deal so the table reads "this deal failed X and Y"
            // instead of duplicating the account name twice.
            const groups = groupCsLifecycleByDeal(allViolations);

            // Phase filter — populated from the data, then applied. Done
            // BEFORE sorting + rendering so the phase dropdown reflects
            // the entire dataset (not just what survives the filter), and
            // a selection like "Adoption" still narrows what we paint.
            _refreshCsLifecyclePhaseOptions(groups);
            const phaseSel = window._csLifecyclePhaseFilter || '';
            const phaseSelNorm = _normCsPhase(phaseSel);
            let filtered = phaseSel
                ? groups.filter(g => _normCsPhase(g.current_phase) === phaseSelNorm)
                : groups;

            // Advanced Filter — applied client-side here since
            // /api/duplicates/cs-lifecycle/violations doesn't accept
            // owner/domain/date params. Owner matches against cs_owner_name;
            // domain against the company domain; date range against any of
            // customer_since / renewal_date / churn_date (deal is "in
            // window" if any lifecycle date sits inside the range).
            filtered = filtered.filter(g => rowMatchesAdvancedFilter(g, {
                ownerField:    'cs_owner_name',
                domainField:   'domain',
                dateFields:    ['customer_since', 'renewal_date', 'churn_date'],
                // 2026-06-08 — wire Layout / Stage / Pipeline filters
                // explicitly. Backend now surfaces these from the underlying
                // Zoho Deal's raw_data; groupCsLifecycleByDeal propagates
                // them onto each group.
                layoutField:   'layout',
                stageField:    'stage',
                pipelineField: 'pipeline',
            }));

            const sorted = sortCsLifecycleRows(filtered, window._csLifecycleSort.key, window._csLifecycleSort.dir);

            if (sorted.length === 0) {
                body.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-gray-500">No CS deals match the active filters. Adjust the phase chip or click <em>Clear All Filters</em> in the Advanced Filters panel.</td></tr>';
                renderPagination('csLifecyclePagination', 0, 1, () => {}, 0, 'deals');
                return;
            }

            // Client-side pagination — 20 deals per page so the viewport
            // doesn't have to scroll through hundreds of violations at
            // once. Page state lives on window so a sort / filter resets
            // back to page 0 (handled by the callers that mutate sort or
            // filter state).
            window._csLifecyclePage = Number.isFinite(window._csLifecyclePage) ? window._csLifecyclePage : 0;
            const totalPages = Math.max(1, Math.ceil(sorted.length / RADAR_PAGE_SIZE));
            if (window._csLifecyclePage >= totalPages) window._csLifecyclePage = 0;
            const pageStart = window._csLifecyclePage * RADAR_PAGE_SIZE;
            const pageSlice = sorted.slice(pageStart, pageStart + RADAR_PAGE_SIZE);

            body.innerHTML = pageSlice.map(g => {
                // CS Lifecycle violations are always Deal records (see
                // scanCsLifecycleViolations: WHERE zoho_module = 'Deals'), so
                // the Zoho link target is hard-coded to 'Deals'.
                const accountCell = g.zoho_record_id
                    ? zohoLink(g.zoho_record_id, 'Deals', g.account_name || '—')
                    : escapeHtml(g.account_name || '—');
                const violationPills = g.violations.map(v =>
                    '<span class="inline-block px-2 py-0.5 rounded text-[11px] font-medium ' + csLifeSeverityPill(v.severity) + '" title="' + escapeHtml(v.severity) + '">'
                    + escapeHtml(csLifeViolationLabel(v.code))
                    + '</span>'
                ).join(' ');
                const messageStack = g.violations.map(v =>
                    '<div class="mb-1 last:mb-0"><span class="text-[10px] uppercase font-medium ' + (v.severity === 'critical' ? 'text-red-700' : v.severity === 'warning' ? 'text-amber-700' : 'text-blue-700') + ' me-1">' + escapeHtml(v.severity) + '</span>' + escapeHtml(v.message || '') + '</div>'
                ).join('');
                const countSuffix = g.violations.length > 1
                    ? ' <span class="text-[10px] text-gray-500">(' + g.violations.length + ')</span>'
                    : '';
                // ── Compact-layout helpers ────────────────────────────────
                // Account + Domain stacked into one cell. Domain in mono
                // font and 10px so it reads as a secondary label.
                const accountDomainCell =
                    '<div class="text-xs text-gray-800 leading-tight">' + accountCell + '</div>'
                    + '<div class="text-[10px] font-mono text-gray-500 leading-tight">' + escapeHtml(g.domain || '—') + '</div>';
                // Three lifecycle dates stacked with mini labels. Same
                // pattern as the Created column on the duplicate tabs.
                const fmtDate = (d) => (d == null || d === '') ? '—' : escapeHtml(String(d));
                const datesCell =
                    '<div class="text-[10px] leading-tight text-gray-600 whitespace-nowrap">'
                    +   '<span class="text-gray-400">Since:</span> ' + fmtDate(g.customer_since)
                    + '</div>'
                    + '<div class="text-[10px] leading-tight text-gray-600 whitespace-nowrap">'
                    +   '<span class="text-gray-400">Renew:</span> ' + fmtDate(g.renewal_date)
                    + '</div>'
                    + '<div class="text-[10px] leading-tight text-gray-600 whitespace-nowrap">'
                    +   '<span class="text-gray-400">Churn:</span> ' + fmtDate(g.churn_date)
                    + '</div>';
                // Violation pills + message stacked into one cell so we
                // drop the dedicated Message column entirely.
                const violationCell =
                    '<div class="flex flex-wrap gap-1 mb-1">' + violationPills + '</div>'
                    + '<div class="text-[11px] text-gray-700 leading-snug">' + messageStack + '</div>';
                return '<tr class="hover:bg-gray-50 align-top">'
                    + '<td class="px-2 py-2 whitespace-nowrap">' + csLifeSeverityBadge(g.worst_severity) + countSuffix + '</td>'
                    + '<td class="px-2 py-2">' + accountDomainCell + '</td>'
                    + '<td class="px-2 py-2 text-xs text-gray-800 whitespace-nowrap">' + escapeHtml(g.current_phase || '—') + '</td>'
                    + '<td class="px-2 py-2 text-xs text-gray-700">' + escapeHtml(g.cs_owner_name || '—') + '</td>'
                    + '<td class="px-2 py-2">' + datesCell + '</td>'
                    + '<td class="px-2 py-2 text-[11px] font-mono text-gray-700 whitespace-nowrap">' + escapeHtml(g.ext_id == null || g.ext_id === '' ? '—' : String(g.ext_id)) + '</td>'
                    + '<td class="px-2 py-2 text-xs text-end text-gray-600 whitespace-nowrap">' + (g.days_since_modified == null ? '—' : g.days_since_modified) + '</td>'
                    + '<td class="px-2 py-2">' + violationCell + '</td>'
                    + '</tr>';
            }).join('');

            renderPagination('csLifecyclePagination', window._csLifecyclePage, totalPages,
                (p) => { window._csLifecyclePage = p; renderCsLifecycle(window._csLifecycleData); },
                sorted.length, 'deals');
        }

        // Severity → CAPA-form severity (matches csLifecycleAutoCapa.ts).
        function csLifeSeverityToCapa(s) {
            if (s === 'critical') return 'critical';
            if (s === 'warning')  return 'major';
            return 'minor';
        }

        // ─── Per-tab payload builders ──────────────────────────────────────
        // Each builder takes a row from the tab's data model and returns the
        // payload shape that openCapaModal / submitOpenCapa expect. The
        // row-picker (openCapaPicker) calls these to populate the modal
        // when an operator selects a row from the dropdown. No button HTML
        // is rendered here — buttons live at the tab-bar level now.

        // CS Lifecycle: payload targets the worst violation on the deal so
        // source_id matches the auto-CAPA cron's pattern
        // (cs_lifecycle:<recordId>:<code>), keeping manual + auto opens
        // idempotent against each other.
        function csLifePayloadFor(g) {
            const v = g.worst_violation || (g.violations && g.violations[0]) || null;
            if (!v || !g.record_id) return null;
            const subject = g.account_name || g.domain || 'unknown account';
            const description = [
                'Account: ' + (g.account_name || '—'),
                'Domain: ' + (g.domain || '—'),
                'Current CS phase: ' + (g.current_phase || '—'),
                'CS Owner: ' + (g.cs_owner_name || '—'),
                'Days since modified: ' + (g.days_since_modified == null ? '—' : g.days_since_modified),
                '',
                'Violation: ' + (v.message || csLifeViolationLabel(v.code)),
                '',
                'Suggested action: ' + (v.suggested_action || 'Resolve the underlying CRM data issue.'),
                '',
                'Opened manually from the Duplicate Radar → CS Lifecycle tab.',
            ].join('\n');
            return {
                sourceType: 'cs_lifecycle_violation',
                sourceId:   'cs_lifecycle:' + g.record_id + ':' + v.code,
                sourceLabel: subject + ' · ' + v.code,
                title:       csLifeViolationLabel(v.code) + ' — ' + subject,
                description,
                severity:    csLifeSeverityToCapa(v.severity),
                targetDays:  v.severity === 'critical' ? 3 : 7,
            };
        }

        // CS Pipeline Overlap: payload matches the auto-CAPA-on-block pattern
        // (source_type 'cs_overlap_block', source_id = cluster.id).
        function csOverlapPayloadFor(r) {
            if (!r || !r.id) return null;
            const verdict = String(r.cs_overlap_verdict || '').toLowerCase();
            const sev = verdict === 'block'  ? 'critical'
                      : verdict === 'review' ? 'major'
                      : verdict === 'warn'   ? 'minor'
                      : 'observation';
            const subject = r.company_name || r.company_name_arabic || r.domain || 'unknown account';
            const description = [
                'Cluster: #' + r.id,
                'Domain: ' + (r.domain || '—'),
                'Company: ' + subject,
                'Sector: ' + (r.client_sector || '—'),
                'CS phase: ' + (csPhaseLabel(r.pipeline_lifecycle_state) || '—'),
                'ARR exposure: ' + formatCurrency(r.arr_exposure || 0),
                'Records in cluster: ' + (r.total_records || 0),
                'Radar verdict: ' + (r.cs_overlap_verdict || '—').toUpperCase(),
                '',
                'Open this cluster in the radar to see every underlying record,',
                'then merge / reassign / annotate per the Quality SOP.',
                '',
                'Opened manually from the Duplicate Radar → CS Pipeline Overlap tab.',
            ].join('\n');
            return {
                sourceType:  'cs_overlap_block',
                sourceId:    String(r.id),
                sourceLabel: subject + ' · cluster #' + r.id,
                title:       'CS overlap (' + (r.cs_overlap_verdict || '—').toUpperCase() + ') — ' + subject,
                description,
                severity:    sev,
                targetDays:  verdict === 'block' ? 3 : 7,
            };
        }

        // Cross-Module overlap. source_type 'cross_module_overlap'.
        function crossModulePayloadFor(c) {
            if (!c || !c.id) return null;
            const meta = CROSS_MODULE_PAIRING_LABELS[c.pairing] || { label: c.pairing || '—', action: 'Open cluster for per-record recommendations' };
            const modules = [];
            if (c.total_leads    > 0) modules.push('Leads(' + c.total_leads + ')');
            if (c.total_contacts > 0) modules.push('Contacts(' + c.total_contacts + ')');
            if (c.total_accounts > 0) modules.push('Accounts(' + c.total_accounts + ')');
            if (c.total_deals    > 0) modules.push('Deals(' + c.total_deals + ')');
            const pairing = String(c.pairing || '').toLowerCase();
            const sev = pairing === 'mixed' ? 'major' : 'minor';
            const subject = c.company_name || c.domain || ('cluster #' + c.id);
            const description = [
                'Cross-module cluster: #' + c.id,
                'Pairing: ' + (meta.label || c.pairing || '—'),
                'Domain: ' + (c.domain || '—'),
                'Company: ' + (c.company_name || '—'),
                'Modules present: ' + modules.join(' · '),
                'Records: ' + (c.total_records || 0),
                'Confidence: ' + (c.confidence_score || 0) + '%',
                'Pipeline value: ' + formatCurrency(Number(c.estimated_pipeline_value || 0)),
                '',
                'Recommended action (radar): ' + (meta.action || 'Open cluster for per-record recommendations'),
                '',
                'Opened manually from the Duplicate Radar → Cross-Module tab.',
            ].join('\n');
            return {
                sourceType:  'cross_module_overlap',
                sourceId:    String(c.id),
                sourceLabel: subject + ' · ' + (meta.label || c.pairing || ''),
                title:       'Cross-module overlap (' + (meta.label || c.pairing || '—') + ') — ' + subject,
                description,
                severity:    sev,
                targetDays:  pairing === 'mixed' ? 5 : 7,
            };
        }

        // Domain Cluster card. source_type 'duplicate_cluster'.
        function clusterPayloadFor(c) {
            if (!c || !c.id) return null;
            const conf = String(c.confidence_level || '').toLowerCase();
            const sev = conf === 'high' ? 'major' : conf === 'medium' ? 'minor' : 'observation';
            const subject = c.company_name || c.domain || ('cluster #' + c.id);
            const description = [
                'Cluster: #' + c.id,
                'Domain: ' + (c.domain || '—'),
                'Company: ' + (c.company_name || '—'),
                'Confidence: ' + (c.confidence_level || '—') + ' (' + (c.confidence_score || 0) + '%)',
                'Status: ' + (c.status || '—'),
                'Records: leads=' + (c.total_leads || 0) + ', deals=' + (c.total_deals || 0) + ', contacts=' + (c.total_contacts || 0) + ', accounts=' + (c.total_accounts || 0),
                'Pipeline inflation: ' + formatCurrency(c.estimated_pipeline_value || 0),
                '',
                'Open this cluster from the Domain Clusters tab to see every',
                'underlying record before merging / annotating per the SOP.',
                '',
                'Opened manually from the Duplicate Radar → Domain Clusters tab.',
            ].join('\n');
            return {
                sourceType:  'duplicate_cluster',
                sourceId:    String(c.id),
                sourceLabel: subject + ' · cluster #' + c.id,
                title:       'Duplicate cluster — ' + subject,
                description,
                severity:    sev,
                targetDays:  7,
            };
        }

        // Account Hint row → CAPA. The hint is a radar suggestion that an
        // orphan deal should be linked to a specific Account. Opening a
        // CAPA here formalises the "fix this Account_Name field in Zoho"
        // work for the Quality inbox. source_type 'account_hint',
        // source_id = hint DB id (stable across renders).
        function accountHintPayloadFor(h) {
            if (!h || !h.id) return null;
            const conf = Number(h.confidence || 0);
            const status = String(h.status || 'pending').toLowerCase();
            // Only pending hints carry real urgency — applied / dismissed
            // CAPAs are retrospective so default to observation.
            const sev = status !== 'pending' ? 'observation'
                      : conf >= 80 ? 'major'
                      : conf >= 60 ? 'minor'
                      : 'observation';
            const dealLabel = h.deal_company_name || h.deal_account_name || h.deal_zoho_id || ('deal #' + h.id);
            const suggested = h.suggested_account_name || h.suggested_domain || '—';
            const description = [
                'Account-Hint id: ' + h.id,
                'Status: ' + status,
                'Confidence: ' + conf + '%',
                '',
                'Deal: ' + dealLabel + (h.deal_zoho_id ? ' (Zoho id ' + h.deal_zoho_id + ')' : ''),
                'Current Account_Name on the deal: ' + (h.deal_account_name || '— missing —'),
                'Suggested Account: ' + suggested + (h.suggested_account_zoho_id ? ' (Zoho id ' + h.suggested_account_zoho_id + ')' : ''),
                'Suggested domain: ' + (h.suggested_domain || '—'),
                'Evidence contact: ' + (h.evidence_contact_email || '—') + (h.evidence_contact_zoho_id ? ' (Zoho id ' + h.evidence_contact_zoho_id + ')' : ''),
                '',
                'Recommended action: open the deal in Zoho and set Account_Name',
                'to the suggested Account above. Next radar sync will auto-',
                'reclassify the hint as Applied.',
                '',
                'Opened manually from the Duplicate Radar → Account Hints tab.',
            ].join('\n');
            return {
                sourceType:  'account_hint',
                sourceId:    'account_hint:' + h.id,
                sourceLabel: dealLabel + ' → ' + suggested,
                title:       'Account-Hint — fix Account_Name on ' + dealLabel,
                description,
                severity:    sev,
                targetDays:  7,
            };
        }

        // Owner Accountability row → CAPA. Used to escalate a rep carrying a
        // high duplicate-debt load: source_type 'owner_accountability',
        // source_id = email (the stable per-owner key). Severity climbs with
        // the rep's duplicate_rate.
        function ownerPayloadFor(o) {
            if (!o || (!o.owner_email && !o.owner_name)) return null;
            const dupRate = Number(o.duplicate_rate || 0);
            const sev = dupRate >= 50 ? 'major'
                      : dupRate >= 25 ? 'minor'
                      : 'observation';
            const subject = o.owner_name || o.owner_email || 'unknown owner';
            const waste = formatCurrency(Number(o.estimated_waste_value || 0));
            const description = [
                'Owner: ' + subject,
                'Email: ' + (o.owner_email || '—'),
                'Role / team: ' + (o.team || '—'),
                'Total records owned: ' + (o.total_records || 0),
                'Duplicate records: ' + (o.duplicate_records || 0) + ' (' + dupRate + '%)',
                'High-confidence duplicates: ' + (o.high_confidence_duplicates || 0),
                'Estimated waste value: ' + waste,
                'RAG status: ' + (o.rag_status || '—'),
                '',
                'Use this CAPA to formalise the coaching / cleanup conversation',
                'with this owner. Attach the per-owner CSV (Export CSV → tick',
                'this row) so Quality has the full picture in the inbox.',
                '',
                'Opened manually from the Duplicate Radar → Owner Accountability tab.',
            ].join('\n');
            return {
                sourceType:  'owner_accountability',
                sourceId:    'owner:' + (o.owner_email || o.owner_name || '').toLowerCase(),
                sourceLabel: subject + ' (' + (o.owner_email || '—') + ')',
                title:       'CRM-hygiene CAPA — ' + subject + ' (' + dupRate + '% dup-rate)',
                description,
                severity:    sev,
                targetDays:  14,
            };
        }

        // Record-tab duplicate group (leads / deals / contacts / accounts).
        // source_id anchored on the primary's Zoho ID so re-clicking the same
        // group hits the existing CAPA.
        function recordTabPayloadFor(module, summary) {
            if (!summary || !summary.primary) return null;
            const primary = summary.primary;
            const zid = String(primary.zoho_record_id || '').trim();
            const moduleZoho = module === 'leads' ? 'Leads'
                             : module === 'deals' ? 'Deals'
                             : module === 'contacts' ? 'Contacts'
                             : 'Accounts';
            const sourceId = zid
                ? (module + ':' + zid)
                : (module + ':' + (primary.record_name || primary.email || 'group') + ':' + (summary.count || 0));
            const subject = primary.record_name || primary.company_name || primary.email || ('group of ' + (summary.count || 0));
            const sharedDesc = (summary.sharedKeys || []).map(s => s.label + '=' + (s.value || '')).join(' · ') || '(chained match — no single shared field)';
            const description = [
                'Module: ' + moduleZoho + ' (page-level duplicate group)',
                'Primary record: ' + subject + (zid ? ' (Zoho id ' + zid + ')' : ''),
                'Members in group: ' + (summary.count || 0),
                'Shared signals: ' + sharedDesc,
                '',
                'Open the ' + moduleZoho + ' Duplicates tab in the radar to see',
                'every member of this group, then merge / annotate per the SOP.',
                '',
                'Opened manually from the Duplicate Radar → ' + moduleZoho + ' Duplicates tab.',
            ].join('\n');
            return {
                sourceType:  'record_duplicate_group',
                sourceId,
                sourceLabel: moduleZoho + ' · ' + subject,
                title:       moduleZoho + ' duplicate group — ' + subject,
                description,
                severity:    'minor',
                targetDays:  7,
            };
        }

        // Auto-CAPA KPIs tab JS retired 2026-05-30. The /api/duplicates/auto-capa/kpis
        // endpoint stays alive for any external dashboard / future re-introduction,
        // but the in-page renderer was removed when the operator chose manual
        // "Open CAPA" buttons over the standalone KPI tab.

        // ─── Open CAPA modal helpers — shared by every actionable tab ────────
        // Any row that should be convertible to a CAPA calls openCapaModal({
        //   sourceType, sourceId, title, description, severity, sourceLabel
        // }). Submit posts to /api/duplicates/capa/manual-open which is
        // idempotent on (source_type, source_id) — re-clicking surfaces the
        // already-open CAPA instead of opening a duplicate.
        window._capaModalState = window._capaModalState || { sourceType: '', sourceId: '', sourceLabel: '' };

        function openCapaModal(opts) {
            const o = opts || {};
            window._capaModalState.sourceType  = String(o.sourceType  || '').trim();
            window._capaModalState.sourceId    = String(o.sourceId    || '').trim();
            window._capaModalState.sourceLabel = String(o.sourceLabel || '').trim();
            document.getElementById('capaModalTitle').value           = String(o.title       || '').slice(0, 240);
            document.getElementById('capaModalDescription').value     = String(o.description || '');
            document.getElementById('capaModalSeverity').value        = ['critical','major','minor','observation'].includes(String(o.severity)) ? o.severity : 'major';
            document.getElementById('capaModalTargetDays').value      = Number.isFinite(Number(o.targetDays)) ? Number(o.targetDays) : 7;
            document.getElementById('capaModalSourceLabel').textContent = window._capaModalState.sourceLabel || window._capaModalState.sourceType || '—';
            document.getElementById('capaModalSourceId').textContent    = window._capaModalState.sourceId    || '—';
            // Explicit-payload path skips the picker — hide it so the operator
            // doesn't see a stale dropdown from a previous picker session.
            const picker = document.getElementById('capaPickerSection');
            if (picker) picker.classList.add('hidden');
            const status = document.getElementById('capaModalStatus');
            status.classList.add('hidden');
            status.textContent = '';
            const btn = document.getElementById('capaModalSubmitBtn');
            btn.disabled = false;
            btn.textContent = 'Open CAPA';
            document.getElementById('capaModal').classList.remove('hidden');
        }
        window.openCapaModal = openCapaModal;

        function closeCapaModal() {
            document.getElementById('capaModal').classList.add('hidden');
        }
        window.closeCapaModal = closeCapaModal;

        // ─── Open CAPA picker — tab → row provider registry ─────────────────
        // Each provider runs the tab's current rendered data through the
        // matching payload-builder and returns one option per actionable
        // row. The shared modal then lets the operator pick which row
        // they're opening a CAPA on. Providers return [] when the tab has
        // never been loaded — openCapaPicker shows a friendly hint in
        // that case.
        const CAPA_TAB_PROVIDERS = {
            'cs-lifecycle': () => {
                const data = window._csLifecycleData;
                if (!data || !Array.isArray(data.violations) || data.violations.length === 0) return [];
                // Same grouping the CS Lifecycle renderer uses, so the picker
                // mirrors what's on screen (one option per deal, not per
                // violation row).
                const groups = groupCsLifecycleByDeal(data.violations);
                return groups
                    .map(g => {
                        const p = csLifePayloadFor(g);
                        if (!p) return null;
                        const subject = g.account_name || g.domain || ('record #' + g.record_id);
                        const sevTag = (g.worst_severity || '').toUpperCase();
                        const violCode = (g.worst_violation && g.worst_violation.code) || '—';
                        return {
                            label: '[' + sevTag + '] ' + subject + ' — ' + violCode,
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
            'cs-overlap': () => {
                const data = window._csOverlapData;
                if (!data || !Array.isArray(data.clusters) || data.clusters.length === 0) return [];
                return data.clusters
                    .map(r => {
                        const p = csOverlapPayloadFor(r);
                        if (!p) return null;
                        const subject = r.company_name || r.domain || ('cluster #' + r.id);
                        const v = (r.cs_overlap_verdict || '—').toUpperCase();
                        return {
                            label: '[' + v + '] ' + subject + ' — ' + (r.domain || '—'),
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
            'cross-module': () => {
                // crossModuleClusters / crossModuleFilter are script-scope
                // `let` declarations earlier in this file (~line 1328) — same
                // closure renderCrossModuleTable uses. Respect the current
                // pairing filter so the picker shows the same rows the
                // operator sees on screen.
                const all = Array.isArray(crossModuleClusters) ? crossModuleClusters : [];
                if (all.length === 0) return [];
                const filtered = crossModuleFilter !== 'all'
                    ? all.filter(c => c.pairing === crossModuleFilter)
                    : all;
                return filtered
                    .map(c => {
                        const p = crossModulePayloadFor(c);
                        if (!p) return null;
                        const subject = c.company_name || c.domain || ('cluster #' + c.id);
                        const pairing = (CROSS_MODULE_PAIRING_LABELS[c.pairing] && CROSS_MODULE_PAIRING_LABELS[c.pairing].label) || c.pairing || '—';
                        return {
                            label: '[' + pairing + '] ' + subject + ' — ' + (c.domain || '—'),
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
            'clusters': () => {
                // Domain Clusters tab — only what's on the current page,
                // since clusters paginate server-side. _lastClustersPage is
                // a script-scope `let` populated by renderClusters().
                const list = Array.isArray(_lastClustersPage) ? _lastClustersPage : [];
                if (list.length === 0) return [];
                return list
                    .map(c => {
                        const p = clusterPayloadFor(c);
                        if (!p) return null;
                        const subject = c.company_name || c.domain || ('cluster #' + c.id);
                        const conf = (c.confidence_level || '—');
                        return {
                            label: '[' + conf + ' · ' + (c.confidence_score || 0) + '%] ' + subject + ' — ' + (c.domain || '—'),
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
            'leads':    () => _recordTabPickerOptions('leads'),
            'deals':    () => _recordTabPickerOptions('deals'),
            'contacts': () => _recordTabPickerOptions('contacts'),
            'accounts': () => _recordTabPickerOptions('accounts'),
            'account-hints': () => {
                // window._accountHintsData is the cache renderAccountHints
                // populates; we read it directly so the picker mirrors the
                // current status-filter view (Pending / Applied / Dismissed).
                const data = window._accountHintsData;
                if (!data || !Array.isArray(data.hints) || data.hints.length === 0) return [];
                return data.hints
                    .map(h => {
                        const p = accountHintPayloadFor(h);
                        if (!p) return null;
                        const dealLabel = h.deal_company_name || h.deal_account_name || h.deal_zoho_id || ('deal #' + h.id);
                        const suggested = h.suggested_account_name || h.suggested_domain || '—';
                        const conf = Number(h.confidence || 0);
                        const status = (h.status || 'pending').toUpperCase();
                        return {
                            label: '[' + status + ' · ' + conf + '%] ' + dealLabel + ' → ' + suggested,
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
            'owners': () => {
                // _ownersCache is the script-scope array renderOwners() fills
                // when the Owner Accountability tab loads. Reads it directly
                // so we mirror what's on screen (with current sort applied).
                const list = Array.isArray(_ownersCache) ? _ownersCache : [];
                if (list.length === 0) return [];
                return list
                    .map(o => {
                        const p = ownerPayloadFor(o);
                        if (!p) return null;
                        const subject = o.owner_name || o.owner_email || 'unknown owner';
                        const rag = (o.rag_status || '—').toUpperCase();
                        const rate = Number(o.duplicate_rate || 0);
                        return {
                            label: '[' + rag + ' · ' + rate + '%] ' + subject + ' — ' + (o.duplicate_records || 0) + ' duplicates',
                            payload: p,
                        };
                    })
                    .filter(Boolean);
            },
        };

        // Lead / Deal / Contact / Account Duplicates picker. The renderer
        // groups records on the fly using union-find; we mirror that here so
        // the picker offers one option per visible duplicate group.
        function _recordTabPickerOptions(module) {
            // The renderers cache the last-rendered tbody by inserting rows
            // into the DOM, not by stashing the grouped data on window. Re-
            // derive groups from the dom-resident data we know exists: scan
            // the table for yellow group-header rows and pull the primary
            // record's text. Cheaper than re-fetching from /api/duplicates.
            const tableId = module + 'Table';
            const tbody = document.getElementById(tableId);
            if (!tbody) return [];
            const headers = tbody.querySelectorAll('tr[data-testid^="row-dup-group-"]');
            const options = [];
            headers.forEach((tr) => {
                const gid = tr.getAttribute('data-testid').replace('row-dup-group-', '');
                const primaryNameEl = tr.querySelector('.font-semibold');
                const countEl = tr.querySelector('.text-gray-500');
                const primaryName = primaryNameEl ? primaryNameEl.textContent.trim() : '(no name)';
                const countText  = countEl ? countEl.textContent.trim() : '';
                // Synthesise a minimal summary that recordTabPayloadFor can
                // consume. The DOM doesn't carry the Zoho ID — fall back to
                // the gid-based synthetic source_id, which is stable across
                // re-renders of the same tab without rescanning.
                const summary = {
                    primary: { record_name: primaryName },
                    count: parseInt((countText.match(/\d+/) || ['0'])[0], 10) || 0,
                    sharedKeys: [],
                };
                const p = recordTabPayloadFor(module, summary);
                if (!p) return;
                // Override the source_id with the rendered group-id so picking
                // the same group from the same render reliably hits the
                // existing CAPA.
                p.sourceId = module + ':group:' + gid + ':' + primaryName.toLowerCase().replace(/\s+/g, '_').slice(0, 40);
                options.push({
                    label: '[' + module.toUpperCase() + '] ' + primaryName + ' · ' + countText,
                    payload: p,
                });
            });
            return options;
        }

        function openCapaPicker(tabKey) {
            const provider = CAPA_TAB_PROVIDERS[tabKey];
            if (typeof provider !== 'function') {
                alert('No CAPA picker is configured for this tab yet.');
                return;
            }
            const rows = provider() || [];
            const tabLabelMap = {
                'cs-lifecycle': 'CS Lifecycle',
                'cs-overlap':   'CS Pipeline Overlap',
                'cross-module': 'Cross-Module',
                'clusters':     'Domain Clusters',
                'leads':        'Lead Duplicates',
                'deals':        'Deal Duplicates',
                'contacts':     'Contact Duplicates',
                'accounts':     'Account Duplicates',
                'account-hints': 'Account Hints',
                'owners':       'Owner Accountability',
            };
            const tabLabel = tabLabelMap[tabKey] || tabKey;
            if (rows.length === 0) {
                alert('No rows are loaded on the ' + tabLabel + ' tab yet — open the tab (and run a scan if needed) so the picker has something to choose from.');
                return;
            }
            // Stash for the picker change-handler to look up.
            window._capaPickerRows = rows;
            window._capaPickerTabLabel = tabLabel;

            // Reset modal fields so a previous open doesn't leak.
            document.getElementById('capaModalTitle').value           = '';
            document.getElementById('capaModalDescription').value     = '';
            document.getElementById('capaModalSeverity').value        = 'major';
            document.getElementById('capaModalTargetDays').value      = 7;
            document.getElementById('capaModalSourceLabel').textContent = '—';
            document.getElementById('capaModalSourceId').textContent    = '—';
            window._capaModalState = { sourceType: '', sourceId: '', sourceLabel: '' };

            // Build + show the picker section.
            const sel = document.getElementById('capaPickerSelect');
            sel.innerHTML = '<option value="">— Pick the row this CAPA is for —</option>'
                + rows.map((r, i) => '<option value="' + i + '">' + escapeHtml(r.label) + '</option>').join('');
            sel.value = '';
            document.getElementById('capaPickerHint').textContent =
                'Tab: ' + tabLabel + ' · ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' available';
            document.getElementById('capaPickerSection').classList.remove('hidden');

            // Reset status + button label, then open the modal.
            const status = document.getElementById('capaModalStatus');
            status.classList.add('hidden');
            status.textContent = '';
            const btn = document.getElementById('capaModalSubmitBtn');
            btn.disabled = false;
            btn.textContent = 'Open CAPA';
            document.getElementById('capaModal').classList.remove('hidden');
        }
        window.openCapaPicker = openCapaPicker;

        function onCapaPickerChange() {
            const sel = document.getElementById('capaPickerSelect');
            const raw = sel.value;
            const idx = parseInt(raw, 10);
            if (!Number.isFinite(idx)) {
                // "Pick a row" selected — clear fields so the operator can't
                // submit an empty payload by accident.
                window._capaModalState = { sourceType: '', sourceId: '', sourceLabel: '' };
                document.getElementById('capaModalTitle').value       = '';
                document.getElementById('capaModalDescription').value = '';
                document.getElementById('capaModalSourceLabel').textContent = '—';
                document.getElementById('capaModalSourceId').textContent    = '—';
                return;
            }
            const row = (window._capaPickerRows || [])[idx];
            if (!row || !row.payload) return;
            const p = row.payload;
            window._capaModalState.sourceType  = p.sourceType  || '';
            window._capaModalState.sourceId    = p.sourceId    || '';
            window._capaModalState.sourceLabel = p.sourceLabel || '';
            document.getElementById('capaModalTitle').value       = String(p.title || '').slice(0, 240);
            document.getElementById('capaModalDescription').value = String(p.description || '');
            document.getElementById('capaModalSeverity').value    = ['critical','major','minor','observation'].includes(String(p.severity)) ? p.severity : 'major';
            document.getElementById('capaModalTargetDays').value  = Number.isFinite(Number(p.targetDays)) ? Number(p.targetDays) : 7;
            document.getElementById('capaModalSourceLabel').textContent = p.sourceLabel || p.sourceType || '—';
            document.getElementById('capaModalSourceId').textContent    = p.sourceId    || '—';
        }
        window.onCapaPickerChange = onCapaPickerChange;

        async function submitOpenCapa() {
            const title       = String(document.getElementById('capaModalTitle').value || '').trim();
            const description = String(document.getElementById('capaModalDescription').value || '').trim();
            const severity    = document.getElementById('capaModalSeverity').value || 'major';
            const targetDaysN = Number(document.getElementById('capaModalTargetDays').value);
            const targetDays  = Number.isFinite(targetDaysN) && targetDaysN > 0 ? Math.floor(targetDaysN) : 7;
            const status      = document.getElementById('capaModalStatus');
            const btn         = document.getElementById('capaModalSubmitBtn');
            const s           = window._capaModalState || {};
            if (!s.sourceType || !s.sourceId) {
                status.className = 'text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2';
                status.textContent = 'Internal error: missing source — please close the dialog and try again.';
                status.classList.remove('hidden');
                return;
            }
            if (!title) {
                status.className = 'text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2';
                status.textContent = 'Title is required.';
                status.classList.remove('hidden');
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Opening…';
            try {
                const res = await fetch('/api/duplicates/capa/manual-open', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_type: s.sourceType,
                        source_id:   s.sourceId,
                        title,
                        description,
                        severity,
                        target_days: targetDays,
                        source_reference: s.sourceLabel || null,
                    }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.error || ('HTTP ' + res.status));
                }
                status.className = 'text-sm text-green-800 bg-green-50 border border-green-200 rounded-md p-2';
                status.textContent = data.was_existing
                    ? ('CAPA already open: ' + (data.capa_number || data.capa_id || '—') + ' — tracked in the QMS CAPA inbox.')
                    : ('CAPA opened: ' + (data.capa_number || data.capa_id || '—') + ' — Quality will work it in the QMS CAPA inbox.');
                status.classList.remove('hidden');
                btn.textContent = data.was_existing ? 'Already open' : 'Opened';
                // Leave button disabled — operator should close the dialog now.
            } catch (e) {
                status.className = 'text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2';
                status.textContent = 'Failed to open CAPA: ' + String((e && e.message) || e);
                status.classList.remove('hidden');
                btn.disabled = false;
                btn.textContent = 'Retry';
            }
        }
        window.submitOpenCapa = submitOpenCapa;

        // 2026-06-08 — Build a Zoho global-search deep-link for a given term.
        // Operators want to jump from a preflight verdict row straight into
        // the actual Lead/Deal/Contact/Account in CRM to verify the match
        // by hand. Zoho's search-by-keyword endpoint takes the term as
        // ?searchword= and surfaces every module that hits, which is the
        // right entry point when we don't have the exact record id (the
        // preflight engine carries the cluster id, not the per-record id —
        // the cluster may span multiple Zoho records). The org id is fixed
        // for this tenant; lifted from renderCrmLinkCell in calls.html to
        // keep the deep-link prefix consistent across pages.
        function _zohoSearchUrl(term) {
            const t = String(term || '').trim();
            if (!t) return null;
            return 'https://crm.zoho.com/crm/org766568398/search?searchword=' + encodeURIComponent(t);
        }

        function _preflightDomainCell(domain) {
            if (!domain) return '<span class="text-gray-400">—</span>';
            const url = _zohoSearchUrl(domain);
            if (!url) return escapeHtml(domain);
            // The arrow ↗ is the standard "opens in new tab / leaves the
            // dashboard" affordance used throughout the radar (see also the
            // Deal ↗ badge in calls.html). Title gives the operator the
            // full destination on hover.
            return '<a href="' + escAttr(url) + '" target="_blank" rel="noopener"'
                + ' class="text-indigo-600 hover:text-indigo-800 underline decoration-dotted"'
                + ' title="Open Zoho CRM search for ' + escAttr(domain) + '">'
                + escapeHtml(domain) + ' <span class="text-[10px] text-gray-400" aria-hidden="true">↗</span></a>';
        }

        function _preflightCompanyCell(name) {
            if (!name) return '<span class="text-gray-400">—</span>';
            const url = _zohoSearchUrl(name);
            if (!url) return escapeHtml(name);
            return '<a href="' + escAttr(url) + '" target="_blank" rel="noopener"'
                + ' class="text-indigo-700 hover:text-indigo-900"'
                + ' title="Open Zoho CRM search for ' + escAttr(name) + '">'
                + escapeHtml(name) + '</a>';
        }

        // 2026-06-08 — Compact per-module breakdown of the matched cluster.
        // Shows only modules that have a non-zero count so PASS rows render
        // an em-dash (no cluster → no counts), and a BLOCK row with
        // contacts but no deals reads "Leads 5 · Contacts 8" instead of a
        // noisy "Leads 5 · Deals 0 · Contacts 8 · Accounts 0".
        function _preflightModulesCell(counts) {
            if (!counts || !counts.total) return '<span class="text-gray-400">—</span>';
            const parts = [];
            if (counts.leads)    parts.push('<span class="text-gray-700">Leads <span class="font-mono font-medium">' + _fn(counts.leads) + '</span></span>');
            if (counts.deals)    parts.push('<span class="text-gray-700">Deals <span class="font-mono font-medium">' + _fn(counts.deals) + '</span></span>');
            if (counts.contacts) parts.push('<span class="text-gray-700">Contacts <span class="font-mono font-medium">' + _fn(counts.contacts) + '</span></span>');
            if (counts.accounts) parts.push('<span class="text-gray-700">Accounts <span class="font-mono font-medium">' + _fn(counts.accounts) + '</span></span>');
            if (parts.length === 0) return '<span class="text-gray-400">—</span>';
            return '<span class="text-[11px] whitespace-nowrap"'
                + ' title="' + escAttr(_fn(counts.total) + ' total records in this cluster across ' + parts.length + ' module(s)') + '">'
                + parts.join(' <span class="text-gray-300">·</span> ')
                + '</span>';
        }

        // 2026-06-08 — Per-row "View" button that opens the cluster detail
        // modal inside the radar (same modal the Domain Clusters tab uses).
        // Lets the operator drill into every underlying record without
        // leaving the preflight context. PASS rows have no cluster_id, so
        // the cell is blank — keeps the column read clean.
        function _preflightViewCell(clusterId) {
            if (!clusterId) return '';
            return '<button type="button"'
                + ' data-on-click="showClusterDetails" data-args="[' + clusterId + ']"'
                + ' class="px-2 py-0.5 text-[11px] rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200"'
                + ' title="Open this cluster in the radar — every record, module, owner, ARR"'
                + ' data-testid="btn-preflight-view-cluster-' + clusterId + '">'
                + 'View →</button>';
        }

        function renderPreflight(data) {
            // Cache the FULL result blob so Excel-export + copy-email don't
            // have to re-run the check.
            window._preflightLastResult = data;

            const s = data.summary || {};
            document.getElementById('preflightSumBlock').textContent  = s.block  || 0;
            document.getElementById('preflightSumReview').textContent = s.review || 0;
            document.getElementById('preflightSumWarn').textContent   = s.warn   || 0;
            document.getElementById('preflightSumDup').textContent    = s.duplicate || 0;
            var _ncEl = document.getElementById('preflightSumNoContact');
            if (_ncEl) _ncEl.textContent = s.no_contact || 0;
            document.getElementById('preflightSumPass').textContent   = s.pass   || 0;

            // Executive headline card — turns the engineer-summary numbers
            // into one sentence a Head of Sales reads in 3 seconds.
            const exec = document.getElementById('preflightExecCard');
            const headline = document.getElementById('preflightExecHeadline');
            const meta = document.getElementById('preflightExecMeta');
            const reasonsHost = document.getElementById('preflightExecTopReasons');
            const actionable = (s.block || 0) + (s.review || 0) + (s.warn || 0) + (s.duplicate || 0) + (s.no_contact || 0);
            const examined = data.examined || 0;
            const pctAct = data.pct_actionable != null ? data.pct_actionable : (examined > 0 ? Math.round(actionable / examined * 1000) / 10 : 0);
            if (exec && headline) {
                headline.textContent = 'Pre-import check on ' + examined.toLocaleString() + ' record(s) found ' + actionable.toLocaleString() + ' duplicate or already-known matches (' + pctAct + '% of the batch).';
                if (meta) meta.textContent = 'Generated ' + (data.generated_at ? data.generated_at.slice(0, 16).replace('T', ' ') + ' UTC' : new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC');
                exec.classList.remove('hidden');
            }
            if (reasonsHost) {
                const reasons = Array.isArray(data.top_reasons) ? data.top_reasons : [];
                reasonsHost.innerHTML = reasons.map(tr => ''
                    + '<div class="bg-white rounded p-2 border border-indigo-200">'
                    +   '<div class="text-xs text-gray-500">' + escapeHtml(tr.label) + '</div>'
                    +   '<div class="text-base font-bold text-indigo-700 mt-0.5">' + tr.count.toLocaleString() + ' <span class="text-xs font-normal text-gray-500">(' + tr.pct + '%)</span></div>'
                    + '</div>').join('') || '<div class="text-xs text-gray-500 col-span-full">No actionable matches in this batch.</div>';
            }

            // Show copy-email / push buttons now that there is a result.
            const copyBtn = document.getElementById('preflightCopyEmailBtn');
            const pushBtn = document.getElementById('preflightPushBtn');
            if (copyBtn) copyBtn.classList.remove('hidden');
            // Push is only useful if there's at least one PASS row.
            if (pushBtn) {
                const passCount = (data.rows || []).filter(r => r.verdict === 'pass').length;
                if (passCount > 0) pushBtn.classList.remove('hidden');
                else pushBtn.classList.add('hidden');
            }

            // Structured-push panel — reveal it + refresh the four live counts
            // (client-side mirror of the planner's pool rules).
            _pfRefreshStructuredPushCounts(data.rows || []);

            const body = document.getElementById('preflightResultTable');
            const rows = data.rows || [];
            if (rows.length === 0) {
                body.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-sm text-gray-500">No rows processed.</td></tr>';
                return;
            }
            const sevTint = {
                critical: 'bg-red-50',
                high: 'bg-amber-50',
                medium: 'bg-yellow-50',
                low: 'bg-blue-50',
                info: '',
            };
            // Sarah 2026-06-17 — ARR column dropped from the result table
            // (mostly "—" on a vendor list since ARR only fires on
            // BLOCK/cs-overlap rows). Still emitted in the Excel export +
            // executive headline card where it's load-bearing.
            // Performance: a big upload (1,600+ rows) rendered in full froze the
            // page — each row is rich HTML (badges, links, escaping). Cap the
            // ON-SCREEN table; the FULL result stays in _preflightLastResult so
            // the Excel downloads + Push see every row. Actionable rows (block /
            // review / warn / duplicate) sort to the top so the useful ones are
            // always visible even when capped.
            const MAX_VISIBLE_PREFLIGHT = 250;
            const vOrder = { block: 0, review: 1, warn: 2, duplicate: 3, pass: 4 };
            const sortedRows = rows.slice().sort((a, b) => (vOrder[a.verdict] != null ? vOrder[a.verdict] : 9) - (vOrder[b.verdict] != null ? vOrder[b.verdict] : 9));
            const visibleRows = sortedRows.slice(0, MAX_VISIBLE_PREFLIGHT);
            const rowsHtml = visibleRows.map(r => {
                const ownerStr = Array.isArray(r.owners) && r.owners.length > 0
                    ? r.owners.slice(0, 2).map(o => escapeHtml(o)).join(', ') + (r.owners.length > 2 ? ' <span class="text-gray-400">+' + (r.owners.length - 2) + '</span>' : '')
                    : '<span class="text-gray-400">—</span>';
                const tint = sevTint[r.executive_severity] || '';
                const execAction = r.executive_action || r.suggested_action || '';
                // "↻ Re-check from CRM" — only on rows flagged because of a CRM
                // match the operator may have just corrected in Zoho. (no_contact
                // is about the uploaded contact itself, so re-fetching deals can't
                // change it — no button there.)
                const canRecheck = ['block', 'review', 'warn', 'duplicate'].indexOf(r.verdict) !== -1;
                const recheckBtn = canRecheck
                    ? ' <button class="pf-recheck-btn text-xs text-indigo-600 hover:text-indigo-800 underline ml-1"'
                        + ' data-pf-domain="' + escAttr(r.input.domain || '') + '"'
                        + ' data-pf-company="' + escAttr(r.input.company_name || '') + '"'
                        + ' title="Re-fetch this company&#39;s deals from Zoho and re-check — use after you corrected it in the CRM">↻ Re-check</button>'
                    : '';
                return '<tr class="hover:bg-gray-50 ' + tint + '">'
                    + '<td class="px-3 py-2 text-xs text-gray-500">' + (r.row_index + 1) + '</td>'
                    + '<td class="px-3 py-2 whitespace-nowrap">' + preflightVerdictBadge(r.verdict, r.reason) + '</td>'
                    + '<td class="px-3 py-2 text-xs font-mono">' + _preflightDomainCell(r.input.domain) + '</td>'
                    + '<td class="px-3 py-2 text-xs">' + _preflightCompanyCell(r.input.company_name) + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-700">' + ownerStr + '</td>'
                    + '<td class="px-3 py-2">' + _preflightModulesCell(r.module_counts) + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-700">' + escapeHtml(csPhaseLabel(r.lifecycle_state)) + '</td>'
                    + '<td class="px-3 py-2 text-xs text-gray-800" title="' + escAttr(r.reason || '') + '">' + escapeHtml(execAction) + '</td>'
                    + '<td class="px-3 py-2 whitespace-nowrap">' + _preflightViewCell(r.cluster_id) + recheckBtn + '</td>'
                    + '</tr>';
            }).join('');
            const moreNote = rows.length > MAX_VISIBLE_PREFLIGHT
                ? '<tr><td colspan="9" class="px-4 py-3 text-center text-xs text-gray-500 bg-gray-50">Showing the first ' + MAX_VISIBLE_PREFLIGHT + ' of ' + rows.length.toLocaleString() + ' rows (flagged first). Use the download buttons for the complete list — every row is included there.</td></tr>'
                : '';
            body.innerHTML = rowsHtml + moreNote;

            // Bind the per-row "↻ Re-check from CRM" handler once (delegated, so
            // it survives every renderPreflight re-render of the table body).
            if (!body._pfRecheckBound) {
                body._pfRecheckBound = true;
                body.addEventListener('click', function (e) {
                    const btn = e.target && e.target.closest ? e.target.closest('.pf-recheck-btn') : null;
                    if (!btn) return;
                    preflightRecheckCompany(btn.getAttribute('data-pf-domain'), btn.getAttribute('data-pf-company'), btn);
                });
            }
        }

        // Normalize a company name for grouping rows of the SAME company within
        // one upload (Arabic-aware, punctuation-insensitive).
        function _pfCompanyNorm(s) {
            return (s || '').toString().toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
        }

        function _pfRecomputeSummary(rows) {
            const s = { block: 0, review: 0, warn: 0, duplicate: 0, pass: 0, no_contact: 0 };
            (rows || []).forEach(function (r) { if (s[r.verdict] != null) s[r.verdict]++; });
            return s;
        }

        // Per-row "↻ Re-check from CRM": re-fetch just THIS company's deals from
        // Zoho, bust the CS-client directory cache, and re-evaluate every row of
        // the same company in place. Use after you corrected the record in Zoho —
        // a stale BLOCK flips to PASS without re-uploading or a full scan.
        async function preflightRecheckCompany(domain, companyName, btn) {
            const data = window._preflightLastResult;
            if (!data || !Array.isArray(data.rows)) return;
            const dom = (domain || '').toLowerCase().trim();
            const coNorm = _pfCompanyNorm(companyName);

            // Gather ALL loaded rows of the same company (by domain, else name).
            const affected = data.rows.filter(function (r) {
                const rd = (r.input && r.input.domain ? r.input.domain : '').toLowerCase().trim();
                if (dom && rd === dom) return true;
                if (!dom && coNorm && _pfCompanyNorm(r.input && r.input.company_name) === coNorm) return true;
                return false;
            });
            if (!affected.length) return;

            const domains = Array.from(new Set(affected.map(function (r) { return (r.input.domain || '').toLowerCase().trim(); }).filter(Boolean)));
            const names = Array.from(new Set(affected.map(function (r) { return (r.input.company_name || '').trim(); }).filter(Boolean)));

            const origLabel = btn ? btn.textContent : '';
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Re-checking…'; }
            try {
                const resp = await fetch('/api/duplicates/preflight/recheck', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ domains: domains, names: names, rows: affected.map(function (r) { return r.input; }) })
                });
                const j = await resp.json().catch(function () { return {}; });
                if (!resp.ok || !j.success) {
                    alert('Re-check failed: ' + (j.error || ('HTTP ' + resp.status)));
                    return;
                }
                // Returned rows are in the SAME order as `affected` — map by
                // position and mutate in place (affected[] are references into
                // data.rows, so the master result updates too).
                const newRows = Array.isArray(j.rows) ? j.rows : [];
                let movedToPass = 0;
                affected.forEach(function (r, k) {
                    const nr = newRows[k];
                    if (!nr) return;
                    if (r.verdict !== 'pass' && nr.verdict === 'pass') movedToPass++;
                    r.verdict = nr.verdict;
                    r.reason = nr.reason;
                    r.suggested_action = nr.suggested_action;
                    r.executive_action = nr.executive_action;
                    r.executive_severity = nr.executive_severity;
                    r.lifecycle_state = nr.lifecycle_state;
                    r.module_counts = nr.module_counts;
                    r.owners = nr.owners;
                    r.cluster_id = nr.cluster_id;
                    if (nr.input) r.input = nr.input;
                });
                data.summary = _pfRecomputeSummary(data.rows);
                renderPreflight(data);

                const upd = (j.resync && j.resync.updated) || 0;
                const co = names[0] || domains[0] || 'company';
                alert('Re-checked ' + co + ':\n• ' + upd + ' deal(s) refreshed from Zoho\n• ' + movedToPass + ' row(s) now PASS');
            } catch (err) {
                alert('Re-check error: ' + (err && err.message ? err.message : err));
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = origLabel || '↻ Re-check'; }
            }
        }

        // (exportPreflightExcel removed 2026-06-17 — the all-rows Excel report
        // button was dropped from the Preflight view; the "Download flagged
        // rows (for Head of Sales)" button covers the hand-off. The server
        // endpoint /api/duplicates/preflight/export-xlsx is still used by it.)

        async function openPushToZohoModal() {
            const data = window._preflightLastResult;
            if (!data) { alert('Run a Preflight check first.'); return; }
            const passRows = (data.rows || []).filter(r => r.verdict === 'pass');
            if (passRows.length === 0) {
                alert('No PASS rows in this run — nothing to push.');
                return;
            }
            window._preflightPushPassRows = passRows;

            // Seed the source field with a stamp the operator can edit.
            const stamp = new Date().toISOString().slice(0, 10);
            const srcEl = document.getElementById('pushZohoSource');
            if (srcEl) srcEl.value = 'Preflight Push — ' + stamp;
            const eligEl = document.getElementById('pushZohoEligibleCount');
            if (eligEl) eligEl.textContent = passRows.length.toLocaleString();
            const resultBox = document.getElementById('pushZohoResult');
            if (resultBox) { resultBox.classList.add('hidden'); resultBox.innerHTML = ''; }
            document.getElementById('pushZohoDryRun').checked = true;
            document.querySelector('input[name="pushZohoOwnerMode"][value="self"]').checked = true;
            onPushZohoOwnerModeChange();

            document.getElementById('pushZohoModal').classList.remove('hidden');

            // Lazy-load layouts + users (one fetch per modal-open is fine).
            try {
                const [layoutsRes, usersRes] = await Promise.all([
                    fetch('/api/duplicates/preflight/zoho-layouts?module=Leads'),
                    fetch('/api/duplicates/preflight/zoho-users'),
                ]);
                const layouts = layoutsRes.ok ? (await layoutsRes.json()).layouts || [] : [];
                const users = usersRes.ok ? (await usersRes.json()).users || [] : [];
                const layoutSel = document.getElementById('pushZohoLayout');
                if (layoutSel) {
                    layoutSel.innerHTML = '<option value="">Select layout…</option>' +
                        layouts.map(l => '<option value="' + escAttr(l.id) + '">' + escapeHtml(l.name) + '</option>').join('');
                }
                const customSel = document.getElementById('pushZohoOwnerCustom');
                const rrSel = document.getElementById('pushZohoOwnerRR');
                const userOpts = users.map(u => '<option value="' + escAttr(u.id) + '">' + escapeHtml(u.name + ' (' + (u.email || '—') + ')') + '</option>').join('');
                if (customSel) customSel.innerHTML = '<option value="">Select user…</option>' + userOpts;
                if (rrSel) rrSel.innerHTML = userOpts;
            } catch (e) {
                console.error('Push-to-Zoho metadata load failed:', e);
            }
        }

        function closePushZohoModal() {
            const m = document.getElementById('pushZohoModal');
            if (m) m.classList.add('hidden');
        }

        function onPushZohoOwnerModeChange() {
            const mode = (document.querySelector('input[name="pushZohoOwnerMode"]:checked') || {}).value || 'self';
            const customSel = document.getElementById('pushZohoOwnerCustom');
            const rrSel = document.getElementById('pushZohoOwnerRR');
            if (customSel) customSel.classList.toggle('hidden', mode !== 'custom');
            if (rrSel) rrSel.classList.toggle('hidden', mode !== 'round_robin');
        }

        async function runPushToZoho() {
            const rows = window._preflightPushPassRows || [];
            if (rows.length === 0) { alert('Reopen the modal — no rows in memory.'); return; }
            const layoutId = (document.getElementById('pushZohoLayout') || {}).value || '';
            if (!layoutId) { alert('Pick a Zoho Layout first.'); return; }
            const mode = (document.querySelector('input[name="pushZohoOwnerMode"]:checked') || {}).value || 'self';
            const dryRun = !!(document.getElementById('pushZohoDryRun') || {}).checked;
            const source = ((document.getElementById('pushZohoSource') || {}).value || '').trim();

            const body = {
                rows,
                layout_id: layoutId,
                owner_mode: mode,
                source,
                dry_run: dryRun,
            };
            if (mode === 'custom') {
                body.owner_id = (document.getElementById('pushZohoOwnerCustom') || {}).value || '';
                if (!body.owner_id) { alert('Pick the Zoho user to assign all rows to.'); return; }
            } else if (mode === 'round_robin') {
                const sel = document.getElementById('pushZohoOwnerRR');
                body.round_robin_user_ids = sel ? Array.from(sel.selectedOptions).map(o => o.value).filter(Boolean) : [];
                if (body.round_robin_user_ids.length === 0) { alert('Pick at least one user for round-robin.'); return; }
            }

            const btn = document.getElementById('pushZohoRunBtn');
            const orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = (dryRun ? 'Dry-running…' : 'Pushing…'); }
            const resultBox = document.getElementById('pushZohoResult');
            try {
                const res = await fetch('/api/duplicates/preflight/push-to-zoho', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
                if (resultBox) {
                    resultBox.classList.remove('hidden');
                    if (data.dry_run) {
                        resultBox.innerHTML = ''
                            + '<div class="font-semibold text-purple-800 mb-1">✓ Dry-run complete</div>'
                            + '<div>Would create ' + (data.would_create_count || 0) + ' Lead(s) on Layout ' + escapeHtml(data.layout_id || '') + '.</div>'
                            + '<div>Dropped: ' + (data.dropped_count || 0) + ' (non-PASS or no identifier).</div>'
                            + (data.sample_payload ? '<div class="mt-2 font-mono text-[10px] bg-white border rounded p-2">Sample payload:<br>' + escapeHtml(JSON.stringify(data.sample_payload, null, 2)) + '</div>' : '')
                            + '<div class="mt-2 text-amber-700">Uncheck the Dry-run box and Push again to actually create the records.</div>';
                    } else {
                        resultBox.innerHTML = ''
                            + '<div class="font-semibold text-emerald-800 mb-1">✓ Push complete</div>'
                            + '<div>Created: ' + (data.created || 0) + ' / ' + (data.attempted || 0) + '</div>'
                            + '<div>Failed: ' + (data.failed || 0) + '</div>'
                            + '<div>Dropped: ' + (data.dropped_count || 0) + ' (non-PASS or no identifier).</div>'
                            + '<div class="mt-1 text-gray-500">Audit-logged. Source: ' + escapeHtml(data.source || '') + '.</div>';
                    }
                }
            } catch (e) {
                if (resultBox) {
                    resultBox.classList.remove('hidden');
                    resultBox.innerHTML = '<div class="font-semibold text-red-700">✗ Push failed</div><div>' + escapeHtml(e.message || String(e)) + '</div>';
                }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Structured push to Zoho — four dedup-safe, dry-run-first actions.
        // Reads the full classified result rows straight off
        // window._preflightLastResult.rows (the master array). The four
        // actions mirror the server planner's pools:
        //   A1 churned-past-cool-off matched → Deal under existing Account
        //   A2 multi-contact new companies   → 1 Deal + contacts + Account
        //   A3 first N single-contact new    → Account + Deal + Contact
        //   A4 next M single-contact new     → Leads (starts after A3's slice)
        // ─────────────────────────────────────────────────────────────────

        // Map a raw preflight result row to the SPRow shape the endpoint wants.
        // verdict / cluster_id / lifecycle_state are TOP-LEVEL on each row;
        // company / domain / contact_name fall back through r.input.
        // Only verdict === "pass" rows are pushable — block/review/duplicate/
        // no-contact must never reach the push (they're the 734 rejected).
        function _pfIsPass(r) { return String(r && r.verdict || '').toLowerCase() === 'pass'; }
        function _pfToSPRow(r, idx) {
            return {
                row_index: (r.row_index != null ? r.row_index : idx),
                company: (r.input && r.input.company_name) || r.company_name || '',
                domain:  (r.input && r.input.domain) || r.domain || '',
                email:   r.email || '',
                phone:   r.phone || '',
                contact_name: r.contact_name || (r.input && r.input.contact_name) || '',
                title: r.title || (r.input && r.input.title) || '',
                verdict: r.verdict || '',
                cluster_id: (r.cluster_id != null ? r.cluster_id : null),
                matched_account_zoho_id: (r.matched_account_zoho_id || (r.input && r.input.matched_account_zoho_id) || null),
                matched_account_name: (r.matched_account_name || (r.input && r.input.matched_account_name) || null),
                lifecycle_state: (r.lifecycle_state != null ? r.lifecycle_state : null),
            };
        }

        // Client-side mirror of the planner's pool rules so the panel can show
        // live counts without a round-trip. Group by normalized company key.
        function _pfNormCompanyKey(company, domain) {
            return String(company || domain || '').trim().toLowerCase();
        }
        function _pfRowHasContact(r) {
            return !!(String(r.email || '').trim() || String(r.phone || '').trim() || String(r.contact_name || '').trim());
        }
        function _pfGroupByCompany(spRows) {
            var map = new Map();
            for (var i = 0; i < spRows.length; i++) {
                var r = spRows[i];
                var key = _pfNormCompanyKey(r.company, r.domain);
                if (!key) continue;
                var g = map.get(key);
                if (!g) { g = { key: key, rows: [] }; map.set(key, g); }
                g.rows.push(r);
            }
            return Array.from(map.values());
        }
        // --- Domain-consistency routing (mirror of preflightStructuredPush.ts
        //     routeContactsByDomainConsistency, so the badges match the server).
        var _PF_FREE_MAIL = { '#n':1,'n/a':1,'na':1,'none':1,'null':1,'unknown':1,'gmail':1,'hotmail':1,'yahoo':1,'outlook':1,'icloud':1,'aol':1,'live':1,'msn':1,'proton':1,'protonmail':1,'hotmai':1,'gmai':1,'gmail.com':1,'hotmail.com':1,'yahoo.com':1,'outlook.com':1,'icloud.com':1,'aol.com':1,'live.com':1,'msn.com':1,'protonmail.com':1,'proton.me':1 };
        function _pfRealDomainRoot(value) {
            var d = String(value || '').trim().toLowerCase();
            if (!d) return null;
            d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
            var at = d.split('@'); d = at[at.length - 1] || d;
            d = d.replace(/\.$/, '');
            if (!d || _PF_FREE_MAIL[d]) return null;
            if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
            return d;
        }
        function _pfMostCommon(vals) {
            var counts = {}, order = [], i, v;
            for (i = 0; i < vals.length; i++) { v = vals[i]; if (!v) continue; if (counts[v] == null) { order.push(v); counts[v] = 0; } counts[v]++; }
            var best = null, bestN = 0;
            for (i = 0; i < order.length; i++) { v = order[i]; if (counts[v] > bestN) { best = v; bestN = counts[v]; } }
            return best;
        }
        // Returns [{ row, route }] with route in { 'account','lead','reject' }.
        function _pfRouteContacts(spRows) {
            var groups = _pfGroupByCompany(spRows);
            var meta = {};
            for (var i = 0; i < groups.length; i++) {
                var g = groups[i];
                var domAnchor = _pfMostCommon(g.rows.map(function (r) { return _pfRealDomainRoot(r.domain); }));
                var emlAnchor = _pfMostCommon(g.rows.map(function (r) { return _pfRealDomainRoot(r.email); }));
                var anchor = domAnchor || emlAnchor;
                var verified = !!anchor && g.rows.some(function (r) { return _pfRealDomainRoot(r.email) === anchor; });
                var crm = g.rows.some(function (r) { return r.lifecycle_state === 'termination_old' || (r.matched_account_zoho_id && String(r.matched_account_zoho_id).trim()) || r.cluster_id != null; });
                meta[g.key] = { anchor: anchor, verified: verified, crm: crm };
            }
            return spRows.map(function (r) {
                var key = _pfNormCompanyKey(r.company, r.domain);
                var m = meta[key] || { anchor: null, verified: false, crm: false };
                var er = _pfRealDomainRoot(r.email);
                var hasEmail = !!String(r.email || '').trim();
                var hasIdentity = !!(String(r.company || '').trim() || _pfRealDomainRoot(r.domain));
                var route, reason;
                if (m.crm) { route = 'account'; reason = 'crm_matched_company'; }
                else if (!hasIdentity) { route = 'lead'; reason = 'no_company_identity'; }
                else if (m.verified) {
                    if (er && er === m.anchor) { route = 'account'; reason = 'email_matches_company'; }
                    else if (er) { route = 'reject'; reason = 'email_contradicts_company'; }
                    else if (!hasEmail) { route = 'account'; reason = 'phone_only_verified_company'; }
                    else { route = 'lead'; reason = 'free_mail_verified_company'; }
                } else {
                    if (er) { route = 'reject'; reason = 'corporate_email_unverifiable_company'; }
                    else { route = 'lead'; reason = 'unverifiable_company'; }
                }
                return { row: r, route: route, reason: reason };
            });
        }
        // Rubbish Data = the rejected contradictions (email domain contradicts the
        // company label, or a corporate email at an unverifiable company). Never
        // pushed — surfaced here so the operator can review/export them.
        function _pfRubbishRows(spRows) {
            var routed = _pfRouteContacts(spRows);
            var out = [];
            for (var i = 0; i < routed.length; i++) {
                if (routed[i].route !== 'reject') continue;
                var r = routed[i].row;
                out.push({
                    company: r.company || '', contact_name: r.contact_name || '',
                    email: r.email || '', phone: r.phone || '', title: r.title || '',
                    reason: routed[i].reason === 'email_contradicts_company'
                        ? 'Email domain contradicts the company label'
                        : 'Corporate email at an unverifiable company',
                });
            }
            return out;
        }
        // Export the rubbish data as CSV so the operator can review the rejects.
        function erDownloadRubbish() {
            var rows = window._pfRubbishData || [];
            if (!rows.length) { alert('No rubbish data — nothing was rejected.'); return; }
            downloadCsvRows('rubbish-data-' + new Date().toISOString().slice(0, 10) + '.csv',
                ['Company', 'Contact Name', 'Email', 'Phone', 'Title', 'Reason'],
                rows.map(function (r) { return [r.company, r.contact_name, r.email, r.phone, r.title, r.reason]; }));
        }
        // Read the head-of-sales "Deals %" knob (default 100 = all new companies
        // eligible for a deal). Kept in one place so badges + push agree.
        function _pfDealPercent() {
            var el = document.getElementById('spDealPercent');
            var v = el ? parseInt(el.value, 10) : NaN;
            if (isNaN(v)) return 100;
            return Math.min(100, Math.max(0, v));
        }
        // Returns { a1, a2, a3, a4, rejected } after routing. dealPercent splits
        // the new-company pool: that % become Deals (A2/A3), the rest are parked
        // as Leads (their contacts fold into A4).
        function _pfCountActions(spRows, dealPercent) {
            var pct = (typeof dealPercent === 'number') ? Math.min(100, Math.max(0, dealPercent)) : 100;
            var routed = _pfRouteContacts(spRows);
            var accountRows = [], a4 = 0, rejected = 0;
            for (var k = 0; k < routed.length; k++) {
                if (routed[k].route === 'account') accountRows.push(routed[k].row);
                else if (routed[k].route === 'lead') a4++;
                else rejected++;
            }
            // Row-level split: matched rows link to existing accounts (A1),
            // unmatched rows open new accounts (A2/A3). Mirrors the planner.
            var isRowExistingMatch = function (r) {
                return (r.matched_account_zoho_id && String(r.matched_account_zoho_id).trim()) ||
                       r.lifecycle_state === 'termination_old' || r.cluster_id != null;
            };
            var matched = [], newRows = [];
            for (var m = 0; m < accountRows.length; m++) {
                (isRowExistingMatch(accountRows[m]) ? matched : newRows).push(accountRows[m]);
            }
            // A1 = distinct existing accounts (by resolved id, else company key).
            var accKeys = {};
            matched.forEach(function (r) {
                var key = (r.matched_account_zoho_id && String(r.matched_account_zoho_id).trim()) || ('name:' + _pfNormCompanyKey(r.company, r.domain));
                accKeys[key] = 1;
            });
            var a1 = Object.keys(accKeys).length;
            var groups = _pfGroupByCompany(newRows);
            var isNewPass = function (g) {
                return g.rows.every(function (r) { return r.cluster_id == null; }) &&
                       g.rows.every(function (r) { return r.verdict === 'pass'; });
            };
            var contactCount = function (g) {
                return g.rows.filter(_pfRowHasContact).length;
            };
            // Deal-eligible new companies, ranked richest-first (matches the
            // server planner), then split by dealPercent: the top slice become
            // deals (A2/A3 by contact count); the rest are parked as leads.
            var eligibleGroups = [];
            for (var i = 0; i < groups.length; i++) {
                if (isNewPass(groups[i]) && contactCount(groups[i]) >= 1) eligibleGroups.push(groups[i]);
            }
            eligibleGroups.sort(function (a, b) {
                var d = contactCount(b) - contactCount(a);
                if (d !== 0) return d;
                var ai = Math.min.apply(null, a.rows.map(function (r) { return (r.row_index != null ? r.row_index : 0); }));
                var bi = Math.min.apply(null, b.rows.map(function (r) { return (r.row_index != null ? r.row_index : 0); }));
                return ai - bi;
            });
            var dealCount = Math.ceil((pct / 100) * eligibleGroups.length);
            var a2 = 0, a3 = 0, parkedLeads = 0;
            for (var i = 0; i < eligibleGroups.length; i++) {
                var g = eligibleGroups[i];
                if (i < dealCount) {
                    var cc = contactCount(g);
                    if (cc >= 2) a2++;
                    else a3++;
                } else {
                    parkedLeads += contactCount(g);
                }
            }
            return { a1: a1, a2: a2, a3: a3, a4: a4 + parkedLeads, rejected: rejected };
        }

        // Reconciliation — proves every Mawsool record has a destination.
        // Categorizes ALL loaded rows (CONTACT-level) and checks the sum:
        //   total = not-imported (block/review/duplicate/no-contact)
        //         + PASS (A1 link + A2 + A3 + A4 leads + rejected).
        // Returns an "unaccounted" count that MUST be 0.
        function _pfReconcile(rawRows) {
            var all = (rawRows || []).map(_pfToSPRow);
            var v = { block: 0, review: 0, duplicate: 0, no_contact: 0, warn: 0, pass: 0, other: 0 };
            all.forEach(function (r) {
                var vv = String(r.verdict || '').toLowerCase();
                if (v[vv] != null) v[vv]++; else if (!vv) v.other++; else v.other++;
            });
            var pass = all.filter(_pfIsPass);
            var routed = _pfRouteContacts(pass);
            var acct = [], a4 = 0, rejected = 0;
            routed.forEach(function (x) {
                if (x.route === 'account') acct.push(x.row);
                else if (x.route === 'lead') a4++;
                else rejected++;
            });
            var isMatch = function (r) {
                return (r.matched_account_zoho_id && String(r.matched_account_zoho_id).trim()) ||
                       r.lifecycle_state === 'termination_old' || r.cluster_id != null;
            };
            var a1 = 0, newRows = [];
            acct.forEach(function (r) { if (isMatch(r)) a1++; else newRows.push(r); });
            var groups = _pfGroupByCompany(newRows);
            var a2 = 0, a3 = 0;
            groups.forEach(function (g) {
                var cc = g.rows.filter(_pfRowHasContact).length;
                if (cc >= 2) a2 += cc; else if (cc === 1) a3 += 1;
            });
            var passSum = a1 + a2 + a3 + a4 + rejected;
            var notImported = v.block + v.review + v.duplicate + v.no_contact + v.warn + v.other;
            return {
                total: all.length, pass: pass.length, notImported: notImported, verdicts: v,
                a1: a1, a2: a2, a3: a3, a4: a4, rejected: rejected,
                passSum: passSum,
                unaccounted_pass: pass.length - passSum,
                unaccounted_total: all.length - (notImported + passSum),
            };
        }

        // Renders the reconciliation into #spReconcileResult.
        function erReconcile() {
            var data = window._preflightLastResult;
            var box = document.getElementById('spReconcileResult');
            if (!data || !Array.isArray(data.rows)) { alert('Run a Preflight check first.'); return; }
            var r = _pfReconcile(data.rows);
            var ok = (r.unaccounted_total === 0 && r.unaccounted_pass === 0);
            var vv = r.verdicts;
            if (box) {
                box.classList.remove('hidden');
                box.innerHTML = ''
                    + '<div class="font-semibold ' + (ok ? 'text-emerald-800' : 'text-red-700') + ' mb-1">'
                        + (ok ? '✓ Every record accounted for' : '✗ ' + r.unaccounted_total + ' record(s) UNACCOUNTED') + '</div>'
                    + '<div>Total loaded: <strong>' + r.total + '</strong></div>'
                    + '<div class="mt-1 text-gray-700">Not imported (' + r.notImported + '): '
                        + 'duplicate ' + vv.duplicate + ' · block ' + vv.block + ' · review ' + vv.review + ' · no-contact ' + vv.no_contact + (vv.warn ? ' · warn ' + vv.warn : '') + (vv.other ? ' · other ' + vv.other : '') + '</div>'
                    + '<div class="mt-1 text-gray-700">PASS (' + r.pass + '): A1 link ' + r.a1 + ' · A2 ' + r.a2 + ' · A3 ' + r.a3 + ' · A4 leads ' + r.a4 + ' · rejected ' + r.rejected + ' = <strong>' + r.passSum + '</strong>'
                        + (r.unaccounted_pass ? ' <span class="text-red-700">(' + r.unaccounted_pass + ' unclassified!)</span>' : ' ✓') + '</div>'
                    + '<div class="mt-1 ' + (ok ? 'text-emerald-700' : 'text-red-700') + '">' + r.notImported + ' + ' + r.passSum + ' = ' + (r.notImported + r.passSum) + ' / ' + r.total + '</div>';
            }
        }

        // Refresh the four count badges + reveal the panel after a Preflight run.
        function _pfRefreshStructuredPushCounts(rawRows) {
            var panel = document.getElementById('structuredPushPanel');
            if (panel) panel.classList.remove('hidden');
            var spRows = (rawRows || []).map(_pfToSPRow).filter(_pfIsPass);
            var c = _pfCountActions(spRows, _pfDealPercent());
            var set = function (id, n) { var el = document.getElementById(id); if (el) el.textContent = String(n); };
            set('spCount-1', c.a1);
            set('spCount-2', c.a2);
            set('spCount-3', c.a3); // single-contact verified-account companies
            set('spCount-4', c.a4); // lead-routed contacts
            // Rubbish Data — rejected contradictions, surfaced + downloadable.
            var rubbish = _pfRubbishRows(spRows);
            window._pfRubbishData = rubbish;
            var rej = document.getElementById('spRejectedNote');
            if (rej) rej.textContent = rubbish.length
                ? ('🗑 Rubbish Data: ' + rubbish.length + ' contact(s) rejected (email domain contradicts the company, or corporate email at an unverifiable company) — NOT pushed.')
                : '';
            var dlBtn = document.getElementById('spRubbishDownloadBtn');
            if (dlBtn) dlBtn.classList.toggle('hidden', rubbish.length === 0);
        }

        // Backfill Title on already-pushed Leads: matches each loaded row to a
        // Lead BY EMAIL and updates its Title. Requires the TITLED Excel loaded
        // (rows must carry a title). Dry-run by default.
        async function erBackfillTitles() {
            var data = window._preflightLastResult;
            if (!data || !Array.isArray(data.rows)) { alert('Load the titled Excel and run a Preflight check first.'); return; }
            var rows = data.rows.map(_pfToSPRow);
            var withTitle = rows.filter(function (r) { return String(r.title || '').trim() && (String(r.email || '').trim() || String(r.phone || '').trim() || String(r.contact_name || '').trim()); }).length;
            if (withTitle === 0) { alert('No rows with a Title (plus an email, phone, or name to match on). Load the Excel that has the Title column, then run Preflight.'); return; }
            var dry = !!(document.getElementById('spBackfillDry') || {}).checked;
            var count = parseInt((document.getElementById('spBackfillNum') || {}).value || '0', 10) || 0;
            var offset = parseInt((document.getElementById('spBackfillOff') || {}).value || '0', 10) || 0;
            var btn = document.getElementById('spBackfillBtn');
            var box = document.getElementById('spBackfillResult');
            var orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = dry ? 'Checking…' : 'Backfilling…'; }
            try {
                var res = await fetch('/api/duplicates/preflight/backfill-titles', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows: rows, module: 'Leads', dry_run: dry, count: count, offset: offset }),
                });
                var resp = await res.json();
                if (!res.ok) throw new Error(resp.error || ('HTTP ' + res.status));
                if (box) {
                    box.classList.remove('hidden');
                    if (resp.dry_run) {
                        box.innerHTML = '<div class="font-semibold text-amber-800">✓ Dry-run complete</div>'
                            + '<div>' + (resp.candidates || 0) + ' rows checked · <span class="text-emerald-700 font-semibold">' + (resp.would_update || 0) + '</span> matched (' + (resp.matched_by_phone || 0) + ' by phone, ' + (resp.matched_by_name || 0) + ' by name) · ' + (resp.not_found || 0) + ' not found.</div>'
                            + '<div class="mt-1 text-amber-700">Uncheck Dry-run and click again to apply. Advance <em>from</em> for the next slice.</div>';
                    } else {
                        box.innerHTML = '<div class="font-semibold text-emerald-800">✓ Backfill complete</div>'
                            + '<div>Updated: ' + (resp.updated || 0) + ' (' + (resp.matched_by_phone || 0) + ' by phone, ' + (resp.matched_by_name || 0) + ' by name) · Failed: ' + (resp.failed || 0) + ' · Not found: ' + (resp.not_found || 0) + '</div>'
                            + ((resp.error_sample && resp.error_sample.length) ? '<div class="text-red-700 mt-1">' + resp.error_sample.map(function (e) { return escapeHtml(e.code || '') + ' — ' + escapeHtml(e.message || ''); }).join('<br>') + '</div>' : '');
                        var offEl = document.getElementById('spBackfillOff');
                        if (offEl && count > 0) offEl.value = String(offset + count);
                    }
                }
            } catch (e) {
                if (box) { box.classList.remove('hidden'); box.innerHTML = '<div class="text-red-700">Backfill failed: ' + escapeHtml(e.message || String(e)) + '</div>'; }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        // Read-only diagnostic: pull the exact required fields + api_names for
        // Deals and Leads from the live CRM, so we can confirm the push fills
        // them under the right api_names (no guessing).
        async function erCheckZohoFields() {
            var btn = document.getElementById('spFieldsBtn');
            var box = document.getElementById('spRejResult');
            var orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = 'Checking…'; }
            try {
                var res = await fetch('/api/duplicates/preflight/zoho-required-fields');
                var resp = await res.json();
                if (!res.ok) throw new Error(resp.error || ('HTTP ' + res.status));
                var fieldRows = function (list) {
                    return (list || []).map(function (f) {
                        return '<tr class="border-b border-gray-100"><td class="pr-2 font-mono">' + escapeHtml(f.api_name) + '</td><td class="pr-2">' + escapeHtml(f.label || '') + '</td><td class="text-gray-500">' + escapeHtml(f.type || '') + (f.required ? ' · <span class="text-rose-600">required</span>' : '') + '</td></tr>';
                    }).join('');
                };
                var section = function (title, mod) {
                    return '<div class="mt-1 font-semibold text-gray-800">' + title + ' — push fills these:</div>'
                        + '<table class="text-[11px] w-full mb-1">' + fieldRows(mod.push_targets) + '</table>'
                        + '<details><summary class="cursor-pointer text-indigo-700">All required ' + title + ' fields (' + (mod.required || []).length + ')</summary><table class="text-[11px] w-full">' + fieldRows(mod.required) + '</table></details>';
                };
                if (box) {
                    box.classList.remove('hidden');
                    box.innerHTML = '<div class="font-semibold text-indigo-800 mb-1">Zoho required fields (live)</div>'
                        + section('Deals', resp.deals || {}) + section('Leads', resp.leads || {});
                }
            } catch (e) {
                if (box) { box.classList.remove('hidden'); box.innerHTML = '<div class="text-red-700">Field check failed: ' + escapeHtml(e.message || String(e)) + '</div>'; }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        // Layer 1: resolve every contact's existing Zoho Account (email domain →
        // company domain → name) so matched people LINK to what we already have
        // instead of being rejected or duplicated. Merges the matched account
        // ids back into the rows, refreshes the badges, and shows the summary.
        async function erResolveExistingAccounts() {
            var data = window._preflightLastResult;
            if (!data || !Array.isArray(data.rows)) { alert('Run a Preflight check first.'); return; }
            var btn = document.getElementById('spResolveBtn');
            var box = document.getElementById('spRejResult');
            var orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = 'Resolving…'; }
            try {
                var rows = data.rows.map(_pfToSPRow).filter(_pfIsPass);
                var res = await fetch('/api/duplicates/preflight/resolve-existing-accounts', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows: rows }),
                });
                var resp = await res.json();
                if (!res.ok) throw new Error(resp.error || ('HTTP ' + res.status));
                // Merge matched account ids back into the source rows (by row_index)
                // so the badges AND the subsequent push both use them.
                var byIdx = {};
                (resp.matches || []).forEach(function (mm) { byIdx[mm.row_index] = mm; });
                data.rows.forEach(function (r, i) {
                    var idx = (r.row_index != null ? r.row_index : i);
                    if (byIdx[idx]) {
                        r.matched_account_zoho_id = byIdx[idx].matched_account_zoho_id;
                        r.matched_account_name = byIdx[idx].matched_account_name || '';
                        if (r.input) {
                            r.input.matched_account_zoho_id = byIdx[idx].matched_account_zoho_id;
                            r.input.matched_account_name = byIdx[idx].matched_account_name || '';
                        }
                    }
                });
                _pfRefreshStructuredPushCounts(data.rows);
                window._pfResolved = true;
                var v = resp.by_via || {};
                // Sample of the human-readable account links (name ← contact).
                var linkSample = (resp.matches || []).slice(0, 40).map(function (mm) {
                    var src = data.rows[mm.row_index] || {};
                    var who = (src.contact_name || (src.input && src.input.contact_name) || src.email || '(contact)');
                    return '<tr class="border-b border-gray-100"><td class="pr-2 text-emerald-700">' + escapeHtml(mm.matched_account_name || ('acct ' + mm.matched_account_zoho_id)) + '</td><td class="text-gray-500">← ' + escapeHtml(String(who)) + ' <span class="text-gray-400">(' + escapeHtml(mm.matched_via || '') + ')</span></td></tr>';
                }).join('');
                if (box) {
                    box.classList.remove('hidden');
                    box.innerHTML = ''
                        + '<div class="font-semibold text-emerald-800 mb-1">✓ Resolved existing accounts</div>'
                        + '<div><span class="text-emerald-700 font-semibold">' + (resp.matched || 0) + '</span> of ' + (resp.total || 0) + ' contacts matched an existing account → they LINK (Action 1), never rejected or duplicated.</div>'
                        + '<div class="text-gray-600 mt-1">Matched via — email domain: ' + (v.email_domain || 0) + ' · company domain: ' + (v.row_domain || 0) + ' · company name: ' + (v.company_name || 0) + '</div>'
                        + (linkSample ? '<details class="mt-1"><summary class="cursor-pointer text-emerald-700 font-medium">Show account links</summary><table class="text-[11px] w-full mt-1">' + linkSample + '</table></details>' : '')
                        + '<div class="text-gray-500 mt-1">' + (resp.unmatched || 0) + ' unmatched → new account / lead / reject per the rules. Badges above are updated.</div>';
                }
            } catch (e) {
                if (box) { box.classList.remove('hidden'); box.innerHTML = '<div class="text-red-700">Resolve failed: ' + escapeHtml(e.message || String(e)) + '</div>'; }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        // Re-count the four badges when the Deals % split changes (live).
        function erRecountSplit() {
            var data = window._preflightLastResult;
            if (data && Array.isArray(data.rows)) _pfRefreshStructuredPushCounts(data.rows);
        }

        // Action handler — wired via data-on-click="erStructuredPush" data-args="[N]".
        async function erStructuredPush(action) {
            action = Number(action);
            var data = window._preflightLastResult;
            if (!data || !Array.isArray(data.rows)) { alert('Run a Preflight check first.'); return; }
            var rows = data.rows.map(_pfToSPRow).filter(_pfIsPass);

            // Every action pushes in operator-sized slices (size = count,
            // from = offset) so a big batch doesn't exceed the gateway timeout.
            var g = function (id) { return parseInt((document.getElementById(id) || {}).value || '0', 10) || 0; };
            var count = g('spNum-' + action);
            var offset = g('spOff-' + action);

            var dryRun = !!(document.getElementById('spDry-' + action) || {}).checked;
            var source = 'Preflight Structured Push — ' + new Date().toISOString().slice(0, 10);

            var btn = document.getElementById('spBtn-' + action);
            var orig = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = (dryRun ? 'Dry-running…' : 'Pushing…'); }
            var resultBox = document.getElementById('spResult-' + action);

            try {
                var res = await fetch('/api/duplicates/preflight/structured-push', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: action,
                        rows: rows,
                        count: count,
                        offset: offset,
                        deal_percent: _pfDealPercent(),
                        dry_run: dryRun,
                        owner_mode: 'self',
                        source: source,
                    }),
                });
                var resp = await res.json();
                if (!res.ok) throw new Error(resp.error || ('HTTP ' + res.status));
                if (resultBox) {
                    resultBox.classList.remove('hidden');
                    if (resp.dry_run) {
                        var w = resp.would || {};
                        var line = (action === 4)
                            ? ('Would create: ' + (w.leads || 0) + ' leads')
                            : ('Would create: ' + (w.accounts || 0) + ' accounts / ' + (w.contacts || 0) + ' contacts / ' + (w.deals || 0) + ' deals');
                        // Diagnostic: full list of exactly what would be pushed,
                        // so the count (e.g. "why 99?") can be verified by eye.
                        var eligibleHtml = '';
                        var ecos = resp.eligible_companies || [];
                        var eleads = resp.eligible_leads || [];
                        if (action === 4 && eleads.length) {
                            var lrows = eleads.map(function (r, i) {
                                return '<tr class="border-b border-gray-100">'
                                    + '<td class="pr-2 text-gray-400">' + (i + 1) + '</td>'
                                    + '<td class="pr-2">' + escapeHtml(r.name || '(no name)') + '</td>'
                                    + '<td class="pr-2 text-gray-600">' + escapeHtml(r.company || '') + '</td>'
                                    + '<td class="pr-2 text-gray-500">' + escapeHtml(r.email || r.phone || '') + '</td>'
                                    + '</tr>';
                            }).join('');
                            eligibleHtml = '<details class="mt-2"><summary class="cursor-pointer text-purple-700 font-medium">Show all ' + eleads.length + ' leads</summary>'
                                + '<div class="mt-1 max-h-64 overflow-y-auto bg-white border rounded p-2"><table class="text-[11px] w-full">' + lrows + '</table></div></details>';
                        } else if (ecos.length) {
                            var crows = ecos.map(function (co, i) {
                                var flag = (action === 1)
                                    ? (co.account_resolved
                                        ? '<span class="text-emerald-600">● account found</span>'
                                        : '<span class="text-amber-600">○ no account (skipped)</span>')
                                    : '';
                                return '<tr class="border-b border-gray-100">'
                                    + '<td class="pr-2 text-gray-400 align-top">' + (i + 1) + '</td>'
                                    + '<td class="pr-2 align-top">' + escapeHtml(co.company || '') + '</td>'
                                    + '<td class="pr-2 text-gray-500 align-top">' + escapeHtml(co.domain || '') + '</td>'
                                    + '<td class="pr-2 text-gray-600 align-top">' + (co.contacts || 0) + ' contact' + ((co.contacts === 1) ? '' : 's') + '</td>'
                                    + '<td class="align-top">' + flag + '</td>'
                                    + '</tr>';
                            }).join('');
                            eligibleHtml = '<details class="mt-2"><summary class="cursor-pointer text-purple-700 font-medium">Show all ' + ecos.length + ' companies</summary>'
                                + '<div class="mt-1 max-h-64 overflow-y-auto bg-white border rounded p-2"><table class="text-[11px] w-full">' + crows + '</table></div></details>';
                        }
                        resultBox.innerHTML = ''
                            + '<div class="font-semibold text-purple-800 mb-1">✓ Dry-run complete</div>'
                            + '<div>' + line + '</div>'
                            + '<div>Skipped: ' + (resp.skipped_count || 0)
                                + (resp.no_matched_account_count ? ' (' + resp.no_matched_account_count + ' churned with no existing Account — won\'t be pushed)' : '')
                                + '</div>'
                            + (resp.active_link_only_count ? '<div class="text-indigo-700">' + resp.active_link_only_count + ' active-account link(s) → contact added, no re-engagement Deal (only churned accounts get a Deal).</div>' : '')
                            + (resp.possible_existing_client_count ? '<div class="text-amber-700 font-medium">⚠ ' + resp.possible_existing_client_count + ' possible existing client(s) — resemble an account we already have; each is tagged in its Description "verify before contacting."</div>' : '')
                            + (action === 1 ? '<div class="text-gray-500 text-[11px]">On push, contacts already in Zoho (by email) are reused, not duplicated.</div>' : '')
                            + eligibleHtml
                            + (resp.sample_payload ? '<div class="mt-2 font-mono text-[10px] bg-white border rounded p-2 overflow-x-auto">Sample payload:<br>' + escapeHtml(JSON.stringify(resp.sample_payload, null, 2)) + '</div>' : '')
                            + '<div class="mt-2 text-amber-700">Uncheck the Dry-run box and Push again to actually create the records.</div>';
                    } else {
                        var cr = resp.created || {};
                        var fl = resp.failed || {};
                        var crLine = (action === 4)
                            ? ('Created: ' + (cr.leads || 0) + ' leads')
                            : ('Created: ' + (cr.accounts || 0) + ' accounts / ' + (cr.contacts || 0) + ' contacts / ' + (cr.deals || 0) + ' deals');
                        var flLine = (action === 4)
                            ? ('Failed: ' + (fl.leads || 0))
                            : ('Failed: ' + ((fl.accounts || 0) + (fl.contacts || 0) + (fl.deals || 0)));
                        // Auto-advance THIS action's offset by the SLICE SIZE
                        // (count), not by records created — the eligible list is a
                        // stable window, so moving by count steps cleanly to the
                        // next slice and never re-creates an item already pushed
                        // (even when some rows in the slice were skipped/failed).
                        var nextOffset = offset + count;
                        if (count > 0) {
                            var offEl = document.getElementById('spOff-' + action);
                            if (offEl) offEl.value = String(nextOffset);
                        }
                        resultBox.innerHTML = ''
                            + '<div class="font-semibold text-emerald-800 mb-1">✓ Push complete</div>'
                            + '<div>' + crLine + '</div>'
                            + (resp.leads_skipped_existing ? '<div class="text-indigo-700">Skipped ' + resp.leads_skipped_existing + ' lead(s) already in Zoho — not duplicated.</div>' : '')
                            + (resp.reused_accounts ? '<div class="text-indigo-700">Reused ' + resp.reused_accounts + ' existing account(s) — not duplicated.</div>' : '')
                            + (resp.existing_contacts_linked ? '<div class="text-indigo-700">Reused ' + resp.existing_contacts_linked + ' existing contact(s) — not duplicated.</div>' : '')
                            + (resp.live_clients_rejected ? '<div class="text-rose-700">🚫 ' + resp.live_clients_rejected + ' contact(s) REJECTED — company is a live client (active deal, not churned after its renewal). Not pushed.</div>' : '')
                            + (resp.contacts_existing_as_lead ? '<div class="text-rose-700">🚫 ' + resp.contacts_existing_as_lead + ' contact(s) REJECTED — already exist as a Lead in the CRM. Not pushed.</div>' : '')
                            + (resp.existing_deals_skipped ? '<div class="text-indigo-700">Skipped ' + resp.existing_deals_skipped + ' deal(s) already open under the account — not duplicated.</div>' : '')
                            + (resp.possible_existing_client_count ? '<div class="text-amber-700">⚠ ' + resp.possible_existing_client_count + ' flagged as possible existing client(s) — see each record\'s Description.</div>' : '')
                            + '<div>' + flLine + '</div>'
                            + ((resp.error_sample && resp.error_sample.length) ? '<div class="mt-1 text-red-700">Failure reason(s):<ul class="list-disc ms-5">' + resp.error_sample.map(function (e) { return '<li>' + escapeHtml(e.stage) + ': ' + escapeHtml(e.code || '') + ' — ' + escapeHtml(e.message || '') + (e.field ? ' <strong>[field: ' + escapeHtml(e.field) + ']</strong>' : '') + '</li>'; }).join('') + '</ul></div>' : '')
                            + '<div>Skipped: ' + (resp.skipped_count || 0) + '</div>'
                            + (count > 0 ? '<div class="mt-1 text-purple-700">Next batch starts at offset ' + nextOffset + '. Push again for the next ' + count + '.</div>' : '')
                            + '<div class="mt-1 text-gray-500">Audit-logged. Source: ' + escapeHtml(source) + '.</div>';
                    }
                }
            } catch (e) {
                if (resultBox) {
                    resultBox.classList.remove('hidden');
                    resultBox.innerHTML = '<div class="font-semibold text-red-700">✗ Push failed</div><div>' + escapeHtml(e.message || String(e)) + '</div>';
                }
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = orig; }
            }
        }

        // Cache for the operator's display name — used in the email signature
        // so a Preflight briefing doesn't go out signed by a previous user.
        // Best-effort fetch on first use; falls through to "[Your name]"
        // placeholder when /api/auth/me is unavailable.
        window._preflightAuthorCache = null;
        async function _resolvePreflightAuthorName() {
            if (window._preflightAuthorCache !== null) return window._preflightAuthorCache;
            try {
                const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
                if (r.ok) {
                    const j = await r.json();
                    if (j && j.authenticated && j.user) {
                        const u = j.user;
                        const name =
                            (u.first_name && (u.first_name + (u.last_name ? ' ' + u.last_name : ''))) ||
                            u.name || u.display_name || u.email || null;
                        window._preflightAuthorCache = name ? String(name).trim() : '';
                        return window._preflightAuthorCache;
                    }
                }
            } catch (_) { /* fall through */ }
            window._preflightAuthorCache = '';
            return '';
        }

        async function copyPreflightEmailBody() {
            const data = window._preflightLastResult;
            if (!data) { alert('Run a Preflight check first.'); return; }
            const s = data.summary || {};
            const actionable = (s.block || 0) + (s.review || 0) + (s.warn || 0) + (s.duplicate || 0) + (s.no_contact || 0);
            const examined = data.examined || 0;
            // Use the result's own pct_actionable when present (.1 precision
            // from the backend), else recompute the same way.
            const pctAct = data.pct_actionable != null
                ? data.pct_actionable
                : (examined > 0 ? Math.round(actionable / examined * 1000) / 10 : 0);
            const reasons = (Array.isArray(data.top_reasons) ? data.top_reasons : []).slice(0, 5);
            const bullet = reasons.length === 0
                ? '  (no actionable matches in this batch)'
                : reasons.map(r => '  • ' + r.label + ' — ' + r.count + ' (' + r.pct + '%)').join('\n');
            const stamp = data.generated_at
                ? data.generated_at.slice(0, 10)
                : new Date().toISOString().slice(0, 10);
            // The do-not-pursue (BLOCK) total splits into existing active clients
            // vs protected / do-not-contact accounts — the summary lumps both into
            // `block`, so the protected count is read from the top-reasons list.
            const allReasons = Array.isArray(data.top_reasons) ? data.top_reasons : [];
            const protectedCount = ((allReasons.find(function (r) { return /protected/i.test(r.label || ''); }) || {}).count) || 0;
            const existingCount = Math.max(0, (s.block || 0) - protectedCount);
            // Body matches the agreed launch format (Ahmad 2026-06-26): a title
            // line, intro, headline numbers that tie out to the batch total, top
            // reasons, next steps. Blank lines are KEPT (no filter) for readability.
            const lines = [
                'Preflight check — ' + examined.toLocaleString() + ' records · ' + actionable.toLocaleString() + ' flagged (' + pctAct + '%) — ' + stamp,
                'I ran a pre-import duplicate check on a batch of ' + examined.toLocaleString() + ' records before handing the list to the Sales floor. Summary below.',
                '',
                'Headline numbers:',
                '  • Rejected (would create a duplicate or hit an existing/protected account): ' + actionable.toLocaleString() + ' contacts (' + pctAct + '%)',
                '  • Of those: ' + (s.block || 0) + ' do-not-pursue (' + existingCount + ' active clients + ' + protectedCount + ' protected) · ' + (s.review || 0) + ' to review (churn cool-off / name-match) · ' + (s.warn || 0) + ' past cool-off · ' + (s.duplicate || 0) + ' already-in-CRM duplicates · ' + (s.no_contact || 0) + ' unreachable',
                '  • PASS (Safe to import): ' + (s.pass || 0).toLocaleString() + ' contacts',
                '',
                'Top reasons:',
                bullet,
                'Full per-row breakdown (domain, company, existing owner, recommended action) is in the attached Preflight Excel report.',
                '',
                'Recommended next steps:',
                '  • Drop the BLOCK rows; active or protected accounts; route the relationship through Customer Success.',
                '  • Hold the REVIEW rows until CS confirms.',
                '  • Re-assign the DUPLICATE rows to the existing owner instead of creating a new lead.',
                '  • Push only the PASS rows (' + (s.pass || 0).toLocaleString() + '); load them into Zoho on the right Layout from the same tab.',
                '',
                'Generated ' + stamp + ' from the Preflight Check tab in WalaPlus QMS.',
            ];
            const body = lines.join('\n');
            const ok = (txt) => {
                try {
                    navigator.clipboard.writeText(txt);
                    const btn = document.getElementById('preflightCopyEmailBtn');
                    if (btn) {
                        const o = btn.innerHTML;
                        btn.innerHTML = '✓ Copied';
                        setTimeout(() => { btn.innerHTML = o; }, 1800);
                    }
                    return true;
                } catch { return false; }
            };
            if (!ok(body)) {
                // Fallback: select-to-copy
                const ta = document.createElement('textarea');
                ta.value = body;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch {}
                document.body.removeChild(ta);
                alert('Email body copied — paste into your mail client.');
            }
        }

        function escapeHtml(s) {
            if (s === null || s === undefined) return '';
            const div = document.createElement('div');
            div.textContent = String(s);
            return div.innerHTML;
        }
        function escAttr(s) {
            if (s === null || s === undefined) return '';
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function formatDate(d) {
            if (!d) return '-';
            try { return _fd(d, { year: 'numeric', month: 'short', day: 'numeric' }); } catch { return '-'; }
        }

        function formatCurrency(v) {
            if (!v || v === 0) return 'SAR ' + _fn(0);
            return 'SAR ' + _fn(Number(v));
        }

        function getConfidenceLevel(score) {
            if (score >= 90) return 'high';
            if (score >= 60) return 'medium';
            return 'low';
        }

        let filterOptionsLoaded = false;

        function toggleFilterPanel() {
            const body = document.getElementById('filterPanelBody');
            const chevron = document.getElementById('filterChevron');
            body.classList.toggle('hidden');
            chevron.style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
            if (!filterOptionsLoaded) loadFilterOptions();
        }

        async function loadFilterOptions() {
            try {
                const res = await fetch('/api/duplicates/filters/options');
                const data = await res.json();
                filterOptionsLoaded = true;

                const ownerSelect = document.getElementById('filterOwner');
                ownerSelect.innerHTML = (data.owners || []).map(o => `<option value="${escAttr(o)}">${escapeHtml(o)}</option>`).join('');

                const layoutSelect = document.getElementById('filterLayout');
                layoutSelect.innerHTML = (data.layouts || []).map(l => `<option value="${escAttr(l)}">${escapeHtml(l)}</option>`).join('');

                const pipelineSelect = document.getElementById('filterPipeline');
                pipelineSelect.innerHTML = (data.pipelines || []).map(p => `<option value="${escAttr(p)}">${escapeHtml(p)}</option>`).join('');

                const stageSelect = document.getElementById('filterStage');
                stageSelect.innerHTML = (data.stages || []).map(s => `<option value="${escAttr(s)}">${escapeHtml(s)}</option>`).join('');
            } catch (e) {
                console.error('Error loading filter options:', e);
            }
        }

        function getSelectedValues(selectId) {
            const sel = document.getElementById(selectId);
            return Array.from(sel.selectedOptions).map(o => o.value);
        }

        // ─── Advanced Filters — shared client-side spec & matcher ────────────
        // Tabs whose loaders don't already forward filters to the backend
        // (CS Lifecycle, CS Pipeline Overlap, Cross-Module, Owner
        // Accountability, Account Hints) apply the filter in-renderer using
        // the spec returned here. The record-tab loader still builds its
        // server-side query via buildFilterParams() — both paths read the
        // same panel controls so the operator sees one consistent state.
        function getAdvancedFilterSpec() {
            // 2026-06-08 ROOT FIX — module/layout/pipeline/stage were on the
            // form UI since day one but never made it into the spec, so the
            // matcher silently ignored them and operators saw "no effect"
            // when they picked Layout=WalaPlus or Stage=Closed-Lost in any
            // tab. Adding them here + the matching branch in
            // rowMatchesAdvancedFilter below closes the bug for every
            // client-side-filtered tab in one place (Cross-Module, CS
            // Overlap, CS Lifecycle, Account Hints, Owners, Domain
            // Clusters — they all read this spec).
            return {
                owners:     getSelectedValues('filterOwner').map(s => String(s || '').toLowerCase()),
                modules:    getSelectedValues('filterModule').map(s => String(s || '').toLowerCase()),
                layouts:    getSelectedValues('filterLayout').map(s => String(s || '').toLowerCase()),
                pipelines:  getSelectedValues('filterPipeline').map(s => String(s || '').toLowerCase()),
                stages:     getSelectedValues('filterStage').map(s => String(s || '').toLowerCase()),
                domain:     (document.getElementById('filterDomain').value || '').toLowerCase().trim(),
                confidence: document.getElementById('filterConfidence').value || '',
                dateFrom:   document.getElementById('filterDateFrom').value || '',
                dateTo:     document.getElementById('filterDateTo').value || '',
                // Marketplace / Corporate segment — chip toggle at top of page
                // and the mirror dropdown in Advanced Filters both write to
                // #filterSegment. 'all' (default) means "no constraint".
                segment:    (document.getElementById('filterSegment')?.value || 'all'),
            };
        }

        // 2026-06-08 — Field-name fallback lists for the four multi-select
        // dimensions added below. Each tab's row shape uses different
        // field names (modules_present[] on cross-module vs. record_type
        // on owners, layout on clusters vs. layout_name on CS Lifecycle,
        // pipeline_lifecycle_state on CS Overlap vs. plain stage on
        // Deals). Rather than make every renderer specify exact fields
        // (which is what made the previous version silently no-op when a
        // mapping was missing), we try a list of likely field names per
        // dimension and use the first one that's actually present on
        // the row. If NONE of the fallback fields exist on the row, the
        // dimension is skipped for that row (don't filter to zero) — so
        // a Layout filter doesn't accidentally hide an Owners-tab row
        // that genuinely has no layout concept.
        const _ADV_FILTER_FALLBACKS = {
            module:   ['record_type', 'module', 'Module', 'module_name'],
            layout:   ['layout', 'Layout', 'layout_name', 'Layout_Name', 'pipeline_layout', 'pipeline_layout_name'],
            pipeline: ['pipeline', 'Pipeline', 'pipeline_name', 'Pipeline_Name'],
            stage:    ['stage', 'Stage', 'stage_name', 'Stage_Name', 'pipeline_lifecycle_state', 'lifecycle_state', 'lifecycle_phase'],
        };

        // For a single dimension, return the row's value across explicit
        // mapping field + every fallback name. Used to handle rows whose
        // module is in an array (cross-module's modules_present[]).
        function _advFilterRowValues(row, mappingField, fallbackKey) {
            const out = [];
            const push = (raw) => {
                if (raw == null) return;
                if (Array.isArray(raw)) {
                    for (const x of raw) if (x != null) out.push(String(x).toLowerCase());
                } else {
                    out.push(String(raw).toLowerCase());
                }
            };
            if (mappingField && row[mappingField] !== undefined) push(row[mappingField]);
            for (const f of (_ADV_FILTER_FALLBACKS[fallbackKey] || [])) {
                if (row[f] !== undefined) push(row[f]);
            }
            return out;
        }

        // Generic multi-select dimension check. Selected values are
        // lower-cased; we accept either an exact equality OR substring
        // hit, because some Zoho fields carry "Done Q4-2025 / Paid" or
        // similar composites that the operator picks the leaf of.
        function _advFilterMatchMulti(selected, rowValues) {
            if (!selected || !selected.length) return true;       // no filter on this dim
            if (!rowValues || !rowValues.length) return true;     // row has no concept of this dim → skip
            return rowValues.some(v => selected.some(sel => sel && (v === sel || v.includes(sel))));
        }

        // mapping: {
        //   ownerField?, domainField?, dateField?|dateFields?[],
        //   confidenceField?,
        //   moduleField?, layoutField?, pipelineField?, stageField?
        // } — names on the row to check.
        // Returns true if the row should survive the filter. Missing
        // mappings short-circuit that dimension as "matches" so a tab can
        // opt-out of any dim that doesn't apply (e.g. Owners tab has no
        // domain field). For the four new multi-select dimensions
        // (module/layout/pipeline/stage) we additionally try a small
        // list of common field names so most tabs Just Work without
        // touching the renderer's mapping.
        function rowMatchesAdvancedFilter(row, mapping, spec) {
            const s = spec || getAdvancedFilterSpec();
            // Owner — case-insensitive substring against any selected name.
            if (s.owners && s.owners.length > 0 && mapping.ownerField) {
                const v = String(row[mapping.ownerField] || '').toLowerCase();
                if (!s.owners.some(o => o && v.includes(o))) return false;
            }
            // Module — multi-select. Matches against record_type / module
            // by default (and any explicit mapping.moduleField on top).
            if (s.modules && s.modules.length > 0) {
                const vals = _advFilterRowValues(row, mapping.moduleField, 'module');
                if (!_advFilterMatchMulti(s.modules, vals)) return false;
            }
            // Layout — multi-select. Matches against layout / layout_name etc.
            if (s.layouts && s.layouts.length > 0) {
                const vals = _advFilterRowValues(row, mapping.layoutField, 'layout');
                if (!_advFilterMatchMulti(s.layouts, vals)) return false;
            }
            // Marketplace / Corporate segment — uses the same layout-field
            // signal as the multi-select Layout above, but binary: rows
            // are "marketplace" when their layout matches the merchant
            // layouts (Marketplace / Partner Accounts), "corporate" for
            // everything else INCLUDING rows with no layout (legacy data
            // shouldn't get hidden by the binary). Mirrors the server-side
            // buildSegmentPredicate exactly.
            if (s.segment && s.segment !== 'all') {
                const vals = _advFilterRowValues(row, mapping.layoutField, 'layout');
                const isMarketplace = vals.some(v =>
                    v === 'marketplace' || v === 'partner accounts'
                );
                if (s.segment === 'marketplace' && !isMarketplace) return false;
                if (s.segment === 'corporate' && isMarketplace) return false;
            }
            // Pipeline — multi-select.
            if (s.pipelines && s.pipelines.length > 0) {
                const vals = _advFilterRowValues(row, mapping.pipelineField, 'pipeline');
                if (!_advFilterMatchMulti(s.pipelines, vals)) return false;
            }
            // Stage — multi-select.
            if (s.stages && s.stages.length > 0) {
                const vals = _advFilterRowValues(row, mapping.stageField, 'stage');
                if (!_advFilterMatchMulti(s.stages, vals)) return false;
            }
            // Domain — case-insensitive substring (so 'acme' matches both
            // acme.com and shop.acme.com).
            if (s.domain && mapping.domainField) {
                const v = String(row[mapping.domainField] || '').toLowerCase();
                if (!v.includes(s.domain)) return false;
            }
            // Confidence dropdown maps to score ranges: high ≥80, medium
            // 60–79, low <60. Only enforced if the row has a numeric
            // confidence_score under mapping.confidenceField.
            if (s.confidence && mapping.confidenceField) {
                const score = Number(row[mapping.confidenceField] || 0);
                if (s.confidence === 'high'   && score <  80) return false;
                if (s.confidence === 'medium' && (score < 60 || score >= 80)) return false;
                if (s.confidence === 'low'    && score >= 60) return false;
            }
            // Date range — at least one configured date field must fall
            // inside [from, to]. Missing dates pass; empty mapping passes.
            if ((s.dateFrom || s.dateTo) && (mapping.dateField || mapping.dateFields)) {
                const fields = Array.isArray(mapping.dateFields)
                    ? mapping.dateFields
                    : [mapping.dateField];
                let pass = false;
                const fromT = s.dateFrom ? new Date(s.dateFrom).getTime() : -Infinity;
                const toT   = s.dateTo   ? new Date(s.dateTo).getTime()   :  Infinity;
                for (const f of fields) {
                    const raw = row[f];
                    if (!raw) continue;
                    const t = new Date(raw).getTime();
                    if (!Number.isFinite(t)) continue;
                    if (t >= fromT && t <= toT) { pass = true; break; }
                }
                if (!pass) return false;
            }
            return true;
        }

        function buildFilterParams() {
            const params = new URLSearchParams();
            const modules = getSelectedValues('filterModule');
            if (modules.length) params.set('modules', modules.join(','));
            const owners = getSelectedValues('filterOwner');
            if (owners.length) params.set('owners', owners.join(','));
            const layouts = getSelectedValues('filterLayout');
            if (layouts.length) params.set('layouts', layouts.join(','));
            const pipelines = getSelectedValues('filterPipeline');
            if (pipelines.length) params.set('pipelines', pipelines.join(','));
            const stages = getSelectedValues('filterStage');
            if (stages.length) params.set('stages', stages.join(','));
            const confidence = document.getElementById('filterConfidence').value;
            if (confidence) params.set('confidence_level', confidence);
            const domain = document.getElementById('filterDomain').value;
            if (domain) params.set('domain', domain);
            const from = document.getElementById('filterDateFrom').value;
            if (from) params.set('start_date', from);
            const to = document.getElementById('filterDateTo').value;
            if (to) params.set('end_date', to);
            // AI-status chip — per-tab state, read from the per-tab AI chip.
            // Defaults to 'active' so untouched clusters land in the list.
            const aiStatus = window._aiStatusByTab && window._aiStatusByTab[window._currentTab];
            if (aiStatus && aiStatus !== 'active') params.set('ai_status', aiStatus);
            // Marketplace / Corporate segment — only send when non-default so
            // the request URL stays clean when the operator hasn't picked one.
            const seg = document.getElementById('filterSegment')?.value;
            if (seg && seg !== 'all') params.set('segment', seg);
            return params;
        }

        function countActiveFilters() {
            let count = 0;
            if (getSelectedValues('filterModule').length) count++;
            if (getSelectedValues('filterOwner').length) count++;
            if (getSelectedValues('filterLayout').length) count++;
            if (getSelectedValues('filterPipeline').length) count++;
            if (getSelectedValues('filterStage').length) count++;
            if (document.getElementById('filterConfidence').value) count++;
            if (document.getElementById('filterDomain').value) count++;
            if (document.getElementById('filterDateFrom').value) count++;
            if (document.getElementById('filterDateTo').value) count++;
            const seg = document.getElementById('filterSegment')?.value;
            if (seg && seg !== 'all') count++;
            return count;
        }

        // ─── Per-tab Advanced Filters state (2026-06-08) ────────────────────
        // Each tab in the Duplicate Radar (Domain Clusters, Lead/Deal/Contact/
        // Account Duplicates, Cross-Module, CS Overlap, CS Lifecycle, Account
        // Hints, Owners, Preflight Check, etc.) keeps its OWN filter selection
        // — Module / Owner / Layout / Pipeline / Stage / Confidence / Domain /
        // Date Range. Switching tabs snapshots the current form into the
        // outgoing tab's slot, then restores the incoming tab's slot to the
        // inputs. Empty slot = blank form. Each tab can therefore have a
        // completely different filter spec, which is what makes the radar
        // usable across heterogeneous workflows ("on the Deal tab I want
        // Stage = Closed-Lost, on the Lead tab I want Layout = Marketplace").
        //
        // Persistence is in-memory only: a hard reload starts every tab
        // fresh. Operators who want cross-session retention can use the
        // browser bookmark URL — the underlying API endpoints still accept
        // the same filter params, so a saved deep-link works regardless.
        const _filterStateByTab = {};
        const _filterAwareTabs = new Set([
            'summary', 'clusters', 'leads', 'deals', 'contacts', 'accounts',
            'cross-module', 'cs-overlap', 'cs-lifecycle', 'deal-lifecycle', 'preflight',
            'owners', 'logs', 'search', 'account-hints',
        ]);

        function _filterGetMultiValues(id) {
            const el = document.getElementById(id);
            if (!el) return [];
            return Array.from(el.selectedOptions || []).map(o => o.value);
        }
        function _filterSetMultiValues(id, values) {
            const el = document.getElementById(id);
            if (!el) return;
            const set = new Set(values || []);
            Array.from(el.options || []).forEach(o => { o.selected = set.has(o.value); });
        }
        function _filterSetInputValue(id, value) {
            const el = document.getElementById(id);
            if (el) el.value = value || '';
        }

        function _snapshotFilterFormToTab(tabId) {
            if (!tabId) return;
            _filterStateByTab[tabId] = {
                module:     _filterGetMultiValues('filterModule'),
                owner:      _filterGetMultiValues('filterOwner'),
                layout:     _filterGetMultiValues('filterLayout'),
                pipeline:   _filterGetMultiValues('filterPipeline'),
                stage:      _filterGetMultiValues('filterStage'),
                confidence: document.getElementById('filterConfidence')?.value || '',
                domain:     document.getElementById('filterDomain')?.value || '',
                dateFrom:   document.getElementById('filterDateFrom')?.value || '',
                dateTo:     document.getElementById('filterDateTo')?.value || '',
                segment:    document.getElementById('filterSegment')?.value || 'all',
            };
        }

        function _restoreFilterFormFromTab(tabId) {
            const s = _filterStateByTab[tabId] || null;
            _filterSetMultiValues('filterModule',   s ? s.module   : []);
            _filterSetMultiValues('filterOwner',    s ? s.owner    : []);
            _filterSetMultiValues('filterLayout',   s ? s.layout   : []);
            _filterSetMultiValues('filterPipeline', s ? s.pipeline : []);
            _filterSetMultiValues('filterStage',    s ? s.stage    : []);
            _filterSetInputValue('filterConfidence', s ? s.confidence : '');
            _filterSetInputValue('filterDomain',     s ? s.domain     : '');
            _filterSetInputValue('filterDateFrom',   s ? s.dateFrom   : '');
            _filterSetInputValue('filterDateTo',     s ? s.dateTo     : '');
            _filterSetInputValue('filterSegment',    s ? s.segment    : 'all');
            _syncSegmentChipFromDropdown();
            _refreshActiveFilterCountBadge();
        }

        // Keep the All / Marketplace / Corporate chip in sync with the
        // mirror dropdown inside Advanced Filters. Called whenever either
        // the dropdown or a chip click changes the value.
        function _syncSegmentChipFromDropdown() {
            const seg = document.getElementById('filterSegment')?.value || 'all';
            const map = { all: 'segmentChipAll', marketplace: 'segmentChipMarketplace', corporate: 'segmentChipCorporate' };
            ['segmentChipAll', 'segmentChipMarketplace', 'segmentChipCorporate'].forEach(id => {
                const el = document.getElementById(id);
                if (!el) return;
                if (id === map[seg]) {
                    el.classList.add('bg-blue-600', 'text-white', 'font-medium');
                    el.classList.remove('bg-white', 'text-gray-700', 'hover:bg-gray-50');
                } else {
                    el.classList.remove('bg-blue-600', 'text-white', 'font-medium');
                    el.classList.add('bg-white', 'text-gray-700', 'hover:bg-gray-50');
                }
            });
        }

        // setSegment(newSeg) — called by the chip buttons and from the Advanced
        // Filters dropdown's onchange. Writes value into the dropdown (single
        // source of truth), restyles chips, snapshots into this tab's slot,
        // and re-runs the active tab's load path so the change is immediate.
        async function setSegment(newSeg) {
            if (!['all', 'marketplace', 'corporate'].includes(newSeg)) return;
            _filterSetInputValue('filterSegment', newSeg);
            _syncSegmentChipFromDropdown();
            try {
                const __active = _currentActiveTabId();
                if (__active && _filterAwareTabs.has(__active)) {
                    _snapshotFilterFormToTab(__active);
                }
            } catch (e) { /* non-fatal */ }
            _refreshActiveFilterCountBadge();
            // Re-run the active tab's loader. applyAdvancedFilters() already
            // routes per-tab; reuse it so we don't duplicate the dispatcher.
            try { await applyAdvancedFilters(); } catch (e) { console.error('setSegment apply error:', e); }
        }
        window.setSegment = setSegment;

        function _currentActiveTabId() {
            const el = document.querySelector('[id^="tab-"].tab-active');
            return el ? el.id.replace(/^tab-/, '') : null;
        }

        function _refreshActiveFilterCountBadge() {
            const count = countActiveFilters();
            const badge = document.getElementById('activeFilterCount');
            if (!badge) return;
            if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
            else            { badge.classList.add('hidden'); }
        }

        async function applyAdvancedFilters() {
            // Persist the active tab's current filter state BEFORE rendering
            // so when the operator later toggles to another tab and back,
            // their filters are still there. Snapshots are also taken on the
            // showTab() boundary; this one is here so an Apply without a
            // subsequent tab switch still captures the latest form state.
            try {
                const __activeTabAtApply = _currentActiveTabId();
                if (__activeTabAtApply && _filterAwareTabs.has(__activeTabAtApply)) {
                    _snapshotFilterFormToTab(__activeTabAtApply);
                }
            } catch (e) { /* non-fatal — form just won't persist on this apply */ }
            const count = countActiveFilters();
            const badge = document.getElementById('activeFilterCount');
            if (count > 0) {
                badge.textContent = count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }

            // Apply filters in the active tab's own renderer when possible.
            // loadRecordTab already passes filters to the backend; the other
            // tabs read getAdvancedFilterSpec() inside their renderers so
            // re-rendering with the cached data is enough.
            const activeTabEl = document.querySelector('[id^="tab-"].tab-active');
            const activeTab = activeTabEl ? activeTabEl.id.replace(/^tab-/, '') : 'summary';
            if (['leads', 'deals', 'contacts', 'accounts'].includes(activeTab)) {
                if (window._loadedTabs) window._loadedTabs.delete(activeTab);
                await loadRecordTab(activeTab, 0);
                return;
            }
            if (activeTab === 'cs-lifecycle') {
                if (window._csLifecycleData) renderCsLifecycle(window._csLifecycleData);
                else await loadCsLifecycle(window._csLifecycleFilter || 'all');
                return;
            }
            if (activeTab === 'deal-lifecycle') {
                if (window._dealLifecycleData) renderDealLifecycle(window._dealLifecycleData);
                else await loadDealLifecycle();
                return;
            }
            if (activeTab === 'deal-compliance') {
                // Stages are chosen in this tab's OWN Stage filter (the chips +
                // "Apply stages" button) — loadDealCompliance reads those. We
                // still reload here and stay on the tab so Apply never bounces
                // to Domain Clusters.
                if (window._loadedTabs) window._loadedTabs.delete('deal-compliance');
                await loadDealCompliance();
                return;
            }
            if (activeTab === 'cs-overlap') {
                if (window._csOverlapData) renderCsOverlap(window._csOverlapData);
                else await loadCsOverlap(window._csOverlapFilter || 'all');
                return;
            }
            if (activeTab === 'cross-module') {
                if (Array.isArray(crossModuleClusters) && crossModuleClusters.length > 0) renderCrossModuleTable();
                else await loadCrossModule();
                return;
            }
            if (activeTab === 'account-hints') {
                if (window._accountHintsData) renderAccountHints(window._accountHintsData);
                else await loadAccountHints();
                return;
            }
            if (activeTab === 'owners') {
                if (Array.isArray(_ownersCache) && _ownersCache.length > 0) renderOwners(_ownersCache);
                else if (typeof loadOwners === 'function') await loadOwners();
                return;
            }

            // Fallback: legacy Domain Clusters routing kept for the Summary
            // and other non-tab views — keeps the historic behaviour intact.
            const params = buildFilterParams();
            try {
                const [clustersRes, summaryRes] = await Promise.all([
                    fetch('/api/duplicates/filtered-clusters?' + params.toString()),
                    fetch('/api/duplicates/filtered-summary?' + params.toString())
                ]);
                const clustersData = await clustersRes.json();
                const summaryData = await summaryRes.json();

                renderFilteredClusters(clustersData.clusters || [], clustersData.total || 0);
                updateFilteredSummaryBadge(summaryData);
            } catch (e) {
                console.error('Error applying filters:', e);
            }
        }

        function renderFilteredClusters(clusters, total) {
            showTab('clusters');
            renderClusters(clusters);
            const pagEl = document.getElementById('clustersPagination');
            if (pagEl) pagEl.innerHTML = `<span class="text-sm text-gray-500">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.showing_filtered', { shown: _fn(clusters.length), total: _fn(total) }))}</span>`;
        }

        function updateFilteredSummaryBadge(data) {
            const badge = document.getElementById('activeFilterCount');
            if (badge && data.totalClusters !== undefined) {
                badge.textContent = WalaPlusI18n.t('dyn.duplicates.filter_count_with_clusters', { count: _fn(countActiveFilters()), total: _fn(data.totalClusters) });
                badge.classList.remove('hidden');
            }
        }

        function clearAllFilters() {
            document.getElementById('filterModule').selectedIndex = -1;
            document.getElementById('filterOwner').selectedIndex = -1;
            document.getElementById('filterLayout').selectedIndex = -1;
            document.getElementById('filterPipeline').selectedIndex = -1;
            document.getElementById('filterStage').selectedIndex = -1;
            document.getElementById('filterConfidence').value = '';
            document.getElementById('filterDomain').value = '';
            document.getElementById('filterDateFrom').value = '';
            document.getElementById('filterDateTo').value = '';
            // Segment dropdown + chip — Clear resets to default 'all'.
            const segEl = document.getElementById('filterSegment');
            if (segEl) segEl.value = 'all';
            _syncSegmentChipFromDropdown();
            document.getElementById('activeFilterCount').classList.add('hidden');
            // Per-tab Clear All — only forget THIS tab's slot. Other tabs
            // keep their own filter selections so a Clear on the Lead tab
            // doesn't wipe Stage = Closed-Lost on the Deal tab.
            try {
                const __active = _currentActiveTabId();
                if (__active && _filterStateByTab[__active]) {
                    delete _filterStateByTab[__active];
                }
            } catch (e) { /* non-fatal */ }
            // Re-render the active tab via the same routing applyAdvancedFilters
            // uses so client-side-filtered tabs (CS Lifecycle / CS Overlap /
            // Cross-Module / Owners / Account Hints) show their full data
            // again without a full page reload.
            applyAdvancedFilters();
        }

        function applyDateFilter() { applyAdvancedFilters(); }
        function clearDateFilter() {
            document.getElementById('filterDateFrom').value = '';
            document.getElementById('filterDateTo').value = '';
            applyAdvancedFilters();
        }

        function formatRelativeTime(isoDate) {
            const then = new Date(isoDate).getTime();
            const now = Date.now();
            const diffMs = now - then;
            const mins = Math.floor(diffMs / 60000);
            if (mins < 1) return WalaPlusI18n.t('dyn.duplicates.just_now');
            if (mins < 60) return WalaPlusI18n.t('dyn.duplicates.mins_ago', { n: _fn(mins) });
            const hours = Math.floor(mins / 60);
            if (hours < 24) return WalaPlusI18n.t('dyn.duplicates.hours_ago', { n: _fn(hours) });
            const days = Math.floor(hours / 24);
            return WalaPlusI18n.t('dyn.duplicates.days_ago', { n: _fn(days) });
        }

        async function loadSyncStatus() {
            try {
                const res = await fetch('/api/duplicates/sync-status');
                const data = await res.json();
                const states = data.syncStates || [];
                if (states.length === 0) return;

                document.getElementById('syncStatusBar').classList.remove('hidden');
                const chipsEl = document.getElementById('syncModuleChips');
                const statusColors = { completed: 'bg-green-100 text-green-700', syncing: 'bg-blue-100 text-blue-700 animate-pulse', failed: 'bg-red-100 text-red-700', idle: 'bg-gray-100 text-gray-600' };
                chipsEl.innerHTML = states.map(s => {
                    const color = statusColors[s.sync_status] || statusColors.idle;
                    return `<span class="px-2 py-1 rounded-full text-xs font-medium ${color}">${escapeHtml(WalaPlusI18n.t('dyn.duplicates.sync_chip', { module: s.module, n: _fn(s.total_synced), status: s.sync_status }))}</span>`;
                }).join('');

                const latestSync = states.filter(s => s.last_sync_at).sort((a, b) => new Date(b.last_sync_at) - new Date(a.last_sync_at))[0];
                if (latestSync) {
                    const ts = latestSync.last_sync_at;
                    const ageHours = (Date.now() - new Date(ts).getTime()) / 3600000;
                    const lastRunEl = document.getElementById('syncLastRun');
                    lastRunEl.textContent = WalaPlusI18n.t('dyn.duplicates.last_synced', { ago: formatRelativeTime(ts), when: _fd(new Date(ts), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) });
                    const dot = document.getElementById('syncStatusDot');
                    const warn = document.getElementById('syncStaleWarning');
                    if (ageHours > 8) {
                        dot.classList.remove('text-green-500');
                        dot.classList.add('text-amber-500');
                        warn.classList.remove('hidden');
                    } else {
                        dot.classList.remove('text-amber-500');
                        dot.classList.add('text-green-500');
                        warn.classList.add('hidden');
                    }
                }
            } catch (e) {
                console.error('Error loading sync status:', e);
            }
        }

        // Phase 4e — Active Zoho connection probe (duplicated from calls.html).
        //
        // Hits GET /api/calls/diagnostic/zoho which actively calls
        // getValidAccessToken() on the server and surfaces the EXACT
        // error if connection fails. Use when this tab shows no data —
        // surfaces invalid_client / invalid_grant / wrong datacenter /
        // rate-limited / network unreachable in plain language.
        async function runZohoDiagnostic() {
            const btn = document.getElementById('btn-diagnose-zoho-duplicates');
            if (btn) btn.disabled = true;
            try {
                const res = await fetch('/api/calls/diagnostic/zoho');
                const data = await res.json();
                if (!data.success) {
                    alert(`Zoho diagnostic failed: ${data.error || 'unknown'}`);
                    return;
                }
                const lines = [];
                lines.push(`DIAGNOSIS: ${data.diagnosis}`);
                lines.push('');
                lines.push('--- Environment Secrets ---');
                lines.push(`  ZOHO_CLIENT_ID:        ${data.env_secrets.ZOHO_CLIENT_ID.present ? `present (length=${data.env_secrets.ZOHO_CLIENT_ID.length})` : 'MISSING'}`);
                lines.push(`  ZOHO_CLIENT_ID_NEW:    ${data.env_secrets.ZOHO_CLIENT_ID_NEW.present ? `present (length=${data.env_secrets.ZOHO_CLIENT_ID_NEW.length})` : 'not set (optional fallback)'}`);
                lines.push(`  ZOHO_CLIENT_SECRET:    ${data.env_secrets.ZOHO_CLIENT_SECRET.present ? `present (length=${data.env_secrets.ZOHO_CLIENT_SECRET.length})` : 'MISSING'}`);
                lines.push(`  ZOHO_REFRESH_TOKEN:    ${data.env_secrets.ZOHO_REFRESH_TOKEN.present ? `present (length=${data.env_secrets.ZOHO_REFRESH_TOKEN.length})` : 'MISSING'}`);
                lines.push(`  ZOHO_ACCOUNTS_URL:     ${data.env_secrets.ZOHO_ACCOUNTS_URL}`);
                lines.push(`  ZOHO_API_DOMAIN:       ${data.env_secrets.ZOHO_API_DOMAIN}`);
                lines.push(`  ZOHO_ACCESS_TOKEN (static): ${data.env_secrets.ZOHO_ACCESS_TOKEN_static.present ? `present (length=${data.env_secrets.ZOHO_ACCESS_TOKEN_static.length})` : 'not set'}`);
                lines.push('');
                lines.push('--- Passive State Before Probe ---');
                lines.push(`  connected: ${data.passive_status_before_probe.connected}`);
                lines.push(`  tokenCached: ${data.passive_status_before_probe.tokenCached}`);
                lines.push(`  tokenExpired: ${data.passive_status_before_probe.tokenExpired}`);
                lines.push(`  message: ${data.passive_status_before_probe.message}`);
                lines.push('');
                lines.push('--- Rate Limit Cooldown ---');
                lines.push(`  rateLimited: ${data.rate_limit_cooldown.rateLimited}`);
                lines.push(`  cooldownMsRemaining: ${data.rate_limit_cooldown.cooldownMsRemaining}`);
                lines.push('');
                lines.push('--- ACTIVE PROBE (real OAuth refresh attempt) ---');
                if (data.active_probe.ok) {
                    lines.push(`  ✓ SUCCESS — access token obtained (length=${data.active_probe.tokenLength})`);
                } else {
                    lines.push(`  ✗ FAILED`);
                    lines.push(`  errorClass: ${data.active_probe.errorClass || '(none)'}`);
                    lines.push(`  errorHttpStatus: ${data.active_probe.errorHttpStatus || '(none)'}`);
                    lines.push(`  errorMessage: ${data.active_probe.errorMessage || '(none)'}`);
                    lines.push(`  isZohoRateLimited: ${data.active_probe.isZohoRateLimited}`);
                }
                lines.push('');
                lines.push('--- Passive State After Probe ---');
                lines.push(`  connected: ${data.passive_status_after_probe.connected}`);
                lines.push(`  tokenCached: ${data.passive_status_after_probe.tokenCached}`);

                const modal = document.createElement('div');
                modal.className = 'fixed inset-0 bg-black/50 flex items-center justify-center p-4';
                modal.setAttribute('data-style', 'z-index:60');
                modal.innerHTML = `
                    <div class="bg-white rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
                        <div class="px-6 py-4 border-b flex items-center justify-between">
                            <h3 class="text-lg font-semibold">Zoho Connection Diagnostic</h3>
                            <button class="text-gray-400 hover:text-gray-700" data-zoho-diag-close>
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                            </button>
                        </div>
                        <pre class="px-6 py-4 overflow-auto text-xs font-mono text-gray-800 flex-1"></pre>
                    </div>`;
                modal.querySelector('pre').textContent = lines.join('\n');
                modal.querySelector('[data-zoho-diag-close]').addEventListener('click', () => modal.remove());
                modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
                document.body.appendChild(modal);
                console.log('[Zoho Diagnostic]', data);
            } catch (e) {
                alert('Zoho diagnostic threw: ' + (e.message || e));
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function syncNowZohoCRM() {
            const btn = document.getElementById('syncNowBtn');
            const originalHTML = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> ' + escapeHtml(WalaPlusI18n.t('dyn.duplicates.syncing'));
            try {
                const doSync = (force) => fetch('/api/duplicates/scan-zoho', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: !!force }),
                });
                let res = await doSync(false);
                // A scan is already running. Offer to force-reset a stuck one
                // and start fresh (the server fences the old run so it can't
                // clobber the new one's state).
                if (res.status === 409) {
                    const info = await res.json().catch(() => ({}));
                    const mins = (info && typeof info.ageMinutes === 'number') ? info.ageMinutes : null;
                    const ask = 'A scan is already in progress'
                        + (mins != null ? ' (running ' + mins + ' min)' : '')
                        + '.\n\nForce-reset it and start a fresh sync?';
                    if (window.confirm(ask)) {
                        res = await doSync(true);
                    } else {
                        btn.disabled = false;
                        btn.innerHTML = originalHTML;
                        return;
                    }
                }
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    alert(err.error || WalaPlusI18n.t('dyn.duplicates.sync_failed'));
                    btn.disabled = false;
                    btn.innerHTML = originalHTML;
                    return;
                }
                document.getElementById('scanProgressBar')?.classList.remove('hidden');
                startScanPolling();
                const restoreBtn = setInterval(async () => {
                    try {
                        const sres = await fetch('/api/duplicates/scan-status');
                        const sdata = await sres.json();
                        if (sdata.status !== 'scanning') {
                            btn.disabled = false;
                            btn.innerHTML = originalHTML;
                            clearInterval(restoreBtn);
                            loadSyncStatus();
                            refreshData();
                        }
                    } catch {}
                }, 2000);
                setTimeout(() => { btn.disabled = false; btn.innerHTML = originalHTML; clearInterval(restoreBtn); }, 600000);
            } catch (e) {
                alert(WalaPlusI18n.t('dyn.duplicates.sync_failed_msg', { msg: e.message || e }));
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        }

        async function checkScanStatus() {
            try {
                const res = await fetch('/api/duplicates/scan-status');
                const data = await res.json();
                if (data.status === 'scanning') {
                    document.getElementById('scanProgressBar').classList.remove('hidden');
                    const scanBtn = document.getElementById('scanZohoBtn');
                    if (scanBtn) {
                        scanBtn.disabled = true;
                        scanBtn.textContent = WalaPlusI18n.t('dyn.duplicates.scanning');
                    }
                    startScanPolling();
                }
            } catch {}
        }

        if (localStorage.getItem('mergeGuideDismissed') === '1') {
            const banner = document.getElementById('mergeGuideBanner');
            if (banner) banner.classList.add('hidden');
        }
        _runWhenI18nReady(function() {
            refreshData();
            checkScanStatus();
            loadSyncStatus();
            setInterval(loadSyncStatus, 60000);
            // R7: if the operator landed mid-scan (refreshed the tab while a
            // scan was in flight), attach SSE silently so the sticky progress
            // bar resumes instead of leaving them guessing.
            attachScanProgressIfRunning();
        });

        // R7: tear down the SSE connection when the tab navigates away,
        // so we don't leak EventSource clients on the server.
        window.addEventListener('beforeunload', closeScanProgressSse);
    