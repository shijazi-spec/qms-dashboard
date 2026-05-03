/**
 * Tests for evaluateAndAlertStorageHealth (Task #546).
 *
 * Verifies:
 *   1. When stats.exceedsRetention is true and no open alert exists yet,
 *      a single high-severity ai_alerts row is created and Slack/email/
 *      in-app notifications fire (when their env vars are set).
 *   2. When stats.exceedsRetention is true but an open alert already
 *      exists, no second alert and no notifications are emitted —
 *      multi-day backlog is deduped.
 *   3. When stats.exceedsRetention flips back to false, every previously
 *      open alert is auto-resolved with a recovery note and a low-
 *      severity recovery notification fires once.
 *   4. Slack/email are skipped silently when their env vars are absent.
 *   5. A failing dedupe check fails closed (no alert, no page) so a
 *      transient DB hiccup cannot spam the channel.
 *
 * Run:  npx tsx tests/storageHealthAlerts.test.ts
 */

import { TestSuite } from './_helpers/runner';
import {
  buildStorageHealthMessage,
  evaluateAndAlertStorageHealth,
  isInQuietHours,
  repageStaleStorageHealthAlerts,
  resolveQuietHoursWindow,
  resolveRepageAfterMinutes,
  STORAGE_HEALTH_DEDUPE_KEY,
  STORAGE_HEALTH_REPAGE_DEFAULT_MIN,
  type StorageHealthAlertDeps,
  type StorageHealthRepageDeps,
} from '../src/utils/storageHealthAlerts';
import type { AiMetricsTableStats } from '../src/utils/aiTelemetry';
import type { AIAlert } from '../src/utils/aiAlertsDatabase';

interface CreatedAlertRecord {
  alert_type: string;
  severity: string;
  title: string;
  description: string;
  related_record_id?: string;
  related_module?: string;
}

interface NotificationRecord {
  type: string;
  title: string;
  message: string;
  severity: string;
}

interface SlackRecord {
  webhookUrl: string;
  text: string;
}

interface EmailRecord {
  to: string[];
  subject: string;
  html: string;
}

interface ResolvedRecord {
  id: number;
  note: string;
}

interface Harness {
  deps: StorageHealthAlertDeps;
  createdAlerts: CreatedAlertRecord[];
  notifications: NotificationRecord[];
  slacks: SlackRecord[];
  emails: EmailRecord[];
  resolved: ResolvedRecord[];
  setOpenAlerts: (alerts: AIAlert[]) => void;
  setOpenAlertExists: (exists: boolean) => void;
  setDedupeFailure: (err: Error | null) => void;
  setSlackOk: (ok: boolean) => void;
  setEmailOk: (ok: boolean) => void;
  setNow: (now: Date) => void;
}

