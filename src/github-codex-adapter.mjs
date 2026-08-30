import { comment, githubRequest, repositoryAllowed } from "./github.mjs";

const MARKER_PREFIX = "metis-codex-dispatch";

export function githubCodexCapabilities(env) {
  return {
    provider: "codex",
    execution: "cloud",
    billing_mode: "included_subscription",
    accepting_tasks: env.CODEX_GITHUB_INTEGRATION_ENABLED === "true",
    driver: "github_integration",
  };
}

export function buildGithubCodexComment(task, leaseId) {
  if (!task?.repository || !Number.isInteger(task.issue_number) || !task.summary || !leaseId) {
    throw new Error("GitHub Codex dispatch requires a repository, issue, summary, and lease");
  }
  return [
    `<!-- ${MARKER_PREFIX}:${leaseId} -->`,
    "@codex implement this issue and open a pull request.",
    "",
    `Metis summary: ${task.summary}`,
    "",
    "Execution guardrails:",
    `- Maximum normalized cost units: ${task.max_cost_units}`,
    "- Inspect the repository deeply; implement, debug, verify, and substantively review the change.",
    "- Follow the repository's AGENTS.md and .metis.yml instructions.",
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
  const comments = await githubRequest(env, path);
  const existing = comments.find((item) => item.body?.includes(marker(leaseId)));
  const created = existing || await comment(env, task.repository, task.issue_number, buildGithubCodexComment(task, leaseId));

  return {
    id: `github-issue-comment:${created.id}`,
    status: "queued",
    driver: "github_integration",
    idempotent_replay: Boolean(existing),
  };
}
