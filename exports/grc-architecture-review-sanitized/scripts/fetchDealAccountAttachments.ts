/**
 * One-time script: fetch attachment metadata for all (or a subset of) Deals
 * and Accounts from Zoho CRM, and write a CSV + JSON report to ./reports.
 *
 * Usage:
 *   npx tsx scripts/fetchDealAccountAttachments.ts
 *   npx tsx scripts/fetchDealAccountAttachments.ts --module=Deals
 *   npx tsx scripts/fetchDealAccountAttachments.ts --module=Accounts --limit=500
 *   npx tsx scripts/fetchDealAccountAttachments.ts --concurrency=6
 *
 * Output files (timestamped):
 *   reports/attachments-<timestamp>.json   full structured data
 *   reports/attachments-<timestamp>.csv    one row per attachment
 *   reports/attachments-summary-<timestamp>.csv  per-record summary
 */

import * as fs from 'fs';
import * as path from 'path';
import { fetchAllZohoRecords, getValidAccessToken } from '../src/utils/zohoCRM';

type ModuleName = 'Deals' | 'Accounts';

interface AttachmentMeta {
  recordModule: ModuleName;
  recordId: string;
  recordName: string;
  attachmentId: string;
  fileName: string;
  fileSizeBytes: number | null;
  fileSizeReadable: string;
  attachmentType: string | null;
  linkUrl: string | null;
  createdByName: string | null;
  createdByEmail: string | null;
  createdTime: string | null;
  modifiedByName: string | null;
  modifiedTime: string | null;
}