function makeHarness(env: NodeJS.ProcessEnv, initialNow?: Date): Harness {
  const createdAlerts: CreatedAlertRecord[] = [];
  const notifications: NotificationRecord[] = [];
  const slacks: SlackRecord[] = [];
  const emails: EmailRecord[] = [];
  const resolved: ResolvedRecord[] = [];

  let openAlertExists = false;
  let openAlerts: AIAlert[] = [];
  let dedupeFailure: Error | null = null;
  let slackOk = true;
  let emailOk = true;
  let now = initialNow ?? new Date('2026-04-25T12:00:00.000Z');

  const deps: StorageHealthAlertDeps = {
    openAlertExistsByKey: async (alertType, relatedRecordId) => {
      if (alertType !== 'storage_health') {
        throw new Error(`unexpected alertType ${alertType}`);
      }
      if (relatedRecordId !== STORAGE_HEALTH_DEDUPE_KEY) {
        throw new Error(`unexpected relatedRecordId ${relatedRecordId}`);
      }
      if (dedupeFailure) throw dedupeFailure;
      return openAlertExists;
    },
    createAIAlert: async (input) => {
      createdAlerts.push({
        alert_type: input.alert_type,
        severity: input.severity,
        title: input.title,
        description: input.description,
        related_record_id: input.related_record_id,
        related_module: input.related_module,
      });
      return {
        id: createdAlerts.length,
        alert_type: input.alert_type,
        severity: input.severity,
        title: input.title,
        description: input.description,
        status: 'open',
      } as AIAlert;
    },
    getOpenAlertsByKey: async (alertType, relatedRecordId) => {
      if (alertType !== 'storage_health') {
        throw new Error(`unexpected alertType ${alertType}`);
      }
      if (relatedRecordId !== STORAGE_HEALTH_DEDUPE_KEY) {
        throw new Error(`unexpected relatedRecordId ${relatedRecordId}`);
      }
      return openAlerts;
    },
    resolveAlert: async (id, note) => {
      resolved.push({ id, note });
      return { id, status: 'resolved' } as AIAlert;
    },
    createNotification: async (input) => {
      notifications.push({
        type: input.type,
        title: input.title,
        message: input.message,
        severity: input.severity,
      });
      return {};
    },
    sendSlack: async (webhookUrl, text) => {
      slacks.push({ webhookUrl, text });
      return slackOk;
    },
    sendEmail: async ({ to, subject, html }) => {
      emails.push({ to, subject, html });
      return emailOk;
    },
    env,
    now: () => now,
  };

  return {
    deps,
    createdAlerts,
    notifications,
    slacks,
    emails,
    resolved,
    setOpenAlerts: (alerts) => {
      openAlerts = alerts;
    },
    setOpenAlertExists: (exists) => {
      openAlertExists = exists;
    },
    setDedupeFailure: (err) => {
      dedupeFailure = err;
    },
    setSlackOk: (ok) => {
      slackOk = ok;
    },
    setEmailOk: (ok) => {
      emailOk = ok;
    },
    setNow: (next) => {
      now = next;
    },
  };
}

const breachingStats: AiMetricsTableStats = {
  rowCount: 12_400,
  oldestStartedAt: '2025-01-01T00:00:00.000Z',
  oldestAgeDays: 120.4,
  retentionDays: 90,
  exceedsRetention: true,
  lastPrune: {
    ranAt: '2026-04-25T06:00:00.000Z',
    retentionDays: 90,
    rowsDeleted: 0,
    durationMs: 12,
    success: true,
    errorMessage: null,
  },
};

const recoveredStats: AiMetricsTableStats = {
  ...breachingStats,
  oldestAgeDays: 60,
  exceedsRetention: false,
};

const suite = new TestSuite('storageHealthAlerts');

await suite.test(
  'opens a single high-severity alert + Slack/email/in-app on first breach',
  async () => {
    const harness = makeHarness({
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
      AI_COST_ALERT_EMAIL: 'ops@example.com,oncall@example.com',
    });
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(result.alertCreated, 'alertCreated should be true');
    suite.expect(!result.alertDeduped, 'alertDeduped should be false');
    suite.expectEqual(result.alertsResolved, 0, 'alertsResolved');
    suite.expect(result.slackSent, 'slackSent should be true');
    suite.expect(result.emailSent, 'emailSent should be true');
    suite.expect(result.inAppCreated, 'inAppCreated should be true');

    suite.expectEqual(harness.createdAlerts.length, 1, 'exactly one ai_alerts row');
    const alert = harness.createdAlerts[0];
    suite.expectEqual(alert.alert_type, 'storage_health', 'alert_type');
    suite.expectEqual(alert.severity, 'high', 'severity');
    suite.expectEqual(
      alert.related_record_id,
      STORAGE_HEALTH_DEDUPE_KEY,
      'related_record_id',
    );
    suite.expectEqual(alert.related_module, 'ai_ops', 'related_module');
    suite.expect(
      alert.title.includes('outgrowing prune window'),
      `title should mention prune window — got: ${alert.title}`,
    );
    suite.expect(
      alert.description.includes('120.4'),
      `description should include oldest age — got: ${alert.description}`,
    );

    suite.expectEqual(harness.slacks.length, 1, 'one Slack call');
    suite.expectEqual(
      harness.slacks[0].webhookUrl,
      'https://hooks.example/abc',
      'slack webhook',
    );

    suite.expectEqual(harness.emails.length, 1, 'one email call');
    suite.expectEqual(
      harness.emails[0].to.join(','),
      'ops@example.com,oncall@example.com',
      'email recipients',
    );
    suite.expect(
      harness.emails[0].subject.includes('Storage Alert'),
      `email subject — got: ${harness.emails[0].subject}`,
    );

    suite.expectEqual(harness.notifications.length, 1, 'one in-app notification');
    suite.expectEqual(harness.notifications[0].severity, 'high', 'in-app severity');
  },
);

