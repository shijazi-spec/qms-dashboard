# GRC Maturity Enhancement — Deploy to Replit

Please apply the following changes. There are **6 new files** to create and **4 existing files** to modify.

---

## STEP 1: Create 6 New Files

### File 1: `src/utils/managementReviewDatabase.ts`
Management Review module — ISO 9001 §9.3 meetings, decisions, action tracking, auto-gather QMS inputs.

Create this file with the full content from the local copy at `src/utils/managementReviewDatabase.ts`.

### File 2: `src/utils/analyticsEngine.ts`
Analytics Engine — process cycle times (avg/median/P90), per-agent compliance reports, CAPA recurrence detection, trend analysis.

Create this file with the full content from the local copy at `src/utils/analyticsEngine.ts`.

### File 3: `src/utils/executiveDigest.ts`
Executive Quality Digest — weekly email with NC/CAPA/risk/audit/KPI summary, styled HTML, send via Resend or Replit Mail.

Create this file with the full content from the local copy at `src/utils/executiveDigest.ts`.

### File 4: `src/mastra/routes/managementReviewRoutes.ts`
9 API endpoints for management reviews and action items.

Create this file with the full content from the local copy at `src/mastra/routes/managementReviewRoutes.ts`.

### File 5: `src/mastra/routes/analyticsRoutes.ts`
6 API endpoints for cycle times, agent compliance, CAPA recurrence, trends, and executive digest.

Create this file with the full content from the local copy at `src/mastra/routes/analyticsRoutes.ts`.

### File 6: `dashboard/reviews.html`
Management Review dashboard page — create/edit reviews, action items, auto-gather data, filters.

Create this file with the full content from the local copy at `dashboard/reviews.html`.

---

## STEP 2: Modify 4 Existing Files

### Modification 1: `src/mastra/index.ts`

**A) Add 2 imports** after the existing `import { reportRoutes }` line:

```typescript
import { managementReviewRoutes } from "./routes/managementReviewRoutes";
import { analyticsRoutes } from "./routes/analyticsRoutes";
```

**B) Register the routes** — in the `apiRoutes` array, after `...reportRoutes,` add:

```typescript
      ...managementReviewRoutes,
      ...analyticsRoutes,
```

**C) Add the `/reviews` page route** — find the section with `// Enterprise Risk Management Routes` and add this block BEFORE it:

```typescript
      // ======================================================================
      // Management Review Routes
      // ======================================================================
      {
        path: "/reviews",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "reviews.html"),
                join(process.cwd(), "..", "dashboard", "reviews.html"),
                "/home/runner/workspace/dashboard/reviews.html",
              ];
              for (const reviewsPath of possiblePaths) {
                if (existsSync(reviewsPath)) {
                  const html = readFileSync(reviewsPath, "utf-8");
                  return c.html(html);
                }
              }
              return c.text("Management Review page not found", 404);
            } catch (error) {
              console.error("Error serving Management Review page:", error);
              return c.text("Error loading Management Review", 500);
            }
          };
        },
      },
```

---

### Modification 2: `src/utils/aiBackgroundScanner.ts`

**A) Add 2 new functions** BEFORE the `export async function runBackgroundScan()` function:

```typescript
async function autoCreateNCsFromCriticalSLABreaches(result: ScanResult): Promise<void> {
  result.checksPerformed++;
  try {
    const criticalAlerts = await safeQuery(`
      SELECT id, title, description, related_module, related_record_id
      FROM ai_alerts
      WHERE alert_type = 'sla_breach' AND severity = 'critical' AND status = 'active'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM nonconformance_records
          WHERE source_type = 'sla_breach' AND source_id = CAST(ai_alerts.id AS TEXT)
        )
      ORDER BY created_at DESC LIMIT 10
    `);

    for (const alert of criticalAlerts) {
      try {
        const ncNumber = `NC-AUTO-${Date.now()}-${alert.id}`;
        await pool.query(`
          INSERT INTO nonconformance_records (nc_number, title, description, nc_type, severity, status,
            source_type, source_id, source_reference, detected_by, detected_date, metadata)
          VALUES ($1, $2, $3, 'process', 'critical', 'open', 'sla_breach', $4, $5, 'AI Scanner', NOW(),
            '{"auto_created": true, "alert_id": ${alert.id}}'::jsonb)
        `, [
          ncNumber,
          `[Auto] ${alert.title}`,
          `Automatically created from critical SLA breach alert.\n\n${alert.description}`,
          String(alert.id),
          `Alert #${alert.id} — ${alert.related_module}`
        ]);
        result.alertsCreated++;
        result.findings.push(`Auto-NC created from critical SLA breach: ${alert.title}`);
      } catch (ncErr) {
        console.warn('[AI Scanner] Failed to auto-create NC:', ncErr instanceof Error ? ncErr.message : ncErr);
      }
    }
  } catch (error) {
    console.error('[AI Scanner] Auto-NC creation check failed:', error instanceof Error ? error.message : error);
  }
}

