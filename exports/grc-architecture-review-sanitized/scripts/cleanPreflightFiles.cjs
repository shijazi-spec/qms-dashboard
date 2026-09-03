/* Local utility (Node, no tsx needed). Removes the "Keywords" & "Technologies"
 * columns from each xlsx, saves a "<name>__CLEAN.xlsx" copy, and extracts the
 * PASS file's company-name column into scripts/passNames.txt.
 *
 *   node scripts/cleanPreflightFiles.cjs "<a.xlsx>" "<b.xlsx>"
 */
const ExcelJS = require("exceljs");
const { writeFileSync } = require("fs");
const { join, dirname, basename } = require("path");

const DROP = new Set(["keywords", "technologies"]);
const NAME_HEADER_PRIORITY = [
  "company", "company name", "company_name", "account name", "account_name", "account",
];

async function processFile(path) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  console.log(`\n===== ${basename(path)} =====`);
  let passNames = [];
  const isPass = /pass/i.test(basename(path));

  wb.eachSheet((ws) => {
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = (cell.value == null ? "" : String(cell.value)).trim();
    });
    console.log(`  sheet "${ws.name}" headers: ${headers.filter(Boolean).join(" | ")}`);

    const dropCols = [];
    headers.forEach((h, col) => {
      if (h && DROP.has(h.toLowerCase())) dropCols.push(col);
    });
    dropCols.sort((a, b) => b - a);
    for (const col of dropCols) {
      console.log(`  -> removing column ${col} ("${headers[col]}")`);
      ws.spliceColumns(col, 1);
    }

    if (isPass && passNames.length === 0) {
      const nh = [];
      ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        nh[col] = (cell.value == null ? "" : String(cell.value)).trim().toLowerCase();
      });
      let nameCol = -1;
      for (const want of NAME_HEADER_PRIORITY) {
        const idx = nh.findIndex((h) => h === want);
        if (idx > 0) { nameCol = idx; break; }
      }
      if (nameCol < 0) nameCol = nh.findIndex((h) => h && h.includes("company"));
      if (nameCol > 0) {
        console.log(`  -> extracting names from column ${nameCol} ("${nh[nameCol]}")`);
        for (let r = 2; r <= ws.rowCount; r++) {
          const v = ws.getRow(r).getCell(nameCol).value;
          const name = v == null ? "" : String(v).trim();
          if (name) passNames.push(name);
        }
      } else {
        console.log(`  -> (no company-name column found to extract)`);
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
    console.error('Pass file paths.');
    process.exit(2);
  }
  let allNames = [];
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
