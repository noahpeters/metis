import { loadPolicy, taskBudget } from "./config.mjs";

export async function admissionDecision(env, task) {
  const policy = loadPolicy(env.METIS_POLICY_JSON);
  const sizePolicy = policy.taskSizes[task.size_class || "unknown"];
  if (!policy.providers.codex_included.enabled) return { admitted: false, reason: "Codex included capacity is disabled." };
  if (policy.providers.paid_api.enabled) throw new Error("Unsafe policy: paid API fallback must remain disabled unless explicitly implemented and approved");
  if (sizePolicy.dispatch !== "automatic" && !task.budget_approved) {
    return { admitted: false, reason: `${task.size_class || "unknown"} tasks require explicit budget approval.` };
  }
  const capacity = await env.DB.prepare("SELECT remaining_units, available FROM provider_capacity WHERE provider = 'codex_included'").first();
  if (!capacity?.available) return { admitted: false, reason: "Included Codex capacity is unavailable or exhausted." };
  const window = await env.DB.prepare("SELECT cost_units_used, tasks_started FROM budget_windows WHERE window_key = date('now')").first();
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM task_leases WHERE expires_at > unixepoch()").first();
  const estimate = Math.min(task.estimated_cost_units || sizePolicy.estimatedCostUnits, taskBudget(policy, task.size_class, task.max_cost_units));
  if ((active?.count || 0) >= policy.global.maxConcurrentTasks) return { admitted: false, defer: true, reason: "Maximum concurrent tasks reached." };
  if ((window?.tasks_started || 0) >= policy.global.maxTasksPerWindow) return { admitted: false, reason: "Global task-start budget exhausted." };
  if ((window?.cost_units_used || 0) + estimate > policy.global.maxCostUnitsPerWindow) return { admitted: false, reason: "Global cost-unit budget exhausted." };
  if (capacity.remaining_units != null && capacity.remaining_units < estimate) return { admitted: false, reason: "Provider capacity is below the task estimate." };
  return { admitted: true, estimate, maxRetries: policy.global.maxRetries, leaseSeconds: policy.global.leaseSeconds };
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
