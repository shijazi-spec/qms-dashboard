/**
 * Task #591 — Drift guard: dispatchPostRestoreSweepAlert vs.
 * STAGING_EMAIL_VERIFICATION.md.
 *
 * Why this script exists
 * ----------------------
 * The staging verification procedure
 * (`audit-evidence/STAGING_EMAIL_VERIFICATION.md`) hard-codes specifics
 * about how `dispatchPostRestoreSweepAlert` (in
 * `src/utils/redactHistoricalLogs.ts`) renders its three channels:
 *
 *   - Slack body — the leading `:rotating_light:` shortcode.
 *   - In-app notification — `module="security/redaction-sweep"`,
 *     `priority="critical"`, `action_url="/audit-logs"`.
 *   - Per-table detail line — `event_logs=…, nc_change_history=…,
 *     capa_change_history=…, ai_pending_actions=…`.
 *
 * Operators read the procedure top-to-bottom while running a staging
 * dry-run and tick boxes against what they actually see in their inbox /
 * Slack channel / dashboard bell. If the dispatcher renames any of those
 * tokens without the procedure being updated, the visual checklist will
 * silently start either:
 *
 *   - failing on healthy code (operators chase ghosts), or
 *   - passing on regressions (the procedure rubber-stamps a broken page).
 *
 * Either outcome erodes trust in the procedure. The dispatcher's unit
 * tests (`tests/redactPostRestoreSweepAlert.test.ts`) lock the *behaviour*
 * but cannot enforce that the *prose document* describing that behaviour
 * stays in sync — that's what this script does.
 *
 * What it does
 * ------------
 * Extracts the relevant string literals from the dispatcher source and
 * asserts each appears verbatim in the staging procedure. Fails the run
 * with a precise pointer to (a) the source location, (b) the exact token
 * that needs to appear, and (c) the doc section that needs editing.
 *
 * If the script can't even *find* the dispatcher anchor (it was
 * renamed/moved), it fails too — that's a louder regression than a token
 * rename and the script's anchor itself needs updating in lock-step.
 *
 * Wiring
 * ------
 * Run as a step in:
 *   - `.github/workflows/secret-redaction.yml` (GitHub Actions, blocks PR)
 *   - `secret-redaction` workflow in `.replit` (local convenience)
 *
 * Manual run:
 *   npx tsx scripts/checkStagingProcedureInSync.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SOURCE_PATH = resolve(REPO_ROOT, "src/utils/redactHistoricalLogs.ts");
const DOC_PATH = resolve(
  REPO_ROOT,
  "audit-evidence/STAGING_EMAIL_VERIFICATION.md",
);

const source = readFileSync(SOURCE_PATH, "utf-8");
const doc = readFileSync(DOC_PATH, "utf-8");

// ---------------------------------------------------------------------------
// Locate the dispatcher function body so we don't grep unrelated code in the
// same (large) file.
// ---------------------------------------------------------------------------

const FN_ANCHOR = "export async function dispatchPostRestoreSweepAlert";
const fnStart = source.indexOf(FN_ANCHOR);
if (fnStart === -1) {
  console.error(
    `[checkStagingProcedureInSync] FAIL — could not find anchor:\n` +
      `  '${FN_ANCHOR}'\n` +
      `in ${SOURCE_PATH}\n\n` +
      `If dispatchPostRestoreSweepAlert was renamed or moved, update both\n` +
      `this script's FN_ANCHOR AND every reference to the function name in\n` +
      `audit-evidence/STAGING_EMAIL_VERIFICATION.md.`,
  );
  process.exit(1);
}
// The next top-level `export` (preceded by a newline) marks the end of the
// function body. If there isn't one, the function is the last thing in the
// file and we walk to EOF.
const fnEnd = source.indexOf("\nexport ", fnStart + FN_ANCHOR.length);
const fnBody = source.slice(fnStart, fnEnd === -1 ? source.length : fnEnd);

// ---------------------------------------------------------------------------
// Define the checks. Each one extracts a literal from the dispatcher and
// produces the verbatim token(s) that must appear in the doc.
// ---------------------------------------------------------------------------

interface Check {
  /** Short identifier surfaced in failure messages. */
  name: string;
  /**
   * Pull the literal from the dispatcher source. Returns null if the source
   * itself has drifted away from what the script knows how to extract — in
   * that case the script can't validate the doc and reports the source
   * regression so both can be updated in lock-step.
   */
  extract: () => string | null;
  /** Verbatim token(s) the doc must contain for this check. */
  docTokens: (extracted: string) => string[];
  /** Where in the source the literal lives (for failure messages). */
  sourceLocation: string;
  /** Where in the doc the operator-facing reference lives. */
  docSection: string;
}

function extractFirstGroup(re: RegExp): () => string | null {
  return () => {
    const m = re.exec(fnBody);
    return m ? m[1] : null;
  };
}

