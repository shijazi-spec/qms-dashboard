const ExcelJS = require('exceljs');

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Missing CRM Owners');
  ws.columns = [
    { header: 'Name (CRM)',           key: 'name',     width: 26 },
    { header: 'Total Records',        key: 'total',    width: 14 },
    { header: 'Leads',                key: 'leads',    width: 8  },
    { header: 'Deals',                key: 'deals',    width: 8  },
    { header: 'First Activity',       key: 'first',    width: 14 },
    { header: 'Last Activity',        key: 'last',     width: 14 },
    { header: 'Days Since Last',      key: 'days',     width: 16 },
    { header: 'Inferred Status',      key: 'status',   width: 16 },
    { header: 'Inferred Role',        key: 'role',     width: 26 },
    { header: 'Top Lead Sources',     key: 'srcs',     width: 30 },
    { header: 'Top Deal Stages',      key: 'stages',   width: 36 },
    { header: 'Total Deal Amount',    key: 'amt',      width: 18 },
    { header: 'Confirmed Team',       key: 'team',     width: 18 },
    { header: 'Confirm/Override',     key: 'confirm',  width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } };

  const rows = [
    ['Sultan Banajah',         514, 7,   507, '2019-08-05', '2025-05-27',  326, 'Inactive', 'Sales',                   'Referral(3), Outbound(2)', 'Closed Lost(207), Signed(159)',        '-'],
    ['Sample User',        413, 0,   413, '2019-08-05', '2026-04-19',   -1, 'Active',   'Sales / Account Manager', '-',                        'Partner Active(236), Contacted(111)',  '268,300'],
    ['Rayan Saleh',            409, 1,   408, '2020-05-18', '2026-01-21',   87, 'Active',   'Sales',                   '-',                        'Client Activated(223), New Deal(104)', '266,565'],
    ['Khalil Aldadah',         282, 0,   282, '2020-05-18', '2025-11-06',  163, 'Inactive', 'Sales / Account Manager', '-',                        'Partner Active(235), New Deal(25)',    '309,202'],
    ['Meznah Alharthi',        230, 0,   230, '2019-08-04', '2022-03-29', 1481, 'Inactive', 'Sales / Account Manager', '-',                        'Closed Lost(121), Signed(109)',        '-'],
    ['zahrah alnasser',        149, 0,   149, '2019-08-04', '2022-03-29', 1481, 'Inactive', 'Sales / Account Manager', '-',                        'Signed(107), Closed Lost(42)',         '-'],
    ['Sample User',          106, 0,   106, '2020-05-18', '2026-04-19',   -1, 'Active',   'Sales / Account Manager', '-',                        'New Deal(58), Partner Active(48)',     '1,353,086'],
    ['Sample User',         46, 0,    46, '2019-08-22', '2022-06-08', 1410, 'Inactive', 'Sales / Account Manager', '-',                        'Partner Active(44), Signed(1)',        '25,200'],
    ['Abdulmajed Alshabili',    16, 1,    15, '2021-11-19', '2025-07-03',  289, 'Inactive', 'Sales',                   'Referral(1)',              'Closed Lost(1), Meeting(1)',           '-'],
    ['waseem albalawi',         11, 0,    11, '2019-08-05', '2022-01-03', 1566, 'Inactive', 'Sales / Account Manager', '-',                        'Closed Lost(7), Signed(4)',            '-'],
    ['Sample User',          10, 10,    0, '2023-08-06', '2025-12-03',  136, 'Inactive', 'SDR / Lead Generation',   'Outbound(6), Referral(3)', '-',                                    '-'],
    ['Awis Kilani',              9, 0,     9, '2019-08-20', '2022-03-29', 1481, 'Inactive', 'Sales / Account Manager', '-',                        'Closed Lost(8), Signed(1)',            '-'],
    ['Ayman Talbi',              8, 0,     8, '2021-03-14', '2026-01-21',   87, 'Active',   'Sales / Account Manager', '-',                        'Contacted(3), Meeting(3)',             '-'],
    ['Nawras',                   7, 0,     7, '2021-04-01', '2022-01-03', 1566, 'Inactive', 'Sales / Account Manager', '-',                        'Signed(4), Closed Lost(3)',            '-'],
    ['Aljawharah Almusharraf',   4, 0,     4, '2019-08-05', '2022-03-29', 1481, 'Inactive', 'Sales / Account Manager', '-',                        'Signed(4)',                            '-'],
    ['HAMAD ALESSA',             2, 0,     2, '2021-01-17', '2025-01-23',  450, 'Inactive', 'Sales / Account Manager', '-',                        'New Deal(2)',                          '-'],
    ['Sample User',       1, 1,     0, '2024-08-21', '2025-09-29',  201, 'Inactive', 'SDR / Lead Generation',   'Search Engine(1)',         '-',                                    '-'],
    ['Sample User',           1, 0,     1, '2020-03-27', '2025-01-23',  450, 'Inactive', 'Sales / Account Manager', '-',                        'Meeting(1)',                           '5,000'],
    ['Sample User',         1, 0,     1, '2022-02-09', '2022-03-01', 1509, 'Inactive', 'Sales / Account Manager', '-',                        'Partner Active(1)',                    '2,000'],
  ];

  for (const r of rows) {
    const row = ws.addRow({
      name: r[0], total: r[1], leads: r[2], deals: r[3],
      first: r[4], last: r[5], days: r[6],
      status: r[7], role: r[8],
      srcs: r[9], stages: r[10], amt: r[11],
      team: '', confirm: '',
    });
    row.getCell('status').fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: r[7] === 'Active' ? 'FFD1FAE5' : 'FFFEE2E2' },
    };
  }
  ws.autoFilter = { from: 'A1', to: 'N1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const ws2 = wb.addWorksheet('Instructions');
  ws2.columns = [{ header: '', key: 'a', width: 110 }];
  const lines = [
    'ExampleOrg - Missing CRM Owners with Activity Profile (2026-04-19)',
    '',
    'These 19 owners exist in your CRM (Leads + Deals) but are NOT in the 117-user roster.',
    'I inferred Status and Role from real CRM activity:',
    '',
    '  - Inferred Status:  Active   = last activity within 90 days of today (2026-04-19)',
    '                      Inactive = last activity older than 90 days',
    '  - Inferred Role:    SDR / Lead Generation   = Leads only',
    '                      Sales / Account Manager = Deals only',
    '                      Sales                   = mix of Leads and Deals',
    '',
    'NEXT STEP: please fill in column M (Confirmed Team). Optionally use column N',
    '(Confirm/Override) to override the inferred Status or Role if it does not match reality.',
    '',
    'Notes:',
    '  - Sultan Banajah: confirmed by you as a different person from Sultan Alrefaei.',
    '  - Sample User: already in seed roster but with team = Unassigned. Please set his real team.',
    '  - "Rayan" alias -> Rayan Saleh (already merged in totals above).',
    '  - "Abdulmajeed Alshabili" alias -> Abdulmajed Alshabili (already merged in totals above).',
    '  - Names with double-spaces (Khalil  Aldadah, Sample User) and odd casing',
    '    (HAMAD ALESSA, zahrah alnasser, waseem albalawi) are stored that way in CRM.',
  ];
  lines.forEach((t, i) => { const r = ws2.addRow({ a: t }); if (i === 0) r.font = { bold: true, size: 12 }; });

  await wb.xlsx.writeFile('exports/Missing_CRM_Owners_with_Activity_2026-04-19.xlsx');
  console.log('Wrote exports/Missing_CRM_Owners_with_Activity_2026-04-19.xlsx');
})();
