/**
 * Shared PDF generator for the Fraud Management module exports.
 *
 * One helper used by:
 *   - GET /api/fraud/rules/export/pdf       (Feature 1)
 *   - GET /api/fraud/incidents/export/pdf   (Feature 2)
 *   - GET /api/fraud/countries/export/pdf   (Feature 3)
 *   - GET /api/fraud/kpis/export/pdf        (Feature 5)
 *
 * Mirrors the PDFKit pattern in src/mastra/routes/auditRoutes.ts.
 *
 * Why a shared helper: the four exports differ only in title, headers,
 * row data, and column widths. A single generator keeps formatting
 * consistent (header, generated-at footer, page numbers) and means a
 * styling tweak only needs to change one file.
 */

import type { UserRole as _UserRole } from "./rbacDatabase"; // type-only import keeps deps minimal
void _UserRole;

export interface FraudPdfColumn {
  /** Header label (printed in the table head). */
  label: string;
  /** Width in PDF points; columns should sum to <= page-content width (~495 for A4 with 50pt margins). */
  width: number;
  /** Optional formatter — if omitted, renderer prints `String(row[key] ?? "—")`. */
  format?: (value: unknown, row: Record<string, unknown>) => string;
  /** Property key to read from each row. */
  key: string;
  /** Right-align the cell text (numbers / amounts). Default false. */
  align?: "left" | "right";
}

export interface FraudPdfReport {
  title: string;
  subtitle?: string;
  rows: Record<string, unknown>[];
  columns: FraudPdfColumn[];
  meta?: { label: string; value: string }[];
  footer?: string;
}

/**
 * Generates an A4 portrait PDF with a centered title, a "generated at"
 * subtitle, an optional metadata block, and a paged table. Returns the
 * full PDF as a Buffer suitable for `bufferResponseWithRange`.
 */
export async function generateFraudPdfReport(
  report: FraudPdfReport,
): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;

  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  // Title
  doc.fontSize(20).fillColor("#B91C1C").text(report.title, { align: "center" });
  doc.moveDown(0.3);
  if (report.subtitle) {
    doc
      .fontSize(11)
      .fillColor("#4B5563")
      .text(report.subtitle, { align: "center" });
  }
  doc
    .fontSize(9)
    .fillColor("#6B7280")
    .text(`Generated ${new Date().toISOString()}`, { align: "center" });
  doc.moveDown(0.8);

  // Optional metadata block
  if (report.meta && report.meta.length > 0) {
    doc.fontSize(10).fillColor("#1F2937");
    for (const m of report.meta) {
      doc.font("Helvetica-Bold").text(`${m.label}: `, { continued: true });
      doc.font("Helvetica").text(m.value);
    }
    doc.moveDown(0.5);
  }

  // Table
  const startX = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Re-scale columns if total width exceeds the usable area
  const totalSpec = report.columns.reduce((s, c) => s + c.width, 0);
  const scale = totalSpec > usableWidth ? usableWidth / totalSpec : 1;
  const widths = report.columns.map((c) => c.width * scale);

  function renderRow(
    cells: string[],
    options: { bold?: boolean; bg?: string } = {},
  ): void {
    const lineHeight = 14;
    let cellHeights = 0;
    // Compute row height based on the tallest cell.
    for (let i = 0; i < cells.length; i++) {
      const h = doc.heightOfString(cells[i] ?? "", {
        width: widths[i] - 4,
        lineGap: 0,
      });
      if (h > cellHeights) cellHeights = h;
    }
    const rowHeight = Math.max(lineHeight, cellHeights + 4);

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
    }

    if (options.bg) {
      doc.save();
      doc.rect(startX, doc.y, usableWidth, rowHeight).fill(options.bg).restore();
    }
    doc
      .font(options.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(8)
      .fillColor(options.bold ? "#111827" : "#1F2937");

    let x = startX;
    const baselineY = doc.y + 2;
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i] ?? "", x + 2, baselineY, {
        width: widths[i] - 4,
        align: report.columns[i]?.align === "right" ? "right" : "left",
      });
      x += widths[i];
    }
    doc.y = baselineY + rowHeight - 2;
  }

  // Header
  renderRow(
    report.columns.map((c) => c.label),
    { bold: true, bg: "#FEE2E2" },
  );

  // Body
  if (report.rows.length === 0) {
    doc
      .moveDown(1)
      .fontSize(10)
      .fillColor("#6B7280")
      .text("(no rows)", { align: "center" });
  } else {
    for (const row of report.rows) {
      const cells = report.columns.map((c) => {
        const raw = row[c.key];
        if (c.format) return c.format(raw, row);
        if (raw == null) return "—";
        return String(raw);
      });
      renderRow(cells);
    }
  }

  // Footer
  if (report.footer) {
    doc.moveDown(1).fontSize(8).fillColor("#9CA3AF").text(report.footer, {
      align: "center",
    });
  }

  // Page numbers
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc
      .fontSize(8)
      .fillColor("#9CA3AF")
      .text(
        `Page ${i + 1} of ${pageCount}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 10,
        { align: "center", width: usableWidth },
      );
  }

  doc.end();
  return await new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
