import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUS_NAMES, ProjectAdmissionError, eligibleProjectItems, loadProjectPolicy, planProjectStatusSchema, projectStatusForState, projectTaskNeedsDispatch, readProjectQueue, readProjectStatusCounts, reconcileProjectStatuses, recoverInterruptedIntakes } from "../src/project.mjs";

const policy = {
  projectId: "PVT_kwHOAA6eJM4Bh81k",
  executionOwnerFieldId: "owner-field",
  metisOwnerOptionId: "metis-option",
  statusFieldId: "status-field",
  readyStatusOptionId: "ready-option",
  statusOptions: Object.fromEntries(PROJECT_STATUS_NAMES.map((name) => [name, name === "Ready" ? "ready-option" : `${name.toLowerCase().replaceAll(" ", "-")}-option`])),
};

test("Project intake recovery covers eligible tasks outside the dispatch scan", async () => {
  const states = new Map([["owner/repo#1", "ready"], ["owner/repo#26", "intake"]]);
  const sent = [];
  const recoveryEnv = {
    DB: { prepare(sql) { return { bind(...args) { return {
      async first() { return { state: states.get(args[0]) }; },
      async run() { return { meta: { changes: sql.startsWith("INSERT INTO project_queue_signals") ? 1 : 0 } }; },
    }; } }; } },
    DISPATCH_QUEUE: { async send(message) { sent.push(message); } },
  };
  const queue = Array.from({ length: 26 }, (_, index) => ({ repository: "owner/repo", issueNumber: index + 1, eligible: true }));
  assert.equal(await recoverInterruptedIntakes(recoveryEnv, queue), 1);
  assert.deepEqual(sent, [{ type: "intake", taskId: "owner/repo#26" }]);
});

