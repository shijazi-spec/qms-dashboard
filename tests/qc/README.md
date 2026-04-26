# WalaPlus Platform QC (Quality Control)

This folder contains the **Platform QC suite** used to verify that each screen and functionality in the WalaPlus app is working. It produces a report you can send to Replit (or any developer) to fix failures by **Screen name** and **Functionality name**.

## How it works

1. **Manifest** (`platform-qc-manifest.ts`) – Defines every check:
   - **Screen** (e.g. "Quality Dashboard", "Risk Register")
   - **Route** (e.g. `/`, `/risks`)
   - **Functionality** (e.g. "Load dashboard data", "List risks")
   - **API** (method + path) used to test that functionality

2. **Runner** (`run-platform-qc.ts`) – Calls each API against the running app and records pass/fail.

3. **Reports** (generated in this folder):
   - `qc-report.json` – Machine-readable (for Cursor/Replit/CI).
   - `qc-report.md` – Human-readable with a **"Send to Replit – Fix These"** table and a JSON block for copy-paste.

## Running the QC suite

**Prerequisites:** The app must be running (e.g. `npm run dev`) or use the live Replit URL.

```bash
# Test against local app (default http://localhost:5000)
npm run qc

# Test against Replit deployment
QC_BASE_URL=https://qms-dashboard.replit.app npm run qc

# Include admin-protected routes (Admin Panel, QMS)
ADMIN_API_KEY=your-admin-key npm run qc
```

## Using the results

- **Cursor / this agent (QC role):**  
  Run `npm run qc`, then open `tests/qc/qc-report.md`. The **"Send to Replit – Fix These"** section lists each failure with **Screen** and **Functionality**. You can say: *"Send to Replit: fix these"* and attach the table or the JSON block.

- **Replit:**  
  Use the table or the JSON from `qc-report.md` (or `qc-report.json`) to fix each item. Each row is one fix: **Screen** + **Functionality** + **Detail** (e.g. HTTP 500).

- **CI / automation:**  
  Run `npm run qc`; exit code is 1 if any check failed. Parse `qc-report.json` for failed entries.

## Adding or changing checks

Edit `platform-qc-manifest.ts`: add a new object to `PLATFORM_QC_MANIFEST` with `screenName`, `screenRoute`, `functionalityName`, `method`, `path`, and optional `headers` / `expectedStatus` / `allowUnauth`.

## Reports and git

You can add `qc-report.json` and `qc-report.md` to `.gitignore` if you prefer not to commit them. Keeping the latest report in the repo can help the team see current QC status.
