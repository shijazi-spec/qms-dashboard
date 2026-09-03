/**
 * safe-render.js — Shared safe DOM rendering helpers
 *
 * RULE: Never use .innerHTML with API/user-controlled data.
 * Use these helpers or .textContent for all dynamic content.
 *
 * Safe patterns:
 *   el.textContent = value;              // always safe for plain text
 *   SafeRender.setText(el, value);       // same as textContent
 *   SafeRender.escape(str);              // HTML-escape for template literals
 *   SafeRender.setHtml(el, trustedHtml); // only for STATIC trusted markup
 *   SafeRender.appendText(parent, tag, text, className); // create+append element
 *
 * NEVER do:
 *   el.innerHTML = apiData;              // stored XSS risk
 *   el.innerHTML = `<span>${apiData}</span>`; // stored XSS risk
 */

(function(global) {
  'use strict';

  var SafeRender = {

    /**
     * HTML-escape a string so it is safe to embed in a template literal
     * used with .innerHTML.  Prefer .textContent wherever possible.
     */
    escape: function(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /**
     * Safely set the text content of an element (never interprets HTML).
     */
    setText: function(el, value) {
      if (!el) return;
      el.textContent = (value === null || value === undefined) ? '' : String(value);
    },

    /**
     * Validate that a value is a safe non-negative integer (e.g. a DB row ID).
     * Returns the integer, or null if invalid.
     */
    safeInt: function(value) {
      var n = parseInt(value, 10);
      return (Number.isFinite(n) && n >= 0 && String(n) === String(value)) ? n : null;
    },

    /**
     * Validate that a string belongs to a known allowlist.
     * Returns the value if allowed, or the fallback otherwise.
     */
    allow: function(value, allowedValues, fallback) {
      var str = String(value || '');
      return allowedValues.indexOf(str) !== -1 ? str : (fallback !== undefined ? fallback : '');
    },

    /**
     * Create a DOM element with safe text content and optional class name,
     * then append it to a parent element.
     * @returns the created element
     */
    appendText: function(parent, tagName, text, className) {
      var el = document.createElement(tagName);
      if (className) el.className = className;
      el.textContent = (text === null || text === undefined) ? '' : String(text);
      if (parent) parent.appendChild(el);
      return el;
    },

    /**
     * Clear all children of an element and add a single safe text paragraph.
     */
    setEmptyMessage: function(el, message) {
      if (!el) return;
      el.textContent = '';
      var p = document.createElement('p');
      p.className = 'text-center text-sm text-gray-400 py-4';
      p.textContent = message || 'No items';
      el.appendChild(p);
    },

    /**
     * setHtml — use ONLY for trusted, statically-authored markup.
     * Calling this with API data is a stored XSS vulnerability.
     * Prefer building the DOM with createElement + textContent instead.
     */
    setHtml: function(el, trustedStaticHtml) {
      if (!el) return;
      el.innerHTML = trustedStaticHtml;
    }
  };

  global.SafeRender = SafeRender;

})(window);
