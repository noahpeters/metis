import { analyzeIssue } from "./ai.mjs";
import { blockTask, comment, enableAutoMerge, githubRequest, repositoryAllowed, setState } from "./github.mjs";
import { admissionDecision, claimTask } from "./scheduler.mjs";
import { dispatchCodexTask } from "./codex-dispatch.mjs";
import { approvalCount, checksPassed, checkSuiteLifecycleFromWebhook, lifecyclePolicy, pullRequestLifecycleFromWebhook, reviewLifecycleFromWebhook, workflowRunFromWebhook } from "./lifecycle.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function verifySignature(secret, signature, body) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = signature.slice(7).match(/.{2}/g)?.map((hex) => parseInt(hex, 16));
  return bytes ? crypto.subtle.verify("HMAC", key, new Uint8Array(bytes), new TextEncoder().encode(body)) : false;
}

export function readyIssueFromWebhook(event, payload) {
  if (event !== "issues" || payload.action !== "labeled" || payload.label?.name !== "metis:ready") return null;
  const labels = (payload.issue?.labels || []).map((label) => typeof label === "string" ? label : label.name);
  const sizeLabel = labels.find((label) => /^metis:size-(small|medium|large|unknown)$/.test(label));
  const maxCostLabel = labels.find((label) => /^metis:max-cost-\d+$/.test(label));
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    issue_node_id: payload.issue?.node_id,
    title: payload.issue?.title || "",
    body: payload.issue?.body || "",
    actor: payload.sender?.login || "unknown",
    size_class: sizeLabel?.slice("metis:size-".length) || null,
    max_cost_units: maxCostLabel ? Number(maxCostLabel.slice("metis:max-cost-".length)) : null,
    budget_approved: labels.includes("metis:budget-approved") ? 1 : 0,
  };
}

function isOfficialCodexConnector(payload) {
  return payload.sender?.login === "chatgpt-codex-connector[bot]"
    && payload.sender?.type === "Bot"
    && payload.comment?.performed_via_github_app?.id === 1144995
    && payload.comment?.performed_via_github_app?.slug === "chatgpt-codex-connector";
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
  const taskUrl = body.match(/https:\/\/chatgpt\.com\/(?:s\/[^)\s]+|codex\/cloud\/tasks\/[^)\s]+)/)?.[0] || null;
  return {
    repository: payload.repository?.full_name,
    issue_number: payload.issue?.number,
    summary: body.split("\n", 1)[0].slice("READY_FOR_PR:".length).trim() || "Codex prepared a change for PR creation.",
    body,
    comment_url: payload.comment?.html_url || null,
    task_url: taskUrl,
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

export function shouldReauthorPullRequest(env, task, lifecycle) {
  return lifecycle.action === "opened"
    && task.state === "awaiting_pr_creation"
    && Boolean(env.GITHUB_APP_BOT_LOGIN)
    && lifecycle.author_login !== env.GITHUB_APP_BOT_LOGIN
    && lifecycle.head_repository === lifecycle.repository
    && Boolean(lifecycle.head_branch)
    && Boolean(lifecycle.base_branch);
}

async function reauthorPullRequest(env, task, lifecycle) {
  await githubRequest(env, `/repos/${task.repository}/pulls/${lifecycle.pull_request_number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  try {
    const replacement = await githubRequest(env, `/repos/${task.repository}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: lifecycle.pull_request_title,
        body: lifecycle.pull_request_body,
        head: lifecycle.head_branch,
        base: lifecycle.base_branch,
        draft: lifecycle.draft,
      }),
    });
    await comment(env, task.repository, task.issue_number, [
      "## Metis created the protected pull request",
      "",
      `Codex prepared branch \`${lifecycle.head_branch}\` at \`${lifecycle.head_sha}\`. Metis closed the user-authored handoff PR and recreated it as the GitHub App so the task owner can provide the required human review.`,
      "",
      `[Review pull request #${replacement.number}](${replacement.html_url})`,
    ].join("\n"));
    return {
      ...lifecycle,
      pull_request_number: replacement.number,
      pull_request_node_id: replacement.node_id,
      pull_request_url: replacement.html_url,
      author_login: replacement.user?.login || env.GITHUB_APP_BOT_LOGIN,
      head_sha: replacement.head?.sha || lifecycle.head_sha,
    };
  } catch (error) {
    await env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?")
      .bind(`Metis could not recreate the pull request as the GitHub App: ${error.message}`, task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:blocked");
    await comment(env, task.repository, task.issue_number, `BLOCKED: Metis closed the handoff PR but could not recreate it as the GitHub App. The branch \`${lifecycle.head_branch}\` remains intact. Error: ${error.message}`);
    throw error;
  }
}

