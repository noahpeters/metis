import { analyzeIssue } from "./ai.mjs";
import { buildIntakeInvestigation, discussionMetadata, fetchIssueDiscussion } from "./intake-context.mjs";
import { blockTask, comment, githubRequest, repositoryAllowed, setState, unresolvedReviewThreadCount } from "./github.mjs";
import { admissionDecision, claimRevision, claimTask, pruneSchedulerSignals, recordSchedulerDeferral } from "./scheduler.mjs";
import { dispatchCodexTask } from "./codex-dispatch.mjs";
import { dispatchViaGithubCodexRevision } from "./github-codex-adapter.mjs";
import { approvalCount, checksPassed, checkSuiteLifecycleFromWebhook, lifecyclePolicy, pullRequestLifecycleFromWebhook, reviewLifecycleFromWebhook, workflowRunFromWebhook } from "./lifecycle.mjs";
import { reconcileProject } from "./project.mjs";
import { dependencyDecision, recordDependencyEvent } from "./dependencies.mjs";
import { capacityObservationStatements } from "./provider-capacity.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function resumeReadyBacklog(env) {
  try {
    return await reconcileProject(env);
  } catch (error) {
    // Admission fails closed when the authoritative Project cannot be read.
    console.error("Project admission paused", { error: String(error) });
    return null;
  }
}

async function verifySignature(secret, signature, body) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = signature.slice(7).match(/.{2}/g)?.map((hex) => parseInt(hex, 16));
  return bytes ? crypto.subtle.verify("HMAC", key, new Uint8Array(bytes), new TextEncoder().encode(body)) : false;
}

function isOfficialCodexConnector(payload) {
  return payload.sender?.login === "chatgpt-codex-connector[bot]"
    && payload.sender?.type === "Bot"
    && payload.comment?.performed_via_github_app?.id === 1144995
    && payload.comment?.performed_via_github_app?.slug === "chatgpt-codex-connector";
}

const CODEX_TASK_URL = /https:\/\/chatgpt\.com\/(?:s\/[^)\s]+|codex\/cloud\/tasks\/[^)\s]+)/;

function suppliedResetTime(body) {
  const match = body.match(/(?:reset(?:s|ting)?|try again|available again)(?:\s+(?:at|after|on|in))?\s*[:\-]?\s*(\d{10,13}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)/i);
  if (!match) return null;
  if (/^\d+$/.test(match[1])) return Math.floor(Number(match[1]) / (match[1].length === 13 ? 1000 : 1));
  const milliseconds = Date.parse(match[1]);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : null;
}

// The GitHub connector does not currently provide a machine-readable callback
// when it accepts (or rejects) an @codex mention. Keep this deliberately narrow:
// only the official App is trusted and acceptance requires a stable task link.
export function connectorAcknowledgmentFromWebhook(event, payload) {
  if (event !== "issue_comment" || payload.action !== "created" || !isOfficialCodexConnector(payload)) return null;
  const body = payload.comment?.body || "";
  if (/^(?:READY_FOR_PR:|REVISION_READY:|REVISION_BLOCKED:)/.test(body)) return null;
  const taskUrl = body.match(CODEX_TASK_URL)?.[0] || null;
  const setupUrl = body.match(/https:\/\/(?:help\.openai\.com|chatgpt\.com|platform\.openai\.com)\/[^)\s]+/)?.[0] || null;
  const environmentRequired = /(?:create|configure|set up|select|requires?|need(?:s|ed)?)\s+(?:an?\s+)?(?:codex\s+)?environment|environment\s+(?:is\s+)?(?:required|not (?:configured|found|available))/i.test(body);
  const integrationFailure = environmentRequired || /(?:permission|authorization|installation|integration|configuration|credential).{0,40}(?:required|missing|invalid|denied|disabled|not (?:configured|installed|authorized))/i.test(body);
  const exhausted = /(?:usage|capacity|rate|task|plan|workspace)?\s*(?:limit|quota|allowance)\s+(?:has been |is )?(?:reached|exceeded|exhausted)|(?:out of|no)\s+(?:remaining\s+)?(?:credits|capacity)|too many requests/i.test(body);
  const rejected = integrationFailure || exhausted || /(?:could(?:n't| not)|unable to|can't|cannot|failed to)\s+(?:create|start|launch|run|accept)|request\s+(?:was\s+)?rejected/i.test(body);
  const marker = body.match(/metis-codex-dispatch:([A-Za-z0-9-]+)/)?.[1] || null;
  const acknowledgment = /(?:codex|task|request|dispatch)/i.test(body) && /(?:mention|received|processing|accept|reject|unable|cannot|can't|couldn't|failed|limit|quota|capacity)/i.test(body);
  if (!taskUrl && !rejected && !body.startsWith("BLOCKED:") && !marker && !acknowledgment) return null;
  const observedAt = payload.comment?.created_at ? Math.floor(Date.parse(payload.comment.created_at) / 1000) : Math.floor(Date.now() / 1000);
  const capacityOutcome = taskUrl ? "accepted" : exhausted ? "exhausted" : integrationFailure ? "unavailable" : rejected ? "rejected" : "unknown";
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    status: taskUrl ? "accepted" : rejected ? "rejected" : "unknown",
    capacity_outcome: capacityOutcome,
    observed_at: observedAt,
    reset_at: exhausted ? suppliedResetTime(body) : null,
    limit_reason: exhausted ? body.split("\n", 1)[0].slice(0, 240) : null,
    lease_id: marker,
    task_url: taskUrl,
    setup_url: environmentRequired ? setupUrl : null,
    reason: (environmentRequired
      ? "Codex requires a configured cloud environment before it can create this task."
      : body.split("\n", 1)[0].replace(/^BLOCKED:\s*/, "") || "The Codex connector rejected the task before creation.").slice(0, 240),
    comment_url: payload.comment?.html_url || null,
    comment_id: payload.comment?.id ? String(payload.comment.id) : null,
  };
}

export function blockedCodexFromWebhook(event, payload) {
  const body = payload.comment?.body || "";
  if (
    event !== "issue_comment"
    || payload.action !== "created"
    || !isOfficialCodexConnector(payload)
    || !body.startsWith("BLOCKED:")
  ) return null;
  const question = body.split("\n", 1)[0].slice("BLOCKED:".length).trim();
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    question: question || "Codex reported a blocker without a question.",
    body,
    comment_url: payload.comment?.html_url || null,
  };
}

export function readyForPrCodexFromWebhook(event, payload) {
  const body = payload.comment?.body || "";
  if (
    event !== "issue_comment"
    || payload.action !== "created"
    || !isOfficialCodexConnector(payload)
    || !body.startsWith("READY_FOR_PR:")
  ) return null;
  const taskUrl = body.match(CODEX_TASK_URL)?.[0] || null;
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    summary: body.split("\n", 1)[0].slice("READY_FOR_PR:".length).trim() || "Codex prepared a change for PR creation.",
    body,
    comment_url: payload.comment?.html_url || null,
    task_url: taskUrl,
  };
}

