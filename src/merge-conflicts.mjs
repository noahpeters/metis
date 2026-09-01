import { comment, githubUserRequest, setState } from "./github.mjs";

export const ACTIVE_CORRECTION_STATES = new Set(["conflicting", "correction_dispatched"]);

export function mergeabilityObservation(pullRequest) {
  if (pullRequest.mergeable == null || pullRequest.mergeable_state === "unknown") return "mergeability_unknown";
  if (pullRequest.mergeable === false && pullRequest.mergeable_state === "dirty") return "conflicting";
  return "clean";
}

export function conflictTupleKey(pullRequestNumber, baseSha, headSha) {
  return `${pullRequestNumber}:${baseSha}:${headSha}`;
}

export function buildMergeConflictCorrectionComment(task, pullRequest, baseSha, headSha) {
  const marker = `metis-codex-merge-conflict:${conflictTupleKey(pullRequest.number, baseSha, headSha)}`;
  return [
    `<!-- ${marker} -->`,
    `@codex resolve the merge conflicts on this existing pull request and push the verified correction to its current branch.`,
    "",
    `Managed issue: ${task.repository}#${task.issue_number}`,
    `Managed pull request: #${pullRequest.number}`,
    `Exact observed base SHA: \`${baseSha}\``,
    `Exact observed head SHA: \`${headSha}\``,
    `Existing head branch: \`${pullRequest.head.ref}\``,
    "",
    "Correction requirements:",
    "- Inspect the changes on both the base and pull-request sides. Preserve both intended implementations and resolve semantic conflicts; never discard either side wholesale.",
    "- Before editing and again immediately before pushing, confirm that the pull request still has the exact base and head SHAs above. If either changed, stop because this correction has been superseded.",
    "- Run the repository-prescribed verification and substantively review the resulting diff.",
    "- Commit and push only to the existing pull-request branch so the pull-request number, discussion, and linkage are preserved. Do not create a replacement pull request.",
    "- Do not merge, deploy, push to the default branch, or mutate production systems or data. Human approval and merge remain required after fresh checks on the new head.",
    "- If updating the existing branch is unsupported or permission is denied, report that exact error instead of creating another pull request.",
    "",
    `Metis-Task: ${task.repository}#${task.issue_number}`,
  ].join("\n");
}

async function recordObservation(env, task, pullRequest, baseSha, headSha, state, failure = null) {
  const tupleKey = conflictTupleKey(pullRequest.number, baseSha, headSha);
  await env.DB.prepare("INSERT INTO merge_conflict_recoveries(tuple_key,task_id,repository,issue_number,pull_request_number,base_sha,head_sha,state,attempt_count,failure_evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,?,unixepoch(),unixepoch()) ON CONFLICT(tuple_key) DO UPDATE SET state=CASE WHEN merge_conflict_recoveries.state IN ('correction_dispatched','corrected','correction_failed','superseded') THEN merge_conflict_recoveries.state ELSE excluded.state END,failure_evidence=COALESCE(excluded.failure_evidence,merge_conflict_recoveries.failure_evidence),updated_at=unixepoch()")
    .bind(tupleKey, task.id, task.repository, task.issue_number, pullRequest.number, baseSha, headSha, state, failure?.slice(0, 500) || null).run();
  return tupleKey;
}