await suite.test(
  'dedupes when an open alert already exists for the key',
  async () => {
    const harness = makeHarness({
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
      AI_COST_ALERT_EMAIL: 'ops@example.com',
    });
    harness.setOpenAlertExists(true);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(!result.alertCreated, 'alertCreated should be false');
    suite.expect(result.alertDeduped, 'alertDeduped should be true');
    suite.expect(!result.slackSent, 'slackSent should be false');
    suite.expect(!result.emailSent, 'emailSent should be false');
    suite.expect(!result.inAppCreated, 'inAppCreated should be false');

    suite.expectEqual(harness.createdAlerts.length, 0, 'no ai_alerts row created');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack calls');
    suite.expectEqual(harness.emails.length, 0, 'no email calls');
    suite.expectEqual(harness.notifications.length, 0, 'no in-app notifications');
  },
);

await suite.test(
  'fails closed when the dedupe check throws (no alert, no page)',
  async () => {
    const harness = makeHarness({
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
    });
    harness.setDedupeFailure(new Error('connection refused'));

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(!result.alertCreated, 'alertCreated should be false');
    suite.expect(result.alertDeduped, 'alertDeduped should be true (fail-closed)');
    suite.expectEqual(harness.createdAlerts.length, 0, 'no ai_alerts row');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack calls');
  },
);

await suite.test(
  'auto-resolves every open storage_health alert when retention recovers',
  async () => {
    const harness = makeHarness({});
    harness.setOpenAlerts([
      { id: 11, status: 'open' } as AIAlert,
      { id: 22, status: 'acknowledged' } as AIAlert,
    ]);

    const result = await evaluateAndAlertStorageHealth(recoveredStats, harness.deps);

    suite.expect(!result.alertCreated, 'alertCreated should be false on recovery');
    suite.expectEqual(result.alertsResolved, 2, 'alertsResolved');
    suite.expect(result.inAppCreated, 'recovery in-app notification fired');

    suite.expectEqual(
      harness.resolved.map((r) => r.id).join(','),
      '11,22',
      'both alerts resolved',
    );
    suite.expect(
      harness.resolved[0].note.includes('Auto-resolved'),
      `resolution note — got: ${harness.resolved[0].note}`,
    );
    suite.expectEqual(harness.notifications.length, 1, 'one recovery notification');
    suite.expectEqual(harness.notifications[0].severity, 'low', 'recovery severity');
  },
);

await suite.test(
  'no-op on recovery when there are no open alerts to resolve',
  async () => {
    const harness = makeHarness({});
    harness.setOpenAlerts([]);

    const result = await evaluateAndAlertStorageHealth(recoveredStats, harness.deps);

    suite.expectEqual(result.alertsResolved, 0, 'alertsResolved');
    suite.expect(!result.inAppCreated, 'no recovery notification when nothing changed');
    suite.expectEqual(harness.resolved.length, 0, 'no resolveAlert calls');
    suite.expectEqual(harness.notifications.length, 0, 'no notifications');
  },
);

