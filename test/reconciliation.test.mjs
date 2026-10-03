import test from "node:test";
import assert from "node:assert/strict";
import { compareShowsAncestor, managedTaskMarker, RECONCILABLE_STATES, selectContainingWorkflowRuns, selectWorkflowRuns } from "../src/reconciliation.mjs";

test("reconciliation includes dispatches still waiting for connector acknowledgment", () => {
  assert.ok(RECONCILABLE_STATES.includes("pending_connector_ack"));
});

test("managed task markers require the exact repository and issue identity", () => {
  const marker = managedTaskMarker("owner/repo", 48);
  assert.match("Summary\n\nMetis-Task: owner/repo#48", marker);
  assert.doesNotMatch("Metis-Task: owner/repo#480", managedTaskMarker("owner/repo", 48));
  assert.doesNotMatch("Metis-Task: other/repo#48", managedTaskMarker("owner/repo", 48));
});

test("workflow evidence is exact-SHA and selects the latest rerun attempt", () => {
  const sha = "a".repeat(40);
  const selected = selectWorkflowRuns(["CI", "Release"], sha, [
    { id: 1, name: "CI", head_sha: sha, run_attempt: 1, conclusion: "failure" },
    { id: 2, name: "CI", head_sha: sha, run_attempt: 2, conclusion: "success" },
    { id: 3, name: "Release", head_sha: "b".repeat(40), run_attempt: 9, conclusion: "success" },
    { id: 4, name: "unconfigured", head_sha: sha, conclusion: "success" },
  ]);
  assert.equal(selected.get("CI").id, 2);
  assert.equal(selected.has("Release"), false);
  assert.equal(selected.has("unconfigured"), false);
});

test("GitHub compare status authoritatively identifies ancestry", () => {
  assert.equal(compareShowsAncestor({ status: "identical" }), true);
  assert.equal(compareShowsAncestor({ status: "ahead" }), true);
  assert.equal(compareShowsAncestor({ status: "diverged" }), false);
  assert.equal(compareShowsAncestor({ status: "behind" }), false);
});

test("containing deployment supersedes a cancelled exact-SHA run", async () => {
  const merge = "a".repeat(40);
  const deployed = "b".repeat(40);
  const comparisons = [];
  const selected = await selectContainingWorkflowRuns("owner/repo", ["Deploy"], merge, [
    { id: 1, name: "Deploy", head_sha: merge, status: "completed", conclusion: "cancelled" },
    { id: 2, name: "Deploy", head_sha: deployed, status: "completed", conclusion: "success" },
  ], async (...args) => { comparisons.push(args); return { status: "ahead" }; });
  assert.equal(selected.get("Deploy").head_sha, deployed);
  assert.deepEqual(comparisons, [["owner/repo", merge, deployed]]);
});

test("one containing deployment can qualify multiple merge commits idempotently", async () => {
  const deployed = "d".repeat(40);
  const runs = [{ id: 7, name: "Deploy", head_sha: deployed, status: "completed", conclusion: "success" }];
  const compare = async () => ({ status: "ahead" });
  const first = await selectContainingWorkflowRuns("owner/repo", ["Deploy"], "a".repeat(40), runs, compare);
  const second = await selectContainingWorkflowRuns("owner/repo", ["Deploy"], "b".repeat(40), runs, compare);
  const repeated = await selectContainingWorkflowRuns("owner/repo", ["Deploy"], "a".repeat(40), runs, compare);
  assert.equal(first.get("Deploy").id, 7);
  assert.equal(second.get("Deploy").id, 7);
  assert.equal(repeated.get("Deploy").id, 7);
});

test("divergent and failed deployments do not qualify completion", async () => {
  const selected = await selectContainingWorkflowRuns("owner/repo", ["Deploy"], "a".repeat(40), [
    { id: 1, name: "Deploy", head_sha: "b".repeat(40), status: "completed", conclusion: "success" },
    { id: 2, name: "Deploy", head_sha: "c".repeat(40), status: "completed", conclusion: "failure" },
  ], async () => ({ status: "diverged" }));
  assert.equal(selected.has("Deploy"), false);
});

test("every required workflow needs successful containing deployment evidence", async () => {
  const merge = "a".repeat(40);
  const selected = await selectContainingWorkflowRuns("owner/repo", ["Deploy API", "Deploy UI"], merge, [
    { id: 1, name: "Deploy API", head_sha: merge, status: "completed", conclusion: "success" },
    { id: 2, name: "Deploy UI", head_sha: "b".repeat(40), status: "completed", conclusion: "failure" },
  ], async () => ({ status: "ahead" }));
  assert.equal(selected.has("Deploy API"), true);
  assert.equal(selected.has("Deploy UI"), false);
});

test("task identity survives Codex bullet and inline-code PR descriptions", () => {
  const marker = managedTaskMarker("noahpeters/H2", 95);
  assert.match("### Testing\n- Metis-Task: noahpeters/H2#95\n", marker);
  assert.match("- PR metadata: `Metis-Task: noahpeters/H2#95`.", marker);
  assert.doesNotMatch("- Metis-Task: noahpeters/H2#950\n", marker);
  assert.doesNotMatch("`Metis-Task: noahpeters/H2#95-extra`", marker);
  assert.doesNotMatch("NotMetis-Task: noahpeters/H2#95", marker);
  assert.doesNotMatch("- Metis-Task: noahpeters/other#95", marker);
  assert.doesNotMatch("Metis-Task: owner/repoXname#95", managedTaskMarker("owner/repo.name", 95));
});

