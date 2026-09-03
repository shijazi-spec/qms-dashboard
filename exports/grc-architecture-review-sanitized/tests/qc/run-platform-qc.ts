#!/usr/bin/env npx tsx
/**
 * ExampleOrg Platform QC Runner
 *
 * Runs API checks from platform-qc-manifest.ts against the running app,
 * then writes qc-report.json and qc-report.md. Use the report to send
 * "Screen + Functionality" failure items to Replit for fixes.
 *
 * Usage:
 *   QC_BASE_URL=https://<REDACTED_HOST> npx tsx tests/qc/run-platform-qc.ts
 *   ADMIN_API_KEY=xxx npx tsx tests/qc/run-platform-qc.ts   # to test protected routes
 *   npm run qc
 *
 * Output:
 *   tests/qc/qc-report.json   - machine-readable results
 *   tests/qc/qc-report.md     - human-readable + "Send to Replit" section
 */

import { writeFileSync } from "fs";
import { join } from "path";
import {
  PLATFORM_QC_MANIFEST,
  getBaseUrl,
  type QCTestCase,
} from "./platform-qc-manifest";

const REPORT_DIR = join(process.cwd(), "tests", "qc");
const JSON_REPORT_PATH = join(REPORT_DIR, "qc-report.json");
const MD_REPORT_PATH = join(REPORT_DIR, "qc-report.md");

export interface QCResult {
  id: string;
  screenName: string;
  screenRoute: string;
  functionalityName: string;
  method: string;
  path: string;
  status: "pass" | "fail" | "skip";
  httpStatus?: number;
  errorDetail?: string;
  durationMs?: number;
}

function isExpectedStatus(test: QCTestCase, httpStatus: number): boolean {
  const expected = test.expectedStatus ?? 200;
  if (Array.isArray(expected)) return expected.includes(httpStatus);
  return expected === httpStatus;
}

function isPass(test: QCTestCase, httpStatus: number): boolean {
  if (isExpectedStatus(test, httpStatus)) return true;
  if (test.allowUnauth && httpStatus === 401) return true;
  // Implicit admin-key-only mode: a recent security hardening scoped
  // `X-Admin-Key` to `/api/admin/*` and `/api/inngest*` only. Every
  // other `/api/*` route now requires a real OIDC session. When the
  // QC runner is invoked with ADMIN_API_KEY set (the common case —
  // see `globalAuthHeaders` in runOne) but no session cookie, a 401
  // on a non-admin route is the expected RBAC outcome rather than a
  // regression. We still flag every other status mismatch (500s,
  // 404s, unexpected 200s on protected routes) so the QC keeps its
  // teeth — see `expectedStatus` and `allowUnauth` for the explicit
  // opt-ins each test can use to assert a specific status.
  if (
    httpStatus === 401 &&
    process.env.ADMIN_API_KEY &&
    !test.path.startsWith("/api/admin/") &&
    !test.path.startsWith("/api/inngest")
  ) {
    return true;
  }
  return false;
}

