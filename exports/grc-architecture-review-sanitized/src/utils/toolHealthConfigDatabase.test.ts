/**
 * Task #459 secret-leak gate for toolHealthConfigDatabase write functions.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./toolHealthConfigDatabase");

console.log("\n=== toolHealthConfigDatabase.setToolHealthConfigOverrides ===\n");
await exerciseAllKeys(h, "setToolHealthConfigOverrides", async (secret, key) => {
  return mod.setToolHealthConfigOverrides({
    overrides: { windowMinutes: 60 },
    changedBy: `${NON_SENSITIVE_MARKER} ${key}`,
    note: `${NON_SENSITIVE_MARKER} (carrying ${key}=${secret})`,
    breachDiff: {
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
    } as never,
  });
});

h.finish("toolHealthConfigDatabase");