async function evaluateAutoMerge(env, task, lifecycle) {
  const policy = lifecyclePolicy(env, task.repository);
  if (!policy.autoMerge || task.is_recovery && policy.autoMergeRecovery === false) return { enabled: false, reason: "auto-merge disabled" };
  const health = await env.DB.prepare("SELECT state FROM repository_health WHERE repository=?").bind(task.repository).first();
  if (health && health.state !== "healthy" && !task.is_recovery) return { enabled: false, reason: "repository recovery lock active" };
  if (task.state === "merging") return { enabled: true, reason: "already enabled" };
  const pullRequest = await githubRequest(env, `/repos/${task.repository}/pulls/${lifecycle.pull_request_number}`);
  if (pullRequest.draft || pullRequest.state !== "open" || pullRequest.base?.ref !== pullRequest.base?.repo?.default_branch) {
    return { enabled: false, reason: "pull request is not an open, non-draft change to the default branch" };
  }
  const [checks, reviews] = await Promise.all([
    githubRequest(env, `/repos/${task.repository}/commits/${pullRequest.head.sha}/check-runs?per_page=100`),
    githubRequest(env, `/repos/${task.repository}/pulls/${lifecycle.pull_request_number}/reviews?per_page=100`),
  ]);
  const checksReady = checksPassed(checks.check_runs || []);
  const approvalsReady = approvalCount(reviews || []) >= policy.requiredApprovals;
  if (!checksReady || !approvalsReady || pullRequest.mergeable !== true) {
    await env.DB.prepare("UPDATE tasks SET state='reviewing', updated_at=unixepoch() WHERE id=? AND state IN ('pr_ready','reviewing','merge_ready')").bind(task.id).run();
    await setState(env, task.repository, task.issue_number, "metis:reviewing");
    return { enabled: false, reason: `waiting for checks, approvals, or mergeability (${checksReady}/${approvalsReady}/${pullRequest.mergeable})` };
  }
  await env.DB.prepare("UPDATE tasks SET state='merge_ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
  await setState(env, task.repository, task.issue_number, "metis:merge-ready");
  await enableAutoMerge(env, lifecycle.pull_request_node_id || pullRequest.node_id, policy.mergeMethod);
  await env.DB.prepare("UPDATE tasks SET state='merging', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
  await setState(env, task.repository, task.issue_number, "metis:merging");
  await comment(env, task.repository, task.issue_number, "## Metis enabled guarded auto-merge\n\nRequired checks, approvals, mergeability, and repository health passed. GitHub native auto-merge now owns the merge gate; Metis will monitor the exact merge SHA through deployment.");
  return { enabled: true };
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
  const task = readyIssueFromWebhook(event, payload);
  const blocked = blockedCodexFromWebhook(event, payload);
  const readyForPr = readyForPrCodexFromWebhook(event, payload);
  const pullRequest = pullRequestForTaskFromWebhook(event, payload);
  const pullRequestLifecycle = pullRequestLifecycleFromWebhook(event, payload);
  const reviewLifecycle = reviewLifecycleFromWebhook(event, payload);
  const checkSuiteLifecycle = checkSuiteLifecycleFromWebhook(event, payload);
  const workflowRun = workflowRunFromWebhook(event, payload);
  if (!task && !blocked && !readyForPr && !pullRequest && !pullRequestLifecycle && !reviewLifecycle && !checkSuiteLifecycle && !workflowRun) return json({ accepted: false }, 202);
  const repository = task?.repository || blocked?.repository || readyForPr?.repository || pullRequest?.repository || pullRequestLifecycle?.repository || reviewLifecycle?.repository || checkSuiteLifecycle?.repository || workflowRun?.repository;
  if (!repositoryAllowed(env, repository)) return json({ error: "repository not allowed" }, 403);
  try {
    await env.DB.prepare("INSERT INTO webhook_deliveries (delivery_id, event_name, received_at) VALUES (?, ?, unixepoch())").bind(delivery, event).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ accepted: true, duplicate: true }, 202);
    throw error;
  }
  if (workflowRun) return json(await handleWorkflowCompletion(env, workflowRun), 202);
  if (pullRequestLifecycle) {
    const id = `${pullRequestLifecycle.repository}#${pullRequestLifecycle.issue_number}`;
    const existing = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    if (!existing) return json({ accepted: false, reason: "unknown task" }, 202);
    if (existing.pull_request_number && existing.pull_request_number !== pullRequestLifecycle.pull_request_number) {
      return json({ accepted: false, reason: "task is already bound to another pull request" }, 202);
    }
    if (["opened", "reopened"].includes(pullRequestLifecycle.action)
      && !["awaiting_pr_creation", "pr_ready", "reviewing", "merge_ready", "merging"].includes(existing.state)) {
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
    const effectivePullRequest = shouldReauthorPullRequest(env, existing, pullRequestLifecycle)
      ? await reauthorPullRequest(env, existing, pullRequestLifecycle)
      : pullRequestLifecycle;
    if (["opened", "reopened"].includes(effectivePullRequest.action)) {
      await env.DB.prepare("UPDATE dispatches SET state='completed', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state='awaiting_pr_creation'")
        .bind(JSON.stringify({ status: "completed", pull_request_url: effectivePullRequest.pull_request_url, pull_request_number: effectivePullRequest.pull_request_number }), id).run();
      await env.DB.prepare("UPDATE tasks SET state='pr_ready', pull_request_url=?, pull_request_number=?, blocker_reason=NULL, updated_at=unixepoch() WHERE id=?")
        .bind(effectivePullRequest.pull_request_url, effectivePullRequest.pull_request_number, id).run();
      await setState(env, existing.repository, existing.issue_number, "metis:pr-ready");
    }
    const current = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first();
    const result = await evaluateAutoMerge(env, current, effectivePullRequest);
    return json({ accepted: true, task_id: id, state: result.enabled ? "merging" : current.state, auto_merge: result }, 202);
  }
  if (reviewLifecycle) {
    const taskForReview = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(`${reviewLifecycle.repository}#${reviewLifecycle.issue_number}`).first();
    if (!taskForReview) return json({ accepted: false, reason: "unknown task" }, 202);
    if (!taskForReview.pull_request_number || taskForReview.pull_request_number !== reviewLifecycle.pull_request_number) {
      return json({ accepted: false, reason: "review is not for the task pull request" }, 202);
    }
    const result = await evaluateAutoMerge(env, taskForReview, reviewLifecycle);
    return json({ accepted: true, task_id: taskForReview.id, auto_merge: result }, 202);
  }
  if (checkSuiteLifecycle) {
    const taskForCheck = await taskForPullRequest(env, checkSuiteLifecycle.repository, checkSuiteLifecycle.pull_request_number);
    if (!taskForCheck) return json({ accepted: false, reason: "unknown pull request" }, 202);
    const result = await evaluateAutoMerge(env, taskForCheck, checkSuiteLifecycle);
    return json({ accepted: true, task_id: taskForCheck.id, auto_merge: result }, 202);
  }
  if (blocked) {
    const id = `${blocked.repository}#${blocked.issue_number}`;
    const existing = await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first();
    if (!existing) return json({ accepted: false, reason: "unknown task" }, 202);
    const result = JSON.stringify({ status: "blocked", question: blocked.question, comment_url: blocked.comment_url });
    await env.DB.batch([
      env.DB.prepare("UPDATE dispatches SET state='blocked', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state='running'").bind(result, id),
      env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
      env.DB.prepare("UPDATE tasks SET state='blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(blocked.question, id),
    ]);
    await setState(env, blocked.repository, blocked.issue_number, "metis:blocked");
    return json({ accepted: true, task_id: id, state: "blocked" }, 202);
  }
  if (readyForPr) {
    const id = `${readyForPr.repository}#${readyForPr.issue_number}`;
    const existing = await env.DB.prepare("SELECT id, state FROM tasks WHERE id=?").bind(id).first();
    if (!existing || existing.state !== "running") return json({ accepted: false, reason: "task is not running" }, 202);
    const result = JSON.stringify({ status: "awaiting_pr_creation", summary: readyForPr.summary, comment_url: readyForPr.comment_url, task_url: readyForPr.task_url });
    await env.DB.batch([
      env.DB.prepare("UPDATE dispatches SET state='awaiting_pr_creation', result_json=?, updated_at=unixepoch() WHERE task_id=? AND state='running'").bind(result, id),
      env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(id),
      env.DB.prepare("UPDATE tasks SET state='awaiting_pr_creation', blocker_reason=NULL, updated_at=unixepoch() WHERE id=?").bind(id),
      env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, cost_units, metadata_json, created_at) VALUES (?, 'codex_included', 'coding_prepared', 0, ?, unixepoch())").bind(id, result),
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
    return json({ accepted: true, task_id: id, state: "awaiting_pr_creation" }, 202);
  }
  const id = `${task.repository}#${task.issue_number}`;
  await env.DB.prepare("INSERT INTO tasks (id, repository, issue_number, issue_node_id, title, body, state, actor, size_class, max_cost_units, budget_approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intake', ?, ?, ?, ?, unixepoch(), unixepoch()) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, state='intake', actor=excluded.actor, size_class=excluded.size_class, max_cost_units=excluded.max_cost_units, budget_approved=excluded.budget_approved, updated_at=unixepoch()")
    .bind(id, task.repository, task.issue_number, task.issue_node_id, task.title, task.body, task.actor, task.size_class, task.max_cost_units, task.budget_approved).run();
  await env.DISPATCH_QUEUE.send({ type: "intake", taskId: id });
  return json({ accepted: true, task_id: id }, 202);
}

async function handleIntake(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  await setState(env, task.repository, task.issue_number, "metis:planning");
  const analysis = await analyzeIssue(env, task);
  await env.DB.prepare("UPDATE tasks SET summary=?, size_class=?, size_confidence=?, estimated_cost_units=?, dependencies_json=?, priority_score=?, state=?, blocker_reason=?, updated_at=unixepoch() WHERE id=?")
    .bind(analysis.summary, task.size_class || analysis.size, analysis.confidence, analysis.estimated_cost_units, JSON.stringify(analysis.dependencies), analysis.priority_score, analysis.readiness, analysis.blocker_question, task.id).run();
  await env.DB.prepare("DELETE FROM dependencies WHERE task_id=?").bind(task.id).run();
  if (analysis.dependencies.length) {
    await env.DB.batch(analysis.dependencies.map((dependency) => env.DB.prepare("INSERT INTO dependencies (task_id, dependency_ref, state) VALUES (?, ?, 'unverified')").bind(task.id, dependency)));
  }
  await env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, cost_units, metadata_json, created_at) VALUES (?, 'workers_ai', 'issue_analysis', 0, ?, unixepoch())").bind(task.id, JSON.stringify({ model: "workers-ai", size: analysis.size })).run();
  if (analysis.readiness === "blocked") return blockTask(env, task, analysis.status_summary || analysis.summary, analysis.blocker_question || "What information is needed to make this issue executable?");
  await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: task.id });
}

