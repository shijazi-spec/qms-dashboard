/**
 * Task #459 secret-leak gate for pdplDatabase.
 *
 * Each writer below also calls `logPdplAction(..., entity)` which JSON-
 * stringifies the WHOLE entity into the audit log's `metadata` JSONB column.
 * The redactedPool wrapper auto-parses each JSON-prefixed param at the top
 * level and walks it via `redactSensitiveDeep`, so we attach the deny-list
 * key as a top-level property of the entity itself (via `as never`). That
 * way both the per-column INSERT params (column-specific writes) and the
 * audit-log metadata blob (full-entity write) catch the secret structurally,
 * regardless of whether the value matches a regex heuristic.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./pdplDatabase");

console.log("\n=== pdplDatabase.addDataInventoryItem ===\n");
await exerciseAllKeys(h, "addDataInventoryItem", async (secret, key) => {
  return mod.addDataInventoryItem(
    {
      field_name: `f-${key}`,
      field_description: `${NON_SENSITIVE_MARKER} description`,
      data_category: "personal" as never,
      module: "users",
      table_name: "platform_users",
      purpose: NON_SENSITIVE_MARKER,
      legal_basis: "consent",
      storage_location: "saudi-region",
      access_roles: [`role:${NON_SENSITIVE_MARKER}`],
      retention_days: 365,
      is_encrypted: true,
      is_masked: false,
      pii_type: "email",
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
    } as never,
    "<REDACTED_EMAIL>",
  );
});

console.log("\n=== pdplDatabase.createDSARRequest ===\n");
await exerciseAllKeys(h, "createDSARRequest", async (secret, key) => {
  return mod.createDSARRequest(
    {
      request_type: "access" as never,
      subject_name: NON_SENSITIVE_MARKER,
      subject_email: "<REDACTED_EMAIL>",
      subject_identifier: `id-${key}`,
      request_description: `${NON_SENSITIVE_MARKER} request body`,
      assigned_to: "Sample User",
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
    } as never,
    "<REDACTED_EMAIL>",
  );
});

console.log("\n=== pdplDatabase.createDataIncident ===\n");
await exerciseAllKeys(h, "createDataIncident", async (secret, key) => {
  return mod.createDataIncident(
    {
      title: `${NON_SENSITIVE_MARKER} incident`,
      description: `${NON_SENSITIVE_MARKER} description`,
      severity: "medium" as never,
      data_types_affected: [`type:${NON_SENSITIVE_MARKER}`],
      records_affected: 1,
      notification_required: false,
      assigned_to: "Sample User",
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
    } as never,
    "<REDACTED_EMAIL>",
  );
});

h.finish("pdplDatabase");
