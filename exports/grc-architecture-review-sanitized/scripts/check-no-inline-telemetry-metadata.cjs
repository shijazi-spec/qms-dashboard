#!/usr/bin/env node
/* eslint-disable */
/**
 * ExampleOrg — AI-telemetry metadata guardrail (Task #511)
 *
 * Defense-in-depth complement to the `BuiltAiCallTelemetryMetadata` brand
 * type (see src/utils/aiTelemetry.ts). The brand makes inline `metadata: { ... }`
 * literals at the three telemetry entry points fail TypeScript already, but
 * a determined caller can still bypass via `as any` / `as unknown as ...`
 * (or via an untyped JS shim) and slip a `catch (err)` payload into the
 * telemetry call. This grep-style scanner runs on every CI build and refuses
 * to merge code where any of the three entry points is fed an inline literal:
 *
 *   - withAiTelemetry({ ..., metadata: { ... } }, fn)
 *   - startTelemetrySpan({ ..., metadata: { ... } })
 *   - recordStreamTelemetry({ ..., metadata: { ... } })
 *
 * Allowed shape at every call site:
 *   metadata: buildAiCallTelemetryMetadata({ ... })
 *
 * Allowlist (intentionally tiny):
 *   - src/utils/aiTelemetry.ts (the helper itself)
 *   - tests/** and src/**\/__tests__/** that explicitly tag a line with
 *     the trailing comment `telemetry-metadata-bypass: <reason>`. Use this
 *     sparingly — it is the audit-trail marker a code reviewer should
 *     catch if it ever appears in non-test code.
 *
 * Wired into:
 *   - tests/noInlineTelemetryMetadata.test.ts (auto-discovered by
 *     tests/runIntegrationTests.ts → `npm test`)
 *   - .github/workflows/secret-redaction.yml — runs as a dedicated CI gate
 *     so a regression fails the merge with an obvious labelled summary.
 *
 * Standalone usage:
 *   node scripts/check-no-inline-telemetry-metadata.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY_POINTS = [
  'withAiTelemetry',
  'startTelemetrySpan',
  'recordStreamTelemetry',
];
const ENTRY_RE = new RegExp(
  `\\b(?:${ENTRY_POINTS.join('|')})\\s*[<(]`,
);
// Match a `metadata:` field whose value begins with `{` on the same logical
// line. Allows the explicit allowed shape (`metadata: buildAiCallTelemetryMetadata(`)
// and any non-literal expression (variable reference, function call) to pass.
const INLINE_METADATA_RE = /\bmetadata\s*:\s*\{/;
const BUILDER_RE = /\bbuildAiCallTelemetryMetadata\s*\(/;
const BYPASS_MARKER = 'telemetry-metadata-bypass';

const ALLOWLIST_FILES = new Set([
  // The helper file defines the shape and inserts a `metadata: {}` default
  // inside `buildAiCallTelemetryMetadata` itself.
  path.join('src', 'utils', 'aiTelemetry.ts'),
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.mastra') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|tsx|cts|mts|js|cjs|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const SEARCH_DIRS = ['src', 'tests', 'dashboard'].map(d => path.join(ROOT, d)).filter(p => fs.existsSync(p));

const violations = [];

for (const dir of SEARCH_DIRS) {
  const files = walk(dir);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    if (ALLOWLIST_FILES.has(rel)) continue;
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!ENTRY_RE.test(content)) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!ENTRY_RE.test(line)) continue;
      // Examine the call site: scan up to 25 lines forward (covers
      // multi-line option-object call sites like
      //   withAiTelemetry(
      //     { agentName: ..., model: ..., promptText: ...,
      //       metadata: buildAiCallTelemetryMetadata({...}) },
      //     fn,
      //   )
      // but stop early at the first matching closing-paren depth so we
      // never bleed into the next statement.
      const startLine = i;
      const endLine = Math.min(lines.length, i + 26);
      let depth = 0;
      let foundCallStart = false;
      for (let j = startLine; j < endLine; j++) {
        const slice = lines[j];
        for (const ch of slice) {
          if (ch === '(' || ch === '<') {
            depth++;
            foundCallStart = true;
          } else if (ch === ')' || ch === '>') {
            depth--;
          }
        }
        // Skip the entry-point line itself (a `metadata:` on the same line
        // is examined too, just rare in practice).
        if (foundCallStart) {
          const m = INLINE_METADATA_RE.exec(slice);
          if (m) {
            // Allow `metadata: buildAiCallTelemetryMetadata({...})` even
            // though it begins with `{` — the BUILDER_RE wins.
            if (BUILDER_RE.test(slice)) continue;
            // Honour the explicit bypass marker ONLY in test paths
            // (`tests/**`, `**/__tests__/**`, `*.test.ts`, `*.spec.ts`)
            // — production code must never opt out, per code-review
            // hardening. Reviewer suggestion (Task #511 follow-up):
            // restrict bypass scope so a stray annotation in src/ that
            // is not under __tests__ still fails the gate.
            const isTestPath =
              rel.startsWith('tests/') ||
              rel.startsWith('tests' + path.sep) ||
              rel.includes('/__tests__/') ||
              rel.includes(path.sep + '__tests__' + path.sep) ||
              /\.(test|spec)\.(ts|tsx|cts|mts|js|cjs|mjs)$/.test(rel);
            if (isTestPath) {
              const window = lines.slice(Math.max(0, j - 1), Math.min(lines.length, j + 2)).join('\n');
              if (window.includes(BYPASS_MARKER)) continue;
            }
            violations.push({
              file: rel,
              entry: line.trim(),
              entryLine: startLine + 1,
              metaLine: j + 1,
              snippet: slice.trimEnd(),
            });
          }
        }
        if (foundCallStart && depth <= 0) break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n✗ AI-telemetry metadata guardrail FAILED — ${violations.length} inline literal(s) at telemetry entry points:`,
  );
  console.error('');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.metaLine}`);
    console.error(`    entry  (line ${v.entryLine}): ${v.entry}`);
    console.error(`    inline (line ${v.metaLine}): ${v.snippet}`);
  }
  console.error('');
  console.error('Inline `metadata: { ... }` literals at withAiTelemetry() / startTelemetrySpan() /');
  console.error('recordStreamTelemetry() risk leaking secrets into ai_call_metrics.metadata. Build the');
  console.error('payload via `buildAiCallTelemetryMetadata({ promptVersion, ... })` instead — the closed');
  console.error('AiCallTelemetryMetadataInput allow-list prevents free-form keys derived from `catch (err)`,');
  console.error('raw HTTP headers, or tool output. See src/utils/aiTelemetry.ts for the full key list.');
  console.error('');
  console.error('If a TEST must exercise the WRITE-path scrubber with an intentionally dirty payload,');
  console.error('annotate the inline literal line with a trailing `// telemetry-metadata-bypass: <reason>`');
  console.error('comment. Production code MUST NOT use the bypass.');
  process.exit(1);
}

console.log('✓ AI-telemetry metadata guardrail PASS — every withAiTelemetry/startTelemetrySpan/recordStreamTelemetry');
console.log('  call site routes `metadata` through buildAiCallTelemetryMetadata() (Task #511).');
process.exit(0);
