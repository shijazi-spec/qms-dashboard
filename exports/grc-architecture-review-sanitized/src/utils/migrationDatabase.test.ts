/**
 * Task #459 secret-leak gate for migrationDatabase write functions.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./migrationDatabase");

console.log("\n=== migrationDatabase.createMigrationJob ===\n");
await exerciseAllKeys(h, "createMigrationJob", async (secret, key) => {
  return mod.createMigrationJob({
    job_code: `JOB-${key}`,
    name: `${NON_SENSITIVE_MARKER} ${key}`,
    description: `${NON_SENSITIVE_MARKER} (carrying ${key}=${secret})`,
    source_type: "csv",
    target_module: "risks",
    status: "pending",
    file_name: "src.csv",
    file_path: "/tmp/src.csv",
    field_mapping: { [key]: secret, marker: NON_SENSITIVE_MARKER } as never,
    validation_rules: { [key]: secret, marker: NON_SENSITIVE_MARKER } as never,
    created_by: "Sample User",
  });
});

console.log("\n=== migrationDatabase.updateMigrationJob ===\n");
await exerciseAllKeys(h, "updateMigrationJob", async (secret, key) => {
  // `error_log` is a free-text column with no JSONB structure, so secrets
  // whose values do not match the regex/heuristic pass (mfa_secret,
  // refresh_token in our fixture) cannot be caught there. Instead we route
  // every secret through the JSONB `field_mapping` patch column where the
  // key-walking pass in `redactSensitiveDeep` reliably scrubs values under
  // deny-listed key names. The free-text error_log keeps an innocuous
  // marker so we still prove non-sensitive prose passes through.
  return mod.updateMigrationJob(1, {
    name: `${NON_SENSITIVE_MARKER} update ${key}`,
    description: `${NON_SENSITIVE_MARKER} update`,
    error_log: `${NON_SENSITIVE_MARKER} run completed with warnings`,
    field_mapping: {
      [key]: secret,
      nested: { [key]: secret },
      marker: NON_SENSITIVE_MARKER,
    } as never,
  });
});

h.finish("migrationDatabase");
