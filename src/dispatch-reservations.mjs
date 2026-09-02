const SAFE_ERROR_LIMIT = 500;

export function sanitizedDispatchError(error) {
  const status = Number.isInteger(error?.status) ? ` (${error.status})` : "";
  const message = String(error?.message || "Dispatch failed")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|authorization)=?\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, SAFE_ERROR_LIMIT);
  return `${message}${status}`.slice(0, SAFE_ERROR_LIMIT);
}

export function dispatchFailureClass(error) {
  if (error?.acceptance === "confirmed_unaccepted") {
    if ([401, 403].includes(error.status)) return "authorization";
    if (error.status >= 400 && error.status < 500) return "validation";
    return "pre_dispatch";
  }
  return "acceptance_unknown";
}

export function commitReservationStatements(env, leaseId, reason = "provider_accepted") {
  return [
    env.DB.prepare("UPDATE dispatch_reservations SET state='committed',reason_class=?,updated_at=unixepoch() WHERE lease_id=? AND state='reserved'").bind(reason, leaseId),
    env.DB.prepare("INSERT INTO reservation_adjustments(lease_id,operation,task_id,reason_class,created_at) SELECT lease_id,'commit',task_id,?,unixepoch() FROM dispatch_reservations WHERE lease_id=? AND state='committed' ON CONFLICT(lease_id,operation) DO NOTHING").bind(reason, leaseId),
  ];
}

export function releaseReservationStatements(env, leaseId, reason, detail = null) {
  return [
    env.DB.prepare("UPDATE pacing_windows SET tasks_started=MAX(0,tasks_started-COALESCE((SELECT task_starts FROM dispatch_reservations WHERE lease_id=? AND state='reserved'),0)) WHERE window_key=(SELECT window_key FROM dispatch_reservations WHERE lease_id=?)").bind(leaseId, leaseId),
    env.DB.prepare("UPDATE provider_capacity SET dispatch_slots_available=MIN(dispatch_slots_limit,dispatch_slots_available+COALESCE((SELECT provider_slots FROM dispatch_reservations WHERE lease_id=? AND state='reserved'),0)),updated_at=unixepoch() WHERE provider=(SELECT provider FROM dispatch_reservations WHERE lease_id=?) AND dispatch_slots_limit IS NOT NULL").bind(leaseId, leaseId),
    env.DB.prepare("UPDATE dispatch_reservations SET state='released',reason_class=?,sanitized_error=?,updated_at=unixepoch() WHERE lease_id=? AND state='reserved'").bind(reason, detail, leaseId),
    env.DB.prepare("INSERT INTO reservation_adjustments(lease_id,operation,task_id,reason_class,sanitized_detail,created_at) SELECT lease_id,'release',task_id,?,?,unixepoch() FROM dispatch_reservations WHERE lease_id=? AND state='released' ON CONFLICT(lease_id,operation) DO NOTHING").bind(reason, detail, leaseId),
    env.DB.prepare("DELETE FROM task_leases WHERE lease_id=? AND EXISTS(SELECT 1 FROM dispatch_reservations WHERE lease_id=? AND state='released')").bind(leaseId, leaseId),
  ];
}

export function reconcileReservationStatements(env, leaseId, reason, detail = null) {
  return [
    env.DB.prepare("UPDATE dispatch_reservations SET state='reconciliation_required',reason_class=?,sanitized_error=?,updated_at=unixepoch() WHERE lease_id=? AND state='reserved'").bind(reason, detail, leaseId),
    env.DB.prepare("INSERT INTO reservation_adjustments(lease_id,operation,task_id,reason_class,sanitized_detail,created_at) SELECT lease_id,'reconcile',task_id,?,?,unixepoch() FROM dispatch_reservations WHERE lease_id=? AND state='reconciliation_required' ON CONFLICT(lease_id,operation) DO NOTHING").bind(reason, detail, leaseId),
  ];
}
