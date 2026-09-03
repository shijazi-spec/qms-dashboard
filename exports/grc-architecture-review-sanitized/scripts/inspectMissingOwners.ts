import { getLeads, getDeals } from '../src/data';

const TARGETS = [
  'Sultan Banajah',
  'Sample User',
  'Khalil Aldadah',
  'Meznah Alharthi',
  'zahrah alnasser',
  'Sample User',
  'Sample User',
  'Abdulmajed Alshabili',
  'Abdulmajeed Alshabili',
  'waseem albalawi',
  'Sample User',
  'Awis Kilani',
  'Ayman Talbi',
  'Nawras',
  'Aljawharah Almusharraf',
  'HAMAD ALESSA',
  'Sample User',
  'Sample User',
  'Sample User',
  'Rayan',
  'Rayan Saleh',
];

const norm = (s: string) => (s || '').toString().trim().replace(/\s+/g, ' ').toLowerCase();

(async () => {
  const [leads, deals] = await Promise.all([getLeads(), getDeals()]);
  const targets = new Set(TARGETS.map(norm));

  type Stat = {
    leadCount: number;
    dealCount: number;
    leadCreatedDates: string[];
    dealCreatedDates: string[];
    dealModifiedDates: string[];
    leadModifiedDates: string[];
    leadSources: Record<string, number>;
    leadStatuses: Record<string, number>;
    dealStages: Record<string, number>;
    dealAmounts: number[];
    rawNames: Set<string>;
  };
  const byOwner: Record<string, Stat> = {};
  const ensure = (k: string): Stat => byOwner[k] ||= {
    leadCount: 0, dealCount: 0,
    leadCreatedDates: [], dealCreatedDates: [],
    leadModifiedDates: [], dealModifiedDates: [],
    leadSources: {}, leadStatuses: {}, dealStages: {}, dealAmounts: [],
    rawNames: new Set(),
  };

  for (const lead of leads) {
    const owner = (lead as any).Owner || '';
    const k = norm(owner);
    if (!targets.has(k)) continue;
    const s = ensure(k);
    s.leadCount++;
    s.rawNames.add(owner);
    if ((lead as any).Created_Time) s.leadCreatedDates.push((lead as any).Created_Time);
    if ((lead as any).Modified_Time) s.leadModifiedDates.push((lead as any).Modified_Time);
    const src = (lead as any).Lead_Source; if (src) s.leadSources[src] = (s.leadSources[src] || 0) + 1;
    const st = (lead as any).Lead_Status; if (st) s.leadStatuses[st] = (s.leadStatuses[st] || 0) + 1;
  }
  for (const deal of deals) {
    const owner = (deal as any).Owner || '';
    const k = norm(owner);
    if (!targets.has(k)) continue;
    const s = ensure(k);
    s.dealCount++;
    s.rawNames.add(owner);
    if ((deal as any).Created_Time) s.dealCreatedDates.push((deal as any).Created_Time);
    if ((deal as any).Modified_Time) s.dealModifiedDates.push((deal as any).Modified_Time);
    const stg = (deal as any).Stage; if (stg) s.dealStages[stg] = (s.dealStages[stg] || 0) + 1;
    const amt = parseFloat((deal as any).Amount); if (!isNaN(amt)) s.dealAmounts.push(amt);
  }

  // Merge Abdulmajeed/Abdulmajed and Rayan/Rayan Saleh
  const mergePairs: [string, string][] = [
    ['abdulmajeed alshabili', 'abdulmajed alshabili'],
    ['rayan',                 'rayan saleh'],
  ];
  for (const [from, to] of mergePairs) {
    if (byOwner[from] && byOwner[to]) {
      const a = byOwner[from], b = byOwner[to];
      b.leadCount += a.leadCount; b.dealCount += a.dealCount;
      b.leadCreatedDates.push(...a.leadCreatedDates);
      b.dealCreatedDates.push(...a.dealCreatedDates);
      b.leadModifiedDates.push(...a.leadModifiedDates);
      b.dealModifiedDates.push(...a.dealModifiedDates);
      a.rawNames.forEach(n => b.rawNames.add(n));
      delete byOwner[from];
    } else if (byOwner[from] && !byOwner[to]) {
      byOwner[to] = byOwner[from]; delete byOwner[from];
    }
  }

  const NOW = new Date('2026-04-19').getTime();
  const DAY = 86400000;

  const rows: any[] = [];
  for (const k of Object.keys(byOwner).sort((a, b) => (byOwner[b].leadCount + byOwner[b].dealCount) - (byOwner[a].leadCount + byOwner[a].dealCount))) {
    const s = byOwner[k];
    const total = s.leadCount + s.dealCount;
    const allDates = [...s.leadCreatedDates, ...s.dealCreatedDates, ...s.leadModifiedDates, ...s.dealModifiedDates]
      .map(d => new Date(d).getTime()).filter(t => !isNaN(t));
    const minD = allDates.length ? new Date(Math.min(...allDates)) : null;
    const maxD = allDates.length ? new Date(Math.max(...allDates)) : null;
    const daysSinceLast = maxD ? Math.floor((NOW - maxD.getTime()) / DAY) : null;

    // Inferred status
    let status = 'Inactive';
    if (daysSinceLast !== null && daysSinceLast <= 90) status = 'Active';

    // Inferred role from module mix
    let role = 'CRM User';
    if (s.leadCount > 0 && s.dealCount === 0) role = 'SDR / Lead Generation';
    else if (s.dealCount > 0 && s.leadCount === 0) role = 'Sales / Account Manager';
    else if (s.dealCount >= s.leadCount) role = 'Sales';
    else role = 'SDR';

    const topLeadSrc = Object.entries(s.leadSources).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}(${v})`).join(', ');
    const topStage = Object.entries(s.dealStages).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}(${v})`).join(', ');
    const totalAmt = s.dealAmounts.reduce((a, b) => a + b, 0);

    rows.push({
      name: [...s.rawNames][0],
      total, leadCount: s.leadCount, dealCount: s.dealCount,
      firstActivity: minD ? minD.toISOString().slice(0, 10) : '-',
      lastActivity: maxD ? maxD.toISOString().slice(0, 10) : '-',
      daysSinceLast,
      inferredStatus: status,
      inferredRole: role,
      topLeadSources: topLeadSrc || '-',
      topDealStages: topStage || '-',
      totalDealAmount: totalAmt ? totalAmt.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '-',
    });
  }

  console.log('\n=== Missing-roster owners — activity profile ===\n');
  console.table(rows);

  // Save as JSON for downstream xlsx
  require('fs').writeFileSync('exports/missing_owners_profile.json', JSON.stringify(rows, null, 2));
  console.log('\nWrote exports/missing_owners_profile.json');
})().catch(e => { console.error(e); process.exit(1); });
