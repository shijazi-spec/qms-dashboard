/**
 * Unit / behavior test for the 24h rate-limit 429 spike alert (Task #282).
 *
 * Covers:
 *   1. evaluateRateLimit24hSpikeAlert() — the pure helper shared by the
 *      dashboard's getRateLimitStats() and the alert cron. Disabled (0),
 *      below-threshold, exactly-at-threshold, above-threshold paths.
 *   2. runRateLimit429SpikeAlertCheck() — the cron check itself, with
 *      every external dependency stubbed:
 *        - threshold disabled (no DB hit at all)
 *        - below threshold (no system_event written)
 *        - above threshold + no recent emissions (writes event, fans out)
 *        - above threshold + recent emission (suppressed as repeat)
 *        - fetchSpikeAggregate throws (DB error path)
 *        - emitSystemEvent throws but Slack/email still attempted
 *
 * Pure / no DB needed — every dep is stubbed, so the suite runs in CI even
 * without DATABASE_URL, matching the convention used by aiToolPolicyBuildPreview
 * and other dep-injected cron tests.
 *
 * Usage:
 *   npx tsx tests/rateLimit429SpikeAlert.test.ts
 *   (also auto-discovered by `npm test` via tests/runIntegrationTests.ts)
 */

import {
  evaluateRateLimit24hSpikeAlert,
  runRateLimit429SpikeAlertCheck,
  getRateLimit24hAlertThreshold,
  getRateLimit24hAlertRepeatHours,
  type SpikeAlertCheckDeps,
} from '../src/utils/rateLimit429SpikeAlert';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`, extra ?? '');
    failed++;
  }
}

interface CapturedAlertMetadata {
  total429: number;
  threshold: number;
  totalSuppressed: number;
  topIps: Array<{ ip: string; events: number; suppressed: number }>;
  repeatHours: number;
  [k: string]: unknown;
}

interface StubInvocations {
  fetchAggregateCalls: number;
  countRecentCalls: number;
  countRecentArgs: number[];
  emitEventCalls: number;
  emittedDescriptions: string[];
  emittedMetadata: CapturedAlertMetadata[];
  slackCalls: string[];
  emailCalls: Array<{ subject: string }>;
}

function makeStubs(overrides: Partial<{
  total429: number;
  totalSuppressed: number;
  topIps: Array<{ ip: string; events: number; suppressed: number }>;
  recentEmissions: number;
  fetchThrows: boolean;
  emitThrows: boolean;
  slackReturns: boolean;
  emailReturns: boolean;
}> = {}): { deps: SpikeAlertCheckDeps; invocations: StubInvocations } {
  const invocations: StubInvocations = {
    fetchAggregateCalls: 0,
    countRecentCalls: 0,
    countRecentArgs: [],
    emitEventCalls: 0,
    emittedDescriptions: [],
    emittedMetadata: [],
    slackCalls: [],
    emailCalls: [],
  };
  const deps: SpikeAlertCheckDeps = {
    fetchSpikeAggregate: async () => {
      invocations.fetchAggregateCalls++;
      if (overrides.fetchThrows) throw new Error('synthetic-db-failure');
      return {
        total429: overrides.total429 ?? 0,
        totalSuppressed: overrides.totalSuppressed ?? 0,
        topIps: overrides.topIps ?? [],
      };
    },
    countRecentAlertEmissions: async (withinHours) => {
      invocations.countRecentCalls++;
      invocations.countRecentArgs.push(withinHours);
      return overrides.recentEmissions ?? 0;
    },
    emitSystemEvent: async ({ description, metadata }) => {
      invocations.emitEventCalls++;
      invocations.emittedDescriptions.push(description);
      invocations.emittedMetadata.push(metadata as CapturedAlertMetadata);
      if (overrides.emitThrows) throw new Error('synthetic-emit-failure');
    },
    postSlack: async (text) => {
      invocations.slackCalls.push(text);
      return overrides.slackReturns ?? false;
    },
    sendEmail: async (subject) => {
      invocations.emailCalls.push({ subject });
      return overrides.emailReturns ?? false;
    },
  };
  return { deps, invocations };
}

async function main(): Promise<void> {
  console.log('=== evaluateRateLimit24hSpikeAlert() — pure helper ===');

  // Disabled (threshold = 0)
  {
    const r = evaluateRateLimit24hSpikeAlert(9999, 0);
    check('threshold=0 → disabled', r.active === false && r.reason === 'disabled', r);
    check('threshold=0 → returns threshold=0', r.threshold === 0, r);
  }
  // Negative threshold treated as disabled
  {
    const r = evaluateRateLimit24hSpikeAlert(9999, -1);
    check('threshold=-1 → disabled', r.active === false && r.reason === 'disabled', r);
  }
  // Below
  {
    const r = evaluateRateLimit24hSpikeAlert(499, 500);
    check('total < threshold → not active', r.active === false && r.reason === 'below_threshold', r);
  }
  // Exactly at threshold (>= semantics)
  {
    const r = evaluateRateLimit24hSpikeAlert(500, 500);
    check('total === threshold → active (>= semantics)', r.active === true && r.reason === 'above_threshold', r);
  }
  // Above
  {
    const r = evaluateRateLimit24hSpikeAlert(1000, 500);
    check('total > threshold → active', r.active === true && r.reason === 'above_threshold', r);
    check('threshold echoed back unchanged', r.threshold === 500, r);
    check('total429 echoed back unchanged', r.total429 === 1000, r);
  }

  console.log('=== getRateLimit24hAlertThreshold() / getRateLimit24hAlertRepeatHours() — env parsing ===');

  // Save and clear
  const saveT = process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD;
  const saveR = process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS;
  try {
    delete process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD;
    check('threshold default = 500', getRateLimit24hAlertThreshold() === 500);

    process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD = '0';
    check('threshold=0 explicitly disables', getRateLimit24hAlertThreshold() === 0);

    process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD = '1000';
    check('threshold env override honored', getRateLimit24hAlertThreshold() === 1000);

    process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD = 'not-a-number';
    check('non-numeric threshold falls back to default', getRateLimit24hAlertThreshold() === 500);

    delete process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS;
    check('repeat-hours default = 6', getRateLimit24hAlertRepeatHours() === 6);

    process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS = '12';
    check('repeat-hours env override honored', getRateLimit24hAlertRepeatHours() === 12);

    process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS = '0';
    check('repeat-hours=0 falls back to default (positive only)', getRateLimit24hAlertRepeatHours() === 6);
  } finally {
    if (saveT === undefined) delete process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD;
    else process.env.RATE_LIMIT_429_24H_ALERT_THRESHOLD = saveT;
    if (saveR === undefined) delete process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS;
    else process.env.RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS = saveR;
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — disabled threshold short-circuits ===');
  {
    const { deps, invocations } = makeStubs({ total429: 9999 });
    const r = await runRateLimit429SpikeAlertCheck({ ...deps, threshold: 0 });
    check('disabled threshold → reason=disabled', r.reason === 'disabled' && r.active === false, r);
    check('disabled threshold → no DB fetch', invocations.fetchAggregateCalls === 0);
    check('disabled threshold → no system_event written', invocations.emitEventCalls === 0);
    check('disabled threshold → no Slack', invocations.slackCalls.length === 0);
    check('disabled threshold → no email', invocations.emailCalls.length === 0);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — below threshold ===');
  {
    const { deps, invocations } = makeStubs({ total429: 100 });
    const r = await runRateLimit429SpikeAlertCheck({ ...deps, threshold: 500 });
    check('below threshold → not active', r.active === false && r.reason === 'below_threshold', r);
    check('below threshold → DB fetch still happened', invocations.fetchAggregateCalls === 1);
    check('below threshold → no recent-emission count needed', invocations.countRecentCalls === 0);
    check('below threshold → no system_event written', invocations.emitEventCalls === 0);
    check('below threshold → no Slack', invocations.slackCalls.length === 0);
    check('below threshold → no email', invocations.emailCalls.length === 0);
    check('below threshold → echoes total429', r.total429 === 100);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — above threshold, no recent emission → fires ===');
  {
    const { deps, invocations } = makeStubs({
      total429: 750,
      totalSuppressed: 30,
      topIps: [
        { ip: '1.2.3.4', events: 500, suppressed: 20 },
        { ip: '5.6.7.8', events: 250, suppressed: 10 },
      ],
      recentEmissions: 0,
      slackReturns: true,
      emailReturns: true,
    });
    const r = await runRateLimit429SpikeAlertCheck({
      ...deps,
      threshold: 500,
      repeatHours: 6,
    });
    check('above threshold → active=true', r.active === true && r.reason === 'above_threshold', r);
    check('above threshold → emitted system_event', r.alertEmitted === true);
    check('above threshold → not suppressed as repeat', r.alertSuppressedAsRepeat === false);
    check('above threshold → countRecent called with repeatHours=6', invocations.countRecentArgs[0] === 6);
    check('above threshold → exactly 1 system_event written', invocations.emitEventCalls === 1);
    check(
      'description includes total and threshold',
      invocations.emittedDescriptions[0].includes('750') &&
        invocations.emittedDescriptions[0].includes('500'),
      invocations.emittedDescriptions[0],
    );
    const md = invocations.emittedMetadata[0];
    check('metadata.total429 = 750', md.total429 === 750, md);
    check('metadata.threshold = 500', md.threshold === 500, md);
    check('metadata.totalSuppressed = 30', md.totalSuppressed === 30, md);
    check('metadata.topIps preserved (length 2)', Array.isArray(md.topIps) && md.topIps.length === 2, md);
    check('Slack POSTed once', invocations.slackCalls.length === 1);
    check(
      'Slack text mentions IPs',
      invocations.slackCalls[0].includes('1.2.3.4') && invocations.slackCalls[0].includes('5.6.7.8'),
      invocations.slackCalls[0],
    );
    check('Email sent once', invocations.emailCalls.length === 1);
    check(
      'Email subject mentions count',
      invocations.emailCalls[0].subject.includes('750'),
      invocations.emailCalls[0].subject,
    );
    check('result.slackSent reflects stub return', r.slackSent === true);
    check('result.emailSent reflects stub return', r.emailSent === true);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — above threshold, recent emission → suppressed ===');
  {
    const { deps, invocations } = makeStubs({
      total429: 1500,
      recentEmissions: 1,
    });
    const r = await runRateLimit429SpikeAlertCheck({
      ...deps,
      threshold: 500,
      repeatHours: 6,
    });
    check('still active (above threshold)', r.active === true);
    check('alertEmitted = false (suppressed)', r.alertEmitted === false);
    check('alertSuppressedAsRepeat = true', r.alertSuppressedAsRepeat === true);
    check('no system_event written', invocations.emitEventCalls === 0);
    check('no Slack call', invocations.slackCalls.length === 0);
    check('no email call', invocations.emailCalls.length === 0);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — fetchAggregate throws → graceful db_error ===');
  {
    const { deps, invocations } = makeStubs({ fetchThrows: true });
    const r = await runRateLimit429SpikeAlertCheck({ ...deps, threshold: 500 });
    check('reason=db_error', r.reason === 'db_error');
    check('active=false on db_error', r.active === false);
    check('no emit on db_error', invocations.emitEventCalls === 0);
    check('no slack on db_error', invocations.slackCalls.length === 0);
    check('no email on db_error', invocations.emailCalls.length === 0);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — emitSystemEvent throws → Slack/email still attempted ===');
  {
    const { deps, invocations } = makeStubs({
      total429: 600,
      emitThrows: true,
      slackReturns: true,
      emailReturns: false,
    });
    const r = await runRateLimit429SpikeAlertCheck({
      ...deps,
      threshold: 500,
      repeatHours: 6,
    });
    check('active=true (above threshold)', r.active === true);
    check('alertEmitted=false because emit threw', r.alertEmitted === false);
    check('Slack still attempted (was called)', invocations.slackCalls.length === 1);
    check('Email still attempted (was called)', invocations.emailCalls.length === 1);
    check('result.slackSent reflects stub return (true)', r.slackSent === true);
    check('result.emailSent reflects stub return (false)', r.emailSent === false);
  }

  console.log('=== runRateLimit429SpikeAlertCheck() — countRecent throws → still alerts (better over-page than miss) ===');
  {
    const { deps, invocations } = makeStubs({ total429: 600, slackReturns: true });
    const customDeps: SpikeAlertCheckDeps = {
      ...deps,
      countRecentAlertEmissions: async () => {
        throw new Error('synthetic-count-failure');
      },
    };
    const r = await runRateLimit429SpikeAlertCheck({
      ...customDeps,
      threshold: 500,
      repeatHours: 6,
    });
    check('active=true', r.active === true);
    check('alertEmitted=true even though countRecent threw', r.alertEmitted === true);
    check('Slack was called', invocations.slackCalls.length === 1);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
