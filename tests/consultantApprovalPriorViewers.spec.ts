/**
 * E2E test for the "Viewed by" chip strip on inline approval cards in the
 * AI Consultant chat (Task #762, follow-up to Task #544).
 *
 * Stubs GET /api/ai/approvals/:code, injects a synthetic assistant bubble
 * with an APR-XXXXXXXX-XXXXXX code, and asserts the rendered card.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import * as crypto from "crypto";

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
// Role gate validates X-Admin-Key against ADMIN_API_KEY exactly
// (hasValidAdminApiKey in src/utils/rbacMiddleware.ts).
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.TEST_ADMIN_KEY || "";

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function buildActionCode(): string {
  const d = new Date();
  const ymd =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[crypto.randomInt(alphabet.length)];
  }
  return `APR-${ymd}-${suffix}`;
}

interface SeedViewer {
  user_id: number | null;
  user_email: string | null;
  user_name: string | null;
  user_role: string | null;
  last_viewed_at: string;
  view_count: number;
}

function buildStubResponse(actionCode: string, priorViewers: SeedViewer[]) {
  return {
    success: true,
    action: {
      action_code: actionCode,
      tool_id: `e2e_consultant_chip_${RUN_ID}`,
      tool_label: `Stub action for Task 762 (${RUN_ID})`,
      payload_preview: `Stub preview ${RUN_ID}.`,
      risk_level: "medium",
      compliance_refs: [],
      requested_by_user_id: null,
      requested_by_email: `e2e-consultant-${RUN_ID}@walaplus-test.invalid`,
      requested_by_name: `Task 762 e2e Requester ${RUN_ID}`,
      thread_id: `thr_consultant_e2e_${RUN_ID}`,
      status: "pending" as const,
      created_at: new Date().toISOString(),
    },
    compliance_doc_links: {},
    can_approve: true,
    can_approve_blocker: null,
    approver_roles: ["admin", "quality_manager"],
    prior_viewers: priorViewers,
  };
}

async function setupConsultantPage(
  page: Page,
  priorViewers: SeedViewer[],
): Promise<string> {
  const actionCode = buildActionCode();
  const stub = buildStubResponse(actionCode, priorViewers);

  await page.route(
    `**/api/ai/approvals/${encodeURIComponent(actionCode)}`,
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(stub),
      });
    },
  );

  return actionCode;
}

async function injectAssistantBubbleWithApprovalCode(
  page: Page,
  actionCode: string,
): Promise<void> {
  await page.evaluate((code) => {
    const container = document.getElementById("messagesContainer");
    if (!container) throw new Error("messagesContainer not found on page");
    const wrapper = document.createElement("div");
    wrapper.className = "flex justify-start gap-2";
    const column = document.createElement("div");
    column.className = "max-w-[75%] flex flex-col";
    const bubble = document.createElement("div");
    bubble.className =
      "bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3 text-sm text-gray-800 leading-relaxed shadow-sm assistant-content";
    bubble.setAttribute("data-role", "assistant-bubble");
    bubble.textContent = "I have queued action " + code + " for your review.";
    column.appendChild(bubble);
    wrapper.appendChild(column);
    container.appendChild(wrapper);
  }, actionCode);
}

test.describe('Consultant chat — "Viewed by" chips on inline approval cards', () => {
  test.use({
    extraHTTPHeaders: ADMIN_KEY ? { "X-Admin-Key": ADMIN_KEY } : {},
  });

  test("renders chip strip with one chip per prior viewer (Task #544)", async ({
    page,
  }) => {
    if (!ADMIN_KEY) {
      test.skip(true, "ADMIN_API_KEY / TEST_ADMIN_KEY not set");
      return;
    }

    // Mix of view_count=1, view_count=3 ("×N" branch), and null role
    // (optional role-span branch).
    const seedViewers: SeedViewer[] = [
      {
        user_id: 101,
        user_email: `lead-auditor-${RUN_ID}@walaplus-test.invalid`,
        user_name: `Lead Auditor ${RUN_ID}`,
        user_role: "quality_manager",
        last_viewed_at: new Date(Date.now() - 60 * 1000).toISOString(),
        view_count: 1,
      },
      {
        user_id: 102,
        user_email: `repeat-reviewer-${RUN_ID}@walaplus-test.invalid`,
        user_name: `Repeat Reviewer ${RUN_ID}`,
        user_role: "admin",
        last_viewed_at: new Date(Date.now() - 30 * 1000).toISOString(),
        view_count: 3,
      },
      {
        user_id: 103,
        user_email: `no-role-${RUN_ID}@walaplus-test.invalid`,
        user_name: `Quality Specialist ${RUN_ID}`,
        user_role: null,
        last_viewed_at: new Date(Date.now() - 15 * 1000).toISOString(),
        view_count: 1,
      },
    ];

    const actionCode = await setupConsultantPage(page, seedViewers);

    const detailResPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/ai/approvals/${actionCode}`) &&
        r.request().method() === "GET",
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/consultant.html`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => !!document.getElementById("messagesContainer"),
      undefined,
      { timeout: 10000 },
    );

    await injectAssistantBubbleWithApprovalCode(page, actionCode);

    const detailRes = await detailResPromise;
    expect(detailRes.status()).toBe(200);

    const card = page.locator(`[data-approval-code="${actionCode}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toHaveAttribute(
      "data-approval-card-status",
      "pending",
      { timeout: 10000 },
    );

    const viewersSection = card.locator(
      '[data-testid="section-prior-viewers"]',
    );
    await expect(viewersSection).toHaveCount(1);
    await expect(viewersSection).toBeVisible();
    await expect(viewersSection).toContainText("Viewed by:");

    const chips = viewersSection.locator('[data-testid="chip-prior-viewer"]');
    await expect(chips).toHaveCount(seedViewers.length);

    for (const viewer of seedViewers) {
      const chip = chips.filter({ hasText: viewer.user_name ?? "" });
      await expect(chip).toHaveCount(1);
      if (viewer.user_role) {
        await expect(chip).toContainText(`(${viewer.user_role})`);
      }
    }

    const repeatChip = chips.filter({ hasText: `Repeat Reviewer ${RUN_ID}` });
    await expect(repeatChip).toContainText("×3");
  });

  test("omits chips when prior_viewers is empty (Task #544 empty case)", async ({
    page,
  }) => {
    if (!ADMIN_KEY) {
      test.skip(true, "ADMIN_API_KEY / TEST_ADMIN_KEY not set");
      return;
    }

    const actionCode = await setupConsultantPage(page, []);

    const detailResPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/ai/approvals/${actionCode}`) &&
        r.request().method() === "GET",
      { timeout: 15000 },
    );

    await page.goto(`${BASE_URL}/consultant.html`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => !!document.getElementById("messagesContainer"),
      undefined,
      { timeout: 10000 },
    );

    await injectAssistantBubbleWithApprovalCode(page, actionCode);

    const detailRes = await detailResPromise;
    expect(detailRes.status()).toBe(200);

    const card = page.locator(`[data-approval-code="${actionCode}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toHaveAttribute(
      "data-approval-card-status",
      "pending",
      { timeout: 10000 },
    );

    // Wrapper must always render so Task #631's silent refresh can grow
    // it in place when a viewer arrives later.
    const viewersSection = card.locator(
      '[data-testid="section-prior-viewers"]',
    );
    await expect(viewersSection).toHaveCount(1);
    await expect(viewersSection).toBeAttached();

    const chips = viewersSection.locator('[data-testid="chip-prior-viewer"]');
    await expect(chips).toHaveCount(0);
    await expect(viewersSection).not.toContainText("Viewed by:");
  });
});
