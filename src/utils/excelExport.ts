/**
 * Shared Excel/XLSX export utility built on the existing exceljs dependency.
 *
 * Goals:
 *  - One place for header styling + auto-width logic so every export looks alike
 *  - Streamed Buffer output suitable for direct return from Hono routes
 *  - Multi-sheet support with a tiny declarative API (`SheetSpec[]`)
 *
 * Used by the audit, duplicates and KPI XLSX export endpoints.
 */
import ExcelJS from "exceljs";

export interface ColumnSpec {
  header: string;
  key: string;
  width?: number;
}

export interface SheetSpec {
  name: string;
  columns: ColumnSpec[];
  rows: Record<string, any>[];
  freezeHeader?: boolean;
}

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } },
  alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  border: {
    top: { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
    left: { style: "thin", color: { argb: "FFE5E7EB" } },
    right: { style: "thin", color: { argb: "FFE5E7EB" } },
  },
};

function autoSize(ws: ExcelJS.Worksheet, columns: ColumnSpec[]) {
  columns.forEach((col, idx) => {
    if (col.width) {
      ws.getColumn(idx + 1).width = col.width;
      return;
    }
    let max = String(col.header).length;
    ws.getColumn(idx + 1).eachCell({ includeEmpty: false }, (cell, row) => {
      if (row === 1) return;
      const v = cell.value == null ? "" : String(cell.value);
      if (v.length > max) max = v.length;
    });
    ws.getColumn(idx + 1).width = Math.min(Math.max(max + 2, 10), 60);
  });
}

export async function buildWorkbook(
  sheets: SheetSpec[],
  meta?: { creator?: string; title?: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta?.creator || "WalaPlus GRC Platform";
  wb.created = new Date();
  if (meta?.title) wb.title = meta.title;

  // Excel sheet names: ≤31 chars, no \ / ? * [ ] :, must be unique within workbook
  const usedNames = new Set<string>();
  const uniquify = (raw: string): string => {
    const base = (raw || "Sheet").replace(/[\\/?*\[\]:]/g, "_").substring(0, 31) || "Sheet";
    if (!usedNames.has(base)) { usedNames.add(base); return base; }
    for (let i = 2; i < 1000; i++) {
      const suffix = `_${i}`;
      const candidate = base.substring(0, 31 - suffix.length) + suffix;
      if (!usedNames.has(candidate)) { usedNames.add(candidate); return candidate; }
    }
    const fallback = `Sheet_${usedNames.size + 1}`;
    usedNames.add(fallback);
    return fallback;
  };

  for (const sheet of sheets) {
    const safeName = uniquify(sheet.name);
    const ws = wb.addWorksheet(safeName, { views: sheet.freezeHeader === false ? [] : [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map(c => ({ header: c.header, key: c.key, width: c.width }));

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => Object.assign(cell, HEADER_STYLE));
    headerRow.height = 22;

    if (sheet.rows.length) {
      ws.addRows(sheet.rows);
    }
    autoSize(ws, sheet.columns);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export function xlsxResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
}
