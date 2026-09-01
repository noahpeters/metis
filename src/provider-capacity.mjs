export const CAPACITY_OUTCOMES = new Set(["accepted", "rejected", "exhausted", "unavailable", "unknown"]);

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
