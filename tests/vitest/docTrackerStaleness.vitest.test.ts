/**
 * Documentation collector dead-man's switch.
 *
 * The property under test: a tracker that has quietly stopped updating is WORSE
 * than no tracker, because it is trusted. "No data" must never be classified as
 * healthy. Every branch below that returns 'ok' is therefore a claim that the
 * board can be believed.
 *
 * The ages are supplied by the database clock in production; the decision is
 * pure so it can be verified here without one.
 */

import { describe, expect, test } from "vitest";
import {
  computeHealthState,
  isAlertDue,
  isDegraded,
  STALE_AFTER_HOURS,
  SILENT_AFTER_MINUTES,
  ALERT_EVERY_HOURS,
} from "../../src/utils/docTrackerStaleness";

const state = (
  snapshotHours: number | null,
  heartbeatMinutes: number | null,
  enabled = true,
) => computeHealthState({ enabled, snapshotHours, heartbeatMinutes });

describe("thresholds match the specification", () => {
  test("26h snapshot / 90min heartbeat / 20h re-alert", () => {
    expect(STALE_AFTER_HOURS).toBe(26);
    expect(SILENT_AFTER_MINUTES).toBe(90);
    expect(ALERT_EVERY_HOURS).toBe(20);
  });
});

describe("health state", () => {
  test("a collector pushing and heartbeating is ok", () => {
    expect(state(1, 5)).toBe("ok");
  });

  test("no snapshot past the threshold is stale (the headline rule)", () => {
    expect(state(30, 5)).toBe("stale");
    expect(state(26, 5)).toBe("stale");
    expect(state(25.9, 5)).not.toBe("stale");
  });

  test("no heartbeat past the threshold is silent (the early warning)", () => {
    // Catches "the service died at 09:00" roughly a day before the snapshot
    // rule would notice.
    expect(state(1, 91)).toBe("silent");
    expect(state(1, 90)).toBe("silent");
    expect(state(1, 89)).toBe("ok");
  });

  test("NEVER having reported is degraded, not healthy", () => {
    // The dangerous case: an empty board that gets believed.
    expect(state(null, 5)).toBe("stale");
    expect(state(1, null)).toBe("silent");
    expect(state(null, null)).toBe("stale");
  });

  test("stale outranks silent", () => {
    // A collector heartbeating happily for a week without ever pushing data is
    // a missing-snapshot finding; reporting "the agent is quiet" understates it.
    expect(state(30, 999)).toBe("stale");
  });

  test("an explicitly disabled collector is not reported as broken", () => {
    expect(state(30, 999, false)).toBe("disabled");
  });

  test("only stale and silent warrant an operator alert", () => {
    expect(isDegraded("stale")).toBe(true);
    expect(isDegraded("silent")).toBe(true);
    expect(isDegraded("ok")).toBe(false);
    expect(isDegraded("disabled")).toBe(false);
  });
});

describe("per-collector alert gate", () => {
  test("the first alert always fires", () => {
    expect(isAlertDue(null)).toBe(true);
  });

  test("the 45-minute loop cannot re-send inside the window", () => {
    // Without this the housekeeping loop would email roughly every 45 minutes
    // for as long as the collector stays down.
    expect(isAlertDue(1)).toBe(false);
    expect(isAlertDue(19)).toBe(false);
  });

  test("a still-degraded collector is re-alerted after the window", () => {
    expect(isAlertDue(20)).toBe(true);
    expect(isAlertDue(48)).toBe(true);
  });
});
