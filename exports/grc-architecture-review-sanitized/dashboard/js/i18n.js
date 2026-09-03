/**
 * ExampleOrg i18n Module — Phase 1
 * Lightweight client-side internationalization with Arabic/RTL support.
 *
 * Usage:
 *   ExampleOrgI18n.init().then(() => { ... })
 *   ExampleOrgI18n.t('nav.brand')
 *   ExampleOrgI18n.t('executive.health_labels.excellent')
 *   ExampleOrgI18n.setLang('ar')  // persists + reloads
 *
 * Adding a new page:
 *   1. Add your keys to dashboard/i18n/en.json and dashboard/i18n/ar.json
 *   2. Add data-i18n="your.key" attributes to your HTML elements
 *   3. Call ExampleOrgI18n.applyToDOM() after the module is initialized
 */

/**
 * Platform-wide rate-limit (429) auto-retry — installed once, covers every
 * section because i18n.js loads on every page before other scripts fetch.
 *
 * The API rate limiter rejects a request BEFORE the handler runs and returns
 * 429 + a Retry-After header, so retrying is always safe — nothing was created
 * or mutated. We transparently retry such requests a few times with a short,
 * capped backoff (the sliding window frees per-second buckets), so no screen
 * ever surfaces "Too many requests" during normal use. Anything that is NOT a
 * limiter 429 (no Retry-After — e.g. an app-level cooldown) passes straight
 * through untouched. Request-object inputs are not retried (their body can only
 * be read once); the whole codebase calls fetch(url, {..}) so this is a no-op
 * guard, not a gap.
 */
(function () {
  if (typeof window === 'undefined' || window.__wpFetchRetryInstalled) return;
  if (typeof window.fetch !== 'function') return;
  window.__wpFetchRetryInstalled = true;
  var _origFetch = window.fetch.bind(window);
  var MAX_RETRIES = 4;
  window.fetch = function (input, init) {
    var isRequestObj = (typeof Request !== 'undefined') && (input instanceof Request);
    var attempt = 0;
    function tryOnce() {
      return _origFetch(input, init).then(function (res) {
        if (res.status !== 429 || attempt >= MAX_RETRIES || isRequestObj) return res;
        var retryAfter = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
        if (!retryAfter) return res; // not a rate-limiter 429 — leave it alone
        attempt++;
        var waitMs = Math.min(2000, 300 * attempt + Math.floor(Math.random() * 200));
        return new Promise(function (resolve) { setTimeout(resolve, waitMs); }).then(tryOnce);
      });
    }
    return tryOnce();
  };
})();

