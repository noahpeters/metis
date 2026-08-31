import test from "node:test";
import assert from "node:assert/strict";
import { dependencyDecision, fetchBlockedBy, findDependencyCycle } from "../src/dependencies.mjs";

const task = { id: "acme/app#2", repository: "acme/app", issue_number: 2, issue_node_id: "I_2" };

function db() {
  const calls = [];
  return { calls, batch: async (statements) => calls.push(...statements), prepare: (sql) => ({ sql, bind(...values) { return { sql, values, run: async () => calls.push({ sql, values }) }; } }) };
}

test("only closed-as-completed dependencies satisfy admission and duplicate relationships collapse", async () => {
  const env = { ALLOWED_REPOSITORIES: "acme/app,acme/api", DB: db() };
  const issue = { node_id: "I_1", number: 1, repository_url: "https://api.github.com/repos/acme/api", state: "closed", state_reason: "completed" };
  const decision = await dependencyDecision(env, task, async () => [issue, issue]);
  assert.equal(decision.executable, true);
  assert.equal(env.DB.calls.filter((call) => call.sql?.includes("INSERT INTO github_dependencies")).length, 1);
});

test("open and not-planned prerequisites defer without admission", async () => {
  const env = { ALLOWED_REPOSITORIES: "acme/app,acme/api", DB: db() };
  const make = (number, state, stateReason) => ({ node_id: `I_${number}`, number, repository_url: "https://api.github.com/repos/acme/api", state, state_reason: stateReason });
  const decision = await dependencyDecision(env, task, async () => [make(1, "open", null), make(3, "closed", "not_planned")]);
  assert.deepEqual(decision.waitingOn, ["acme/api#1", "acme/api#3"]);
});

test("cross-repository dependencies must remain within the allowlist", async () => {
  await assert.rejects(() => fetchBlockedBy({ ALLOWED_REPOSITORIES: "acme/app" }, task, async () => [
    { node_id: "I_9", number: 9, repository_url: "https://api.github.com/repos/other/repo", state: "open" },
  ]), /outside the repository allowlist/);
});

test("cycle detection reports the exact chain, including self-dependencies", () => {
  assert.deepEqual(findDependencyCycle(new Map([["a#1", ["b#2"]], ["b#2", ["c#3"]], ["c#3", ["a#1"]]])), ["a#1", "b#2", "c#3", "a#1"]);
  assert.deepEqual(findDependencyCycle(new Map([["a#1", ["a#1"]]])), ["a#1", "a#1"]);
});

test("chains and diamonds are acyclic regardless of insertion order", () => {
  const graph = new Map([
    ["app#4", ["app#2", "app#3"]],
    ["app#3", ["app#1"]],
    ["app#2", ["app#1"]],
    ["app#1", []],
  ]);
  assert.equal(findDependencyCycle(graph), null);
});