export function revisionCodexFromWebhook(event, payload) {
  const body = payload.comment?.body || "";
  if (event !== "issue_comment" || payload.action !== "created" || !isOfficialCodexConnector(payload)) return null;
  const marker = body.match(/Metis-Task:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/i);
  if (!marker || marker[1].toLowerCase() !== payload.repository?.full_name?.toLowerCase()) return null;
  if (body.includes("REVISION_BLOCKED:")) {
    return { repository: marker[1], issue_number: Number(marker[2]), status: "blocked", question: body.split("REVISION_BLOCKED:")[1].split("\n", 1)[0].trim(), body };
  }
  const ready = body.match(/REVISION_READY:\s*([0-9a-f]{40})/i);
  return ready ? { repository: marker[1], issue_number: Number(marker[2]), status: "ready", head_sha: ready[1].toLowerCase(), body } : null;
}

export function unmarkedRevisionPullRequestFromWebhook(event, payload) {
  const pr = payload.pull_request;
  if (event !== "pull_request" || !["opened", "reopened"].includes(payload.action) || !pr || /Metis-Task:/i.test(pr.body || "")) return null;
  if (pr.user?.type === "Bot" || pr.head?.repo?.full_name !== payload.repository?.full_name || !pr.head?.ref?.startsWith("codex/")) return null;
  if (!(pr.body || "").includes("chatgpt.com/codex/cloud/tasks/")) return null;
  return {
    repository: payload.repository.full_name,
    action: payload.action,
    pull_request_number: pr.number,
    pull_request_node_id: pr.node_id,
    pull_request_url: pr.html_url,
    pull_request_title: pr.title || "",
    pull_request_body: pr.body || "",
    author_login: pr.user?.login || null,
    head_sha: pr.head?.sha,
    head_branch: pr.head?.ref,
    head_repository: pr.head?.repo?.full_name,
    base_branch: pr.base?.ref,
    draft: Boolean(pr.draft),
    merged: false,
    merge_sha: null,
  };
}

export function pullRequestForTaskFromWebhook(event, payload) {
  const lifecycle = pullRequestLifecycleFromWebhook(event, payload);
  if (!lifecycle || !["opened", "reopened"].includes(lifecycle.action)) return null;
  return {
    repository: lifecycle.repository,
    issue_number: lifecycle.issue_number,
    pull_request_url: lifecycle.pull_request_url,
    pull_request_number: lifecycle.pull_request_number,
  };
}

async function taskForPullRequest(env, repository, pullRequestNumber) {
  return env.DB.prepare("SELECT * FROM tasks WHERE repository=? AND pull_request_number=? ORDER BY updated_at DESC LIMIT 1")
    .bind(repository, pullRequestNumber).first();
}

async function evaluateMergeReadiness(env, task, lifecycle) {
  const policy = lifecyclePolicy(env, task.repository);
  const health = await env.DB.prepare("SELECT state FROM repository_health WHERE repository=?").bind(task.repository).first();
  if (health && health.state !== "healthy" && !task.is_recovery) return { ready: false, reason: "repository recovery lock active" };
  if (task.state === "merge_ready") return { ready: true, reason: "already ready for human merge" };
  const pullRequest = await githubRequest(env, `/repos/${task.repository}/pulls/${lifecycle.pull_request_number}`);
  if (pullRequest.draft || pullRequest.state !== "open" || pullRequest.base?.ref !== pullRequest.base?.repo?.default_branch) {
    return { ready: false, reason: "pull request is not an open, non-draft change to the default branch" };
  }
  const [checks, reviews, unresolvedThreads] = await Promise.all([
    githubRequest(env, `/repos/${task.repository}/commits/${pullRequest.head.sha}/check-runs?per_page=100`),
    githubRequest(env, `/repos/${task.repository}/pulls/${lifecycle.pull_request_number}/reviews?per_page=100`),
    unresolvedReviewThreadCount(env, task.repository, lifecycle.pull_request_number),
  ]);
  const checksReady = !policy.requiredChecks || checksPassed(checks.check_runs || []);
  const approvalsReady = approvalCount(reviews || []) >= policy.requiredApprovals;
  if (!checksReady || !approvalsReady || unresolvedThreads > 0 || pullRequest.mergeable !== true) {
    await env.DB.prepare("UPDATE tasks SET state='reviewing', updated_at=unixepoch() WHERE id=? AND state IN ('pr_ready','reviewing','merge_ready')").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:reviewing");
    return { ready: false, reason: `waiting for checks, approvals, resolved threads, or mergeability (${checksReady}/${approvalsReady}/${unresolvedThreads}/${pullRequest.mergeable})` };
  }
  await env.DB.prepare("UPDATE tasks SET state='merge_ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
  await setState(env, task.repository, task.issue_number, "metis:merge-ready");
  await comment(env, task.repository, task.issue_number, "## Metis is ready for human merge\n\nRequired checks, approvals, resolved review threads, mergeability, and repository health passed. A human may now merge the pull request. Metis will not merge it; after the human merge, Metis will monitor the exact merge SHA through deployment.");
  return { ready: true };
}

async function handleRevisionDispatch(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(message.taskId).first();
  if (!task || task.state !== "reviewing" || !task.pull_request_number) return;
  const policy = lifecyclePolicy(env, task.repository);
  const attempts = await env.DB.prepare("SELECT COUNT(*) AS count FROM revision_dispatches WHERE task_id=?").bind(task.id).first();
  if ((attempts?.count || 0) >= policy.maxRevisionAttempts) {
    await env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason='Review revision retry limit reached.',updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    return blockTask(env, task, "Codex exhausted the configured review-revision limit.", "Should Metis authorize another revision attempt or should a human take over?");
  }
  const pullRequest = await githubRequest(env, `/repos/${task.repository}/pulls/${task.pull_request_number}`);
  const existing = await env.DB.prepare("SELECT id FROM revision_dispatches WHERE task_id=? AND base_head_sha=?").bind(task.id, pullRequest.head.sha).first();
  if (existing) return;
  const decision = await admissionDecision(env, task);
  if (!decision.admitted) {
    if (decision.defer) {
      if (decision.scheduler) await recordSchedulerDeferral(env, decision);
      return;
    }
    await env.DB.prepare("UPDATE tasks SET state='budget_blocked',blocker_reason=?,updated_at=unixepoch() WHERE id=?").bind(decision.reason, task.id).run();
    return blockTask(env, task, decision.reason, "Should this revision receive the required task-specific approval?", true);
  }
  const comments = await githubRequest(env, `/repos/${task.repository}/pulls/${task.pull_request_number}/comments?per_page=100`);
  const feedback = comments.map((item) => ({ id: item.id, path: item.path, line: item.line || item.original_line, body: item.body, url: item.html_url }));
  const leaseId = await claimRevision(env, task, decision);
  try {
    const dispatched = await dispatchViaGithubCodexRevision(env, task, { baseHeadSha: pullRequest.head.sha, feedback }, leaseId);
    await env.DB.prepare("INSERT INTO revision_dispatches(task_id,pull_request_number,base_head_sha,lease_id,external_id,state,feedback_json,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,unixepoch(),unixepoch())")
      .bind(task.id, task.pull_request_number, pullRequest.head.sha, leaseId, dispatched.id, JSON.stringify(feedback)).run();
    await setState(env, task.repository, task.issue_number, "metis:revising");
    await comment(env, task.repository, task.issue_number, `## Metis dispatched a review revision\n\nCodex is addressing ${feedback.length} review comment(s) against exact head \`${pullRequest.head.sha}\`. The pull request remains blocked pending a new commit and renewed human approval.`);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id),
      env.DB.prepare("UPDATE pacing_windows SET estimated_workload_units_used=MAX(0,estimated_workload_units_used-?),tasks_started=MAX(0,tasks_started-1) WHERE window_key=date('now')").bind(decision.estimatedWorkloadUnits),
      env.DB.prepare("UPDATE tasks SET state=?,attempt_count=MAX(0,attempt_count-1),blocker_reason=?,updated_at=unixepoch() WHERE id=?")
        .bind([401, 403].includes(error.status) ? "blocked" : "reviewing", [401, 403].includes(error.status) ? "GitHub revision dispatch credential lacks pull-request comment permission." : null, task.id),
    ]);
    if ([401, 403].includes(error.status)) {
      await setState(env, task.repository, task.issue_number, "metis:blocked");
      await comment(env, task.repository, task.issue_number, "## Metis blocked the review revision\n\nThe GitHub user credential used to invoke Codex cannot comment on pull requests. Grant that credential Pull requests read/write access, update `GITHUB_DISPATCH_USER_TOKEN`, then submit the requested-changes review again. No revision capacity remains charged.");
      return;
    }
    throw error;
  }
}

