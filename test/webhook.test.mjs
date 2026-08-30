import test from "node:test";
import assert from "node:assert/strict";
import { blockedCodexFromWebhook, pullRequestForTaskFromWebhook, readyForPrCodexFromWebhook, readyIssueFromWebhook, revisionCodexFromWebhook, shouldReauthorPullRequest } from "../src/index.mjs";

test("accepts only a metis:ready issue label event", () => {
  const payload = {
    action: "labeled",
    label: { name: "metis:ready" },
    repository: { full_name: "noahpeters/ftops" },
    issue: { number: 12, node_id: "I_1", title: "Do work", body: "Safely", labels: [{ name: "metis:ready" }, { name: "metis:size-small" }, { name: "metis:max-cost-3" }, { name: "metis:budget-approved" }] },
    sender: { login: "noah" },
  };
  assert.deepEqual(readyIssueFromWebhook("issues", payload), {
    repository: "noahpeters/ftops", issue_number: 12, issue_node_id: "I_1", title: "Do work", body: "Safely", actor: "noah", size_class: "small", max_cost_units: 3, budget_approved: 1,
  });
  assert.equal(readyIssueFromWebhook("issues", { ...payload, label: { name: "bug" } }), null);
  assert.equal(readyIssueFromWebhook("pull_request", payload), null);
});

test("accepts BLOCKED results only from the Codex connector", () => {
  const payload = {
    action: "created",
    repository: { full_name: "noahpeters/metis-sandbox" },
    issue: { number: 1 },
    comment: {
      body: "BLOCKED: Which remote should I use?\n\nDetails",
      html_url: "https://github.com/noahpeters/metis-sandbox/issues/1#issuecomment-1",
      performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
    },
    sender: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
  };
  assert.deepEqual(blockedCodexFromWebhook("issue_comment", payload), {
    repository: "noahpeters/metis-sandbox",
    issue_number: 1,
    question: "Which remote should I use?",
    body: payload.comment.body,
    comment_url: payload.comment.html_url,
  });
  assert.equal(blockedCodexFromWebhook("issue_comment", { ...payload, sender: { login: "someone-else" } }), null);
  assert.equal(blockedCodexFromWebhook("issue_comment", {
    ...payload,
    comment: { ...payload.comment, performed_via_github_app: { id: 999, slug: "chatgpt-codex-connector" } },
  }), null);
  assert.equal(blockedCodexFromWebhook("issues", payload), null);
});

test("accepts ready-for-PR results only from the Codex connector", () => {
  const payload = {
    action: "created",
    repository: { full_name: "noahpeters/metis-sandbox" },
    issue: { number: 4 },
    comment: {
      body: "READY_FOR_PR: Subtraction helper is verified.\n\n[View task →](https://chatgpt.com/s/cd_test)",
      html_url: "https://github.com/noahpeters/metis-sandbox/issues/4#issuecomment-2",
      performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
    },
    sender: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
  };
  assert.deepEqual(readyForPrCodexFromWebhook("issue_comment", payload), {
    repository: "noahpeters/metis-sandbox",
    issue_number: 4,
    summary: "Subtraction helper is verified.",
    body: payload.comment.body,
    comment_url: payload.comment.html_url,
    task_url: "https://chatgpt.com/s/cd_test",
  });
  assert.equal(readyForPrCodexFromWebhook("issue_comment", { ...payload, sender: { login: "someone-else" } }), null);
  assert.equal(readyForPrCodexFromWebhook("issue_comment", {
    ...payload,
    comment: { ...payload.comment, performed_via_github_app: { id: 1144995, slug: "lookalike" } },
  }), null);
});

test("maps a marked pull request to its awaiting Metis task", () => {
  const payload = {
    action: "opened",
    repository: { full_name: "noahpeters/metis-sandbox" },
    pull_request: {
      number: 5,
      html_url: "https://github.com/noahpeters/metis-sandbox/pull/5",
      body: "Summary\n\nMetis-Task: noahpeters/metis-sandbox#4",
    },
  };
  assert.deepEqual(pullRequestForTaskFromWebhook("pull_request", payload), {
    repository: "noahpeters/metis-sandbox",
    issue_number: 4,
    pull_request_url: payload.pull_request.html_url,
    pull_request_number: 5,
  });
  assert.equal(pullRequestForTaskFromWebhook("pull_request", {
    ...payload,
    pull_request: { ...payload.pull_request, body: "Metis-Task: other/repo#4" },
  }), null);
});

test("re-authors only an awaiting same-repository PR not already owned by the App", () => {
  const env = { GITHUB_APP_BOT_LOGIN: "metis-control-plane-noah[bot]" };
  const task = { state: "awaiting_pr_creation" };
  const lifecycle = { action: "opened", repository: "noahpeters/metis-sandbox", author_login: "noahpeters", head_repository: "noahpeters/metis-sandbox", head_branch: "work", base_branch: "main" };
  assert.equal(shouldReauthorPullRequest(env, task, lifecycle), true);
  assert.equal(shouldReauthorPullRequest(env, task, { ...lifecycle, author_login: env.GITHUB_APP_BOT_LOGIN }), false);
  assert.equal(shouldReauthorPullRequest(env, task, { ...lifecycle, head_repository: "fork/repo" }), false);
  assert.equal(shouldReauthorPullRequest(env, { state: "pr_ready" }, lifecycle), false);
});

test("accepts exact revision results only from the official Codex connector", () => {
  const payload = { action: "created", repository: { full_name: "owner/repo" }, comment: { body: `REVISION_READY: ${"b".repeat(40)}\n\nMetis-Task: owner/repo#7`, performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" } }, sender: { login: "chatgpt-codex-connector[bot]", type: "Bot" } };
  assert.deepEqual(revisionCodexFromWebhook("issue_comment", payload), { repository: "owner/repo", issue_number: 7, status: "ready", head_sha: "b".repeat(40), body: payload.comment.body });
  assert.equal(revisionCodexFromWebhook("issue_comment", { ...payload, sender: { login: "lookalike", type: "Bot" } }), null);
  assert.equal(revisionCodexFromWebhook("issue_comment", { ...payload, comment: { ...payload.comment, body: `REVISION_READY: ${"b".repeat(40)}\nMetis-Task: other/repo#7` } }), null);
});