(function (global) {
  'use strict';

  var STORAGE_KEY = 'ExampleOrg_lang';
  var NUMERALS_KEY = 'ExampleOrg_eastern_numerals';
  // Tracks a language change that has been written to localStorage but has
  // not yet been confirmed-persisted on the server (offline, 5xx, etc.).
  // Shape: { lang: 'en'|'ar', timestamp: <ms epoch> }. Cleared once the
  // server returns a 2xx for the matching lang.
  var PENDING_KEY = 'ExampleOrg_lang_pending';
  var DEFAULT_LANG = 'en';
  var SUPPORTED = ['en', 'ar'];
  var PREF_ENDPOINT = '/api/user/language-preference';

  var _lang = DEFAULT_LANG;
  var _strings = {};
  var _loaded = false;
  var _readyCallbacks = [];
  var _useEasternNumerals = true;
  var _retryInFlight = false;
  var _onlineHandlerBound = false;

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
      link.href = '<REDACTED_URL>';
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
   * Read the pending (unsynced) language marker from localStorage.
   * Returns null if absent, malformed, or holds an unsupported lang.
   */
  function _readPending() {
    try {
      var raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.lang === 'string' && SUPPORTED.indexOf(parsed.lang) !== -1) {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  function _writePending(lang) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ lang: lang, timestamp: Date.now() }));
    } catch (_) {}
  }

  function _clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }

  /**
   * POST the language preference once. Resolves to `true` on a 2xx response
   * (and clears the pending marker, but ONLY when it still matches `lang` —
   * this prevents an older successful response from racing past and clearing
   * a newer pending write). Resolves to `false` on any failure (network
   * error, non-2xx). The caller decides whether to retry.
   */
  function _postLang(lang) {
    return fetch(PREF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: <REDACTED_SECRET>
      body: JSON.stringify({ lang: lang })
    }).then(function (r) {
      if (r && r.ok) {
        var pending = _readPending();
        if (pending && pending.lang === lang) {
          _clearPending();
        }
        return true;
      }
      return false;
    }, function () {
      return false;
    });
  }

  /**
   * Persist language preference: localStorage + server (if authenticated).
   * Records a "pending" marker before the network call so that, if the
   * request fails (offline, 5xx, network drop), a later init() or `online`
   * event can retry until the server matches localStorage.
   * Returns a Promise that resolves once the server request settles (or fails).
   * Does NOT reload automatically — caller must decide.
   */
  function _persistLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    _writePending(lang);
    _bindOnlineRetry();
    return _postLang(lang);
  }

  /**
   * Retry a previously-failed language persist, if one is pending. Safe to
   * call repeatedly; concurrent calls are coalesced via _retryInFlight.
   * Returns a Promise resolving to `true` on success, `false` otherwise
   * (including when there is no pending write).
   */
  function _retryPendingLang() {
    if (_retryInFlight) return Promise.resolve(false);
    var pending = _readPending();
    if (!pending) return Promise.resolve(false);
    _retryInFlight = true;
    return _postLang(pending.lang).then(function (ok) {
      _retryInFlight = false;
      return ok;
    }, function () {
      _retryInFlight = false;
      return false;
    });
  }

  /**
   * Bind an `online` listener once so that a failed persist is retried
   * automatically the moment the browser regains connectivity.
   */
  function _bindOnlineRetry() {
    if (_onlineHandlerBound) return;
    if (typeof window === 'undefined' || !window.addEventListener) return;
    _onlineHandlerBound = true;
    window.addEventListener('online', function () { _retryPendingLang(); });
  }

  /**
   * Switch language, wait for the server to acknowledge, then reload the page.
   * Awaiting the persist call eliminates the race where the old server-side
   * preference was returned on the next page load before the write completed.
   * A 5-second timeout ensures the page always reloads, even if the server
   * stalls or is unreachable (localStorage is already updated, so the correct
   * language will be applied on reload regardless).
   */
  function setLang(lang, onBusy) {
    if (SUPPORTED.indexOf(lang) === -1) return;
    if (typeof onBusy === 'function') {
      try { onBusy(true); } catch (_) {}
    }
    var previous = _lang;
    // Load the new dictionary and swap in-memory locale state BEFORE we
    // emit `ExampleOrgLanguageChange`, so any subscriber that re-renders
    // (KPI list, charts on risks/vendors/compliance) reads the new
    // strings via the translator instead of the previous bundle. The
    // page reload still follows so persisted DOM and server preference
    // catch up, but the live relabeling works without waiting on it.
    var loadTimeout = new Promise(function (resolve) { setTimeout(resolve, 5000); });
    var swapped = Promise.race([_loadStrings(lang), loadTimeout]).then(function (strings) {
      if (!strings) return; // load timed out — let reload below pick up the new locale
      _strings = strings;
      _lang = lang;
      try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
      _applyHtmlDir(_lang);
      try { applyToDOM(); } catch (_) {}
      try {
        document.dispatchEvent(new CustomEvent('ExampleOrgLanguageChange', {
          detail: { lang: lang, previous: previous }
        }));
      } catch (_) {}
    }).catch(function () { /* fall through to reload-only path */ });

    var persistTimeout = new Promise(function (resolve) { setTimeout(resolve, 5000); });
    Promise.all([swapped, Promise.race([_persistLang(lang), persistTimeout])]).then(function () {
      window.location.reload();
    });
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
    return fetch(PREF_ENDPOINT, { credentials: '<REDACTED_SECRET>' })
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

    // If a previous setLang() couldn't reach the server (offline / 5xx), the
    // server still holds the stale language. Keep retrying in the background
    // until the server matches localStorage, and ensure connectivity-restored
    // events also trigger a retry.
    var pending = _readPending();
    if (pending) {
      _bindOnlineRetry();
      _retryPendingLang();
    }

    return _fetchServerPref()
      .then(function (serverLang) {
        // When a pending unsynced write exists, the server value is stale by
        // definition — trust localStorage and let the background retry catch
        // the server up. Otherwise, prefer the server value as the source of
        // truth across devices.
        var hasPendingForLocal = pending && pending.lang === localLang;
        if (
          !hasPendingForLocal &&
          serverLang &&
          SUPPORTED.indexOf(serverLang) !== -1 &&
          serverLang !== localLang
        ) {
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
   * Format a date in the active locale, with Eastern Arabic numerals when appropriate.
   * `opts` accepts standard Intl.DateTimeFormat options (year/month/day/hour/minute/...).
   * Returns '-' for falsy or invalid dates so it can be dropped into table cells safely.
   */
  function _localTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
    catch (_) { return undefined; }
  }

  function formatDate(date, opts) {
    if (date == null || date === '') return '-';
    var d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '-';
    var useEastern = _useEasternNumerals;
    var locale = (_lang === 'ar' && useEastern) ? 'ar-SA'
      : (_lang === 'ar' ? 'ar' : 'en-US');
    var options = opts || { year: 'numeric', month: 'short', day: 'numeric' };
    if (!options.timeZone) options.timeZone = _localTimeZone();
    try {
      return new Intl.DateTimeFormat(locale, options).format(d);
    } catch (_) {
      try { return d.toLocaleDateString(); } catch (__) { return String(date); }
    }
  }

  function formatDateTime(date, opts) {
    var options = opts || {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    };
    return formatDate(date, options);
  }

  function formatTime(date, opts) {
    var options = opts || { hour: '2-digit', minute: '2-digit' };
    return formatDate(date, options);
  }

  /**
   * Enable or disable Eastern Arabic numerals (١٢٣ vs 123).
   * Persisted to localStorage and applied immediately without reload.
   */
  function setUseEasternNumerals(enabled) {
    _useEasternNumerals = !!enabled;
    try { localStorage.setItem(NUMERALS_KEY, String(_useEasternNumerals)); } catch (_) {}
    document.dispatchEvent(new CustomEvent('ExampleOrgNumeralChange', { detail: { eastern: _useEasternNumerals } }));
  }

  /**
   * Return whether Eastern Arabic numerals are currently enabled.
   */
  function getUseEasternNumerals() {
    return _useEasternNumerals;
  }

  /**
   * Fire all onReady callbacks and dispatch 'ExampleOrgI18nReady' event.
   * Called internally after strings are loaded.
   */
  function _fireReady() {
    _readyCallbacks.forEach(function (cb) { try { cb(); } catch (_) {} });
    _readyCallbacks = [];
    try {
      document.dispatchEvent(new CustomEvent('ExampleOrgI18nReady'));
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

  global.ExampleOrgI18n = {
    init: init,
    t: t,
    tDynamic: tDynamic,
    setLang: setLang,
    currentLang: currentLang,
    isRTL: isRTL,
    applyToDOM: applyToDOM,
    formatDateBilingual: formatDateBilingual,
    formatDate: formatDate,
    formatDateTime: formatDateTime,
    formatTime: formatTime,
    formatNumber: formatNumber,
    setUseEasternNumerals: setUseEasternNumerals,
    getUseEasternNumerals: getUseEasternNumerals,
    onReady: onReady
  };

})(window);