async function completeRevision(env, task, revision, headSha, result = {}) {
  await env.DB.batch([
    env.DB.prepare("UPDATE revision_dispatches SET state='completed',result_json=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify({ ...result, head_sha: headSha }), revision.id),
    env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id),
    env.DB.prepare("UPDATE tasks SET state='reviewing',blocker_reason=NULL,updated_at=unixepoch() WHERE id=?").bind(task.id),
    env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES(?,'codex_included','review_revision',0,?,unixepoch())").bind(task.id, JSON.stringify({ base_head_sha: revision.base_head_sha, head_sha: headSha })),
  ]);
  await setState(env, task.repository, task.issue_number, "metis:reviewing");
  await comment(env, task.repository, task.issue_number, `## Metis received the revised PR head\n\nCodex updated the pull request from \`${revision.base_head_sha}\` to \`${headSha}\`. Human re-review and resolution of every review thread are still required.`);
}

async function beginRecovery(env, task, workflow) {
  const policy = lifecyclePolicy(env, task.repository);
  const health = await env.DB.prepare("SELECT recovery_attempts FROM repository_health WHERE repository=?").bind(task.repository).first();
  const attempts = (health?.recovery_attempts || 0) + 1;
  if (attempts > policy.maxRecoveryAttempts) {
    await env.DB.prepare("UPDATE repository_health SET state='recovery_blocked', workflow_url=?, recovery_attempts=?, updated_at=unixepoch() WHERE repository=?")
      .bind(workflow.workflow_url, attempts, task.repository).run();
    await env.DB.prepare("UPDATE tasks SET state='recovery_blocked', blocker_reason='Automated deployment recovery retry limit reached.', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:recovery-blocked");
    await comment(env, task.repository, task.issue_number, `## Deployment recovery is blocked\n\n[The deployment workflow](${workflow.workflow_url}) failed after ${policy.maxRecoveryAttempts} automated recovery attempt(s). Normal work remains frozen until a human diagnoses the infrastructure or authorizes another recovery attempt.`);
    return;
  }
  await env.DB.prepare("INSERT INTO repository_health (repository,state,blocking_sha,workflow_url,root_task_id,recovery_attempts,updated_at) VALUES (?, 'recovery', ?, ?, ?, ?, unixepoch()) ON CONFLICT(repository) DO UPDATE SET state='recovery', blocking_sha=excluded.blocking_sha, workflow_url=excluded.workflow_url, root_task_id=COALESCE(repository_health.root_task_id,excluded.root_task_id), recovery_attempts=excluded.recovery_attempts, updated_at=unixepoch()")
    .bind(task.repository, workflow.head_sha, workflow.workflow_url, task.id, attempts).run();
  await env.DB.prepare("UPDATE tasks SET state='recovery', blocker_reason=?, updated_at=unixepoch() WHERE id=?")
    .bind(`Deployment workflow ${workflow.workflow_name} failed for ${workflow.head_sha}.`, task.id).run();
  await setState(env, task.repository, task.issue_number, "metis:recovery");

  const existing = await env.DB.prepare("SELECT id FROM tasks WHERE repository=? AND recovery_for_sha=?").bind(task.repository, workflow.head_sha).first();
  if (existing) return;
  const issue = await githubRequest(env, `/repos/${task.repository}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: `[Metis recovery] Restore main deployment for ${workflow.head_sha.slice(0, 12)}`,
      body: [
        `The required deployment workflow **${workflow.workflow_name}** failed for main commit \`${workflow.head_sha}\`.`,
        "",
        `Failure: ${workflow.workflow_url}`,
        "",
        "Diagnose the exact workflow failure and any merge-related side effects. Prepare the smallest corrective pull request. Do not bypass checks, push directly to main, merge, or deploy manually.",
        "",
        `Metis-Recovery: ${task.repository}@${workflow.head_sha}`,
      ].join("\n"),
      labels: ["metis:planning", "metis:size-unknown", "metis:budget-approved"],
    }),
  });
  const recoveryId = `${task.repository}#${issue.number}`;
  await env.DB.prepare("INSERT INTO tasks (id,repository,issue_number,issue_node_id,title,body,state,actor,size_class,budget_approved,priority_score,is_recovery,recovery_for_sha,created_at,updated_at) VALUES (?,?,?,?,?,?,'intake','metis-recovery','unknown',1,100000,1,?,unixepoch(),unixepoch())")
    .bind(recoveryId, task.repository, issue.number, issue.node_id, issue.title, issue.body, workflow.head_sha).run();
  await env.DISPATCH_QUEUE.send({ type: "intake", taskId: recoveryId });
  await comment(env, task.repository, task.issue_number, `## Metis activated deployment recovery\n\nNormal coding dispatch is frozen for this repository. Recovery issue #${issue.number} has priority and will produce a corrective pull request within the configured retry and budget limits.`);
}

