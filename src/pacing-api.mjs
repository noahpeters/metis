import { loadPolicy } from "./config.mjs";

export const PACING_OVERVIEW_SCHEMA_VERSION = 1;
export const RESET_CONFIRMATION = "START_NEW_PACING_WINDOW";
const ACTIVE_STATES = ["dispatching", "pending_connector_ack", "running", "revising", "recovering"];
const noStore = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const iso = (seconds) => seconds == null ? null : new Date(Number(seconds) * 1000).toISOString();

function nextUtcDay(seconds) {
  const date = new Date(Number(seconds) * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000;
}

export async function pacingOverview(request, env) {
  return pacingOverviewForIdentity(request.headers.get("X-Metis-Verified-Email"), env);
}

export async function pacingOverviewForIdentity(email, env) {
  if (!identityAllowed(email)) return error("unauthorized", "Verified identity required", 401);
  const policy = loadPolicy(env.METIS_POLICY_JSON);
  const [window, provider, active, executable, checkpoint] = await Promise.all([
    env.DB.prepare("SELECT p.*,c.generation FROM pacing_window_control c JOIN pacing_windows p ON p.window_key=c.current_window_id WHERE c.singleton=1").first(),
    env.DB.prepare("SELECT available,resets_at,updated_at FROM provider_capacity WHERE provider='codex_included'").first(),
    env.DB.prepare(`SELECT id,repository,issue_number,state FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")}) ORDER BY id`).bind(...ACTIVE_STATES).all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM tasks t WHERE t.state='ready' AND NOT EXISTS (SELECT 1 FROM dependencies d WHERE d.task_id=t.id AND d.state!='completed') AND NOT EXISTS (SELECT 1 FROM repository_health h WHERE h.repository=t.repository AND h.state!='healthy')").first(),
    env.DB.prepare("SELECT last_successful_at FROM project_reconciliation_checkpoint ORDER BY last_successful_at DESC LIMIT 1").first(),
  ]);
  const observed = Math.floor(Date.now() / 1000);
  const workloadUsed = window?.estimated_workload_units_used ?? null;
  const startsUsed = window?.tasks_started ?? null;
  const workloadLimit = policy.global.maxEstimatedWorkloadUnitsPerWindow ?? null;
  const startsLimit = policy.global.maxTasksPerWindow ?? null;
  const limiting = window == null ? "unknown" : startsLimit != null && startsUsed >= startsLimit ? "task_starts" : workloadLimit != null && workloadUsed >= workloadLimit ? "estimated_workload_units" : null;
  const scheduledReset = nextUtcDay(observed);
  return noStore({
    schema_version: PACING_OVERVIEW_SCHEMA_VERSION,
    semantics: "estimated_local_pacing",
    window: { id: window?.window_key ?? null, generation: window?.generation ?? null, started_at: iso(window?.started_at), end: iso(window?.ended_at ?? scheduledReset), timezone: "UTC", next_scheduled_reset_at: iso(scheduledReset) },
    pacing: { estimated_workload_units: { used: workloadUsed, limit: workloadLimit }, task_starts: { used: startsUsed, limit: startsLimit }, state: limiting === "unknown" ? "unknown" : limiting ? "exhausted" : "available", limiting_dimension: limiting },
    active_tasks: { count: active?.results ? active.results.length : null, references: active?.results?.map(({ id, repository, issue_number, state }) => ({ id, repository, issue_number, state })) ?? null },
    executable_ready: { count: checkpoint ? executable?.count ?? null : null, authority: "github_project_dependencies_repository_health" },
    provider_capacity: provider ? { state: provider.available === 1 ? "available" : provider.available === 0 ? "unavailable" : "unknown", observed_at: iso(provider.updated_at), resets_at: iso(provider.resets_at) } : { state: "unknown", observed_at: null, resets_at: null },
    observed_at: iso(observed), freshness: { project_reconciled_at: iso(checkpoint?.last_successful_at) }, configuration: { provenance: env.METIS_POLICY_JSON ? "METIS_POLICY_JSON" : "built_in_defaults" },
  });
}

export async function resetPacingWindow(request, env, reconcile) {
  return resetPacingWindowForIdentity(request.headers.get("X-Metis-Verified-Email"), request, env, reconcile);
}

export async function nudgeReadyWorkForIdentity(email, reconcile) {
  if (!identityAllowed(email)) return error("unauthorized", "Verified identity required", 401);
  const result = await reconcile();
  if (result == null) return error("reconciliation_failed", "The fresh control-plane reconciliation did not complete", 503);
  return noStore({ reconciled: true, observed: result.observed ?? null, admitted: result.admitted ?? null });
}

export async function resetPacingWindowForIdentity(email, request, env, reconcile = async () => {}) {
  if (!identityAllowed(email)) return error("unauthorized", "Verified identity required", 401);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 200) return error("invalid_idempotency_key", "A valid Idempotency-Key is required", 400);
  let body;
  try { body = await request.json(); } catch { return error("invalid_json", "A JSON reset request is required", 400); }
  if (body.confirmation !== RESET_CONFIRMATION) return error("confirmation_required", `confirmation must equal ${RESET_CONFIRMATION}`, 400);
  if (!body.expected_window_id || !body.request_id || typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.length > 500) return error("invalid_request", "expected_window_id, request_id, and a reason of 8-500 characters are required", 400);
  const duplicate = await env.DB.prepare("SELECT * FROM pacing_reset_audit WHERE idempotency_key=? OR request_id=?").bind(idempotencyKey, body.request_id).first();
  if (duplicate) return noStore(result(duplicate, true));
  const current = await env.DB.prepare("SELECT current_window_id,generation FROM pacing_window_control WHERE singleton=1").first();
  if (!current || current.current_window_id !== body.expected_window_id) return error("stale_window", "The expected pacing window is no longer current", 409, { current_window_id: current?.current_window_id ?? null });
  const now = Math.floor(Date.now() / 1000);
  const newId = `${new Date(now * 1000).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-g${current.generation + 1}-${crypto.randomUUID().slice(0, 8)}`;
  const actor = email.toLowerCase();
  const rows = await env.DB.batch([
    env.DB.prepare("INSERT INTO pacing_windows(window_key,estimated_workload_units_used,tasks_started,started_at) SELECT ?,0,0,? WHERE EXISTS(SELECT 1 FROM pacing_window_control WHERE singleton=1 AND current_window_id=?)").bind(newId, now, body.expected_window_id),
    env.DB.prepare("UPDATE pacing_windows SET ended_at=?,superseded_by=? WHERE window_key=? AND ended_at IS NULL AND EXISTS(SELECT 1 FROM pacing_window_control WHERE current_window_id=?)").bind(now, newId, body.expected_window_id, body.expected_window_id),
    env.DB.prepare("UPDATE pacing_window_control SET current_window_id=?,generation=generation+1,updated_at=? WHERE singleton=1 AND current_window_id=?").bind(newId, now, body.expected_window_id),
    env.DB.prepare("DELETE FROM scheduler_signals WHERE window_key=? AND EXISTS(SELECT 1 FROM pacing_window_control WHERE current_window_id=?)").bind(body.expected_window_id, newId),
    env.DB.prepare("INSERT INTO pacing_reset_audit(request_id,idempotency_key,actor_email,source_window_id,new_window_id,reason,deployment_version,outcome,created_at) SELECT ?,?,?,?,?,?,?,'reset',? WHERE EXISTS(SELECT 1 FROM pacing_window_control WHERE current_window_id=?)").bind(body.request_id, idempotencyKey, actor, body.expected_window_id, newId, body.reason.trim(), env.DEPLOYMENT_VERSION || null, now, newId),
  ]);
  if (!Number(rows[4]?.meta?.changes ?? rows[4]?.changes ?? 0)) {
    const raced = await env.DB.prepare("SELECT * FROM pacing_reset_audit WHERE idempotency_key=?").bind(idempotencyKey).first();
    return raced ? noStore(result(raced, true)) : error("stale_window", "Another reset superseded the expected pacing window", 409);
  }
  await reconcile();
  return noStore({ source_window_id: body.expected_window_id, new_window_id: newId, reset_at: iso(now), duplicate: false }, 201);
}

function result(row, duplicate) { return { source_window_id: row.source_window_id, new_window_id: row.new_window_id, reset_at: iso(row.created_at), duplicate }; }
function error(code, message, status, details) { return noStore({ error: { code, message, ...(details || {}) } }, status); }
function identityAllowed(email) { return typeof email === "string" && /^[^@]+@from-trees\.com$/.test(email.toLowerCase()); }
