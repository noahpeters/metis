import test from "node:test";
import assert from "node:assert/strict";
import { buildMergeConflictCorrectionComment, conflictTupleKey, mergeabilityObservation } from "../src/merge-conflicts.mjs";

test("unknown mergeability is distinct from clean and conflicting evidence", () => {
  assert.equal(mergeabilityObservation({ mergeable: null, mergeable_state: "unknown" }), "mergeability_unknown");
  assert.equal(mergeabilityObservation({ mergeable: false, mergeable_state: "dirty" }), "conflicting");
  assert.equal(mergeabilityObservation({ mergeable: false, mergeable_state: "blocked" }), "clean");
  assert.equal(mergeabilityObservation({ mergeable: true, mergeable_state: "clean" }), "clean");
});

test("conflict dispatch identity is exact to PR, base, and head", () => {
  assert.equal(conflictTupleKey(42, "base", "head"), "42:base:head");
  assert.notEqual(conflictTupleKey(42, "new-base", "head"), conflictTupleKey(42, "base", "head"));
});

test("same-PR correction prompt preserves both sides and requires exact-SHA verification", () => {
  const task = { repository: "owner/repo", issue_number: 13 };
  const pull = { number: 42, head: { ref: "codex/feature" } };
  const body = buildMergeConflictCorrectionComment(task, pull, "a".repeat(40), "b".repeat(40));
  assert.match(body, /push the verified correction to its current branch/);
  assert.match(body, /Preserve both intended implementations/);
  assert.match(body, /Do not create a replacement pull request/);
  assert.match(body, new RegExp("a{40}"));
  assert.match(body, new RegExp("b{40}"));
  assert.match(body, /fresh checks on the new head/);
});