async function handleWorkflowCompletion(env, workflow) {
  const health = await env.DB.prepare("SELECT * FROM repository_health WHERE repository=? AND blocking_sha=?").bind(workflow.repository, workflow.head_sha).first();
  if (!health || health.state !== "deploying") return { accepted: false, reason: "workflow is not for the active deployment SHA" };
  const policy = lifecyclePolicy(env, workflow.repository);
  if (!policy.deploymentWorkflows.includes(workflow.workflow_name)) return { accepted: false, reason: "workflow is not required by lifecycle policy" };
  await env.DB.prepare("INSERT INTO deployment_runs (repository,head_sha,workflow_name,conclusion,workflow_url,updated_at) VALUES (?,?,?,?,?,unixepoch()) ON CONFLICT(repository,head_sha,workflow_name) DO UPDATE SET conclusion=excluded.conclusion, workflow_url=excluded.workflow_url, updated_at=unixepoch()")
    .bind(workflow.repository, workflow.head_sha, workflow.workflow_name, workflow.conclusion, workflow.workflow_url).run();
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE repository=? AND merge_sha=? ORDER BY updated_at DESC LIMIT 1").bind(workflow.repository, workflow.head_sha).first();
  if (!task) return { accepted: false, reason: "no task for deployment SHA" };
  if (!["success", "neutral", "skipped"].includes(workflow.conclusion)) {
    await beginRecovery(env, task, workflow);
    return { accepted: true, state: "recovery", task_id: task.id };
  }
  const runs = await env.DB.prepare("SELECT workflow_name,conclusion FROM deployment_runs WHERE repository=? AND head_sha=?").bind(workflow.repository, workflow.head_sha).all();
  const byName = new Map(runs.results.map((run) => [run.workflow_name, run.conclusion]));
  if (!policy.deploymentWorkflows.every((name) => ["success", "neutral", "skipped"].includes(byName.get(name)))) {
    return { accepted: true, state: "deploying", task_id: task.id };
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE repository_health SET state='healthy', blocking_sha=NULL, workflow_url=NULL, recovery_attempts=0, updated_at=unixepoch() WHERE repository=?").bind(workflow.repository),
    env.DB.prepare("UPDATE tasks SET state='complete', blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(task.id),
  ]);
  await setState(env, task.repository, task.issue_number, "metis:complete");
  await comment(env, task.repository, task.issue_number, `## Metis verified deployment\n\nAll required deployment workflows succeeded for merge commit \`${workflow.head_sha}\`. Repository health is restored and normal dispatch may resume.`);
  if (health.root_task_id && health.root_task_id !== task.id) {
    const rootTask = await env.DB.prepare("SELECT id,issue_number FROM tasks WHERE id=?").bind(health.root_task_id).first();
    if (rootTask) {
      await env.DB.prepare("UPDATE tasks SET state='complete', blocker_reason=NULL, updated_at=unixepoch() WHERE id=? AND state='recovery'").bind(rootTask.id).run();
      await setState(env, workflow.repository, rootTask.issue_number, "metis:complete");
      await comment(env, workflow.repository, rootTask.issue_number, `## Metis verified corrective deployment\n\nThe bounded recovery chain succeeded at \`${workflow.head_sha}\`. Repository health is restored.`);
    }
  }
  return { accepted: true, state: "complete", task_id: task.id };
}

