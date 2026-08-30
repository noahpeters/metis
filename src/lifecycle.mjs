const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function taskMarker(repository, body = "") {
  const marker = body.match(/Metis-Task:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/i);
  if (!marker || marker[1].toLowerCase() !== repository?.toLowerCase()) return null;
  return Number(marker[2]);
}

export function lifecyclePolicy(env, repository) {
  let supplied = {};
  try {
    supplied = JSON.parse(env.METIS_LIFECYCLE_POLICY_JSON || "{}");
  } catch {
    return { autoMerge: false, requiredApprovals: 1, requiredChecks: true, maxRevisionAttempts: 2, deploymentWorkflows: [], maxRecoveryAttempts: 2, mergeMethod: "SQUASH" };
  }
  const defaults = supplied.defaults || {};
  const selected = supplied.repositories?.[repository] || {};
  return {
    requiredApprovals: 1,
    requiredChecks: true,
    maxRevisionAttempts: 2,
    deploymentWorkflows: [],
    maxRecoveryAttempts: 2,
    mergeMethod: "SQUASH",
    ...defaults,
    ...selected,
    autoMerge: selected.autoMerge === true,
  };
}

export function pullRequestLifecycleFromWebhook(event, payload) {
  if (event !== "pull_request" || !["opened", "reopened", "synchronize", "closed"].includes(payload.action)) return null;
  const repository = payload.repository?.full_name;
  const issueNumber = taskMarker(repository, payload.pull_request?.body);
  if (!issueNumber) return null;
  return {
    repository,
    issue_number: issueNumber,
    action: payload.action,
    pull_request_number: payload.pull_request?.number,
    pull_request_node_id: payload.pull_request?.node_id,
    pull_request_url: payload.pull_request?.html_url,
    pull_request_title: payload.pull_request?.title || "",
    pull_request_body: payload.pull_request?.body || "",
    author_login: payload.pull_request?.user?.login || null,
    head_sha: payload.pull_request?.head?.sha,
    head_branch: payload.pull_request?.head?.ref,
    head_repository: payload.pull_request?.head?.repo?.full_name,
    base_branch: payload.pull_request?.base?.ref,
    draft: Boolean(payload.pull_request?.draft),
    merged: Boolean(payload.pull_request?.merged),
    merge_sha: payload.pull_request?.merge_commit_sha || null,
  };
}

export function reviewLifecycleFromWebhook(event, payload) {
  if (event !== "pull_request_review" || payload.action !== "submitted") return null;
  const repository = payload.repository?.full_name;
  const issueNumber = taskMarker(repository, payload.pull_request?.body);
  if (!issueNumber) return null;
  return {
    repository,
    issue_number: issueNumber,
    pull_request_number: payload.pull_request?.number,
    pull_request_node_id: payload.pull_request?.node_id,
    review_state: payload.review?.state?.toLowerCase(),
    reviewed_head_sha: payload.pull_request?.head?.sha,
  };
}

export function checkSuiteLifecycleFromWebhook(event, payload) {
  if (event !== "check_suite" || payload.action !== "completed") return null;
  const pullRequest = payload.check_suite?.pull_requests?.[0];
  if (!pullRequest?.number) return null;
  return {
    repository: payload.repository?.full_name,
    pull_request_number: pullRequest.number,
    head_sha: payload.check_suite?.head_sha,
    conclusion: payload.check_suite?.conclusion,
  };
}

export function workflowRunFromWebhook(event, payload) {
  if (event !== "workflow_run" || payload.action !== "completed") return null;
  return {
    repository: payload.repository?.full_name,
    head_sha: payload.workflow_run?.head_sha,
    workflow_name: payload.workflow_run?.name,
    conclusion: payload.workflow_run?.conclusion,
    workflow_url: payload.workflow_run?.html_url,
  };
}

export function checksPassed(checkRuns) {
  return checkRuns.length > 0
    && checkRuns.every((check) => check.status === "completed" && SUCCESS_CONCLUSIONS.has(check.conclusion));
}

export function approvalCount(reviews) {
  const latestByUser = new Map();
  for (const review of reviews) {
    if (review.user?.login) latestByUser.set(review.user.login, review.state?.toLowerCase());
  }
  return [...latestByUser.values()].filter((state) => state === "approved").length;
}
