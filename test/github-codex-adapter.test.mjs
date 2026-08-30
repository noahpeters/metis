import test from "node:test";
import assert from "node:assert/strict";
import { buildGithubCodexComment, githubCodexCapabilities } from "../src/github-codex-adapter.mjs";

test("GitHub Codex capability is fail-closed by default", () => {
  assert.deepEqual(githubCodexCapabilities({}), {
    provider: "codex",
    execution: "cloud",
    billing_mode: "included_subscription",
    accepting_tasks: false,
    driver: "github_integration",
  });
  assert.equal(githubCodexCapabilities({ CODEX_GITHUB_INTEGRATION_ENABLED: "true" }).accepting_tasks, true);
});

test("GitHub Codex task comment is idempotently marked and preserves guardrails", () => {
  const body = buildGithubCodexComment({
    repository: "owner/repo",
    issue_number: 7,
    summary: "Fix the retry edge case",
    max_cost_units: 4,
  }, "lease-123");
  assert.match(body, /metis-codex-dispatch:lease-123/);
  assert.match(body, /@codex implement this issue/);
  assert.match(body, /Never merge, deploy, or mutate production/);
  assert.match(body, /BLOCKED:/);
});