async function receiveWebhook(request, env) {
  const body = await request.text();
  if (!await verifySignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("x-hub-signature-256"), body)) return json({ error: "invalid signature" }, 401);
  const delivery = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (event === "ping") return json({ ok: true });
  const payload = JSON.parse(body);
  // Project reconciliation is the sole normal admission path. Lifecycle label
  // webhooks remain useful visibility signals but can never create a task.
  const task = null;
  const blocked = blockedCodexFromWebhook(event, payload);
  const readyForPr = readyForPrCodexFromWebhook(event, payload);
  const connectorAck = connectorAcknowledgmentFromWebhook(event, payload);
  const revisionResult = revisionCodexFromWebhook(event, payload);
  const pullRequest = pullRequestForTaskFromWebhook(event, payload);
  let pullRequestLifecycle = pullRequestLifecycleFromWebhook(event, payload);
  const unmarkedRevisionPr = unmarkedRevisionPullRequestFromWebhook(event, payload);
  const reviewLifecycle = reviewLifecycleFromWebhook(event, payload);
  const checkSuiteLifecycle = checkSuiteLifecycleFromWebhook(event, payload);
  const workflowRun = workflowRunFromWebhook(event, payload);
  if (!task && !blocked && !readyForPr && !connectorAck && !revisionResult && !pullRequest && !pullRequestLifecycle && !unmarkedRevisionPr && !reviewLifecycle && !checkSuiteLifecycle && !workflowRun) return json({ accepted: false }, 202);
  const repository = task?.repository || blocked?.repository || readyForPr?.repository || connectorAck?.repository || revisionResult?.repository || pullRequest?.repository || pullRequestLifecycle?.repository || unmarkedRevisionPr?.repository || reviewLifecycle?.repository || checkSuiteLifecycle?.repository || workflowRun?.repository;
  if (!repositoryAllowed(env, repository)) return json({ error: "repository not allowed" }, 403);
  try {
    await env.DB.prepare("INSERT INTO webhook_deliveries (delivery_id, event_name, received_at) VALUES (?, ?, unixepoch())").bind(delivery, event).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ accepted: true, duplicate: true }, 202);
    throw error;
  }
  if (!pullRequestLifecycle && unmarkedRevisionPr) {
    const candidates = await env.DB.prepare("SELECT t.id,t.issue_number FROM tasks t JOIN revision_dispatches r ON r.task_id=t.id AND r.state='awaiting_pr_creation' WHERE t.repository=? AND t.state='awaiting_revision_pr' AND r.updated_at >= unixepoch()-7200").bind(unmarkedRevisionPr.repository).all();
    if (candidates.results.length !== 1) return json({ accepted: false, reason: "unmarked revision PR is ambiguous or has no active revision" }, 202);
    pullRequestLifecycle = { ...unmarkedRevisionPr, issue_number: candidates.results[0].issue_number };
  }
  if (workflowRun) {
    const result = await handleWorkflowCompletion(env, workflowRun);
    if (result.state === "complete") await resumeReadyBacklog(env);
    return json(result, 202);
  }
  if (revisionResult) {
    const id = `${revisionResult.repository}#${revisionResult.issue_number}`;
    const taskForRevision = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    const revision = await env.DB.prepare("SELECT * FROM revision_dispatches WHERE task_id=? AND state='running' ORDER BY id DESC LIMIT 1").bind(id).first();
    if (!taskForRevision || !revision) return json({ accepted: false, reason: "no active revision" }, 202);
    if (revisionResult.status === "blocked") {
      await env.DB.batch([
        env.DB.prepare("UPDATE revision_dispatches SET state='blocked',result_json=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify(revisionResult), revision.id),
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
        env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason=?,updated_at=unixepoch() WHERE id=?").bind(revisionResult.question || "Codex blocked during review revision.", id),
      ]);
      await setState(env, taskForRevision.repository, taskForRevision.issue_number, "metis:blocked");
      await resumeReadyBacklog(env);
      return json({ accepted: true, task_id: id, state: "blocked" }, 202);
    }
    const currentPr = await githubRequest(env, `/repos/${taskForRevision.repository}/pulls/${taskForRevision.pull_request_number}`);
    if (currentPr.head.sha === revision.base_head_sha || currentPr.head.sha.toLowerCase() !== revisionResult.head_sha) {
      return json({ accepted: false, reason: "revision result does not match the current changed PR head" }, 202);
    }
    await completeRevision(env, taskForRevision, revision, currentPr.head.sha, revisionResult);
    await resumeReadyBacklog(env);
    return json({ accepted: true, task_id: id, state: "reviewing", head_sha: currentPr.head.sha }, 202);
  }
  if (pullRequestLifecycle) {
    const id = `${pullRequestLifecycle.repository}#${pullRequestLifecycle.issue_number}`;
    const existing = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    if (!existing) return json({ accepted: false, reason: "unknown task" }, 202);
    const replacingReviewedPr = ["opened", "reopened"].includes(pullRequestLifecycle.action) && existing.state === "awaiting_revision_pr" && existing.pull_request_number && existing.pull_request_number !== pullRequestLifecycle.pull_request_number;
    if (existing.pull_request_number && existing.pull_request_number !== pullRequestLifecycle.pull_request_number && !replacingReviewedPr) {
      return json({ accepted: false, reason: "task is already bound to another pull request" }, 202);
    }
    if (replacingReviewedPr) {
      await githubRequest(env, `/repos/${existing.repository}/pulls/${existing.pull_request_number}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
      await comment(env, existing.repository, existing.issue_number, `## Metis superseded pull request #${existing.pull_request_number}\n\nCodex prepared a replacement revision. The superseded PR was closed without merging, and Metis bound the replacement for fresh human review.`);
      existing.pull_request_number = null;
    }
    if (["opened", "reopened"].includes(pullRequestLifecycle.action)
      && !["awaiting_pr_creation", "awaiting_revision_pr", "pr_ready", "reviewing", "merge_ready", "merging"].includes(existing.state)) {
      return json({ accepted: false, reason: "task is not in a pull-request lifecycle state" }, 202);
    }
    if (["synchronize", "closed"].includes(pullRequestLifecycle.action) && !existing.pull_request_number) {
      return json({ accepted: false, reason: "task is not bound to this pull request" }, 202);
    }
    if (pullRequestLifecycle.action === "closed") {
      if (!pullRequestLifecycle.merged || !pullRequestLifecycle.merge_sha) {
        await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason='Pull request closed without merging.', updated_at=unixepoch() WHERE id=?").bind(id).run();
        await setState(env, existing.repository, existing.issue_number, "metis:blocked");
        return json({ accepted: true, task_id: id, state: "blocked" }, 202);
      }
      const policy = lifecyclePolicy(env, existing.repository);
      if (!policy.deploymentWorkflows.length) {
        await env.DB.prepare("UPDATE tasks SET state='recovery_blocked', merge_sha=?, blocker_reason='No required deployment workflows are configured.', updated_at=unixepoch() WHERE id=?").bind(pullRequestLifecycle.merge_sha, id).run();
        await env.DB.prepare("INSERT INTO repository_health(repository,state,blocking_sha,root_task_id,recovery_attempts,updated_at) VALUES (?, 'recovery_blocked', ?, ?, 0, unixepoch()) ON CONFLICT(repository) DO UPDATE SET state='recovery_blocked', blocking_sha=excluded.blocking_sha, root_task_id=COALESCE(repository_health.root_task_id,excluded.root_task_id), updated_at=unixepoch()")
          .bind(existing.repository, pullRequestLifecycle.merge_sha, existing.id).run();
        await setState(env, existing.repository, existing.issue_number, "metis:recovery-blocked");
        return json({ accepted: true, task_id: id, state: "recovery_blocked" }, 202);
      }
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET state='deploying', merge_sha=?, blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(pullRequestLifecycle.merge_sha, id),
        env.DB.prepare("INSERT INTO repository_health(repository,state,blocking_sha,root_task_id,recovery_attempts,updated_at) VALUES (?, 'deploying', ?, ?, 0, unixepoch()) ON CONFLICT(repository) DO UPDATE SET state='deploying', blocking_sha=excluded.blocking_sha, root_task_id=CASE WHEN excluded.root_task_id IS NULL THEN repository_health.root_task_id ELSE excluded.root_task_id END, updated_at=unixepoch() ").bind(existing.repository, pullRequestLifecycle.merge_sha, existing.is_recovery ? null : existing.id),
      ]);
      await setState(env, existing.repository, existing.issue_number, "metis:deploying");
      return json({ accepted: true, task_id: id, state: "deploying", merge_sha: pullRequestLifecycle.merge_sha }, 202);
    }
    const effectivePullRequest = pullRequestLifecycle;
    if (effectivePullRequest.action === "synchronize") {
      const revision = await env.DB.prepare("SELECT * FROM revision_dispatches WHERE task_id=? AND state='running' ORDER BY id DESC LIMIT 1").bind(id).first();
      if (revision && revision.base_head_sha !== effectivePullRequest.head_sha) {
        await completeRevision(env, existing, revision, effectivePullRequest.head_sha, { source: "pull_request.synchronize" });
      }
    }
    if (["opened", "reopened"].includes(effectivePullRequest.action)) {
      await env.DB.prepare("UPDATE dispatches SET state='completed', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state='awaiting_pr_creation'")
        .bind(JSON.stringify({ status: "completed", pull_request_url: effectivePullRequest.pull_request_url, pull_request_number: effectivePullRequest.pull_request_number }), id).run();
      await env.DB.prepare("UPDATE tasks SET state='pr_ready', pull_request_url=?, pull_request_number=?, blocker_reason=NULL, updated_at=unixepoch() WHERE id=?")
        .bind(effectivePullRequest.pull_request_url, effectivePullRequest.pull_request_number, id).run();
      await setState(env, existing.repository, existing.issue_number, "metis:pr-ready");
      const awaitingRevision = await env.DB.prepare("SELECT * FROM revision_dispatches WHERE task_id=? AND state='awaiting_pr_creation' ORDER BY id DESC LIMIT 1").bind(id).first();
      if (awaitingRevision) {
        await env.DB.prepare("UPDATE revision_dispatches SET state='completed',result_json=?,updated_at=unixepoch() WHERE id=?")
          .bind(JSON.stringify({ replacement_pull_request_number: effectivePullRequest.pull_request_number, head_sha: effectivePullRequest.head_sha }), awaitingRevision.id).run();
      }
    }
    const current = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    const result = await evaluateMergeReadiness(env, current, effectivePullRequest);
    return json({ accepted: true, task_id: id, state: result.ready ? "merge_ready" : current.state, merge_readiness: result }, 202);
  }
  if (reviewLifecycle) {
    const taskForReview = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(`${reviewLifecycle.repository}#${reviewLifecycle.issue_number}`).first();
    if (!taskForReview) return json({ accepted: false, reason: "unknown task" }, 202);
    if (!taskForReview.pull_request_number || taskForReview.pull_request_number !== reviewLifecycle.pull_request_number) {
      return json({ accepted: false, reason: "review is not for the task pull request" }, 202);
    }
    if (reviewLifecycle.review_state === "changes_requested") {
      await env.DISPATCH_QUEUE.send({ type: "revision", taskId: taskForReview.id, reviewedHeadSha: reviewLifecycle.reviewed_head_sha });
      return json({ accepted: true, task_id: taskForReview.id, state: "reviewing", revision_queued: true }, 202);
    }
    const result = await evaluateMergeReadiness(env, taskForReview, reviewLifecycle);
    return json({ accepted: true, task_id: taskForReview.id, merge_readiness: result }, 202);
  }
  if (checkSuiteLifecycle) {
    const taskForCheck = await taskForPullRequest(env, checkSuiteLifecycle.repository, checkSuiteLifecycle.pull_request_number);
    if (!taskForCheck) return json({ accepted: false, reason: "unknown pull request" }, 202);
    const result = await evaluateMergeReadiness(env, taskForCheck, checkSuiteLifecycle);
    return json({ accepted: true, task_id: taskForCheck.id, merge_readiness: result }, 202);
  }
  if (connectorAck && !blocked) {
    const id = `${connectorAck.repository}#${connectorAck.issue_number}`;
    const pending = await env.DB.prepare("SELECT d.*,l.estimated_workload_units_reserved FROM dispatches d LEFT JOIN task_leases l ON l.lease_id=d.lease_id WHERE d.task_id=? ORDER BY d.id DESC LIMIT 1").bind(id).first();
    if (!pending) return json({ accepted: false, reason: "no correlated dispatch" }, 202);
    if (connectorAck.lease_id && connectorAck.lease_id !== pending.lease_id) return json({ accepted: false, reason: "connector acknowledgment lease mismatch" }, 202);
    const audit = JSON.stringify(connectorAck);
    const observationStatements = capacityObservationStatements(env, pending.id, connectorAck);
    if (pending.state !== "pending_connector_ack") {
      await env.DB.batch(observationStatements);
      return json({ accepted: true, task_id: id, state: pending.state, late: true, capacity: connectorAck.capacity_outcome }, 202);
    }
    if (connectorAck.status === "unknown") {
      await env.DB.batch(observationStatements);
      return json({ accepted: true, task_id: id, state: "pending_connector_ack", capacity: "unknown" }, 202);
    }
    if (connectorAck.status === "accepted") {
      await env.DB.batch([
        ...observationStatements,
        env.DB.prepare("UPDATE dispatches SET external_id=?,state='running',result_json=?,updated_at=unixepoch() WHERE id=? AND state='pending_connector_ack'").bind(connectorAck.task_url, audit, pending.id),
        env.DB.prepare("UPDATE tasks SET state='running',blocker_reason=NULL,updated_at=unixepoch() WHERE id=? AND state='pending_connector_ack'").bind(id),
        env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES(?,'codex_included','connector_acknowledged',0,?,unixepoch())").bind(id, audit),
      ]);
      return json({ accepted: true, task_id: id, state: "running", external_id: connectorAck.task_url }, 202);
    }
    const reason = connectorAck.setup_url ? `${connectorAck.reason} Setup: ${connectorAck.setup_url}` : connectorAck.reason;
    await env.DB.batch([
      ...observationStatements,
      env.DB.prepare("UPDATE dispatches SET state='blocked',result_json=?,updated_at=unixepoch() WHERE id=? AND state='pending_connector_ack'").bind(audit, pending.id),
      env.DB.prepare("DELETE FROM task_leases WHERE lease_id=?").bind(pending.lease_id),
      env.DB.prepare("UPDATE pacing_windows SET tasks_started=MAX(0,tasks_started-1),estimated_workload_units_used=MAX(0,estimated_workload_units_used-?) WHERE window_key=date('now')").bind(pending.estimated_workload_units_reserved),
      env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason=?,attempt_count=MAX(0,attempt_count-1),updated_at=unixepoch() WHERE id=? AND state='pending_connector_ack'").bind(reason, id),
      env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES(?,'codex_included','connector_rejected_refund',0,?,unixepoch())").bind(id, audit),
    ]);
    await setState(env, connectorAck.repository, connectorAck.issue_number, "metis:blocked");
    await comment(env, connectorAck.repository, connectorAck.issue_number, `## Codex did not accept this dispatch\n\n${reason}\n\nThe unused task-start and workload reservations were refunded. After resolving this blocker, reapply \`metis:ready\` to retry once.`);
    await resumeReadyBacklog(env);
    return json({ accepted: true, task_id: id, state: "blocked", refunded: true }, 202);
  }
  if (blocked) {
    const id = `${blocked.repository}#${blocked.issue_number}`;
    const existing = await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first();
    if (!existing) return json({ accepted: false, reason: "unknown task" }, 202);
    const pending = await env.DB.prepare("SELECT d.id,d.lease_id,l.estimated_workload_units_reserved FROM dispatches d LEFT JOIN task_leases l ON l.lease_id=d.lease_id WHERE d.task_id=? AND d.state='pending_connector_ack' ORDER BY d.id DESC LIMIT 1").bind(id).first();
    const result = JSON.stringify({ status: "blocked", question: blocked.question, comment_url: blocked.comment_url });
    const statements = [
      env.DB.prepare("UPDATE dispatches SET state='blocked', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state IN ('pending_connector_ack','running')").bind(result, id),
      env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
      env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(blocked.question, id),
      env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES(?,'codex_included',?,0,?,unixepoch())").bind(id, pending ? "connector_rejected_refund" : "coding_blocked", result),
    ];
    if (pending) {
      statements.push(env.DB.prepare("UPDATE pacing_windows SET tasks_started=MAX(0,tasks_started-1),estimated_workload_units_used=MAX(0,estimated_workload_units_used-?) WHERE window_key=date('now')").bind(pending.estimated_workload_units_reserved));
      statements.push(env.DB.prepare("UPDATE tasks SET attempt_count=MAX(0,attempt_count-1) WHERE id=?").bind(id));
    }
    await env.DB.batch(statements);
    await setState(env, blocked.repository, blocked.issue_number, "metis:blocked");
    await resumeReadyBacklog(env);
    return json({ accepted: true, task_id: id, state: "blocked" }, 202);
  }
  if (readyForPr) {
    const id = `${readyForPr.repository}#${readyForPr.issue_number}`;
    const existing = await env.DB.prepare("SELECT id, state FROM tasks WHERE id=?").bind(id).first();
    if (existing?.state === "revising") {
      const revision = await env.DB.prepare("SELECT * FROM revision_dispatches WHERE task_id=? AND state='running' ORDER BY id DESC LIMIT 1").bind(id).first();
      if (!revision) return json({ accepted: false, reason: "no active revision" }, 202);
      const result = JSON.stringify({ status: "awaiting_pr_creation", summary: readyForPr.summary, task_url: readyForPr.task_url, supersedes_pull_request: revision.pull_request_number });
      await env.DB.batch([
        env.DB.prepare("UPDATE revision_dispatches SET state='awaiting_pr_creation',result_json=?,updated_at=unixepoch() WHERE id=?").bind(result, revision.id),
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
        env.DB.prepare("UPDATE tasks SET state='awaiting_revision_pr',blocker_reason=NULL,updated_at=unixepoch() WHERE id=?").bind(id),
        env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) VALUES(?,'codex_included','review_revision_prepared',0,?,unixepoch())").bind(id, result),
      ]);
      await setState(env, readyForPr.repository, readyForPr.issue_number, "metis:awaiting-pr");
      await comment(env, readyForPr.repository, readyForPr.issue_number, ["## Metis is awaiting the revised PR handoff", "", readyForPr.summary, "", readyForPr.task_url ? `[Review the Codex revision and click **Create PR**](${readyForPr.task_url}).` : "Open the linked Codex revision and click **Create PR**.", "", `Metis will close superseded PR #${revision.pull_request_number}, bind the replacement, and require fresh human review and a human merge.`].join("\n"));
      await resumeReadyBacklog(env);
      return json({ accepted: true, task_id: id, state: "awaiting_revision_pr" }, 202);
    }
    if (!existing || existing.state !== "running") return json({ accepted: false, reason: "task is not running" }, 202);
    const result = JSON.stringify({ status: "awaiting_pr_creation", summary: readyForPr.summary, comment_url: readyForPr.comment_url, task_url: readyForPr.task_url });
    await env.DB.batch([
      env.DB.prepare("UPDATE dispatches SET state='awaiting_pr_creation', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state='running'").bind(result, id),
      env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
      env.DB.prepare("UPDATE tasks SET state='awaiting_pr_creation', blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(id),
      env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, legacy_estimated_workload_units, metadata_json, created_at) VALUES (?, 'codex_included', 'coding_prepared', 0, ?, unixepoch())").bind(id, result),
    ]);
    await setState(env, readyForPr.repository, readyForPr.issue_number, "metis:awaiting-pr");
    await comment(env, readyForPr.repository, readyForPr.issue_number, [
      "## Metis is awaiting PR creation",
      "",
      readyForPr.summary,
      "",
      readyForPr.task_url ? `[Review the Codex task and click **Create PR**](${readyForPr.task_url}).` : "Open the linked Codex task above and click **Create PR** after reviewing the diff.",
      "",
      "The coding lease has been released. Metis will detect the signed pull-request webhook and move this issue to `metis:pr-ready`.",
    ].join("\n"));
    await resumeReadyBacklog(env);
    return json({ accepted: true, task_id: id, state: "awaiting_pr_creation" }, 202);
  }
  const id = `${task.repository}#${task.issue_number}`;
  await env.DB.prepare("INSERT INTO tasks (id, repository, issue_number, issue_node_id, title, body, state, actor, size_class, max_workload_units, budget_approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, ?, unixepoch(), unixepoch()) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, state='intake', actor=excluded.actor, size_class=excluded.size_class, max_workload_units=excluded.max_workload_units, budget_approved=excluded.budget_approved, blocker_reason=NULL, updated_at=unixepoch()")
    .bind(id, task.repository, task.issue_number, task.issue_node_id, task.title, task.body, task.actor, task.size_class, task.max_workload_units, task.budget_approved).run();
  await env.DISPATCH_QUEUE.send({ type: "intake", taskId: id });
  return json({ accepted: true, task_id: id }, 202);
}

