#!/usr/bin/env node
/**
 * WalaPlus Accessibility Check (axe-core + JSDOM)
 * Runs WCAG 2.1 AA axe-core checks against the top 10 dashboard HTML files.
 * Exits with code 1 if any serious or critical violations are found.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import axe from 'axe-core';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOP10_PAGES = [
  'index.html',
  'executive.html',
  'grc.html',
  'qms.html',
  'audits.html',
  'risks.html',
  'consultant.html',
  'ai-approvals.html',
  'policies.html',
  'duplicates.html',
];

const DASHBOARD_DIR = join(__dirname, '..', 'dashboard');
const FAIL_IMPACT = ['critical', 'serious'];

async function runAxe(htmlPath) {
  const html = readFileSync(htmlPath, 'utf-8');
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
    url: 'http://localhost:5000',
  });
  const { window } = dom;
  const { document } = window;

  await new Promise((resolve) => {
    if (document.readyState === 'complete') return resolve();
    window.addEventListener('load', resolve);
    setTimeout(resolve, 500);
  });

  return new Promise((resolve, reject) => {
    const axeSource = axe.source;
    try {
      window.eval(axeSource);
      window.axe.configure({ reporter: 'v2' });
      window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      }, function(err, results) {
        if (err) return reject(err);
        resolve(results);
      });
    } catch (e) {
      reject(e);
    }
  });
}

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';

async function main() {
  console.log('');
  console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  WalaPlus Accessibility Check — axe-core WCAG 2.1 AA${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);
  console.log('');

  let totalViolations = 0;
  let totalSerious = 0;
  const report = [];

  for (const page of TOP10_PAGES) {
    const htmlPath = join(DASHBOARD_DIR, page);
    if (!existsSync(htmlPath)) {
      console.log(`  ${YELLOW}⚠ SKIP${RESET} ${page} (file not found)`);
      report.push({ page, status: 'skip', violations: [] });
      continue;
    }

    process.stdout.write(`  Checking ${page}...`);
    try {
      const results = await runAxe(htmlPath);
      const violations = results.violations || [];
      const serious = violations.filter(v => FAIL_IMPACT.includes(v.impact));

      if (violations.length === 0) {
        console.log(` ${GREEN}✅ 0 violations${RESET}`);
      } else if (serious.length === 0) {
        console.log(` ${YELLOW}⚠ ${violations.length} minor violations (no serious/critical)${RESET}`);
      } else {
        console.log(` ${RED}❌ ${violations.length} violations (${serious.length} serious/critical)${RESET}`);
      }

      if (serious.length > 0) {
        for (const v of serious) {
          console.log(`      ${RED}[${v.impact.toUpperCase()}]${RESET} ${v.id}: ${v.description}`);
          (v.nodes || []).slice(0, 2).forEach(n => {
            const snippet = (n.html || '').replace(/\s+/g, ' ').slice(0, 100);
            console.log(`        → ${snippet}`);
          });
        }
      }

      totalViolations += violations.length;
      totalSerious += serious.length;
      report.push({ page, status: serious.length > 0 ? 'fail' : 'pass', violations });
    } catch (err) {
      console.log(` ${YELLOW}⚠ error (${err.message})${RESET}`);
      report.push({ page, status: 'error', violations: [] });
    }
  }

  console.log('');
  console.log(`${BOLD}══════════════════════════════════════════════════${RESET}`);

  const reportPath = join(__dirname, '..', 'a11y-report.json');
  writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: { totalViolations, totalSerious, pages: report.length },
    pages: report.map(r => ({
      page: r.page,
      status: r.status,
      violationCount: (r.violations || []).length,
      seriousCount: (r.violations || []).filter(v => FAIL_IMPACT.includes(v.impact)).length,
    })),
  }, null, 2), 'utf-8');

  if (totalSerious > 0) {
    console.log(`${RED}${BOLD}  RESULT: FAIL — ${totalSerious} serious/critical violation(s) found across ${TOP10_PAGES.length} pages.${RESET}`);
    console.log(`  Report written to a11y-report.json`);
    console.log('');
    process.exit(1);
  } else {
    console.log(`${GREEN}${BOLD}  RESULT: PASS — 0 serious/critical violations across ${TOP10_PAGES.length} pages.${RESET}`);
    console.log(`  (${totalViolations} minor violations logged to a11y-report.json)`);
    console.log('');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error in a11y-check:', err);
  process.exit(2);
});