await suite.test(
  'skips Slack/email silently when env vars are unset',
  async () => {
    const harness = makeHarness({});
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(result.alertCreated, 'alertCreated still true');
    suite.expect(!result.slackSent, 'slackSent false (no webhook)');
    suite.expect(!result.emailSent, 'emailSent false (no recipients)');
    suite.expect(result.inAppCreated, 'in-app still fires (always available)');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack calls');
    suite.expectEqual(harness.emails.length, 0, 'no email calls');
  },
);

await suite.test(
  'suppresses Slack/email during quiet hours but still creates ai_alerts row + in-app notification',
  async () => {
    // Window: 22:00–07:00 UTC. Pin clock to 03:00 UTC — squarely inside.
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T03:00:00.000Z'),
    );
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(result.alertCreated, 'alertCreated should still be true');
    suite.expect(
      result.quietHoursSuppressed,
      'quietHoursSuppressed should be true at 03:00 UTC inside 22-07 window',
    );
    suite.expect(!result.slackSent, 'Slack must be suppressed in quiet hours');
    suite.expect(!result.emailSent, 'Email must be suppressed in quiet hours');
    suite.expect(
      result.inAppCreated,
      'In-app notification still fires so morning view shows the issue',
    );

    suite.expectEqual(harness.createdAlerts.length, 1, 'ai_alerts row still inserted');
    suite.expectEqual(harness.notifications.length, 1, 'in-app notification still created');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call attempted');
    suite.expectEqual(harness.emails.length, 0, 'no email call attempted');
  },
);

await suite.test(
  'pages Slack/email normally when quiet hours are configured but the clock is outside the window',
  async () => {
    // Window: 22-07 UTC. Pin clock to 12:00 UTC — squarely outside.
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T12:00:00.000Z'),
    );
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(result.alertCreated, 'alertCreated true');
    suite.expect(
      !result.quietHoursSuppressed,
      'quietHoursSuppressed should be false outside the window',
    );
    suite.expect(result.slackSent, 'Slack should fire outside quiet hours');
    suite.expect(result.emailSent, 'Email should fire outside quiet hours');
    suite.expectEqual(harness.slacks.length, 1, 'one Slack call');
    suite.expectEqual(harness.emails.length, 1, 'one email call');
  },
);

await suite.test(
  'quiet-hours window honours STORAGE_HEALTH_QUIET_HOURS_TZ (Asia/Riyadh = UTC+3)',
  async () => {
    // Window: 00:00–06:00 Riyadh time (= 21:00–03:00 UTC). Pin clock to
    // 23:30 UTC — inside Riyadh window (02:30 local).
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        STORAGE_HEALTH_QUIET_HOURS_START: '0',
        STORAGE_HEALTH_QUIET_HOURS_END: '6',
        STORAGE_HEALTH_QUIET_HOURS_TZ: 'Asia/Riyadh',
      },
      new Date('2026-04-25T23:30:00.000Z'),
    );
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);

    suite.expect(
      result.quietHoursSuppressed,
      'quietHoursSuppressed should be true (02:30 Riyadh is inside 0-6 window)',
    );
    suite.expect(!result.slackSent, 'Slack suppressed');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');

    // Now move the clock to 09:00 UTC (= 12:00 Riyadh) — outside the window.
    harness.setNow(new Date('2026-04-25T09:00:00.000Z'));
    harness.setOpenAlertExists(false);
    const result2 = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);
    suite.expect(
      !result2.quietHoursSuppressed,
      'quietHoursSuppressed should be false at 12:00 Riyadh (outside 0-6)',
    );
    suite.expect(result2.slackSent, 'Slack fires outside Riyadh quiet hours');
  },
);

await suite.test(
  'invalid quiet-hours env vars are treated as disabled (no suppression)',
  async () => {
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        STORAGE_HEALTH_QUIET_HOURS_START: 'banana',
        STORAGE_HEALTH_QUIET_HOURS_END: '24', // out of range
      },
      new Date('2026-04-25T03:00:00.000Z'),
    );
    harness.setOpenAlertExists(false);

    const result = await evaluateAndAlertStorageHealth(breachingStats, harness.deps);
    suite.expect(
      !result.quietHoursSuppressed,
      'invalid env vars must disable the window, not suppress everything',
    );
    suite.expect(result.slackSent, 'Slack still fires when window is disabled');
  },
);

