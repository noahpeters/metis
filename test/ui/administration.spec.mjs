import { expect, test } from "@playwright/test";

const pacing = {
  window: { id: "window-ui-test", started_at: "2026-01-01T00:00:00Z", next_scheduled_reset_at: "2026-01-08T00:00:00Z" },
  pacing: { estimated_workload_units: { used: 3, limit: 20 }, task_starts: { used: 2, limit: 10 }, limiting_dimension: null, state: "available" },
  active_tasks: { count: 1 },
  executable_ready: { count: 4 },
  provider_capacity: { state: "available" },
  observed_at: "2026-01-01T12:00:00Z",
};

test("renders the authenticated administration UI", async ({ page }, testInfo) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: { service: "metis", status: "operational" } }));
  await page.route("**/api/pacing", (route) => route.fulfill({ json: pacing }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByText("metis is operational.")).toBeVisible();
  await expect(page.getByText("3 / 20")).toBeVisible();
  await expect(page.locator("header")).toContainText("ui-test@from-trees.com");

  await page.screenshot({ path: testInfo.outputPath("administration.png"), fullPage: true });
  await testInfo.attach("rendered-administration", { path: testInfo.outputPath("administration.png"), contentType: "image/png" });
});
