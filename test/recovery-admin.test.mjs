import assert from "node:assert/strict";
import test from "node:test";
import { recoveryEvidencePolicy, selectRecoveryEvidence } from "../src/recovery-admin.mjs";

const shaA = "a".repeat(40), shaB = "b".repeat(40);
const run = (id, name, sha, conclusion, updated_at) => ({ id, name, head_sha: sha, head_branch: "main", event: "push", conclusion, updated_at, html_url: `https://github.test/runs/${id}` });

test("exact-SHA policy does not silently accept a newer green deployment", () => {
  const runs = [run(1, "Deploy", shaA, "failure", "2026-08-01T00:00:00Z"), run(2, "Deploy", shaB, "success", "2026-09-01T00:00:00Z")];
  assert.equal(selectRecoveryEvidence(runs, ["Deploy"], shaA, "exact_sha"), null);
  assert.deepEqual(selectRecoveryEvidence(runs, ["Deploy"], shaA, "latest_main_success"), { head_sha: shaB, exact_sha: false, runs: [{ id: 2, name: "Deploy", url: "https://github.test/runs/2", conclusion: "success" }] });
});

test("recovery evidence requires every configured workflow on one SHA", () => {
  assert.equal(selectRecoveryEvidence([run(1, "Deploy", shaA, "success", "2026-09-01T00:00:00Z")], ["Deploy", "UI"], shaA, "exact_sha"), null);
  assert.equal(selectRecoveryEvidence([run(1, "Deploy", shaA, "success", "2026-09-01T00:00:00Z"), run(2, "UI", shaA, "cancelled", "2026-09-01T00:01:00Z")], ["Deploy", "UI"], shaA, "exact_sha"), null);
});

test("unknown recovery policies fail closed to exact SHA", () => {
  assert.equal(recoveryEvidencePolicy({ METIS_LIFECYCLE_POLICY_JSON: JSON.stringify({ repositories: { "owner/repo": { recoveryEvidence: "anything_green" } } }) }, "owner/repo"), "exact_sha");
});
