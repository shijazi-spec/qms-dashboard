(function (global) {
  'use strict';

  var PALETTE = [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#06b6d4',
    '#ec4899',
    '#84cc16',
    '#f97316',
    '#14b8a6',
    '#6366f1',
    '#eab308'
  ];

  function colors(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(PALETTE[i % PALETTE.length]);
    return out;
  }

  function colorFor(i) {
    return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
  }

  function tooltipDefaults() {
    return {
      backgroundColor: 'rgba(17, 24, 39, 0.95)',
      titleColor: '#ffffff',
      bodyColor: '#e5e7eb',
      borderColor: 'rgba(255, 255, 255, 0.08)',
      borderWidth: 1,
      padding: 12,
      cornerRadius: 8,
      titleFont: { weight: '600', size: 13 },
      bodyFont: { size: 12 },
      displayColors: true,
      boxPadding: 6
    };
  }

  function legendDefaults(position) {
    return {
      display: true,
      position: position || 'right',
      labels: {
        usePointStyle: true,
        pointStyle: 'circle',
        padding: 14,
        boxWidth: 8,
        boxHeight: 8,
        font: { size: 12, weight: '500' },
        color: '#374151'
      }
    };
  }

  function pctTooltipCallbacks() {
    return {
      label: function (item) {
        var v = item.parsed;
        var ds = item.dataset && item.dataset.data ? item.dataset.data : [];
        var total = 0;
        for (var i = 0; i < ds.length; i++) total += Number(ds[i]) || 0;
        var pct = total ? ((v / total) * 100).toFixed(1) : '0.0';
        var label = item.label || '';
        return label + ': ' + Number(v).toLocaleString() + ' (' + pct + '%)';
      }
    };
  }

  /**
   * Build a clean doughnut config with distinct slice colors, white separators,
   * hover lift, and percentage tooltips. Pass overrides to merge.
   */
  function doughnutConfig(opts) {
    opts = opts || {};
    var labels = opts.labels || [];
    var data = opts.data || [];
    var palette = opts.colors || colors(labels.length);
    var legendPos = opts.legendPosition || 'right';

    var cfg = {
      type: opts.type || 'doughnut',
      <REDACTED_SCHEME> {
        labels: labels,
        datasets: [{
          <REDACTED_SCHEME> data,
          backgroundColor: palette,
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 10,
          hoverBorderWidth: 3,
          hoverBorderColor: '#ffffff',
          spacing: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: opts.cutout || '62%',
        animation: { duration: 600, easing: 'easeOutQuart' },
        layout: { padding: 6 },
        plugins: {
          legend: opts.legend === false ? { display: false } : legendDefaults(legendPos),
          tooltip: Object.assign({}, tooltipDefaults(), {
            callbacks: pctTooltipCallbacks()
          })
        }
      }
    };

    if (opts.extendOptions && typeof opts.extendOptions === 'object') {
      cfg.options = Object.assign({}, cfg.options, opts.extendOptions);
    }
    return cfg;
  }

  global.ExampleOrgChartTheme = {
    PALETTE: PALETTE,
    colors: colors,
    colorFor: colorFor,
    tooltipDefaults: tooltipDefaults,
    legendDefaults: legendDefaults,
    pctTooltipCallbacks: pctTooltipCallbacks,
    doughnutConfig: doughnutConfig
  };
})(window);
