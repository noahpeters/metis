import test from "node:test";
import assert from "node:assert/strict";
import { blockedCodexFromWebhook, readyIssueFromWebhook } from "../src/index.mjs";

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
    },
    sender: { login: "chatgpt-codex-connector" },
  };
  assert.deepEqual(blockedCodexFromWebhook("issue_comment", payload), {
    repository: "noahpeters/metis-sandbox",
    issue_number: 1,
    question: "Which remote should I use?",
    body: payload.comment.body,
    comment_url: payload.comment.html_url,
  });
  assert.equal(blockedCodexFromWebhook("issue_comment", { ...payload, sender: { login: "someone-else" } }), null);
  assert.equal(blockedCodexFromWebhook("issues", payload), null);
});
