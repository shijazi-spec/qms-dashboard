/**
 * Tests for runStorageHealthMorningDigest (Task #604).
 *
 * Verifies:
 *   1. Sends a single Slack + email digest listing every unresolved
 *      storage_health alert created during the just-closed quiet-hours
 *      window.
 *   2. The alert query window is computed from the configured quiet-hours
 *      length (same-day and wrap-around windows both work).
 *   3. The opt-out env var STORAGE_HEALTH_MORNING_DIGEST_DISABLED skips
 *      everything.
 *   4. When quiet hours aren't configured, the digest is a no-op.
 *   5. When the window has no unresolved alerts, no Slack/email is pushed.
 *   6. Slack/email are skipped silently when their env vars are unset.
 *   7. Notification failures are swallowed (returns success=false but does
 *      not throw).
 *
 * Run:  npx tsx tests/storageHealthMorningDigest.test.ts
 */

import { TestSuite } from './_helpers/runner';
import {
  buildMorningDigestMessage,
  quietHoursLengthHours,
  runStorageHealthMorningDigest,
  type MorningDigestDeps,
} from '../src/utils/storageHealthMorningDigest';
import { resolveQuietHoursWindow } from '../src/utils/storageHealthAlerts';
import type { AIAlert, AlertType } from '../src/utils/aiAlertsDatabase';

