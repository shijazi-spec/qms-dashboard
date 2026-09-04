// @ts-ignore - plain .mjs module without type declarations
import { isInvalidPackageTreeAuditError } from "../scripts/harden-mastra-output-dependencies.mjs";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log("generated dependency audit retry classification");

assert(
  isInvalidPackageTreeAuditError({
    message: "npm audit --omit=dev failed with exit code 1",
    npmOutput: "Invalid package tree, run npm install to rebuild your package-lock.json",
  }),
  "retries the package-firewall invalid-tree response",
);

assert(
  isInvalidPackageTreeAuditError(
    new Error("Invalid package tree, run npm install to rebuild your package-lock.json"),
  ),
  "recognizes the invalid-tree response in the error message",
);

assert(
  !isInvalidPackageTreeAuditError({
    message: "npm audit --omit=dev failed with exit code 1",
    npmOutput: "1 high severity vulnerability",
  }),
  "does not retry a real vulnerability finding",
);

assert(
  !isInvalidPackageTreeAuditError({
    message: "npm audit --omit=dev failed with exit code 1",
    npmOutput: "network timeout",
  }),
  "does not hide unrelated audit failures",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);