const args = process.argv.slice(2).reduce<Record<string, string>>((acc, a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {});

const moduleArg = (args.module || 'both').toLowerCase();
const limit = args.limit ? parseInt(args.limit, 10) : Infinity;
const concurrency = args.concurrency ? parseInt(args.concurrency, 10) : 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function humanBytes(b: number | null): string {
  if (b == null || isNaN(b)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function getValidTokenAndDomain(): Promise<{ token: string; apiDomain: string }> {
  const apiDomain = process.env.ZOHO_API_DOMAIN || '<REDACTED_URL>';
  const token = await getValidAccessToken();
  return { token, apiDomain };
}

async function refreshTokenIfStale(currentToken: string): Promise<string> {
  // After a long run the token may have expired. Re-fetch — getValidAccessToken
  // returns the cached one if still valid, otherwise refreshes.
  const fresh = await getValidAccessToken();
  return fresh || currentToken;
}

async function fetchAttachmentsFor(
  module: ModuleName,
  recordId: string,
  recordName: string,
  token: string,
  apiDomain: string
): Promise<AttachmentMeta[]> {
  const url = `${apiDomain}/crm/v2/${module}/${recordId}/Attachments?per_page=200`;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Zoho-oauthtoken ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (res.status === 204) return [];
      if (res.status === 429) {
        if (attempt > 4) throw new Error(`429 rate limit (gave up) on ${module}/${recordId}`);
        await sleep(attempt * 4000);
        continue;
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} on ${module}/${recordId}/Attachments: ${txt.slice(0, 200)}`);
      }
      const text = await res.text();
      if (!text || !text.trim()) return [];
      const data = JSON.parse(text);
      const rows: any[] = data?.data || [];
      return rows.map((a) => ({
        recordModule: module,
        recordId,
        recordName,
        attachmentId: a.id,
        fileName: a.File_Name || '',
        fileSizeBytes: a.Size != null ? Number(a.Size) : null,
        fileSizeReadable: humanBytes(a.Size != null ? Number(a.Size) : null),
        attachmentType: a.$type || a.$attachment_type || null,
        linkUrl: a.$link_url || null,
        createdByName: a.Created_By?.name || null,
        createdByEmail: a.Created_By?.email || null,
        createdTime: a.Created_Time || null,
        modifiedByName: a.Modified_By?.name || null,
        modifiedTime: a.Modified_Time || null,
      }));
    } catch (err: any) {
      if (attempt > 3) {
        console.warn(`  ⚠️  ${module}/${recordId} failed after ${attempt} attempts: ${err?.message}`);
        return [];
      }
      await sleep(attempt * 1500);
    }
  }
}

async function processModule(
  module: ModuleName,
  token: string,
  apiDomain: string
): Promise<{
  attachments: AttachmentMeta[];
  perRecord: { module: ModuleName; recordId: string; recordName: string; attachmentCount: number; totalSizeBytes: number }[];
  totalRecords: number;
}> {
  const nameField = module === 'Deals' ? 'Deal_Name' : 'Account_Name';
  console.log(`\n📥 Fetching all ${module} record ids…`);
  const t0 = Date.now();
  const records = await fetchAllZohoRecords(module, {
    fields: ['id', nameField],
    maxRecords: limit === Infinity ? undefined : limit,
  });
  console.log(`  ${module}: ${records.length} records in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const attachments: AttachmentMeta[] = [];
  const perRecord: { module: ModuleName; recordId: string; recordName: string; attachmentCount: number; totalSizeBytes: number }[] = [];

  let cursor = 0;
  let processed = 0;
  const total = records.length;
  const startedAt = Date.now();

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= records.length) return;
      const rec = records[idx];
      const rid = rec.id;
      const rname = (rec.data?.[nameField] as string) || '';
      const atts = await fetchAttachmentsFor(module, rid, rname, token, apiDomain);
      if (atts.length > 0) {
        attachments.push(...atts);
        const totalSize = atts.reduce((s, a) => s + (a.fileSizeBytes || 0), 0);
        perRecord.push({ module, recordId: rid, recordName: rname, attachmentCount: atts.length, totalSizeBytes: totalSize });
      }
      processed++;
      if (processed % 100 === 0 || processed === total) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = processed / Math.max(elapsed, 0.001);
        const eta = ((total - processed) / Math.max(rate, 0.001)).toFixed(0);
        console.log(`  …${module}: ${processed}/${total} records scanned, ${attachments.length} attachments found (eta ${eta}s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { attachments, perRecord, totalRecords: records.length };
}

async function main() {
  const includeDeals = moduleArg === 'both' || moduleArg === 'deals';
  const includeAccounts = moduleArg === 'both' || moduleArg === 'accounts';
  if (!includeDeals && !includeAccounts) {
    console.error(`Unknown --module=${args.module}. Use Deals, Accounts, or both.`);
    process.exit(1);
  }

  console.log(`🚀 Attachment fetch  module=${moduleArg}  limit=${limit}  concurrency=${concurrency}`);
  const { token, apiDomain } = await getValidTokenAndDomain();
  console.log(`🔑 Zoho token acquired  apiDomain=${apiDomain}`);

  const allAttachments: AttachmentMeta[] = [];
  const allPerRecord: { module: ModuleName; recordId: string; recordName: string; attachmentCount: number; totalSizeBytes: number }[] = [];
  const totals: Record<string, number> = {};

  if (includeDeals) {
    const r = await processModule('Deals', token, apiDomain);
    allAttachments.push(...r.attachments);
    allPerRecord.push(...r.perRecord);
    totals.dealsRecords = r.totalRecords;
  }
  if (includeAccounts) {
    const r = await processModule('Accounts', token, apiDomain);
    allAttachments.push(...r.attachments);
    allPerRecord.push(...r.perRecord);
    totals.accountsRecords = r.totalRecords;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), 'reports');
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, `attachments-${stamp}.json`);
  const csvPath = path.join(outDir, `attachments-${stamp}.csv`);
  const summaryCsvPath = path.join(outDir, `attachments-summary-${stamp}.csv`);

  const summary = {
    generatedAt: new Date().toISOString(),
    moduleFilter: moduleArg,
    recordLimit: limit === Infinity ? null : limit,
    concurrency,
    totals: {
      ...totals,
      attachmentsTotal: allAttachments.length,
      recordsWithAttachments: allPerRecord.length,
      totalSizeBytes: allAttachments.reduce((s, a) => s + (a.fileSizeBytes || 0), 0),
      totalSizeReadable: humanBytes(allAttachments.reduce((s, a) => s + (a.fileSizeBytes || 0), 0)),
      byModule: {
        Deals: {
          recordsWithAttachments: allPerRecord.filter((r) => r.module === 'Deals').length,
          attachments: allAttachments.filter((a) => a.recordModule === 'Deals').length,
        },
        Accounts: {
          recordsWithAttachments: allPerRecord.filter((r) => r.module === 'Accounts').length,
          attachments: allAttachments.filter((a) => a.recordModule === 'Accounts').length,
        },
      },
    },
  };

  fs.writeFileSync(jsonPath, JSON.stringify({ summary, attachments: allAttachments, perRecord: allPerRecord }, null, 2));

  const headers = [
    'recordModule',
    'recordId',
    'recordName',
    'attachmentId',
    'fileName',
    'fileSizeBytes',
    'fileSizeReadable',
    'attachmentType',
    'linkUrl',
    'createdByName',
    'createdByEmail',
    'createdTime',
    'modifiedByName',
    'modifiedTime',
  ];
  const csvLines = [headers.join(',')];
  for (const a of allAttachments) {
    csvLines.push(headers.map((h) => csvEscape((a as any)[h])).join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  const sumHeaders = ['module', 'recordId', 'recordName', 'attachmentCount', 'totalSizeBytes', 'totalSizeReadable'];
  const sumLines = [sumHeaders.join(',')];
  for (const r of allPerRecord) {
    sumLines.push(
      [r.module, r.recordId, r.recordName, r.attachmentCount, r.totalSizeBytes, humanBytes(r.totalSizeBytes)]
        .map(csvEscape)
        .join(',')
    );
  }
  fs.writeFileSync(summaryCsvPath, sumLines.join('\n'));

  console.log(`\n✅ Done.`);
  console.log(`   Attachments found:        ${summary.totals.attachmentsTotal}`);
  console.log(`   Records w/ attachments:   ${summary.totals.recordsWithAttachments}`);
  console.log(`   Total payload:            ${summary.totals.totalSizeReadable}`);
  console.log(`\n📄 JSON      : ${jsonPath}`);
  console.log(`📄 CSV (rows): ${csvPath}`);
  console.log(`📄 CSV (sum) : ${summaryCsvPath}`);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