interface QueryRecord {
  alertTypes: AlertType[];
  fromMs: number;
  toMs: number;
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

interface Harness {
  deps: MorningDigestDeps;
  queries: QueryRecord[];
  slacks: SlackRecord[];
  emails: EmailRecord[];
  setAlerts: (alerts: AIAlert[]) => void;
  setQueryError: (err: Error | null) => void;
  setSlackOk: (ok: boolean) => void;
  setEmailOk: (ok: boolean) => void;
  setSlackThrows: (err: Error | null) => void;
  setEmailThrows: (err: Error | null) => void;
}

function makeHarness(env: NodeJS.ProcessEnv, now: Date): Harness {
  const queries: QueryRecord[] = [];
  const slacks: SlackRecord[] = [];
  const emails: EmailRecord[] = [];
  let alerts: AIAlert[] = [];
  let queryError: Error | null = null;
  let slackOk = true;
  let emailOk = true;
  let slackThrows: Error | null = null;
  let emailThrows: Error | null = null;

  const deps: MorningDigestDeps = {
    getUnresolvedAlertsCreatedBetween: async (alertTypes, fromMs, toMs) => {
      queries.push({ alertTypes: [...alertTypes], fromMs, toMs });
      if (queryError) throw queryError;
      return alerts;
    },
    sendSlack: async (webhookUrl, text) => {
      slacks.push({ webhookUrl, text });
      if (slackThrows) throw slackThrows;
      return slackOk;
    },
    sendEmail: async ({ to, subject, html }) => {
      emails.push({ to, subject, html });
      if (emailThrows) throw emailThrows;
      return emailOk;
    },
    env,
    now: () => now,
  };

  return {
    deps,
    queries,
    slacks,
    emails,
    setAlerts: (a) => {
      alerts = a;
    },
    setQueryError: (e) => {
      queryError = e;
    },
    setSlackOk: (ok) => {
      slackOk = ok;
    },
    setEmailOk: (ok) => {
      emailOk = ok;
    },
    setSlackThrows: (e) => {
      slackThrows = e;
    },
    setEmailThrows: (e) => {
      emailThrows = e;
    },
  };
}

function alert(
  id: number,
  severity: AIAlert['severity'],
  title: string,
  createdAt: string,
): AIAlert {
  return {
    id,
    alert_type: 'storage_health',
    severity,
    title,
    description: `desc ${id}`,
    status: 'open',
    created_at: new Date(createdAt),
  } as AIAlert;
}

const suite = new TestSuite('storageHealthMorningDigest');

await suite.test(
  'sends a single Slack + email digest listing alerts in the just-closed wrap-around window',
  async () => {
    // Quiet hours 22→07 (length 9h). Cron fires at 07:05 UTC.
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com,oncall@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
        APP_BASE_URL: 'https://app.example.com',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([
      alert(1, 'high', 'AI usage table outgrowing prune window — oldest 120d', '2026-04-25T02:30:00.000Z'),
      alert(2, 'critical', 'Second breach during the night', '2026-04-25T03:45:00.000Z'),
    ]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expect(!result.optedOut, 'not opted out');
    suite.expect(!result.quietHoursDisabled, 'quiet hours configured');
    suite.expect(!result.noAlertsInWindow, 'has alerts');
    suite.expectEqual(result.alertCount, 2, 'alertCount');
    suite.expect(result.slackSent, 'slack sent');
    suite.expect(result.emailSent, 'email sent');

    // Window = [now - 9h, now)
    suite.expectEqual(harness.queries.length, 1, 'one DB query');
    const q = harness.queries[0];
    suite.expectEqual(q.alertTypes.join(','), 'storage_health', 'default alert type');
    suite.expectEqual(q.toMs, new Date('2026-04-25T07:05:00.000Z').getTime(), 'toMs is now');
    suite.expectEqual(
      q.fromMs,
      new Date('2026-04-25T07:05:00.000Z').getTime() - 9 * 3600 * 1000,
      'fromMs is now - 9h',
    );

    suite.expectEqual(harness.slacks.length, 1, 'one Slack call');
    suite.expect(
      harness.slacks[0].text.includes('Morning digest'),
      `slack text — got: ${harness.slacks[0].text}`,
    );
    suite.expect(
      harness.slacks[0].text.includes('AI usage table outgrowing'),
      'slack text mentions first alert title',
    );
    suite.expect(
      harness.slacks[0].text.includes('Second breach'),
      'slack text mentions second alert title',
    );
    suite.expect(
      harness.slacks[0].text.includes('app.example.com/dashboard'),
      'slack text contains app link',
    );

    suite.expectEqual(harness.emails.length, 1, 'one email call');
    suite.expectEqual(
      harness.emails[0].to.join(','),
      'ops@example.com,oncall@example.com',
      'email recipients',
    );
    suite.expect(
      harness.emails[0].subject.includes('overnight digest'),
      `email subject — got: ${harness.emails[0].subject}`,
    );
    suite.expect(
      harness.emails[0].html.includes('AI usage table outgrowing'),
      'email html lists first alert',
    );
  },
);

await suite.test(
  'computes a same-day window correctly (start < end)',
  async () => {
    // Quiet hours 01→05 (length 4h). Cron fires at 05:00 UTC.
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        STORAGE_HEALTH_QUIET_HOURS_START: '1',
        STORAGE_HEALTH_QUIET_HOURS_END: '5',
      },
      new Date('2026-04-25T05:00:00.000Z'),
    );
    harness.setAlerts([alert(1, 'high', 't', '2026-04-25T03:00:00.000Z')]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expectEqual(harness.queries.length, 1, 'one DB query');
    const q = harness.queries[0];
    suite.expectEqual(q.toMs - q.fromMs, 4 * 3600 * 1000, 'window length 4h');
    suite.expect(result.slackSent, 'slack sent');
  },
);

await suite.test(
  'opts out cleanly when STORAGE_HEALTH_MORNING_DIGEST_DISABLED=1',
  async () => {
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
        STORAGE_HEALTH_MORNING_DIGEST_DISABLED: '1',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([alert(1, 'high', 't', '2026-04-25T03:00:00.000Z')]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expect(result.optedOut, 'optedOut should be true');
    suite.expectEqual(harness.queries.length, 0, 'no DB query');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');
    suite.expectEqual(harness.emails.length, 0, 'no email call');
  },
);

await suite.test(
  'recognises truthy opt-out spellings (true, yes, on, case-insensitive)',
  async () => {
    for (const v of ['true', 'YES', 'On', 'TRUE']) {
      const harness = makeHarness(
        {
          STORAGE_HEALTH_QUIET_HOURS_START: '22',
          STORAGE_HEALTH_QUIET_HOURS_END: '7',
          STORAGE_HEALTH_MORNING_DIGEST_DISABLED: v,
        },
        new Date('2026-04-25T07:05:00.000Z'),
      );
      const result = await runStorageHealthMorningDigest(harness.deps);
      suite.expect(result.optedOut, `opt-out for value "${v}"`);
    }
    // And a non-truthy value should NOT opt out
    const harness = makeHarness(
      {
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
        STORAGE_HEALTH_MORNING_DIGEST_DISABLED: '0',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([]);
    const r = await runStorageHealthMorningDigest(harness.deps);
    suite.expect(!r.optedOut, '"0" should NOT opt out');
  },
);

await suite.test(
  'no-op when quiet hours are not configured',
  async () => {
    const harness = makeHarness(
      { SLACK_WEBHOOK_URL: 'https://hooks.example/abc' },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([alert(1, 'high', 't', '2026-04-25T03:00:00.000Z')]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expect(result.quietHoursDisabled, 'quietHoursDisabled true');
    suite.expectEqual(harness.queries.length, 0, 'no DB query');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');
  },
);

await suite.test(
  'no Slack/email when window has no unresolved alerts',
  async () => {
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expectEqual(result.alertCount, 0, 'alertCount 0');
    suite.expect(result.noAlertsInWindow, 'noAlertsInWindow true');
    suite.expectEqual(harness.queries.length, 1, 'DB query still ran');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack push when nothing to digest');
    suite.expectEqual(harness.emails.length, 0, 'no email push when nothing to digest');
  },
);

await suite.test(
  'skips Slack/email silently when env vars are unset (still queries)',
  async () => {
    const harness = makeHarness(
      {
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([alert(1, 'high', 't', '2026-04-25T03:00:00.000Z')]);

    const result = await runStorageHealthMorningDigest(harness.deps);

    suite.expectEqual(result.alertCount, 1, 'alertCount 1');
    suite.expect(!result.slackSent, 'slack not sent (no webhook)');
    suite.expect(!result.emailSent, 'email not sent (no recipients)');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack call');
    suite.expectEqual(harness.emails.length, 0, 'no email call');
  },
);

await suite.test(
  'transient Slack/email failures are swallowed (returns false, does not throw)',
  async () => {
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        AI_COST_ALERT_EMAIL: 'ops@example.com',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setAlerts([alert(1, 'high', 't', '2026-04-25T03:00:00.000Z')]);
    harness.setSlackThrows(new Error('slack 500'));
    harness.setEmailThrows(new Error('resend timeout'));

    const result = await runStorageHealthMorningDigest(harness.deps);
    suite.expect(!result.slackSent, 'slack reported false');
    suite.expect(!result.emailSent, 'email reported false');
    suite.expectEqual(result.alertCount, 1, 'still counted alerts');
  },
);

await suite.test(
  'DB query failure does not throw — returns zero counts',
  async () => {
    const harness = makeHarness(
      {
        SLACK_WEBHOOK_URL: 'https://hooks.example/abc',
        STORAGE_HEALTH_QUIET_HOURS_START: '22',
        STORAGE_HEALTH_QUIET_HOURS_END: '7',
      },
      new Date('2026-04-25T07:05:00.000Z'),
    );
    harness.setQueryError(new Error('connection refused'));

    const result = await runStorageHealthMorningDigest(harness.deps);
    suite.expectEqual(result.alertCount, 0, 'no alerts counted');
    suite.expectEqual(harness.slacks.length, 0, 'no Slack push');
  },
);

await suite.test(
  'quietHoursLengthHours: same-day, wrap-around, and disabled cases',
  async () => {
    suite.expectEqual(
      quietHoursLengthHours(
        resolveQuietHoursWindow({
          STORAGE_HEALTH_QUIET_HOURS_START: '1',
          STORAGE_HEALTH_QUIET_HOURS_END: '5',
        }),
      ),
      4,
      'same-day 1→5 = 4h',
    );
    suite.expectEqual(
      quietHoursLengthHours(
        resolveQuietHoursWindow({
          STORAGE_HEALTH_QUIET_HOURS_START: '22',
          STORAGE_HEALTH_QUIET_HOURS_END: '7',
        }),
      ),
      9,
      'wrap-around 22→7 = 9h',
    );
    suite.expectEqual(
      quietHoursLengthHours(
        resolveQuietHoursWindow({
          STORAGE_HEALTH_QUIET_HOURS_START: '5',
          STORAGE_HEALTH_QUIET_HOURS_END: '5',
        }),
      ),
      0,
      'equal start/end disables (length 0)',
    );
    suite.expectEqual(
      quietHoursLengthHours(resolveQuietHoursWindow({})),
      0,
      'unset env disables (length 0)',
    );
  },
);

await suite.test(
  'buildMorningDigestMessage handles a single alert (singular wording)',
  async () => {
    const msg = buildMorningDigestMessage(
      [alert(1, 'high', 'A breach', '2026-04-25T02:30:00.000Z')],
      new Date('2026-04-24T22:00:00.000Z').getTime(),
      new Date('2026-04-25T07:00:00.000Z').getTime(),
      'https://app.example.com',
    );
    suite.expect(
      msg.slackText.includes('1 unresolved alert ') ||
        msg.slackText.includes('1 unresolved alert*'),
      `slack singular wording — got: ${msg.slackText}`,
    );
    suite.expect(
      msg.emailSubject.includes('1 unresolved alert'),
      `email singular wording — got: ${msg.emailSubject}`,
    );
    suite.expect(
      !msg.emailSubject.includes('alerts'),
      `email should not pluralize — got: ${msg.emailSubject}`,
    );
  },
);

await suite.test(
  'buildMorningDigestMessage escapes HTML in alert titles',
  async () => {
    const msg = buildMorningDigestMessage(
      [alert(1, 'high', '<script>x</script> & "bad"', '2026-04-25T02:30:00.000Z')],
      new Date('2026-04-24T22:00:00.000Z').getTime(),
      new Date('2026-04-25T07:00:00.000Z').getTime(),
      '',
    );
    suite.expect(
      !msg.emailHtml.includes('<script>x</script>'),
      'raw <script> tag must not appear in email',
    );
    suite.expect(
      msg.emailHtml.includes('&lt;script&gt;'),
      'angle brackets escaped',
    );
    suite.expect(
      msg.emailHtml.includes('&quot;bad&quot;'),
      'quotes escaped',
    );
  },
);

suite.finishOrExit();
