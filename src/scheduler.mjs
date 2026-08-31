import { loadPolicy, taskWorkloadLimit } from "./config.mjs";

export async function admissionDecision(env, task) {
  const policy = loadPolicy(env.METIS_POLICY_JSON);
  const sizePolicy = policy.taskSizes[task.size_class || "unknown"];
  const health = await env.DB.prepare("SELECT state, blocking_sha FROM repository_health WHERE repository=?").bind(task.repository).first();
  if (health && health.state !== "healthy" && !task.is_recovery) {
    return { admitted: false, defer: true, repositoryLocked: true, reason: `Repository recovery for ${health.blocking_sha || "main"} has priority over normal work.` };
  }
  if (!policy.providers.codex_included.enabled) return schedulerDeferral("provider", "Codex included capacity is disabled.");
  if (policy.providers.paid_api.enabled) throw new Error("Unsafe policy: paid API fallback must remain disabled unless explicitly implemented and approved");
  if (sizePolicy.dispatch !== "automatic" && !task.budget_approved) {
    return { admitted: false, reason: `${task.size_class || "unknown"} tasks require explicit budget approval.` };
  }
  const capacity = await env.DB.prepare("SELECT available FROM provider_capacity WHERE provider = 'codex_included'").first();
  if (!capacity?.available) return schedulerDeferral("provider", "Codex dispatch is disabled by the operator capacity gate.");
  const window = await env.DB.prepare("SELECT estimated_workload_units_used, tasks_started FROM pacing_windows WHERE window_key = date('now')").first();
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_leases WHERE expires_at > unixepoch()").first();
  const estimatedWorkloadUnits = Math.min(task.estimated_workload_units || sizePolicy.estimatedWorkloadUnits, taskWorkloadLimit(policy, task.size_class, task.max_workload_units));
  if ((active?.count || 0) >= policy.global.maxConcurrentTasks) return schedulerDeferral("concurrency", "Maximum concurrent tasks reached.");
  if (policy.global.maxTasksPerWindow != null && (window?.tasks_started || 0) >= policy.global.maxTasksPerWindow) return schedulerDeferral("task-start-pacing", "Operator task-start pacing limit reached.");
  if ((window?.estimated_workload_units_used || 0) + estimatedWorkloadUnits > policy.global.maxEstimatedWorkloadUnitsPerWindow) return schedulerDeferral("workload-pacing", "Operator estimated-workload pacing limit reached.");
  return { admitted: true, estimatedWorkloadUnits, maxRetries: policy.global.maxRetries, leaseSeconds: policy.global.leaseSeconds };
}

export function schedulerDeferral(kind, reason) {
  return { admitted: false, defer: true, scheduler: true, kind, reason };
}

export async function recordSchedulerDeferral(env, decision) {
  const windowKey = new Date().toISOString().slice(0, 10);
  const signalKey = `${windowKey}:${decision.kind}`;
  await env.DB.prepare("INSERT INTO scheduler_signals (signal_key,window_key,kind,reason,created_at,updated_at) VALUES (?,?,?,?,unixepoch(),unixepoch()) ON CONFLICT(signal_key) DO UPDATE SET reason=excluded.reason,updated_at=unixepoch()")
    .bind(signalKey, windowKey, decision.kind, decision.reason).run();
}

export async function claimTask(env, task, decision) {
  const leaseId = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare("INSERT INTO pacing_windows (window_key, estimated_workload_units_used, tasks_started) VALUES (date('now'), ?, 1) ON CONFLICT(window_key) DO UPDATE SET estimated_workload_units_used = estimated_workload_units_used + excluded.estimated_workload_units_used, tasks_started = tasks_started + 1").bind(decision.estimatedWorkloadUnits),
    env.DB.prepare("INSERT INTO task_leases (task_id, lease_id, provider, estimated_workload_units_reserved, expires_at) VALUES (?, ?, 'codex_included', ?, unixepoch() + ?)").bind(task.id, leaseId, decision.estimatedWorkloadUnits, decision.leaseSeconds),
    env.DB.prepare("UPDATE tasks SET state = 'dispatching', attempt_count = attempt_count + 1, updated_at = unixepoch() WHERE id = ? AND state IN ('ready','retrying')").bind(task.id),
  ]);
  return { leaseId, results: result };
}

export async function claimRevision(env, task, decision) {
  const leaseId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO pacing_windows (window_key, estimated_workload_units_used, tasks_started) VALUES (date('now'), ?, 1) ON CONFLICT(window_key) DO UPDATE SET estimated_workload_units_used = estimated_workload_units_used + excluded.estimated_workload_units_used, tasks_started = tasks_started + 1").bind(decision.estimatedWorkloadUnits),
    env.DB.prepare("INSERT INTO task_leases (task_id, lease_id, provider, estimated_workload_units_reserved, expires_at) VALUES (?, ?, 'codex_included', ?, unixepoch() + ?)").bind(task.id, leaseId, decision.estimatedWorkloadUnits, decision.leaseSeconds),
    env.DB.prepare("UPDATE tasks SET state='revising', attempt_count=attempt_count+1, updated_at=unixepoch() WHERE id=? AND state='reviewing'").bind(task.id),
  ]);
  return leaseId;
}