export async function observeManagedPullRequestMergeability(env, task, pullRequest, { maxAttempts = 2 } = {}) {
  const baseSha = pullRequest.base?.sha;
  const headSha = pullRequest.head?.sha;
  if (!baseSha || !headSha || !pullRequest.number) throw new Error("Pull request mergeability evidence lacks an exact base or head SHA");

  const active = await env.DB.prepare("SELECT * FROM merge_conflict_recoveries WHERE task_id=? AND state IN ('conflicting','correction_dispatched') ORDER BY id DESC").bind(task.id).all();
  for (const recovery of active.results) {
    if (recovery.base_sha !== baseSha || recovery.head_sha !== headSha) {
      const terminalState = recovery.base_sha === baseSha && recovery.head_sha !== headSha ? "corrected" : "superseded";
      await env.DB.prepare("UPDATE merge_conflict_recoveries SET state=?,updated_at=unixepoch() WHERE id=? AND state IN ('conflicting','correction_dispatched')").bind(terminalState, recovery.id).run();
    }
  }

  const observation = mergeabilityObservation(pullRequest);
  const tupleKey = await recordObservation(env, task, pullRequest, baseSha, headSha, observation === "clean" ? "corrected" : observation);
  if (observation !== "conflicting") {
    if (observation === "clean" && task.state === "merge_conflict") {
      await env.DB.prepare("UPDATE tasks SET state='reviewing',updated_at=unixepoch() WHERE id=? AND state='merge_conflict'").bind(task.id).run();
    }
    return { state: observation, tuple_key: tupleKey };
  }

  const health = await env.DB.prepare("SELECT state FROM repository_health WHERE repository=?").bind(task.repository).first();
  if (health && health.state !== "healthy") return { state: "conflicting", deferred: "repository recovery has priority", tuple_key: tupleKey };

  const recovery = await env.DB.prepare("SELECT * FROM merge_conflict_recoveries WHERE tuple_key=?").bind(tupleKey).first();
  if (recovery.state === "correction_dispatched" || recovery.state === "correction_failed") return { state: recovery.state, tuple_key: tupleKey };
  if (recovery.attempt_count >= maxAttempts) return { state: "correction_failed", tuple_key: tupleKey };

  const body = buildMergeConflictCorrectionComment(task, pullRequest, baseSha, headSha);
  const claimed = await env.DB.prepare("UPDATE merge_conflict_recoveries SET state='correction_dispatched',attempt_count=attempt_count+1,dispatched_at=unixepoch(),updated_at=unixepoch() WHERE tuple_key=? AND state='conflicting'").bind(tupleKey).run();
  if (!claimed.meta?.changes) return { state: "correction_dispatched", tuple_key: tupleKey };
  try {
    const path = `/repos/${task.repository}/issues/${pullRequest.number}/comments`;
    const comments = await githubUserRequest(env, `${path}?per_page=100`);
    const marker = `metis-codex-merge-conflict:${tupleKey}`;
    const created = comments.find((item) => item.body?.includes(marker)) || await githubUserRequest(env, path, { method: "POST", body: JSON.stringify({ body }) });
    await env.DB.batch([
      env.DB.prepare("UPDATE merge_conflict_recoveries SET dispatch_identity=?,updated_at=unixepoch() WHERE tuple_key=? AND state='correction_dispatched'").bind(`github-pr-comment:${created.id}`, tupleKey),
      env.DB.prepare("UPDATE tasks SET state='merge_conflict',blocker_reason=NULL,updated_at=unixepoch() WHERE id=?").bind(task.id),
    ]);
    await setState(env, task.repository, task.issue_number, "metis:reviewing");
    await comment(env, task.repository, task.issue_number, `## Metis is repairing a merge conflict\n\nCodex was dispatched once for pull request #${pullRequest.number} at base \`${baseSha}\` and head \`${headSha}\`. It must update the same branch. Fresh checks and renewed human approval will be required for the resulting head.`);
    return { state: "correction_dispatched", tuple_key: tupleKey, dispatch_identity: `github-pr-comment:${created.id}` };
  } catch (error) {
    const denied = [401, 403].includes(error.status);
    const evidence = denied ? `Existing pull-request branch update/comment permission denied by GitHub (${error.status}).` : String(error);
    await env.DB.prepare("UPDATE merge_conflict_recoveries SET state='correction_failed',failure_evidence=?,updated_at=unixepoch() WHERE tuple_key=?").bind(evidence.slice(0, 500), tupleKey).run();
    if (denied) {
      await env.DB.prepare("UPDATE tasks SET state='blocked',blocker_reason=?,updated_at=unixepoch() WHERE id=?").bind(evidence, task.id).run();
      await setState(env, task.repository, task.issue_number, "metis:blocked");
      await comment(env, task.repository, task.issue_number, `## Merge-conflict correction requires operator action\n\n${evidence} Grant the configured GitHub dispatch identity permission to comment on and push to the existing pull-request branch. Metis will not create a replacement pull request.`);
      return { state: "correction_failed", operator_error: true, tuple_key: tupleKey };
    }
    throw error;
  }
}