await suite.test(
  'isInQuietHours: same-day window matches half-open [start, end)',
  async () => {
    const win = resolveQuietHoursWindow({
      STORAGE_HEALTH_QUIET_HOURS_START: '1',
      STORAGE_HEALTH_QUIET_HOURS_END: '5',
    });
    suite.expect(win.enabled, 'window enabled');
    suite.expect(
      isInQuietHours(win, new Date('2026-04-25T01:00:00.000Z')),
      '01:00 should be inside (start is inclusive)',
    );
    suite.expect(
      isInQuietHours(win, new Date('2026-04-25T04:59:00.000Z')),
      '04:59 should be inside',
    );
    suite.expect(
      !isInQuietHours(win, new Date('2026-04-25T05:00:00.000Z')),
      '05:00 should be outside (end is exclusive)',
    );
    suite.expect(
      !isInQuietHours(win, new Date('2026-04-25T00:59:00.000Z')),
      '00:59 should be outside',
    );
  },
);

await suite.test(
  'isInQuietHours: wrap-around window (start > end) covers both sides of midnight',
  async () => {
    const win = resolveQuietHoursWindow({
      STORAGE_HEALTH_QUIET_HOURS_START: '22',
      STORAGE_HEALTH_QUIET_HOURS_END: '7',
    });
    suite.expect(win.enabled, 'wrap-around window enabled');
    suite.expect(
      isInQuietHours(win, new Date('2026-04-25T22:30:00.000Z')),
      '22:30 should be inside',
    );
    suite.expect(
      isInQuietHours(win, new Date('2026-04-25T03:00:00.000Z')),
      '03:00 (post-midnight) should be inside',
    );
    suite.expect(
      isInQuietHours(win, new Date('2026-04-25T06:59:00.000Z')),
      '06:59 should be inside',
    );
    suite.expect(
      !isInQuietHours(win, new Date('2026-04-25T07:00:00.000Z')),
      '07:00 should be outside (end is exclusive)',
    );
    suite.expect(
      !isInQuietHours(win, new Date('2026-04-25T12:00:00.000Z')),
      '12:00 should be outside',
    );
    suite.expect(
      !isInQuietHours(win, new Date('2026-04-25T21:59:00.000Z')),
      '21:59 should be outside',
    );
  },
);

await suite.test(
  'resolveQuietHoursWindow: start === end disables the window (avoids 24/7 suppression)',
  async () => {
    const win = resolveQuietHoursWindow({
      STORAGE_HEALTH_QUIET_HOURS_START: '5',
      STORAGE_HEALTH_QUIET_HOURS_END: '5',
    });
    suite.expect(!win.enabled, 'equal start/end must disable');
  },
);

