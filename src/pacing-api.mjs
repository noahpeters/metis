import { loadPolicy } from "./config.mjs";
import { reenergizeCapacityForOperator } from "./provider-capacity.mjs";
import { observeExecutableReady } from "./executable-ready.mjs";

export const PACING_OVERVIEW_SCHEMA_VERSION = 2;
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
  const [window, provider, active, checkpoint, completed] = await Promise.all([
    env.DB.prepare("SELECT p.*,c.generation FROM pacing_window_control c JOIN pacing_windows p ON p.window_key=c.current_window_id WHERE c.singleton=1").first(),
    env.DB.prepare("SELECT available,resets_at,updated_at,metadata_json FROM provider_capacity WHERE provider='codex_included'").first(),
    env.DB.prepare(`SELECT id,repository,issue_number,state FROM tasks WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")}) ORDER BY id`).bind(...ACTIVE_STATES).all(),
    env.DB.prepare("SELECT last_successful_at FROM project_reconciliation_checkpoint ORDER BY last_successful_at DESC LIMIT 1").first(),
    env.DB.prepare("SELECT MIN(u.created_at) AS created_at,t.estimated_workload_units,t.size_class FROM usage_events u JOIN tasks t ON t.id=u.task_id WHERE u.created_at>=unixepoch()-86400 AND (u.operation IN ('coding_prepared','connector_completed_without_ack','review_revision_prepared') OR (u.operation='coding' AND json_extract(u.metadata_json,'$.status') IN ('completed','awaiting_pr_creation'))) GROUP BY u.task_id,u.operation,u.metadata_json,t.estimated_workload_units,t.size_class").all(),
  ]);
  let readiness = null;
  if (checkpoint) {
    try { readiness = await observeExecutableReady(env); } catch { /* incomplete authoritative evidence remains unknown */ }
  }
  const observed = Math.floor(Date.now() / 1000);
  const startsUsed = window?.tasks_started ?? null;
  const startsLimit = policy.global.maxTasksPerWindow ?? null;
  const limiting = window == null ? "unknown" : startsLimit != null && startsUsed >= startsLimit ? "task_starts" : null;
  const scheduledReset = nextUtcDay(observed);
  const completedRows = completed?.results || [];
  const completedSize = (seconds) => completedRows.reduce((sum, row) => {
    if (Number(row.created_at) < observed - seconds) return sum;
    const fallback = policy.taskSizes[row.size_class]?.estimatedWorkloadUnits ?? policy.taskSizes.unknown.estimatedWorkloadUnits;
    return sum + Math.max(0, Math.round(Number(row.estimated_workload_units) || fallback));
  }, 0);
  let providerMetadata = {};
  try { providerMetadata = JSON.parse(provider?.metadata_json || "{}"); } catch { /* malformed legacy metadata is not capacity evidence */ }
  const providerState = !provider ? "unknown" : provider.available === 1 ? "available" : providerMetadata.outcome === "exhausted" ? "exhausted" : provider.available === 0 ? "unavailable" : "unknown";
  return noStore({
    schema_version: PACING_OVERVIEW_SCHEMA_VERSION,
    semantics: "operational_capacity",
    window: { id: window?.window_key ?? null, generation: window?.generation ?? null, started_at: iso(window?.started_at), end: iso(window?.ended_at ?? scheduledReset), timezone: "UTC", next_scheduled_reset_at: iso(scheduledReset) },
    pacing: { task_starts: { used: startsUsed, limit: startsLimit }, state: limiting === "unknown" ? "unknown" : limiting ? "exhausted" : "available", limiting_dimension: limiting },
    work_completed: { unit: "size_points", last_1_hour: completedSize(3600), last_8_hours: completedSize(28800), last_24_hours: completedSize(86400) },
    active_tasks: { count: active?.results ? active.results.length : null, references: active?.results?.map(({ id, repository, issue_number, state }) => ({ id, repository, issue_number, state })) ?? null },
    executable_ready: { count: readiness?.executable_ready_count ?? null, authority: "github_project_status_and_dependencies" },
    provider_capacity: provider ? { state: providerState, observed_at: iso(provider.updated_at), expected_available_at: providerState === "exhausted" ? iso(provider.resets_at) : null, limit_reason: providerState === "exhausted" ? providerMetadata.limit_reason || null : null } : { state: "unknown", observed_at: null, expected_available_at: null, limit_reason: null },
    observed_at: iso(observed), freshness: { project_reconciled_at: iso(checkpoint?.last_successful_at) }, configuration: { provenance: env.METIS_POLICY_JSON ? "METIS_POLICY_JSON" : "built_in_defaults" },
  });
}

export async function nudgeReadyWorkForIdentity(email, reconcile) {
  if (!identityAllowed(email)) return error("unauthorized", "Verified identity required", 401);
  const result = await reconcile();
  if (result == null) return error("reconciliation_failed", "The fresh control-plane reconciliation did not complete", 503);
  return noStore({ reconciled: true, observed: result.observed ?? null, admitted: result.admitted ?? null });
}

export async function reenergizeCapacityForIdentity(email, request, env, reconcile) {
  if (!identityAllowed(email)) return error("unauthorized", "Verified identity required", 401);
  let body;
  try { body = await request.json(); } catch { return error("invalid_json", "A JSON request is required", 400); }
  if (body.confirmation !== "REENERGIZE_CAPACITY") return error("confirmation_required", "confirmation must equal REENERGIZE_CAPACITY", 400);
  if (typeof body.request_id !== "string" || !body.request_id.trim() || body.request_id.length > 200) return error("invalid_request", "A bounded request_id is required", 400);
  const result = await reenergizeCapacityForOperator(env, { requestId: body.request_id.trim(), actor: email.toLowerCase(), reason: "Operator requested a capacity retest." });
  if (!result) return error("capacity_not_exhausted", "Provider capacity is no longer in the exhausted state", 409);
  const reconciliation = result.duplicate ? null : await reconcile();
  return noStore({ ...result, reconciliation_completed: result.duplicate ? null : reconciliation !== null });
}

function error(code, message, status, details) { return noStore({ error: { code, message, ...(details || {}) } }, status); }
function identityAllowed(email) { return typeof email === "string" && /^[^@]+@from-trees\.com$/.test(email.toLowerCase()); }