async function handleIntake(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  await setState(env, task.repository, task.issue_number, "metis:planning");
  let discussion;
  try {
    discussion = await fetchIssueDiscussion(env, task.repository, task.issue_number);
  } catch (error) {
    const reason = `Authoritative issue discussion fetch failed: ${error.message}`;
    await env.DB.prepare("UPDATE tasks SET state='ready', blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:ready");
    await comment(env, task.repository, task.issue_number, `## Metis deferred intake\n\n${reason}. The human Ready attestation remains authoritative. Metis will retry when evidence is available; no blocker or attempt was recorded.`);
    return;
  }
  const investigation = buildIntakeInvestigation(task, discussion, env.METIS_PROJECT_POLICY_JSON);
  const analysis = await analyzeIssue(env, task, discussion, investigation);
  await env.DB.prepare("UPDATE tasks SET summary=?, size_class=?, size_confidence=?, estimated_workload_units=?, dependencies_json=?, priority_score=?, state=?, blocker_reason=?, updated_at=unixepoch() WHERE id=?")
    .bind(analysis.summary, task.size_class || analysis.size, analysis.confidence, analysis.estimated_workload_units, JSON.stringify(analysis.dependencies), analysis.priority_score, "ready", null, task.id).run();
  await env.DB.prepare("DELETE FROM dependencies WHERE task_id=?").bind(task.id).run();
  if (analysis.dependencies.length) {
    await env.DB.batch(analysis.dependencies.map((dependency) => env.DB.prepare("INSERT INTO dependencies (task_id, dependency_ref, state) VALUES (?, ?, 'unverified')").bind(task.id, dependency)));
  }
  await env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, legacy_estimated_workload_units, metadata_json, created_at) VALUES (?, 'workers_ai', 'issue_analysis', 0, ?, unixepoch())").bind(task.id, JSON.stringify({ model: "workers-ai", size: analysis.size, discussion: discussionMetadata(discussion), investigation_sources: Object.keys(investigation) })).run();
  // Human-applied Ready is the authority boundary. Model readiness and prose-only
  // dependencies are advisory and cannot demote the task.
  await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: task.id });
}

