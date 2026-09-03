import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import uiWorker from "../src/ui/worker.mjs";

const root = new URL("..", import.meta.url).pathname;
const screenshot = join(root, "output/playwright/metis-pacing.png");
const overview = {
  semantics: "operational_capacity",
  observed_at: "2026-09-01T08:00:00.000Z",
  window: { id: "2026-09-01", next_scheduled_reset_at: "2026-09-01T10:00:00.000Z" },
  pacing: {
    state: "available",
    limiting_dimension: null,
    task_starts: { used: 8, limit: 24 },
  },
  work_completed: { unit: "size_points", last_1_hour: 5, last_8_hours: 18, last_24_hours: 32 },
  active_tasks: { count: 0 },
  executable_ready: { count: 5 },
  provider_capacity: { state: "available" },
};

const contentTypes = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const env = {
  ENVIRONMENT: "local",
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_EMAIL: "noah@from-trees.com",
  UI_STREAM_INTERVAL_MS: "100",
  UI_STREAM_LIFETIME_MS: "300",
  ASSETS: {
    async fetch(request) {
      const pathname = new URL(request.url).pathname.slice(1);
      const body = await readFile(join(root, "ui-assets", pathname));
      return new Response(body, { headers: { "content-type": contentTypes[extname(pathname)] } });
    },
  },
  CONTROL_PLANE: {
    async pacingOverview() { return { status: 200, body: JSON.stringify(overview) }; },
    async repositoryOverview() { return { status: 200, body: JSON.stringify({ repositories: [
      { repository: "noahpeters/metis", state: "recovery_blocked", dispatch_locked: true, blocking_sha: "60f1d51885342bfe349ff2c28736ce6b20d84846", workflow_url: "https://github.com/noahpeters/metis/actions/runs/33487414111", root_task_id: "noahpeters/metis#68", recovery_attempts: 2, updated_at: 1788249600, ready_count: 1, recovery_task: { issue_number: 68, state: "recovery_blocked" }, recovery_pr: { number: 73, state: "closed_unmerged", url: "https://github.com/noahpeters/metis/pull/73" }, deployment_evidence: [{ head_sha: "7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b", conclusion: "success" }], evidence_policy: "exact_sha", waiting_reason: "Normal dispatch is frozen while recovery for 60f1d5188534 is unresolved." },
      { repository: "noahpeters/ftops", state: "healthy", dispatch_locked: false, ready_count: 3 },
      { repository: "noahpeters/msgstats", state: "healthy", dispatch_locked: false, ready_count: 0 },
    ] }) }; },
    async nudgeReadyWork() { return { status: 200, body: JSON.stringify({ reconciled: true, observed: 5, admitted: 1 }) }; },
  },
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers });
    const response = await uiWorker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const failures = [];
  page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Ready work is waiting" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Nudge" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Reset budget" }).count(), 0);
  const circle = await page.locator(".status-circle").boundingBox();
  const cardDisplay = await page.locator("#pacing-card").evaluate((element) => getComputedStyle(element).display);
  assert.equal(cardDisplay, "grid", "pacing card CSS did not load");
  assert.ok(circle?.width >= 250 && circle?.height >= 250, "status circle is not rendered at the intended desktop size");
  assert.deepEqual(await page.locator(".completion-grid dd").allInnerTexts(), ["5", "18", "32"]);
  await page.getByRole("heading", { name: "noahpeters/metis" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Revalidate" }).count(), 1);
  assert.equal(failures.length, 0, failures.join("\n"));
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`Rendered UI verified: ${screenshot}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
