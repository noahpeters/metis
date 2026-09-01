import test from "node:test";
import assert from "node:assert/strict";
import { managedTaskMarker, RECONCILABLE_STATES, selectWorkflowRuns } from "../src/reconciliation.mjs";

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