async function handleDispatch(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  let dependencies;
  try {
    dependencies = await dependencyDecision(env, task);
  } catch (error) {
    await recordDependencyEvent(env, task.id, "reconciliation-error", { message: error.message }, `reconciliation-error:${task.id}:${Math.floor(Date.now() / 3600000)}`);
    throw error;
  }
  if (!dependencies.executable) {
    await env.DB.prepare("UPDATE tasks SET state='ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:ready");
    await recordDependencyEvent(env, task.id, "deferred", { waiting_on: dependencies.waitingOn, observed_at: dependencies.observedAt }, `deferred:${task.id}:${dependencies.waitingOn.sort().join(",")}`);
    return;
  }
  const decision = await admissionDecision(env, task);
  if (!decision.admitted) {
    if (decision.defer) {
      await env.DB.prepare("UPDATE tasks SET state='ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
      await setState(env, task.repository, task.issue_number, "metis:ready");
      if (decision.scheduler) await recordSchedulerDeferral(env, decision);
      if (decision.repositoryLocked) return;
      return;
    }
    await env.DB.prepare("UPDATE tasks SET state='budget_blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(decision.reason, task.id).run();
    return blockTask(env, task, decision.reason, "Should this task receive the required task-specific approval?", true);
  }
  const { leaseId } = await claimTask(env, task, decision);
  if (!leaseId) {
    // Another delivery won the task lease or the last scheduler slot. Leave the
    // Ready task authoritative; the backlog scan will revisit it after release.
    return;
  }
  await setState(env, task.repository, task.issue_number, "metis:implementing");
  try {
    const dispatch = await dispatchCodexTask(env, { ...task, max_workload_units: task.max_workload_units || decision.estimatedWorkloadUnits }, leaseId);
    const pending = dispatch.driver === "github_user_integration";
    await env.DB.prepare("INSERT INTO dispatches (task_id, lease_id, provider, external_id, state, created_at, updated_at) VALUES (?, ?, 'codex_included', ?, ?, unixepoch(), unixepoch())").bind(task.id, leaseId, dispatch.id, pending ? "pending_connector_ack" : "running").run();
    await env.DB.prepare("UPDATE tasks SET state=?, updated_at=unixepoch() WHERE id=?").bind(pending ? "pending_connector_ack" : "running", task.id).run();
  } catch (error) {
    await env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id).run();
    if (task.attempt_count + 1 >= decision.maxRetries) {
      await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(String(error), task.id).run();
      return blockTask(env, task, "The coding provider could not accept the task within its retry limit.", "Should Metis retry after the provider configuration or capacity is corrected?");
    }
    await env.DB.prepare("UPDATE tasks SET state='retrying', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    throw error;
  }
}

async function handleCallback(request, env) {
  if (request.headers.get("authorization") !== `Bearer ${env.CODEX_CALLBACK_TOKEN}`) return json({ error: "unauthorized" }, 401);
  const result = await request.json();
  const dispatch = await env.DB.prepare("SELECT * FROM dispatches WHERE external_id=?").bind(result.id).first();
  if (!dispatch) return json({ error: "unknown dispatch" }, 404);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(dispatch.task_id).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE dispatches SET state=?, result_json=?, updated_at=unixepoch() WHERE id=?").bind(result.status, JSON.stringify(result), dispatch.id),
    env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id),
    env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, input_tokens, output_tokens, legacy_estimated_workload_units, metadata_json, created_at) VALUES (?, 'codex_included', 'coding', ?, ?, ?, ?, unixepoch())").bind(task.id, result.usage?.input_tokens || null, result.usage?.output_tokens || null, 0, JSON.stringify(result.usage || {})),
  ]);
  if (result.status === "blocked") {
    await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(result.question || result.summary, task.id).run();
    await blockTask(env, task, result.summary, result.question || "What decision is needed to continue?");
  } else if (result.status === "awaiting_pr_creation") {
    await env.DB.prepare("UPDATE tasks SET state='awaiting_pr_creation', blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:awaiting-pr");
  } else if (result.status === "completed" && result.pull_request_url) {
    await env.DB.prepare("UPDATE tasks SET state='pr_ready', pull_request_url=?, updated_at=unixepoch() WHERE id=?").bind(result.pull_request_url, task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:pr-ready");
  } else {
    await env.DB.prepare("UPDATE tasks SET state='failed', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(result.summary || "Coding execution failed", task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:failed");
  }
  await resumeReadyBacklog(env);
  return json({ accepted: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "metis-control-plane" });
    if (request.method === "POST" && url.pathname === "/webhooks/github") return receiveWebhook(request, env);
    if (request.method === "POST" && url.pathname === "/callbacks/codex") return handleCallback(request, env);
    return json({ error: "not found" }, 404);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (["intake", "dispatch"].includes(message.body.type)) {
          await env.DB.prepare("DELETE FROM project_queue_signals WHERE task_id=? AND message_type=?").bind(message.body.taskId, message.body.type).run();
        }
        if (message.body.type === "intake") await handleIntake(env, message.body);
        else if (message.body.type === "dispatch") await handleDispatch(env, message.body);
        else if (message.body.type === "revision") await handleRevisionDispatch(env, message.body);
        else throw new Error("Unknown queue message type");
        message.ack();
      } catch (error) {
        console.error("Queue operation failed", { messageId: message.id, error: String(error) });
        message.retry();
      }
    }
  },
  async scheduled(_controller, env) {
    await pruneSchedulerSignals(env);
    const expired = await env.DB.prepare("SELECT l.task_id,l.estimated_workload_units_reserved,r.id AS revision_id FROM task_leases l LEFT JOIN revision_dispatches r ON r.lease_id=l.lease_id AND r.state='running' WHERE l.expires_at <= unixepoch()").all();
    for (const row of expired.results) {
      if (row.revision_id) {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(row.task_id).first();
        await env.DB.batch([
          env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(row.task_id),
          env.DB.prepare("UPDATE revision_dispatches SET state='failed',result_json=?,updated_at=unixepoch() WHERE id=?").bind(JSON.stringify({ reason: "revision lease expired" }), row.revision_id),
          env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason='Review revision lease expired.',updated_at=unixepoch() WHERE id=?").bind(row.task_id),
        ]);
        if (task) await setState(env, task.repository, task.issue_number, "metis:blocked");
        continue;
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(row.task_id),
        env.DB.prepare("UPDATE dispatches SET state='ack_timeout',result_json=?,updated_at=unixepoch() WHERE task_id=? AND state='pending_connector_ack'").bind(JSON.stringify({ reason: "connector acknowledgment timed out" }), row.task_id),
        env.DB.prepare("UPDATE pacing_windows SET tasks_started=MAX(0,tasks_started-1),estimated_workload_units_used=MAX(0,estimated_workload_units_used-?) WHERE window_key=date('now') AND EXISTS (SELECT 1 FROM dispatches WHERE task_id=? AND state='ack_timeout')").bind(row.estimated_workload_units_reserved, row.task_id),
        env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason='Codex connector acknowledgment timed out before task acceptance.',updated_at=unixepoch() WHERE id=? AND state='pending_connector_ack'").bind(row.task_id),
        env.DB.prepare("INSERT INTO usage_events(task_id,provider,operation,legacy_estimated_workload_units,metadata_json,created_at) SELECT ?,'codex_included','connector_ack_timeout_refund',0,?,unixepoch() WHERE EXISTS (SELECT 1 FROM dispatches WHERE task_id=? AND state='ack_timeout')").bind(row.task_id, JSON.stringify({ reason: "connector acknowledgment timed out" }), row.task_id),
        env.DB.prepare("UPDATE tasks SET state='retrying', updated_at=unixepoch() WHERE id=? AND state IN ('dispatching','running')").bind(row.task_id),
      ]);
      const timedOut = await env.DB.prepare("SELECT state FROM tasks WHERE id=?").bind(row.task_id).first();
      if (timedOut?.state === "blocked") {
        const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(row.task_id).first();
        if (task) await setState(env, task.repository, task.issue_number, "metis:blocked");
      } else await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: row.task_id });
    }
    await resumeReadyBacklog(env);
  },
};