await suite.test(
  'recovery path is not affected by quiet hours (always auto-resolves + recovery in-app)',
  async () => {
    // Quiet hours active, but stats show recovery — we must still auto-
    // resolve open alerts and emit the recovery in-app notification so the
    // alerts feed isn't stuck on a stale "OPEN" badge until 07:00.
    const harness = makeHarness(
      {
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T03:00:00.000Z'),
    );
    harness.setOpenAlerts([{ id: 99, status: 'open' } as AIAlert]);

    const result = await evaluateAndAlertStorageHealth(recoveredStats, harness.deps);
    suite.expectEqual(result.alertsResolved, 1, 'recovery resolves the open alert');
    suite.expect(
      result.inAppCreated,
      'recovery in-app notification fires even during quiet hours',
    );
    suite.expect(
      !result.quietHoursSuppressed,
      'quietHoursSuppressed only flips on the breach path (no Slack/email on recovery anyway)',
    );
  },
);

await suite.test(
  'buildStorageHealthMessage handles missing oldestAgeDays gracefully',
  async () => {
    const stats: AiMetricsTableStats = {
      ...breachingStats,
      oldestStartedAt: null,
      oldestAgeDays: null,
    };
    const msg = buildStorageHealthMessage(stats);
    suite.expect(
      msg.title.includes('unavailable'),
      `title should mention unavailable — got: ${msg.title}`,
    );
    suite.expect(
      msg.description.includes('unavailable'),
      `description should mention unavailable — got: ${msg.description}`,
    );
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Re-page sweep (Task #679)
// ──────────────────────────────────────────────────────────────────────────────

interface RepageHarness {
  deps: StorageHealthRepageDeps;
  slacks: SlackRecord[];
  emails: EmailRecord[];
  notified: Array<{ alertId: number; channel: string; whenMs: number }>;
  setOpenAlerts: (alerts: AIAlert[]) => void;
  setSlackOk: (ok: boolean) => void;
  setEmailOk: (ok: boolean) => void;
  setNow: (now: Date) => void;
  setListFailure: (err: Error | null) => void;
}

function makeRepageHarness(
  env: NodeJS.ProcessEnv,
  initialNow?: Date,
): RepageHarness {
  const slacks: SlackRecord[] = [];
  const emails: EmailRecord[] = [];
  const notified: Array<{ alertId: number; channel: string; whenMs: number }> = [];
  let openAlerts: AIAlert[] = [];
  let slackOk = true;
  let emailOk = true;
  let now = initialNow ?? new Date('2026-04-25T12:00:00.000Z');
  let listFailure: Error | null = null;

  const deps: StorageHealthRepageDeps = {
    getOpenAlertsByKey: async (alertType, relatedRecordId) => {
      if (alertType !== 'storage_health') {
        throw new Error(`unexpected alertType ${alertType}`);
      }
      if (relatedRecordId !== STORAGE_HEALTH_DEDUPE_KEY) {
        throw new Error(`unexpected relatedRecordId ${relatedRecordId}`);
      }
      if (listFailure) throw listFailure;
      return openAlerts;
    },
    recordAlertNotified: async (alertId, channel, whenMs) => {
      notified.push({ alertId, channel, whenMs });
    },
    sendSlack: async (webhookUrl, text) => {
      slacks.push({ webhookUrl, text });
      return slackOk;
    },
    sendEmail: async ({ to, subject, html }) => {
      emails.push({ to, subject, html });
      return emailOk;
    },
    env,
    now: () => now,
  };

  return {
    deps,
    slacks,
    emails,
    notified,
    setOpenAlerts: (a) => {
      openAlerts = a;
    },
    setSlackOk: (ok) => {
      slackOk = ok;
    },
    setEmailOk: (ok) => {
      emailOk = ok;
    },
    setNow: (n) => {
      now = n;
    },
    setListFailure: (err) => {
      listFailure = err;
    },
  };
}

await suite.test(
  'resolveRepageAfterMinutes: default when env is unset, disabled when <=0',
  async () => {
    suite.expectEqual(
      resolveRepageAfterMinutes({}),
      STORAGE_HEALTH_REPAGE_DEFAULT_MIN,
      'default when unset',
    );
    suite.expectEqual(
      resolveRepageAfterMinutes({ STORAGE_HEALTH_REPAGE_AFTER_MIN: '60' }),
      60,
      '60 min override',
    );
    suite.expectEqual(
      resolveRepageAfterMinutes({ STORAGE_HEALTH_REPAGE_AFTER_MIN: '0' }),
      null,
      '0 disables',
    );
    suite.expectEqual(
      resolveRepageAfterMinutes({ STORAGE_HEALTH_REPAGE_AFTER_MIN: '-5' }),
      null,
      'negative disables',
    );
    suite.expectEqual(
      resolveRepageAfterMinutes({ STORAGE_HEALTH_REPAGE_AFTER_MIN: 'banana' }),
      STORAGE_HEALTH_REPAGE_DEFAULT_MIN,
      'invalid falls back to default',
    );
  },
);

await suite.test(
  're-page sweep: alert older than threshold gets a Slack/email page and notified_at is stamped',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    // 30h since last page → past 24h threshold.
    const lastPagedAt = new Date(now.getTime() - 30 * 60 * 60_000);
    const harness = makeRepageHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
      },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 42,
        alert_type: 'storage_health',
        severity: 'high',
        title: 'AI usage table outgrowing prune window',
        description: 'oldest row is 130d old',
        status: 'open',
        notified_at: lastPagedAt,
        created_at: lastPagedAt,
      } as unknown as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);

    suite.expect(!result.disabled, 'sweep is enabled');
    suite.expectEqual(result.alertsConsidered, 1, 'one alert considered');
    suite.expectEqual(result.alertsRepaged, 1, 'one re-page sent');
    suite.expectEqual(result.slackSent, 1, 'one Slack call ok');
    suite.expectEqual(result.emailSent, 1, 'one email call ok');
    suite.expectEqual(harness.slacks.length, 1, 'slack invoked once');
    suite.expectEqual(harness.emails.length, 1, 'email invoked once');
    suite.expect(
      harness.slacks[0].text.includes('still OPEN'),
      `slack text — got: ${harness.slacks[0].text}`,
    );
    suite.expectEqual(harness.notified.length, 1, 'notified_at stamped once');
    suite.expectEqual(harness.notified[0].alertId, 42, 'stamp on alert id 42');
    suite.expectEqual(
      harness.notified[0].channel,
      'slack+email_repage',
      'channel reflects both sent',
    );
  },
);

