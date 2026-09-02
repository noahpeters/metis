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
