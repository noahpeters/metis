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

async function seed(db, { starts = 1, taskState = null, reconciled = true, provider = 1, exhausted = false, completed = [] } = {}) {
  await sql(db, [
    "DELETE FROM usage_events", "DELETE FROM dependencies", "DELETE FROM tasks", "DELETE FROM project_reconciliation_checkpoint",
    `UPDATE pacing_windows SET tasks_started=${starts} WHERE window_key=(SELECT current_window_id FROM pacing_window_control WHERE singleton=1)`,
    `UPDATE provider_capacity SET available=${provider}, metadata_json='${exhausted ? '{"outcome":"exhausted","limit_reason":"weekly limit"}' : '{}'}', updated_at=unixepoch(), resets_at=unixepoch()+3600 WHERE provider='codex_included'`,
  ]);
  if (reconciled) await db.prepare("INSERT INTO project_reconciliation_checkpoint(project_id,last_successful_at,updated_at) VALUES ('full-stack',?,unixepoch())").bind(Math.floor(Date.now() / 1000)).run();
  if (taskState) await db.prepare("INSERT INTO tasks(id,repository,issue_number,title,state,estimated_workload_units,budget_approved,dependencies_json,created_at,updated_at) VALUES ('round-trip','noahpeters/example',72,'Seeded through D1',?,1,1,'[]',unixepoch(),unixepoch())").bind(taskState).run();
  for (const [index, points] of completed.entries()) {
    const id = `completed-${index}`;
    await db.prepare("INSERT INTO tasks(id,repository,issue_number,title,state,estimated_workload_units,budget_approved,dependencies_json,created_at,updated_at) VALUES (?, 'noahpeters/example', ?, 'Completed work', 'awaiting_pr_creation', ?, 1, '[]', unixepoch(), unixepoch())").bind(id, 100 + index, points).run();
    await db.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES (?,'codex_included','coding_prepared',0,'{}',unixepoch())").bind(id).run();
  }
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
      { name: "ui", compatibilityFlags: ["rpc"], modules: uiModules, modulesRoot: root, serviceBindings: { CONTROL_PLANE: "control-plane" }, assets: { directory: join(root, "ui-assets"), binding: "ASSETS", run_worker_first: true }, bindings: { ENVIRONMENT: "local", LOCAL_AUTH_ENABLED: "true", LOCAL_AUTH_EMAIL: "tester@from-trees.com", UI_STREAM_INTERVAL_MS: "100", UI_STREAM_LIFETIME_MS: "300" } },
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

  await open({ starts: 1, taskState: "running", completed: [2, 5] });
  await page.getByRole("heading", { name: "Actively implementing" }).waitFor();
  assert.deepEqual(await page.locator(".completion-grid dd").allInnerTexts(), ["7", "7", "7"]);
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "active");

  await open({ starts: 1 });
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "unknown");

  await open({ provider: 0, exhausted: true });
  await page.getByRole("heading", { name: "Codex capacity exhausted" }).waitFor();
  assert.equal(await page.locator("#pacing-card").getAttribute("data-state"), "exhausted");
  assert.match(await page.locator(".reset-time").innerText(), /Expected availability/);
  await page.screenshot({ path: join(artifacts, "capacity-exhausted.png"), fullPage: true });
  const reenergizeResponse = page.waitForResponse((response) => response.url().endsWith("/api/capacity/reenergize"));
  await page.getByRole("button", { name: "Reenergize" }).click();
  assert.equal((await reenergizeResponse).status(), 200);
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();
  assert.equal((await db.prepare("SELECT available FROM provider_capacity WHERE provider='codex_included'").first()).available, 1);
  assert.equal((await db.prepare("SELECT mode,actor FROM capacity_reenergizations ORDER BY created_at DESC LIMIT 1").first()).mode, "operator");

  await open({ reconciled: false });
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();

  assert.equal(await page.getByRole("button", { name: "Reset budget" }).count(), 0);

  const unauthorized = await unauthorizedUi.fetch("https://ui/");
  assert.equal(unauthorized.status, 401);
  const binding = (await mf.getBindings("ui")).CONTROL_PLANE;
  const boundary = await binding.pacingOverview("attacker@example.com");
  assert.equal(boundary.status, 401, "authorization must be enforced by control-plane RPC, without shared secrets or CF-Worker headers");

  // Native task capture uses the real authenticated UI -> RPC -> D1 boundary.
  assert.equal((await unauthorizedUi.fetch("https://ui/tasks")).status,401);
  assert.equal((await binding.nativeTasks("attacker@example.com","GET","/api/tasks",null)).status,403);
  await page.goto("https://ui/tasks");
  await page.getByRole("button",{name:"New task",exact:true}).click();
  await page.getByLabel("Title",{exact:true}).fill("Prepare task context");
  await page.getByLabel("Instructions",{exact:true}).fill("Create a context manifest and verify it.");
  await page.getByLabel("Task data (JSON object)").fill('{"project":"Metis"}');
  await page.getByRole("button",{name:"Save task",exact:true}).click();
  await page.getByRole("heading",{name:"Prepare task context",exact:true}).waitFor();
  const parentId=new URL(page.url()).pathname.split('/')[2];
  assert.equal(JSON.parse((await db.prepare("SELECT data_json FROM native_tasks WHERE id=?").bind(parentId).first()).data_json).project,"Metis");
  await page.getByRole("button",{name:"New task",exact:true}).click();
  await page.getByLabel("Title",{exact:true}).fill("Execute dependent task");
  await page.getByLabel("Instructions",{exact:true}).fill("Use the prepared context to write and test code.");
  await page.getByRole("button",{name:"Save task",exact:true}).click();
  await page.getByRole("heading",{name:"Execute dependent task",exact:true}).waitFor();
  const childId=new URL(page.url()).pathname.split('/')[2];
  await page.getByLabel("Dependencies (select tasks that must complete first)").selectOption(parentId);
  const depSaved=page.waitForResponse(r=>r.url().endsWith('/dependencies'));
  await page.getByRole("button",{name:"Save dependencies",exact:true}).click();
  assert.equal((await depSaved).status(),200);
  await page.getByRole("button",{name:"Mark ready",exact:true}).click();
  await page.getByRole("button",{name:"Start cloud execution",exact:true}).waitFor();
  assert.equal(await page.getByRole("button",{name:"Start cloud execution",exact:true}).isDisabled(),true);
  assert.equal((await db.prepare("SELECT dependency_id FROM native_task_dependencies WHERE task_id=?").bind(childId).first()).dependency_id,parentId);
  await page.screenshot({path:join(artifacts,"native-tasks-desktop.png"),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(artifacts,"native-tasks-mobile.png"),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1280,height:900});
  // Seed a provider receipt to verify the actual retained attempt deep link.
  const attemptId=crypto.randomUUID();
  await db.prepare("UPDATE native_tasks SET phase='ready' WHERE id=?").bind(parentId).run();
  await db.prepare("INSERT INTO standalone_tasks(id,instructions,state,executor,result_json) VALUES (?,'fixture execution','completed','codex',?)").bind(attemptId,JSON.stringify({threadId:'fixture-codex-thread',containerStopped:true,finalMessage:'Context verified',repository:{binding:'example',canRework:true,publication:{state:'published',receipt:{review:{id:'1',url:'https://github.com/example/project/pull/1'}}}}})).run();
  await db.prepare("INSERT INTO native_task_attempts(id,task_id,requested_by) VALUES (?,?,'tester@from-trees.com')").bind(attemptId,parentId).run();
  await page.goto(`https://ui/tasks/${parentId}/attempts/${attemptId}`);
  await page.getByText('Codex thread: fixture-codex-thread',{exact:true}).waitFor();
  await page.getByText('Saved execution result',{exact:true}).click();
  assert.match(await page.locator('.task-attempt pre').innerText(),/Context verified/);
  await page.screenshot({path:join(artifacts,"native-task-attempt.png"),fullPage:true});
  await db.prepare("UPDATE native_tasks SET data_json=? WHERE id=?").bind(JSON.stringify({repositoryBinding:'example'}),parentId).run();
  await page.getByRole('button',{name:'Rework change',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).selectOption('resolve_conflicts');
  await page.getByLabel('Rework instructions',{exact:true}).fill('Resolve the conflicts against the new target base.');
  const rejectedRework=page.waitForResponse(r=>r.url().endsWith('/rework'));
  await page.getByRole('button',{name:'Start new attempt',exact:true}).click();
  assert.equal((await rejectedRework).status(),503);
  await page.locator('#rework-error').getByText('Repository binding is not configured',{exact:true}).waitFor();
  await page.locator('#cancel-rework').click();

  await page.goto("https://ui/");

  await db.exec("DROP TABLE pacing_window_control");
  await page.reload();
  await page.getByRole("heading", { name: "Status unknown" }).waitFor();
  await page.screenshot({ path: join(artifacts, "upstream-failure.png"), fullPage: true });
  assert.equal(diagnostics.filter((line) => line.startsWith("[pageerror]")).length, 0);
});