await suite.test(
  're-page sweep: alert with recent notified_at is throttled (no Slack/email)',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    // 2h since last page — well inside 24h throttle window.
    const lastPagedAt = new Date(now.getTime() - 2 * 60 * 60_000);
    const harness = makeRepageHarness(
      { SLACK_WEBHOOK_URL: 'https://hooks.example/abc' },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 7,
        status: 'open',
        notified_at: lastPagedAt,
        created_at: new Date(now.getTime() - 5 * 24 * 60 * 60_000),
      } as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);

    suite.expectEqual(result.alertsConsidered, 1, 'one considered');
    suite.expectEqual(result.alertsThrottled, 1, 'one throttled');
    suite.expectEqual(result.alertsRepaged, 0, 'zero re-pages');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack calls');
    suite.expectEqual(harness.notified.length, 0, 'no notified_at writes');
  },
);

await suite.test(
  're-page sweep: alert with no notified_at uses created_at as fallback',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    // Alert created 30h ago, never paged.
    const createdAt = new Date(now.getTime() - 30 * 60 * 60_000);
    const harness = makeRepageHarness(
      { SLACK_WEBHOOK_URL: 'https://hooks.example/abc' },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 99,
        status: 'open',
        notified_at: null,
        created_at: createdAt,
      } as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);

    suite.expectEqual(result.alertsRepaged, 1, 'fallback path re-pages');
    suite.expectEqual(harness.slacks.length, 1, 'slack invoked');
    suite.expectEqual(harness.notified[0].channel, 'slack_repage', 'slack-only label');
  },
);

await suite.test(
  're-page sweep: young alert (created recently) is not re-paged',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    // 6h ago — well inside the 24h threshold.
    const createdAt = new Date(now.getTime() - 6 * 60 * 60_000);
    const harness = makeRepageHarness(
      { SLACK_WEBHOOK_URL: 'https://hooks.example/abc' },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 1,
        status: 'open',
        notified_at: null,
        created_at: createdAt,
      } as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expectEqual(result.alertsSkippedYoung, 1, 'one skipped (young)');
    suite.expectEqual(result.alertsRepaged, 0, 'no re-page');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack');
  },
);

