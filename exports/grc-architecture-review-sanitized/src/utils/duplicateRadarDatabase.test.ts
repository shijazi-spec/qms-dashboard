import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./duplicateRadarDatabase");

console.log("\n=== duplicateRadarDatabase.createCluster ===\n");
await exerciseAllKeys(h, "createCluster", async (secret, key, payload) => {
  return mod.createCluster({
    domain: `example-${key}.com`,
    company_name: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    company_name_arabic: NON_SENSITIVE_MARKER,
    total_leads: 1,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 1,
    confidence_level: "high",
    confidence_score: 0.9,
    match_signals: [`signal:${NON_SENSITIVE_MARKER}`],
    owners_involved: [`owner:${NON_SENSITIVE_MARKER}`],
    estimated_pipeline_value: 1000,
    status: "active",
    ai_recommendation: NON_SENSITIVE_MARKER,
  } as never);
});

console.log("\n=== duplicateRadarDatabase.addRecordToCluster ===\n");
await exerciseAllKeys(h, "addRecordToCluster", async (secret, key, payload) => {
  return mod.addRecordToCluster({
    cluster_id: 1,
    record_type: "lead" as never,
    CRMProvider_record_id: `Z-${key}`,
    record_name: NON_SENSITIVE_MARKER,
    company_name: NON_SENSITIVE_MARKER,
    email: "user@example.invalid",
    domain: "<REDACTED_HOST>",
    phone: "+1-555-0100",
    owner_name: NON_SENSITIVE_MARKER,
    owner_email: "user@example.invalid",
    status: "active" as never,
    stage: "open",
    deal_value: 0,
    source: "test",
    is_primary: false,
    ai_recommendation: NON_SENSITIVE_MARKER,
    confidence_score: 0.9,
    is_mock_data: false,
    raw_data: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
  } as never);
});

h.finish("duplicateRadarDatabase");
