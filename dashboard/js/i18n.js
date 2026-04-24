/**
 * WalaPlus i18n Module — Phase 1
 * Lightweight client-side internationalization with Arabic/RTL support.
 *
 * Usage:
 *   WalaPlusI18n.init().then(() => { ... })
 *   WalaPlusI18n.t('nav.brand')
 *   WalaPlusI18n.t('executive.health_labels.excellent')
 *   WalaPlusI18n.setLang('ar')  // persists + reloads
 *
 * Adding a new page:
 *   1. Add your keys to dashboard/i18n/en.json and dashboard/i18n/ar.json
 *   2. Add data-i18n="your.key" attributes to your HTML elements
 *   3. Call WalaPlusI18n.applyToDOM() after the module is initialized
 */

(function (global) {
  'use strict';

  var STORAGE_KEY = 'walaplus_lang';
  var NUMERALS_KEY = 'walaplus_eastern_numerals';
  var DEFAULT_LANG = 'en';
  var SUPPORTED = ['en', 'ar'];
  var PREF_ENDPOINT = '/api/user/language-preference';

  var _lang = DEFAULT_LANG;
  var _strings = {};
  var _loaded = false;
  var _readyCallbacks = [];
  var _useEasternNumerals = true;

  function _loadNumeralPref() {
    try {
      var stored = localStorage.getItem(NUMERALS_KEY);
      if (stored !== null) {
        _useEasternNumerals = stored !== 'false';
      }
    } catch (_) {}
  }

  function _detectLang() {
    // 1. localStorage
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.indexOf(stored) !== -1) return stored;
    } catch (_) {}
    // 2. <html lang> already set by SSR/server
    var htmlLang = (document.documentElement.lang || '').toLowerCase().split('-')[0];
    if (htmlLang && SUPPORTED.indexOf(htmlLang) !== -1) return htmlLang;
    // 3. Browser language
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase().split('-')[0];
    if (nav && SUPPORTED.indexOf(nav) !== -1) return nav;
    return DEFAULT_LANG;
  }

  function _applyHtmlDir(lang) {
    var rtl = lang === 'ar';
    document.documentElement.lang = lang;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.body.classList.toggle('wp-rtl', rtl);
    // Load Arabic font only when needed
    if (rtl && !document.getElementById('wp-arabic-font')) {
      var link = document.createElement('link');
      link.id = 'wp-arabic-font';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@300;400;500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }

  function _get(obj, path) {
    if (!obj || !path) return null;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return null;
      cur = cur[parts[i]];
    }
    return cur != null ? String(cur) : null;
  }

  function t(key, vars) {
    var val = _get(_strings, key);
    if (val == null) {
      // Fallback: return the last segment of the key so pages don't show raw keys
      return key.split('.').pop();
    }
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (k) {
        val = val.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
      });
    }
    return val;
  }

  /**
   * Translate a dynamic API-supplied value (e.g. a status code, category, or
   * module name) by looking up `${prefix}.${normalized}`. Normalization
   * lowercases the value and replaces spaces/dashes with underscores.
   * If no translation exists, returns a graceful, prettified fallback of
   * the raw value (e.g. "data_privacy" -> "Data Privacy") so unknown
   * values still render readably in both languages.
   */
  function tDynamic(prefix, value, opts) {
    if (value == null) {
      return (opts && opts.fallback != null) ? String(opts.fallback) : '';
    }
    var raw = String(value);
    var normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    var translated = _get(_strings, prefix + '.' + normalized);
    if (translated != null) return translated;
    if (opts && opts.fallback != null) return String(opts.fallback);
    // Prettify unknown raw value: "data_privacy" -> "Data Privacy"
    return raw
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function applyToDOM(root) {
    var container = root || document;
    container.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      var translated = t(key);
      // Respect data-i18n-attr to set attributes (e.g. placeholder, title)
      var attr = el.getAttribute('data-i18n-attr');
      if (attr) {
        el.setAttribute(attr, translated);
      } else {
        el.textContent = translated;
      }
    });
    // Also handle data-i18n-placeholder shorthand
    container.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    // Also handle data-i18n-title shorthand
    container.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
  }

  function currentLang() {
    return _lang;
  }

  function isRTL() {
    return _lang === 'ar';
  }

  /**
   * Persist language preference: localStorage + server (if authenticated).
   * Does NOT reload automatically — caller must decide.
   */
  function _persistLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    fetch(PREF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ lang: lang })
    }).catch(function () {});
  }

  /**
   * Switch language and reload the page.
   */
  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    _persistLang(lang);
    // Reload to re-apply all templates
    window.location.reload();
  }

  /**
   * Load translation JSON for the given language.
   */
  function _loadStrings(lang) {
    return fetch('/dashboard/i18n/' + lang + '.json?v=1.0', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('i18n load failed: ' + r.status);
        return r.json();
      });
  }

  /**
   * Fetch the user's server-side language preference.
   * Resolves to the language code or null if unauthenticated.
   */
  function _fetchServerPref() {
    return fetch(PREF_ENDPOINT, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.lang ? d.lang : null; })
      .catch(function () { return null; });
  }

  /**
   * Initialize: detect language, load strings, apply to DOM.
   * Returns a Promise that resolves when strings are ready.
   */
  function init() {
    if (_loaded) {
      return Promise.resolve();
    }
    // Load numeral format preference from localStorage
    _loadNumeralPref();
    // Detect local preference first for fast render, then reconcile with server
    var localLang = _detectLang();
    _lang = localLang;
    _applyHtmlDir(_lang);

    return _fetchServerPref()
      .then(function (serverLang) {
        if (serverLang && SUPPORTED.indexOf(serverLang) !== -1 && serverLang !== localLang) {
          _lang = serverLang;
          try { localStorage.setItem(STORAGE_KEY, serverLang); } catch (_) {}
          _applyHtmlDir(_lang);
        }
        return _loadStrings(_lang);
      })
      .then(function (strings) {
        _strings = strings;
        _loaded = true;
        applyToDOM();
        _fireReady();
        return strings;
      })
      .catch(function (err) {
        console.warn('[i18n] Failed to load strings, falling back to en:', err);
        if (_lang !== 'en') {
          return _loadStrings('en').then(function (strings) {
            _strings = strings;
            _loaded = true;
            applyToDOM();
            _fireReady();
          });
        }
      });
  }

  /**
   * Convenience: format a date in both Gregorian and Hijri.
   * Returns { gregorian: string, hijri: string }
   */
  function formatDateBilingual(date) {
    var d = date instanceof Date ? date : new Date(date);
    var gregorian = new Intl.DateTimeFormat(_lang === 'ar' ? 'ar-SA' : 'en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    }).format(d);

    var hijri = '';
    try {
      hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic', {
        year: 'numeric', month: 'long', day: 'numeric'
      }).format(d);
    } catch (_) {
      try {
        hijri = new Intl.DateTimeFormat('ar-SA', {
          calendar: 'islamic',
          year: 'numeric', month: 'long', day: 'numeric'
        }).format(d);
      } catch (_2) {}
    }
    return { gregorian: gregorian, hijri: hijri };
  }

  /**
   * Format a number using locale-appropriate numerals.
   * When language is Arabic and _useEasternNumerals is true, renders ١٢٣ style.
   * Override per-call via the second argument (null = use stored preference).
   */
  function formatNumber(num, overrideEastern) {
    var useEastern = (overrideEastern !== undefined && overrideEastern !== null)
      ? overrideEastern : _useEasternNumerals;
    var locale = (_lang === 'ar' && useEastern) ? 'ar-SA' : 'en-US';
    try {
      return new Intl.NumberFormat(locale).format(num);
    } catch (_) {
      return String(num);
    }
  }

  /**
   * Enable or disable Eastern Arabic numerals (١٢٣ vs 123).
   * Persisted to localStorage and applied immediately without reload.
   */
  function setUseEasternNumerals(enabled) {
    _useEasternNumerals = !!enabled;
    try { localStorage.setItem(NUMERALS_KEY, String(_useEasternNumerals)); } catch (_) {}
    document.dispatchEvent(new CustomEvent('walaPlusNumeralChange', { detail: { eastern: _useEasternNumerals } }));
  }

  /**
   * Return whether Eastern Arabic numerals are currently enabled.
   */
  function getUseEasternNumerals() {
    return _useEasternNumerals;
  }

  /**
   * Fire all onReady callbacks and dispatch 'walaPlusI18nReady' event.
   * Called internally after strings are loaded.
   */
  function _fireReady() {
    _readyCallbacks.forEach(function (cb) { try { cb(); } catch (_) {} });
    _readyCallbacks = [];
    try {
      document.dispatchEvent(new CustomEvent('walaPlusI18nReady'));
    } catch (_) {}
  }

  /**
   * Register a callback to run once i18n strings are loaded.
   * If already loaded, the callback fires immediately.
   */
  function onReady(cb) {
    if (typeof cb !== 'function') return;
    if (_loaded) { try { cb(); } catch (_) {} } else { _readyCallbacks.push(cb); }
  }

  global.WalaPlusI18n = {
    init: init,
    t: t,
    tDynamic: tDynamic,
    setLang: setLang,
    currentLang: currentLang,
    isRTL: isRTL,
    applyToDOM: applyToDOM,
    formatDateBilingual: formatDateBilingual,
    formatNumber: formatNumber,
    setUseEasternNumerals: setUseEasternNumerals,
    getUseEasternNumerals: getUseEasternNumerals,
    onReady: onReady
  };

})(window);
