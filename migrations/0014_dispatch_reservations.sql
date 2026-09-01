CREATE TABLE dispatch_reservations (
  lease_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  provider TEXT NOT NULL,
  window_key TEXT NOT NULL REFERENCES pacing_windows(window_key),
  workload_units INTEGER NOT NULL CHECK(workload_units >= 0),
  task_starts INTEGER NOT NULL DEFAULT 1 CHECK(task_starts = 1),
  provider_slots INTEGER NOT NULL DEFAULT 0 CHECK(provider_slots IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('reserved','committed','released','reconciliation_required')),
  attempt_number INTEGER NOT NULL,
  reason_class TEXT,
  sanitized_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE reservation_adjustments (
  lease_id TEXT NOT NULL REFERENCES dispatch_reservations(lease_id),
  operation TEXT NOT NULL CHECK(operation IN ('commit','release','reconcile')),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reason_class TEXT NOT NULL,
  sanitized_detail TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(lease_id, operation)
);

ALTER TABLE provider_capacity ADD COLUMN dispatch_slots_limit INTEGER;
ALTER TABLE provider_capacity ADD COLUMN dispatch_slots_available INTEGER;
CREATE INDEX dispatch_reservations_state_idx ON dispatch_reservations(state, updated_at);