async function checkCAPARecurrence(result: ScanResult): Promise<void> {
  result.checksPerformed++;
  try {
    const rows = await safeQuery(`
      SELECT root_cause, COUNT(*) as cnt,
             array_agg(capa_number ORDER BY created_at DESC) as capa_numbers
      FROM capa_records
      WHERE root_cause IS NOT NULL AND TRIM(root_cause) != ''
        AND created_at >= NOW() - INTERVAL '90 days'
      GROUP BY LOWER(TRIM(root_cause))
      HAVING COUNT(*) >= 2
      ORDER BY cnt DESC
      LIMIT 5
    `);

    for (const row of rows) {
      const created = await createAlertIfNew(
        'nc_detection', row.cnt >= 3 ? 'high' : 'medium',
        `CAPA recurrence: "${row.root_cause.substring(0, 60)}..." (${row.cnt}x in 90 days)`,
        `Root cause "${row.root_cause}" has appeared in ${row.cnt} CAPA records within the last 90 days: ${row.capa_numbers.join(', ')}. This indicates the corrective actions may not be addressing the systemic issue.`,
        `Conduct a deeper systemic root cause analysis. Consider process redesign, additional training, or structural controls to prevent recurrence.`,
        'qms'
      );
      if (created) { result.alertsCreated++; result.findings.push(`CAPA recurrence: ${row.root_cause.substring(0, 40)}`); }
    }
  } catch (error) {
    console.error('[AI Scanner] CAPA recurrence check failed:', error instanceof Error ? error.message : error);
  }
}
```

**B) In `runBackgroundScan()`**, add these 2 lines after `await checkHighConfidenceDuplicates(result);`:

```typescript
  await autoCreateNCsFromCriticalSLABreaches(result);
  await checkCAPARecurrence(result);
```

---

### Modification 3: `src/mastra/inngest/index.ts`

**Add this block** AFTER `inngestFunctions.push(aiScannerFunction);` and BEFORE `export function inngestServe({`:

```typescript
const executiveDigestFunction = inngest.createFunction(
  { id: "weekly-executive-digest" },
  { cron: process.env.DIGEST_CRON || "0 7 * * 1" },
  async ({ step }) => {
    return await step.run("send-executive-digest", async () => {
      console.log("[Digest] Weekly executive quality digest triggered");
      const { sendDigestEmail } = await import("../../utils/executiveDigest");
      const result = await sendDigestEmail();
      console.log("[Digest] Result:", result);

      if (result.success) {
        try {
          const { createNotification } = await import("../../utils/notificationHub");
          await createNotification({
            type: 'info',
            title: 'Weekly Quality Digest sent',
            message: `Executive quality digest sent via ${result.method}.`,
            link: '/executive',
            severity: 'low'
          });
        } catch {}
      }

      return result;
    });
  },
);
inngestFunctions.push(executiveDigestFunction);
```

---

### Modification 4: `dashboard/js/navigation.js`

In the `navigationGroups` array, find the **GRC** group's `items` array. Add this entry after the `Compliance` item and before the `Vendors` item:

```javascript
        { label: 'Mgmt Review', href: '/reviews', icon: 'clipboard-list', id: 'reviews' },
```

---

## STEP 3: Restart and Verify

After applying all changes, restart the server and verify:

1. `/reviews` page loads with Management Review UI
2. Navigation shows "Mgmt Review" under GRC group
3. `GET /api/management-reviews` returns `{ reviews: [], total: 0 }`
4. `GET /api/analytics/cycle-times` returns metrics object
5. `GET /api/analytics/agent-compliance` returns `{ reports: [] }`
6. `GET /api/analytics/executive-digest` returns digest data JSON
7. `GET /api/analytics/executive-digest?format=html` shows styled HTML digest

## Optional Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `DIGEST_CRON` | Executive digest cron schedule | `0 7 * * 1` (Mon 7 AM) |
| `QUALITY_DIGEST_EMAIL` | Digest recipient email | Falls back to `ADMIN_EMAIL` |
