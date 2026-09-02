import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
import uiWorker from "../src/ui/worker.mjs";

const root = new URL("..", import.meta.url).pathname;
const screenshot = join(root, "output/playwright/metis-pacing.png");
const overview = {
  semantics: "estimated_local_pacing",
  observed_at: "2026-09-01T08:00:00.000Z",
  window: { id: "2026-09-01", next_scheduled_reset_at: "2026-09-01T10:00:00.000Z" },
  pacing: {
    state: "available",
    limiting_dimension: null,
    estimated_workload_units: { used: 32, limit: 64 },
    task_starts: { used: 8, limit: 24 },
  },
  active_tasks: { count: 0 },
  executable_ready: { count: 5 },
  provider_capacity: { state: "available" },
};

const contentTypes = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const env = {
  ENVIRONMENT: "local",
  LOCAL_AUTH_ENABLED: "true",
  LOCAL_AUTH_EMAIL: "noah@from-trees.com",
  ASSETS: {
    async fetch(request) {
      const pathname = new URL(request.url).pathname.slice(1);
      const body = await readFile(join(root, "ui-assets", pathname));
      return new Response(body, { headers: { "content-type": contentTypes[extname(pathname)] } });
    },
  },
  CONTROL_PLANE: {
    async pacingOverview() { return { status: 200, body: JSON.stringify(overview) }; },
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
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Ready work is waiting" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Nudge" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Reset budget" }).isVisible(), true);
  const circle = await page.locator(".status-circle").boundingBox();
  const cardDisplay = await page.locator("#pacing-card").evaluate((element) => getComputedStyle(element).display);
  assert.equal(cardDisplay, "grid", "pacing card CSS did not load");
  assert.ok(circle?.width >= 250 && circle?.height >= 250, "status circle is not rendered at the intended desktop size");
  assert.equal(await page.locator(".amount strong").textContent(), "32");
  assert.equal(await page.locator(".amount span").textContent(), " / 64");
  assert.equal(failures.length, 0, failures.join("\n"));
  await mkdir(join(root, "output/playwright"), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(`Rendered UI verified: ${screenshot}`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
