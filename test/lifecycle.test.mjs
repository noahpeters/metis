import test from "node:test";
import assert from "node:assert/strict";
import { approvalCount, checksPassed, lifecyclePolicy, pullRequestLifecycleFromWebhook, workflowRunFromWebhook } from "../src/lifecycle.mjs";

test("lifecycle policy is fail-closed and repository scoped", () => {
  assert.equal(lifecyclePolicy({}, "owner/repo").autoMerge, false);
  const env = { METIS_LIFECYCLE_POLICY_JSON: JSON.stringify({ defaults: { requiredApprovals: 2 }, repositories: { "owner/repo": { autoMerge: true, deploymentWorkflows: ["Deploy"] } } }) };
  assert.deepEqual(lifecyclePolicy(env, "owner/repo"), {
    autoMerge: true, requiredApprovals: 2, deploymentWorkflows: ["Deploy"], maxRecoveryAttempts: 2, mergeMethod: "SQUASH",
  });
  assert.equal(lifecyclePolicy(env, "other/repo").autoMerge, false);
});

test("pull request lifecycle requires a repository-bound task marker", () => {
  const payload = {
    action: "closed",
    repository: { full_name: "owner/repo" },
    pull_request: { number: 7, node_id: "PR_7", html_url: "https://github.com/owner/repo/pull/7", title: "Change", body: "Metis-Task: owner/repo#12", user: { login: "author" }, head: { sha: "head", ref: "work", repo: { full_name: "owner/repo" } }, base: { ref: "main" }, merged: true, merge_commit_sha: "merge" },
  };
  const lifecycle = pullRequestLifecycleFromWebhook("pull_request", payload);
  assert.equal(lifecycle.merge_sha, "merge");
  assert.equal(lifecycle.author_login, "author");
  assert.equal(lifecycle.head_branch, "work");
  assert.equal(pullRequestLifecycleFromWebhook("pull_request", { ...payload, pull_request: { ...payload.pull_request, body: "Metis-Task: other/repo#12" } }), null);
});

test("checks and approvals require completed success and latest reviewer state", () => {
  assert.equal(checksPassed([]), false);
  assert.equal(checksPassed([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }]), true);
  assert.equal(checksPassed([{ status: "completed", conclusion: "failure" }]), false);
  assert.equal(approvalCount([
    { user: { login: "a" }, state: "APPROVED" },
    { user: { login: "a" }, state: "CHANGES_REQUESTED" },
    { user: { login: "b" }, state: "APPROVED" },
  ]), 1);
});

test("workflow completion retains exact deployment SHA", () => {
  const event = workflowRunFromWebhook("workflow_run", { action: "completed", repository: { full_name: "owner/repo" }, workflow_run: { head_sha: "abc", name: "Deploy", conclusion: "failure", html_url: "https://example.test/run" } });
  assert.deepEqual(event, { repository: "owner/repo", head_sha: "abc", workflow_name: "Deploy", conclusion: "failure", workflow_url: "https://example.test/run" });
});
