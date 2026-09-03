export const CAPACITY_OUTCOMES = new Set(["accepted", "rejected", "exhausted", "unavailable", "unknown"]);

export const OBSERVATION_CLASSIFICATIONS = new Set(["actual", "estimated", "unattributed", "stale", "unavailable", "unknown"]);
export const OBSERVATION_FRESHNESS = new Set(["fresh", "stale", "unknown"]);
export const RECONCILIATION_STATES = new Set(["pending", "reconciled", "superseded", "conflict"]);
const OPTIONAL_PROVIDER_FIELDS = ["input_tokens", "output_tokens", "total_tokens", "credits", "model", "reset_at", "execution_surface"];
const CORRELATIONS = ["task_id", "repository", "issue_number", "pull_request_number", "dispatch_id", "lease_id"];
const FORBIDDEN_KEYS = /(^|_)(prompt|source_code|credential|secret|token_value|response_value)s?$/i;

function required(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`Missing provider observation ${name}`);
  return value;
}

function assertPrivateDataAbsent(value, path = "observation") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`Provider observation contains forbidden private field: ${path}.${key}`);
    assertPrivateDataAbsent(child, `${path}.${key}`);
  }
}

// Provider values are copied, never defaulted. In particular, absent numbers remain NULL rather than zero.
export function providerObservation(input) {
  assertPrivateDataAbsent(input);
  const classification = required(input.classification, "classification");
  const freshness = required(input.freshness, "freshness");
  const reconciliationState = input.reconciliation_state ?? "pending";
  if (!OBSERVATION_CLASSIFICATIONS.has(classification)) throw new Error(`Invalid provider observation classification: ${classification}`);
  if (!OBSERVATION_FRESHNESS.has(freshness)) throw new Error(`Invalid provider observation freshness: ${freshness}`);
  if (!RECONCILIATION_STATES.has(reconciliationState)) throw new Error(`Invalid provider observation reconciliation state: ${reconciliationState}`);

  const observation = {
    provider: required(input.provider, "provider"), workspace_ref: input.workspace_ref ?? null,
    provider_ref: input.provider_ref ?? null, event_class: required(input.event_class, "event_class"),
    classification, observed_at: required(input.observed_at, "observed_at"),
    provider_window_start: input.provider_window_start ?? null, provider_window_end: input.provider_window_end ?? null,
    provider_timezone: input.provider_timezone ?? null, freshness, sanitized_status: input.sanitized_status ?? null,
  };
  for (const field of OPTIONAL_PROVIDER_FIELDS) observation[field] = Object.hasOwn(input, field) ? input[field] : null;
  for (const field of CORRELATIONS) observation[field] = input.correlations?.[field]?.proven === true ? input.correlations[field].value : null;
  return {
    ...observation,
    deduplication_key: required(input.deduplication_key, "deduplication_key"),
    source_revision: required(input.source_revision, "source_revision"),
    pagination_checkpoint: input.pagination_checkpoint ?? null,
    reconciliation_state: reconciliationState,
    derived_metrics: input.derived_metrics ?? {},
  };
}

export function providerObservationStatement(env, input) {
  const value = providerObservation(input);
  const columns = ["provider", "workspace_ref", "provider_ref", "event_class", "classification", "observed_at", "provider_window_start", "provider_window_end", "provider_timezone", "freshness", "sanitized_status", ...OPTIONAL_PROVIDER_FIELDS, ...CORRELATIONS, "deduplication_key", "source_revision", "pagination_checkpoint", "reconciliation_state", "derived_metrics_json"];
  const values = columns.map((column) => column === "derived_metrics_json" ? JSON.stringify(value.derived_metrics) : value[column]);
  return env.DB.prepare(`INSERT INTO provider_observations(${columns.join(",")},created_at) VALUES(${columns.map(() => "?").join(",")},unixepoch()) ON CONFLICT DO NOTHING`).bind(...values);
}

export function capacityObservation(acknowledgment) {
  const outcome = acknowledgment.capacity_outcome;
  if (!CAPACITY_OUTCOMES.has(outcome)) throw new Error(`Invalid provider-capacity outcome: ${outcome}`);
  return {
    outcome,
    observed_at: acknowledgment.observed_at,
    reset_at: outcome === "exhausted" ? acknowledgment.reset_at : null,
    limit_reason: outcome === "exhausted" ? acknowledgment.limit_reason : null,
    evidence: {
      comment_url: acknowledgment.comment_url || null,
      reason: acknowledgment.reason || null,
      task_url: acknowledgment.task_url || null,
    },
  };
}

