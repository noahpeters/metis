import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { chromium } from "playwright";

const root = new URL("../..", import.meta.url).pathname;
const artifacts = join(root, "output", "full-stack");
const policy = JSON.stringify({ global: { maxConcurrentTasks: 1, maxEstimatedWorkloadUnitsPerWindow: 8, maxTasksPerWindow: 4, maxRetries: 2 }, providers: { codex_included: { enabled: true }, paid_api: { enabled: false }, perplexity: { enabled: false } } });

async function migrate(db) {
  for (const name of (await readdir(join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort()) {
    // D1's exec() treats each newline as a separate statement. Repository
    // migrations format statements across lines, so normalize them first.
    const migration = (await readFile(join(root, "migrations", name), "utf8"))
      .replace(/^\s*--.*$/gm, "")
      .replace(/\r?\n/g, " ");
    await db.exec(migration);
  }
}

async function sql(db, statements) {
  for (const statement of statements) await db.prepare(statement).run();
}

async function modulesFor(entrypoint) {
  const paths = (await readdir(join(root, "src"), { recursive: true }))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => join(root, "src", name));
  const entry = join(root, entrypoint);
  return [entry, ...paths.filter((path) => path !== entry)].map((path) => ({ type: "ESModule", path }));
}

async function seed(db, { used = 3, starts = 1, taskState = null, reconciled = true, provider = 1 } = {}) {
  await sql(db, [
    "DELETE FROM dependencies", "DELETE FROM tasks", "DELETE FROM project_reconciliation_checkpoint",
    `UPDATE pacing_windows SET estimated_workload_units_used=${used}, tasks_started=${starts} WHERE window_key=(SELECT current_window_id FROM pacing_window_control WHERE singleton=1)`,
    `UPDATE provider_capacity SET available=${provider}, updated_at=unixepoch(), resets_at=unixepoch()+3600 WHERE provider='codex_included'`,
  ]);
  if (reconciled) await db.prepare("INSERT INTO project_reconciliation_checkpoint(project_id,last_successful_at,updated_at) VALUES ('full-stack',?,unixepoch())").bind(Math.floor(Date.now() / 1000)).run();
  if (taskState) await db.prepare("INSERT INTO tasks(id,repository,issue_number,title,state,estimated_workload_units,budget_approved,dependencies_json,created_at,updated_at) VALUES ('round-trip','noahpeters/example',72,'Seeded through D1',?,1,1,'[]',unixepoch(),unixepoch())").bind(taskState).run();
}

test("D1 observations round-trip through control-plane RPC and the rendered UI", { timeout: 120_000 }, async (t) => {
  await mkdir(artifacts, { recursive: true });
  // Miniflare 5's constructor uses its new configuration model. Keep the
  // concise programmatic v4 options for this isolated test and convert them
  // explicitly rather than relying on the removed implicit conversion.
  const controlPlaneModules = await modulesFor("src/control-plane-entrypoint.mjs");
  const uiModules = await modulesFor("src/ui/worker.mjs");
  const mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: "2026-08-30", cf: false, log: new Log(LogLevel.WARN),
    workers: [
      { name: "control-plane", compatibilityFlags: ["rpc"], modules: controlPlaneModules, modulesRoot: root, d1Databases: { DB: "round-trip" }, bindings: { METIS_POLICY_JSON: policy, DEPLOYMENT_VERSION: "full-stack-test" } },
      { name: "ui", compatibilityFlags: ["rpc"], modules: uiModules, modulesRoot: root, serviceBindings: { CONTROL_PLANE: "control-plane" }, assets: { directory: join(root, "ui-assets"), binding: "ASSETS", run_worker_first: true }, bindings: { ENVIRONMENT: "local", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "tester@from-trees.com" } },
      { name: "unauthorized-ui", compatibilityFlags: ["rpc"], modules: uiModules, modulesRoot: root, serviceBindings: { CONTROL_PLANE: "control-plane" }, assets: { directory: join(root, "ui-assets"), binding: "ASSETS", run_worker_first: true }, bindings: { ENVIRONMENT: "production", LOCAL_AUTH_ENABLED: "false" } },
    ],
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB", "control-plane");
  await migrate(db);
  const ui = await mf.getWorker("ui");
  const unauthorizedUi = await mf.getWorker("unauthorized-ui");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const diagnostics = [];
  page.on("console", (message) => diagnostics.push(`[console:${message.type()}] ${message.text()}`));
  page.on("response", (response) => diagnostics.push(`[response:${response.status()}] ${response.url()}`));
  page.on("requestfailed", (request) => diagnostics.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => diagnostics.push(`[pageerror] ${error.stack || error.message}`));
  t.after(() => writeFile(join(artifacts, "diagnostics.log"), diagnostics.join("\n")));

  async function open(state) {
    await seed(db, state);
    await page.goto("https://ui/");
  }
  // Route Chromium through the real Miniflare fetcher rather than an HTTP mock.
  await page.route("https://ui/**", async (route) => {
    const request = route.request();
    diagnostics.push(`[request] ${request.method()} ${request.url()}`);
    try {
      const headers = Object.fromEntries(Object.entries(request.headers()).filter(([name]) => ["accept", "content-type", "idempotency-key"].includes(name)));
      const response = await ui.fetch(request.url(), { method: request.method(), headers, body: request.method() === "GET" ? undefined : request.postDataBuffer() });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    } catch (error) {
      diagnostics.push(`[routeerror] ${request.url()} ${error.stack || error}`);
      await route.abort();
    }
  });

  await open({ used: 3, starts: 1, taskState: "running" });
  await page.getByRole("heading", { name: "Actively implementing" }).waitFor();
  assert.equal(await page.locator(".amount").innerText(), "3 / 8");
  assert.match(await page.locator(".reset-time").innerText(), /Next scheduled reset/);
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "active");

  await open({ used: 2, starts: 1 });
  await page.getByRole("heading", { name: "Available and idle" }).waitFor();
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "idle");

  await open({ used: 8, starts: 2 });
  await page.getByRole("heading", { name: "Workload-unit limit exhausted" }).waitFor();
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "exhausted");

  await open({ reconciled: false });
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();

  await open({ used: 5, starts: 2 });
  const source = (await db.prepare("SELECT current_window_id FROM pacing_window_control").first()).current_window_id;
  await page.getByRole("button", { name: "Reset budget" }).click();
  await page.locator("#reset-dialog").getByLabel("Reason").fill("Full-stack reset verification");
  const resetResponse = page.waitForResponse((response) => response.url().endsWith("/api/pacing/reset"));
  await page.getByRole("button", { name: "Start new window" }).click();
  assert.equal((await resetResponse).status(), 201);
  await page.getByText("Reset succeeded", { exact: false }).waitFor();
  assert.equal((await db.prepare("SELECT estimated_workload_units_used,tasks_started FROM pacing_windows WHERE window_key=(SELECT current_window_id FROM pacing_window_control)").first()).estimated_workload_units_used, 0);
  const audit = await db.prepare("SELECT actor_email,source_window_id,reason,outcome FROM pacing_reset_audit ORDER BY id DESC LIMIT 1").first();
  assert.deepEqual(audit, { actor_email: "tester@from-trees.com", source_window_id: source, reason: "Full-stack reset verification", outcome: "reset" });

  const unauthorized = await unauthorizedUi.fetch("https://ui/");
  assert.equal(unauthorized.status, 401);
  const binding = (await mf.getBindings("ui")).CONTROL_PLANE;
  const boundary = await binding.pacingOverview("attacker@example.com");
  assert.equal(boundary.status, 401, "authorization must be enforced by control-plane RPC, without shared secrets or CF-Worker headers");

  await db.exec("DROP TABLE pacing_window_control");
  await page.reload();
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();
  await page.screenshot({ path: join(artifacts, "upstream-failure.png"), fullPage: true });
  assert.equal(diagnostics.filter((line) => line.startsWith("[pageerror]")).length, 0);
});
