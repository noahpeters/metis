import assert from "node:assert/strict";
import test from "node:test";
import { aggregateExecutableReady, classifyExecutableReady, observeExecutableReady } from "../src/executable-ready.mjs";

const policy = { statusOptions: { Done: "done" } };
const ready = (repository, number) => ({ repository, issueNumber: number, issueState: "OPEN", eligible: true, statusOptionId: "ready" });
const projectItem = (repository, number, statusOptionId) => ({ repository, issueNumber: number, issueState: "OPEN", eligible: false, statusOptionId });
const blocker = (key) => ({ prerequisiteKey: key });

test("executable Ready classification applies all-of Project Done semantics", () => {
  const queue = [ready("acme/app", 1), ready("acme/app", 2), ready("acme/app", 3), ready("acme/app", 4), projectItem("acme/api", 10, "done"), projectItem("acme/api", 11, "backlog")];
  const dependencies = new Map([
    ["acme/app#1", []],
    ["acme/app#2", [blocker("acme/api#10")]],
    ["acme/app#3", [blocker("acme/api#11")]],
    ["acme/app#4", [blocker("acme/api#10"), blocker("acme/api#11")]],
  ]);
  const observation = classifyExecutableReady(queue, dependencies, policy);
  assert.deepEqual(observation.issues.map(({ key, executable }) => [key, executable]), [
    ["acme/app#1", true], ["acme/app#2", true], ["acme/app#3", false], ["acme/app#4", false],
  ]);
  assert.deepEqual(aggregateExecutableReady(observation, "acme/app"), { executable: 2, raw: 4, waiting: 2 });
  assert.equal(observation.executable_ready_count, 2);
});

test("cross-repository duplicates are harmless and unavailable Project status fails closed", () => {
  const queue = [ready("acme/app", 1), ready("acme/app", 2), projectItem("acme/api", 10, "done")];
  const dependencies = new Map([
    ["acme/app#1", [blocker("acme/api#10"), blocker("acme/api#10")]],
    ["acme/app#2", [blocker("acme/api#99")]],
  ]);
  const observation = classifyExecutableReady(queue, dependencies, policy);
  assert.equal(observation.issues[0].blocker_count, 1);
  assert.equal(observation.issues[0].executable, true);
  assert.equal(observation.issues[1].executable, false);
});

test("closed issues, dependency cycles, and non-Metis Ready items cannot inflate counts", () => {
  const closed = { ...ready("acme/app", 3), issueState: "CLOSED" };
  const queue = [ready("acme/app", 1), ready("acme/app", 2), closed, { ...ready("acme/app", 4), eligible: false }];
  const dependencies = new Map([["acme/app#1", [blocker("acme/app#2")]], ["acme/app#2", [blocker("acme/app#1")]]]);
  const observation = classifyExecutableReady(queue, dependencies, policy);
  assert.equal(observation.raw_ready_count, 2);
  assert.equal(observation.executable_ready_count, 0);
});

test("the authoritative observation scans every paginated Ready item, not the dispatch window", async () => {
  const fullPolicy = {
    projectId: "project", executionOwnerFieldId: "owner", metisOwnerOptionId: "metis", statusFieldId: "status", readyStatusOptionId: "ready",
    statusOptions: { Backlog: "backlog", Ready: "ready", "In progress": "progress", "Awaiting human": "human", Blocked: "blocked", Deploying: "deploying", Done: "done" },
  };
  const fields = { nodes: [
    { id: "owner", name: "Execution owner", options: [{ id: "metis", name: "Metis" }] },
    { id: "status", name: "Status", options: Object.entries(fullPolicy.statusOptions).map(([name, id]) => ({ id, name })) },
  ] };
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `item-${index + 1}`, isArchived: false,
    content: { __typename: "Issue", id: `issue-${index + 1}`, number: index + 1, state: "OPEN", repository: { nameWithOwner: "acme/app" } },
    fieldValues: { nodes: [{ optionId: "metis", field: { id: "owner" } }, { optionId: "ready", field: { id: "status" } }] },
  }));
  const graphql = async (_env, _query, variables) => variables.issue
    ? { node: { id: variables.issue, number: Number(variables.issue.slice(6)), repository: { nameWithOwner: "acme/app" }, parent: null, subIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }
    : { node: { id: "project", fields, items: { nodes: variables.cursor ? items.slice(15) : items.slice(0, 15), pageInfo: { hasNextPage: !variables.cursor, endCursor: variables.cursor ? null : "page-2" } } } };
  const fetched = [];
  const observation = await observeExecutableReady({ METIS_PROJECT_POLICY_JSON: JSON.stringify(fullPolicy), ALLOWED_REPOSITORIES: "acme/app" }, { graphql, fetchDependencies: async (_env, path) => { fetched.push(path); return []; } });
  assert.equal(observation.executable_ready_count, 30);
  assert.equal(fetched.length, 30);
});

test("incomplete dependency evidence makes the observation unavailable", async () => {
  const queue = [ready("acme/app", 1)];
  assert.throws(() => classifyExecutableReady(queue, new Map(), policy), /dependency observation/i);
});