await suite.test(
  're-page sweep: STORAGE_HEALTH_REPAGE_AFTER_MIN=0 disables the sweep entirely',
  async () => {
    const harness = makeRepageHarness({
      STORAGE_HEALTH_REPAGE_AFTER_MIN: '0',
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
    });
    harness.setOpenAlerts([
      {
        id: 1,
        status: 'open',
        notified_at: null,
        created_at: new Date('2025-01-01T00:00:00.000Z'),
      } as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expect(result.disabled, 'sweep is disabled');
    suite.expectEqual(result.alertsRepaged, 0, 'no re-page');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack');
    suite.expectEqual(harness.notified.length, 0, 'no notified_at writes');
  },
);

await suite.test(
  're-page sweep: quiet hours suppresses Slack/email but still counts as considered',
  async () => {
    const now = new Date('2026-04-25T03:00:00.000Z');
    const lastPagedAt = new Date(now.getTime() - 30 * 60 * 60_000);
    const harness = makeRepageHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 5,
        status: 'open',
        notified_at: lastPagedAt,
        created_at: lastPagedAt,
      } as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expect(result.quietHoursActive, 'quiet hours active');
    suite.expectEqual(result.alertsQuietHoursSuppressed, 1, 'one suppressed');
    suite.expectEqual(result.alertsRepaged, 0, 'no re-page during quiet hours');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');
    suite.expectEqual(harness.notified.length, 0, 'no notified_at write');
  },
);

await suite.test(
  're-page sweep: no open alerts → no Slack, no notified_at writes',
  async () => {
    const harness = makeRepageHarness({
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
    });
    harness.setOpenAlerts([]);
    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expectEqual(result.alertsConsidered, 0, 'zero considered');
    suite.expectEqual(result.alertsRepaged, 0, 'zero re-pages');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack');
  },
);

await suite.test(
  're-page sweep: list failure is non-fatal',
  async () => {
    const harness = makeRepageHarness({
      SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
    });
    harness.setListFailure(new Error('connection refused'));
    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expectEqual(result.alertsConsidered, 0, 'considered=0 on failure');
    suite.expectEqual(result.alertsRepaged, 0, 'no re-page');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack');
  },
);

await suite.test(
  're-page sweep: acknowledged alerts are NOT re-paged (operator already triaged)',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    const lastPagedAt = new Date(now.getTime() - 30 * 60 * 60_000);
    const harness = makeRepageHarness(
      { SLACK_WEBHOOK_URL: 'https://hooks.example/abc' },
      now,
    );
    harness.setOpenAlerts([
      {
        id: 88,
        status: 'acknowledged',
        notified_at: lastPagedAt,
        created_at: lastPagedAt,
      } as unknown as AIAlert,
    ]);

    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expectEqual(result.alertsConsidered, 1, 'one considered');
    suite.expectEqual(
      result.alertsSkippedAcknowledged,
      1,
      'acknowledged alert skipped',
    );
    suite.expectEqual(result.alertsRepaged, 0, 'no re-page');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');
    suite.expectEqual(
      harness.notified.length,
      0,
      'no notified_at write — operator already triaged',
    );
  },
);

await suite.test(
  're-page sweep: stamps not_configured_repage when no Slack/email is wired',
  async () => {
    const now = new Date('2026-04-25T12:00:00.000Z');
    const lastPagedAt = new Date(now.getTime() - 30 * 60 * 60_000);
    const harness = makeRepageHarness({}, now);
    harness.setOpenAlerts([
      {
        id: 17,
        status: 'open',
        notified_at: lastPagedAt,
        created_at: lastPagedAt,
      } as AIAlert,
    ]);
    const result = await repageStaleStorageHealthAlerts(harness.deps);
    suite.expectEqual(result.alertsRepaged, 1, 'still counts as a sweep pass');
    suite.expectEqual(result.slackSent, 0, 'no slack sent');
    suite.expectEqual(result.emailSent, 0, 'no email sent');
    suite.expectEqual(harness.notified.length, 1, 'notified_at stamped');
    suite.expectEqual(
      harness.notified[0].channel,
      'not_configured_repage',
      'channel reflects no config',
    );
  },
);

suite.finishOrExit();
