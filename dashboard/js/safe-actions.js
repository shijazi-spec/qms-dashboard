/**
 * safe-actions.js — CSP-safe inline event handler replacement.
 *
 * The dashboard CSP no longer allows `script-src 'unsafe-inline'`, so
 * `onclick="..."`, `onchange="..."`, etc. are silently blocked by browsers. // csp-safe-inline-handler: JSDoc comment text, not actual attributes
 * This module wires up a single delegated listener per event type that reads
 * `data-on-{event}` attributes and invokes the named function from a strict
 * allowlist registry, never from arbitrary global scope.
 *
 * Usage:
 *   <button data-on-click="loadFeedback">Refresh</button>
 *   <button data-on-click="setRating" data-args="[3]">3 stars</button>
 *   <button data-on-click="closeModal" data-args="[&quot;myModal&quot;]">X</button>
 *   <form data-on-submit="submitFeedback" data-pass-event="true">…</form>
 *
 * `data-args` is a JSON array. For multiple sequenced calls on one element,
 * use comma-separated function names and a nested array of args:
 *   <a data-on-click="closeModal,showDetail" data-args="[[],[42]]">go</a>
 *
 * `data-pass-event="true"` appends the DOM event as the last argument.
 *
 * For `submit` events, `event.preventDefault()` is called automatically.
 *
 * Security model:
 *   Only functions registered via SafeActions.register() or SafeActions.registerAll()
 *   can be invoked through data-on-* attributes. The registry is populated at
 *   DOMContentLoaded time from page-defined (non-native) globals, freezing the
 *   callable set before any user-supplied HTML can be injected. Native browser
 *   functions (fetch, eval, XMLHttpRequest, etc.) are never registered.
 */
