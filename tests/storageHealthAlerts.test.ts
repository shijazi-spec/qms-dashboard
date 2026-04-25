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
  STORAGE_HEALTH_DEDUPE_KEY,
  type StorageHealthAlertDeps,
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
}

function makeHarness(env: NodeJS.ProcessEnv): Harness {
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

suite.finishOrExit();
