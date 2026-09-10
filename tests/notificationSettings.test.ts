/**
 * Unit tests for src/utils/notificationSettings.ts
 *
 * The precedence rule is the whole point of this module, and it is the kind of
 * thing that looks obviously right and is quietly wrong: an env var that is set
 * but empty, an inverted mute flag read as an enable flag, a default that wins
 * over an explicit `false`. Any of those silences a compliance alert without
 * saying so.
 *
 * These cover the layers that need no database. The override layer is exercised
 * against a live database by the settings screen itself.
 *
 * Run:  npx tsx tests/notificationSettings.test.ts
 */

import {
  NOTIFICATION_SWITCHES,
  resolveFromEnv,
} from "../src/utils/notificationSettings";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("notificationSettings");

console.log("\n=== Notification settings ===\n");

const byKey = (k: string) => {
  const sw = NOTIFICATION_SWITCHES.find((s) => s.key === k);
  if (!sw) throw new Error(`no switch ${k}`);
  return sw;
};

await suite.test("an unset env var falls through to the default", async () => {
  const sw = byKey("health_pulse_slack");
  const r = resolveFromEnv(sw, {} as NodeJS.ProcessEnv);
  suite.expectEqual(r.enabled, false, "default off");
  suite.expectEqual(r.source, "default", "reported as default, not env");
});

await suite.test("an EMPTY env var is not an answer", async () => {
  // Replit writes an empty string for a secret that was created and left blank.
  // Treating "" as false would silently disable an alert whose default is ON,
  // and report the source as "env" so the screen would agree with itself.
  const sw = byKey("direct_audit_slack");
  const r = resolveFromEnv(sw, {
    DIRECT_AUDIT_SLACK_NOTIFY: "",
  } as NodeJS.ProcessEnv);
  suite.expectEqual(r.enabled, true, "keeps its default-on");
  suite.expectEqual(r.source, "default", "empty is not a decision");
});

await suite.test("an explicit env value wins over the default", async () => {
  const sw = byKey("health_pulse_slack");
  suite.expectEqual(
    resolveFromEnv(sw, { HEALTH_PULSE_SLACK_ALERTS: "true" } as NodeJS.ProcessEnv)
      .enabled,
    true,
    "turned on",
  );
  const off = byKey("direct_audit_slack");
  suite.expectEqual(
    resolveFromEnv(off, {
      DIRECT_AUDIT_SLACK_NOTIFY: "false",
    } as NodeJS.ProcessEnv).enabled,
    false,
    "turned off",
  );
});

await suite.test("only the literal word true enables a switch", async () => {
  // Matches every other gate in this codebase. "1" and "yes" look enabling and
  // are not; an operator who types one of those and sees the alert stay off
  // needs the screen to say "env" so the mismatch is visible.
  const sw = byKey("fraud_reminders");
  for (const v of ["1", "yes", "on", "enabled"]) {
    suite.expectEqual(
      resolveFromEnv(sw, { FRAUD_REMINDERS_ENABLED: v } as NodeJS.ProcessEnv)
        .enabled,
      false,
      `"${v}" does not enable`,
    );
  }
  suite.expectEqual(
    resolveFromEnv(sw, { FRAUD_REMINDERS_ENABLED: "TRUE" } as NodeJS.ProcessEnv)
      .enabled,
    true,
    "case-insensitive true",
  );
});

await suite.test("an INVERTED env var is read as a mute, not an enable", async () => {
  // PLATFORM_SLACK_MUTE=true means the channel is SILENT, so `enabled` must be
  // false. Getting this backwards would make the screen show "on" for a muted
  // channel — the exact double negative envInverted exists to absorb.
  const sw = byKey("platform_slack_announcements");
  suite.expectEqual(sw.envInverted, true, "declared inverted");
  suite.expectEqual(
    resolveFromEnv(sw, { PLATFORM_SLACK_MUTE: "true" } as NodeJS.ProcessEnv)
      .enabled,
    false,
    "mute=true means NOT enabled",
  );
  suite.expectEqual(
    resolveFromEnv(sw, { PLATFORM_SLACK_MUTE: "false" } as NodeJS.ProcessEnv)
      .enabled,
    true,
    "mute=false means enabled",
  );
  suite.expectEqual(
    resolveFromEnv(sw, {} as NodeJS.ProcessEnv).enabled,
    true,
    "unset means enabled — silence is never the default",
  );
});

await suite.test("a switch with no env var still resolves", async () => {
  // The CS alerts have only ever had a hardcoded default. They must not become
  // unreachable just because there is no secret behind them.
  for (const k of ["cs_overlap_alert", "cs_lifecycle_alert"]) {
    const sw = byKey(k);
    suite.expectEqual(sw.envVar, null, `${k} has no env var`);
    suite.expectEqual(
      resolveFromEnv(sw, {} as NodeJS.ProcessEnv).enabled,
      true,
      `${k} defaults on`,
    );
  }
});

await suite.test("the registry has no duplicate keys", async () => {
  const keys = NOTIFICATION_SWITCHES.map((s) => s.key);
  suite.expectEqual(new Set(keys).size, keys.length, "unique keys");
});

await suite.test("every switch is describable to a human", async () => {
  // The registry IS the documentation — an entry without a label, cadence or
  // description puts a nameless toggle on the settings screen, which is how
  // this drifted back into being unreadable in the first place.
  for (const sw of NOTIFICATION_SWITCHES) {
    suite.expectEqual(sw.label.length > 0, true, `${sw.key} label`);
    suite.expectEqual(sw.cadence.length > 0, true, `${sw.key} cadence`);
    suite.expectEqual(sw.description.length > 10, true, `${sw.key} description`);
  }
});

await suite.test("today's production behaviour is preserved exactly", async () => {
  // The migration promise: on the day this ships, with no overrides set, every
  // switch resolves to what it resolved to before. Pinned against the real
  // production environment as of 2026-09-07 — the two mute switches Sarah asked
  // for are off, the rest sit at their defaults.
  //
  // RE-PINNED 2026-09-10 for sales_weekly_reports: false -> true. Not drift.
  // e62c781d turned that report from an opt-in weekly digest into the SDR/Sales
  // team's standing DAILY audit (Sarah: "the sales team solve most of them"),
  // so ON with no override is the new intended production behaviour. The key
  // and envVar keep their "weekly" names so stored overrides and configured
  // secrets keep resolving; only the cadence and the default changed.
  //
  // Every other value below is still the 2026-09-07 pin. Moving one of these
  // should always mean a deliberate, attributed decision like that one — if a
  // value here starts disagreeing with the registry for any other reason, the
  // registry is what changed by accident, not this list.
  const prod = {
    HEALTH_PULSE_SLACK_ALERTS: undefined,
    FRAUD_REMINDERS_ENABLED: undefined,
    PLATFORM_SLACK_MUTE: undefined,
  } as unknown as NodeJS.ProcessEnv;

  const expected: Record<string, boolean> = {
    platform_slack_announcements: true,
    health_pulse_slack: false,
    fraud_reminders: false,
    sales_weekly_reports: true,
    direct_audit_slack: true,
    missing_docs_report: false,
    cs_overlap_alert: true,
    cs_lifecycle_alert: true,
  };
  for (const sw of NOTIFICATION_SWITCHES) {
    suite.expectEqual(
      resolveFromEnv(sw, prod).enabled,
      expected[sw.key],
      sw.key,
    );
  }
});

suite.finishOrExit();
