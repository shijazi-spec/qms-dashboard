/**
 * Shared resolution-category helper for ai_alerts rows (Task #346).
 *
 * Categorises a resolved alert into one of four buckets so the AI Ops and
 * consultant dashboards render visually distinct badges per source:
 *
 *   - "recovered"               → tool-health metric returned below threshold
 *                                 (note prefix "auto-resolved: error rate" or
 *                                  "auto-resolved: p95 latency")
 *   - "went_silent"             → tool-health silent-tool sweep auto-closed
 *                                 the alert because the tool stopped being
 *                                 called (note prefix "auto-resolved: tool
 *                                 went silent")
 *   - "prompt_regression_auto"  → prompt-regression cron auto-cleared the
 *                                 alert (note prefix "auto-resolved: prompt
 *                                 regression")
 *   - "manual"                  → resolved row with no "auto-resolved:" prefix
 *                                 (i.e. an operator clicked Resolve)
 *
 * Anything else (open / acknowledged / dismissed) returns null.
 *
 * The categoriser is exposed on window.ExampleOrgAlertResolution so both
 * dashboard pages can share the exact same prefix logic. Keep this file in
 * lock-step with src/mastra/workflows/{toolHealthAlertsCron,promptRegressionAlertsCron}.ts
 * — those crons own the canonical resolution_note prefixes that this helper
 * pattern-matches against.
 */
(function (root) {
  function normalize(note) {
    return String(note == null ? '' : note).trim().toLowerCase();
  }

  function categorize(alert) {
    if (!alert || alert.status !== 'resolved') return null;
    var note = normalize(alert.resolution_note);
    if (note.indexOf('auto-resolved:') !== 0) return 'manual';
    if (note.indexOf('auto-resolved: tool went silent') === 0) return 'went_silent';
    if (note.indexOf('auto-resolved: error rate') === 0) return 'recovered';
    if (note.indexOf('auto-resolved: p95 latency') === 0) return 'recovered';
    if (note.indexOf('auto-resolved: prompt regression') === 0) return 'prompt_regression_auto';
    // Unknown auto-resolved variant — treat as a generic recovery so it
    // still gets the green pill rather than falling through to "manual".
    return 'recovered';
  }

  function isAutoResolved(alert) {
    var c = categorize(alert);
    return c !== null && c !== 'manual';
  }

  // Per-category badge spec. `slug` is used in data-testid attributes so
  // tests can pin a category without hard-coding the visual classes.
  var BADGES = {
    recovered: {
      slug: 'recovered',
      text: 'Recovered',
      classes: 'bg-green-100 text-green-800 border border-green-300',
      defaultTooltip: 'Auto-resolved by the recovery cron — metric returned below threshold.',
    },
    went_silent: {
      slug: 'went-silent',
      text: 'Tool went silent',
      classes: 'bg-teal-100 text-teal-800 border border-teal-200',
      defaultTooltip: 'Auto-resolved by the silent-tool sweep — no calls in the cooldown window.',
    },
    prompt_regression_auto: {
      slug: 'prompt-regression',
      text: 'Prompt regression cleared',
      classes: 'bg-purple-100 text-purple-700 border border-purple-200',
      defaultTooltip: 'Auto-resolved by the prompt-regression cron.',
    },
    manual: {
      slug: 'manual',
      text: 'Manual',
      classes: 'bg-gray-100 text-gray-700 border border-gray-200',
      defaultTooltip: 'Closed by an operator.',
    },
  };

  function getBadgeSpec(category) {
    return BADGES[category] || null;
  }

  function isRecoveryCategory(category) {
    return category === 'recovered' || category === 'went_silent';
  }

  root.ExampleOrgAlertResolution = {
    categorize: categorize,
    isAutoResolved: isAutoResolved,
    getBadgeSpec: getBadgeSpec,
    isRecoveryCategory: isRecoveryCategory,
    BADGES: BADGES,
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
