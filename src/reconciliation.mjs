import { comment, githubRequest, setState } from "./github.mjs";
import { lifecyclePolicy } from "./lifecycle.mjs";
import { observeManagedPullRequestMergeability } from "./merge-conflicts.mjs";

export const RECONCILABLE_STATES = ["pending_connector_ack", "running", "awaiting_pr_creation", "pr_ready", "reviewing", "merge_ready", "merge_conflict", "merging", "deploying", "recovery"];
const SUCCESS = new Set(["success", "neutral", "skipped"]);
const FAILURE = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

export function managedTaskMarker(repository, issueNumber) {
  return new RegExp(`(?:^|\\n)Metis-Task:\\s*${repository.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}#${issueNumber}(?:\\s|$)`, "i");
}

export function selectWorkflowRuns(configured, mergeSha, runs) {
  const byWorkflow = new Map();
  for (const run of runs) {
    if (run.head_sha !== mergeSha || !configured.includes(run.name)) continue;
    const prior = byWorkflow.get(run.name);
    if (!prior || (run.run_attempt || 1) > (prior.run_attempt || 1) || run.id > prior.id) byWorkflow.set(run.name, run);
  }
  return byWorkflow;
}

async function boundedPages(env, path, limit = 3) {
  const separator = path.includes("?") ? "&" : "?";
  const values = [];
  for (let page = 1; page <= limit; page += 1) {
    const response = await githubRequest(env, `${path}${separator}per_page=100&page=${page}`);
    const batch = Array.isArray(response) ? response : response.workflow_runs;
    if (!Array.isArray(batch)) throw new Error(`Unexpected paginated GitHub response for ${path}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`Reconciliation pagination limit reached for ${path}`);
}

async function audit(env, task, transition, evidence, error = null) {
  const key = `${task.id}:${transition}:${evidence.merge_sha || evidence.head_sha || "none"}`;
  await env.DB.prepare("INSERT INTO reconciliation_events(event_key,task_id,transition,evidence_json,error,created_at) VALUES(?,?,?,?,?,unixepoch()) ON CONFLICT(event_key) DO NOTHING")
    .bind(key, task.id, transition, JSON.stringify(evidence), error).run();
  return key;
}

async function reportError(env, task, error) {
  const evidence = { repository: task.repository, issue_number: task.issue_number };
  const key = await audit(env, task, "error", evidence, String(error));
  const row = await env.DB.prepare("SELECT reported_at FROM reconciliation_events WHERE event_key=?").bind(key).first();
  if (!row?.reported_at) {
    await comment(env, task.repository, task.issue_number, `## Metis reconciliation paused\n\nAuthoritative GitHub evidence could not be reconciled safely: ${String(error)}\n\nNo lifecycle state was inferred or demoted.`);
    await env.DB.prepare("UPDATE reconciliation_events SET reported_at=unixepoch() WHERE event_key=? AND reported_at IS NULL").bind(key).run();
  }
}

async function discoverPullRequest(env, task) {
  const pulls = await boundedPages(env, `/repos/${task.repository}/pulls?state=all&sort=updated&direction=desc`);
  const candidates = pulls.filter((pr) => managedTaskMarker(task.repository, task.issue_number).test(pr.body || ""));
  if (candidates.length > 1) throw new Error(`multiple managed pull requests match ${task.id}: ${candidates.map((pr) => `#${pr.number}`).join(", ")}`);
  return candidates[0] || null;
}

async function workflowEvidence(env, task, mergeSha) {
  const configured = lifecyclePolicy(env, task.repository).deploymentWorkflows;
  if (!configured.length) throw new Error("no required deployment workflows are configured");
  const runs = await boundedPages(env, `/repos/${task.repository}/actions/runs?head_sha=${encodeURIComponent(mergeSha)}&event=push`);
  const byWorkflow = selectWorkflowRuns(configured, mergeSha, runs);
  return { configured, byWorkflow };
}

export async function reconcileManagedTasks(env, { maxTasks = 20, onDeploymentFailure } = {}) {
  const placeholders = RECONCILABLE_STATES.map(() => "?").join(",");
  const tasks = await env.DB.prepare(`SELECT * FROM tasks WHERE state IN (${placeholders}) ORDER BY updated_at LIMIT ?`).bind(...RECONCILABLE_STATES, maxTasks).all();
  const results = [];
  for (const task of tasks.results) {
    try {
      let pr = task.pull_request_number ? await githubRequest(env, `/repos/${task.repository}/pulls/${task.pull_request_number}`) : await discoverPullRequest(env, task);
      if (!pr) { results.push({ task_id: task.id, state: task.state }); continue; }
      if (!managedTaskMarker(task.repository, task.issue_number).test(pr.body || "")) throw new Error(`bound pull request #${pr.number} has a conflicting or missing task marker`);
      if (task.pull_request_number && task.pull_request_number !== pr.number) throw new Error("pull request identity changed");
      if (!task.pull_request_number) {
        await env.DB.prepare("UPDATE tasks SET pull_request_number=?,pull_request_url=?,state='pr_ready',updated_at=unixepoch() WHERE id=? AND pull_request_number IS NULL")
          .bind(pr.number, pr.html_url, task.id).run();
        await audit(env, task, "pr-bound", { pull_request_number: pr.number, head_sha: pr.head.sha });
      }
      if (!pr.merged || !pr.merge_commit_sha) {
        const conflict = await observeManagedPullRequestMergeability(env, task, pr, { maxAttempts: lifecyclePolicy(env, task.repository).maxMergeConflictAttempts });
        results.push({ task_id: task.id, state: conflict.state });
        continue;
      }
      const mergeSha = pr.merge_commit_sha;
      const evidence = await workflowEvidence(env, task, mergeSha);
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET state='deploying',merge_sha=?,pull_request_number=?,pull_request_url=?,updated_at=unixepoch() WHERE id=? AND state!='complete'").bind(mergeSha, pr.number, pr.html_url, task.id),
        env.DB.prepare("INSERT INTO repository_health(repository,state,blocking_sha,root_task_id,recovery_attempts,updated_at) VALUES(?,'deploying',?,?,0,unixepoch()) ON CONFLICT(repository) DO UPDATE SET state=CASE WHEN repository_health.state='healthy' THEN 'deploying' ELSE repository_health.state END,blocking_sha=excluded.blocking_sha,root_task_id=excluded.root_task_id,updated_at=unixepoch()").bind(task.repository, mergeSha, task.id),
      ]);
      const failed = evidence.configured.map((name) => evidence.byWorkflow.get(name)).find((run) => run && FAILURE.has(run.conclusion));
      if (failed) {
        await audit(env, task, "deployment-failed", { merge_sha: mergeSha, workflow: failed.name, run_id: failed.id, run_attempt: failed.run_attempt });
        if (onDeploymentFailure) await onDeploymentFailure({ ...task, merge_sha: mergeSha }, { repository: task.repository, head_sha: mergeSha, workflow_name: failed.name, conclusion: failed.conclusion, workflow_url: failed.html_url });
        results.push({ task_id: task.id, state: "recovery" });
        continue;
      }
      const missing = evidence.configured.find((name) => !evidence.byWorkflow.has(name));
      if (missing && Math.floor(Date.now() / 1000) - task.updated_at > 3600 && onDeploymentFailure) {
        await audit(env, task, "deployment-missing", { merge_sha: mergeSha, workflow: missing });
        await onDeploymentFailure({ ...task, merge_sha: mergeSha }, { repository: task.repository, head_sha: mergeSha, workflow_name: missing, conclusion: "missing", workflow_url: pr.html_url });
        results.push({ task_id: task.id, state: "recovery" });
        continue;
      }
      const complete = evidence.configured.every((name) => SUCCESS.has(evidence.byWorkflow.get(name)?.conclusion));
      if (!complete) { results.push({ task_id: task.id, state: "deploying" }); continue; }
      const eventKey = `${task.id}:complete:${mergeSha}`;
      const existing = await env.DB.prepare("SELECT reported_at FROM reconciliation_events WHERE event_key=?").bind(eventKey).first();
      await env.DB.batch([
        env.DB.prepare("UPDATE tasks SET state='complete',merge_sha=?,blocker_reason=NULL,updated_at=unixepoch() WHERE id=?").bind(mergeSha, task.id),
        env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(task.id),
        env.DB.prepare("UPDATE dispatches SET state='completed',updated_at=unixepoch() WHERE task_id=? AND state NOT IN ('completed','failed')").bind(task.id),
        env.DB.prepare("UPDATE repository_health SET state='healthy',blocking_sha=NULL,workflow_url=NULL,recovery_attempts=0,updated_at=unixepoch() WHERE repository=? AND blocking_sha=?").bind(task.repository, mergeSha),
        env.DB.prepare("INSERT INTO reconciliation_events(event_key,task_id,transition,evidence_json,created_at) VALUES(?,?,'complete',?,unixepoch()) ON CONFLICT(event_key) DO NOTHING").bind(eventKey, task.id, JSON.stringify({ pull_request_number: pr.number, merge_sha: mergeSha, workflows: evidence.configured.map((name) => ({ name, run_id: evidence.byWorkflow.get(name).id, run_attempt: evidence.byWorkflow.get(name).run_attempt || 1 })) })),
      ]);
      await setState(env, task.repository, task.issue_number, "metis:complete");
      await githubRequest(env, `/repos/${task.repository}/issues/${task.issue_number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
      if (!existing?.reported_at) {
        await comment(env, task.repository, task.issue_number, `## Metis reconciled authoritative completion\n\nPull request #${pr.number} merged as exact SHA \`${mergeSha}\`, and every configured deployment workflow succeeded for that SHA. Metis repaired the runtime chain and closed this task.`);
        await env.DB.prepare("UPDATE reconciliation_events SET reported_at=unixepoch() WHERE event_key=?").bind(eventKey).run();
      }
      results.push({ task_id: task.id, state: "complete" });
    } catch (error) {
      await reportError(env, task, error);
      results.push({ task_id: task.id, state: task.state, error: String(error) });
    }
  }
  return results;
}
