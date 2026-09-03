# Run QC Inside Replit (to avoid production 52 errors)

If QC from your PC against `https://<REDACTED_HOST>` always shows 52 "fetch failed" errors, the production URL may not accept API requests from outside. **Run the QC inside Replit** so it hits the server on the same machine (localhost).

## Steps in Replit

1. **Start the app**  
   Click **Run** so the app is running (e.g. on port 5000).

2. **Open the Shell**  
   In Replit, open the **Shell** tab (bottom panel).

3. **Run QC against localhost** (no env var):
   ```bash
   npm run qc
   ```
   This uses the default `<REDACTED_URL>`, so all requests stay inside Replit.

4. **Check the report**  
   Open `tests/qc/qc-report.md` in the Replit file tree. You should see real pass/fail counts (e.g. 49 pass, 3 fail for admin/404).

## Why this helps

- **From your PC:** Requests go to `https://<REDACTED_HOST>`. If that deployment doesn’t expose the API to the internet (or blocks external requests), every request fails → 52 errors.
- **From Replit Shell:** Requests go to `<REDACTED_URL>` on the same machine as the running app, so the API is reachable and you get accurate results.

Use the Replit-run QC report as the source of truth for what’s working. Use production URL from your PC only when your Replit plan actually exposes the API at that URL.