(function (global) {
  'use strict';

  var BUBBLING_EVENTS = [
    'click', 'change', 'submit', 'input', 'keyup', 'keydown', 'keypress',
    'mouseover', 'mouseout', 'mousedown', 'mouseup', 'dblclick'
  ];
  // Focus/blur do not bubble; use focusin/focusout instead.
  var FOCUS_ALIASES = { focus: 'focusin', blur: 'focusout' };

  // Strict allowlist: only functions explicitly registered here can be dispatched.
  var registry = Object.create(null);

  function parseArgs(el) {
    var raw = el.getAttribute('data-args');
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      try { console.warn('safe-actions: invalid data-args', raw, e); } catch (_) {}
      return [];
    }
  }

  /**
   * Resolve special "@..." string tokens against the live element/event.
   * Supported tokens (used by the migration script for inline `this.x` refs):
   *   "@this"             -> the element with the data-on-* attribute
   *   "@this.value"       -> .value
   *   "@this.checked"     -> .checked
   *   "@this.dataset.foo" -> .dataset.foo
   *   "@event"            -> the DOM event
   *   "@event.target.value" etc.
   */
  function resolveTokens(args, el, event) {
    if (!args || !args.length) return args;
    return args.map(function (a) {
      if (typeof a !== 'string' || a.charAt(0) !== '@') return a;
      var path = a.slice(1).split('.');
      var root = path[0] === 'this' ? el : (path[0] === 'event' ? event : undefined);
      if (root === undefined) return a;
      var v = root;
      for (var i = 1; i < path.length; i++) {
        if (v == null) return undefined;
        v = v[path[i]];
      }
      return v;
    });
  }

  function isNativeFn(fn) {
    try {
      return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
    } catch (_) {
      return true;
    }
  }

  /**
   * Resolve a function name against the strict registry only.
   * Dot-notation (e.g. "ns.method") traverses from the top-level registry key.
   */
  function resolveFn(name) {
    if (!name) return null;
    var parts = String(name).split('.');
    var key = parts[0];

    if (!Object.prototype.hasOwnProperty.call(registry, key)) {
      try { console.warn('safe-actions: function not registered', name); } catch (_) {}
      return null;
    }

    var fn = registry[key];
    var ctx = registry;
    for (var i = 1; i < parts.length; i++) {
      ctx = fn;
      fn = fn && fn[parts[i]];
      if (fn === undefined || fn === null) return null;
    }
    return typeof fn === 'function' ? { fn: fn, ctx: ctx } : null;
  }

  function callOne(name, args) {
    var resolved = resolveFn(name);
    if (!resolved) {
      try { console.warn('safe-actions: function not found or not registered', name); } catch (_) {}
      return;
    }
    try {
      resolved.fn.apply(resolved.ctx, args || []);
    } catch (err) {
      try { console.error('safe-actions: error in', name, err); } catch (_) {}
    }
  }

  function dispatch(eventName, e) {
    var attr = 'data-on-' + eventName;
    var target = e.target && e.target.closest ? e.target.closest('[' + attr + ']') : null;
    if (!target) return;

    var spec = target.getAttribute(attr);
    if (!spec) return;

    if (eventName === 'submit') {
      try { e.preventDefault(); } catch (_) {}
    }

    var passEvent = target.hasAttribute('data-pass-event');
    var args = parseArgs(target);

    if (spec.indexOf(',') === -1) {
      var callArgs = resolveTokens(args.slice(), target, e);
      if (passEvent) callArgs.push(e);
      callOne(spec, callArgs);
      return;
    }

    var fns = spec.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var nested = fns.length > 0 && args.length === fns.length && Array.isArray(args[0]);
    fns.forEach(function (fnName, idx) {
      var fnArgs = nested ? resolveTokens((args[idx] || []).slice(), target, e) : [];
      if (passEvent) fnArgs.push(e);
      callOne(fnName, fnArgs);
    });
  }

  function bind(eventName) {
    var listenName = FOCUS_ALIASES[eventName] || eventName;
    document.addEventListener(listenName, function (e) { dispatch(eventName, e); }, true);
  }

  /**
   * Scan `ns` and register every non-native own function into the allowlist.
   * Called at init time with `global` to capture page-defined handlers before
   * any dynamic HTML is injected. Native browser APIs are never registered.
   */
  function registerAllFrom(ns) {
    for (var key in ns) {
      try {
        var val = ns[key];
        if (typeof val === 'function' && !isNativeFn(val)) {
          if (!Object.prototype.hasOwnProperty.call(registry, key)) {
            registry[key] = val;
          }
        }
      } catch (_) {}
    }
  }

  function init() {
    // Freeze the callable set to functions already defined at DOMContentLoaded.
    // innerHTML-injected markup added later cannot introduce new window functions,
    // so attacker-supplied data-on-* attributes cannot invoke arbitrary globals.
    registerAllFrom(global);
    BUBBLING_EVENTS.forEach(bind);
    bind('focus');
    bind('blur');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.SafeActions = {
    /** Invoke a registered handler by name (used by pages that need programmatic dispatch). */
    call: function (name, args) { callOne(name, args || []); },
    /**
     * Explicitly register a single handler under the given name.
     * Accepts a function (regular handler) OR a plain namespace object whose
     * own function properties become callable via dotted notation
     * (e.g. register('Nav', NavObj) → data-on-click="Nav.signOut").
     */
    register: function (name, value) {
      if (typeof value === 'function' && !isNativeFn(value)) {
        registry[name] = value;
        return;
      }
      // Namespace object: must be a plain (non-array, non-DOM, non-window) object.
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value !== global &&
        typeof value.nodeType !== 'number'
      ) {
        registry[name] = value;
      }
    },
    /** Register all non-native functions from a namespace object into the allowlist. */
    registerAll: function (ns) { registerAllFrom(ns); }
  };

  // Convenience helpers exposed for inline-handler migrations that previously
  // performed simple navigation or DOM toggling directly inside on{event}=.
  if (typeof global.navigateTo !== 'function') {
    global.navigateTo = function (url) { if (url) global.location.href = url; };
  }
  if (typeof global.openInNewTab !== 'function') {
    global.openInNewTab = function (url) { if (url) global.open(url, '_blank'); };
  }
  if (typeof global.toggleClass !== 'function') {
    global.toggleClass = function (id, className) {
      var el = global.document.getElementById(id);
      if (el) el.classList.toggle(className);
    };
  }
  if (typeof global.addClass !== 'function') {
    global.addClass = function (id, className) {
      var el = global.document.getElementById(id);
      if (el) el.classList.add(className);
    };
  }
  if (typeof global.removeClass !== 'function') {
    global.removeClass = function (id, className) {
      var el = global.document.getElementById(id);
      if (el) el.classList.remove(className);
    };
  }
  if (typeof global.clickElement !== 'function') {
    global.clickElement = function (id) {
      var el = global.document.getElementById(id);
      if (el) el.click();
    };
  }
  // HTML-attribute escape: used by pages that build `data-args` strings inline.
  if (typeof global.escAttr !== 'function') {
    global.escAttr = function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    };
  }
})(window);
