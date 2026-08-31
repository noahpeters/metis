import assert from "node:assert/strict";
import test from "node:test";
import { ProjectAdmissionError, loadProjectPolicy, readProjectQueue } from "../src/project.mjs";

const policy = {
  projectId: "PVT_kwHOAA6eJM4Bh81k",
  executionOwnerFieldId: "owner-field",
  metisOwnerOptionId: "metis-option",
  statusFieldId: "status-field",
  readyStatusOptionId: "ready-option",
};

function page(nodes, hasNextPage = false, endCursor = null) {
  return { node: { id: policy.projectId, fields: { nodes: [
    { id: "owner-field", name: "Execution owner", options: [{ id: "metis-option", name: "Metis" }, { id: "human-option", name: "Human" }] },
    { id: "status-field", name: "Status", options: [{ id: "ready-option", name: "Ready" }, { id: "todo-option", name: "Todo" }] },
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
  }), /Ready status schema/);
  await assert.rejects(() => readProjectQueue(env, async () => page([item("one", 1), item("two", 1)])), /duplicate issue/);
  await assert.rejects(() => readProjectQueue(env, async () => page([item("one", 1, "metis-option", "ready-option", "outside/repo")])), /disallowed repository/);
  await assert.rejects(() => readProjectQueue(env, async () => page([{ ...item("one", 1), content: { __typename: "PullRequest" } }])), /not an accessible issue/);
});

test("Project credential and exact ID policy are mandatory", async () => {
  assert.throws(() => loadProjectPolicy(), ProjectAdmissionError);
  await assert.rejects(() => readProjectQueue({ ...env, METIS_PROJECT_USER_TOKEN: undefined }), /METIS_PROJECT_USER_TOKEN/);
});