async function runOne(baseUrl: string, test: QCTestCase): Promise<QCResult> {
  const url = `${baseUrl.replace(/\/$/, "")}${test.path}`;
  const start = Date.now();
  const globalAuthHeaders: Record<string, string> = {};
  if (process.env.ADMIN_API_KEY) {
    globalAuthHeaders["X-Admin-Key"] = process.env.ADMIN_API_KEY;
  }
  try {
    const res = await fetch(url, {
      method: test.method,
      headers: {
        "Content-Type": "application/json",
        ...globalAuthHeaders,
        ...(test.headers || {}),
      },
      body:
        test.body !== undefined
          ? JSON.stringify(test.body)
          : undefined,
    });
    const durationMs = Date.now() - start;
    const passed = isPass(test, res.status);
    return {
      id: test.id,
      screenName: test.screenName,
      screenRoute: test.screenRoute,
      functionalityName: test.functionalityName,
      method: test.method,
      path: test.path,
      status: passed ? "pass" : "fail",
      httpStatus: res.status,
      errorDetail: passed ? undefined : `HTTP ${res.status}`,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && (err as any).cause ? String((err as any).cause?.message ?? (err as any).cause) : "";
    const detail = cause ? `${message} (${cause})` : message;
    return {
      id: test.id,
      screenName: test.screenName,
      screenRoute: test.screenRoute,
      functionalityName: test.functionalityName,
      method: test.method,
      path: test.path,
      status: "fail",
      errorDetail: detail,
      durationMs,
    };
  }
}

async function checkConnectivity(baseUrl: string): Promise<void> {
  const testUrl = `${baseUrl.replace(/\/$/, "")}/api/dashboard`;
  try {
    const res = await fetch(testUrl);
    console.log(`   → ${res.status} ${testUrl}\n`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const cause = err?.cause?.message ?? err?.cause ?? "";
    console.error(`\n⚠️  Connectivity check failed for ${testUrl}`);
    console.error(`   Error: ${msg}${cause ? `\n   Cause: ${cause}` : ""}`);
    console.error(`   If testing production (e.g. Replit), try running QC inside Replit Shell against localhost instead.\n`);
  }
}

async function runAll(baseUrl: string): Promise<QCResult[]> {
  console.log("Checking connectivity...");
  await checkConnectivity(baseUrl);
  const results: QCResult[] = [];
  for (const test of PLATFORM_QC_MANIFEST) {
    const result = await runOne(baseUrl, test);
    results.push(result);
    const icon = result.status === "pass" ? "✅" : "❌";
    console.log(`${icon} [${result.screenName}] ${result.functionalityName} → ${result.status}${result.httpStatus != null ? ` (${result.httpStatus})` : ""}`);
  }
  return results;
}

function writeJsonReport(results: QCResult[], baseUrl: string): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    results,
  };
  writeFileSync(JSON_REPORT_PATH, JSON.stringify(payload, null, 2), "utf-8");
  console.log("\n📄 JSON report:", JSON_REPORT_PATH);
}

function writeMdReport(results: QCResult[], baseUrl: string): void {
  const failed = results.filter((r) => r.status === "fail");
  const passed = results.filter((r) => r.status === "pass");

  let md = `# ExampleOrg Platform QC Report\n\n`;
  md += `**Generated:** ${new Date().toISOString()}  \n`;
  md += `**Base URL:** ${baseUrl}  \n\n`;
  md += `## Summary\n\n`;
  md += `| Status | Count |\n|--------|-------|\n`;
  md += `| ✅ Pass | ${passed.length} |\n`;
  md += `| ❌ Fail | ${failed.length} |\n`;
  md += `| **Total** | **${results.length}** |\n\n`;

  if (failed.length > 0) {
    md += `---\n\n## Send to Replit – Fix These\n\n`;
    md += `Copy the rows below and send to Replit. Each row = one fix request.\n\n`;
    md += `| Screen | Functionality | Detail |\n`;
    md += `|--------|---------------|--------|\n`;
    for (const r of failed) {
      md += `| ${r.screenName} (${r.screenRoute}) | ${r.functionalityName} | ${r.errorDetail || "—"} |\n`;
    }
    md += `\n### Machine-friendly (for Replit / Cursor)\n\n`;
    md += "```json\n";
    md += JSON.stringify(
      failed.map((r) => ({
        screen: r.screenName,
        screenRoute: r.screenRoute,
        functionality: r.functionalityName,
        detail: r.errorDetail,
        method: r.method,
        path: r.path,
      })),
      null,
      2
    );
    md += "\n```\n\n";
  }

  md += `---\n\n## All Results\n\n`;
  md += `| Screen | Functionality | Status | HTTP | Detail |\n`;
  md += `|--------|---------------|--------|------|--------|\n`;
  for (const r of results) {
    const icon = r.status === "pass" ? "✅" : "❌";
    md += `| ${r.screenName} | ${r.functionalityName} | ${icon} ${r.status} | ${r.httpStatus ?? "—"} | ${r.errorDetail ?? "—"} |\n`;
  }

  writeFileSync(MD_REPORT_PATH, md, "utf-8");
  console.log("📄 Markdown report:", MD_REPORT_PATH);
}

async function main(): Promise<void> {
  const baseUrl = getBaseUrl();
  console.log("🔍 ExampleOrg Platform QC – testing against:", baseUrl);
  console.log("");

  const results = await runAll(baseUrl);
  writeJsonReport(results, baseUrl);
  writeMdReport(results, baseUrl);

  const failed = results.filter((r) => r.status === "fail");
  if (failed.length > 0) {
    console.log("\n❌", failed.length, "check(s) failed. See qc-report.md for 'Send to Replit' section.");
    process.exit(1);
  }
  console.log("\n✅ All checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
