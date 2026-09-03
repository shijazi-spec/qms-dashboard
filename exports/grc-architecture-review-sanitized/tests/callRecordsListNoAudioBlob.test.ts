/**
 * Regression test for getCallRecords() in src/utils/callIntelligenceDb.ts
 *
 * ROOT-CAUSE GUARD (2026-05-29): the Call Records tab showed
 * "No call records found" even though rows existed, because getCallRecords
 * used `SELECT cr.*` which dragged the heavy audio_blob BYTEA column into the
 * /api/calls list response. For a 500-row list that serialized ~10-20 MB of
 * binary into JSON, blowing past the dashboard's 20s fetch abort so the
 * records fetch silently failed and the tab rendered zero rows.
 *
 * This test inserts a row WITH an audio_blob and asserts the list query:
 *   - returns the row,
 *   - OMITS the audio_blob binary,
 *   - KEEPS the small audio metadata (audio_blob_size/mime), recording_url,
 *     and the SDR score columns the UI relies on.
 *
 * Run:  npx tsx tests/callRecordsListNoAudioBlob.test.ts
 */

import {
  callIntelligencePool,
  initCallIntelligenceTables,
  createCallRecord,
  getCallRecords,
} from "../src/utils/callIntelligenceDb";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("callRecordsListNoAudioBlob");

console.log("\n=== getCallRecords audio_blob exclusion ===\n");

await initCallIntelligenceTables();

const callId = `test-noblob-${Date.now()}`;

await suite.test(
  "list query returns the row but excludes the audio_blob binary",
  async () => {
    await createCallRecord({
      call_id: callId,
      source: "manual",
      agent_email: "<REDACTED_EMAIL>",
      status: "qa_review_pending",
    } as any);

    // Attach a ~500KB fake audio_blob — the exact payload that used to break
    // the list response.
    await callIntelligencePool.query(
      `UPDATE call_records
          SET audio_blob = $2,
              audio_blob_mime = 'audio/mpeg',
              audio_blob_size = 500000,
              recording_url = '/uploads/calls/test.mp3'
        WHERE call_id = $1`,
      [callId, Buffer.alloc(500000, 7)],
    );

    const { records } = await getCallRecords({ limit: 500 });
    const row: any = records.find((r: any) => r.call_id === callId);

    suite.expect(!!row, "inserted row is present in the list");
    suite.expect(
      !Object.prototype.hasOwnProperty.call(row, "audio_blob"),
      "audio_blob binary must NOT be present in list rows",
    );
    suite.expect(
      row.audio_blob_size === 500000,
      "audio_blob_size metadata is preserved",
    );
    suite.expect(
      row.audio_blob_mime === "audio/mpeg",
      "audio_blob_mime metadata is preserved",
    );
    suite.expect(
      row.recording_url === "/uploads/calls/test.mp3",
      "recording_url (used for playback) is preserved",
    );
    suite.expect(
      Object.prototype.hasOwnProperty.call(row, "sdr_overall_score"),
      "sdr_overall_score column is still projected",
    );

    // Measure the isolated sentinel row, not every pre-existing call in the
    // shared development DB. Live rows may legitimately contain large
    // transcripts/metadata even when audio_blob is correctly excluded.
    const bytes = Buffer.byteLength(JSON.stringify(row));
    suite.expect(
      bytes < 100000,
      `sentinel row JSON should be small without the blob, got ${bytes} bytes`,
    );
  },
);

await suite.test("cleanup test row", async () => {
  await callIntelligencePool.query(
    "DELETE FROM call_records WHERE call_id = $1",
    [callId],
  );
  suite.expect(true, "cleanup done");
});

suite.finishOrExit();
