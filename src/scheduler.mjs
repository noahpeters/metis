import { loadPolicy, taskBudget } from "./config.mjs";

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
  const capacity = await env.DB.prepare("SELECT remaining_units, available FROM provider_capacity WHERE provider = 'codex_included'").first();
  if (!capacity?.available) return schedulerDeferral("provider", "Included Codex capacity is unavailable or exhausted.");
  const window = await env.DB.prepare("SELECT cost_units_used, tasks_started FROM budget_windows WHERE window_key = date('now')").first();
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_leases WHERE expires_at > unixepoch()").first();
  const estimate = Math.min(task.estimated_cost_units || sizePolicy.estimatedCostUnits, taskBudget(policy, task.size_class, task.max_cost_units));
  if ((active?.count || 0) >= policy.global.maxConcurrentTasks) return schedulerDeferral("concurrency", "Maximum concurrent tasks reached.");
  if ((window?.tasks_started || 0) >= policy.global.maxTasksPerWindow) return schedulerDeferral("task-start-budget", "Global task-start budget exhausted.");
  if ((window?.cost_units_used || 0) + estimate > policy.global.maxCostUnitsPerWindow) return schedulerDeferral("cost-budget", "Global cost-unit budget exhausted.");
  if (capacity.remaining_units != null && capacity.remaining_units < estimate) return schedulerDeferral("provider", "Provider capacity is below the task estimate.");
  return { admitted: true, estimate, maxRetries: policy.global.maxRetries, leaseSeconds: policy.global.leaseSeconds };
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
    env.DB.prepare("INSERT INTO budget_windows (window_key, cost_units_used, tasks_started) VALUES (date('now'), ?, 1) ON CONFLICT(window_key) DO UPDATE SET cost_units_used = cost_units_used + excluded.cost_units_used, tasks_started = tasks_started + 1").bind(decision.estimate),
    env.DB.prepare("INSERT INTO task_leases (task_id, lease_id, provider, cost_units_reserved, expires_at) VALUES (?, ?, 'codex_included', ?, unixepoch() + ?)").bind(task.id, leaseId, decision.estimate, decision.leaseSeconds),
    env.DB.prepare("UPDATE tasks SET state = 'dispatching', attempt_count = attempt_count + 1, updated_at = unixepoch() WHERE id = ? AND state IN ('ready','retrying')").bind(task.id),
    env.DB.prepare("UPDATE provider_capacity SET remaining_units = CASE WHEN remaining_units IS NULL THEN NULL ELSE remaining_units - ? END, updated_at = unixepoch() WHERE provider = 'codex_included'").bind(decision.estimate),
  ]);
  return { leaseId, results: result };
}

export async function claimRevision(env, task, decision) {
  const leaseId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO budget_windows (window_key, cost_units_used, tasks_started) VALUES (date('now'), ?, 1) ON CONFLICT(window_key) DO UPDATE SET cost_units_used = cost_units_used + excluded.cost_units_used, tasks_started = tasks_started + 1").bind(decision.estimate),
    env.DB.prepare("INSERT INTO task_leases (task_id, lease_id, provider, cost_units_reserved, expires_at) VALUES (?, ?, 'codex_included', ?, unixepoch() + ?)").bind(task.id, leaseId, decision.estimate, decision.leaseSeconds),
    env.DB.prepare("UPDATE tasks SET state='revising', attempt_count=attempt_count+1, updated_at=unixepoch() WHERE id=? AND state='reviewing'").bind(task.id),
    env.DB.prepare("UPDATE provider_capacity SET remaining_units=CASE WHEN remaining_units IS NULL THEN NULL ELSE remaining_units-? END,updated_at=unixepoch() WHERE provider='codex_included'").bind(decision.estimate),
  ]);
  return leaseId;
}
