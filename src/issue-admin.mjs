import { githubRequest, setState } from "./github.mjs";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const authorized = (email) => typeof email === "string" && /^[^@]+@from-trees\.com$/i.test(email);
const managed = (env, repository) => (env.ALLOWED_REPOSITORIES || "").split(",").map((value) => value.trim()).includes(repository);

function validate(body, idempotencyKey, action) {
  if (!idempotencyKey || !body?.request_id || !Number.isInteger(body.issue_number) || !Number.isInteger(body.expected_updated_at) || typeof body.reason !== "string" || body.reason.trim().length < 8) return false;
  if (action === "reset_ready") return body.confirmation === "RESET_TO_READY";
  return body.confirmation === "FORCE_COMPLETE" && typeof body.diff_reference === "string" && body.diff_reference.trim().length >= 7 && body.diff_reference.trim().length <= 500;
}

function cleanupStatements(env, taskId, action) {
  const reason = action === "reset_ready" ? "operator_reset" : "operator_force_complete";
  return [
    env.DB.prepare("UPDATE provider_capacity SET dispatch_slots_available=MIN(dispatch_slots_limit,dispatch_slots_available+COALESCE((SELECT SUM(provider_slots) FROM dispatch_reservations WHERE task_id=? AND state IN ('reserved','reconciliation_required')),0)),updated_at=unixepoch() WHERE provider='codex_included' AND dispatch_slots_limit IS NOT NULL").bind(taskId),
    env.DB.prepare("UPDATE dispatch_reservations SET state='released',reason_class=?,sanitized_error='Superseded by an audited operator action.',updated_at=unixepoch() WHERE task_id=? AND state IN ('reserved','reconciliation_required')").bind(reason, taskId),
    env.DB.prepare("INSERT INTO reservation_adjustments(lease_id,operation,task_id,reason_class,sanitized_detail,created_at) SELECT lease_id,'release',task_id,?,'Superseded by an audited operator action.',unixepoch() FROM dispatch_reservations WHERE task_id=? AND state='released' ON CONFLICT(lease_id,operation) DO NOTHING").bind(reason, taskId),
    env.DB.prepare("UPDATE dispatches SET state='operator_superseded',result_json=json_object('reason',?),updated_at=unixepoch() WHERE task_id=? AND state IN ('pending_connector_ack','running')").bind(reason, taskId),
    env.DB.prepare("UPDATE revision_dispatches SET state='operator_superseded',result_json=json_object('reason',?),updated_at=unixepoch() WHERE task_id=? AND state IN ('pending_connector_ack','running')").bind(reason, taskId),
    env.DB.prepare("DELETE FROM task_leases WHERE task_id=?").bind(taskId),
    env.DB.prepare("DELETE FROM project_queue_signals WHERE task_id=?").bind(taskId),
  ];
}

export async function administerIssueForIdentity(email, request, env, resumeBacklog, action) {
  if (!authorized(email)) return json({ error: { code: "unauthorized", message: "Administrator identity required" } }, 401);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  let body;
  try { body = await request.json(); } catch { return json({ error: { code: "invalid_json", message: "A JSON request is required" } }, 400); }
  if (!validate(body, idempotencyKey, action)) return json({ error: { code: "invalid_request", message: "Confirmation, reason, issue identity, request ID, idempotency key, and observed version are required" } }, 400);
  if (!managed(env, body.repository)) return json({ error: { code: "unknown_repository", message: "Repository is not managed" } }, 404);
  const duplicate = await env.DB.prepare("SELECT after_json FROM issue_admin_audit WHERE idempotency_key=? OR request_id=?").bind(idempotencyKey, body.request_id).first();
  if (duplicate) return json({ ...JSON.parse(duplicate.after_json), duplicate: true });
  const taskId = `${body.repository}#${body.issue_number}`;
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id=?").bind(taskId).first();
  if (!task) return json({ error: { code: "unknown_task", message: "Metis has no task record for this issue" } }, 404);
  if (task.updated_at !== body.expected_updated_at) return json({ error: { code: "stale_state", message: "Issue state changed; refresh before confirming" } }, 409);
  const before = { state: task.state, blocker_reason: task.blocker_reason, attempt_count: task.attempt_count, pull_request_url: task.pull_request_url, merge_sha: task.merge_sha, updated_at: task.updated_at };
  const nextState = action === "reset_ready" ? "ready" : "complete";
  await setState(env, body.repository, body.issue_number, action === "reset_ready" ? "metis:ready" : "metis:complete");
  if (action === "force_complete") await githubRequest(env, `/repos/${body.repository}/issues/${body.issue_number}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
  const after = { action, task_id: taskId, state: nextState, issue_state: action === "force_complete" ? "closed" : "open", diff_reference: action === "force_complete" ? body.diff_reference.trim() : null, deployment_verification_waived: action === "force_complete" };
  await env.DB.batch([
    ...cleanupStatements(env, taskId, action),
    action === "reset_ready"
      ? env.DB.prepare("UPDATE tasks SET state='ready',blocker_reason=NULL,attempt_count=0,pull_request_url=NULL,pull_request_number=NULL,merge_sha=NULL,updated_at=MAX(unixepoch(),updated_at+1) WHERE id=? AND updated_at=?").bind(taskId, body.expected_updated_at)
      : env.DB.prepare("UPDATE tasks SET state='complete',blocker_reason=NULL,updated_at=MAX(unixepoch(),updated_at+1) WHERE id=? AND updated_at=?").bind(taskId, body.expected_updated_at),
    env.DB.prepare("INSERT INTO issue_admin_audit(request_id,idempotency_key,task_id,action,actor_email,reason,diff_reference,before_json,after_json,deployment_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch())").bind(body.request_id, idempotencyKey, taskId, action, email.toLowerCase(), body.reason.trim(), action === "force_complete" ? body.diff_reference.trim() : null, JSON.stringify(before), JSON.stringify(after), env.DEPLOYMENT_VERSION || null),
  ]);
  await resumeBacklog();
  return json(after);
}