export function capacityObservationStatements(env, dispatchId, acknowledgment) {
  const observation = capacityObservation(acknowledgment);
  const evidenceKey = acknowledgment.comment_id
    ? `github-comment:${acknowledgment.comment_id}`
    : `connector:${acknowledgment.comment_url || `${dispatchId}:${observation.observed_at}`}`;
  const statements = [env.DB.prepare("INSERT INTO provider_capacity_observations(provider,dispatch_id,evidence_key,outcome,observed_at,reset_at,limit_reason,evidence_json,created_at) VALUES('codex_included',?,?,?,?,?,?,?,unixepoch()) ON CONFLICT(provider,evidence_key) DO NOTHING")
    .bind(dispatchId, evidenceKey, observation.outcome, observation.observed_at, observation.reset_at, observation.limit_reason, JSON.stringify(observation.evidence))];

  if (["accepted", "exhausted"].includes(observation.outcome)) {
    const available = observation.outcome === "accepted" ? 1 : 0;
    statements.push(env.DB.prepare("UPDATE provider_capacity SET available=?,resets_at=?,metadata_json=?,updated_at=? WHERE provider='codex_included' AND updated_at<=?")
      .bind(available, observation.reset_at, JSON.stringify({ source: "dispatch_acknowledgment", outcome: observation.outcome, limit_reason: observation.limit_reason }), observation.observed_at, observation.observed_at));
  }
  return statements;
}

export async function reenergizeExpiredCapacity(env, now = Math.floor(Date.now() / 1000)) {
  const exhausted = await env.DB.prepare("SELECT updated_at FROM provider_capacity WHERE provider='codex_included' AND available=0 AND json_extract(metadata_json,'$.outcome')='exhausted' AND COALESCE(resets_at,updated_at+3600)<=?").bind(now).first();
  if (!exhausted) return false;
  const requestId = `automatic:codex_included:${exhausted.updated_at}`;
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO capacity_reenergizations(request_id,provider,mode,actor,source_observed_at,reason,created_at) SELECT ?,'codex_included','automatic',NULL,updated_at,'Provider reset interval elapsed.',? FROM provider_capacity WHERE provider='codex_included' AND available=0 AND updated_at=? AND json_extract(metadata_json,'$.outcome')='exhausted' AND COALESCE(resets_at,updated_at+3600)<=? ON CONFLICT(request_id) DO NOTHING").bind(requestId, now, exhausted.updated_at, now),
    env.DB.prepare("UPDATE provider_capacity SET available=1,resets_at=NULL,metadata_json=json_object('source','automatic_reenergization','previous_outcome','exhausted','source_observed_at',updated_at),updated_at=? WHERE provider='codex_included' AND available=0 AND updated_at=? AND EXISTS(SELECT 1 FROM capacity_reenergizations WHERE request_id=?)").bind(now, exhausted.updated_at, requestId),
  ]);
  return Boolean(results[1]?.meta?.changes ?? results[1]?.changes);
}

export async function reenergizeCapacityForOperator(env, { requestId, actor, reason }, now = Math.floor(Date.now() / 1000)) {
  const duplicate = await env.DB.prepare("SELECT request_id,created_at FROM capacity_reenergizations WHERE request_id=? AND mode='operator'").bind(requestId).first();
  if (duplicate) return { reenergized: true, duplicate: true, reenergized_at: duplicate.created_at };
  const exhausted = await env.DB.prepare("SELECT updated_at FROM provider_capacity WHERE provider='codex_included' AND available=0 AND json_extract(metadata_json,'$.outcome')='exhausted'").first();
  if (!exhausted) return null;
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO capacity_reenergizations(request_id,provider,mode,actor,source_observed_at,reason,created_at) SELECT ?,'codex_included','operator',?,updated_at,?,? FROM provider_capacity WHERE provider='codex_included' AND available=0 AND updated_at=? AND json_extract(metadata_json,'$.outcome')='exhausted' ON CONFLICT(request_id) DO NOTHING").bind(requestId, actor, reason, now, exhausted.updated_at),
    env.DB.prepare("UPDATE provider_capacity SET available=1,resets_at=NULL,metadata_json=json_object('source','operator_reenergization','previous_outcome','exhausted','source_observed_at',updated_at),updated_at=? WHERE provider='codex_included' AND available=0 AND updated_at=? AND EXISTS(SELECT 1 FROM capacity_reenergizations WHERE request_id=?)").bind(now, exhausted.updated_at, requestId),
  ]);
  return Boolean(results[1]?.meta?.changes ?? results[1]?.changes) ? { reenergized: true, duplicate: false, reenergized_at: now } : null;
}
