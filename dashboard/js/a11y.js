/**
 * WalaPlus Accessibility Helper (WCAG 2.1 AA)
 * - Skip-to-main-content link injection
 * - Modal focus trap + Escape-to-close + return-focus-to-trigger
 * - Consistent focus-visible enhancement
 * - ARIA live region for AI Consultant responses
 */
(function () {
  'use strict';

  var FOCUSABLE = [
    'a[href]:not([tabindex="-1"])',
    'button:not([disabled]):not([tabindex="-1"])',
    'input:not([disabled]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  var _activeTrap = null;
  var _trapKeyHandler = null;

  function getFocusable(container) {
    return Array.prototype.slice.call(container.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return !el.closest('[hidden]') && el.offsetParent !== null;
    });
  }

  function activateFocusTrap(dialogEl, triggerEl) {
    if (_activeTrap) deactivateFocusTrap();

    var trigger = triggerEl || document.activeElement;
    _activeTrap = { dialog: dialogEl, trigger: trigger };

    var firstFocusable = getFocusable(dialogEl)[0];
    if (firstFocusable) firstFocusable.focus();

    _trapKeyHandler = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModalByEl(dialogEl);
        return;
      }
      if (e.key !== 'Tab') return;
      var focusable = getFocusable(dialogEl);
      if (!focusable.length) { e.preventDefault(); return; }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', _trapKeyHandler, true);
  }

  function deactivateFocusTrap() {
    if (!_activeTrap) return;
    if (_trapKeyHandler) {
      document.removeEventListener('keydown', _trapKeyHandler, true);
      _trapKeyHandler = null;
    }
    var trigger = _activeTrap.trigger;
    _activeTrap = null;
    if (trigger && typeof trigger.focus === 'function') {
      try { trigger.focus(); } catch (_) {}
    }
  }

  function openModal(modalEl, triggerEl) {
    if (!modalEl) return;
    modalEl.classList.remove('hidden');
    modalEl.classList.add('active');
    modalEl.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    activateFocusTrap(modalEl, triggerEl);
  }

  function closeModalByEl(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    modalEl.classList.remove('active');
    modalEl.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    deactivateFocusTrap();
  }

  function closeModal(idOrEl) {
    var el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    closeModalByEl(el);
  }

  function injectSkipLink() {
    if (document.getElementById('wp-skip-link')) return;
    var mainId = 'main-content';
    var main = document.querySelector('main')
      || document.querySelector('[role="main"]')
      || document.querySelector('.wp-main-content')
      || document.querySelector('#main-content');
    if (main) {
      if (!main.id) main.id = mainId;
      else mainId = main.id;
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    } else {
      var placeholder = document.createElement('span');
      placeholder.id = mainId;
      placeholder.setAttribute('tabindex', '-1');
      placeholder.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);';
      document.body.insertBefore(placeholder, document.body.firstChild);
    }
    var link = document.createElement('a');
    link.id = 'wp-skip-link';
    link.href = '#' + mainId;
    link.className = 'wp-skip-link';
    link.textContent = 'Skip to main content';
    document.body.insertBefore(link, document.body.firstChild);
  }

  function injectSkipLinkStyles() {
    if (document.getElementById('wp-a11y-styles')) return;
    var style = document.createElement('style');
    style.id = 'wp-a11y-styles';
    style.textContent = [
      '.wp-skip-link {',
      '  position: fixed; top: -100%; left: 0; z-index: 99999;',
      '  padding: 12px 24px; background: #1e3a8a; color: #fff;',
      '  font-size: 14px; font-weight: 600; text-decoration: none;',
      '  border-radius: 0 0 8px 0; outline: none;',
      '  transition: top 0.15s ease;',
      '}',
      '.wp-skip-link:focus { top: 0; }',
      '',
      '/* WCAG-AA focus-visible ring */',
      ':focus-visible {',
      '  outline: 3px solid #4f46e5;',
      '  outline-offset: 2px;',
      '}',
      'button:focus-visible, a:focus-visible, [tabindex]:focus-visible,',
      'input:focus-visible, select:focus-visible, textarea:focus-visible {',
      '  outline: 3px solid #4f46e5;',
      '  outline-offset: 2px;',
      '  border-radius: 4px;',
      '}',
      '',
      '/* Remove focus ring for mouse clicks (only show for keyboard) */',
      ':focus:not(:focus-visible) { outline: none; }',
      '',
      '/* Widget quick-btn as button */',
      'button.widget-quick-btn { font-family: inherit; background: none; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function injectARIALiveRegion() {
    if (document.getElementById('wp-aria-live')) return;
    var live = document.createElement('div');
    live.id = 'wp-aria-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    live.setAttribute('role', 'status');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;';
    document.body.appendChild(live);
  }

  function announce(message) {
    var live = document.getElementById('wp-aria-live');
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = message; }, 50);
  }

  function patchLegacyModals() {
    document.querySelectorAll('.modal').forEach(function (modal) {
      if (!modal.getAttribute('role') || modal.getAttribute('role') !== 'dialog') {
        modal.setAttribute('role', 'dialog');
      }
      if (!modal.getAttribute('aria-modal')) {
        modal.setAttribute('aria-modal', 'true');
      }
      if (!modal.getAttribute('aria-hidden')) {
        modal.setAttribute('aria-hidden', modal.classList.contains('hidden') ? 'true' : 'false');
      }
      var heading = modal.querySelector('h2, h3, h4');
      if (heading && !modal.getAttribute('aria-labelledby')) {
        if (!heading.id) heading.id = 'modal-title-' + Math.random().toString(36).slice(2, 7);
        modal.setAttribute('aria-labelledby', heading.id);
      }
      modal.querySelectorAll('button[onclick*="hidden"], button[title*="Close"], button[title*="close"], button[data-dismiss], button[aria-label*="lose"]').forEach(function (btn) {
        if (!btn.getAttribute('aria-label')) {
          btn.setAttribute('aria-label', 'Close dialog');
        }
      });
      var svgOnlyBtns = modal.querySelectorAll('button');
      svgOnlyBtns.forEach(function (btn) {
        if (!btn.getAttribute('aria-label') && !btn.textContent.trim()) {
          var svgTitle = btn.querySelector('title');
          btn.setAttribute('aria-label', svgTitle ? svgTitle.textContent : 'Close dialog');
        }
      });
    });
  }

  function watchModals() {
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.type !== 'attributes') return;
        var el = mutation.target;
        if (!el.classList || !el.classList.contains('modal')) return;
        var wasHidden = mutation.oldValue && mutation.oldValue.split(' ').indexOf('hidden') !== -1;
        var isHidden = el.classList.contains('hidden');
        if (wasHidden && !isHidden) {
          el.setAttribute('aria-hidden', 'false');
          activateFocusTrap(el, document.activeElement);
        } else if (!wasHidden && isHidden) {
          el.setAttribute('aria-hidden', 'true');
          if (_activeTrap && _activeTrap.dialog === el) {
            deactivateFocusTrap();
          }
        }
      });
    });
    document.querySelectorAll('.modal').forEach(function (modal) {
      observer.observe(modal, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    });
    var bodyObserver = new MutationObserver(function () {
      document.querySelectorAll('.modal').forEach(function (modal) {
        if (!modal._a11yWatched) {
          modal._a11yWatched = true;
          observer.observe(modal, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
        }
      });
      patchLegacyModals();
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    injectSkipLinkStyles();
    injectSkipLink();
    injectARIALiveRegion();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        patchLegacyModals();
        watchModals();
      });
    } else {
      patchLegacyModals();
      watchModals();
    }
  }

  function makeChartAccessible(canvasId, chartInstance, title) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;

    canvas.setAttribute('role', 'img');
    if (title && !canvas.getAttribute('aria-label')) {
      canvas.setAttribute('aria-label', title);
    }

    var summaryId = canvasId + '-summary';
    var summary = document.getElementById(summaryId);
    if (!summary || !chartInstance) return;

    var datasets = chartInstance.data && chartInstance.data.datasets;
    var labels = (chartInstance.data && chartInstance.data.labels) || [];
    if (!datasets || !datasets.length || !labels.length) return;

    var multiDataset = datasets.length > 1;

    while (summary.firstChild) summary.removeChild(summary.firstChild);

    var caption = document.createElement('caption');
    caption.textContent = title || 'Chart data';
    summary.appendChild(caption);

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var thCat = document.createElement('th');
    thCat.setAttribute('scope', 'col');
    thCat.textContent = 'Category';
    headerRow.appendChild(thCat);
    if (multiDataset) {
      datasets.forEach(function (ds) {
        var th = document.createElement('th');
        th.setAttribute('scope', 'col');
        th.textContent = ds.label || 'Value';
        headerRow.appendChild(th);
      });
    } else {
      var thVal = document.createElement('th');
      thVal.setAttribute('scope', 'col');
      thVal.textContent = 'Value';
      headerRow.appendChild(thVal);
    }
    thead.appendChild(headerRow);
    summary.appendChild(thead);

    var tbody = document.createElement('tbody');
    labels.forEach(function (label, i) {
      var tr = document.createElement('tr');
      var tdLabel = document.createElement('td');
      tdLabel.textContent = label != null ? String(label) : '';
      tr.appendChild(tdLabel);
      if (multiDataset) {
        datasets.forEach(function (ds) {
          var td = document.createElement('td');
          td.textContent = ds.data[i] != null ? String(ds.data[i]) : '';
          tr.appendChild(td);
        });
      } else {
        var td = document.createElement('td');
        td.textContent = datasets[0].data[i] != null ? String(datasets[0].data[i]) : '';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    summary.appendChild(tbody);
  }

  window.WalaPlusA11y = {
    init: init,
    openModal: openModal,
    closeModal: closeModal,
    activateFocusTrap: activateFocusTrap,
    deactivateFocusTrap: deactivateFocusTrap,
    announce: announce,
    makeChartAccessible: makeChartAccessible
  };

  init();
})();
