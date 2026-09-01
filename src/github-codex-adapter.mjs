import { githubUserRequest, repositoryAllowed } from "./github.mjs";

const MARKER_PREFIX = "metis-codex-dispatch";
const REVISION_MARKER_PREFIX = "metis-codex-revision";

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
    `- Maximum estimated workload units: ${task.max_workload_units}`,
    "- The human-applied `metis:ready` decision is authoritative and supersedes older readiness language, prerequisite questions, and unstructured dependency prose in the issue or comments.",
    "- Metis has already checked GitHub's structured `blocked by` relationships. Do not ask a human to reconfirm, prove, or interpret issue dependencies.",
    "- Assume all human-verifiable prerequisites are satisfied or intentionally waived unless current authoritative evidence proves a concrete hard contradiction.",
    "- Inspect the repository deeply; implement, debug, verify, and substantively review the change.",
    "- Follow the repository's AGENTS.md and .metis.yml instructions.",
    "- Commit the verified change in the cloud task and prepare pull-request title/body metadata.",
    "- Do not run `git push`, use `gh`, or try to create the pull request from the shell. A human will use Codex Cloud's Create PR button.",
    "- When the change is ready for that button, begin the final response with `READY_FOR_PR:`.",
    "- Never merge, deploy, or mutate production systems or data.",
    "- Investigate repository and issue evidence yourself before blocking. Missing proof, uncertainty, stale prose, inferred dependencies, and information you can inspect are not blockers.",
    "- Use `BLOCKED:` only when one currently missing human decision or inaccessible required resource concretely prevents safe implementation; include the exact current evidence after the question.",
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
  let comments;
  try { comments = await githubUserRequest(env, path); }
  catch (error) { error.acceptance = "confirmed_unaccepted"; throw error; }
  const existing = comments.find((item) => item.body?.includes(marker(leaseId)));
  let created = existing;
  if (!created) {
    try {
      created = await githubUserRequest(env, `/repos/${task.repository}/issues/${task.issue_number}/comments`, {
        method: "POST", body: JSON.stringify({ body: buildGithubCodexComment(task, leaseId) }),
      });
    } catch (error) {
      // An HTTP rejection proves GitHub did not create the comment. A transport
      // failure after POST may have delivered it and must never be auto-refunded.
      error.acceptance = error.status ? "confirmed_unaccepted" : "unknown";
      throw error;
    }
  }

  return {
    id: `github-issue-comment:${created.id}`,
    status: "queued",
    driver: "github_user_integration",
    idempotent_replay: Boolean(existing),
  };
}

export function buildGithubCodexRevisionComment(task, revision, leaseId) {
  if (!task?.repository || !task?.pull_request_number || !revision?.baseHeadSha || !leaseId) throw new Error("Codex revision dispatch is incomplete");
  const feedback = revision.feedback.map((item) => `- ${item.path ? `${item.path}${item.line ? `:${item.line}` : ""}: ` : ""}${item.body}`).join("\n");
  return [
    `<!-- ${REVISION_MARKER_PREFIX}:${leaseId} -->`,
    `@codex revise the implementation from pull request #${task.pull_request_number} and prepare a replacement pull request.`,
    "",
    `Exact starting head SHA: \`${revision.baseHeadSha}\``,
    `Metis-Task: ${task.repository}#${task.issue_number}`,
    "",
    "Requested changes:",
    feedback || "- Re-read the submitted CHANGES_REQUESTED review and address every unresolved thread.",
    "",
    "Revision guardrails:",
    `- Inspect pull request #${task.pull_request_number} at the exact starting SHA and preserve its intended functionality except where review feedback requires changes.`,
    "- Re-read the current diff and all unresolved review threads before editing.",
    "- Implement the smallest coherent correction, run the relevant tests, and commit the verified replacement change.",
    "- Do not run `git push`, use `gh`, or create the pull request from the shell. A human will use Codex Cloud's Create PR button.",
    "- Never merge, deploy, push to the default branch, or mutate production systems or data.",
    `- Finish with \`READY_FOR_PR:\` and include \`Metis-Task: ${task.repository}#${task.issue_number}\` in the prepared PR body.`,
    "- If a decision is missing, finish with `REVISION_BLOCKED:` followed by one concrete question and the same Metis-Task marker.",
  ].join("\n");
}

export async function dispatchViaGithubCodexRevision(env, task, revision, leaseId) {
  const capabilities = githubCodexCapabilities(env);
  if (!capabilities.accepting_tasks) throw new Error("GitHub Codex integration is disabled");
  if (!repositoryAllowed(env, task.repository)) throw new Error("Repository is not allowlisted for Codex revision dispatch");
  const path = `/repos/${task.repository}/issues/${task.issue_number}/comments?per_page=100`;
  const comments = await githubUserRequest(env, path);
  const marker = `<!-- ${REVISION_MARKER_PREFIX}:${leaseId} -->`;
  const existing = comments.find((item) => item.body?.includes(marker));
  const created = existing || await githubUserRequest(env, `/repos/${task.repository}/issues/${task.issue_number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: buildGithubCodexRevisionComment(task, revision, leaseId) }),
  });
  return { id: `github-issue-comment:${created.id}`, status: "queued", idempotent_replay: Boolean(existing) };
}
