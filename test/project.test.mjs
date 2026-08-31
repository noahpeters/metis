import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUS_NAMES, ProjectAdmissionError, loadProjectPolicy, planProjectStatusSchema, projectStatusForState, readProjectQueue, reconcileProjectStatuses } from "../src/project.mjs";

const policy = {
  projectId: "PVT_kwHOAA6eJM4Bh81k",
  executionOwnerFieldId: "owner-field",
  metisOwnerOptionId: "metis-option",
  statusFieldId: "status-field",
  readyStatusOptionId: "ready-option",
  statusOptions: Object.fromEntries(PROJECT_STATUS_NAMES.map((name) => [name, name === "Ready" ? "ready-option" : `${name.toLowerCase().replaceAll(" ", "-")}-option`])),
};

function page(nodes, hasNextPage = false, endCursor = null) {
  return { node: { id: policy.projectId, fields: { nodes: [
    { id: "owner-field", name: "Execution owner", options: [{ id: "metis-option", name: "Metis" }, { id: "human-option", name: "Human" }] },
    { id: "status-field", name: "Status", options: PROJECT_STATUS_NAMES.map((name) => ({ id: policy.statusOptions[name], name })) },
  ] }, items: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}

function item(id, number, owner = "metis-option", status = "ready-option", repository = "noahpeters/metis") {
  return { id, isArchived: false, content: { __typename: "Issue", id: `ISSUE_${number}`, number, repository: { nameWithOwner: repository } }, fieldValues: { nodes: [
    { optionId: owner, field: { id: "owner-field" } }, { optionId: status, field: { id: "status-field" } },
  ] } };
}

const env = { METIS_PROJECT_POLICY_JSON: JSON.stringify(policy), ALLOWED_REPOSITORIES: "noahpeters/metis,noahpeters/metis-sandbox" };

test("Project pages retain connection POSITION order and eligibility", async () => {
  const calls = [];
  const graphql = async (_env, query, variables) => {
    assert.match(query, /orderBy: \{field: POSITION, direction: ASC\}/);
    calls.push(variables.cursor);
    return variables.cursor === null
      ? page([item("item-2", 2), item("item-3", 3, "human-option")], true, "next")
      : page([item("item-1", 1, "metis-option", "todo-option"), item("item-4", 4)]);
  };
  const result = await readProjectQueue(env, graphql);
  assert.deepEqual(calls, [null, "next"]);
  assert.deepEqual(result.map(({ projectItemId, orderIndex, eligible }) => ({ projectItemId, orderIndex, eligible })), [
    { projectItemId: "item-2", orderIndex: 0, eligible: true },
    { projectItemId: "item-3", orderIndex: 1, eligible: false },
    { projectItemId: "item-1", orderIndex: 2, eligible: false },
    { projectItemId: "item-4", orderIndex: 3, eligible: true },
  ]);
});

test("Project queue fails closed for schema drift, duplicates, and disallowed content", async () => {
  await assert.rejects(() => readProjectQueue(env, async () => {
    const value = page([item("one", 1)]); value.node.fields.nodes[1].options[0].name = "Not ready"; return value;
  }), /Project Status option/);
  await assert.rejects(() => readProjectQueue(env, async () => page([item("one", 1), item("two", 1)])), /duplicate issue/);
  await assert.rejects(() => readProjectQueue(env, async () => page([item("one", 1, "metis-option", "ready-option", "outside/repo")])), /disallowed repository/);
  await assert.rejects(() => readProjectQueue(env, async () => page([{ ...item("one", 1), content: { __typename: "PullRequest" } }])), /not an accessible issue/);
});

test("Project credential and exact ID policy are mandatory", async () => {
  assert.throws(() => loadProjectPolicy(), ProjectAdmissionError);
  await assert.rejects(() => readProjectQueue({ ...env, METIS_PROJECT_USER_TOKEN: undefined }), /METIS_PROJECT_USER_TOKEN/);
});

test("every lifecycle state maps to its concise Project summary", () => {
  assert.equal(projectStatusForState("intake"), "Backlog");
  assert.equal(projectStatusForState("ready"), "Ready");
  for (const state of ["dispatching", "running", "revising"]) assert.equal(projectStatusForState(state), "In progress");
  for (const state of ["awaiting_pr_creation", "pr_ready", "reviewing", "merge_ready"]) assert.equal(projectStatusForState(state), "Awaiting human");
  for (const state of ["blocked", "budget_blocked", "failed", "recovery_blocked"]) assert.equal(projectStatusForState(state), "Blocked");
  for (const state of ["deploying", "recovery"]) assert.equal(projectStatusForState(state), "Deploying");
  assert.equal(projectStatusForState("complete"), "Done");
});

test("schema bootstrap dry-run plans additions without replacing option IDs", () => {
  const project = page([]).node;
  project.fields.nodes[1].options = project.fields.nodes[1].options.filter((option) => option.name !== "Done");
  assert.deepEqual(planProjectStatusSchema(project, policy).changes, ["add Status option: Done"]);
  assert.throws(() => planProjectStatusSchema(project, policy, { dryRun: false }), /Refusing to replace/);
});

test("status reconciliation repairs drift and records retryable failures", async () => {
  const statements = [];
  const db = { prepare(sql) { return { bind(...args) { return { async first() { return { state: "running" }; }, async run() { statements.push([sql, args]); } }; } }; } };
  const queue = [{ ...item("item-7", 7, "human-option", "ready-option"), repository: "noahpeters/metis", issueNumber: 7, projectItemId: "item-7", statusOptionId: "ready-option" }];
  const calls = [];
  const mirrorEnv = { ...env, DB: db };
  assert.deepEqual(await reconcileProjectStatuses(mirrorEnv, queue, { graphql: async (_env, query, variables) => calls.push({ query, variables }) }), { repaired: 1 });
  assert.equal(calls[0].variables.option, policy.statusOptions["In progress"]);
  await reconcileProjectStatuses(mirrorEnv, queue, { graphql: async () => { throw new Error("temporary outage"); } });
  assert.ok(statements.some(([sql, args]) => sql.startsWith("INSERT INTO project_status_sync") && args.includes("temporary outage")));
});
