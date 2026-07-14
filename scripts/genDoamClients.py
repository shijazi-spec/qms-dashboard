#!/usr/bin/env python3
"""Regenerate src/utils/doamClients.ts from the DOAM clients Excel.

DOAM = government entities subscribed to WalaPlus via the HR ministry (دوم);
contracts auto-renew yearly. Preflight rejects them (see duplicateRadarPreflight.ts
matchDoamClient). Re-run this whenever Sarah sends an updated list.

Usage:  python scripts/genDoamClients.py "C:/path/to/الجهات المفعلة في دوم.xlsx"
Expected sheet columns: B=Gov Name (EN), C=Arabic name, D=Domain, E=Status
                        (مفعل = active, غير مفعل = inactive).
"""
import sys, os, json, openpyxl

def main():
    if len(sys.argv) < 2:
        print("usage: python scripts/genDoamClients.py <xlsx-path>")
        sys.exit(1)
    path = sys.argv[1]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_ts = os.path.join(here, "src", "utils", "doamClients.ts")

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    entries, seen = [], set()
    for r in ws.iter_rows(values_only=True):
        cells = [(str(c).strip() if c is not None else "") for c in r]
        en = cells[1] if len(cells) > 1 else ""
        ar = cells[2] if len(cells) > 2 else ""
        dom = (cells[3] if len(cells) > 3 else "").lower().lstrip("@").strip()
        st = cells[4] if len(cells) > 4 else ""
        if not (en or ar or dom):
            continue
        if en == "Gov Name (EN)" or ar.startswith("اسم"):
            continue  # header
        key = (en.lower(), ar, dom)
        if key in seen:
            continue
        seen.add(key)
        entries.append({"en": en, "ar": ar, "domain": dom, "active": st == "مفعل"})

    active = sum(1 for e in entries if e["active"])
    ts = (
        '// AUTO-GENERATED from the DOAM clients xlsx (scripts/genDoamClients.py).\n'
        '// DOAM = HR-gov subscription clients (auto-renewing yearly) that may NOT be in\n'
        '// the CRM but must be rejected by Preflight (matchDoamClient). Do not hand-edit;\n'
        '// re-run the generator on an updated xlsx.\n'
        'export interface DoamClient { en: string; ar: string; domain: string; active: boolean; }\n'
        'export const DOAM_CLIENTS: DoamClient[] = '
        + json.dumps(entries, ensure_ascii=False, indent=0).replace("\n", "")
        + ';\n'
    )
    open(out_ts, "w", encoding="utf-8").write(ts)
    print(f"wrote {out_ts}: {len(entries)} entries ({active} active, {len(entries)-active} inactive)")

if __name__ == "__main__":
    main()