async function handleDispatch(env, message) {
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(message.taskId).first();
  if (!task) return;
  const decision = await admissionDecision(env, task);
  if (!decision.admitted) {
    if (decision.defer) {
      await env.DB.prepare("UPDATE tasks SET state='ready', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
      if (decision.repositoryLocked) return;
      throw new Error(decision.reason);
    }
    await env.DB.prepare("UPDATE tasks SET state='budget_blocked', blocker_reason=?, updated_at=unixepoch() WHERE id=?").bind(decision.reason, task.id).run();
    return blockTask(env, task, decision.reason, "Should Metis increase this task's budget/capacity or wait for the next capacity window?", true);
  }
  const { leaseId } = await claimTask(env, task, decision);
  await setState(env, task.repository, task.issue_number, "metis:implementing");
  try {
    const dispatch = await dispatchCodexTask(env, { ...task, max_cost_units: task.max_cost_units || decision.estimate }, leaseId);
    await env.DB.prepare("INSERT INTO dispatches (task_id, lease_id, provider, external_id, state, created_at, updated_at) VALUES (?, ?, 'codex_included', ?, 'running', unixepoch(), unixepoch())").bind(task.id, leaseId, dispatch.id).run();
    await env.DB.prepare("UPDATE tasks SET state='running', updated_at=unixepoch() WHERE id=?").bind(task.id).run();
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
    env.DB.prepare("INSERT INTO usage_events (task_id, provider, operation, input_tokens, output_tokens, cost_units, metadata_json, created_at) VALUES (?, 'codex_included', 'coding', ?, ?, ?, ?, unixepoch())").bind(task.id, result.usage?.input_tokens || null, result.usage?.output_tokens || null, result.usage?.cost_units || 0, JSON.stringify(result.usage || {})),
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
        if (message.body.type === "intake") await handleIntake(env, message.body);
        else if (message.body.type === "dispatch") await handleDispatch(env, message.body);
        else throw new Error("Unknown queue message type");
        message.ack();
      } catch (error) {
        console.error("Queue operation failed", { messageId: message.id, error: String(error) });
        message.retry();
      }
    }
  },
  async scheduled(_controller, env) {
    const expired = await env.DB.prepare("SELECT task_id FROM task_leases WHERE expires_at <= unixepoch()").all();
    for (const row of expired.results) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(row.task_id),
        env.DB.prepare("UPDATE tasks SET state='retrying', updated_at=unixepoch() WHERE id=? AND state IN ('dispatching','running')").bind(row.task_id),
      ]);
      await env.DISPATCH_QUEUE.send({ type: "dispatch", taskId: row.task_id });
    }
  },
};
