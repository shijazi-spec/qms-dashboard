(function () {
  function applyOne(el) {
    var raw = el.getAttribute('data-style');
    if (!raw) return;
    var rules = raw.split(';');
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var idx = rule.indexOf(':');
      if (idx === -1) continue;
      var prop = rule.slice(0, idx).trim();
      var val = rule.slice(idx + 1).trim();
      if (!prop) continue;
      try {
        if (prop.indexOf('--') === 0) {
          el.style.setProperty(prop, val);
        } else {
          el.style.setProperty(prop, val);
        }
      } catch (_e) {}
    }
    el.removeAttribute('data-style');
  }

  function applyStyles(root) {
    if (!root) return;
    if (root.nodeType === 1 && root.hasAttribute && root.hasAttribute('data-style')) {
      applyOne(root);
    }
    if (root.querySelectorAll) {
      var nodes = root.querySelectorAll('[data-style]');
      for (var i = 0; i < nodes.length; i++) applyOne(nodes[i]);
    }
  }

  function init() {
    applyStyles(document);
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type === 'childList') {
            for (var j = 0; j < m.addedNodes.length; j++) {
              applyStyles(m.addedNodes[j]);
            }
          } else if (m.type === 'attributes' && m.attributeName === 'data-style') {
            applyOne(m.target);
          }
        }
      });
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-style'],
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.applyDataStyles = applyStyles;
})();