function page(nodes, hasNextPage = false, endCursor = null) {
  return { node: { id: policy.projectId, fields: { nodes: [
    { id: "owner-field", name: "Execution owner", options: [{ id: "metis-option", name: "Metis" }, { id: "human-option", name: "Human" }] },
    { id: "status-field", name: "Status", options: PROJECT_STATUS_NAMES.map((name) => ({ id: policy.statusOptions[name], name })) },
  ] }, items: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}

function item(id, number, owner = "metis-option", status = "ready-option", repository = "noahpeters/metis") {
  return { id, isArchived: false, content: { __typename: "Issue", id: `ISSUE_${number}`, number, repository: { nameWithOwner: repository }, labels: { nodes: [] } }, fieldValues: { nodes: [
    { optionId: owner, field: { id: "owner-field" } }, { optionId: status, field: { id: "status-field" } },
  ] } };
}

test("Project status aggregates use every page and isolate repositories, owners, and content", async () => {
  const labeled = (value, labels) => ({ ...value, content: { ...value.content, labels: { nodes: labels.map((name) => ({ name })) } } });
  const ignored = { ...item("draft", 90), content: { __typename: "DraftIssue" } };
  const graphql = async (_env, _query, variables) => variables.cursor === null
    ? page([
      item("ready-1", 1),
      item("human", 2, "human-option"),
      item("backlog", 3, "metis-option", policy.statusOptions.Backlog),
      labeled(item("awaiting-1", 4, "metis-option", policy.statusOptions["Awaiting human"]), ["metis:awaiting-pr"]),
      ignored,
    ], true, "page-2")
    : page([
      labeled(item("awaiting-2", 5, "metis-option", policy.statusOptions["Awaiting human"], "noahpeters/metis-sandbox"), ["metis:reviewing"]),
      item("awaiting-3", 6, "metis-option", policy.statusOptions["Awaiting human"], "noahpeters/metis-sandbox"),
      item("done", 7, "metis-option", policy.statusOptions.Done, "noahpeters/metis-sandbox"),
      { ...item("unset", 8), fieldValues: { nodes: [{ optionId: "metis-option", field: { id: "owner-field" } }] } },
    ]);
  assert.deepEqual(await readProjectStatusCounts(env, graphql), {
    "noahpeters/metis": { statuses: { Ready: 1, "Awaiting human": 1 }, awaiting_human_reasons: { "Awaiting PR": 1 } },
    "noahpeters/metis-sandbox": { statuses: { "Awaiting human": 2, Done: 1 }, awaiting_human_reasons: { Reviewing: 1, Unclassified: 1 } },
  });
});

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

test("scheduler scans every eligible Project item in authoritative order", () => {
  const queue = Array.from({ length: 46 }, (_, index) => ({ id: index + 1, eligible: index !== 10 }));
  const eligible = eligibleProjectItems(queue);
  assert.equal(eligible.length, 45);
  assert.equal(eligible.at(-1).id, 46);
  assert.deepEqual(eligible.slice(24, 27).map(({ id }) => id), [26, 27, 28]);
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
  assert.deepEqual(eligibleProjectItems(queue).map((entry) => entry.issueNumber), [44, 45, 46, 25]);
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
  assert.equal(projectStatusForState("intake"), "Ready");
  assert.equal(projectStatusForState("ready"), "Ready");
  for (const state of ["dispatching", "pending_connector_ack", "running", "revising"]) assert.equal(projectStatusForState(state), "In progress");
  for (const state of ["awaiting_pr_creation", "pr_ready", "reviewing", "merge_ready"]) assert.equal(projectStatusForState(state), "Awaiting human");
  for (const state of ["blocked", "budget_blocked", "failed", "recovery_blocked"]) assert.equal(projectStatusForState(state), "Blocked");
  for (const state of ["deploying", "recovery"]) assert.equal(projectStatusForState(state), "Deploying");
  assert.equal(projectStatusForState("complete"), "Done");
});

test("Ready and retrying Project tasks both enter dispatch", () => {
  assert.equal(projectTaskNeedsDispatch("ready"), true);
  assert.equal(projectTaskNeedsDispatch("retrying"), true);
  assert.equal(projectTaskNeedsDispatch("intake"), false);
  assert.equal(projectTaskNeedsDispatch("running"), false);
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
  assert.equal(queue[0].statusOptionId, policy.statusOptions["In progress"]);
  assert.equal(queue[0].eligible, false);
  queue[0].statusOptionId = policy.statusOptions.Ready;
  await reconcileProjectStatuses(mirrorEnv, queue, { graphql: async () => { throw new Error("temporary outage"); } });
  assert.ok(statements.some(([sql, args]) => sql.startsWith("INSERT INTO project_status_sync") && args.includes("temporary outage")));
});

test("a repaired intake status becomes eligible in the same reconciliation", async () => {
  const db = { prepare() { return { bind() { return { async first() { return { state: "intake" }; }, async run() {} }; } }; } };
  const queue = [{ repository: "noahpeters/metis", issueNumber: 8, projectItemId: "item-8", ownerOptionId: policy.metisOwnerOptionId, statusOptionId: policy.statusOptions.Backlog, eligible: false }];
  await reconcileProjectStatuses({ ...env, DB: db }, queue, { graphql: async () => ({}) });
  assert.equal(queue[0].statusOptionId, policy.statusOptions.Ready);
  assert.equal(queue[0].eligible, true);
});

test("a human-set Project Ready status retries an ordinary blocked task", async () => {
  const statements = [];
  const db = { prepare(sql) { return { bind(...args) { return { async first() { return { state: "blocked" }; }, async run() { statements.push([sql, args]); } }; } }; } };
  const queue = [{ repository: "noahpeters/metis", issueNumber: 9, projectItemId: "item-9", ownerOptionId: policy.metisOwnerOptionId, statusOptionId: policy.statusOptions.Ready, eligible: true }];
  const calls = [];
  await reconcileProjectStatuses({ ...env, DB: db }, queue, { graphql: async (...args) => calls.push(args) });
  assert.ok(statements.some(([sql]) => sql.startsWith("UPDATE tasks SET state='retrying'")));
  assert.equal(queue[0].eligible, true);
  assert.equal(calls.length, 0);
});
