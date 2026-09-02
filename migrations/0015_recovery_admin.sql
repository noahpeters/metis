CREATE TABLE recovery_admin_audit (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  deployment_version TEXT,
  created_at INTEGER NOT NULL
);