test("recent containing deployment completes reconciliation despite full history pages", async () => {
  const { collectContainingWorkflowRuns } = await import("../src/reconciliation.mjs");
  const pages = [];
  const selected = await collectContainingWorkflowRuns("owner/repo", ["Deploy"], "merge", async (page) => {
    pages.push(page);
    return Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index, name: "Deploy", head_sha: `deployed-${index}`, status: "completed", conclusion: "success" }));
  }, async () => ({ status: "ahead" }));
  assert.equal(selected.get("Deploy").id, 1000);
  assert.deepEqual(pages, [1]);
});

test("deployment lookup reads another page when a required workflow is missing", async () => {
  const { collectContainingWorkflowRuns } = await import("../src/reconciliation.mjs");
  const selected = await collectContainingWorkflowRuns("owner/repo", ["Deploy", "UI"], "merge", async (page) => page === 1
    ? Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index, name: "Deploy", head_sha: "merge", status: "completed", conclusion: "success" }))
    : [{ id: 100, name: "UI", head_sha: "merge", status: "completed", conclusion: "success" }], async () => ({ status: "ahead" }));
  assert.equal(selected.size, 2);
});

test("bounded incomplete or divergent evidence cannot clear a recovery lock", async () => {
  const { collectContainingWorkflowRuns } = await import("../src/reconciliation.mjs");
  await assert.rejects(collectContainingWorkflowRuns("owner/repo", ["Deploy"], "merge", async () =>
    Array.from({ length: 100 }, (_, index) => ({ id: index, name: "Deploy", head_sha: "other", status: "completed", conclusion: "success" })),
  async () => ({ status: "diverged" })), /pagination limit/);
  await assert.rejects(collectContainingWorkflowRuns("owner/repo", ["Deploy"], "merge", async () => [
    { id: 1, name: "Deploy", head_sha: "other", status: "completed", conclusion: "success" },
  ], async () => { throw new Error("GitHub unavailable"); }), /GitHub unavailable/);
});

test("H2 stale merged tasks clear the repository lock using a containing deployment", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { reconcileManagedTasks } = await import("../src/reconciliation.mjs");
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(name, migrations), "utf8"));
  const cases = [[82, 98, "- PR metadata: `Metis-Task: noahpeters/H2#82`."], [92, 97, "- Metis-Task: noahpeters/H2#92\n"], [95, 100, "- Metis-Task: noahpeters/H2#95\n"]];
  for (const [issue, pr] of cases) db.prepare("INSERT INTO tasks(id,repository,issue_number,title,state,pull_request_number,merge_sha,created_at,updated_at) VALUES (?,'noahpeters/H2',?,'Deployed change','deploying',?,?,1,1)").run(`noahpeters/H2#${issue}`, issue, pr, `merge-${issue}`);
  db.prepare("INSERT INTO repository_health(repository,state,blocking_sha,root_task_id,updated_at) VALUES ('noahpeters/H2','deploying','merge-95','noahpeters/H2#95',1)").run();
  // An older unrelated discovery task must not delay the deployment locks.
  db.exec("INSERT INTO tasks(id,repository,issue_number,title,state,created_at,updated_at) VALUES ('owner/other#1','owner/other',1,'Old unbound task','awaiting_pr_creation',0,0)");
  const env = {
    GITHUB_TOKEN: "test-token",
    METIS_LIFECYCLE_POLICY_JSON: JSON.stringify({ defaults: { deploymentWorkflows: ["Storefront"] } }),
    DB: {
      prepare(sql) { const statement = db.prepare(sql); return {
        args: [], bind(...args) { this.args = args; return this; },
        async first() { return statement.get(...this.args) || null; },
        async all() { return { results: statement.all(...this.args) }; },
        async run() { return { meta: { changes: statement.run(...this.args).changes } }; },
      }; },
      async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
    },
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method || "GET" });
    let body = {};
    if (!init.method && path.includes("/pulls/")) {
      const [issue, pr, marker] = cases.find(([, pr]) => path.endsWith(`/${pr}`));
      body = { number: pr, body: marker, merged: true, merge_commit_sha: `merge-${issue}`, head: { sha: "head" }, html_url: `https://github.test/pulls/${pr}` };
    } else if (path.endsWith("/actions/runs")) {
      body = { workflow_runs: Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index, name: "Storefront", head_sha: "current-main", status: "completed", conclusion: "success" })) };
    } else if (path.includes("/compare/")) body = { status: "ahead" };
    else if (!init.method && path.includes("/issues/")) body = { labels: [{ name: "metis:deploying" }] };
    return Response.json(body);
  };
  try {
    const results = await reconcileManagedTasks(env, { maxTasks: 3 });
    assert.equal(results.length, 3);
    assert.ok(results.every(({ state }) => state === "complete"));
    assert.deepEqual({ ...db.prepare("SELECT state,blocking_sha FROM repository_health").get() }, { state: "healthy", blocking_sha: null });
    assert.equal(db.prepare("SELECT count(*) AS count FROM reconciliation_events WHERE transition='complete'").get().count, 3);
    assert.equal(requests.filter(({ path, method }) => path.endsWith("/comments") && method === "POST").length, 3);
    const repeated = await reconcileManagedTasks(env, { repository: "noahpeters/H2" });
    assert.deepEqual(repeated, []);
    assert.equal(requests.filter(({ path, method }) => path.endsWith("/comments") && method === "POST").length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});