function extractLiteral(needle: string): () => string | null {
  return () => (fnBody.includes(needle) ? needle : null);
}

const COUNTER_NAMES = [
  "event_logs",
  "nc_change_history",
  "capa_change_history",
  "ai_pending_actions",
] as const;

const checks: Check[] = [
  {
    name: "notification.module",
    extract: extractFirstGroup(/module:\s*"([^"]+)"/),
    docTokens: (v) => [`module="${v}"`],
    sourceLocation:
      'createNotification({ module: "..." }) inside dispatchPostRestoreSweepAlert',
    docSection:
      'Pre-requisites step 5 ("module=…") and Procedure C Step 1 ("module=\\"security/redaction-sweep\\"")',
  },
  {
    name: "notification.priority",
    extract: extractFirstGroup(/priority:\s*"([^"]+)"/),
    docTokens: (v) => [`priority="${v}"`],
    sourceLocation:
      'createNotification({ priority: "..." }) inside dispatchPostRestoreSweepAlert',
    docSection:
      'Pre-requisites step 5 and Procedure C Step 1 ("priority=\\"critical\\"")',
  },
  {
    name: "notification.action_url",
    extract: extractFirstGroup(/action_url:\s*"([^"]+)"/),
    docTokens: (v) => [`action_url="${v}"`],
    sourceLocation:
      'createNotification({ action_url: "..." }) inside dispatchPostRestoreSweepAlert',
    docSection:
      'Procedure C Step 1 ("action_url=\\"/audit-logs\\"") and the "Action URL" visual check',
  },
  {
    name: "slack.rotating_light_prefix",
    extract: extractLiteral(":rotating_light:"),
    docTokens: () => [":rotating_light:"],
    sourceLocation:
      "slackBody.text template inside dispatchPostRestoreSweepAlert",
    docSection:
      '"Why this exists" item 3, Pre-requisites step 4, and Procedure B Step 2 ("Headline line")',
  },
  // Each of the four counter names must appear in the dispatcher's
  // detailLine template AND in the doc's per-table-counts shape.
  ...COUNTER_NAMES.map(
    (counter): Check => ({
      name: `counter.${counter}`,
      // The dispatcher renders the token as `${counter}=${triggers.${counter}}`
      // — match exactly that to detect a rename of either the column or the
      // template variable.
      extract: extractLiteral(`${counter}=\${triggers.${counter}}`),
      docTokens: () => [`${counter}=`],
      sourceLocation:
        "detailLine template inside dispatchPostRestoreSweepAlert " +
        `(\`${counter}=\${triggers.${counter}}\`)`,
      docSection:
        "detail-line shape repeated in Procedures A/B/C " +
        '("event_logs=…, nc_change_history=…, capa_change_history=…, ai_pending_actions=…")',
    }),
  ),
];

// ---------------------------------------------------------------------------
// Run the checks.
// ---------------------------------------------------------------------------

const failures: string[] = [];

for (const check of checks) {
  const value = check.extract();
  if (value == null) {
    failures.push(
      `❌ Source drift on '${check.name}'.\n` +
        `   Could not extract the expected literal from:\n` +
        `     ${check.sourceLocation}\n` +
        `     in ${SOURCE_PATH}\n` +
        `   The dispatcher has been refactored in a way this script does not\n` +
        `   recognise. Update this script's extractor for '${check.name}' AND\n` +
        `   the matching doc section:\n` +
        `     ${check.docSection}\n` +
        `     in ${DOC_PATH}`,
    );
    continue;
  }
  for (const token of check.docTokens(value)) {
    if (!doc.includes(token)) {
      failures.push(
        `❌ Doc drift on '${check.name}'.\n` +
          `   Source value: ${JSON.stringify(value)}\n` +
          `     at ${check.sourceLocation}\n` +
          `     in ${SOURCE_PATH}\n` +
          `   Required verbatim token in doc: ${JSON.stringify(token)}\n` +
          `     was NOT found in ${DOC_PATH}\n` +
          `   Update the doc section that references this token:\n` +
          `     ${check.docSection}\n` +
          `   (or, if the doc is the source of truth, change the dispatcher\n` +
          `    back to the documented value).`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    "[checkStagingProcedureInSync] FAIL — dispatchPostRestoreSweepAlert and\n" +
      "audit-evidence/STAGING_EMAIL_VERIFICATION.md have drifted apart:\n",
  );
  for (const f of failures) console.error(f + "\n");
  console.error(
    "Fix: update either the dispatcher or the staging procedure so each token\n" +
      "above matches verbatim, then re-run:\n" +
      "  npx tsx scripts/checkStagingProcedureInSync.ts\n",
  );
  process.exit(1);
}

console.log(
  `[checkStagingProcedureInSync] OK — ${checks.length} dispatcher tokens still ` +
    `appear verbatim in audit-evidence/STAGING_EMAIL_VERIFICATION.md.`,
);
