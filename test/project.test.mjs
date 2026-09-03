import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUS_NAMES, ProjectAdmissionError, boundedEligibleItems, loadProjectPolicy, planProjectStatusSchema, projectStatusForState, readProjectQueue, reconcileProjectStatuses } from "../src/project.mjs";
import { readFileSync } from "node:fs";

const policy = {
  projectId: "PVT_kwHOAA6eJM4Bh81k",
  executionOwnerFieldId: "owner-field",
  metisOwnerOptionId: "metis-option",
  statusFieldId: "status-field",
  readyStatusOptionId: "ready-option",
  statusOptions: Object.fromEntries(PROJECT_STATUS_NAMES.map((name) => [name, name === "Ready" ? "ready-option" : `${name.toLowerCase().replaceAll(" ", "-")}-option`])),
};

test("Project reconciliation re-enqueues interrupted intake tasks", () => {
  const source = readFileSync("src/project.mjs", "utf8");
  assert.match(source, /existing\.state === "intake"[\s\S]*enqueueOnce\(env, "intake", id\)/);
});

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

function withHierarchy(projectGraphql, children = {}, parents = {}) {
  return async (requestEnv, query, variables) => {
    if (!variables.issue) return projectGraphql(requestEnv, query, variables);
    const number = Number(variables.issue.replace("ISSUE_", ""));
    const childNumbers = children[number] || [];
    const parentNumber = parents[number];
    return { node: {
      id: variables.issue,
      number,
      repository: { nameWithOwner: "noahpeters/metis" },
      parent: parentNumber ? { id: `ISSUE_${parentNumber}`, number: parentNumber, repository: { nameWithOwner: "noahpeters/metis" } } : null,
      subIssues: { nodes: childNumbers.map((child) => ({ id: `ISSUE_${child}`, number: child, repository: { nameWithOwner: "noahpeters/metis" } })), pageInfo: { hasNextPage: false, endCursor: null } },
    } };
  };
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
  const result = await readProjectQueue(env, withHierarchy(graphql));
  assert.deepEqual(calls, [null, "next"]);
  assert.deepEqual(result.map(({ projectItemId, orderIndex, eligible }) => ({ projectItemId, orderIndex, eligible })), [
    { projectItemId: "item-2", orderIndex: 0, eligible: true },
    { projectItemId: "item-3", orderIndex: 1, eligible: false },
    { projectItemId: "item-1", orderIndex: 2, eligible: false },
    { projectItemId: "item-4", orderIndex: 3, eligible: true },
  ]);
});

test("scheduler scans are bounded without changing authoritative Project order", () => {
  const queue = [
    { id: "blocked-owner", eligible: false },
    { id: "highest", eligible: true },
    { id: "second", eligible: true },
    { id: "outside-bound", eligible: true },
  ];
  assert.deepEqual(boundedEligibleItems(queue, 2).map(({ id }) => id), ["highest", "second"]);
});

test("Project queue fails closed for schema drift and duplicates but skips ineligible content", async () => {
  await assert.rejects(() => readProjectQueue(env, withHierarchy(async () => {
    const value = page([item("one", 1)]); value.node.fields.nodes[1].options[0].name = "Not ready"; return value;
  })), /Project Status option/);
  await assert.rejects(() => readProjectQueue(env, withHierarchy(async () => page([item("one", 1), item("two", 1)]))), /duplicate issue/);
  assert.deepEqual(await readProjectQueue(env, withHierarchy(async () => page([item("one", 1, "metis-option", "ready-option", "outside/repo")]))), []);
  assert.deepEqual(await readProjectQueue(env, withHierarchy(async () => page([{ ...item("one", 1), content: { __typename: "PullRequest" } }]))), []);
  assert.deepEqual(await readProjectQueue(env, withHierarchy(async () => page([{ ...item("one", 1), isArchived: true }]))), []);
});

test("Project pagination rejects a repeated cursor", async () => {
  await assert.rejects(() => readProjectQueue(env, async () => page([], true, "same")), /repeated an end cursor/);
});

test("Project hierarchy groups descendants ahead of the next positioned root", async () => {
  const flat = [item("parent-5", 5, "human-option"), item("parent-12", 12, "human-option"), item("child-25", 25), item("child-44", 44), item("child-45", 45), item("child-46", 46)];
  const graphql = withHierarchy(async () => page(flat), { 5: [44, 45, 46], 12: [25] }, { 44: 5, 45: 5, 46: 5, 25: 12 });
  const queue = await readProjectQueue(env, graphql);
  assert.deepEqual(queue.map((entry) => entry.issueNumber), [5, 44, 45, 46, 12, 25]);
  assert.deepEqual(boundedEligibleItems(queue).map((entry) => entry.issueNumber), [44, 45, 46, 25]);
  assert.deepEqual(queue.find((entry) => entry.issueNumber === 44).ancestry.map((entry) => entry.issueNumber), [5]);
  assert.equal(queue.find((entry) => entry.issueNumber === 25).rootPosition, 1);
});

test("Project hierarchy preserves unparented positions, nested order, and deduplicates flat children", async () => {
  const flat = [item("parent-1", 1, "human-option"), item("child-2", 2), item("root-9", 9), item("child-3", 3)];
  const graphql = withHierarchy(async () => page(flat), { 1: [2], 2: [3] }, { 2: 1, 3: 2 });
  const queue = await readProjectQueue(env, graphql);
  assert.deepEqual(queue.map((entry) => entry.issueNumber), [1, 2, 3, 9]);
  assert.deepEqual(queue.find((entry) => entry.issueNumber === 3).ancestry.map((entry) => entry.issueNumber), [1, 2]);
  assert.deepEqual(queue.map((entry) => entry.orderIndex), [0, 1, 2, 3]);
});

test("Project hierarchy fails closed on cycles, conflicting parents, and sub-issue pagination failure", async () => {
  await assert.rejects(() => readProjectQueue(env, withHierarchy(async () => page([item("one", 1), item("two", 2)]), { 1: [2], 2: [1] }, { 1: 2, 2: 1 })), /cycle/);
  await assert.rejects(() => readProjectQueue(env, withHierarchy(async () => page([item("one", 1), item("two", 2), item("three", 3)]), { 1: [3], 2: [3] }, { 3: 1 })), /conflicting ancestry/);
  const incomplete = withHierarchy(async () => page([item("one", 1)]));
  await assert.rejects(() => readProjectQueue(env, async (...args) => {
    const result = await incomplete(...args);
    if (args[2].issue) result.node.subIssues.pageInfo = { hasNextPage: true, endCursor: null };
    return result;
  }), /did not return an end cursor/);
});

test("Project credential and exact ID policy are mandatory", async () => {
  assert.throws(() => loadProjectPolicy(), ProjectAdmissionError);
  await assert.rejects(() => readProjectQueue({ ...env, METIS_PROJECT_USER_TOKEN: undefined }), /METIS_PROJECT_USER_TOKEN/);
});

test("every lifecycle state maps to its concise Project summary", () => {
  assert.equal(projectStatusForState("intake"), "Backlog");
  assert.equal(projectStatusForState("ready"), "Ready");
  for (const state of ["dispatching", "pending_connector_ack", "running", "revising"]) assert.equal(projectStatusForState(state), "In progress");
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
