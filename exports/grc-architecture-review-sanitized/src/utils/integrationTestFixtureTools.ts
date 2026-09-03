/**
 * Integration-test fixture tools — registered at server startup so the
 * live-HTTP integration suite can POST to /api/ai/approvals/:code/approve
 * and verify that the full HTTP stack redacts secrets in the response.
 *
 * IMPORTANT: Registration is guarded by NODE_ENV !== 'production' so
 * these no-op tools are never present in the production gated-tool registry.
 * They are only active in development and test environments where the
 * live-HTTP integration test (`tests/aiApprovalRoutesRedaction.integration.ts`)
 * is expected to run.
 *
 * Two tools are registered when the guard passes:
 *   1. <REDACTED_SECRET>__ok     — returns credential-shaped
 *      values (key-based + regex-based deny lists exercised).
 *   2. <REDACTED_SECRET>__throws — throws an Error whose
 *      message embeds a credential; verifies the catch branch scrubs it.
 *
 * The tool IDs are prefixed with "integration-test-" so they are trivially
 * identifiable as fixtures during code review and in any approvals UI.
 *
 * Cleanup: registration mutates only in-memory objects (TOOL_GOVERNANCE_POLICIES
 * and the wrappedRegistry Map). Both are reset when the server process restarts,
 * so there is no persistent state to clean up. Seeded ai_pending_actions rows
 * are cleaned up by the integration test's `finally` block.
 */

import { TOOL_GOVERNANCE_POLICIES } from './aiToolGovernance';
import { withApprovalGate } from './withApprovalGate';

/* ------------------------------------------------------------------ */
/* Fixture tool IDs — referenced by the integration test script       */
/* ------------------------------------------------------------------ */

export const INT_TEST_OK_TOOL_ID =
  '<REDACTED_SECRET>__ok';
export const INT_TEST_THROW_TOOL_ID =
  '<REDACTED_SECRET>__throws';

/* ------------------------------------------------------------------ */
/* Secret constants embedded in tool results                          */
/* These are INTENTIONALLY credential-shaped (server-side) so the    */
/* test can verify they never reach the HTTP client response body.    */
/*                                                                    */
/* Using "INT" in the value strings distinguishes them from the       */
/* in-process unit-test constants so a leak from one test cannot      */
/* mask a regression in the other.                                    */
/* ------------------------------------------------------------------ */

export const INT_APPROVE_RESULT_SK_KEY =
  '<REDACTED_SECRET>';
export const INT_APPROVE_RESULT_GH_TOKEN =
  '<REDACTED_SECRET>';
export const INT_APPROVE_RESULT_BCRYPT =
  '<REDACTED_PASSWORD_HASH>';
export const INT_APPROVE_RESULT_ACCESS =
  'eyJhbGciLEAKDETECTORINTAPPROVE_freshaccesstoken9988';
export const INT_APPROVE_THROW_SK_KEY =
  '<REDACTED_SECRET>';

/* ------------------------------------------------------------------ */
/* Conditional registration: development/test only                    */
/* ------------------------------------------------------------------ */

if (process.env.NODE_ENV !== 'production') {
  TOOL_GOVERNANCE_POLICIES[INT_TEST_OK_TOOL_ID] = {
    toolId: INT_TEST_OK_TOOL_ID,
    label: '[Integration-Test] Redaction Canary (success)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: ['REDACTION-INTEGRATION-TEST'],
    entityType: 'integration',
    buildPreview: () => 'Redaction canary — success path (integration test)',
  };

  TOOL_GOVERNANCE_POLICIES[INT_TEST_THROW_TOOL_ID] = {
    toolId: INT_TEST_THROW_TOOL_ID,
    label: '[Integration-Test] Redaction Canary (throws)',
    riskLevel: 'high',
    requiresApproval: true,
    complianceRefs: ['REDACTION-INTEGRATION-TEST'],
    entityType: 'integration',
    buildPreview: () => 'Redaction canary — throw path (integration test)',
  };

  withApprovalGate({
    id: INT_TEST_OK_TOOL_ID,
    description:
      '[Integration-Test] No-op tool that returns credential-shaped values. ' +
      'Used exclusively by the live-HTTP redaction integration test.',
    execute: async () => ({
      success: true,
      rotated: true,
      new_api_key: <REDACTED_SECRET>
      access_token: <REDACTED_SECRET>
      nested: {
        free_form_note: `Vendor returned token: ${INT_APPROVE_RESULT_GH_TOKEN}`,
        legacy_password_hash_blob: <REDACTED_SECRET>
      },
      audit_note: 'Integration-test canary rotation completed',
    }),
  });

  withApprovalGate({
    id: INT_TEST_THROW_TOOL_ID,
    description:
      '[Integration-Test] No-op tool that throws with a secret in the message. ' +
      'Used exclusively by the live-HTTP redaction integration test.',
    execute: async () => {
      throw new Error(
        `Vendor refused rotation; offending key was ${INT_APPROVE_THROW_SK_KEY}`,
      );
    },
  });
}
