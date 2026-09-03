import { getLeads, getDeals } from '../src/data';

async function main() {
  console.log('Fetching ALL Leads from CRMProvider (this may take a minute)...');
  const t1 = Date.now();
  const leads = await getLeads();
  console.log(`  Leads fetched: ${leads.length} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  console.log('Fetching ALL Deals from CRMProvider...');
  const t2 = Date.now();
  const deals = await getDeals();
  console.log(`  Deals fetched: ${deals.length} in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  for (const [label, rows] of [['Leads', leads], ['Deals', deals]] as const) {
    const empty = rows.filter(r => !((r as any).Layouts || '').toString().trim());
    const filled = rows.filter(r => ((r as any).Layouts || '').toString().trim());
    const breakdown: Record<string, number> = {};
    filled.forEach(r => {
      const k = (r as any).Layouts.toString().trim();
      breakdown[k] = (breakdown[k] || 0) + 1;
    });
    console.log(`\n=== ${label} (full CRM scan) ===`);
    console.log(`  Total records:      ${rows.length}`);
    console.log(`  With layout name:   ${filled.length}`);
    console.log(`  EMPTY layout:       ${empty.length}`);
    console.log(`  Layout breakdown:`);
    Object.entries(breakdown)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`    · ${k.padEnd(30)} ${v}`));
    if (empty.length > 0) {
      console.log(`  Sample empty-layout records (first 5):`);
      empty.slice(0, 5).forEach(e => {
        console.log(`    · id=${(e as any).id} owner="${(e as any).Owner}" created=${(e as any).Created_Time}`);
      });
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
