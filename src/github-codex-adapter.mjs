import { githubUserRequest, repositoryAllowed } from "./github.mjs";

const MARKER_PREFIX = "metis-codex-dispatch";

export function githubCodexCapabilities(env) {
  return {
    provider: "codex",
    execution: "cloud",
    billing_mode: "included_subscription",
    accepting_tasks: env.CODEX_GITHUB_INTEGRATION_ENABLED === "true" && Boolean(env.GITHUB_DISPATCH_USER_TOKEN),
    driver: "github_user_integration",
  };
}

export function buildGithubCodexComment(task, leaseId) {
  if (!task?.repository || !Number.isInteger(task.issue_number) || !task.summary || !leaseId) {
    throw new Error("GitHub Codex dispatch requires a repository, issue, summary, and lease");
  }
  return [
    `<!-- ${MARKER_PREFIX}:${leaseId} -->`,
    "@codex implement this issue and prepare the completed change for the Codex Cloud Create PR handoff.",
    "",
    `Metis summary: ${task.summary}`,
    `Repository remote: https://github.com/${task.repository}.git`,
    "Pull-request base branch: `main`",
    `Required pull-request body marker: \`Metis-Task: ${task.repository}#${task.issue_number}\``,
    "",
    "Execution guardrails:",
    `- Maximum normalized cost units: ${task.max_cost_units}`,
    "- Inspect the repository deeply; implement, debug, verify, and substantively review the change.",
    "- Follow the repository's AGENTS.md and .metis.yml instructions.",
    "- Commit the verified change in the cloud task and prepare pull-request title/body metadata.",
    "- Do not run `git push`, use `gh`, or try to create the pull request from the shell. A human will use Codex Cloud's Create PR button.",
    "- When the change is ready for that button, begin the final response with `READY_FOR_PR:`.",
    "- Never merge, deploy, or mutate production systems or data.",
    "- If information or a decision is missing, stop and respond with `BLOCKED:` followed by one concrete question.",
  ].join("\n");
}

function marker(leaseId) {
  return `<!-- ${MARKER_PREFIX}:${leaseId} -->`;
}

export async function dispatchViaGithubCodex(env, task, leaseId) {
  const capabilities = githubCodexCapabilities(env);
  if (!capabilities.accepting_tasks) throw new Error("GitHub Codex integration is disabled");
  if (!repositoryAllowed(env, task.repository)) throw new Error("Repository is not allowlisted for Codex dispatch");

  const path = `/repos/${task.repository}/issues/${task.issue_number}/comments?per_page=100`;
  const comments = await githubUserRequest(env, path);
  const existing = comments.find((item) => item.body?.includes(marker(leaseId)));
  const created = existing || await githubUserRequest(env, `/repos/${task.repository}/issues/${task.issue_number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: buildGithubCodexComment(task, leaseId) }),
  });

  return {
    id: `github-issue-comment:${created.id}`,
    status: "queued",
    driver: "github_user_integration",
    idempotent_replay: Boolean(existing),
  };
}
