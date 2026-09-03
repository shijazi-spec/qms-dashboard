/**
 * Local utility (runs on the Windows box, not Replit). For each xlsx passed:
 *   1) print its headers,
 *   2) remove the "Keywords" and "Technologies" columns,
 *   3) save a "<name>__CLEAN.xlsx" copy next to the original,
 *   4) for the PASS file, extract the company-name column into
 *      scripts/passNames.txt for the directory name-audit.
 *
 *   npx tsx scripts/cleanPreflightFiles.ts "<file1.xlsx>" "<file2.xlsx>"
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "fs";
import { join, dirname, basename } from "path";

const DROP = new Set(["keywords", "technologies"]);
const NAME_HEADER_PRIORITY = [
  "company", "company name", "company_name", "account name", "account_name", "account",
];

async function processFile(path: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  console.log(`\n===== ${basename(path)} =====`);
  const passNames: string[] = [];
  const isPass = /pass/i.test(basename(path));

  wb.eachSheet((ws) => {
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = (cell.value == null ? "" : String(cell.value)).trim();
    });
    console.log(`  sheet "${ws.name}" headers: ${headers.filter(Boolean).join(" | ")}`);

    // Remove drop-columns RIGHT-TO-LEFT so indices stay valid.
    const dropCols: number[] = [];
    headers.forEach((h, col) => {
      if (h && DROP.has(h.toLowerCase())) dropCols.push(col);
    });
    dropCols.sort((a, b) => b - a);
    for (const col of dropCols) {
      console.log(`  → removing column ${col} ("${headers[col]}")`);
      ws.spliceColumns(col, 1);
    }

    // Extract company names from the PASS file (after removal; find by header).
    if (isPass && passNames.length === 0) {
      const newHeaders: string[] = [];
      ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        newHeaders[col] = (cell.value == null ? "" : String(cell.value)).trim().toLowerCase();
      });
      let nameCol = -1;
      for (const want of NAME_HEADER_PRIORITY) {
        const idx = newHeaders.findIndex((h) => h === want);
        if (idx > 0) { nameCol = idx; break; }
      }
      if (nameCol < 0) nameCol = newHeaders.findIndex((h) => h && h.includes("company"));
      if (nameCol > 0) {
        console.log(`  → extracting names from column ${nameCol} ("${newHeaders[nameCol]}")`);
        for (let r = 2; r <= ws.rowCount; r++) {
          const v = ws.getRow(r).getCell(nameCol).value;
          const name = v == null ? "" : String(v).trim();
          if (name) passNames.push(name);
        }
      } else {
        console.log(`  → (no company-name column found to extract)`);
      }
    }
  });

  const out = join(dirname(path), basename(path).replace(/\.xlsx$/i, "__CLEAN.xlsx"));
  await wb.xlsx.writeFile(out);
  console.log(`  saved: ${out}`);
  return passNames;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Pass file paths: npx tsx scripts/cleanPreflightFiles.ts "<a.xlsx>" "<b.xlsx>"');
    process.exit(2);
  }
  let allNames: string[] = [];
  for (const f of files) {
    const names = await processFile(f);
    if (names.length) allNames = names;
  }
  if (allNames.length) {
    const dest = join(process.cwd(), "scripts", "passNames.txt");
    writeFileSync(dest, "# PASS company names (auto-extracted)\n" + allNames.join("\n") + "\n", "utf8");
    console.log(`\nWrote ${allNames.length} company name(s) to scripts/passNames.txt`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("clean failed:", e); process.exit(2); });
