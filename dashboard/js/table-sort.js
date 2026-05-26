/**
 * WalaPlus — Universal table sort.
 *
 * Adds click-to-sort (ascending / descending / off) to every <table> across
 * the platform without per-page wiring. Loaded once from navigation.js so it
 * applies to every dashboard page that includes the global nav.
 *
 * Opt-out:
 *   - <table data-no-sort>            … skip the whole table
 *   - <th    data-no-sort>            … skip just that column
 *
 * The helper deliberately stays out of the way when a table is already
 * managed by a custom sort handler — any <th> that already has a
 * `data-on-click` attribute (i.e. wired to safe-actions) is left alone, so
 * server-paged tables like CS Lifecycle / CS Overlap keep working.
 *
 * Numeric detection strips common formatting (currency symbols, commas,
 * percent, "k"/"m"/"b" magnitude suffixes, SAR / USD prefixes) so columns
 * like "SAR 13,469,678.91" and "70%" sort numerically rather than
 * lexically.
 */
(function () {
  'use strict';

  if (window.__walaplusTableSortInit) return;
  window.__walaplusTableSortInit = true;

  var SORT_INDICATOR_CLASS = 'wp-sort-indicator';
  var SORTABLE_TH_CLASS = 'wp-sortable-th';
  var STATE_KEY = '__wpSortState'; // { key: colIndex, dir: 'asc'|'desc'|null }

  function isInputishTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea' || tag === 'label';
  }

  function shouldSkipTable(table) {
    if (!table || table.hasAttribute('data-no-sort')) return true;
    // Need at least one <tbody> row to be worth sorting.
    var tbody = table.tBodies && table.tBodies[0];
    if (!tbody) return true;
    // A thead with <th> cells we can wire.
    var thead = table.tHead;
    if (!thead || !thead.rows.length) return true;
    return false;
  }

  function shouldSkipHeader(th) {
    if (!th || th.hasAttribute('data-no-sort')) return true;
    // Leave custom-sort columns alone — they have their own handler that
    // typically re-queries the server and won't compose with client sort.
    if (th.hasAttribute('data-on-click')) return true;
    // Header cells that exist only to host a "select all" checkbox aren't
    // meaningful to sort by — skip if the cell is dominated by an input.
    var firstChild = th.firstElementChild;
    if (firstChild && (firstChild.tagName === 'INPUT' || th.querySelector('input[type="checkbox"]'))) {
      // Only skip if there's no textual label alongside the checkbox.
      var text = (th.textContent || '').replace(/\s+/g, '').trim();
      if (!text) return true;
    }
    return false;
  }

  function getCellText(row, colIndex) {
    var cell = row.cells && row.cells[colIndex];
    if (!cell) return '';
    // Prefer an explicit sort-value override if the row provides one.
    var override = cell.getAttribute('data-sort-value');
    if (override !== null) return override;
    return (cell.textContent || '').trim();
  }

  function parseNumeric(value) {
    if (value === null || value === undefined) return NaN;
    var s = String(value).trim();
    if (!s) return NaN;
    // Strip currency/percent/magnitude and thousands separators. Keep the
    // sign and decimal point.
    var cleaned = s
      .replace(/[\u200e\u200f]/g, '')           // LTR/RTL marks
      .replace(/[\u00a0\s]/g, '')                // whitespace
      .replace(/(sar|usd|eur|gbp|aed|qar|kwd|bhd|omr)/gi, '')
      .replace(/[,٬]/g, '')                      // grouping sep (latin + arabic)
      .replace(/[%]/g, '');
    var mag = 1;
    var lastChar = cleaned.slice(-1).toLowerCase();
    if (lastChar === 'k') { mag = 1e3; cleaned = cleaned.slice(0, -1); }
    else if (lastChar === 'm') { mag = 1e6; cleaned = cleaned.slice(0, -1); }
    else if (lastChar === 'b') { mag = 1e9; cleaned = cleaned.slice(0, -1); }
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
    return parseFloat(cleaned) * mag;
  }

  function parseDate(value) {
    if (!value) return NaN;
    var ts = Date.parse(value);
    return isNaN(ts) ? NaN : ts;
  }

  function detectColumnType(rows, colIndex, sampleSize) {
    var samples = 0;
    var numeric = 0;
    var dateish = 0;
    for (var i = 0; i < rows.length && samples < sampleSize; i++) {
      var raw = getCellText(rows[i], colIndex);
      if (!raw) continue;
      samples++;
      if (!isNaN(parseNumeric(raw))) numeric++;
      else if (!isNaN(parseDate(raw))) dateish++;
    }
    if (samples === 0) return 'string';
    if (numeric / samples >= 0.7) return 'number';
    if (dateish / samples >= 0.7) return 'date';
    return 'string';
  }

  function compareFactory(type, dir) {
    var mult = dir === 'asc' ? 1 : -1;
    if (type === 'number') {
      return function (a, b) {
        var na = parseNumeric(a), nb = parseNumeric(b);
        var aNan = isNaN(na), bNan = isNaN(nb);
        if (aNan && bNan) return 0;
        if (aNan) return 1;  // empties always last
        if (bNan) return -1;
        return (na - nb) * mult;
      };
    }
    if (type === 'date') {
      return function (a, b) {
        var da = parseDate(a), db = parseDate(b);
        var aNan = isNaN(da), bNan = isNaN(db);
        if (aNan && bNan) return 0;
        if (aNan) return 1;
        if (bNan) return -1;
        return (da - db) * mult;
      };
    }
    // String / locale-aware. Empty strings always last so they don't
    // pollute the visible top of the list.
    var coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return function (a, b) {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return coll.compare(a, b) * mult;
    };
  }

  function setIndicator(th, dir) {
    var ind = th.querySelector('.' + SORT_INDICATOR_CLASS);
    if (!ind) return;
    if (dir === 'asc') {
      ind.textContent = '↑';
      ind.classList.remove('opacity-30');
      ind.classList.add('opacity-100');
    } else if (dir === 'desc') {
      ind.textContent = '↓';
      ind.classList.remove('opacity-30');
      ind.classList.add('opacity-100');
    } else {
      ind.textContent = '⇅';
      ind.classList.remove('opacity-100');
      ind.classList.add('opacity-30');
    }
  }

  function clearOtherIndicators(thead, exceptTh) {
    var ths = thead.querySelectorAll('th.' + SORTABLE_TH_CLASS);
    for (var i = 0; i < ths.length; i++) {
      if (ths[i] !== exceptTh) setIndicator(ths[i], null);
    }
  }

  function applySort(table, colIndex, dir) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    var rows = Array.prototype.slice.call(tbody.rows);
    if (rows.length < 2) return;

    if (!dir) {
      // Restore original order if we tracked it.
      var original = tbody[STATE_KEY] && tbody[STATE_KEY].original;
      if (original) {
        for (var i = 0; i < original.length; i++) {
          if (original[i].parentNode === tbody) tbody.appendChild(original[i]);
        }
      }
      tbody[STATE_KEY] = { key: null, dir: null, original: original };
      return;
    }

    // Snapshot original order the first time we sort this tbody so we can
    // restore it on the third click.
    if (!tbody[STATE_KEY] || !tbody[STATE_KEY].original) {
      tbody[STATE_KEY] = { key: null, dir: null, original: rows.slice() };
    }

    var type = detectColumnType(rows, colIndex, 12);
    var cmp = compareFactory(type, dir);
    rows.sort(function (a, b) {
      return cmp(getCellText(a, colIndex), getCellText(b, colIndex));
    });

    var frag = document.createDocumentFragment();
    for (var j = 0; j < rows.length; j++) frag.appendChild(rows[j]);
    tbody.appendChild(frag);

    tbody[STATE_KEY] = {
      key: colIndex,
      dir: dir,
      original: tbody[STATE_KEY].original,
    };
  }

  function onHeaderClick(ev) {
    var th = ev.currentTarget;
    if (isInputishTarget(ev.target) && ev.target !== th) return;
    var table = th.closest('table');
    if (!table) return;
    var headerRow = th.parentElement;
    var colIndex = Array.prototype.indexOf.call(headerRow.cells, th);
    if (colIndex < 0) return;

    var tbody = table.tBodies[0];
    if (!tbody) return;
    var state = tbody[STATE_KEY] || { key: null, dir: null };
    var nextDir;
    if (state.key !== colIndex) nextDir = 'asc';
    else if (state.dir === 'asc') nextDir = 'desc';
    else if (state.dir === 'desc') nextDir = null;
    else nextDir = 'asc';

    applySort(table, colIndex, nextDir);
    clearOtherIndicators(table.tHead, th);
    setIndicator(th, nextDir);
  }

  function onHeaderKeydown(ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onHeaderClick(ev);
    }
  }

  function wireHeader(th) {
    if (th.classList.contains(SORTABLE_TH_CLASS)) return;
    th.classList.add(SORTABLE_TH_CLASS, 'cursor-pointer', 'select-none', 'hover:bg-gray-100');
    // Indicator: small arrow next to the label. Stays muted until used.
    if (!th.querySelector('.' + SORT_INDICATOR_CLASS)) {
      var ind = document.createElement('span');
      ind.className = SORT_INDICATOR_CLASS + ' opacity-30 ms-1 text-[10px]';
      ind.textContent = '⇅';
      ind.setAttribute('aria-hidden', 'true');
      th.appendChild(document.createTextNode(' '));
      th.appendChild(ind);
    }
    th.setAttribute('tabindex', '0');
    th.setAttribute('role', 'button');
    var existingLabel = (th.getAttribute('aria-label') || th.textContent || '').trim();
    th.setAttribute('aria-label', existingLabel + ' (click to sort)');
    th.addEventListener('click', onHeaderClick);
    th.addEventListener('keydown', onHeaderKeydown);
  }

  function upgradeTable(table) {
    if (shouldSkipTable(table)) return;
    if (table.__wpSortUpgraded) return;
    table.__wpSortUpgraded = true;
    var headerRow = table.tHead.rows[0];
    if (!headerRow) return;
    for (var i = 0; i < headerRow.cells.length; i++) {
      var th = headerRow.cells[i];
      if (shouldSkipHeader(th)) continue;
      wireHeader(th);
    }
  }

  function upgradeAll(root) {
    var scope = root || document;
    var tables = scope.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) upgradeTable(tables[i]);
  }

  function start() {
    upgradeAll(document);
    // Watch for tables / theads that arrive after initial render — many
    // dashboards build tables in JS after API calls return.
    try {
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (!m.addedNodes) continue;
          for (var j = 0; j < m.addedNodes.length; j++) {
            var n = m.addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (n.tagName === 'TABLE') upgradeTable(n);
            else if (n.querySelectorAll) {
              var nested = n.querySelectorAll('table');
              for (var k = 0; k < nested.length; k++) upgradeTable(nested[k]);
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) { /* MutationObserver unavailable — initial pass still works */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
