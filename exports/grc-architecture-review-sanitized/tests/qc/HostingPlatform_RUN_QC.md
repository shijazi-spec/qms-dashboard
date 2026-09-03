# Run QC Inside HostingPlatform (to avoid production 52 errors)

If QC from your PC against `<REDACTED_URL_SCHEME><REDACTED_HOST>` always shows 52 "fetch failed" errors, the production URL may not accept API requests from outside. **Run the QC inside HostingPlatform** so it hits the server on the same machine (localhost).

## Steps in HostingPlatform

1. **Start the app**  
   Click **Run** so the app is running (e.g. on port 5000).

2. **Open the Shell**  
   In HostingPlatform, open the **Shell** tab (bottom panel).

3. **Run QC against localhost** (no env var):
   ```bash
   npm run qc
   ```
   This uses the default `<REDACTED_URL>`, so all requests stay inside HostingPlatform.

4. **Check the report**  
   Open `tests/qc/qc-report.md` in the HostingPlatform file tree. You should see real pass/fail counts (e.g. 49 pass, 3 fail for admin/404).

## Why this helps

- **From your PC:** Requests go to `<REDACTED_URL_SCHEME><REDACTED_HOST>`. If that deployment doesn’t expose the API to the internet (or blocks external requests), every request fails → 52 errors.
- **From HostingPlatform Shell:** Requests go to `<REDACTED_URL>` on the same machine as the running app, so the API is reachable and you get accurate results.

Use the HostingPlatform-run QC report as the source of truth for what’s working. Use production URL from your PC only when your HostingPlatform plan actually exposes the API at that URL.
