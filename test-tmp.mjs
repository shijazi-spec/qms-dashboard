import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync('dashboard/health.html', 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost/dashboard/health',
  pretendToBeVisual: true,
});
const { window } = dom;

window.WalaPlusI18n = {
  t(k, vars) {
    let v = k;
    if (vars) for (const x of Object.keys(vars)) v = v.replace('{' + x + '}', vars[x]);
    return v;
  },
};

window.fetch = async () => ({ ok: false, status: 200, text: async () => '' });
window.Chart = function () { return { destroy() {} }; };
window.alert = () => {};

const scripts = [...window.document.querySelectorAll('script')]
  .filter(s => !s.src && s.textContent.includes('renderLatest'));
if (scripts.length !== 1) throw new Error('Expected one inline app script, got ' + scripts.length);
window.eval(scripts[0].textContent);

// Simulate logged-in render
const sample = {
  overall_status: 'degraded',
  run_at: new Date().toISOString(),
  duration_ms: 1234,
  pass_count: 8,
  warn_count: 1,
  fail_count: 1,
  skipped_count: 0,
  checks: [
    { id: 'infra.429-pruner', label: '429 Pruner', category: 'infrastructure', status: 'pass', duration_ms: 23 },
    { id: 'infra.queue-depth', label: 'Queue Depth', category: 'infrastructure', status: 'fail', duration_ms: 12, message: 'queue full' },
    { id: 'ep.health', label: 'Health endpoint', category: 'endpoints', status: 'pass', duration_ms: 4 },
    { id: 'ai.budget', label: 'AI budget', category: 'ai', status: 'warn', duration_ms: 7, message: 'near limit' },
    { id: 'aud.daily', label: 'Daily audit', category: 'audits', status: 'pass', duration_ms: 100 },
    { id: 'data.uniques', label: 'Unique IDs', category: 'data', status: 'pass', duration_ms: 50 },
    { id: 'sched.tick', label: 'Scheduler tick', category: 'scheduler', status: 'pass', duration_ms: 9 },
  ],
};

window.document.getElementById('main-content').classList.remove('hidden');
window.renderLatest(sample);

const filterContainer = window.document.getElementById('checks-filter');
console.log('filter container hidden?', filterContainer.classList.contains('hidden'));
const chips = filterContainer.querySelectorAll('.filter-chip');
console.log('chip count:', chips.length, '(expect 7: All + 6 cats)');
const chipLabels = [...chips].map(c => ({
  cat: c.getAttribute('data-cat'),
  testid: c.getAttribute('data-testid'),
  pressed: c.getAttribute('aria-pressed'),
  text: c.textContent.trim().replace(/\s+/g, ' '),
}));
console.log('chips:', JSON.stringify(chipLabels, null, 2));

// Banner should show 1 fail + 1 warn regardless of filter
const banner = window.document.getElementById('alert-banner');
console.log('banner hidden?', banner.classList.contains('hidden'));
const bannerItems = window.document.querySelectorAll('#alert-banner-list li');
console.log('banner item count:', bannerItems.length, '(expect 2)');

// Click "ai" chip
const aiChip = window.document.querySelector('[data-testid="chip-filter-ai"]');
aiChip.click();
console.log('after click, selected pressed:', window.document.querySelector('[data-testid="chip-filter-ai"]').getAttribute('aria-pressed'));
console.log('all chip pressed:', window.document.querySelector('[data-testid="chip-filter-all"]').getAttribute('aria-pressed'));

const visibleGroups = [...window.document.querySelectorAll('#checks-list [data-testid^="group-category-"]')]
  .map(g => g.getAttribute('data-testid'));
console.log('visible groups after AI filter:', visibleGroups, '(expect only group-category-ai)');

// Banner should remain unchanged
const bannerItemsAfter = window.document.querySelectorAll('#alert-banner-list li');
console.log('banner item count after filter:', bannerItemsAfter.length, '(expect 2 — still all failing/warning)');

// Persistence: sessionStorage and URL
console.log('sessionStorage:', window.sessionStorage.getItem('health.filterCategory'));
console.log('url:', window.location.href);

// Click All to restore
window.document.querySelector('[data-testid="chip-filter-all"]').click();
const visibleGroupsAll = [...window.document.querySelectorAll('#checks-list [data-testid^="group-category-"]')]
  .map(g => g.getAttribute('data-testid'));
console.log('visible groups after All:', visibleGroupsAll.length, '(expect 6)');
console.log('sessionStorage after All:', window.sessionStorage.getItem('health.filterCategory'));
console.log('url after All:', window.location.href);

// Test missing-category fallback: simulate persisted filter for cat that disappears
window.sessionStorage.setItem('health.filterCategory', 'kpis');
// reload state by manually setting selectedCategory and re-render
window.eval('selectedCategory = "kpis"');
window.renderLatest(sample);
const allChip = window.document.querySelector('[data-testid="chip-filter-all"]');
console.log('fallback: All chip pressed when persisted cat absent?', allChip.getAttribute('aria-pressed'));

console.log('OK');
