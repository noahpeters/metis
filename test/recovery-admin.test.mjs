import assert from "node:assert/strict";
import test from "node:test";
import { recoveryEvidencePolicy, repositoryOverviewForIdentity, selectRecoveryEvidence, visibleOperatorIssues } from "../src/recovery-admin.mjs";

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

function overviewEnv() {
  return {
    ALLOWED_REPOSITORIES: "owner/one,owner/two",
    DB: { prepare(sql) { return { bind() { return {
      async first() { return sql.includes("COUNT(*)") ? { count: 2 } : null; },
      async all() { return { results: [] }; },
    }; } }; } },
  };
}

test("repository overview exposes only repository-safe Project aggregates", async () => {
  const response = await repositoryOverviewForIdentity("admin@from-trees.com", overviewEnv(), async () => ({
    "owner/one": { statuses: { Ready: 2, "Awaiting human": 1 }, awaiting_human_reasons: { Reviewing: 1 } },
    "owner/two": { statuses: {}, awaiting_human_reasons: {} },
  }));
  const body = await response.json();
  assert.deepEqual(body.repositories.map(({ repository, project_counts }) => ({ repository, project_counts })), [
    { repository: "owner/one", project_counts: { statuses: { Ready: 2, "Awaiting human": 1 }, awaiting_human_reasons: { Reviewing: 1 } } },
    { repository: "owner/two", project_counts: { statuses: {}, awaiting_human_reasons: {} } },
  ]);
});

test("repository overview reports failed Project observations as unavailable", async () => {
  const response = await repositoryOverviewForIdentity("admin@from-trees.com", overviewEnv(), async () => { throw new Error("GitHub unavailable"); });
  const body = await response.json();
  assert.ok(body.repositories.every(({ project_counts }) => project_counts === null));
});

test("operator issue lists include open Metis-owned non-Backlog items only", () => {
  const queue = [
    { repository: "owner/one", issueNumber: 1, title: "Visible", issueState: "OPEN", projectStatus: "Ready", lifecycleTags: ["metis:blocked"], metisOwned: true },
    { repository: "owner/one", issueNumber: 2, title: "Backlog", issueState: "OPEN", projectStatus: "Backlog", lifecycleTags: [], metisOwned: true },
    { repository: "owner/one", issueNumber: 3, title: "Closed", issueState: "CLOSED", projectStatus: "Done", lifecycleTags: ["metis:complete"], metisOwned: true },
    { repository: "owner/one", issueNumber: 4, title: "Human", issueState: "OPEN", projectStatus: "Ready", lifecycleTags: [], metisOwned: false },
  ];
  assert.deepEqual(visibleOperatorIssues(queue, "owner/one", [{ issue_number: 1, state: "retrying", updated_at: 42 }]), [{ repository: "owner/one", issue_number: 1, title: "Visible", issue_state: "OPEN", project_status: "Ready", status_tags: ["metis:blocked"], task_state: "retrying", updated_at: 42 }]);
});
