/**
 * Unit tests for `src/utils/alertEmailRecipients.ts` — Task #573.
 *
 * Focused on the pure (non-DB) helpers:
 *   - normaliseEmail        — validation + lower-casing
 *   - parseChannel          — closed-set channel guard
 *   - parseRecipientsEnvValue — comma-list parsing for the env fallback
 *   - resolveEffectiveRecipients — DB-vs-env precedence (with an
 *                                  injected `list` stub so the test
 *                                  never touches the real DB)
 *
 * The DB-mutating helpers (addAlertRecipient / removeAlertRecipient /
 * listAlertRecipientsAudit) are exercised end-to-end via the admin
 * route + dashboard UI and are not re-covered here to avoid a hard
 * Postgres dependency in this unit test file.
 */

import {
  normaliseEmail,
  parseChannel,
  parseRecipientsEnvValue,
  resolveEffectiveRecipients,
  ALERT_CHANNELS,
} from "../src/utils/alertEmailRecipients";

let passed = 0;
let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function run(): Promise<void> {
  console.log("\nnormaliseEmail");
  {
    assert(normaliseEmail("<REDACTED_EMAIL>") === "<REDACTED_EMAIL>", "lower-cases input");
    assert(normaliseEmail("  <REDACTED_EMAIL>  ") === "<REDACTED_EMAIL>", "trims whitespace");
    assert(normaliseEmail("not-an-email") === null, "rejects no-@");
    assert(normaliseEmail("<REDACTED_EMAIL>") === null, "rejects no-tld");
    assert(normaliseEmail("<REDACTED_EMAIL>") === null, "rejects 1-char tld");
    assert(normaliseEmail("") === null, "rejects empty");
    assert(normaliseEmail("   ") === null, "rejects whitespace-only");
    assert(normaliseEmail(undefined) === null, "rejects undefined");
    assert(normaliseEmail(123) === null, "rejects non-string");
    assert(normaliseEmail("has <REDACTED_EMAIL>") === null, "rejects whitespace inside");
    const tooLong = "a".repeat(250) + "@<REDACTED_HOST>";
    assert(normaliseEmail(tooLong) === null, "rejects > 254 chars");
  }

  console.log("\nparseChannel");
  {
    assert(parseChannel("post_restore_sweep") === "post_restore_sweep", "post_restore_sweep accepted");
    assert(parseChannel("ai_cost") === "ai_cost", "ai_cost accepted");
    assert(parseChannel("hacker") === null, "unknown channel rejected");
    assert(parseChannel("") === null, "empty rejected");
    assert(parseChannel(undefined) === null, "undefined rejected");
    assert(parseChannel(42) === null, "non-string rejected");
    assert(
      ALERT_CHANNELS.length === 2 &&
        ALERT_CHANNELS.includes("post_restore_sweep") &&
        ALERT_CHANNELS.includes("ai_cost"),
      "ALERT_CHANNELS exposes the closed set",
    );
  }

  console.log("\nparseRecipientsEnvValue");
  {
    assert(parseRecipientsEnvValue("<REDACTED_EMAIL>").join(",") === "<REDACTED_EMAIL>", "single entry");
    assert(
      parseRecipientsEnvValue("<REDACTED_EMAIL>, <REDACTED_EMAIL> , <REDACTED_EMAIL>").join("|") ===
        "<REDACTED_EMAIL>|<REDACTED_EMAIL>|<REDACTED_EMAIL>",
      "multi-entry trim",
    );
    assert(
      parseRecipientsEnvValue("<REDACTED_EMAIL>, <REDACTED_EMAIL>, <REDACTED_EMAIL>").join("|") === "<REDACTED_EMAIL>|<REDACTED_EMAIL>",
      "case-insensitive de-dupe",
    );
    assert(parseRecipientsEnvValue(" , , ").length === 0, "whitespace-only → empty");
    assert(parseRecipientsEnvValue("").length === 0, "empty string → empty");
    assert(parseRecipientsEnvValue(undefined).length === 0, "undefined → empty");
    assert(parseRecipientsEnvValue(null).length === 0, "null → empty");
  }

  console.log("\nresolveEffectiveRecipients precedence");
  {
    // DB list non-empty wins over env.
    const r1 = await resolveEffectiveRecipients(
      "post_restore_sweep",
      "<REDACTED_EMAIL>",
      {
        list: async () => [
          { email: "<REDACTED_EMAIL>", added_by: "admin", added_at: new Date() },
        ],
      },
    );
    assert(r1.source === "db", "source=db when DB list non-empty");
    assert(
      r1.recipients.length === 1 && r1.recipients[0] === "<REDACTED_EMAIL>",
      "DB list returned, env ignored",
    );

    // DB empty → env fallback.
    const r2 = await resolveEffectiveRecipients(
      "post_restore_sweep",
      "<REDACTED_EMAIL>, <REDACTED_EMAIL>",
      { list: async () => [] },
    );
    assert(r2.source === "env", "source=env when DB empty + env set");
    assert(
      r2.recipients.length === 2 && r2.recipients[0] === "<REDACTED_EMAIL>",
      "env list parsed and returned",
    );

    // Both empty → none.
    const r3 = await resolveEffectiveRecipients(
      "post_restore_sweep",
      "",
      { list: async () => [] },
    );
    assert(r3.source === "none", "source=none when both empty");
    assert(r3.recipients.length === 0, "no recipients returned");

    // DB list with case-only duplicates de-duped defensively.
    const r4 = await resolveEffectiveRecipients(
      "post_restore_sweep",
      "<REDACTED_EMAIL>",
      {
        list: async () => [
          { email: "<REDACTED_EMAIL>", added_by: null, added_at: null },
          { email: "<REDACTED_EMAIL>", added_by: null, added_at: null },
          { email: "<REDACTED_EMAIL>", added_by: null, added_at: null },
        ],
      },
    );
    assert(r4.source === "db", "source=db on duplicates");
    assert(
      r4.recipients.length === 2 && r4.recipients[0] === "<REDACTED_EMAIL>",
      "case-insensitive dedupe preserves first occurrence",
    );

    // Resolver tolerates a list-fn that throws → falls through to env.
    // (The real resolver wraps DB errors inside listAlertRecipients —
    // here we assert callers can plug in any list fn that returns []
    // on error to get the env-fallback behaviour.)
    const r5 = await resolveEffectiveRecipients(
      "ai_cost",
      "<REDACTED_EMAIL>",
      { list: async () => [] },
    );
    assert(
      r5.source === "env" && r5.recipients[0] === "<REDACTED_EMAIL>",
      "ai_cost channel resolves with env fallback",
    );
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
